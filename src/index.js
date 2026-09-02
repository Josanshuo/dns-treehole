import { createTxt, deleteRecord, listOurTxt, countOurTxt, DnsError } from './dns.js';

export { PostReaper } from './reaper.js';

/* ---------- 记录格式 ---------- */
// tree1;<创建时间戳>;<存活秒数>;<署名>;<正文>
// 单条 TXT 字符串硬上限 255 字节，前缀开销约 36 字节，正文剩约 219 字节 ≈ 73 个汉字。

const MAX_BYTES = 255;
const PREFIX = 'tree1';
const ALLOWED_TTL = [60, 300, 900, 3600, 21600, 86400];
const NICK_RE = /^[a-zA-Z0-9_\u4e00-\u9fa5-]{1,12}$/;
const CHANNEL_RE = /^[a-z0-9-]{1,20}$/;

const enc = new TextEncoder();
const byteLen = (s) => enc.encode(s).length;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

/* ---------- 发布 ---------- */

async function handlePost(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: '请求体不是合法 JSON' }, 400);
  }

  const { invite, channel = 'wall', nick = 'anon', text = '', ttl = 300 } = body;

  // 邀请码。逗号分隔存在 secret 里，够小圈子用。
  const codes = (env.INVITE_CODES || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!codes.length) return json({ error: '服务端未配置邀请码' }, 500);
  if (!codes.includes(String(invite))) return json({ error: '邀请码无效' }, 403);

  if (!CHANNEL_RE.test(channel)) return json({ error: '频道名只允许小写字母、数字和连字符' }, 400);
  if (!NICK_RE.test(nick)) return json({ error: '署名不合法（1-12 位，中英文数字下划线）' }, 400);
  if (!text.trim()) return json({ error: '正文不能为空' }, 400);
  if (!ALLOWED_TTL.includes(Number(ttl))) return json({ error: '不支持的存活时长' }, 400);

  const created = Math.floor(Date.now() / 1000);
  const content = `${PREFIX};${created};${ttl};${nick};${text}`;

  const used = byteLen(content);
  if (used > MAX_BYTES) {
    return json(
      { error: `超出单条 TXT 上限：${used} / ${MAX_BYTES} 字节（中文一字 3 字节）` },
      400
    );
  }

  // 200 条上限保护。2024-09-01 之后新建的免费 zone 只有 200 条，
  // 而且 zone 里的其他记录也计入配额，所以留了缓冲。
  const cap = Number(env.RECORD_CAP || 180);
  try {
    if ((await countOurTxt(env)) >= cap) {
      return json({ error: `已达记录上限（${cap}），等一些帖子过期后再发` }, 503);
    }
  } catch (err) {
    if (err.status === 429) return json({ error: 'API 限流，稍后再试' }, 429);
    throw err;
  }

  const name = `${channel}.${env.BASE_NAME}`;
  const expiresAt = Date.now() + Number(ttl) * 1000;

  let recordId;
  try {
    recordId = await createTxt(env, {
      name,
      content,
      ttl: Number(ttl), // 缓存时长；实际消失靠删除，TTL 决定删除多久后全网可见
      comment: `${env.RECORD_TAG}:${expiresAt}`,
    });
  } catch (err) {
    if (err instanceof DnsError) {
      return json({ error: `建记录失败：${err.message}` }, err.status === 429 ? 429 : 502);
    }
    throw err;
  }

  // 设闹钟。失败也没关系，cron 会兜底。
  try {
    const stub = env.POST_REAPER.get(env.POST_REAPER.idFromName(recordId));
    await stub.schedule(recordId, expiresAt);
  } catch (err) {
    console.error('闹钟设置失败，等 cron 兜底', recordId, err.message);
  }

  return json({
    ok: true,
    recordId,
    name,
    bytes: used,
    expiresAt: Math.floor(expiresAt / 1000),
    dig: `dig ${name} TXT +short`,
  });
}

/* ---------- 兜底对账 ---------- */

/**
 * 每分钟扫一遍，删掉所有已过期但还在的记录。
 *
 * DNS 记录是 Worker 之外的状态：DO 挂了、闹钟丢了、API 调用连续失败，
 * 都没人收尸。这个循环让系统自愈。
 */
async function sweep(env) {
  const now = Date.now();
  let records;
  try {
    records = await listOurTxt(env);
  } catch (err) {
    console.error('对账列表失败', err.message);
    return;
  }

  const expired = records.filter((r) => {
    const at = Number((r.comment || '').split(':')[1]);
    return Number.isFinite(at) && at <= now;
  });

  // Cloudflare 没有批量删除接口，一条一次调用。
  // 每轮设上限，避免把 1200/5min 的额度烧光。
  const budget = Number(env.SWEEP_BUDGET || 40);
  let done = 0;
  for (const r of expired.slice(0, budget)) {
    try {
      await deleteRecord(env, r.id);
      done++;
    } catch (err) {
      if (err.status === 429) break; // 限流就停，下一分钟继续
      console.error('删除失败', r.id, err.message);
    }
  }

  if (expired.length) {
    console.log(`对账：过期 ${expired.length} 条，本轮删除 ${done} 条`);
  }
}

/* ---------- 入口 ---------- */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/post' && request.method === 'POST') {
      try {
        return await handlePost(request, env);
      } catch (err) {
        console.error(err);
        return json({ error: '服务端错误' }, 500);
      }
    }

    if (url.pathname === '/api/config') {
      // 前端需要知道往哪个名字下读
      return json({
        baseName: env.BASE_NAME,
        maxBytes: MAX_BYTES,
        ttlOptions: ALLOWED_TTL,
      });
    }

    // 其余交给静态资源（public/）
    return env.ASSETS.fetch(request);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(sweep(env));
  },
};
