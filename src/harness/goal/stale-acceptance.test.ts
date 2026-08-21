/**
 * **判据陈旧闸**:accept 的绿是 resume 复用来的、而本 run 重规划过 → 那份绿不属于最终这棵树。
 * (2026-08-21,run `58df6b9e`(P2)复盘)
 *
 * ## 现场,逐跳全部有盘上证据
 *
 * ```
 * 05:25:50  accept 节点真跑真绿, 写下 checkpoint (accept.json, status:'done', 指纹 1biymr9gf3ber)
 * ~05:28    verifier 否决 → 重规划 → 毒集丢绿 → 半回滚, **盘被改坏**
 * 第 2 轮    accept **不在毒集前向闭包里** → resume-skip 直接复用那份绿
 * 05:37     oracleOk = (status === 'done') = true → 终态 delivered-with-red + done
 * ```
 *
 * 扎人的地方:#165① 那道「收尾复验」**只在 `!oracleOk` 时触发**,而 oracleOk 已经被这份
 * 旧的绿撑成 true —— **闸被自己要防的那个东西关上了**。P2 的日志里确实没有任何 `#165①` 行。
 *
 * ## 判据为什么要两个条件
 *
 * `复用` ∧ `重规划过`,少任一个都不判 stale:
 *   · 只复用没重规划 = 盘没动过,那份绿仍然作数(别给每次 resume 都加一次全量测试的钱);
 *   · 只重规划没复用 = accept 这一轮真跑过,本来就算数。
 *
 * ⚠ `status === 'skipped'`(quorum 级联压死)与 `skipped === true`(resume 复用)是两个
 * **正交**概念,这里问的是后者。两条用例分别钉住。
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGoal, type RunGoalConfig } from './run-goal';
import type { AcceptanceSpec, GoalClassification, GoalTier } from './classify-acceptance';
import type { ConductorPlan } from '../conductor-plan';
import type { ExecutorDagConfig, ExecutorDagResult } from '../dag/types';

const ACC_EXEC: AcceptanceSpec = { kind: 'executable', command: 'bun test', expectExit: 0 };
const cls =
  (tier: GoalTier, acceptance: AcceptanceSpec = ACC_EXEC) =>
  async (): Promise<GoalClassification> => ({ tier, acceptance });

function contractDag(): ExecutorDagResult {
  return {
    plan: { name: 'goal-contract', nodes: {} },
    results: {
      contract: { id: 'contract', status: 'done', kind: 'conductor', output: '# SDD', deps: [], usage: { in: 1, out: 1 } },
    },
  } as unknown as ExecutorDagResult;
}

/**
 * 造 P2 那个形状:accept 绿 + `skipped`(= resume 复用)+ `verification.escalated`(= 重规划过)。
 * 三个旋钮各自可关,用来钉「少任一个条件都不判 stale」。
 */
function executeDag(opts: { acceptSkipped?: boolean; escalated?: boolean; acceptStatus?: 'done' | 'failed' | 'skipped' } = {}): ExecutorDagResult {
  return {
    plan: { name: 'goal-execute', nodes: {} },
    results: {
      accept: {
        id: 'accept',
        status: opts.acceptStatus ?? 'done',
        kind: 'command',
        output: '',
        deps: ['execute'],
        usage: { in: 0, out: 0 },
        ...(opts.acceptSkipped ? { skipped: true } : {}),
      },
      execute: {
        id: 'execute', status: 'done', kind: 'conductor', output: '[子图]', deps: [],
        usage: { in: 1, out: 1 }, rounds: 1, converged: true,
      },
    },
    reusedNodes: [],
    ...(opts.escalated
      ? { verification: { pass: false, reason: '执行子图 5/7 成功、2 个失败', attempts: 2, escalated: true, conductorModel: 'c:m' } }
      : {}),
  } as unknown as ExecutorDagResult;
}

const dagRouter = (execute: () => Promise<ExecutorDagResult>) =>
  (async (plan: ConductorPlan) => (plan.name === 'goal-execute' ? await execute() : contractDag())) as never;

/** `bun test` 被调了几次 —— D-1 基线恒占 1 次, 复验再加 1 次。 */
const n = (calls: string[]): number => calls.filter((c) => c === 'bun test').length;

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** `commandRunner` 记账:复验到底跑没跑、跑了几次。 */
function cfg(recheckExit: number, calls: string[], dag: Partial<ExecutorDagConfig> = {}): RunGoalConfig {
  const cwd = mkdtempSync(join(tmpdir(), 'omd-stale-'));
  dirs.push(cwd);
  return {
    cwd,
    dag: {
      conductorModel: 'c:m',
      leafModel: 'l:m',
      commandRunner: (async (r: { command: string }) => {
        calls.push(r.command);
        return { exitCode: recheckExit, stdout: '', stderr: '', timedOut: false };
      }) as never,
      ...dag,
    } as ExecutorDagConfig,
    _today: () => '2026-07-28',
  };
}

