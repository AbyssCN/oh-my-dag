/**
 * ignition-preflight 测试 (S2 / INV-5 / G-1)。
 *
 * 覆盖: ② 活 run 写集相交 → blocked + overlap (G-1 前半); force → 'ok' 且板上留越闸记录
 * (G-1 后半 / INV-5); 终态 run 不占写面; ③ 已结晶未点火 SDD 相交 → 只 advisories 不拒 (D-1/D-10);
 * 自身 SDD / 已被活 run 占用的 SDD 不产生建议; force 无冲突不越闸留账。
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendBoard, BOARD_RUN_ID, readBoard, type BoardEntry } from '../board/run-board';
import { ignitionPreflight } from './ignition-preflight';

const dirs: string[] = [];
const freshRoot = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'omd-ignition-'));
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

/** 造一份已结晶 SDD (契约+分解两段齐, 表可解析), 返回路径。 */
const writeSdd = (root: string, file: string, rows: string[]): string => {
  const dir = join(root, 'docs', 'plan');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, file);
  writeFileSync(
    path,
    `# ${file}\n\n## 契约 (Contracts)\nGWT: 样例契约。\n\n## 分解 (Breakdown)\n` +
      `| 切片 | 写集 | 依赖 | verify |\n| --- | --- | --- | --- |\n` +
      rows.map((r) => `| ${r} |`).join('\n') +
      '\n',
    'utf8',
  );
  return path;
};

const SDD_TWO = ['1 写 a | src/a.ts | — | bun test src/a.test.ts', '2 写 b | src/b.ts | — | bun test src/b.test.ts'];

