import { DurableObject } from 'cloudflare:workers';
import { deleteRecord } from './dns.js';

/**
 * 一条帖子一个 PostReaper 实例，用 recordId 作为 DO 的名字。
 *
 * 官方文档明确提醒两点，这里都处理了：
 *   1. 闹钟不会自动重复，需要重新 setAlarm()
 *   2. 极少数情况下闹钟会重复触发，所以 alarm() 必须幂等
 *      —— 删除天然幂等，deleteRecord() 把 404 当成功。
 */
export class PostReaper extends DurableObject {
  /** 发帖时调用：登记记录 ID 并设好闹钟。 */
  async schedule(recordId, expiresAtMs) {
    await this.ctx.storage.put('recordId', recordId);
    await this.ctx.storage.put('attempts', 0);
    await this.ctx.storage.setAlarm(expiresAtMs);
  }

  async alarm() {
    const recordId = await this.ctx.storage.get('recordId');
    if (!recordId) return; // 已经处理过

    try {
      await deleteRecord(this.env, recordId);
      await this.ctx.storage.deleteAll(); // 用完即弃，不留 SQLite 存储
    } catch (err) {
      // 限流或网络抖动：退避重试，最多 6 次（约 1+2+4+8+16+32 分钟）
      const attempts = ((await this.ctx.storage.get('attempts')) ?? 0) + 1;
      if (attempts > 6) {
        // 放弃，交给每分钟的 cron 兜底对账
        await this.ctx.storage.deleteAll();
        return;
      }
      await this.ctx.storage.put('attempts', attempts);
      await this.ctx.storage.setAlarm(Date.now() + 2 ** attempts * 30_000);
    }
  }
}
