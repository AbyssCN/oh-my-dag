/**
 * run-board 词表扩两型(verified / intervened)的契约测试 —— #160 首片。
 *
 * 本片只立**词表与不变量**: 板能记这两型且 append/read/compact/单行 ≤1KB / liveRuns 全成立。
 * 生产发射点(run-goal 终态发 verified、人工介入记录面、readout 可避免性率、判据④)是后续片。
 *
 * GWT 1-5 全部对应 SDD 契约; INV-1..INV-4 由 GWT 行为钉住。
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { FAILURE_KIND_ORDER } from '../node-failure';
import { appendBoard, liveRuns, readBoard, type BoardEntry } from './run-board';

const dirs: string[] = [];
const freshRoot = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'omd-run-board-vi-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const entry = (runId: string, event: BoardEntry['event'], extra: Partial<BoardEntry> = {}): BoardEntry => ({
  v: 1,
  ts: new Date().toISOString(),
  runId,
  event,
  ...extra,
});

const boardFile = (root: string): string => join(root, '.omd', 'run-board.jsonl');

/** G-4 保留期契约值: 默认 24h, 自 terminal 条目 ts 起算。 */
const RETENTION_MS = 24 * 60 * 60 * 1000;
const tsAgo = (ms: number): string => new Date(Date.now() - ms).toISOString();

/** 直接写板文件(绕过 appendBoard 构造过期 ts / 超大 payload 场景): 父目录先建好。 */
const writeBoard = (root: string, lines: string[]): void => {
  mkdirSync(dirname(boardFile(root)), { recursive: true });
  writeFileSync(boardFile(root), lines.join('\n') + '\n', 'utf8');
};


describe('GWT-1: verified 事件落盘 + 回读字段无损', () => {
  test('verified + verdict + note 逐字段回读一致', () => {
    const root = freshRoot();
    const e: BoardEntry = entry('r1', 'verified', { verdict: 'fail', note: '判词指纹…abc123' });
    appendBoard(root, e);
    const got = readBoard(root);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({
      v: 1,
      runId: 'r1',
      event: 'verified',
      verdict: 'fail',
      note: '判词指纹…abc123',
    });
    expect(got[0]!.ts).toBe(e.ts);
  });
});


describe('GWT-2: intervened 合法值往返 + 非法 verdict/cause fail-loud 不落坏行', () => {
  test('intervened + 合法 cause 逐字段回读一致', () => {
    const root = freshRoot();
    const e: BoardEntry = entry('r2', 'intervened', { cause: 'empty-artifact', note: '人工收编原因' });
    appendBoard(root, e);
    const got = readBoard(root);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({
      v: 1,
      runId: 'r2',
      event: 'intervened',
      cause: 'empty-artifact',
      note: '人工收编原因',
    });
  });

  test('intervened + 非法 cause: appendBoard 抛 + 板上没有新行', () => {
    const root = freshRoot();
    // 先放一条合法的, 确认非法 append 后该条仍在且**没有新行**
    appendBoard(root, entry('seed', 'claimed', { writeSet: ['seed.ts'] }));
    const before = readBoard(root);
    expect(before).toHaveLength(1);

    expect(() =>
      appendBoard(root, entry('r2', 'intervened', { cause: 'not-a-kind', note: 'x' })),
    ).toThrow(/intervened event requires cause in FAILURE_KIND_ORDER/);

    const after = readBoard(root);
    expect(after).toHaveLength(1); // 只有 seed, 没新行
    expect(after[0]!.runId).toBe('seed');
  });

  test('verified + 非法 verdict: appendBoard 抛 + 板上没有新行', () => {
    const root = freshRoot();
    appendBoard(root, entry('seed', 'claimed', { writeSet: ['seed.ts'] }));
    const before = readBoard(root);
    expect(before).toHaveLength(1);

    // 用类型断言模拟调用方传错 verdict 的真实场景(合法 TS 不会容许, 但运行期仍要 fail-loud)
    const bad = entry('r1', 'verified', { verdict: 'maybe' as unknown as 'pass', note: 'x' });
    expect(() => appendBoard(root, bad)).toThrow(/verified event requires verdict in \{"pass","fail"\}/);

    const after = readBoard(root);
    expect(after).toHaveLength(1);
    expect(after[0]!.runId).toBe('seed');
  });

  test('verified 缺 verdict: appendBoard 抛', () => {
    const root = freshRoot();
    expect(() => appendBoard(root, entry('r1', 'verified', { note: 'no verdict' }))).toThrow(
      /verified event requires verdict/,
    );
  });
});


