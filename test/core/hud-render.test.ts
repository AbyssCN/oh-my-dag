/**
 * test/core/hud-render.test.ts — omd-hud 渲染层单测 (纯函数)。
 *
 * 覆盖: 空闲降级 · live DAG (header/进度条/层级图/running 耗时) · stalled · finished ·
 * fog 追加 · 宽度截断 (宽字符按 2) · color=false 无 ANSI。
 */
import { describe, expect, test } from 'bun:test';
import { clamp, dispWidth, renderHud, type HudSession } from '../../src/hud/render';
import type { DagView } from '../../src/hud/load';
import type { HudDagSnapshot, HudFogSnapshot } from '../../src/hud/types';

const NOW = Date.parse('2026-07-21T10:05:00.000Z');
const session: HudSession = { model: 'Opus', repo: 'xihe', ctxPct: 14, costUsd: 0.02, fiveHourPct: 2 };

const liveSnap = (): HudDagSnapshot => ({
  schema: 1,
  runId: 'plan-abc123',
  goal: 'ship omd-hud',
  status: 'running',
  updatedAt: '2026-07-21T10:04:55.000Z',
  levels: [['a', 'b'], ['c']],
  planned: [
    { id: 'a', kind: 'leaf' },
    { id: 'b', kind: 'leaf' },
    { id: 'c', kind: 'agent' },
  ],
  started: ['c'],
  startedAt: { c: '2026-07-21T10:04:15.000Z' }, // 45s ago
  settled: [
    { id: 'a', status: 'done', kind: 'leaf' },
    { id: 'b', status: 'done', kind: 'leaf' },
  ],
});

const liveView = (): DagView => ({ snap: liveSnap(), phase: 'live', ageMs: 5000 });

describe('dispWidth / clamp', () => {
  test('宽字符 (CJK/emoji) 按 2 计', () => {
    expect(dispWidth('abc')).toBe(3);
    expect(dispWidth('散雾')).toBe(4);
    expect(dispWidth('⚡')).toBe(2);
  });
  test('clamp 超宽截断 + …, 不超宽原样', () => {
    expect(clamp('hello world', 5)).toBe('hell…');
    expect(clamp('hello', 20)).toBe('hello');
    // 宽字符不被半截: 6 宽预算下 '散雾x' (2+2+1=5) + …
    expect(dispWidth(clamp('散雾散雾', 5))).toBeLessThanOrEqual(5);
  });
  test('ANSI 转义不计宽', () => {
    expect(dispWidth('\x1b[32mok\x1b[0m')).toBe(2);
  });
});

describe('renderHud — 空闲降级', () => {
  test('无 dag 无 fog → 单行 session 摘要', () => {
    const out = renderHud({ dag: null, fog: null, session, cols: 200, nowMs: NOW, color: false });
    expect(out.split('\n')).toHaveLength(1);
    expect(out).toContain('Opus');
    expect(out).toContain('xihe');
    expect(out).toContain('ctx 14%');
    expect(out).toContain('5h 2%');
    expect(out).toContain('$0.02');
  });
});

describe('renderHud — live DAG', () => {
  test('header + 层级图 + running 耗时', () => {
    const out = renderHud({ dag: liveView(), fog: null, session, cols: 200, nowMs: NOW, color: false });
    const lines = out.split('\n');
    expect(lines[0]).toContain('⚡ ship omd-hud');
    expect(lines[0]).toContain('running');
    expect(lines[0]).toContain('2/3'); // 2 done / 3 total
    // 层级图两层
    expect(out).toContain('L1');
    expect(out).toContain('L2');
    // running 节点 c(agent) 45s
    expect(out).toContain('c(agent 45s)');
  });
  test('color=false 无 ANSI; color=true 有', () => {
    const plain = renderHud({ dag: liveView(), fog: null, session, cols: 200, nowMs: NOW, color: false });
    expect(plain).not.toContain('\x1b[');
    const colored = renderHud({ dag: liveView(), fog: null, session, cols: 200, nowMs: NOW, color: true });
    expect(colored).toContain('\x1b[');
  });
});

describe('renderHud — stalled / finished', () => {
  test('stalled → ⚠ + 龄; 不显示 running 行', () => {
    const view: DagView = { snap: { ...liveSnap(), started: [] }, phase: 'stalled', ageMs: 47000 };
    const out = renderHud({ dag: view, fog: null, session, cols: 200, nowMs: NOW, color: false });
    expect(out).toContain('⚠ stalled');
    expect(out).not.toContain('running 0');
  });
  test('finished done → ✔ done', () => {
    const snap: HudDagSnapshot = { ...liveSnap(), status: 'done', started: [], settled: [
      { id: 'a', status: 'done', kind: 'leaf' }, { id: 'b', status: 'done', kind: 'leaf' }, { id: 'c', status: 'done', kind: 'agent' },
    ] };
    const out = renderHud({ dag: { snap, phase: 'finished', ageMs: 2000 }, fog: null, session, cols: 200, nowMs: NOW, color: false });
    expect(out).toContain('✔ done');
    expect(out).toContain('3/3');
  });
  test('finished failed → ✘ failed + 失败计数', () => {
    const snap: HudDagSnapshot = { ...liveSnap(), status: 'failed', started: [], settled: [
      { id: 'a', status: 'done', kind: 'leaf' }, { id: 'b', status: 'failed', kind: 'leaf' }, { id: 'c', status: 'failed', kind: 'agent' },
    ] };
    const out = renderHud({ dag: { snap, phase: 'finished', ageMs: 2000 }, fog: null, session, cols: 200, nowMs: NOW, color: false });
    expect(out).toContain('✘ failed');
    expect(out).toContain('✘2');
  });
});

describe('renderHud — fog 段', () => {
  const fog: HudFogSnapshot = { schema: 1, updatedAt: '2026-07-21T10:04:00.000Z', destination: 'MCP-first', ruled: 2, total: 5, bar: '████▒▒▒▒░░' };
  test('fog 追加在 DAG 之后', () => {
    const out = renderHud({ dag: liveView(), fog, session, cols: 200, nowMs: NOW, color: false });
    const last = out.split('\n').at(-1)!;
    expect(last).toContain('🧭 MCP-first');
    expect(last).toContain('2/5 散雾');
  });
  test('空闲 + fog → session 行 + fog 行', () => {
    const out = renderHud({ dag: null, fog, session, cols: 200, nowMs: NOW, color: false });
    expect(out.split('\n')).toHaveLength(2);
  });
});

describe('renderHud — 宽度截断 (窄终端)', () => {
  test('每行显示宽 ≤ cols', () => {
    const fog: HudFogSnapshot = { schema: 1, updatedAt: '2026-07-21T10:04:00.000Z', destination: '一个很长的目的地名字用来撑爆宽度', ruled: 1, total: 9, bar: '█▒▒▒▒░░░░░' };
    const out = renderHud({ dag: liveView(), fog, session, cols: 24, nowMs: NOW, color: false });
    for (const l of out.split('\n')) {
      expect(dispWidth(l)).toBeLessThanOrEqual(24);
    }
  });
});
