import { DurableObject } from 'cloudflare:workers';
import { createTxt, countOurTxt, evictSoonest, DnsError } from './dns.js';

// 邀请码字母表：去掉了 0/o、1/l/i 这些容易看混的字符
const CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
function randomCode(len = 10) {
  let s = '';
  while (s.length < len) {
    const [b] = crypto.getRandomValues(new Uint8Array(1));
    if (b < 248) s += CODE_ALPHABET[b % CODE_ALPHABET.length]; // 248 = 31*8，拒绝采样去掉取模偏差
  }
  return s;
}

/**
 * 全站只有一个 PostGate 实例（idFromName('gate')），所有发帖都经过它。
 *
 * 为什么需要它：「数一下 → 满了就挤掉一条 → 建记录」是三次 API 调用，
 * 并发的请求会看到同一个计数、挤掉同一条记录，然后各建各的，
 * 实测 10 个并发能把上限冲过去 8 条。放进一个实例里排队执行就没有这个问题。
 *
 * 有额度的邀请码也存在这里（SQLite），扣额度和建记录在同一次排队里完成。
 * secret 里的静态码不限量，不进这张表。
 *
 * 注意 DO 的 input gate 只在等 storage 时挡新事件，等 fetch() 时不挡，
 * 所以这里自己用一条 promise 链把请求串起来。
 */
export class PostGate extends DurableObject {
  #queue = Promise.resolve();

  constructor(ctx, env) {
    super(ctx, env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS invites (
      code    TEXT PRIMARY KEY,
      quota   INTEGER NOT NULL,
      used    INTEGER NOT NULL DEFAULT 0,
      note    TEXT NOT NULL DEFAULT '',
      created INTEGER NOT NULL
    )`);
  }

  /* ---------- 邀请码 ---------- */

  #row(code) {
    // 生成的码都是小写；有人照着截图敲成大写也认
    return this.ctx.storage.sql.exec('SELECT * FROM invites WHERE code = ?', String(code).toLowerCase()).toArray()[0] || null;
  }

  /** 查一个码还剩多少：{ ok, quota, used, left }；不存在时 { ok:false }。 */
  check(code) {
    const r = this.#row(code);
    if (!r) return { ok: false };
    return { ok: r.used < r.quota, quota: r.quota, used: r.used, left: Math.max(0, r.quota - r.used) };
  }

  /** 生成 count 个额度为 quota 的码。 */
  issue({ quota, count = 1, note = '' }) {
    const now = Date.now();
    const out = [];
    for (let i = 0; i < count; i++) {
      const code = randomCode();
      this.ctx.storage.sql.exec(
        'INSERT INTO invites (code, quota, used, note, created) VALUES (?, ?, 0, ?, ?)',
        code, quota, note, now
      );
      out.push({ code, quota, used: 0, left: quota, note, created: now });
    }
    return out;
  }

  list() {
    return this.ctx.storage.sql.exec('SELECT * FROM invites ORDER BY created DESC').toArray()
      .map((r) => ({ ...r, left: Math.max(0, r.quota - r.used) }));
  }

  revoke(code) {
    return this.ctx.storage.sql.exec('DELETE FROM invites WHERE code = ?', code).rowsWritten > 0;
  }

  /* ---------- 发帖 ---------- */

  /**
   * 串行地验邀请码、腾位置、建记录、扣额度。
   * 返回 { ok:true, recordId, evicted, left } 或 { ok:false, status, message, left? }，
   * 不抛 DnsError —— 跨 RPC 边界自定义字段会丢。left 为 null 表示不限量。
   */
  async create(req) {
    const run = this.#queue.then(() => this.#create(req), () => this.#create(req));
    this.#queue = run.catch(() => {}); // 一个失败不能卡住后面的
    return run;
  }

  async #create({ invite, unlimited, name, content, ttl, comment, cap }) {
    // 先验邀请码。静态码不限量；生成的码看额度。
    let row = null;
    if (!unlimited) {
      row = this.#row(invite);
      if (!row) return { ok: false, status: 403, message: '邀请码无效' };
      if (row.used >= row.quota) return { ok: false, status: 403, message: '这个邀请码的额度用完了', left: 0 };
    }

    let evicted = false;
    try {
      if ((await countOurTxt(this.env)) >= cap) {
        evicted = Boolean(await evictSoonest(this.env));
        if (!evicted) {
          return { ok: false, status: 503, message: `已达记录上限（${cap}），等一些帖子过期后再发` };
        }
      }
      const recordId = await createTxt(this.env, { name, content, ttl, comment });

      // 记录建成了才扣额度，失败不算
      let left = null;
      if (row) {
        this.ctx.storage.sql.exec('UPDATE invites SET used = used + 1 WHERE code = ?', row.code);
        left = row.quota - row.used - 1;
      }
      return { ok: true, recordId, evicted, left };
    } catch (err) {
      if (err instanceof DnsError) {
        if (err.status === 429) return { ok: false, status: 429, message: 'API 限流，稍后再试' };
        return { ok: false, status: 502, message: `建记录失败：${err.message}` };
      }
      throw err;
    }
  }
}
