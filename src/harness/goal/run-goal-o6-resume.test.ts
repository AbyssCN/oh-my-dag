/**
 * src/harness/goal/run-goal-o6-resume.test.ts ——
 * #242 resume × O-6 回落陷阱的回归用例 (票 242, 91 号图; run 7f9c511a 复盘)。
 *
 * 事故形状: 已绿切片续跑时 O-6 探针重跑 → 必判「判据虚」→ 整图静默回落 conductor →
 * 回落图叶子重写已完成实装。修向: resume 时 verify 当前绿的切片视为已达成 —— 不判 vacuous,
 * 实装节点降为 command 重验 (零 LLM 零写盘)。
 *
 * 票上的回归判据逐条钉:
 *  ① 修绿 verify → resume 同 runId: 不再回落 (plan 仍是 goal-execute-flat, 图上没有
 *     conductor `execute` 节点 ⇒ 不可能产生 execute::* 子节点), 且判词 o6-vacuous-verify
 *     不再出现在任何 warn 里。
 *  ② 已达成切片的实装节点 executor 是 'command' (跑同一条 verify), 不再是携带 write_set 的
 *     agent ⇒ 「不重写任何已 done 切片的写集文件」由节点类型构造保证。
 *  ③ resume 而 verify 仍红的切片照常保留 agent 实装节点 (该重做的还得重做)。
 *
 * ★ 反向自检 (逐条实跑过证伪):
 *   - 把 run-goal.ts 探针里 `if (resuming)` 那条分支删掉 (恢复必抛) ⇒ ①② 同红 (回落发生,
 *     plan 变 goal-execute)。
 *   - 把「实装节点降为 command」那段节点映射删掉 ⇒ ② 红 (executor 仍是 agent)。
 *   - 把 `resuming` 判据写反 (非 resume 也不抛) ⇒ o6-vacuous-verify.gate.test.ts ① 红
 *     (O-6 首次编图的判别力由那份用例钉住, 本文件不重复)。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGoal, type RunGoalConfig } from './run-goal';
import { setCoreLogger, type CoreLogger } from '../logger';
import type { AcceptanceSpec, GoalClassification } from './classify-acceptance';
import type { ConductorPlan } from '../conductor-plan';
import type { ExecutorDagConfig, ExecutorDagResult } from '../dag/types';
import type { CheckpointManager } from '../continuity/checkpoint-manager';

const SLICE_VERIFY = 'bun test src/o6-resume-target.test.ts';

/** 最小可用 SDD (形状同 o6-vacuous-verify.gate.test.ts 的 SDD_OK): 单切片零依赖无波形。 */
const SDD_OK = [
  '# o6 resume 回归契约',
  '## 契约 (Contracts)',
  '- G-1 占位',
  '## 分解 (Breakdown)',
  '| 切片 | 写集 | 依赖 | verify |',
  '|---|---|---|---|',
  `| 1 占位切片 | src/o6-resume-target.ts + test | — | ${SLICE_VERIFY} |`,
].join('\n');

const tmpSdd = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'omd-o6-resume-sdd-'));
  const p = join(dir, 'x.md');
  writeFileSync(p, SDD_OK);
  return p;
};

const ACC: AcceptanceSpec = { kind: 'executable', command: 'bun test', expectExit: 0 };
const cls = async (): Promise<GoalClassification> => ({ tier: 'complex', acceptance: ACC });

const captured: Array<{ msg: string; fields: Record<string, unknown> }> = [];
const captureLogger: CoreLogger = {
  debug: () => {},
  info: () => {},
  warn: (o, m) => {
    captured.push({ msg: m ?? '', fields: o && typeof o === 'object' && !Array.isArray(o) ? (o as Record<string, unknown>) : {} });
  },
  error: (o, m) => {
    captured.push({ msg: m ?? '', fields: o && typeof o === 'object' && !Array.isArray(o) ? (o as Record<string, unknown>) : {} });
  },
};
// 模块级单例必须换回去 —— 跨文件污染教训照抄 o6-vacuous-verify.gate.test.ts 的注。
const consoleLogger: CoreLogger = {
  debug: () => {},
  info: (o, m) => console.log(m ?? '', typeof o === 'string' ? o : ''),
  warn: (o, m) => console.warn(m ?? '', typeof o === 'string' ? o : ''),
  error: (o, m) => console.error(m ?? '', o),
};
beforeEach(() => {
  captured.length = 0;
  setCoreLogger(captureLogger);
});
afterEach(() => {
  captured.length = 0;
  setCoreLogger(consoleLogger);
});

