// go-fallback.ts — opencode-go (GO 订阅) 端点偶发溢出/5xx → 回退 deepseek 官方 (ds-v4-pro) 一次。
//
// 治的洞 (2026-06-20 reconfig 收尾): A 层 reason/synth/judge/verifier 走 opencode-go:* (订阅 $0 成本),
//   但 GO 端点偶发 context 溢出 / 429 / 5xx → 整轮 fanout 或 verifier 失败。回退到官方 deepseek-v4-pro
//   (有钱、稳) 保证产出。只对 `opencode-go:` 坐标生效, 其它模型失败照常抛 (别吞真错误)。

/** GO 失败时的官方回退坐标 (deepseek 官方账户, 实测稳)。 */
export const GO_FALLBACK_MODEL = 'deepseek:deepseek-v4-pro';

/** model 是否走 GO 订阅端点 (= 该挂回退)。 */
export function isGoModel(model: string): boolean {
  return typeof model === 'string' && model.startsWith('opencode-go:');
}

/**
 * 跑 run(model); 若 model 是 GO 坐标且抛错 → 用 GO_FALLBACK_MODEL 重试一次。
 * 非 GO 模型失败 → 原样抛 (不掩盖真错误)。回退也失败 → 抛回退的错。
 */
export async function withGoFallback<T>(
  model: string,
  run: (m: string) => Promise<T>,
  fallbackModel: string = GO_FALLBACK_MODEL,
): Promise<T> {
  try {
    return await run(model);
  } catch (e) {
    if (isGoModel(model)) return run(fallbackModel);
    throw e;
  }
}
