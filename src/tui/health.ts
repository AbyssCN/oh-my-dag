/**
 * src/tui/health —— **上下文健康度一行**(切片⑤,v5 切片表 #5)。
 *
 * 判据:同一会话里 `read` 同一个文件 ≥3 次 → 出一行提示;**平时不占位**
 * (`line()` 返回 `null`,调用方靠 visible 回调把整行摘掉,不是画一行空白)。
 *
 * 为什么盯这个:重复读 = 同一份内容在上下文里存了多份,窗口在被静默吃掉。
 * 提示只报**最重的那个**文件 —— 列全表就成了第二张 HUD,一行的意义就没了。
 */

/** 触发阈值。第 3 次读同一个文件时亮。 */
export const REREAD_THRESHOLD = 3;

export interface ContextHealth {
  /** 喂一次工具调用(只认 `read` 且带 path;别的调用不计)。 */
  onTool(name: string, args: unknown): void;
  /** 换会话时清零 —— 计数是一条会话的上下文状态,不是 UI 进程的。 */
  reset(): void;
  /** 当前提示行。`null` = 健康(不占位)。 */
  line(): string | null;
}

export function createContextHealth(threshold = REREAD_THRESHOLD): ContextHealth {
  const reads = new Map<string, number>();
  return {
    onTool(name, args) {
      if (name !== 'read') return;
      const path = (args as { path?: unknown } | undefined)?.path;
      if (typeof path !== 'string' || !path) return;
      reads.set(path, (reads.get(path) ?? 0) + 1);
    },
    reset() {
      reads.clear();
    },
    line() {
      let worst: { path: string; n: number } | null = null;
      for (const [path, n] of reads) {
        if (n >= threshold && (!worst || n > worst.n)) worst = { path, n };
      }
      if (!worst) return null;
      return `Context health: read ${worst.path} ${worst.n}x already - it is most likely still in context, refer to it instead of reading again`;
    },
  };
}
