/**
 * O-6 × 切片交付判定的**端到端**回归(2026-08-28)。
 *
 * ## 它补的是哪一格
 *
 * `slice-delivery.test.ts` 单测了判定与取证;`run-goal-o6-resume.test.ts`(#242)覆盖
 * **resume** 那条逃生门;`gates/o6-vacuous-verify.gate.test.ts` 覆盖**首次编图判虚**。
 * 唯独 **「非 resume + git 证据说写集动过 ⇒ 放行」** 这条新路径此前没有 e2e ——
 * 而它正是本次改动的全部理由(人做掉一半的契约点不着火)。
 *
 * ## 判据形状照抄 #242 那份
 *
 * 「不回落」= 引擎吃到的是平铺图,不是 conductor 包装图(回落图才有 `execute` 节点)。
 * 这条比「没抛异常」强:抛不抛只说明闸放没放行,而回落是**静默**的 ——
 * 放行了却回落,读起来一切正常而实装被重写一遍。
 *
 * ## 反向自检(每条真跑过一次)
 * · 把 `run-goal.ts` 里的 git 证据那一路删掉(只留 resuming)→ ① 当场红(回落发生)。
 * · 把「取不到证据」判成放行 → ③ 当场红。
 * · 把 `collectSliceGitEvidence` 的 status 那一跳去掉 → ② 由绿转红(脏文件不再算证据)。
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
import type { ExecGit } from './slice-delivery';

const SLICE_VERIFY = 'bun test src/o6-delivery-target.test.ts';

const SDD_OK = [
  '# o6 交付判定回归契约',
  '## 契约 (Contracts)',
  '- G-1 占位',
  '## 分解 (Breakdown)',
  '| 切片 | 写集 | 依赖 | verify |',
  '|---|---|---|---|',
  `| 1 占位切片 | src/o6-delivery-target.ts + test | — | ${SLICE_VERIFY} |`,
].join('\n');

const tmpSdd = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'omd-o6-delivery-sdd-'));
  const p = join(dir, 'x.md');
  writeFileSync(p, SDD_OK);
  return p;
};

const ACC: AcceptanceSpec = { kind: 'executable', command: 'bun test', expectExit: 0 };
const cls = async (): Promise<GoalClassification> => ({ tier: 'complex', acceptance: ACC });

// 模块级 logger 单例必须换回去 —— 跨文件污染教训照抄 #242 那份的注。
const quiet: CoreLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
const consoleLogger: CoreLogger = {
  debug: () => {},
  info: (o, m) => console.log(m ?? '', typeof o === 'string' ? o : ''),
  warn: (o, m) => console.warn(m ?? '', typeof o === 'string' ? o : ''),
  error: (o, m) => console.error(m ?? '', o),
};
beforeEach(() => setCoreLogger(quiet));
afterEach(() => setCoreLogger(consoleLogger));

function makeCapturingRunDag(sink: ConductorPlan[]): NonNullable<RunGoalConfig['_runDag']> {
  return (async (plan: ConductorPlan): Promise<ExecutorDagResult> => {
    sink.push(plan);
    return {
      plan,
      results: {},
      sessionId: 'o6-delivery-test',
      levels: [],
      usage: { conductor: { in: 0, out: 0 }, leavesIn: 0, leavesOut: 0, leavesCacheHit: 0 },
      reusedNodes: [],
    };
  }) as never;
}

/** git 替身:两次 `log` 按调用序(查落盘点 / 数之后的提交),再一次 `status`。 */
const fakeGit = (t: {
  birth?: { stdout: string; exitCode: number };
  since?: { stdout: string; exitCode: number };
  status?: { stdout: string; exitCode: number };
}): ExecGit => {
  let logCalls = 0;
  const fail = { stdout: '', exitCode: 128 };
  return (args) => {
    if (args[0] === 'log') return (logCalls++ === 0 ? t.birth : t.since) ?? fail;
    if (args[0] === 'status') return t.status ?? fail;
    return fail;
  };
};

