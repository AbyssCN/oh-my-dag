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

// ── c2 波: 回流三态映射 (GWT-G1-2/3) ─────────────────────────────────────────

import { mkdirSync, writeFileSync } from 'node:fs';
import { reflowGoalResults } from './afk-hook';
import { goalResumePath, researchResultPath } from './dispatch';

const writeResult = (cwd: string, slug: string, id: string, outcome: string, body = '摘要') => {
  const p = researchResultPath(cwd, slug, id);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, `outcome: ${outcome}\nrunId: run-${id}\n\n${body}`);
};

const goalMapOn = (cwd: string, id = 'g9'): void => {
  const map: PathMap = {
    destination: '图', slug: 'm1', decisionsLog: [],
    tickets: [t({ id, executorKind: 'goal' })],
  };
  saveMap(map, cwd);
};

const mdBackend = (cwd: string) => resolveBackend(cwd, { env: { OMD_PATH_BACKEND: 'md' } });

describe('reflowGoalResults 三态映射 (D-G1.4, GWT-G1-2)', () => {
  test('success → 票 delivered, 结果文件归档 .done, 标记清空', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'goal-rf-'));
    goalMapOn(cwd);
    writeResult(cwd, 'm1', 'g9', 'success');
    const out = reflowGoalResults(mdBackend(cwd), cwd, 'm1');
    expect(out).toEqual([{ ticketId: 'g9', disposition: 'delivered', outcome: 'success', runId: 'run-g9' }]);
    expect(mdBackend(cwd).readMap(cwd, 'm1')!.tickets[0]!.status).toBe('delivered');
    expect(existsSync(researchResultPath(cwd, 'm1', 'g9'))).toBe(false);
    expect(existsSync(`${researchResultPath(cwd, 'm1', 'g9')}.done`)).toBe(true);
    rmSync(cwd, { recursive: true, force: true });
  });

  test('blocked → 票 escalated (需人)', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'goal-rf-'));
    goalMapOn(cwd);
    writeResult(cwd, 'm1', 'g9', 'blocked', '要 owner 给凭证');
    const out = reflowGoalResults(mdBackend(cwd), cwd, 'm1');
    expect(out[0]!.disposition).toBe('escalated');
    expect(mdBackend(cwd).readMap(cwd, 'm1')!.tickets[0]!.status).toBe('escalated');
    rmSync(cwd, { recursive: true, force: true });
  });

  test('not-converged → 票留 ruled + 续跑锚落盘 + 结果归档 .attempt (不重复折入)', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'goal-rf-'));
    goalMapOn(cwd);
    writeResult(cwd, 'm1', 'g9', 'not-converged');
    const out = reflowGoalResults(mdBackend(cwd), cwd, 'm1');
    expect(out[0]!.disposition).toBe('resumable');
    expect(mdBackend(cwd).readMap(cwd, 'm1')!.tickets[0]!.status).toBe('ruled');
    expect(readFileSync(goalResumePath(cwd, 'm1', 'g9'), 'utf8')).toBe('run-g9');
    // 幂等: 再折一次无事发生 (结果文件已归档)
    expect(reflowGoalResults(mdBackend(cwd), cwd, 'm1')).toEqual([]);
    rmSync(cwd, { recursive: true, force: true });
  });

  test('GWT-G1-3: not-converged 后再派 → 用旧 runId 续 (resume 语义), 不造新 run', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'goal-rf-'));
    goalMapOn(cwd);
    writeResult(cwd, 'm1', 'g9', 'not-converged');
    reflowGoalResults(mdBackend(cwd), cwd, 'm1');
    const spawns: string[][] = [];
    const d = dispatchGoalTicket(cwd, 'm1', 'g9', '继续收敛', { spawnDetached: (c) => (spawns.push(c), 1), makeRunId: () => 'run-NEW' });
    expect(d.runId).toBe('run-g9'); // 旧 runId, 不是 run-NEW
    expect(spawns[0]!.join(' ')).toContain('--run-id run-g9');
    expect(spawns[0]!.join(' ')).toContain('--result-out'); // 结果通道接上
    rmSync(cwd, { recursive: true, force: true });
  });

  test('research 票的结果文件不走 goal 路 (语义分离)', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'goal-rf-'));
    const map: PathMap = { destination: '图', slug: 'm1', decisionsLog: [], tickets: [{ id: 'r9', type: 'research', title: '查', blockedBy: [], status: 'open' }] };
    saveMap(map, cwd);
    writeResult(cwd, 'm1', 'r9', 'success');
    expect(reflowGoalResults(mdBackend(cwd), cwd, 'm1')).toEqual([]); // 不碰 research
    rmSync(cwd, { recursive: true, force: true });
  });
});

