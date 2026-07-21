/**
 * mimo-provider —— 小米 MiMo 的 pi 会话 provider 扩展 (走 pi.registerProvider)。
 *
 * ⛔ 现状 (2026-07-21 实证, 别被下面"背景"骗): **本扩展让 mimo 当 agent-leaf 是不工作的。**
 * 亲测: 挂载后 agent-leaf 用 `mimo:...` 仍 0-token 静默失败 —— `pi.registerProvider` 注册进 **session
 * ModelRegistry**, 但 agent-leaf:190 的 compat `getModel` 读**另一个全局 store** 看不到; 且自定 provider
 * 的 api 调用在 pi session modelRuntime 里没接上 (deepseek pi-native 通、mimo 自定不通)。故 `mimo:` 只在
 * **callModel 栈** (conductor / inproc / verifier, 走 xihe registry) 可用, 做 agent-leaf 用不了。
 *
 * ✅ mimo 当 agent-leaf 的**真路径** = `~/.pi/agent/models.json` 里的 provider **`mimo-platform`**
 *   (baseUrl + `$MIMO_PLATFORM_API_KEY` + openai-completions), 坐标写 `mimo-platform:mimo-v2.5-pro-ultraspeed`。
 *   pi ModelRuntime 从 models.json 加载, runtime.getModel 认得 —— 这才是 agent-fleet 模型正门。
 *
 * 📌 本文件保留作**统一-registry SDD (docs/plan/2026-07-21-unified-model-registry.md) D-2 的参考**
 *   (generic 自定-provider pi 接线待实现); D-2 落地时连同 3 处挂载 (agent-leaf/pi-runtime/tui) 一并删。
 */
import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';

/** thinkingLevel → provider reasoning 档 (镜像 deepseek: high→high, max→max, 其余不发)。 */
const THINKING_MAP: Record<'minimal' | 'low' | 'medium' | 'high' | 'max', string | null> = {
  minimal: null,
  low: null,
  medium: null,
  high: 'high',
  max: 'max',
};

/** mimo 模型静态目录。cost 与 src/model/cost-ledger 同步; contextWindow/maxTokens 取保守够用值 (防截断)。 */
const MIMO_MODELS = [
  {
    id: 'mimo-v2.5-pro-ultraspeed',
    name: 'MiMo v2.5 Pro Ultraspeed',
    reasoning: true,
    input: ['text'] as ('text' | 'image')[],
    cost: { input: 1.5, output: 6.0, cacheRead: 0.3, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 16_384,
    thinkingLevelMap: THINKING_MAP,
  },
  {
    id: 'mimo-v2.5-pro',
    name: 'MiMo v2.5 Pro',
    reasoning: true,
    input: ['text'] as ('text' | 'image')[],
    cost: { input: 0.5, output: 2.0, cacheRead: 0.1, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 16_384,
    thinkingLevelMap: THINKING_MAP,
  },
  {
    id: 'mimo-v2.5',
    name: 'MiMo v2.5',
    reasoning: true,
    input: ['text'] as ('text' | 'image')[],
    cost: { input: 0.5, output: 2.0, cacheRead: 0.1, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 16_384,
    thinkingLevelMap: THINKING_MAP,
  },
];

/**
 * pi 扩展: 把 mimo 经 registerProvider 正门登记进会话 ModelRegistry。
 * 无凭证 (MIMO_BASE_URL / MIMO_API_KEY 缺) → 跳过不注册 (fail-open, 不崩会话)。
 */
export function createMimoProviderExtension(): ExtensionFactory {
  return (pi) => {
    const baseUrl = process.env.MIMO_BASE_URL?.trim();
    const apiKey = process.env.MIMO_API_KEY?.trim();
    if (!baseUrl || !apiKey) return;
    pi.registerProvider('mimo', {
      baseUrl,
      apiKey,
      api: 'openai-completions',
      models: MIMO_MODELS,
    });
  };
}
