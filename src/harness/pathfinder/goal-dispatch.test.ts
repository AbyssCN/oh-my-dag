/**
 * c1 波契约测试 (D-G1.1/G1.2, GWT-G1-1) — goal 档票的分流与幂等分派。
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PathMap, Ticket } from './types';
import { compileSlice } from './slice-compiler';
import { dispatchGoalTicket, goalDispatchedPath } from './dispatch';
import { saveMap } from './maps';
import { resolveBackend } from './backend';
import { createPathfinderTools, readyRegion } from '../../mcp/tools/pathfinder';

const t = (over: Partial<Ticket> & { id: string }): Ticket => ({
  type: 'task',
  title: `票 ${over.id}`,
  blockedBy: [],
  status: 'ruled',
  ruling: `干 ${over.id}`,
  ...over,
});

describe('readyRegion 分流 (D-G1.1/G1.2)', () => {
  test('goal 档票进 goals 侧; prototype 未选档默认 goal; 普通 task 进 slice 侧', () => {
    const map: PathMap = {
      destination: 'd', slug: 'm', decisionsLog: [],
      tickets: [
        t({ id: 't1' }),
        t({ id: 't2', executorKind: 'goal' }),
        t({ id: 'p1', type: 'prototype' }),
        t({ id: 'p2', type: 'prototype', executorKind: 'agent' }), // 显式选档的 prototype 不走 goal
      ],
    };
    expect(readyRegion(map)).toEqual({ slice: ['t1', 'p2'], goals: ['t2', 'p1'] });
  });

  test('compileSlice 收到 goal 档票 → 响亮炸 (D-G1.2 fail-loud, 不静默降级 leaf)', () => {
    const map: PathMap = { destination: 'd', slug: 'm', decisionsLog: [], tickets: [t({ id: 't2', executorKind: 'goal' })] };
    expect(() => compileSlice(map, ['t2'])).toThrow(/goal 档/);
  });
});

describe('dispatchGoalTicket 幂等 (GWT-G1-1 后半)', () => {
  test('首派 spawn + 写标记; 二派命中标记不重 spawn 且 runId 稳定', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'goal-disp-'));
    const spawns: string[][] = [];
    const deps = { spawnDetached: (cmd: string[]) => (spawns.push(cmd), 123), makeRunId: () => 'run-fixed' };
    const d1 = dispatchGoalTicket(cwd, 'm', 't2', '收敛这个目标', deps);
    expect(d1).toEqual({ runId: 'run-fixed', already: false });
    expect(spawns).toHaveLength(1);
    expect(spawns[0]!.join(' ')).toContain('--goal 收敛这个目标');
    expect(spawns[0]!.join(' ')).toContain('--max-rounds 2'); // D-G1.6 默认档
    expect(readFileSync(goalDispatchedPath(cwd, 'm', 't2'), 'utf8')).toBe('run-fixed');
    const d2 = dispatchGoalTicket(cwd, 'm', 't2', '收敛这个目标', deps);
    expect(d2).toEqual({ runId: 'run-fixed', already: true });
    expect(spawns).toHaveLength(1); // 没有第二次 spawn
    rmSync(cwd, { recursive: true, force: true });
  });

  test('spawn 抛错 → 不写标记 (无"已派"假象, 可重试)', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'goal-disp-'));
    expect(() =>
      dispatchGoalTicket(cwd, 'm', 't2', 'x', { spawnDetached: () => { throw new Error('spawn 炸'); } }),
    ).toThrow(/spawn 炸/);
    expect(existsSync(goalDispatchedPath(cwd, 'm', 't2'))).toBe(false);
    rmSync(cwd, { recursive: true, force: true });
  });
});

describe('path_deliver 分流 (GWT-G1-1)', () => {
  test('纯 goal 区域: fire fake solve, slice 不编, 票留 ruled', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'goal-del-'));
    const map: PathMap = { destination: '图', slug: 'm1', decisionsLog: [], tickets: [t({ id: 't2', executorKind: 'goal' })] };
    saveMap(map, cwd);
    const fired: string[] = [];
    let sliceRan = false;
    const tools = createPathfinderTools({
      cwd,
      env: { OMD_PATH_BACKEND: 'md' },
      models: { conductorModel: 'x', leafModel: 'x' },
      agentRunner: (async () => ({ text: '', usage: { in: 0, out: 0 } })) as never,
      commandRunner: (async () => ({ text: '', usage: { in: 0, out: 0 }, exitCode: 0 })) as never,
      resolveBackend: (c) => resolveBackend(c, { env: { OMD_PATH_BACKEND: 'md' } }),
      dispatchGoal: ((_c: string, _s: string, gid: string, goalText: string) => {
        fired.push(`${gid}:${goalText}`);
        return { runId: 'run-g', already: false };
      }) as never,
      executeSlice: (async () => ((sliceRan = true), { results: {}, verification: { pass: true } })) as never,
    });
    const deliver = tools.find((x) => x.name === 'path_deliver')!;
    const res = (await deliver.handler({}, {} as never)) as { content: { text: string }[]; isError?: boolean };
    expect(res.isError).not.toBe(true);
    expect(fired).toEqual(['t2:干 t2']); // goal=ruling 全文
    expect(sliceRan).toBe(false); // slice 图不含 goal 票
    const backend = resolveBackend(cwd, { env: { OMD_PATH_BACKEND: 'md' } });
    expect(backend.readMap(cwd, 'm1')!.tickets[0]!.status).toBe('ruled'); // 在飞, 未 delivered
    rmSync(cwd, { recursive: true, force: true });
  });
});
