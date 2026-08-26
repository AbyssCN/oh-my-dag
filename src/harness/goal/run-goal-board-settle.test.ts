/**
 * board 结算闸 (2026-08-26) —— 两条 claim 侧的不变量。
 *
 * ## 起因 (实账)
 *
 * 清点 `.omd/run-board.jsonl` 时发现 **12 条判为"在跑"的 run, 最早 8.3 天, `ps` 里零个对应进程**。
 * 板的活判据只有 `claimed ∧ ¬terminal` (dag-run-board.ts:122), 没有心跳也没有年龄上限,
 * 而 `emitBoard('terminal')` 的两个调用点都在**正常返回路径**上 —— 抛错即悬空。
 * 后果不止是脏板: 此后每一次点火回执都打印一段假撞车告警, 把真撞车淹掉。
 *
 * 同一次清点还发现 12 条的 `writeSet` **逐字节相同** = `SDD_DECLARED_WRITE_SET` 那个
 * 2026-08-10 SDD 的模块级常量被当兜底写了进去。
 *
 * ## 反向自检 (仓规: 新加的闸必须当场证伪一次)
 *
 * - 把 `runGoal` 外壳的 `finally` 去掉 ⇒ 「抛错也结算」红;
 * - 把 `box.settled = true` 那一行删掉 ⇒ 「正常收尾只有一条 terminal」红 (会补出第二条);
 * - 把 `boardDeclared` 改回 `?? SDD_DECLARED_WRITE_SET` ⇒ 「未注入则字段缺席」红;
 * - 把 claim 之前抛的那条去掉 ⇒ 无法证明外壳不会凭空造 terminal。
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGoal, type RunGoalConfig } from './run-goal';
import type { AcceptanceSpec, GoalClassification, GoalTier } from './classify-acceptance';
import type { ExecutorDagConfig, ExecutorDagResult } from '../dag/types';
import type { ConductorPlan } from '../conductor-plan';
import { readBoard } from '../board/run-board';
import { SDD_DECLARED_WRITE_SET } from '../writeset/write-set';

const ACC_EXEC: AcceptanceSpec = { kind: 'executable', command: 'bun test', expectExit: 0 };
const cls =
  (tier: GoalTier, acceptance: AcceptanceSpec = ACC_EXEC) =>
  async (): Promise<GoalClassification> => ({ tier, acceptance });

function executeDag(): ExecutorDagResult {
  return {
    plan: { name: 'goal-execute', nodes: {} },
    results: {
      accept: { id: 'accept', status: 'done', kind: 'command', output: '', deps: ['execute'], usage: { in: 0, out: 0 } },
      execute: {
        id: 'execute', status: 'done', kind: 'conductor', output: '[conductor 子图: 1/1 成功]',
        deps: [], usage: { in: 1, out: 1 }, rounds: 1, converged: true,
      },
    },
  } as unknown as ExecutorDagResult;
}

const dagRouter = (async (plan: ConductorPlan) =>
  plan.name === 'goal-execute'
    ? executeDag()
    : ({ plan: { name: 'goal-contract', nodes: {} }, results: {} } as unknown as ExecutorDagResult)) as never;

function cfg(cwd: string, sessionId: string, extra: Partial<RunGoalConfig> = {}): RunGoalConfig {
  return {
    cwd,
    dag: { conductorModel: 'c:m', leafModel: 'l:m', sessionId } as ExecutorDagConfig,
    _today: () => '2026-08-26',
    _classify: cls('simple'),
    _runDag: dagRouter,
    ...extra,
  };
}

const tmp = (tag: string): string => mkdtempSync(join(tmpdir(), `omd-settle-${tag}-`));

describe('★ claim 过的 run 一定有 terminal 收尾', () => {
  test('分类段抛错 → 板上仍有 terminal, outcome=failed 且 note 标明是外壳兜底的', async () => {
    const root = tmp('throw');
    const boom = async (): Promise<GoalClassification> => {
      throw new Error('classify 炸了 (模拟引擎 bug)');
    };
    await expect(runGoal('会炸的目标', cfg(root, 'sess-throw', { _classify: boom }))).rejects.toThrow('classify 炸了');

    const entries = readBoard(root).filter((e) => e.runId === 'sess-throw');
    expect(entries.some((e) => e.event === 'claimed')).toBe(true);
    const term = entries.filter((e) => e.event === 'terminal');
    expect(term).toHaveLength(1);
    // 「引擎抛了」必须与「run 自己判失败」分得开 —— 靠 note 那一列, 不靠猜 (§NULL ≠ 0)。
    expect(term[0]!.note).toContain('uncaught');
  });

  test('反向: 正常收尾只有**一条** terminal (外壳不补第二条)', async () => {
    const root = tmp('ok');
    await runGoal('正常目标', cfg(root, 'sess-ok'));
    const term = readBoard(root).filter((e) => e.runId === 'sess-ok' && e.event === 'terminal');
    expect(term).toHaveLength(1);
    expect(term[0]!.note).not.toContain('uncaught');
  });

  test('反向: claim **之前**抛 → 板上零条目 (外壳不许凭空造 terminal)', async () => {
    const root = tmp('preclaim');
    // sddPath 指向不存在的契约 → loadSddContract 在 board 接线之前就抛。
    const cfgPre = cfg(root, 'sess-preclaim', { sddPath: join(root, '不存在的契约.md') });
    await expect(runGoal('坏契约', cfgPre)).rejects.toThrow();
    expect(readBoard(root).filter((e) => e.runId === 'sess-preclaim')).toEqual([]);
  });
});

describe('★ claim 行的写集: 未注入 = 字段缺席, 不兜底常量', () => {
  test('未注入 → claimed 行没有 writeSet 字段 (而不是那个 2026-08-10 的常量)', async () => {
    const root = tmp('nows');
    await runGoal('没声明写集', cfg(root, 'sess-nows'));
    const claim = readBoard(root).find((e) => e.runId === 'sess-nows' && e.event === 'claimed')!;
    expect(claim.writeSet).toBeUndefined();
    // 逐字节钉死那个常量不再出现 —— 只断言 undefined 的话, 换成 `[]` 也能过。
    expect(JSON.stringify(claim)).not.toContain(SDD_DECLARED_WRITE_SET.allowed[0]!);
  });

  test('注入了 → claimed 行带**本 run 自己的**写集 (证明上一条不是把功能删了)', async () => {
    const root = tmp('ws');
    await runGoal(
      '声明了写集',
      cfg(root, 'sess-ws', { writeSet: { declared: { allowed: ['src/only/mine/**'], forbidden: [] } } }),
    );
    const claim = readBoard(root).find((e) => e.runId === 'sess-ws' && e.event === 'claimed')!;
    expect(claim.writeSet).toEqual(['src/only/mine/**']);
  });
});
