import { DurableObject } from 'cloudflare:workers';
import { createTxt, deleteRecord, batchDelete, DnsError } from './dns.js';

const ttlLabel = (t) => (t < 3600 ? `${t / 60} 分钟` : t < 86400 ? `${t / 3600} 小时` : `${t / 86400} 天`);

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

// 到点前这么久以内的记录并进同一批删，省一次调用；代价是帖子最多提前这么点时间消失
const REAP_WINDOW_MS = 2000;
// 删除失败后过多久再试（限流窗口是 5 分钟，cron 对账也会兜底）
const REAP_RETRY_MS = 60_000;

/**
 * 全站只有一个 PostGate 实例（idFromName('gate')），所有发帖都经过它。
 *
 * 为什么需要它：「数一下 → 满了就挤掉一条 → 建记录」并发执行时，
 * 多个请求会看到同一个计数、挤掉同一条记录，然后各建各的，
 * 实测 10 个并发能把上限冲过去 8 条。放进一个实例里排队执行就没有这个问题。
 *
 * 它还记着一份台账（posts 表）：本站建的每条记录的 ID 和过期时间。
 * 计数、挑最接近过期的、到点删除都查这张表，不用问 API ——
 * 每条帖子只花 1 次 API 调用（建记录），到点的记录攒成一批一次删掉。
 * 真相仍在 Cloudflare 那边，每分钟的 cron 用 API 列表把台账校正一遍（reconcile）。
 *
 * 有额度的邀请码也存在这里（SQLite），扣额度和建记录在同一次排队里完成。
 * secret 里的静态码不限量，不进那张表。
 *
 * 注意 DO 的 input gate 只在等 storage 时挡新事件，等 fetch() 时不挡，
 * 所以这里自己用一条 promise 链把发帖、闹钟、对账串起来。
 */
export class PostGate extends DurableObject {
  #queue = Promise.resolve();
  // 删除失败后的退避截止时间。只在内存里，实例重启就清零，顶多多试一次
  #notBefore = 0;

