/**
 * effect/disposer 最小惯例 (C1, dsh/cordis 吸收计划线 C, 2026-08-17)。
 *
 * 从 cordis Fiber.effect 学形状, 只取三条硬语义, 不引 fiber/Context 系统:
 *   ① disposer 按注册的**逆序**执行 (后建的资源先拆 —— 依赖别人的先走);
 *   ② `dispose()` 重复调用 no-op, 每个 disposer 至多跑一次;
 *   ③ 单个 disposer 抛错**不阻断其余** —— fail-open 可以吞异常, 不许吞证据:
 *      错误原文 + label 经 warn 留痕 (本仓静默失效纪律第 2 条)。
 *
 * 适用面: 长活资源 (连接池/watcher/子进程/临时目录)。**存量不回改** (Surgical);
 * 新资源必须经此注册 —— 首个生产消费方 = omd pack 的安装临时世界 (A3), 其后 D1 ext v2。
 * 在已 dispose 的 scope 上再注册 = 编程错误, 直接 throw (同 cordis INACTIVE_EFFECT,
 * 这里 fail-open 没有意义: 静默接受等于资源永不释放)。
 */

export type Disposer = () => void | Promise<void>;

export interface EffectScope {
  /** 注册一个 disposer。返回提前释放函数 (执行并从 scope 摘除, 之后 dispose() 不再跑它)。 */
  defer(dispose: Disposer, label?: string): () => Promise<void>;
  /** 逆序执行全部 disposer。重复调用返回同一个 promise (no-op)。 */
  dispose(): Promise<void>;
  readonly disposed: boolean;
}

export function createEffectScope(warn: (msg: string) => void = (m) => console.warn(m)): EffectScope {
  type Entry = { run: Disposer; label: string; done: boolean };
  const entries: Entry[] = [];
  let disposing: Promise<void> | undefined;

  async function runOne(entry: Entry): Promise<void> {
    if (entry.done) return;
    entry.done = true;
    try {
      await entry.run();
    } catch (err) {
      warn(`effect[${entry.label}] disposer 抛错 (已继续拆其余): ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    }
  }

  return {
    get disposed() {
      return disposing != null;
    },
    defer(dispose, label = 'anonymous') {
      if (disposing) throw new Error(`effect: scope 已 dispose, 拒绝注册 "${label}" (资源将永不释放)`);
      const entry: Entry = { run: dispose, label, done: false };
      entries.push(entry);
      return () => runOne(entry);
    },
    dispose() {
      disposing ??= (async () => {
        for (const entry of [...entries].reverse()) await runOne(entry);
      })();
      return disposing;
    },
  };
}