/** 切片 verify 恒绿(这一族测试问的就是「已绿之后怎么判」),其余命令恒绿。 */
function makeConfig(gitExec: ExecGit, sink: ConductorPlan[]): RunGoalConfig {
  const dag = { conductorModel: 'c:m', leafModel: 'l:m' } as ExecutorDagConfig;
  dag.commandRunner = async () => ({
    text: '',
    usage: { in: 0, out: 0 },
    exitCode: 0,
    timedOut: false,
    signal: null,
  });
  return {
    cwd: mkdtempSync(join(tmpdir(), 'omd-o6-delivery-cwd-')),
    dag, // 注意:**不设** continuity.resume —— 本文件测的正是非 resume 那条路
    _classify: cls,
    _runDag: makeCapturingRunDag(sink),
    sddPath: tmpSdd(),
    gitExec,
    writeSet: { _collectChangedFiles: () => [] },
  };
}

describe('O-6 × 交付判定 e2e:非 resume 时靠 git 证据分辨', () => {
  test('★① 写集被提交动过 ⇒ 平铺图照编,不回落(新路径的全部理由)', async () => {
    const sink: ConductorPlan[] = [];
    await runGoal('o6 delivery regress', makeConfig(fakeGit({
      birth: { stdout: 'shaBIRTH\n', exitCode: 0 },
      since: { stdout: 'c1\nc2\n', exitCode: 0 },
      status: { stdout: '', exitCode: 0 },
    }), sink));
    // 回落图才有 conductor `execute` 节点 —— 它在即说明闸拒了/回落了。
    const names = sink.flatMap((p) => Object.keys(p.nodes ?? {}));
    expect(names.some((n) => n === 'execute' || n.startsWith('execute::'))).toBe(false);
    expect(sink.length).toBeGreaterThan(0);
  });

  test('★② 只有未提交改动(人刚做完还没 commit)⇒ 同样放行', async () => {
    const sink: ConductorPlan[] = [];
    await runGoal('o6 delivery dirty', makeConfig(fakeGit({
      birth: { stdout: '', exitCode: 0 },          // 契约还没提交
      status: { stdout: ' M src/o6-delivery-target.ts\n', exitCode: 0 },
    }), sink));
    const names = sink.flatMap((p) => Object.keys(p.nodes ?? {}));
    expect(names.some((n) => n === 'execute' || n.startsWith('execute::'))).toBe(false);
  });

  // ⚠ 拒的那一侧**实测**行为(2026-08-28 真跑过一次才写的,前两版都猜错了):
  //  · `runGoal` **不抛** —— 写 `rejects.toThrow` 永远绿不了(第一版 3 条红);
  //  · 也**不回落** —— 引擎压根没被调起来(第二版又 2 条红,`execute` 节点根本不存在)。
  //    实测 `_runDag` 调用次数为 0,`outcome` 为 `not-converged`。
  // 于是判据取「引擎一次都没被调起来」—— 它比「回落了」强: 回落至少还跑了一张图,
  // 而这里是连图都没编。
  test('★③ 写集一次没被动过 ⇒ 判据虚,引擎一次都没被调起来', async () => {
    const sink: ConductorPlan[] = [];
    const r = await runGoal('o6 delivery vacuous', makeConfig(fakeGit({
      birth: { stdout: 'shaBIRTH\n', exitCode: 0 },
      since: { stdout: '', exitCode: 0 },
      status: { stdout: '', exitCode: 0 },
    }), sink));
    expect(sink).toHaveLength(0);
    expect((r as unknown as { outcome?: string }).outcome).toBe('not-converged');
  });

  test('★④ git 取不到证据 ⇒ 同样不放行(取不到不许当成交付)', async () => {
    const sink: ConductorPlan[] = [];
    const r = await runGoal('o6 delivery undetermined', makeConfig(fakeGit({}), sink));
    expect(sink).toHaveLength(0);
    expect((r as unknown as { outcome?: string }).outcome).toBe('not-converged');
  });
});
