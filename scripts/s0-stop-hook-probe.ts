/**
 * scripts/s0-stop-hook-probe.ts —— **S-0 探针**(`docs/plan/2026-08-30-sdk-selfcheck-recon.md:291`)。
 *
 * ## 唯一目标(侦察笔记「附:标 `?` 的未决项」第 1 条)
 *
 * headless `query()` 下 Stop hook 的注入路究竟是哪一条:
 *   · A = `{ decision: 'block', reason }`
 *   · B = `{ hookSpecificOutput: { hookEventName: 'Stop', additionalContext } }`
 * 以及**文本以什么形态到模型面前**。
 *
 * 顺带回答未决项 3:阻断续转产生的 token 在 `result.modelUsage` 里是累进到同一份还是分条。
 *
 * ## 为什么必须是探针而不是推理
 *
 * 两条路 SDK 0.3.226 的**类型面都存在**(`sdk.d.ts:7097` StopHookSpecificOutput.additionalContext
 * 与 `:7147` decision:'block' + `:7153` reason),所以"类型里有"答不了"哪条真生效"。
 * 而 `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` 的执行逻辑**不在这个 npm 包里**
 * (`stop_hook_active` 只出现在 `sdk.d.ts` 的类型里,`.mjs` 零命中)—— 它在 SDK 抽出来的
 * CLI 二进制中。静态读到此为止,剩下的只能真跑。
 *
 * ## 判据(动手前写死)
 *
 * 每臂跑同一个 prompt:「回一个词:APPLE」。Stop hook 首次触发时注入「改成 BANANA」。
 *   · **续转了** ⇔ 收到第二条 assistant 消息 ∧ 末条正文含 BANANA;
 *   · **没续转** ⇔ 只有一条 assistant,正文仍是 APPLE。
 * `stop_hook_active === true` 时一律返 `{}` 放行 —— 不然就是无限环。
 *
 * 两臂读数相同 → 先怀疑这一格判据不成立,再怀疑 SDK(仓规 §「一个在任何干预下都不动的数」)。
 *
 * 用法:`bun run scripts/s0-stop-hook-probe.ts`(约 3 发真调用,秒级)
 */
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';

type Arm = 'none' | 'block' | 'additionalContext' | 'both';

const PROMPT = '回一个词, 只回那个词, 不要任何解释: APPLE';
const INJECT = '不对。改成回 BANANA —— 只回这一个词。';

interface ArmResult {
  arm: Arm;
  hookCalls: { stop_hook_active: boolean; last_assistant_message?: string }[];
  assistantTexts: string[];
  usageRows: unknown[];
  resultText?: string;
  error?: string;
}

function textOf(m: SDKMessage): string | null {
  const mm = m as unknown as { type: string; message?: { content?: unknown[] } };
  if (mm.type !== 'assistant') return null;
  const parts = (mm.message?.content ?? []) as { type: string; text?: string }[];
  return parts.filter((p) => p.type === 'text').map((p) => p.text ?? '').join('');
}

async function runArm(arm: Arm): Promise<ArmResult> {
  const out: ArmResult = { arm, hookCalls: [], assistantTexts: [], usageRows: [] };

  const cb = async (input: unknown) => {
    const i = input as { stop_hook_active?: boolean; last_assistant_message?: string };
    out.hookCalls.push({
      stop_hook_active: i.stop_hook_active === true,
      ...(i.last_assistant_message !== undefined ? { last_assistant_message: i.last_assistant_message } : {}),
    });
    // 第二次进来 = 已经因为本 hook 续转过一轮。**必须放行**, 否则无限环。
    if (i.stop_hook_active === true) return {};
    // ★ 对照臂: 什么都不注。**没有它这组读数一文不值** —— 三臂全"续转了"时,
    //   分不清是注入起了作用, 还是这个 prompt 本来就会续转 (判据不成立, 量的是尺子)。
    if (arm === 'none') return {};
    if (arm === 'block') return { decision: 'block' as const, reason: INJECT };
    if (arm === 'additionalContext')
      return { hookSpecificOutput: { hookEventName: 'Stop' as const, additionalContext: INJECT } };
    return {
      decision: 'block' as const,
      reason: INJECT,
      hookSpecificOutput: { hookEventName: 'Stop' as const, additionalContext: INJECT },
    };
  };

  const options = {
    model: 'claude-sonnet-4-5',
    cwd: process.cwd(),
    tools: [],
    settingSources: [],
    strictMcpConfig: true,
    hooks: { Stop: [{ hooks: [cb] }] },
  } as unknown as Options;

  try {
    for await (const m of query({ prompt: PROMPT, options })) {
      const t = textOf(m);
      if (t !== null && t.trim()) out.assistantTexts.push(t.trim());
      const mm = m as unknown as { type: string; subtype?: string; result?: string; modelUsage?: unknown };
      if (mm.type === 'result') {
        out.resultText = mm.result;
        if (mm.modelUsage) out.usageRows.push(mm.modelUsage);
      }
    }
  } catch (e) {
    out.error = (e as Error).message;
  }
  return out;
}

const verdict = (r: ArmResult): string => {
  if (r.error) return `炸了: ${r.error}`;
  const last = r.assistantTexts.at(-1) ?? '';
  const turned = r.assistantTexts.length > 1;
  const banana = /BANANA/i.test(last);
  if (turned && banana) return '★ 续转了, 且吃进了注入文本 (BANANA)';
  if (turned && !banana) return '△ 续转了, 但没照注入文本改 (文本没到模型面前 / 到了但没听)';
  if (!turned && banana) return '?? 没续转却出现 BANANA —— 判据有问题, 别用';
  return '✗ 没续转 (这条路在 headless query() 下不生效)';
};

const main = async () => {
  console.log('S-0 探针 —— Stop hook 注入路 (SDK 0.3.226)\n');
  console.log(`prompt: ${PROMPT}`);
  console.log(`注入:   ${INJECT}\n`);
  for (const arm of ['none', 'block', 'additionalContext', 'both'] as Arm[]) {
    const r = await runArm(arm);
    console.log(`── 臂 ${arm} ──────────────────────────────`);
    console.log(`  hook 触发次数: ${r.hookCalls.length} ${JSON.stringify(r.hookCalls.map((h) => h.stop_hook_active))}`);
    if (r.hookCalls[0]?.last_assistant_message !== undefined)
      console.log(`  last_assistant_message(首次): ${JSON.stringify(r.hookCalls[0].last_assistant_message)}`);
    console.log(`  assistant 消息数: ${r.assistantTexts.length} → ${JSON.stringify(r.assistantTexts)}`);
    console.log(`  result: ${JSON.stringify(r.resultText)}`);
    console.log(`  modelUsage 条数: ${r.usageRows.length}`);
    if (r.usageRows.length) console.log(`  modelUsage: ${JSON.stringify(r.usageRows[0])}`);
    console.log(`  判决: ${verdict(r)}\n`);
  }
};

main().catch((e) => {
  console.error('探针本身炸了:', e);
  process.exit(1);
});
