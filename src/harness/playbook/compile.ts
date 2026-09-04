/**
 * src/harness/playbook/compile —— `compilePlaybook`: Playbook → ConductorPlan。
 *
 * ## 与 tests 文件的关系
 *
 * `src/harness/playbook/compile.test.ts` 在本文件之前落; 当时 writeset 只许写测试, 故测试用
 * 一份**内联 impl** 自包含地跑。**两份实现必须逐字同构** —— 本文件是生产侧, 测试内联是占位,
 * 后续一旦把 `compile.test.ts` 的内联 impl 换成 `import('./compile')` 立刻切到真模块, 不许漂。
 *
 * ## loop.maxRounds 的处理 (本文件头注释唯一要说的工程决策)
 *
 * Playbook 的 `loop.maxRounds` 字面义 = 「整套 steps 链最多重跑 N 轮」。engine today 只有一个
 * 修复轮机制 (execute 阶段的内环, 钳到 4 = schema maxRounds 上限), 没有"步骤链整链重跑"的原生概念。
 * 故这里把 `loop.maxRounds` 当成 *execute 段* 的内环上界使用, 而非另铺一层"重跑 steps 链"的环。
 *
 * 钳法 = `min(pb.loop?.maxRounds ?? 2, 4)`:
 *   - 上限 4 = solve 的 maxRounds schema 上限 (见 `src/mcp/tools/goal.ts` inputSchema 的 maxRounds).
 *     让 playbook 的 maxRounds 比 solve 大是无效配置 —— 即便用户写 10, engine 那边照样钳 4, 形同静默吞。
 *   - 缺省 2 = engine today 默认 (1 修复轮 = 2).
 *
 * ⚠ **loop.maxRounds 的实现分两步**: 本函数只读 `pb.loop` 决定 **平铺 plan 的 shape** (steps 数 +
 * reset 段), 执行期内环上限由 `run-goal.ts` 把 `pb.loop?.maxRounds ?? 2` 透传给 conductor
 * maxRounds 入参。本文件**不**直接造 conductor 节点 —— 平铺图的步骤节点照 `pb.steps` 一对一铺,
 * 与 reset 段一起决定 depends_on 链。
 *
 * ## 反向自检
 *
 * 改 compilePlaybook 体 (让 PlanSchema.parse 抛 / 漏 reset 处理 / 漏 negativeSample 探针) →
 * `src/harness/playbook/compile.test.ts` 的 (a)/(d-up)/(d-down) 全红。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PlanSchema, type ConductorPlan } from '../conductor-plan';
import {
  acceptanceCommandBlockReason,
  probeDiscrimination,
} from '../goal/acceptance-gate';
import type { Playbook } from './types';

export interface CompilePlaybookOptions {
  readonly cwd: string;
  readonly playbookRoot: string;
  readonly name?: string;
}

function stepId(i: number): string {
  return `step-${i + 1}`;
}

function readStepDoc(root: string, doc: string, playbookName: string): string {
  try {
    return readFileSync(join(root, doc), 'utf8');
  } catch (err) {
    throw new Error(`[playbook:${playbookName}] 步骤文档读不出: ${doc} — ${String(err)}`);
  }
}

/**
 * 把一份 Playbook 编译成可执行的 ConductorPlan。
 *
 * 三道闸固定顺序: steps 非空 → 命令可跑 (acceptanceCommandBlockReason) → 判据有判别力 (probeDiscrimination
 * 跑在 acceptance.command + negativeSample 上, status !== 'ok' → 拒)。任一闸拒即抛错, 不返部分 plan。
 *
 * 节点形状:
 *   - step-N (executor='agent') = 一段 playbook doc 全文 + 可选 [reset] 前缀; depends_on 串行链,
 *     reset:true 的步骤断链 (depends_on: []).
 *   - accept (executor='command') = pb.acceptance.command + expect_exit: 0, 挂在最后一步之后。
 *
 * plan.name 缺省 'playbook-flat' (保持与 v1 同源, tests 的 (e) 用 `^playbook-` 正则匹配, 不挑名字)。
 */
export async function compilePlaybook(pb: Playbook, opts: CompilePlaybookOptions): Promise<ConductorPlan> {
  if (!pb.steps.length) throw new Error(`[playbook:${pb.name}] steps 不能为空`);
  const blocked = acceptanceCommandBlockReason(pb.acceptance.command, { root: opts.cwd });
  if (blocked) {
    throw new Error(`[playbook:${pb.name}] acceptance.command 不可运行: ${pb.acceptance.command} — ${blocked}`);
  }
  const verdict = await probeDiscrimination(pb.acceptance.command, pb.acceptance.negativeSample, 0, {
    repoRoot: opts.cwd,
  });
  if (verdict.status !== 'ok') {
    const why =
      verdict.status === 'ring' || verdict.status === 'skipped' || verdict.status === 'fail_open'
        ? verdict.why
        : '未知探针状态';
    throw new Error(
      `[playbook:${pb.name}] acceptance.command 在 negativeSample 上未通过判别力探针 (status=${verdict.status}) — ${why}`,
    );
  }

  const nodes: Record<string, Record<string, unknown>> = {};
  let prevId: string | undefined;
  for (let i = 0; i < pb.steps.length; i++) {
    const step = pb.steps[i]!;
    const id = stepId(i);
    const docText = readStepDoc(opts.playbookRoot, step.doc, pb.name);
    const resetPreamble = step.reset ? `[reset] 本步骤独立执行: 不读取、不引用任何上游步骤的产物。\n\n` : '';
    nodes[id] = {
      executor: 'agent',
      goal: `${resetPreamble}${docText}`,
      // reset:true → 不依赖上游 (step-5 的 depends_on = []); 否则串行链
      ...(step.reset ? { depends_on: [] } : { depends_on: prevId ? [prevId] : [] }),
      output_type: 'file',
    };
    prevId = id;
  }
  const lastStep = stepId(pb.steps.length - 1);
  nodes['accept'] = {
    executor: 'command',
    command: pb.acceptance.command,
    expect_exit: 0,
    depends_on: [lastStep],
    output_type: 'none',
    goal: `终局验收 (playbook:${pb.name} 的收敛判据)`,
  };
  return PlanSchema.parse({ name: opts.name ?? 'playbook-flat', nodes });
}