describe('ignitionPreflight (S2 / INV-5)', () => {
  test('G-1: 板上活 run 写集相交 → blocked 且 conflicts 带 overlap', () => {
    const root = freshRoot();
    appendBoard(root, entry('r1', 'claimed', { writeSet: ['src/a.ts'] }));
    const rep = ignitionPreflight(root, ['src/a.ts', 'src/b.ts']);
    expect(rep.verdict).toBe('blocked');
    expect(rep.conflicts).toEqual([{ runId: 'r1', overlap: ['src/a.ts'] }]);
    // blocked = 拒绝点火 → 绝不越闸, 板上不留任何 bypass 证据。
    expect(readBoard(root).filter((e) => e.event === 'note' && e.runId === BOARD_RUN_ID)).toHaveLength(0);
  });

  test('G-1: force:true → ok 且板上留一行越闸记录 (INV-5 后半)', () => {
    const root = freshRoot();
    appendBoard(root, entry('r1', 'claimed', { writeSet: ['src/a.ts'] }));
    const rep = ignitionPreflight(root, ['src/a.ts', 'src/b.ts'], { force: true });
    expect(rep.verdict).toBe('ok');
    expect(rep.conflicts).toEqual([{ runId: 'r1', overlap: ['src/a.ts'] }]);
    // 证据只认重读磁盘后的 note 行 (runId = BOARD_RUN_ID) —— 按字段过滤定位,
    // 不把整板内容当历史快照去全量比对。
    const notes = readBoard(root).filter((e) => e.event === 'note' && e.runId === BOARD_RUN_ID);
    expect(notes).toHaveLength(1);
    expect(notes[0]!.note).toContain('越闸');
    expect(notes[0]!.note).toContain('r1');
    expect(notes[0]!.note).toContain('src/a.ts');
    // 持久化: 第二次独立重读, 账还在 (不依赖单次读的瞬时状态)。
    expect(readBoard(root).filter((e) => e.event === 'note' && e.runId === BOARD_RUN_ID)).toHaveLength(1);
    // 越闸只追加证据行, 不动板上原有 claimed 条目。
    const claimed = readBoard(root).filter((e) => e.runId === 'r1');
    expect(claimed).toHaveLength(1);
    expect(claimed[0]!.event).toBe('claimed');
  });

  test('已终态 run 的写集相交 → 不占写面, ok (D-9: 活 = claimed 无 terminal)', () => {
    const root = freshRoot();
    appendBoard(root, entry('r-done', 'claimed', { writeSet: ['src/a.ts'] }));
    appendBoard(root, entry('r-done', 'terminal', { outcome: 'ok' }));
    const rep = ignitionPreflight(root, ['src/a.ts']);
    expect(rep.verdict).toBe('ok');
    expect(rep.conflicts).toEqual([]);
  });
  test('claimed 条目出现在 terminal 之后 → 仍不算活 (终态判定按 runId, 不按板上先后次序)', () => {
    const root = freshRoot();
    appendBoard(root, entry('r-done', 'terminal', { outcome: 'ok' }));
    appendBoard(root, entry('r-done', 'claimed', { writeSet: ['src/a.ts'] }));
    const rep = ignitionPreflight(root, ['src/a.ts']);
    expect(rep.verdict).toBe('ok');
    expect(rep.conflicts).toEqual([]);
  });

  test('写集不相交 → ok, 无冲突', () => {
    const root = freshRoot();
    appendBoard(root, entry('r1', 'claimed', { writeSet: ['src/a.ts'] }));
    const rep = ignitionPreflight(root, ['src/b.ts', 'src/c.ts']);
    expect(rep.verdict).toBe('ok');
    expect(rep.conflicts).toEqual([]);
  });

  test('多个活 run 相交 → 每个一条 conflict, overlap 排序', () => {
    const root = freshRoot();
    appendBoard(root, entry('r1', 'claimed', { writeSet: ['src/b.ts', 'src/a.ts'] }));
    appendBoard(root, entry('r2', 'claimed', { writeSet: ['src/c.ts'] }));
    const rep = ignitionPreflight(root, ['src/c.ts', 'src/a.ts']);
    expect(rep.verdict).toBe('blocked');
    expect(rep.conflicts).toEqual([
      { runId: 'r1', overlap: ['src/a.ts'] },
      { runId: 'r2', overlap: ['src/c.ts'] },
    ]);
  });
  test('G-1: overlap 多元素时逐字精确且字典序排序 (conflicts 按板上次序)', () => {
    const root = freshRoot();
    appendBoard(root, entry('r1', 'claimed', { writeSet: ['src/b.ts', 'src/a.ts', 'src/d.ts'] }));
    appendBoard(root, entry('r2', 'claimed', { writeSet: ['src/z.ts', 'src/d.ts', 'src/c.ts'] }));
    const rep = ignitionPreflight(root, ['src/d.ts', 'src/b.ts', 'src/z.ts', 'src/c.ts']);
    expect(rep.verdict).toBe('blocked');
    expect(rep.conflicts).toEqual([
      { runId: 'r1', overlap: ['src/b.ts', 'src/d.ts'] },
      { runId: 'r2', overlap: ['src/c.ts', 'src/d.ts', 'src/z.ts'] },
    ]);
  });

  test('force 但无冲突 → 没有闸可越, 不留越闸记录', () => {
    const root = freshRoot();
    appendBoard(root, entry('r1', 'claimed', { writeSet: ['src/a.ts'] }));
    ignitionPreflight(root, ['src/b.ts'], { force: true });
    expect(readBoard(root).filter((e) => e.event === 'note' && e.runId === BOARD_RUN_ID)).toHaveLength(0);
  });

  test('空写集 → 恒 ok, 无冲突无建议', () => {
    const root = freshRoot();
    appendBoard(root, entry('r1', 'claimed', { writeSet: ['src/a.ts'] }));
    const rep = ignitionPreflight(root, []);
    expect(rep.verdict).toBe('ok');
    expect(rep.conflicts).toEqual([]);
    expect(rep.advisories).toEqual([]);
  });

  test('③ 已结晶未点火 SDD 写集相交 → 只进 advisories, 不拒 (D-1/D-10)', () => {
    const root = freshRoot();
    writeSdd(root, 'other-sdd.md', ['1 写 other | src/other.ts | — | bun test src/other.test.ts']);
    const rep = ignitionPreflight(root, ['src/other.ts', 'src/x.ts']);
    expect(rep.verdict).toBe('ok');
    expect(rep.conflicts).toEqual([]);
    expect(rep.advisories).toHaveLength(1);
    expect(rep.advisories[0]).toContain('docs/plan/other-sdd.md');
    expect(rep.advisories[0]).toContain('src/other.ts');
    expect(rep.advisories[0]).toContain('合图');
  });

  test('③ 自身 SDD (写集并集 == 本 run 写集) → 不给自己出建议', () => {
    const root = freshRoot();
    writeSdd(root, 'mine.md', SDD_TWO);
    const rep = ignitionPreflight(root, ['src/a.ts', 'src/b.ts']);
    expect(rep.verdict).toBe('ok');
    expect(rep.advisories).toEqual([]);
  });

  test('③ 已被活 run 占用的 SDD → 归 ② 管, 不重复建议', () => {
    const root = freshRoot();
    writeSdd(root, 'busy.md', SDD_TWO);
    appendBoard(root, entry('r-busy', 'claimed', { writeSet: ['src/b.ts'] }));
    const rep = ignitionPreflight(root, ['src/a.ts']);
    expect(rep.verdict).toBe('ok'); // 与 r-busy 不相交
    expect(rep.conflicts).toEqual([]);
    expect(rep.advisories).toEqual([]); // busy.md 已点火 → 不建议
  });

  test('③ 不可解析的文档 (缺契约段) → 不是已结晶 SDD, 无建议 (fail-open)', () => {
    const root = freshRoot();
    const dir = join(root, 'docs', 'plan');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'prose.md'), '# 一篇散文, 没有契约段\n\n随便写写。\n', 'utf8');
    const rep = ignitionPreflight(root, ['src/a.ts']);
    expect(rep.verdict).toBe('ok');
    expect(rep.advisories).toEqual([]);
  });

  test('docs/plan 不存在 → 无建议, ok (fail-open)', () => {
    const root = freshRoot();
    const rep = ignitionPreflight(root, ['src/a.ts']);
    expect(rep.verdict).toBe('ok');
    expect(rep.advisories).toEqual([]);
  });
});
