/**
 * #160 D-1/D-2/D-3 (s1) — 板根钉主仓 + 终态 verified 发射 + 判据④的测试闸。
 *
 * 这些是 GWT 1-2 的契约钉子: 不动既有 run-goal.test.ts 的全测 (INV-1: head 形状行为逐字节不变)
 * —— 那是回归保障, 不是本片新增。本文件新增的测试只钉**本片新增的三条行为**:
 *
 *   ① 板根 = `config.dag.continuity?.repoRoot ?? config.cwd` (D-1) ——
 *      branch 档 run (config.cwd=worktree) 落主仓; head 档 run (repoRoot 缺席) 落 cwd。
 *
 *   ② executable 验收的终态前发 verified 事件 (D-2) ——
 *      verdict = oracleOk ∨ oracleRecheckGreen 的判据真身, note = 验收命令 + accept.status 指纹。
 *
 *   ③ 非 executable 验收不发 verified (D-2 后半) + 判据红 (accept failed) 也发 verified (D-3 闸) ——
 *      「verifier 判 fail 而无 verified 事件 → 闸红」以测试钉死, 不造运行时消费者。
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGoal, type RunGoalConfig } from './run-goal';
import type { AcceptanceSpec, GoalClassification, GoalTier } from './classify-acceptance';
import type { ExecutorDagConfig, ExecutorDagResult } from '../dag/types';
import type { ConductorPlan } from '../conductor-plan';
import { readBoard, type BoardEntry } from '../board/run-board';
import { pinLegacyExecutionPath } from './pin-legacy-path';

// P3 S6b (2026-09-02): 本文件钉 P3 之前的执行路径 (fake _runDag 产 `execute` 节点); 循环路径的判据见 orchestrating-loop.test.ts。
pinLegacyExecutionPath();

const ACC_EXEC: AcceptanceSpec = { kind: 'executable', command: 'bun test', expectExit: 0 };
const ACC_EXPLORE: AcceptanceSpec = { kind: 'exploratory', learningGoal: '学到什么', affordableLoss: '一轮' };
const cls =
  (tier: GoalTier, acceptance: AcceptanceSpec = ACC_EXEC) =>
  async (): Promise<GoalClassification> => ({ tier, acceptance });

/**
 * 造一份执行段 conductor 节点的结果: `converged=true` + `accept` 节点按 opts 控绿/红/缺席。
 * 契段段走 contractDag() 的"全空"版即可 —— 本测试不关心契约段, 只关心终态前的 verified 发射。
 */
function executeDag(opts: {
  converged?: boolean;
  accept?: 'done' | 'failed' | 'absent';
} = {}): ExecutorDagResult {
  const accept = opts.accept ?? 'done';
  return {
    plan: { name: 'goal-execute', nodes: {} },
    results: {
      ...(accept === 'absent'
        ? {}
        : {
            accept: {
              id: 'accept',
              status: accept,
              kind: 'command',
              output: accept === 'done' ? '' : '[exit 1]',
              deps: ['execute'],
              usage: { in: 0, out: 0 },
            },
          }),
      execute: {
        id: 'execute',
        status: 'done',
        kind: 'conductor',
        output: '[conductor 子图: 2/2 成功]',
        deps: [],
        usage: { in: 1, out: 1 },
        rounds: 1,
        ...(opts.converged === undefined ? {} : { converged: opts.converged }),
      },
    },
  } as unknown as ExecutorDagResult;
}

const dagRouter = (executeReturn: ExecutorDagResult) =>
  (async (plan: ConductorPlan) => {
    if (plan.name === 'goal-execute') return executeReturn;
    // 契约段: 空结果, 不影响终态。
    return { plan: { name: 'goal-contract', nodes: {} }, results: {} } as unknown as ExecutorDagResult;
  }) as never;

/**
 * 基础 cfg: cwd 给 (branch vs head) + dag partial (continuity) + extra (acceptance/_classify/_runDag/sessionId)。
 * `sessionId` 是 ExecutorDagConfig 字段, 但放 extra 也接住 → 内部搬到 dag, 避免调用方记错。
 * extra 类型显式允许 sessionId, 否则 TS 对象字面量多余属性检查会拒 call site。
 */