  constructor(ctx, env) {
    super(ctx, env);
    const sql = ctx.storage.sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS invites (
      code    TEXT PRIMARY KEY,
      quota   INTEGER NOT NULL,
      used    INTEGER NOT NULL DEFAULT 0,
      note    TEXT NOT NULL DEFAULT '',
      created INTEGER NOT NULL,
      max_ttl INTEGER NOT NULL DEFAULT 120
    )`);
    // 老表没有 max_ttl 列就补上
    const cols = sql.exec('PRAGMA table_info(invites)').toArray().map((c) => c.name);
    if (!cols.includes('max_ttl')) sql.exec('ALTER TABLE invites ADD COLUMN max_ttl INTEGER NOT NULL DEFAULT 120');
    // 1 分钟这一档已经取消，之前按 60 秒发的码提到 2 分钟，不然它们什么都发不了
    sql.exec('UPDATE invites SET max_ttl = 120 WHERE max_ttl < 120');

    sql.exec(`CREATE TABLE IF NOT EXISTS posts (
      record_id  TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created    INTEGER NOT NULL
    )`);
    sql.exec('CREATE INDEX IF NOT EXISTS posts_expires ON posts (expires_at)');
  }

  /** 把一件事排到队尾。一件失败不能卡住后面的。 */
  #run(fn) {
    const run = this.#queue.then(fn, fn);
    this.#queue = run.catch(() => {});
    return run;
  }

  /* ---------- 邀请码 ---------- */

  #row(code) {
    // 生成的码都是小写；有人照着截图敲成大写也认
    return this.ctx.storage.sql.exec('SELECT * FROM invites WHERE code = ?', String(code).toLowerCase()).toArray()[0] || null;
  }

  /** 查一个码还剩多少、最长能发多久：{ ok, quota, used, left, maxTtl }；不存在时 { ok:false }。 */
  check(code) {
    const r = this.#row(code);
    if (!r) return { ok: false };
    return { ok: r.used < r.quota, quota: r.quota, used: r.used, left: Math.max(0, r.quota - r.used), maxTtl: r.max_ttl };
  }

  /** 生成 count 个额度为 quota、最长存活 maxTtl 秒的码。 */
  issue({ quota, count = 1, note = '', maxTtl = 120 }) {
    const now = Date.now();
    const out = [];
    for (let i = 0; i < count; i++) {
      const code = randomCode();
      this.ctx.storage.sql.exec(
        'INSERT INTO invites (code, quota, used, note, created, max_ttl) VALUES (?, ?, 0, ?, ?, ?)',
        code, quota, note, now, maxTtl
      );
      out.push({ code, quota, used: 0, left: quota, maxTtl, note, created: now });
    }
    return out;
  }

  list() {
    return this.ctx.storage.sql.exec('SELECT * FROM invites ORDER BY created DESC').toArray()
      .map(({ max_ttl, ...r }) => ({ ...r, left: Math.max(0, r.quota - r.used), maxTtl: max_ttl }));
  }

  revoke(code) {
    return this.ctx.storage.sql.exec('DELETE FROM invites WHERE code = ?', code).rowsWritten > 0;
  }

  /* ---------- 台账 ---------- */

  #count() {
    return this.ctx.storage.sql.exec('SELECT COUNT(*) AS n FROM posts').one().n;
  }

  #soonest() {
    return this.ctx.storage.sql.exec('SELECT record_id FROM posts ORDER BY expires_at LIMIT 1').toArray()[0] || null;
  }

  #remember(recordId, name, expiresAt) {
    this.ctx.storage.sql.exec(
      'INSERT OR REPLACE INTO posts (record_id, name, expires_at, created) VALUES (?, ?, ?, ?)',
      recordId, name, expiresAt, Date.now()
    );
  }

  #forget(ids) {
    for (const id of ids) this.ctx.storage.sql.exec('DELETE FROM posts WHERE record_id = ?', id);
  }

  /** 新记录进台账后，闹钟只会往前拨，不会往后拨。 */
  async #armAlarm(at) {
    at = Math.max(at, this.#notBefore);
    const cur = await this.ctx.storage.getAlarm();
    if (cur == null || at < cur) await this.ctx.storage.setAlarm(at);
  }

  /** 把闹钟拨到台账里最早过期的那条；台账空了就取消。 */
  async #rearm() {
    const { t } = this.ctx.storage.sql.exec('SELECT MIN(expires_at) AS t FROM posts').one();
    if (t == null) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(Math.max(t, this.#notBefore));
  }

  /* ---------- 发帖 ---------- */

  /**
   * 串行地验邀请码、腾位置、建记录、扣额度。
   * 返回 { ok:true, recordId, evicted, left } 或 { ok:false, status, message, left? }，
   * 不抛 DnsError —— 跨 RPC 边界自定义字段会丢。left 为 null 表示不限量。
   */
  create(req) {
    return this.#run(() => this.#create(req));
  }

  async #create({ invite, unlimited, name, content, ttl, comment, expiresAt, cap }) {
    // 先验邀请码。静态码不限量；生成的码看额度。
    let row = null;
    if (!unlimited) {
      row = this.#row(invite);
      if (!row) return { ok: false, status: 403, message: '邀请码无效' };
      if (row.used >= row.quota) return { ok: false, status: 403, message: '这个邀请码的额度用完了', left: 0, maxTtl: row.max_ttl };
      if (ttl > row.max_ttl) {
        return {
          ok: false, status: 400,
          message: `这个邀请码最长只能发 ${ttlLabel(row.max_ttl)}的帖子`,
          left: row.quota - row.used, maxTtl: row.max_ttl,
        };
      }
    }

    let evicted = false;
    try {
      // 满了就把台账里最接近过期的删掉腾位置。台账可能比 zone 多（有人在面板上手删了），
      // 删到一条已经不存在的记录时只是台账少一行，回头再看还满不满。
      while (this.#count() >= cap) {
        const victim = this.#soonest();
        if (!victim) return { ok: false, status: 503, message: `已达记录上限（${cap}），等一些帖子过期后再发` };
        const result = await deleteRecord(this.env, victim.record_id);
        this.#forget([victim.record_id]);
        if (result === 'deleted') {
          evicted = true;
          break;
        }
      }

      const recordId = await createTxt(this.env, { name, content, ttl, comment });
      this.#remember(recordId, name, expiresAt);
      await this.#armAlarm(expiresAt);

      // 记录建成了才扣额度，失败不算
      let left = null;
      if (row) {
        this.ctx.storage.sql.exec('UPDATE invites SET used = used + 1 WHERE code = ?', row.code);
        left = row.quota - row.used - 1;
      }
      return { ok: true, recordId, evicted, left, maxTtl: row ? row.max_ttl : null };
    } catch (err) {
      if (err instanceof DnsError) {
        if (err.status === 429) return { ok: false, status: 429, message: 'API 限流，稍后再试' };
        return { ok: false, status: 502, message: `建记录失败：${err.message}` };
      }
      throw err;
    }
  }

  /* ---------- 到点删除 ---------- */

  /**
   * 闹钟不会自动重复，每次删完都要重新拨；极少数情况下会重复触发，
   * 而删除是幂等的，所以重复触发无害。
   */
  alarm() {
    return this.#run(() => this.#reap());
  }

  /** 把台账里所有到点（含 REAP_WINDOW_MS 内即将到点）的记录一批删掉，再把闹钟拨到下一条。 */
  async #reap() {
    const due = this.ctx.storage.sql
      .exec('SELECT record_id FROM posts WHERE expires_at <= ?', Date.now() + REAP_WINDOW_MS)
      .toArray().map((r) => r.record_id);
    let gone = [];
    if (due.length) {
      try {
        gone = await batchDelete(this.env, due);
      } catch (err) {
        console.error('到点删除失败', due.length, err.message);
      }
      this.#forget(gone);
      console.log(`到点删除：${gone.length} / ${due.length} 条`);
      // 没删干净（限流或网络抖动）：过一会儿再试，cron 对账也会兜底
      this.#notBefore = gone.length < due.length ? Date.now() + REAP_RETRY_MS : 0;
    }
    await this.#rearm();
    return { due: due.length, gone: gone.length };
  }

  /* ---------- 对账 ---------- */

  /**
   * 用 API 列表校正台账（cron 每分钟调一次）：
   * 面板上手删的、台账丢的、上个版本建的记录，这一步都对齐。
   * listedAt 是取列表那一刻的时间，之后新建的记录还没来得及出现在列表里，不能当作已删除。
   * 对齐后顺手把已过期的删掉。
   */
  reconcile(records, listedAt) {
    return this.#run(async () => {
      const sql = this.ctx.storage.sql;
      const listed = new Set(records.map((r) => r.id));
      const stale = sql.exec('SELECT record_id FROM posts WHERE created < ?', listedAt).toArray()
        .filter((r) => !listed.has(r.record_id)).map((r) => r.record_id);
      this.#forget(stale);

      const before = this.#count();
      for (const r of records) {
        sql.exec(
          'INSERT OR IGNORE INTO posts (record_id, name, expires_at, created) VALUES (?, ?, ?, ?)',
          r.id, r.name, r.expiresAt, listedAt
        );
      }
      const added = this.#count() - before;

      const reaped = await this.#reap();
      return { removed: stale.length, added, live: this.#count(), ...reaped };
    });
  }
}