describe('判据陈旧闸 —— 复用的绿 ∧ 重规划过 → 必须重量', () => {
  test('★★ P2 原形: 绿是复用的 + 重规划过 + 复验红 → **判据判红**(原实装会发 delivered)', async () => {
    // 这条就是 run 58df6b9e。怎么让它红: 把 `oracleOk = acceptStale ? … : acceptCheckpointGreen`
    // 改回 `= acceptCheckpointGreen` → 陈旧的绿又能撑起 converged, 断言红。
    const calls: string[] = [];
    const r = await runGoal('goal', {
      ...cfg(1, calls), // 复验退出码 1 = 在最终这棵树上不成立
      _classify: cls('complex'),
      _runDag: dagRouter(async () => executeDag({ acceptSkipped: true, escalated: true })),
    });
    // ⚠ 判据是**次数**不是"有没有": `commandRunner` 还被 D-1 基线用着 (同一条命令)。
    //   基线 1 次 + 复验 1 次 = 2。只看"有没有"会把基线误读成复验。
    expect(n(calls)).toBe(2);
    expect(r.converged).toBe(false); // 陈旧的绿不许撑起收敛
  });

  test('★ 绿是复用的 + 重规划过 + 复验**绿** → 收敛(闸不是一律判红)', async () => {
    // 护栏: 防止"修陈旧绿"修成"只要 resume 过就判红"。复验说得算。
    const calls: string[] = [];
    const r = await runGoal('goal', {
      ...cfg(0, calls),
      _classify: cls('complex'),
      _runDag: dagRouter(async () => executeDag({ acceptSkipped: true, escalated: true })),
    });
    expect(n(calls)).toBe(2);
    expect(r.converged).toBe(true);
  });

  test('★ 只复用、**没重规划** → 不判 stale, 一次复验都不跑(别给每次 resume 加一次全量测试的钱)', async () => {
    // 怎么让它红: 把 `&& replanned` 从 acceptStale 里删掉 → 这里会多跑一次 bun test, 断言红。
    const calls: string[] = [];
    const r = await runGoal('goal', {
      ...cfg(1, calls),
      _classify: cls('complex'),
      _runDag: dagRouter(async () => executeDag({ acceptSkipped: true, escalated: false })),
    });
    expect(n(calls)).toBe(1); // 只有 D-1 基线那一次, 没有复验
    expect(r.converged).toBe(true);
  });

  test('★ 只重规划、accept 这一轮**真跑过** → 不判 stale, 不复验', async () => {
    // 怎么让它红: 把 `&& acceptLeaf?.skipped === true` 删掉 → 任何重规划轮都要重量, 断言红。
    const calls: string[] = [];
    const r = await runGoal('goal', {
      ...cfg(1, calls),
      _classify: cls('complex'),
      _runDag: dagRouter(async () => executeDag({ acceptSkipped: false, escalated: true })),
    });
    expect(n(calls)).toBe(1); // 只有 D-1 基线那一次, 没有复验
    expect(r.converged).toBe(true);
  });

  test('★ 复验跑不起来 → 陈旧的绿**不作数**(fail-closed: 没在最终这棵树上证明过就不算成)', async () => {
    // 怎么让它红: 把 `oracleRecheckRan && oracleRecheckGreen` 改成 `oracleRecheckGreen ?? 旧绿`
    // 之类的 fail-open 写法 → 复验抛错时陈旧绿复活, 断言红。
    const cwd = mkdtempSync(join(tmpdir(), 'omd-stale-'));
    dirs.push(cwd);
    const r = await runGoal('goal', {
      cwd,
      dag: {
        conductorModel: 'c:m',
        leafModel: 'l:m',
        commandRunner: (async () => {
          throw new Error('复验命令起不来');
        }) as never,
      } as ExecutorDagConfig,
      _today: () => '2026-07-28',
      _classify: cls('complex'),
      _runDag: dagRouter(async () => executeDag({ acceptSkipped: true, escalated: true })),
    });
    expect(r.converged).toBe(false);
  });

  test('★ `status:"skipped"`(quorum 级联)与 `skipped:true`(resume 复用)不混为一谈', async () => {
    // 级联压死那格走的是原 #165① 那条路(accept 没跑 → 复验), 与 stale 是两回事。
    // 怎么让它红: 把 acceptStale 的判据换成 `status === 'skipped'` → 这条走错分支。
    const calls: string[] = [];
    await runGoal('goal', {
      ...cfg(0, calls),
      _classify: cls('complex'),
      _runDag: dagRouter(async () => executeDag({ acceptStatus: 'skipped', acceptSkipped: false, escalated: false })),
    });
    expect(n(calls)).toBe(2); // 基线 + 复验 —— 没跑那格仍然要复验 (#165① 语义保持)
  });
});
