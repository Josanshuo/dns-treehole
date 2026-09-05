import { listOurTxt, expiryOf } from './dns.js';

export { PostGate } from './gate.js';

/* ---------- 记录格式 ---------- */
// tree1;<创建时间戳>;<存活秒数>;<署名>;<正文>
// 单条 TXT 字符串硬上限 255 字节，前缀开销约 36 字节，正文剩约 219 字节 ≈ 73 个汉字。

const MAX_BYTES = 255;
const PREFIX = 'tree1';
// 记录的 DNS TTL 固定为 Cloudflare 允许的最短值。以前等于帖子寿命，结果频道里有一条一天的帖子，
// 解析器就把整个频道的答案缓存一天，后面发的新帖别人几小时都看不到。
const RECORD_TTL = 60;
// 和 Cloudflare DNS 面板的 TTL 选项一致（去掉 Auto 和 1 分钟）：2/5/10/15/30 分钟、1/2/5/12 小时、1 天
// 1 分钟去掉是因为实测别人要 20–60 秒才看得到（解析器把 60 秒的答案缓存满），一分钟的帖子几乎没人来得及看
const ALLOWED_TTL = [120, 300, 600, 900, 1800, 3600, 7200, 18000, 43200, 86400];
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

const staticCodes = (env) => (env.INVITE_CODES || '').split(',').map((s) => s.trim()).filter(Boolean);
const gate = (env) => env.POST_GATE.get(env.POST_GATE.idFromName('gate'));

/* ---------- 邀请码 ---------- */

/** 前端填完邀请码时查一下还剩多少。静态码返回 unlimited。 */
async function handleInviteCheck(request, env) {
  const body = await request.json().catch(() => ({}));
  const code = String(body.invite || '').trim();
  if (!code) return json({ ok: false });
  if (staticCodes(env).includes(code)) return json({ ok: true, unlimited: true });
  return json(await gate(env).check(code));
}

function timingSafeEqual(a, b) {
  const x = enc.encode(a), y = enc.encode(b);
  return x.length === y.length && crypto.subtle.timingSafeEqual(x, y);
}

/**
 * 管理接口，用 ADMIN_KEY secret 保护（Authorization: Bearer <key>）：
 *   GET    /api/admin/invites           列出所有生成的码和用量
 *   POST   /api/admin/invites           { quota, count?, note? } 生成新码
 *   DELETE /api/admin/invites/<code>    作废一个码
 */
async function handleAdmin(request, env, url) {
  if (!env.ADMIN_KEY) return json({ error: '未配置 ADMIN_KEY' }, 503);
  if (!timingSafeEqual(request.headers.get('Authorization') || '', `Bearer ${env.ADMIN_KEY}`)) {
    return json({ error: '需要管理密钥' }, 401);
  }
  const m = url.pathname.match(/^\/api\/admin\/invites(?:\/([a-z0-9]+))?$/);
  if (!m) return json({ error: '没有这个接口' }, 404);
  const g = gate(env);

  if (!m[1] && request.method === 'GET') return json({ invites: await g.list() });
  if (!m[1] && request.method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const quota = Number(body.quota), count = Number(body.count ?? 1);
    if (!Number.isInteger(quota) || quota < 1 || quota > 10000) return json({ error: 'quota 要是 1–10000 的整数' }, 400);
    if (!Number.isInteger(count) || count < 1 || count > 50) return json({ error: 'count 要是 1–50 的整数' }, 400);
    const note = String(body.note || '').slice(0, 60);
    const maxTtl = Number(body.maxTtl ?? 120); // 这个码最长能发多久的帖子，默认 2 分钟
    if (!ALLOWED_TTL.includes(maxTtl)) return json({ error: `maxTtl 要是 ${ALLOWED_TTL.join('/')} 之一` }, 400);
    return json({ invites: await g.issue({ quota, count, note, maxTtl }) });
  }
  if (m[1] && request.method === 'DELETE') return json({ revoked: await g.revoke(m[1]) });
  return json({ error: '没有这个接口' }, 404);
}

