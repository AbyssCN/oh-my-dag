/**
 * 截断上报 (owner 2026-07-28)。
 *
 * 背景 bug: provider 报 `finish_reason: 'length'` 且正文**非空**时, 老路径原样返回半截答案 ——
 * `finishReason` 字段有生产者、**零消费者**, 全仓没人看。后果是综合/终稿被腰斩后当成品往下游传:
 * 一次 eval 里 kimi 综合器写完收尾 (out 5892), 同题 deepseek/minimax 顶满 8k 交半截文, 判分掉 3-4 个点,
 * 看上去像"模型更差"或"择优丢点", 实际是预算不够写完。静默失败伪装成质量差异, 是最贵的那类 bug。
 *
 * 这里给一个与 accounting 同形的观察者接缝: 宿主可订阅 (接进 onStage/HUD/日志); 无人订阅时
 * 兜底写 stderr —— **绝不静默**。上报本身 fail-open, 不下沉主流程。
 */
export interface TruncationInfo {
  /** 解析后的 'provider:modelId'。 */
  model: string;
  /** 实际输出 token 数 (≈ 请求的 cap)。 */
  out: number;
  /** 本次请求给的 maxTokens (省略 = 走 provider/transport 默认)。 */
  cap?: number;
  /** 调用角色标签 (可观测), 如 'fanout-leaf'。 */
  role?: string;
}

export type TruncationObserver = (info: TruncationInfo) => void;

const observers = new Set<TruncationObserver>();

/** 订阅截断事件; 返回取消订阅。 */
export function onTruncation(fn: TruncationObserver): () => void {
  observers.add(fn);
  return () => observers.delete(fn);
}

/** 上报一次截断。无订阅者 → 兜底 stderr (可见性是这条的全部意义)。 */
export function reportTruncation(info: TruncationInfo): void {
  if (observers.size === 0) {
    process.stderr.write(
      `[truncated] ${info.model}${info.role ? ` (${info.role})` : ''} 输出撞到上限 out=${info.out}${info.cap ? ` cap=${info.cap}` : ''} — 正文被截断, 抬 maxTokens 或让它续写\n`,
    );
    return;
  }
  for (const fn of observers) {
    try {
      fn(info);
    } catch {
      /* 上报不下沉主流程 */
    }
  }
}
