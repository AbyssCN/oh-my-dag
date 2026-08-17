#!/usr/bin/env bun
/**
 * repeat-plan-validity —— 计划有效率跑器 (SDD #159 切片 2) 的薄 CLI 装配。
 *
 * 本脚本**只**做装配, 不进测试。判据与口径全在 src/eval/plan-validity.ts 核里,
 * 测试用注入 generate 跑; 这里接生产 conductor 座, 跑真测量 —— 那是 #97 缺口②
 * 的真实点火, **不在本 run 内烧**, 等 slice-2 落地后单独按点火纪律报消耗。
 *
 * G6 任务文本同源: 从 src/eval/tasks/detector-goals.ts 取前 3 条 (逐字复制,
 * 出处行号见下方 G6_TASKS 注释) —— 与 scripts/eval-detector-usage.ts 用的同一份
 * DETECTOR_GOAL_CASES (前 3 = worthy 组)。
 *
 * 座位解析照 eval-detector-usage.ts:43-58 的惯例 (2026-08-03 修, 与 seat-sourced
 * 同一族缺陷): 变量名 vs 值的漂是报告里看不出的那种, 起跑打 stderr + 写进结果
 * 的 SEAT_PROVENANCE 字串, 不许只靠 stderr。
 *
 * 跑: bun --env-file=.env run scripts/probes/repeat-plan-validity.ts [--n 5]
 */
import '../../src/harness/script-bootstrap';
import { bootstrapModelRuntime } from '../../src/model/bootstrap';
import { send } from '../../src/model/gateway';
import { conductorSystemPrompt, PLAN_BOUNDARY } from '../../src/harness/conductor-plan';
import { measurePlanValidity, type PlanValidityTask } from '../../src/eval/plan-validity';
import { tryResolveSeatModel } from '../../src/model/role-models';

const argv = process.argv.slice(2);
const opt = (n: string): string | undefined => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
// n 必须是整数: `Math.max(1, Number('x'))` = NaN, 会一路带到 repeatSegment 才炸 (且已烧完
// bootstrap), 这里当场退出把打字错误挡在花钱之前。
const N = Number(opt('n') ?? '5');
if (!Number.isInteger(N) || N < 1) {
  process.stderr.write(`repeat-plan-validity: --n 要整数 >= 1, 收到 ${opt('n')}\n`);
  process.exit(2);
}

/**
 * G6 任务样本: DETECTOR_GOAL_CASES 前 3 条 (都在 worthy 半) 的 goal 文本, **逐字复制**。
 * scripts/eval-detector-usage.ts:96 遍历的就是这份清单, 出处 src/eval/tasks/detector-goals.ts:
 *   - 'two-audiences'        ← detector-goals.ts:33-35 (case 体 30-37)
 *   - 'zh-en-promise'        ← detector-goals.ts:41-43 (case 体 38-45)
 *   - 'three-modules-errors' ← detector-goals.ts:49-51 (case 体 46-53)
 * 不 import 而复制: 这把尺量的是「同一段文本跑 n 次的分布」, 语料动了读数就不可比 —— 复制
 * 把 G6 那次的输入**冻在本文件里**, 语料后续演进不会悄悄改掉基线。
 */
const G6_TASKS: readonly PlanValidityTask[] = [
  {
    id: 'two-audiences',
    text:
      '写两份面向不同读者的说明: docs/user.md (给用户) 与 docs/dev.md (给开发者), 各自介绍同一个功能"批量导出"。' +
      '两份必须在事实口径上完全一致 (支持的格式、上限条数、是否异步), 不许各说各的。',
  },
  {
    id: 'zh-en-promise',
    text:
      '写 marketing/zh.md 与 marketing/en.md 两份文案, 介绍同一个退款政策。两份给出的**承诺**必须一致 ' +
      '(时限、适用范围、例外), 不能一边写"7 个工作日"另一边写"within a week"。',
  },
  {
    id: 'three-modules-errors',
    text:
      '三个模块各写一段 API 说明 (docs/api-auth.md · docs/api-file.md · docs/api-job.md), ' +
      '每段都要列自己的错误码。三段之间的错误码**不许冲突** (同一个码不能在两处表示不同的错)。',
  },
];

const log = (s: string): void => void process.stderr.write(s + '\n');

const conductorSeat = tryResolveSeatModel('conductor');
const CONDUCTOR_SEAT = opt('model') ?? conductorSeat?.model;
if (!CONDUCTOR_SEAT) {
  process.stderr.write('repeat-plan-validity: `conductor` 座位解析不出模型, 且没给 --model\n');
  process.exit(2);
}
const SEAT_PROVENANCE = opt('model') ? ' (--model 覆盖)' : ` (conductor 座 · 来源 ${conductorSeat?.source})`;

/** 与 eval-detector-usage.ts:63-83 的 expandOnce 同形 (系统 prompt + 边界 + 禁 map/conductor)。 */
async function generatePlan(goal: string): Promise<string> {
  const sys = conductorSystemPrompt({ profile: 'full' });
  const r = await send({
    model: CONDUCTOR_SEAT!,
    messages: [
      { role: 'system', content: sys },
      {
        role: 'user',
        content:
          `${PLAN_BOUNDARY}${goal}\n\n` +
          '注意: 本次分解出的节点**不得**再用 executor:"conductor" 或 executor:"map" —— ' +
          '你现在就是运行时展开, 已经知道清单了, 直接把步骤列出来即可。',
      },
    ],
    thinkingLevel: 'high',
    maxTokens: 32_768,
  });
  return r.text ?? '';
}

async function main(): Promise<void> {
  bootstrapModelRuntime();
  log(
    `plan-validity 跑 ${G6_TASKS.length} task × ${N} 采样 · 座位 ${CONDUCTOR_SEAT}${SEAT_PROVENANCE}…`,
  );
  const result = await measurePlanValidity({
    tasks: G6_TASKS,
    n: N,
    generate: generatePlan,
  });
  // 逐 task + overall 口径行, 全经 renderRepeatLine (INV-3 单点)
  for (const line of result.lines) console.log(line);
  // result.lines 末尾已是 `plan-validity/_overall: ...` (renderRepeatLine 产, 含 rate + Wilson95 + n=)。
  // 不许在这里再拼 rate/n= —— 那是 INV-3 反面 (两处算口径必漂)。若要座位溯源, 起跑 stderr 那行就在。
  log(`\n座位 ${CONDUCTOR_SEAT}${SEAT_PROVENANCE} · 口径行见上 (renderRepeatLine 唯一真源)。`);
}

await main();
