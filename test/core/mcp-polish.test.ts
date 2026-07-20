/**
 * test/core/mcp-polish.test.ts — MCP polish 层纯逻辑单测 (fake/内存, 零网络)。
 *
 * 覆盖:
 *   ① applyNodeEvent start → startedAt ISO + running 行含耗时
 *   ② dispatchBriefing L1 层级行 + >20 节点降采样
 *   ③ fogBar 迷雾条渲染
 *   ④ assemble agentRunner 超时 env 覆盖 (标注跳过理由)
 */
import { describe, expect, test } from 'bun:test';
import { RunRegistry } from '../../src/mcp/run-registry';
import type { DagNodeEvent } from '../../src/harness/executor-dag-types';
import { renderProgressAscii, dispatchBriefing } from '../../src/mcp/tools/dag-tools';
import { fogBar } from '../../src/mcp/tools/pathfinder';
import type { PathMap, Ticket } from '../../src/harness/pathfinder/types';
import type { ConductorPlan } from '../../src/harness/conductor-plan';
import type { ExecutorDagConfig } from '../../src/harness/executor-dag-types';

// ── helpers ──────────────────────────────────────────────────────────────────

/** 冻结时钟 RunRegistry。 */
function frozenRegistry(iso: string): RunRegistry {
  return new RunRegistry(() => new Date(iso));
}

/** 最小 ConductorPlan。 */
function makePlan(nodes: Record<string, { executor?: string; depends_on?: string[] }>): ConductorPlan {
  return {
    name: 'test-plan',
    nodes: Object.fromEntries(
      Object.entries(nodes).map(([id, n]) => [id, { goal: `goal-${id}`, ...n }]),
    ),
  } as ConductorPlan;
}

/** 最小 ExecutorDagConfig。 */
const BASE_CONFIG: ExecutorDagConfig = {
  conductorModel: 'test:conductor',
  leafModel: 'test:leaf',
};

/** 造票 helper。 */
function ticket(id: string, status: Ticket['status'], type: Ticket['type'] = 'task'): Ticket {
  return { id, type, title: `title-${id}`, blockedBy: [], status };
}

/** 造地图 helper。 */
function makeMap(destination: string, tickets: Ticket[]): PathMap {
  return { destination, slug: destination.toLowerCase().replace(/\s+/g, '-'), tickets, decisionsLog: [] };
}

// ── ① applyNodeEvent: startedAt ISO + running 行耗时 ────────────────────────

describe('applyNodeEvent → startedAt + running elapsed', () => {
  test('start 事件写入 ISO startedAt; getSummary running 行含耗时', () => {
    const t0 = '2025-01-01T00:00:00.000Z';
    const t1 = '2025-01-01T00:00:45.000Z'; // +45s
    let clock = t0;
    const reg = new RunRegistry(() => new Date(clock));

    reg.register('r1', { goal: 'test' });
    reg.start('r1');

    // planned → start (clock = t0 → startedAt = t0)
    reg.applyNodeEvent('r1', { type: 'planned', nodes: [{ id: 'n1', kind: 'agent' }] });
    reg.applyNodeEvent('r1', { type: 'start', id: 'n1', kind: 'agent' });

    const rec = reg.getRecord('r1')!;
    expect(rec.progress).toBeDefined();
    expect(rec.progress!.startedAt['n1']).toBe(t0);
    expect(rec.progress!.started).toContain('n1');

    // advance clock to t1 → getSummary elapsed = 45s
    clock = t1;
    const summary = reg.getSummary('r1');
    const text = summary.content[0]!.text;
    expect(text).toContain('running:');
    expect(text).toContain('n1(agent, 45s)');
  });

  test('settle 移除 startedAt + 从 started 列表消失', () => {
    const reg = frozenRegistry('2025-01-01T00:00:00.000Z');
    reg.register('r1', { goal: 'test' });
    reg.start('r1');
    reg.applyNodeEvent('r1', { type: 'planned', nodes: [{ id: 'n1', kind: 'leaf' }] });
    reg.applyNodeEvent('r1', { type: 'start', id: 'n1', kind: 'leaf' });
    reg.applyNodeEvent('r1', { type: 'settle', id: 'n1', status: 'done', kind: 'leaf' });

    const p = reg.getRecord('r1')!.progress!;
    expect(p.started).not.toContain('n1');
    expect(p.startedAt['n1']).toBeUndefined();
    expect(p.settled).toContainEqual(expect.objectContaining({ id: 'n1', status: 'done' }));
  });
});

// ── ② dispatchBriefing: L1 层级行 + >20 节点降采样 ─────────────────────────