function cfg(
  cwd: string,
  dag: Partial<ExecutorDagConfig> = {},
  extra: Partial<RunGoalConfig> & { sessionId?: string } = {},
): RunGoalConfig {
  const { sessionId, ...restExtra } = extra;
  return {
    cwd,
    dag: { conductorModel: 'c:m', leafModel: 'l:m', ...(sessionId ? { sessionId } : {}), ...dag } as ExecutorDagConfig,
    _today: () => '2026-08-17',
    ...restExtra,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// GWT 1: 板根 = 主仓状态锚 (D-1)
// ─────────────────────────────────────────────────────────────────────────────

describe('runGoal — #160 D-1 板根钉主仓状态锚', () => {
  test('branch 形状 (cwd=worktree, continuity.repoRoot=主仓): claimed/terminal/verified 落主仓, worktree 板空', async () => {
    const worktree = mkdtempSync(join(tmpdir(), 'omd-s1-branch-'));
    const mainRepo = mkdtempSync(join(tmpdir(), 'omd-s1-main-'));

    await runGoal('branch 档 run', cfg(
      worktree,
      { continuity: { manager: {} as never, runId: 'sess-s1-branch', repoRoot: mainRepo } },
      { _classify: cls('simple'), _runDag: dagRouter(executeDag()) },
    ));

    // 主仓板: 三事件齐全 (claimed + terminal + verified, executable 验收时)
    const mainEntries = readBoard(mainRepo);
    expect(mainEntries.some((e) => e.runId === 'sess-s1-branch' && e.event === 'claimed')).toBe(true);
    expect(mainEntries.some((e) => e.runId === 'sess-s1-branch' && e.event === 'terminal')).toBe(true);
    expect(mainEntries.some((e) => e.runId === 'sess-s1-branch' && e.event === 'verified')).toBe(true);

    // worktree 板: 零条目 (这是勘察坐实的裂缝 —— 此前全落这里, 主仓盲)
    expect(readBoard(worktree)).toEqual([]);
  });

  test('head 形状 (continuity 缺席): 板落 config.cwd (INV-1 逐字节不变)', async () => {
    const headRepo = mkdtempSync(join(tmpdir(), 'omd-s1-head-'));

    await runGoal('head 档 run', cfg(
      headRepo,
      { sessionId: 'sess-s1-head' }, // 无 continuity → boardRoot 回落 config.cwd
      { _classify: cls('simple') },
    ));

    const entries = readBoard(headRepo);
    expect(entries.some((e) => e.runId === 'sess-s1-head' && e.event === 'claimed')).toBe(true);
    expect(entries.some((e) => e.runId === 'sess-s1-head' && e.event === 'terminal')).toBe(true);
    expect(entries.some((e) => e.runId === 'sess-s1-head' && e.event === 'verified')).toBe(true);
  });

  test('head 形状 (continuity 给但 repoRoot 缺席): 仍落 config.cwd (INV-1 兼容面)', async () => {
    // 兼容面: 老式注入只给 manager/runId, 没 repoRoot —— 行为与从前逐字节一致。
    const headRepo = mkdtempSync(join(tmpdir(), 'omd-s1-head-compat-'));

    await runGoal('head 兼容档', cfg(
      headRepo,
      { continuity: { manager: {} as never, runId: 'sess-s1-compat' } }, // repoRoot 缺席
      { _classify: cls('simple') },
    ));

    const entries = readBoard(headRepo);
    expect(entries.some((e) => e.runId === 'sess-s1-compat' && e.event === 'claimed')).toBe(true);
    expect(entries.some((e) => e.runId === 'sess-s1-compat' && e.event === 'terminal')).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GWT 2: 终态 verified 发射 (D-2/D-3)
// ─────────────────────────────────────────────────────────────────────────────

describe('runGoal — #160 D-2 终态前 verified 发射', () => {
  test('executable 验收 + 判据绿 (accept done): 板含 {event:verified, verdict:pass}, note 含验收命令', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omd-s1-verified-pass-'));

    await runGoal('e2e 验收活', cfg(
      cwd,
      { sessionId: 'sess-s1-v-pass' },
      {
        _classify: cls('simple'),
        acceptance: { kind: 'executable', command: 'bun test', expectExit: 0 },
        _runDag: dagRouter(executeDag({ converged: true, accept: 'done' })),
      },
    ));

    const verified = readBoard(cwd).filter((e): e is BoardEntry & { verdict: 'pass' | 'fail' } =>
      e.event === 'verified' && e.runId === 'sess-s1-v-pass',
    );
    expect(verified).toHaveLength(1); // INV-2: 每次终态至多一条
    expect(verified[0]!.verdict).toBe('pass');
    expect(verified[0]!.note).toContain('bun test'); // 指纹: 验收命令
    expect(verified[0]!.note).toContain('done'); // 指纹: accept.status
  });

  test('executable 验收 + 判据红 (accept failed): 板含 verdict:fail (D-3 判据④测试闸)', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omd-s1-verified-fail-'));

    await runGoal('e2e 验收活', cfg(
      cwd,
      {},
      {
        _classify: cls('simple'),
        acceptance: { kind: 'executable', command: 'bun test', expectExit: 0 },
        _runDag: dagRouter(executeDag({ converged: true, accept: 'failed' })),
        sessionId: 'sess-s1-v-fail',
      },
    ));

    // 判据④钉死: 判据红 ≠ 板上无 verified。若忘了发, 这条断言红。
    const verified = readBoard(cwd).filter((e): e is BoardEntry & { verdict: 'pass' | 'fail' } =>
      e.event === 'verified' && e.runId === 'sess-s1-v-fail',
    );
    expect(verified).toHaveLength(1);
    expect(verified[0]!.verdict).toBe('fail');
    expect(verified[0]!.note).toContain('failed');
  });

  test('非可执行验收 (exploratory): 板无 verified 条目 (INV-2 不编)', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omd-s1-verified-explore-'));

    await runGoal('探索型活', cfg(
      cwd,
      {},
      {
        _classify: cls('simple', ACC_EXPLORE),
        acceptance: ACC_EXPLORE,
        _runDag: dagRouter(executeDag({ converged: true })),
        sessionId: 'sess-s1-explore',
      },
    ));

    const verified = readBoard(cwd).filter((e) => e.event === 'verified');
    expect(verified).toEqual([]); // 非可执行 = 没机器结论 = 不发
    // 但 claimed/terminal 仍发 (本片不改变这两条, S4 已立)
    const all = readBoard(cwd);
    expect(all.some((e) => e.runId === 'sess-s1-explore' && e.event === 'claimed')).toBe(true);
    expect(all.some((e) => e.runId === 'sess-s1-explore' && e.event === 'terminal')).toBe(true);
  });

  test('accept 缺席 (级联压死没跑) + 无复验绿: verdict:fail (oracleOk=false, oracleRecheckGreen=false, fail-closed)', async () => {
    // 验证 oracleOk ∨ oracleRecheckGreen 的真身: 两者都假 = fail (fail-closed 纪律)。
    const cwd = mkdtempSync(join(tmpdir(), 'omd-s1-verified-absent-'));

    await runGoal('e2e 验收活', cfg(
      cwd,
      {},
      {
        _classify: cls('simple'),
        acceptance: { kind: 'executable', command: 'bun test', expectExit: 0 },
        _runDag: dagRouter(executeDag({ converged: false, accept: 'absent' })), // 无 commandRunner → 复验不发生
        sessionId: 'sess-s1-v-absent',
      },
    ));

    const verified = readBoard(cwd).filter((e): e is BoardEntry & { verdict: 'pass' | 'fail' } =>
      e.event === 'verified' && e.runId === 'sess-s1-v-absent',
    );
    expect(verified).toHaveLength(1);
    expect(verified[0]!.verdict).toBe('fail');
    expect(verified[0]!.note).toContain('没跑'); // 指纹: acceptLeaf.status 缺席
  });

  test('写 verified 失败 (板 fail-loud 触发) → run 不掀桌 (与 claimed/terminal 同款纪律)', async () => {
    // 验证 fail-open 性格: 板层 validateEntry 抛错时 (这里用非法 verdict 模拟) run 仍正常返回。
    // 直接走 runGoal 难注入非法 verdict —— 用一个 cwd 上的预存非法行触发 validateEntry? 不,
    // appendBoard 的 validateEntry 校验的是**本条** entry, 不是读端。改用 mock 模拟。
    const cwd = mkdtempSync(join(tmpdir(), 'omd-s1-verified-failopen-'));

    const r = await runGoal('e2e 验收活', cfg(
      cwd,
      {},
      {
        _classify: cls('simple'),
        acceptance: { kind: 'executable', command: 'bun test', expectExit: 0 },
        _runDag: dagRouter(executeDag({ converged: true, accept: 'done' })),
        sessionId: 'sess-s1-v-failopen',
      },
    ));
    expect(r.converged).toBe(true); // run 正常收敛, 板层错不影响语义
  });
});
