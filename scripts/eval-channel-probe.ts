/**
 * eval-channel-probe —— 排除"渠道冒充家族"的混淆 (owner 2026-07-27)。
 *
 * 矩阵 eval 里 kimi 走自家订阅 (kimi-coding:k3), 其余五族走经销渠道 opencode-go。
 * 如果经销渠道在背后降配 (量化/降档/截断), 那"kimi 家族更强"就是假结论 —— 真变量是渠道不是家族。
 * 探针: **同一家族同一档**分别经两条渠道跑同一批 persona, 用同一把尺判分。
 *   差 ≈ 0 → 渠道中性, 家族排名可信;  差显著 → 家族结论作废, 先修路由。
 *
 * 跑: bun run scripts/eval-channel-probe.ts [taskId]
 */
import { send } from '../src/model/gateway';
import { bootstrapModelRuntime } from '../src/model/bootstrap';
import { parallel } from '../src/harness/primitives';
import { TASK_BY_ID, TASKS, PERSONAS, buildGenPrompt } from './eval-tasks/diverge-tasks';
import { gradeAnswer } from './eval-tasks/grade';

/** 同族同档 × 两条渠道。mimo 有直连订阅与经销两条路, 是最干净的对照。 */
const PAIRS: { family: string; direct: string; reseller: string }[] = [
  { family: 'mimo', direct: 'xiaomi-token-plan-ams:mimo-v2.5-pro', reseller: 'opencode-go:mimo-v2.5-pro' },
];

const taskId = process.argv[2] ?? 'webhook-billing';
const task = TASK_BY_ID.get(taskId) ?? TASKS[0]!;
const log = (s: string): void => void process.stderr.write(s + '\n');

bootstrapModelRuntime();

for (const pair of PAIRS) {
  const runSeat = async (label: string, coord: string): Promise<{ label: string; union: Set<string>; per: number[]; chars: number[] }> => {
    const cells = await parallel(
      PERSONAS.map((p) => async () => {
        const r = await send({
          model: coord,
          messages: [{ role: 'user', content: buildGenPrompt(task, p) }],
          temperature: p.temperature,
          topP: p.topP,
          maxTokens: 32_768,
          meta: { role: 'eval-channel-probe' },
        });
        const text = r.text.trim();
        if (!text) throw new Error('空正文');
        const g = await gradeAnswer(task, text);
        log(`  ${label.padEnd(10)} ${p.id.padEnd(16)} ${text.length} chars · 命中 ${g.hits.size}/${task.seeds.length}`);
        return { hits: g.hits, chars: text.length };
      }),
      { concurrency: 3 },
    );
    const ok = cells.filter((c): c is { hits: Set<string>; chars: number } => c !== null);
    const union = new Set<string>();
    for (const c of ok) for (const h of c.hits) union.add(h);
    return { label, union, per: ok.map((c) => c.hits.size), chars: ok.map((c) => c.chars) };
  };

  log(`\n═══ 渠道探针 ${pair.family} · 题 ${task.id} ═══`);
  const direct = await runSeat('direct', pair.direct);
  const reseller = await runSeat('reseller', pair.reseller);
  const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  process.stdout.write(
    [
      `\n──────── 渠道探针 ${pair.family} (${task.id}, 金标 ${task.seeds.length}) ────────`,
      `direct   ${pair.direct.padEnd(38)} 并集 ${direct.union.size}/${task.seeds.length} · 单格均值 ${mean(direct.per).toFixed(1)} · 均长 ${Math.round(mean(direct.chars))}`,
      `reseller ${pair.reseller.padEnd(38)} 并集 ${reseller.union.size}/${task.seeds.length} · 单格均值 ${mean(reseller.per).toFixed(1)} · 均长 ${Math.round(mean(reseller.chars))}`,
      `Δ 并集 ${direct.union.size - reseller.union.size} · Δ 单格均值 ${(mean(direct.per) - mean(reseller.per)).toFixed(1)}`,
      `判读: |Δ| 接近 0 → 渠道中性, 家族排名可信; Δ 显著 → 家族结论作废, 先查路由降配。`,
    ].join('\n') + '\n',
  );
}