describe('dispatchBriefing', () => {
  test('含 L1 层级行; 3 节点 2 层图', () => {
    const plan = makePlan({
      a: {},
      b: { depends_on: ['a'] },
      c: { depends_on: ['a'] },
    });
    const out = dispatchBriefing(plan, BASE_CONFIG);
    expect(out).toContain('L1');
    expect(out).toContain('L2');
    expect(out).toContain('nodes: 3');
  });

  test('>20 节点降采样: 行含计数不含全部 id', () => {
    // 构造 25 个无依赖节点 → 1 层 25 节点, 超阈值
    const nodes: Record<string, { executor?: string }> = {};
    for (let i = 0; i < 25; i++) nodes[`n${i}`] = {};
    const plan = makePlan(nodes);
    const out = dispatchBriefing(plan, BASE_CONFIG);

    // 降采样模式: L1 行含 ✔/▶/✘/○ + 计数, 不含节点 id
    expect(out).toContain('L1');
    expect(out).toContain('○25'); // 25 个 pending
    // 不应包含具体 id (如 n0, n24)
    expect(out).not.toContain('n0(');
    expect(out).not.toContain('n24(');
  });

  test('≤20 节点展 id + kind', () => {
    const plan = makePlan({ a: { executor: 'agent' }, b: { executor: 'leaf' } });
    const out = dispatchBriefing(plan, BASE_CONFIG);
    // 展开模式: 含节点 id + kind
    expect(out).toContain('a(agent)');
    expect(out).toContain('b(leaf)');
  });
});

// ── ③ renderProgressAscii: 层级渲染 ─────────────────────────────────────────

describe('renderProgressAscii', () => {
  test('≤20 节点展 id; 状态符号正确', () => {
    const levels = [['a', 'b'], ['c']];
    const progress = {
      planned: [
        { id: 'a', kind: 'agent' },
        { id: 'b', kind: 'leaf' },
        { id: 'c', kind: 'leaf' },
      ],
      started: ['b'],
      settled: [{ id: 'a', status: 'done' as const, kind: 'agent' }],
    };
    const out = renderProgressAscii(levels, progress);
    expect(out).toContain('L1 ✔ a(agent) ▶ b(leaf)');
    expect(out).toContain('L2 ○ c(leaf)');
  });

  test('>20 节点降采样: 每层只输出计数', () => {
    const ids = Array.from({ length: 25 }, (_, i) => `n${i}`);
    const levels = [ids];
    const progress = {
      planned: ids.map((id) => ({ id, kind: 'leaf' })),
      started: ['n0'],
      settled: [{ id: 'n1', status: 'done' as const, kind: 'leaf' }],
    };
    const out = renderProgressAscii(levels, progress);
    // 1 done + 1 running + 23 pending
    expect(out).toContain('✔1');
    expect(out).toContain('▶1');
    expect(out).toContain('○23');
    // 不含具体 id
    expect(out).not.toContain('n0(');
  });
});

// ── ③ fogBar: 迷雾条渲染 ────────────────────────────────────────────────────

describe('fogBar', () => {
  test('空地图: 0/0 散雾', () => {
    const map = makeMap('TestDest', []);
    const out = fogBar(map);
    expect(out).toContain('0/0 散雾');
  });

  test('全 delivered: ████… 3/3 散雾', () => {
    const map = makeMap('Done', [
      ticket('t1', 'delivered'),
      ticket('t2', 'ruled'),
      ticket('t3', 'delivered'),
    ]);
    const out = fogBar(map);
    expect(out).toContain('3/3 散雾');
    expect(out).toContain('█ t1 t2 t3');
    expect(out).toContain('▒ —'); // 无 open
    expect(out).toContain('░ —'); // 无 blocked
  });

  test('混合状态: 比例条 + 分类 id 行', () => {
    const map = makeMap('Mixed', [
      ticket('t1', 'delivered'),
      ticket('t2', 'open'),
      ticket('t3', 'blocked'),
      ticket('t4', 'ruled'),
    ]);
    const out = fogBar(map);
    // 2/4 散雾
    expect(out).toContain('2/4 散雾');
    // 分类行
    expect(out).toContain('█ t1 t4');
    expect(out).toContain('▒ t2');
    expect(out).toContain('░ t3');
    // 目的地标签
    expect(out).toContain('<Mixed>');
  });

  test('全 open: ▒▒▒… 0/N 散雾', () => {
    const map = makeMap('Open', [ticket('a', 'open'), ticket('b', 'open')]);
    const out = fogBar(map);
    expect(out).toContain('0/2 散雾');
    expect(out).toContain('▒ a b');
    expect(out).toContain('█ —');
  });
});

// ── ④ assemble agentRunner 超时 env 覆盖 ────────────────────────────────────

describe('assemble leafTimeoutMs env override', () => {
  /**
   * ⏭ 跳过: assembleOmdMcpTools 内部创建 createAgentLeafRunner, opts 不对外暴露;
   * env 解析逻辑 (OMD_LEAF_TIMEOUT_MS → leafTimeoutMs) 是内联 IIFE, 无独立纯函数可测。
   *
   * 若要测: ① 提取 parseLeafTimeoutMs(env) 为独立纯函数 ② 或 mock createAgentLeafRunner
   * 捕获 opts.leafTimeoutMs。当前代码结构下直接测 = 白盒桩过深, 维护成本 > 价值。
   *
   * 验证路径 (手动/集成): 启动 MCP server 带 OMD_LEAF_TIMEOUT_MS=120000, 观察 agent leaf
   * 超时行为是否 120s 而非默认 3600s。
   */
  test.skip('env OMD_LEAF_TIMEOUT_MS 覆盖默认 3600s (见注释: 需提取纯函数或 mock)', () => {
    // placeholder — 不可达
  });
});