describe('GWT-3: 单行 ≤1KB(INV-1) + note 超 500B 截断对新事件成立', () => {
  test('verified + 2KB note → 落盘行字节数 ≤ 1024 且回读 note 是截断后的前缀', () => {
    const root = freshRoot();
    const longNote = 'X'.repeat(2 * 1024); // 2KB
    appendBoard(root, entry('r1', 'verified', { verdict: 'fail', note: longNote }));

    const raw = readFileSync(boardFile(root), 'utf8');
    const lines = raw.split('\n').filter((l) => l.trim().length > 0);
    expect(lines).toHaveLength(1);
    expect(Buffer.byteLength(lines[0]!, 'utf8')).toBeLessThanOrEqual(1024);

    const got = readBoard(root);
    expect(got).toHaveLength(1);
    expect(got[0]!.event).toBe('verified');
    expect(got[0]!.verdict).toBe('fail');
    expect(got[0]!.note!.length).toBeLessThanOrEqual(500);
    expect(got[0]!.note!.startsWith('X')).toBe(true); // 截断后前缀
  });
});


describe('GWT-4: compact 对 verified/intervened 随 run 生命周期 (D-3)', () => {
  test('活 run A 的 verified 留; 终态超期 run B 的 intervened 随 run 删', () => {
    const root = freshRoot();
    // A: 活 run (claimed, 无 terminal), ts 用当前时间 —— 不会被任何保留期判定为超期
    const lines: string[] = [
      JSON.stringify(entry('A', 'claimed', { writeSet: ['a.ts'] })),
      JSON.stringify({ ...entry('A', 'verified', { verdict: 'pass' }), ts: new Date().toISOString() }),
      // B: 终态 run, terminal ts 已超 2× 保留期 → 触发 stale 删除
      JSON.stringify(entry('B', 'claimed', { ts: tsAgo(2 * RETENTION_MS), writeSet: ['b.ts'] })),
      JSON.stringify(entry('B', 'terminal', { ts: tsAgo(2 * RETENTION_MS), outcome: 'ok' })),
      JSON.stringify({ ...entry('B', 'intervened', { cause: 'empty-artifact' }), ts: tsAgo(2 * RETENTION_MS) }),
    ];
    writeBoard(root, lines);

    // 触发 compact(直接追加一条新条目, appendBoard 内部 withLock → compactBoard)
    appendBoard(root, entry('A', 'note', { note: 'trigger compact' }));

    const got = readBoard(root);
    const runIds = got.map((e) => e.runId);
    // A 的 verified 仍在
    expect(runIds).toContain('A');
    const aVerified = got.find((e) => e.runId === 'A' && e.event === 'verified');
    expect(aVerified).toBeDefined();
    expect(aVerified!.verdict).toBe('pass');
    // B 的所有条目(含 intervened)随 run 删除
    expect(runIds).not.toContain('B');
  });
});


describe('GWT-5: liveRuns 不因新事件改变判定 (D-4)', () => {
  test('有 claimed + verified + intervened 但无 terminal → 仍在 liveRuns, writeSet 取自 claimed', () => {
    const entries: BoardEntry[] = [
      entry('r-live', 'claimed', { writeSet: ['a.ts', 'b.ts'] }),
      entry('r-live', 'verified', { verdict: 'pass', note: 'x' }),
      entry('r-live', 'intervened', { cause: 'empty-artifact', note: 'y' }),
    ];
    const live = liveRuns(entries);
    expect(live.has('r-live')).toBe(true);
    expect(live.get('r-live')).toEqual(['a.ts', 'b.ts']);
  });

  test('已有 terminal 的 run, 即使有 verified/intervened → 不进 liveRuns', () => {
    const entries: BoardEntry[] = [
      entry('r-done', 'claimed', { writeSet: ['a.ts'] }),
      entry('r-done', 'verified', { verdict: 'pass' }),
      entry('r-done', 'intervened', { cause: 'broken-artifact' }),
      entry('r-done', 'terminal', { outcome: 'ok' }),
    ];
    const live = liveRuns(entries);
    expect(live.has('r-done')).toBe(false);
  });
});


describe('FAILURE_KIND_ORDER 词表复用 (D-2 cause 值域)', () => {
  test('FAILURE_KIND_ORDER 至少包含 empty-artifact, broken-artifact, infra-error', () => {
    // 锚住 SDD 中明确提到的几个 kind, 防 node-failure 词表漂移让本测试静默失效
    expect(FAILURE_KIND_ORDER).toContain('empty-artifact');
    expect(FAILURE_KIND_ORDER).toContain('broken-artifact');
    expect(FAILURE_KIND_ORDER).toContain('infra-error');
  });
});