/** 捕获引擎入参 plan 的 _runDag 桩 (探针之后才会被调; 返回空 results 让 runGoal 正常收尾)。 */
function makeCapturingRunDag(sink: ConductorPlan[]): NonNullable<RunGoalConfig['_runDag']> {
  return (async (plan: ConductorPlan): Promise<ExecutorDagResult> => {
    sink.push(plan);
    return {
      plan,
      results: {},
      sessionId: 'o6-resume-test',
      levels: [],
      usage: { conductor: { in: 0, out: 0 }, leavesIn: 0, leavesOut: 0, leavesCacheHit: 0 },
      reusedNodes: [],
    };
  }) as never;
}

function makeConfig(opts: { sliceVerifyExit: number; resume: boolean; sink: ConductorPlan[] }): RunGoalConfig {
  const cwd = mkdtempSync(join(tmpdir(), 'omd-o6-resume-cwd-'));
  const dag = { conductorModel: 'c:m', leafModel: 'l:m' } as ExecutorDagConfig;
  dag.commandRunner = async (arg: { command: string }) => ({
    text: '',
    usage: { in: 0, out: 0 },
    // 切片 verify 按注入的退出码答; 其余 (accept 基线/复验) 恒绿 —— 复现场景就是「修绿后续跑」。
    exitCode: arg.command === SLICE_VERIFY ? opts.sliceVerifyExit : 0,
    timedOut: false,
    signal: null,
  });
  if (opts.resume) {
    // runGoal 只读 continuity.resume / runId; manager 在注入 _runDag 后引擎不落地, 桩即可。
    dag.continuity = { manager: {} as CheckpointManager, runId: 'run-7f9c511a-regress', resume: true };
  }
  return {
    cwd,
    dag,
    _classify: cls,
    _runDag: makeCapturingRunDag(opts.sink),
    sddPath: tmpSdd(),
    // S-46 接线面: 注入空 diff (复用路径零新写是常态) —— 修前它会把复用片判「缺片」造假红。
    writeSet: { _collectChangedFiles: () => [] },
  };
}

describe('#242 resume × O-6: 已绿切片续跑不判 vacuous、不回落、不重做实装', () => {
  test('①② resume + verify 已绿 ⇒ 平铺图照编 (零回落零 execute 节点), 实装节点降为 command 重验', async () => {
    const sink: ConductorPlan[] = [];
    const result = await runGoal('o6 resume regress', makeConfig({ sliceVerifyExit: 0, resume: true, sink }));

    // ① 不回落: 引擎吃到的是平铺图, 不是 conductor 包装图 —— 回落图才有 `execute` conductor
    // 节点 (execute::* 子节点的唯一来源)。
    expect(sink.length).toBe(1);
    const plan = sink[0]!;
    expect(plan.name).toBe('goal-execute-flat');
    expect(Object.keys(plan.nodes).some((id) => id === 'execute' || id.startsWith('execute::'))).toBe(false);
    // 判词不再出现 (修前它经 flatFallback warn 外泄 —— o6-vacuous-verify.gate.test.ts ① 钉的那条路)。
    expect(JSON.stringify(captured)).not.toContain('o6-vacuous-verify');

    // ② 已达成切片的实装节点是 command 重验, 不再是携带 write_set 的 agent。
    const impl = plan.nodes['s1']!;
    expect(impl.executor).toBe('command');
    expect(impl.command).toBe(SLICE_VERIFY);
    expect(impl.write_set).toBeUndefined();
    // 整图零 agent 节点 (单切片全绿) ⇒ 没有任何节点有资格重写写集文件。
    expect(Object.values(plan.nodes).every((n) => n.executor !== 'agent')).toBe(true);

    // S-46 接线: 复用片零 diff 判 reused 不判缺片 —— 反向自检: 把 run-goal 里
    // coverSlices 的第三参 (flatReusedSlices) 拿掉 ⇒ 这里 red=true / missing=[1] 转红。
    expect(result.sliceCoverage?.red).toBe(false);
    expect(result.sliceCoverage?.reused).toEqual([1]);
    expect(result.sliceCoverage?.missing).toEqual([]);
  });

  test('③ resume + verify 仍红 ⇒ 切片照常保留 agent 实装节点 (该重做的还得重做)', async () => {
    const sink: ConductorPlan[] = [];
    await runGoal('o6 resume regress red', makeConfig({ sliceVerifyExit: 1, resume: true, sink }));

    expect(sink.length).toBe(1);
    const plan = sink[0]!;
    expect(plan.name).toBe('goal-execute-flat');
    expect(plan.nodes['s1']!.executor).toBe('agent');
  });
});