/* ---------- 发布 ---------- */

async function handlePost(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: '请求体不是合法 JSON' }, 400);
  }

  const { invite, channel = 'wall', nick = 'anon', text: rawText = '', ttl = 300 } = body;
  const text = String(rawText).replace(/[\r\n]+/g, ' '); // 不支持换行，统一换成空格

  // 邀请码。secret 里逗号分隔的静态码不限量；用管理接口生成的码有额度，存在 PostGate 里，
  // 由它在建记录的同一次排队里校验和扣减。
  const code = String(invite || '').trim();
  if (!code) return json({ error: '邀请码无效' }, 403);
  const unlimited = staticCodes(env).includes(code);

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

  const name = `${channel}.${env.BASE_NAME}`;
  const expiresAt = Date.now() + Number(ttl) * 1000;

  // 200 条上限保护。2024-09-01 之后新建的免费 zone 只有 200 条，
  // 而且 zone 里的其他记录也计入配额，所以留了缓冲。
  // 满了不让人等：把最接近过期的那条提前删掉腾位置。
  // 计数 / 腾位 / 建记录必须一起串行执行，否则并发发帖会冲过上限，
  // 所以交给全站唯一的 PostGate 实例排队做；它记着台账，到点也由它批量删。
  const res = await gate(env).create({
    invite: code,
    unlimited,
    name,
    content: content.replace(/\\/g, '\\\\'), // 反斜杠按 master-file 写法转义，不然 API 会把 \x 当转义序列吃掉
    ttl: RECORD_TTL, // DNS 缓存时长固定 60 秒，和帖子寿命无关；寿命写在内容里，靠删除和前端倒计时生效
    comment: `${env.RECORD_TAG}:${expiresAt}`,
    expiresAt,
    cap: Number(env.RECORD_CAP || 180),
  });
  if (!res.ok) {
    return json({
      error: res.message,
      ...(res.left != null && { left: res.left }),
      ...(res.maxTtl != null && { maxTtl: res.maxTtl }),
    }, res.status);
  }
  const { recordId, evicted, left, maxTtl } = res;

  return json({
    ok: true,
    recordId,
    name,
    bytes: used,
    content, // 前端拿它先把自己的帖子垫上显示，等 DNS 返回同样的字符串再自然接管
    evicted, // 为了腾位置提前删了一条最接近过期的帖子
    left, // 这个邀请码还能发几条；null 表示不限量
    maxTtl, // 这个邀请码最长能发多久的帖子；null 表示不限
    expiresAt: Math.floor(expiresAt / 1000),
    dig: `dig ${name} TXT +short`,
  });
}

/* ---------- 兜底对账 ---------- */

/**
 * 每分钟把 zone 里的实际记录列一遍，交给 PostGate 校正台账、删掉已过期的。
 *
 * DNS 记录是 Worker 之外的状态：DO 挂了、闹钟丢了、API 调用连续失败、
 * 有人在面板上手删，台账都会和实际脱节。这个循环让系统自愈。
 * 每轮固定 1 次列表调用，有过期记录时再加 1 次批量删除。
 */
async function sweep(env) {
  const listedAt = Date.now();
  let records;
  try {
    records = await listOurTxt(env);
  } catch (err) {
    console.error('对账列表失败', err.message);
    return;
  }

  const ours = records
    .map((r) => ({ id: r.id, name: r.name, expiresAt: expiryOf(r) }))
    .filter((r) => r.expiresAt != null);

  const { removed, added, live, due, gone } = await gate(env).reconcile(ours, listedAt);
  if (removed || added || due) {
    console.log(`对账：台账删 ${removed} 补 ${added}，过期 ${due} 条删除 ${gone} 条，现存 ${live} 条`);
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

    if (url.pathname === '/api/invite/check' && request.method === 'POST') {
      return handleInviteCheck(request, env);
    }

    if (url.pathname.startsWith('/api/admin/')) {
      try {
        return await handleAdmin(request, env, url);
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
