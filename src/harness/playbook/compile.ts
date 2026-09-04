/**
 * src/harness/playbook/compile —— `compilePlaybook`: Playbook → ConductorPlan (零 LLM 平铺图)。
 *
 * 节点形状:
 *   - step-N (executor='agent') = 该步 doc 文件全文, 串行依赖 (第 i+1 步 deps 第 i 步)。
 *     `reset:true` 的步**仍在链上** (顺序是 playbook 的语义), 只是 goal 前加一行「不读取上游产物」——
 *     引擎没有节点级「不注入上游输出」的开关, 这一行是散文不是闸 (2026-09-04 记于此, 加了开关再换)。
 *   - accept (executor='command') = pb.acceptance.command, expect_exit 0, deps 最后一步。
 *   step 节点不声明 output_type: 声明 'file' 会进产物闸 (engine.ts declaredArtifact), 步骤没有固定产物, 会被冤判。
 *
 * ## loop.maxRounds 的取舍
 *
 * playbook 原义 = 「整套步骤最多重跑 N 轮」。引擎今天对平铺图只有一种重跑: 终审判红后「原图 + finding 重跑」
 * (升级轮, `maxEscalations`)。所以映射为 maxEscalations = min(N, 4) - 1 (N 轮 = 首跑 + N-1 次重跑; 4 = solve
 * maxRounds 上限), 接线在 run-goal.ts 的 execCfg 处。本文件不读 loop。
 *
 * 三道闸固定顺序: steps 非空 → 命令可跑 (acceptanceCommandBlockReason) → 判据有判别力 (probeDiscrimination 跑在
 * acceptance.command + negativeSample 上, 与 classify 的判据自证同一条探针, 不另写)。任一闸拒即抛错, 不返部分 plan。
 *
 * 证伪 (compile.test.ts): 让 PlanSchema.parse 抛 / 把 reset 步从链上摘掉 / 删 negativeSample 探针 → (a)/(d-up)/(d-down) 红。
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
      // 串行链; reset 只改 goal 前言, 不摘链 (顺序是 playbook 的语义)。
      depends_on: prevId ? [prevId] : [],
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
