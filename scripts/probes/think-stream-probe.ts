/**
 * think-stream-probe —— **这个座位到底流不流思维链?**(2026-08-13)
 *
 * ## 为什么需要它
 *
 * TUI 侧修好 `thinking_delta` 的映射(`backend-embedded.mapAgentEvent`)之后,
 * 屏上有没有思维链还取决于**另一端**:provider 发不发 `reasoning_content`。
 * 这两件事分属两边,而"看不到思维链"这一个症状**两边都能造成**。
 * 靠读代码分不开(pi 的映射在、目录里 `reasoning: true` 也在,仍可能一片都不发)——
 * 只有真调一次才分得开。
 *
 * ⚠ **会真花钱**(一次短调用)。判据是成本:一次几分钱的调用 vs 一个分不清病因的猜测。
 *
 * 用法:
 * ```
 * bun run scripts/probes/think-stream-probe.ts                     # 默认 deepseek:deepseek-v4-pro
 * bun run scripts/probes/think-stream-probe.ts kimi:k3             # 换座位量
 * ```
 *
 * 读数怎么读:
 * - `thinking_delta` **> 0** ⇒ 这一端好的;屏上还看不到就是 TUI 侧的事。
 * - `thinking_delta` **= 0** 而 `text_delta > 0` ⇒ 端点不发推理,换座位或接受没有思维链。
 *   **这不是 bug,是这个座位的属性** —— 别去 TUI 里找。
 *
 * 2026-08-13 在 `deepseek:deepseek-v4-pro` 上的基线读数:
 * `thinking_start 1 · thinking_delta 140 · thinking_end 1 · text_delta 7`,思维链 416 字。
 */
import { streamSimple } from '@earendil-works/pi-ai/compat';
import { bootstrapModelRuntime } from '../../src/model/bootstrap';
import { resolvePiApiKey, resolvePiModel } from '../../src/model/pi-transport';

const coord = process.argv[2] ?? 'deepseek:deepseek-v4-pro';
const [provider, ...rest] = coord.split(':');
const modelId = rest.join(':');
if (!provider || !modelId) throw new Error(`座位坐标要写成 provider:model-id, 实得 ${coord}`);

bootstrapModelRuntime();
const model = resolvePiModel(provider, modelId);
if (!model) throw new Error(`座位解析不到 ${coord} —— 先确认 provider 已配 (omd tui 里 /login)`);
const apiKey = resolvePiApiKey(provider);

const counts: Record<string, number> = {};
let think = '';
const stream = await streamSimple(
  model as never,
  {
    systemPrompt: 'You are terse.',
    messages: [{ role: 'user', content: '17 * 23 是多少? 先想清楚再答。' }],
    tools: [],
  } as never,
  { apiKey, reasoning: 'high' } as never,
);
for await (const e of stream as AsyncIterable<{ type: string; delta?: string }>) {
  counts[e.type] = (counts[e.type] ?? 0) + 1;
  if (e.type === 'thinking_delta') think += e.delta ?? '';
}

console.log(`座位: ${coord}`);
console.log('事件计数:', counts);
console.log(`thinking 累计字符: ${think.length}`);
console.log('思维链前 160 字:', JSON.stringify(think.slice(0, 160)));
console.log(
  (counts.thinking_delta ?? 0) > 0
    ? '判词: 这一端会流思维链 —— 屏上还看不到的话, 病因在 TUI 侧。'
    : '判词: 这个座位一片推理都不发 —— 不是 TUI 的事, 换座位或接受没有思维链。',
);
