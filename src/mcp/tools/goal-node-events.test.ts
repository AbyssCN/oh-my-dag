/**
 * `dag_goal` / `solve` 的**节点事件旁路** —— 2026-08-21 补的第三半。
 *
 * ## 它要杀死的失效形态
 *
 * `goal.ts:704-707` 的注释记着 2026-07-30 撞出的事故:「`dag_goal` 此前一个事件都不发」。
 * 当时补了两半 —— `runRegistry.applyNodeEvent`(让 `dag_status` 有数)与 `hudMirror.write`
 * (让 statusline 亮起来)—— 而 `dag_run` 那条线其实有**三半**(`dag-tools.ts:415-425`),
 * 第三半是转发给订阅者(TUI 活图 / fleet)。**那一半没补,一直空到 2026-08-21。**
 *
 * 后果之所以难撞见, 正是因为它只坏了一半:statusline 吃 `.omd/hud/dag.json` 所以是亮的,
 * TUI 吃进程内订阅所以全程是黑的。**「一个观测面有、另一个没有」比「两个都没有」隐蔽得多** ——
 * 人会以为是 TUI 那边的显示问题, 而不是数据根本没到。
 *
 * ## 证伪方式(加闸必须当场证伪一次)
 *
 * 把 `goal.ts` 的 `deps.onNodeEvent?.(runId, e)` 那一段删掉 → 第一条测立刻红(收到 0 个事件)。
 * 把它挪到 `hudMirror.write` 之前 → 第二条测红(顺序是判据不是口味, 与 `dag-tools.ts:418-425` 同)。
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGoalTool } from './goal';
import { RunRegistry } from '../run-registry';
import type { DagNodeEvent } from '../../harness/dag/types';
import type { RunGoalResult } from '../../harness/goal/run-goal';

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'omd-gevt-'));
  mkdirSync(join(dir, '.git'));
  return realpathSync(dir);
}

const okResult = (goal: string): RunGoalResult => ({
  goal, tier: 'simple', acceptance: { kind: 'executable', command: 'x', expectExit: 0 },
  stages: [], sources: [], repoContext: '', converged: true, rounds: 1, reusedNodes: [], outcome: 'success' as const,
});

/** 引擎会发的那几种事件, 挑三种有代表性的(含 verdict —— 闸的判词走的就是它)。 */
const EVENTS: DagNodeEvent[] = [
  { type: 'planned', nodes: [{ id: 'n1', kind: 'agent' }] },
  { type: 'start', id: 'n1', kind: 'agent' },
  { type: 'verdict', id: 'n1', gate: 'verifier', verdict: 'fail', round: 1, reason: '产物不成立' },
];

function make(opts: { subscriber?: (runId: string, e: DagNodeEvent) => void } = {}) {
  const anchor = makeRepo();
  const trace: string[] = [];
  const seen: { runId: string; e: DagNodeEvent }[] = [];
  const tool = createGoalTool({
    // 替身 runGoal: 把引擎会发的事件原样打进 config.onNodeEvent, 模拟真引擎那一侧。
    runGoal: async (goal, cfg) => {
      for (const e of EVENTS) (cfg.dag as { onNodeEvent?: (e: DagNodeEvent) => void }).onNodeEvent?.(e);
      return okResult(goal);
    },
    runRegistry: new RunRegistry(),
    cwd: anchor,
    buildConfig: () => ({ conductorModel: 'c:m', leafModel: 'l:m' }),
    hudMirror: { write: () => trace.push('mirror') },
    onNodeEvent: opts.subscriber ?? ((runId, e) => { trace.push('subscriber'); seen.push({ runId, e }); }),
  });
  const call = () => tool.handler({ goal: '把 HudMirror 拆成每 run 一文件' } as never, {} as never) as Promise<{ content: { text: string }[]; isError?: boolean }>;
  return { call, trace, seen };
}

describe('dag_goal 节点事件旁路 (2026-08-21 补的第三半)', () => {
  test('★ 引擎发的事件真的到达订阅者, 且带上 runId —— 少了这条, 走 solve 的 run 在 TUI 上全程是黑的', async () => {
    const { call, seen } = make();
    const out = await call();
    expect(out.isError).toBeUndefined();
    expect(seen.length).toBe(EVENTS.length);
    expect(seen.map((s) => s.e.type)).toEqual(['planned', 'start', 'verdict']);
    // runId 必须是同一个非空串 —— 订阅者靠它把事件归到哪张图上。
    const ids = new Set(seen.map((s) => s.runId));
    expect(ids.size).toBe(1);
    expect([...ids][0]).toBeTruthy();
    // 闸的判词必须原样过去, 不许在旁路上被削。
    const v = seen[2]!.e as Extract<DagNodeEvent, { type: 'verdict' }>;
    expect(v.gate).toBe('verifier');
    expect(v.reason).toBe('产物不成立');
  });

  test('顺序: 镜像写盘在前, 订阅者在后 (与 dag-tools.ts:418-425 同一条判据)', async () => {
    const { call, trace } = make();
    await call();
    // 每个事件都是先 mirror 后 subscriber, 不许交错成 subscriber 先。
    // 尾上多一次 mirror (2026-09-02): 终态 (succeed/cancel/fail) 之后再无节点事件, 不补这一笔分片就永远停在
    // `running` (实测 96 份僵尸分片, TUI 当「waiting」挂一辈子)。它没有订阅者对应项 —— 终态不是节点事件。
    expect(trace).toEqual([...EVENTS.flatMap(() => ['mirror', 'subscriber']), 'mirror']);
  });

  test('订阅者抛错被吞, 不打断这次 goal —— 观测面挂了不许拖垮执行', async () => {
    const { call } = make({ subscriber: () => { throw new Error('TUI 那边炸了'); } });
    const out = await call();
    expect(out.isError).toBeUndefined();
  });

  test('不给订阅者 = 与补线前逐字节一致 (纯 MCP 调用方不受影响)', async () => {
    const anchor = makeRepo();
    const tool = createGoalTool({
      runGoal: async (goal, cfg) => {
        for (const e of EVENTS) (cfg.dag as { onNodeEvent?: (e: DagNodeEvent) => void }).onNodeEvent?.(e);
        return okResult(goal);
      },
      runRegistry: new RunRegistry(),
      cwd: anchor,
      buildConfig: () => ({ conductorModel: 'c:m', leafModel: 'l:m' }),
    });
    const out = (await tool.handler({ goal: '随便一个目标' } as never, {} as never)) as { isError?: boolean };
    expect(out.isError).toBeUndefined();
  });
});
