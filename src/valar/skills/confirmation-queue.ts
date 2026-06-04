/**
 * src/valar/skills/confirmation-queue — 非打断式确认队列 (the owner 2026-06-03)。
 *
 * 自动产生的"要不要做 X"提议**排队**, 在 session 空档 (agent_end 回合间) 逐个弹 yes/no —— 绝不在
 * agent 回合中插入, 一次只弹一个 (modal 期间 showing 闸 block 重入), 用户拒过的不再本 session 重问。
 *
 * 通用 (key/title/message/apply 任意实体), skill 治理是首个 producer; optimize/gene 后续同用。
 * 纯逻辑 + 注入 confirm fn → 完全可测 (不依赖 pi/TUI)。
 */
export interface PendingConfirm {
  /** 去重键 (同 key 不重复入队; 拒绝后本 session 不再问)。 */
  key: string;
  title: string;
  message: string;
  /** 用户确认后执行 (yes 才跑)。 */
  apply: () => void | Promise<void>;
}

export type DrainOutcome = 'applied' | 'dismissed' | 'idle' | 'busy';

export class ConfirmationQueue {
  private readonly items: PendingConfirm[] = [];
  private readonly dismissed = new Set<string>();
  private showing = false;

  /** 入队。已 pending 同 key / 本 session 已拒 → 跳过 (返 false)。 */
  enqueue(item: PendingConfirm): boolean {
    if (this.dismissed.has(item.key)) return false;
    if (this.items.some((i) => i.key === item.key)) return false;
    this.items.push(item);
    return true;
  }

  size(): number {
    return this.items.length;
  }

  pendingKeys(): string[] {
    return this.items.map((i) => i.key);
  }

  /**
   * 弹下一个确认。modal 进行中 → 'busy' (不重入); 空 → 'idle'。
   * yes → apply() 后出队 'applied'; no → 出队 + 记 dismissed 'dismissed'。
   * confirm 注入 (pi 的 ctx.ui.confirm 或测试 fake)。
   */
  async drainOne(confirm: (title: string, message: string) => Promise<boolean>): Promise<DrainOutcome> {
    if (this.showing) return 'busy';
    const item = this.items[0];
    if (!item) return 'idle';
    this.showing = true;
    try {
      const ok = await confirm(item.title, item.message);
      this.items.shift(); // confirm 决出后才出队 (期间 showing 闸 + dedup 防并发重复)
      if (ok) {
        await item.apply();
        return 'applied';
      }
      this.dismissed.add(item.key);
      return 'dismissed';
    } finally {
      this.showing = false;
    }
  }
}
