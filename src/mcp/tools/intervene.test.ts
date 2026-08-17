/**
 * src/mcp/tools/intervene.test —— GWT 3 (SDD #160 D-4)。
 *
 * 合法 cause → 板上读回 + 回执含「已记」;
 * 非法 cause → err 回执含合法值域 + 板无新行 (INV-3);
 * 缺 runId → err 回执 (跑板前拦)。
 *
 * 测试夹具 = 真 mkdtemp 主仓根 (TMPDIR 已被 test/setup 隔离) — 写盘即真, 不打桩。
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readBoard } from '../../harness/board/run-board';
import { createInterveneTools } from './intervene';

const mkCwd = (): string => mkdtempSync(join(tmpdir(), 'omd-intervene-'));
const byName = (cwd: string, name: string) =>
  createInterveneTools({ cwd }).find((t) => t.name === name)!;

const call = (
  h: ReturnType<typeof byName>['handler'],
  args: Record<string, unknown>,
): Promise<{ content: { text: string }[]; isError?: boolean }> =>
  h(args as never, {} as never) as unknown as Promise<{ content: { text: string }[]; isError?: boolean }>;

describe('dag_intervene 工具 (GWT 3 / D-4)', () => {
  test('合法 cause + note → 回执含「已记」, 板上可读回该 intervened 条目', async () => {
    const cwd = mkCwd();
    const h = byName(cwd, 'dag_intervene').handler;

    const res = await call(h, { runId: 'r1', cause: 'empty-artifact', note: '手工收编' });

    expect(res.isError).toBeFalsy();
    expect(res.content[0]!.text).toBe('已记 intervened r1 empty-artifact');

    const rows = readBoard(cwd);
    const intervened = rows.filter((r) => r.event === 'intervened');
    expect(intervened).toHaveLength(1);
    expect(intervened[0]).toMatchObject({
      runId: 'r1',
      cause: 'empty-artifact',
      note: '手工收编',
    });
  });

  test('合法 cause + 缺省 note → 板条目不带 note 字段 (整键缺席, 不是空串)', async () => {
    const cwd = mkCwd();
    const h = byName(cwd, 'dag_intervene').handler;

    const res = await call(h, { runId: 'r-no-note', cause: 'assert-failed' });

    expect(res.isError).toBeFalsy();
    expect(res.content[0]!.text).toBe('已记 intervened r-no-note assert-failed');

    const rows = readBoard(cwd);
    const intervened = rows.filter((r) => r.event === 'intervened');
    expect(intervened).toHaveLength(1);
    expect(intervened[0]).toMatchObject({ runId: 'r-no-note', cause: 'assert-failed' });
    expect('note' in intervened[0]!).toBe(false); // 整键缺席 ≠ note:''
  });

  test('非法 cause (绕过 schema) → err 回执含合法值域, 板无新行 (INV-3)', async () => {
    const cwd = mkCwd();
    const h = byName(cwd, 'dag_intervene').handler;

    const res = await call(h, { runId: 'r2', cause: 'not-a-kind', note: 'x' });

    expect(res.isError).toBe(true);
    // 合法值域必须念出来 —— 调用方看这一行就知道该填哪个
    expect(res.content[0]!.text).toContain('empty-artifact');
    expect(res.content[0]!.text).toContain('assert-failed');
    expect(res.content[0]!.text).toContain('"not-a-kind"');

    const rows = readBoard(cwd);
    expect(rows.filter((r) => r.event === 'intervened')).toHaveLength(0);
  });

  test('缺 runId → err 回执, 板无新行 (跑板前拦)', async () => {
    const cwd = mkCwd();
    const h = byName(cwd, 'dag_intervene').handler;

    const res = await call(h, { cause: 'empty-artifact' });

    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain('runId');
    expect(readBoard(cwd)).toHaveLength(0);
  });

  test('多次合法调用 → 板上 multiple intervened 条目 (append-only 性质)', async () => {
    const cwd = mkCwd();
    const h = byName(cwd, 'dag_intervene').handler;

    await call(h, { runId: 'r3', cause: 'assert-failed' });
    await call(h, { runId: 'r3', cause: 'timed-out', note: '第二次介入' });
    await call(h, { runId: 'r4', cause: 'gate-rejected' });

    const intervened = readBoard(cwd).filter((r) => r.event === 'intervened');
    expect(intervened).toHaveLength(3);
    expect(intervened.map((r) => r.cause)).toEqual(['assert-failed', 'timed-out', 'gate-rejected']);
    expect(intervened[1]!.note).toBe('第二次介入');
  });
});