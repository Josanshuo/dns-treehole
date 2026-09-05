import { DurableObject } from 'cloudflare:workers';
import { createTxt, countOurTxt, evictSoonest, DnsError } from './dns.js';

/**
 * 全站只有一个 PostGate 实例（idFromName('gate')），所有发帖都经过它。
 *
 * 为什么需要它：「数一下 → 满了就挤掉一条 → 建记录」是三次 API 调用，
 * 并发的请求会看到同一个计数、挤掉同一条记录，然后各建各的，
 * 实测 10 个并发能把上限冲过去 8 条。放进一个实例里排队执行就没有这个问题。
 *
 * 注意 DO 的 input gate 只在等 storage 时挡新事件，等 fetch() 时不挡，
 * 所以这里自己用一条 promise 链把请求串起来。
 */
export class PostGate extends DurableObject {
  #queue = Promise.resolve();

  /**
   * 串行地为一条帖子腾位置并建记录。
   * 返回 { ok:true, recordId, evicted } 或 { ok:false, status, message }，
   * 不抛 DnsError —— 跨 RPC 边界自定义字段会丢。
   */
  async create(req) {
    const run = this.#queue.then(() => this.#create(req), () => this.#create(req));
    this.#queue = run.catch(() => {}); // 一个失败不能卡住后面的
    return run;
  }

  async #create({ name, content, ttl, comment, cap }) {
    let evicted = false;
    try {
      if ((await countOurTxt(this.env)) >= cap) {
        evicted = Boolean(await evictSoonest(this.env));
        if (!evicted) {
          return { ok: false, status: 503, message: `已达记录上限（${cap}），等一些帖子过期后再发` };
        }
      }
      const recordId = await createTxt(this.env, { name, content, ttl, comment });
      return { ok: true, recordId, evicted };
    } catch (err) {
      if (err instanceof DnsError) {
        if (err.status === 429) return { ok: false, status: 429, message: 'API 限流，稍后再试' };
        return { ok: false, status: 502, message: `建记录失败：${err.message}` };
      }
      throw err;
    }
  }
}