// ── c3 波: 发现物提取 → 建议票 (D-G1.5, GWT-G1-2 后半) ───────────────────────

import { extractGoalDiscoveries } from './afk-hook';

describe('extractGoalDiscoveries 词表 (D-G1.5)', () => {
  test('三类行各提一条; success stage 不提', () => {
    const body = [
      'goal: 干活',
      'tier: complex · 未收敛 · 2 轮',
      '  [success] research — 查完了',
      '  [oracle-failed/failed] execute — tsc 两处红',
      '阻塞 (需外部输入): 要 GCP 凭证',
      '预算停: 30 分钟到顶',
    ].join('\n');
    expect(extractGoalDiscoveries(body)).toEqual([
      { type: 'task', title: '[未收敛·execute] tsc 两处红' },
      { type: 'grill', title: '[阻塞] 要 GCP 凭证' },
      { type: 'task', title: '[预算停] 30 分钟到顶' },
    ]);
  });

  test('无失败面 → 空 (success 结果不产建议)', () => {
    expect(extractGoalDiscoveries('goal: x\n  [success] execute — 全绿')).toEqual([]);
  });
});

describe('c3 折入端到端: 发现物入图 suggested 态', () => {
  test('blocked 结果 → escalated + [阻塞] suggested 票溯源 runId + 台账留痕', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'goal-c3-'));
    goalMapOn(cwd);
    writeResult(cwd, 'm1', 'g9', 'blocked', '干到一半\n阻塞 (需外部输入): 要 owner 给 API key');
    const out = reflowGoalResults(mdBackend(cwd), cwd, 'm1', { at: '2026-08-04T12:00:00Z' });
    expect(out[0]!.disposition).toBe('escalated');
    expect(out[0]!.suggested).toContain('建议入图 1');
    const m = mdBackend(cwd).readMap(cwd, 'm1')!;
    const sugg = m.tickets.find((x) => x.status === 'suggested')!;
    expect(sugg.title).toBe('[阻塞] 要 owner 给 API key');
    expect(sugg.type).toBe('grill');
    expect(sugg.suggestedBy).toBe('run-g9');
    rmSync(cwd, { recursive: true, force: true });
  });

  test('同一发现物重复折入 (两张 goal 票同病) → 第二次被指纹/语义档去重, 不翻倍', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'goal-c3-'));
    const map: PathMap = {
      destination: '图', slug: 'm1', decisionsLog: [],
      tickets: [t({ id: 'g1', executorKind: 'goal' }), t({ id: 'g2', executorKind: 'goal' })],
    };
    saveMap(map, cwd);
    writeResult(cwd, 'm1', 'g1', 'not-converged', '  [oracle-failed] execute — tsc 红');
    writeResult(cwd, 'm1', 'g2', 'not-converged', '  [oracle-failed] execute — tsc 红');
    const out = reflowGoalResults(mdBackend(cwd), cwd, 'm1', { at: '2026-08-04T12:00:00Z' });
    expect(out).toHaveLength(2);
    const m = mdBackend(cwd).readMap(cwd, 'm1')!;
    expect(m.tickets.filter((x) => x.status === 'suggested')).toHaveLength(1); // 只入一张
    expect(m.suggestionsLog!.some((e) => e.outcome === 'deduped' || e.outcome === 'deduped-semantic')).toBe(true); // 去重有痕
    rmSync(cwd, { recursive: true, force: true });
  });
});
