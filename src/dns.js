/**
 * Cloudflare DNS API 的最小封装。
 *
 * 全局速率限制是 1200 次 / 5 分钟，按用户累计，dashboard 操作也吃同一份额度。
 * 每条帖子只消耗 1 次（建记录）；删除按批合并成一次调用，计数和挑腾位对象
 * 都查 PostGate 自己的台账，不问 API。
 */

const API = 'https://api.cloudflare.com/client/v4';

// batch 接口一次最多处理多少条记录（免费版 200，付费档 3500）
const BATCH_MAX = 200;

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
 * 腾位时台账里的记录可能已经被人在面板上手删了，所以这里必须幂等。
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

/**
 * 一次调用删一批记录（batch 接口各档位都能用）。返回确认已不存在的记录 ID。
 *
 * 批里只要有一条失败整批都不生效（比如某条已经被删过了），这时退回逐条删，
 * 逐条是幂等的。限流或网络故障则立刻停手，把已确认的部分返回，让调用方稍后再试。
 */
export async function batchDelete(env, ids) {
  const gone = [];
  for (let i = 0; i < ids.length; i += BATCH_MAX) {
    const chunk = ids.slice(i, i + BATCH_MAX);
    try {
      await call(env, 'POST', '/dns_records/batch', { deletes: chunk.map((id) => ({ id })) });
      gone.push(...chunk);
      continue;
    } catch (err) {
      if (!(err instanceof DnsError) || err.status === 429) return gone;
      console.error('批量删除整批失败，改为逐条', err.message);
    }
    for (const id of chunk) {
      try {
        await deleteRecord(env, id);
        gone.push(id);
      } catch (err) {
        if (!(err instanceof DnsError) || err.status === 429) return gone;
        console.error('删除失败', id, err.message);
      }
    }
  }
  return gone;
}

/** 列出本项目建的所有 TXT 记录（靠 comment 前缀区分，不碰 zone 里的其他记录）。 */
export async function listOurTxt(env) {
  const out = [];
  let page = 1;
  for (;;) {
    const qs = new URLSearchParams({
      type: 'TXT',
      per_page: '500',
      page: String(page),
      'comment.startswith': env.RECORD_TAG,
    });
    const json = await call(env, 'GET', `/dns_records?${qs}`);
    out.push(...json.result);
    const info = json.result_info || {};
    if (!info.total_pages || page >= info.total_pages) break;
    page++;
    if (page > 5) break; // 安全阀，别把限流额度烧光
  }
  return out;
}

/** 从记录 comment（RECORD_TAG:<过期毫秒时间戳>）里取过期时间；解析不出返回 null。 */
export function expiryOf(record) {
  const at = Number((record.comment || '').split(':')[1]);
  return Number.isFinite(at) ? at : null;
}

export { DnsError };
