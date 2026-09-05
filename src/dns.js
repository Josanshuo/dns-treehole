/**
 * Cloudflare DNS API 的最小封装。
 *
 * 全局速率限制是 1200 次 / 5 分钟，按用户累计，dashboard 操作也吃同一份额度。
 * 这里每条帖子消耗 2 次（建 + 删），所以理论上限约 600 条 / 5 分钟。
 */

const API = 'https://api.cloudflare.com/client/v4';

class DnsError extends Error {
  constructor(message, status, errors) {
    super(message);
    this.name = 'DnsError';
    this.status = status;
    this.errors = errors || [];
  }
}

async function call(env, method, path, body) {
  const res = await fetch(`${API}/zones/${env.CF_ZONE_ID}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.CF_API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  // 429 单独识别，方便上层退避
  if (res.status === 429) {
    throw new DnsError('Cloudflare API 限流（1200 次 / 5 分钟）', 429);
  }

  let json;
  try {
    json = await res.json();
  } catch {
    throw new DnsError(`API 返回了非 JSON（HTTP ${res.status}）`, res.status);
  }

  if (!res.ok || json.success === false) {
    const msg = (json.errors || []).map((e) => `${e.code}: ${e.message}`).join('; ');
    throw new DnsError(msg || `HTTP ${res.status}`, res.status, json.errors);
  }
  return json;
}

/** 建一条 TXT 记录，返回记录 ID。 */
export async function createTxt(env, { name, content, ttl, comment }) {
  const json = await call(env, 'POST', '/dns_records', {
    type: 'TXT',
    name,
    content,
    ttl,
    comment,
  });
  return json.result.id;
}

/**
 * 删一条记录。幂等：记录已不存在时视为成功。
 * DO 闹钟在极少数情况下会重复触发，所以这里必须幂等。
 */
export async function deleteRecord(env, recordId) {
  try {
    await call(env, 'DELETE', `/dns_records/${recordId}`);
    return 'deleted';
  } catch (err) {
    if (err.status === 404 || err.errors.some((e) => e.code === 81044)) {
      return 'already-gone';
    }
    throw err;
  }
}

/** 列出本项目建的所有 TXT 记录（靠 comment 前缀区分，不碰 zone 里的其他记录）。 */
export async function listOurTxt(env) {
  const out = [];
  let page = 1;
  for (;;) {
    const qs = new URLSearchParams({
      type: 'TXT',
      per_page: '100',
      page: String(page),
      'comment.startswith': env.RECORD_TAG,
    });
    const json = await call(env, 'GET', `/dns_records?${qs}`);
    out.push(...json.result);
    const info = json.result_info || {};
    if (!info.total_pages || page >= info.total_pages) break;
    page++;
    if (page > 20) break; // 安全阀，别把限流额度烧光
  }
  return out;
}

/** 从我们的记录里挑出最接近过期的那条（comment 形如 RECORD_TAG:<过期毫秒时间戳>）。 */
export function soonestExpiring(records) {
  let best = null;
  for (const r of records) {
    const at = Number((r.comment || '').split(':')[1]);
    if (!Number.isFinite(at)) continue;
    if (!best || at < best.at) best = { at, record: r };
  }
  return best ? best.record : null;
}

/**
 * 记录满了就把最接近过期的那条提前删掉腾位置，而不是让人等。
 * 返回被删的记录；没有可删的返回 null。
 */
export async function evictSoonest(env) {
  const victim = soonestExpiring(await listOurTxt(env));
  if (!victim) return null;
  await deleteRecord(env, victim.id);
  return victim;
}

/** 当前占用的记录数，用于卡住 200 条上限。 */
export async function countOurTxt(env) {
  const qs = new URLSearchParams({
    type: 'TXT',
    per_page: '1',
    'comment.startswith': env.RECORD_TAG,
  });
  const json = await call(env, 'GET', `/dns_records?${qs}`);
  return json.result_info?.total_count ?? 0;
}

export { DnsError };
