/**
 * MiMo API key env 桥 (单一真理源)。
 *
 * 本仓 `.env` 用 `MIMO_API_KEY` (人类记得住); pi-ai 的 `xiaomi-token-plan-ams` provider 经
 * getEnvApiKey 自动读 `XIAOMI_TOKEN_PLAN_AMS_API_KEY`。此处别名一下, 不必重复输 key。
 * 注: tp- token-plan key 区域锁 (the owner=AMS, 其它区 401); 换区先 probe 三区 (见 [[reference-mimo-api]])。
 */

/** provider 是 ams MiMo 且仅有 MIMO_API_KEY 时, 把它桥成 pi-ai 期望的 env key。幂等。 */
export function ensureMimoApiKey(provider: string): void {
  if (
    provider === 'xiaomi-token-plan-ams' &&
    !process.env.XIAOMI_TOKEN_PLAN_AMS_API_KEY &&
    process.env.MIMO_API_KEY
  ) {
    process.env.XIAOMI_TOKEN_PLAN_AMS_API_KEY = process.env.MIMO_API_KEY;
  }
}
