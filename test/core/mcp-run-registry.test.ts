/**
 * test/core/mcp-run-registry.test.ts — run 注册表单元测试 (SDD run-registry).
 *
 * 纯内存, 零磁盘: 未知 runId → 明确 MCP error (isError + message), 非 crash。
 */
import { describe, expect, test } from 'bun:test';
import { RunRegistry, type RunStatus } from '../../src/mcp/run-registry';

describe('RunRegistry', () => {
  test('未知 runId getStatus → null (不抛)', () => {
    const reg = new RunRegistry();
    expect(reg.getStatus('nonexistent')).toBeNull();
  });

  test('未知 runId getSummary → isError MCP 结果', () => {
    const reg = new RunRegistry();
    const res = reg.getSummary('no-such-id');
    expect(res.isError).toBe(true);
    expect(res.content).toHaveLength(1);
    expect(res.content[0]!.type).toBe('text');
    expect((res.content[0]! as { type: 'text'; text: string }).text).toContain('no-such-id');
  });

  test('register → pending; start → running; succeed → done', () => {
    const reg = new RunRegistry();
    reg.register('r1', { goal: 'test' });
    expect(reg.getStatus('r1')).toBe('pending');

    reg.start('r1');
    expect(reg.getStatus('r1')).toBe('running');

    reg.succeed('r1', { output: 'ok' });
    expect(reg.getStatus('r1')).toBe('done');
    const summary = reg.getSummary('r1');
    expect(summary.isError).toBeFalsy();
    expect((summary.content[0]! as { type: 'text'; text: string }).text).toContain('done');
  });

  test('register → fail → failed', () => {
    const reg = new RunRegistry();
    reg.register('r2', { goal: 'test' });
    reg.start('r2');
    reg.fail('r2', 'boom');
    expect(reg.getStatus('r2')).toBe('failed');
    const summary = reg.getSummary('r2');
    expect(summary.isError).toBeFalsy(); // 查询成功, 不是 MCP error
    expect((summary.content[0]! as { type: 'text'; text: string }).text).toContain('failed');
    expect((summary.content[0]! as { type: 'text'; text: string }).text).toContain('boom');
  });

  test('重复 register 同 runId → 抛 (不静默覆盖)', () => {
    const reg = new RunRegistry();
    reg.register('dup', { goal: 'x' });
    expect(() => reg.register('dup', { goal: 'y' })).toThrow();
  });

  test('非法状态转换 → 抛 (如 pending→done 跳过 running)', () => {
    const reg = new RunRegistry();
    reg.register('r3', { goal: 'test' });
    expect(() => reg.succeed('r3', {})).toThrow();
  });

  test('listRuns 按状态过滤', () => {
    const reg = new RunRegistry();
    reg.register('a', { goal: 'x' });
    reg.register('b', { goal: 'y' });
    reg.start('b');
    expect(reg.listRuns('pending')).toEqual(['a']);
    expect(reg.listRuns('running')).toEqual(['b']);
    expect(reg.listRuns()).toEqual(expect.arrayContaining(['a', 'b']));
  });
});

// ── round4: applyNodeEvent 三事件语义 ────────────────────────────────────────────

describe('applyNodeEvent', () => {
  test('start 进 started; settle 移出 started 进 settled; planned 整体覆盖', () => {
    const reg = new RunRegistry();
    reg.register('r1', { goal: 'g' });
    reg.start('r1');
    reg.applyNodeEvent('r1', { type: 'planned', nodes: [{ id: 'a', kind: 'inproc' }, { id: 'b', kind: 'agent' }] });
    reg.applyNodeEvent('r1', { type: 'start', id: 'a', kind: 'inproc' });
    let p = reg.getRecord('r1')!.progress!;
    expect(p.planned.length).toBe(2);
    expect(p.started).toEqual(['a']);
    reg.applyNodeEvent('r1', { type: 'settle', id: 'a', status: 'done', kind: 'inproc', model: 'fake:m' });
    p = reg.getRecord('r1')!.progress!;
    expect(p.started).toEqual([]);
    expect(p.settled).toEqual([{ id: 'a', status: 'done', kind: 'inproc', model: 'fake:m' }]);
    // 升级重规划: planned 整体覆盖
    reg.applyNodeEvent('r1', { type: 'planned', nodes: [{ id: 'c', kind: 'inproc' }] });
    expect(reg.getRecord('r1')!.progress!.planned).toEqual([{ id: 'c', kind: 'inproc' }]);
    // 未知 runId: 静默不抛 (fail-open, 事件流不背崩溃责任)
    expect(() => reg.applyNodeEvent('ghost', { type: 'start', id: 'x', kind: 'inproc' })).not.toThrow();
  });

  test('start 记 ISO 时刻 (注入 clock); running 行带耗时; settle 清时刻', () => {
    let t = Date.parse('2026-01-01T00:00:00.000Z');
    const reg = new RunRegistry(() => new Date(t));
    reg.register('r1', { goal: 'g' });
    reg.start('r1');
    reg.applyNodeEvent('r1', { type: 'planned', nodes: [{ id: 'a', kind: 'inproc' }] });
    reg.applyNodeEvent('r1', { type: 'start', id: 'a', kind: 'inproc' });
    expect(reg.getRecord('r1')!.progress!.startedAt).toEqual({ a: '2026-01-01T00:00:00.000Z' });
    t += 192_000; // 3m12s
    const text = reg.getSummary('r1').content[0]!.text;
    expect(text).toContain('running: a(inproc, 3m12s)');
    reg.applyNodeEvent('r1', { type: 'settle', id: 'a', status: 'done', kind: 'inproc' });
    expect(reg.getRecord('r1')!.progress!.startedAt).toEqual({});
  });
});
