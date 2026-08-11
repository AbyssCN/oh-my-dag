/**
 * run-board 测试(G-4/G-5 契约条款, 不是可选项)。
 *
 * ## G-5 反向自检(证伪方式, 契约条款)
 * 证伪: 把 `run-board.ts` 的 `compactBoard` 里 `terminalRuns.has(p.runId)` 的删除分支
 * 反转为「**删活条目**」(例如把 `if (p && terminalRuns.has(p.runId)) { continue; }` 改成
 * `if (p && !terminalRuns.has(p.runId)) { continue; }`), 跑本文件:
 * `bun test src/harness/board/run-board.test.ts`
 * → **G-4 那条(「compact 后 ≤1MB 且所有活 run 条目仍在」)必须变红**(活条目被删)。
 * 还原后再跑 → 全绿。本文件先于实现跑过一次: 无 compact 的裸 append 实现上,
 * 超限文件不会被压缩, G-4 红; 实现 compact 后绿。
 *
 * 本文件在写死前已按此流程亲手执行过一遍(变异 → 红 → 还原 → 绿), 注释即证伪契约。
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { appendBoard, readBoard, liveRuns, type BoardEntry } from './run-board';

const dirs: string[] = [];
const freshRoot = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'omd-run-board-'));
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

/** 直接写板文件(绕过 appendBoard 构造坏行/超限场景): 父目录先建好。 */
const writeBoard = (root: string, lines: string[]): void => {
  mkdirSync(dirname(boardFile(root)), { recursive: true });
  writeFileSync(boardFile(root), lines.join('\n') + '\n', 'utf8');
};

describe('appendBoard / readBoard 基本往返', () => {
  test('追加一条 claimed → 读回同一条(字段无损)', () => {
    const root = freshRoot();
    appendBoard(root, entry('r1', 'claimed', { writeSet: ['a.ts', 'b.ts'] }));
    const got = readBoard(root);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ v: 1, runId: 'r1', event: 'claimed', writeSet: ['a.ts', 'b.ts'] });
  });

  test('note 超 500B 截断, 且截断不劈开多字节字符', () => {
    const root = freshRoot();
    appendBoard(root, entry('r1', 'note', { note: '界'.repeat(600) }));
    const got = readBoard(root);
    expect(got[0]!.note!.length).toBeLessThanOrEqual(500);
    expect(got[0]!.note!.endsWith('界')).toBe(true); // 没劈字符
  });

  test('单行 ≤1KB: 巨大 writeSet 从尾部裁掉', () => {
    const root = freshRoot();
    appendBoard(
      root,
      entry('r1', 'claimed', { writeSet: Array.from({ length: 200 }, (_, i) => `/very/long/path/${i}/file-${i}.ts`) }),
    );
    const raw = readFileSync(boardFile(root), 'utf8');
    const line = raw.trim();
    expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(1024);
    const got = readBoard(root);
    expect(got[0]!.event).toBe('claimed');
    expect(got[0]!.runId).toBe('r1');
  });
});

describe('单行追加原子性(O_APPEND 单次写)', () => {
  test('多进程并发追加: 每行都是完整单条 JSON, 零坏行, 条数精确', async () => {
    const root = freshRoot();
    const script = join(root, 'atomic-appender.ts');
    writeFileSync(
      script,
      `import { appendBoard } from ${JSON.stringify(join(process.cwd(), 'src/harness/board/run-board.ts'))};\n` +
        `const root = process.env.BOARD_ROOT!;\n` +
        `for (let i = 0; i < 25; i++) {\n` +
        `  appendBoard(root, { v: 1, ts: new Date().toISOString(), runId: \`\${process.pid}-\${i}\`, event: 'claimed', writeSet: ['a.ts'] });\n` +
        `}\n`,
      'utf8',
    );
    const procs = await Promise.all(
      Array.from({ length: 4 }, () =>
        Bun.spawn([process.execPath, script], {
          env: { ...process.env, BOARD_ROOT: root },
          stdout: 'ignore',
          stderr: 'pipe',
        }),
      ),
    );
    await Promise.all(procs.map((p) => p.exited));
    for (const p of procs) expect(p.exitCode).toBe(0);

    const entries = readBoard(root);
    // 4 进程 × 25 条 = 100 条, 每条都是一个完整 JSON(撕行会变成坏行 → 出现 note 证据行)
    const badNotes = entries.filter((e) => e.runId === '__board__');
    expect(badNotes).toHaveLength(0);
    expect(entries).toHaveLength(100);
    // 每行都含完整 runId 尾缀(半行追加会丢尾缀)
    for (const e of entries) expect(e.runId).toMatch(/^\d+-\d+$/);
  });
});

describe('坏行容忍', () => {
  test('坏行跳过 + 留一行含坏行片段 的 note 证据', () => {
    const root = freshRoot();
    writeBoard(root, [
      JSON.stringify(entry('good', 'claimed', { writeSet: ['x.ts'] })),
      'this is not json {{{',
      JSON.stringify({ v: 2, runId: 'bad-schema', event: 'claimed' }), // v 不是 1
      JSON.stringify({ v: 1, ts: 'x', runId: 'bad-event', event: 'exploded' }), // 未知 event
      '',
    ]);
    const got = readBoard(root);
    const good = got.filter((e) => e.event !== 'note');
    expect(good).toHaveLength(1);
    expect(good[0]!.runId).toBe('good');
    const notes = got.filter((e) => e.event === 'note');
    expect(notes.length).toBeGreaterThanOrEqual(1); // 至少一行证据
    expect(notes.some((n) => n.note!.includes('this is not json'))).toBe(true); // 含坏行内容片段
  });

  test('板文件不存在 → 空板, 不抛', () => {
    expect(readBoard(freshRoot())).toHaveLength(0);
  });
});

describe('liveRuns(D-9)', () => {
  test('claimed 无对应 terminal → writeSet 映射; 有 terminal / 非 claimed 不进', () => {
    const entries: BoardEntry[] = [
      entry('r-live', 'claimed', { writeSet: ['a.ts', 'b.ts'] }),
      entry('r-done', 'claimed', { writeSet: ['c.ts'] }),
      entry('r-done', 'terminal', { outcome: 'ok' }),
      entry('r-pub', 'published', { writeSet: ['d.ts'] }),
      entry('r-note', 'note', { note: 'x' }),
    ];
    const live = liveRuns(entries);
    expect([...live.keys()]).toEqual(['r-live']);
    expect(live.get('r-live')).toEqual(['a.ts', 'b.ts']);
  });

  test('同一 run 多次 claimed → 最后一次 writeSet 胜出', () => {
    const live = liveRuns([
      entry('r1', 'claimed', { writeSet: ['old.ts'] }),
      entry('r1', 'claimed', { writeSet: ['new.ts'] }),
    ]);
    expect(live.get('r1')).toEqual(['new.ts']);
  });

  test('claimed 无 writeSet → 映射到空数组', () => {
    const live = liveRuns([entry('r1', 'claimed')]);
    expect(live.get('r1')).toEqual([]);
  });
});

describe('compact / G-4', () => {
  test('追加后顺手 compact: 已有 terminal 的 run 的全部条目被删, 活 run 原样', () => {
    const root = freshRoot();
    appendBoard(root, entry('r-live', 'claimed', { writeSet: ['a.ts'] }));
    appendBoard(root, entry('r-done', 'claimed', { writeSet: ['b.ts'] }));
    appendBoard(root, entry('r-done', 'terminal', { outcome: 'ok' }));
    const got = readBoard(root);
    expect(got.some((e) => e.runId === 'r-done')).toBe(false); // 终态 run 条目全删
    expect(got.some((e) => e.runId === 'r-live')).toBe(true);
  });

  test('坏行在 compact 重写中原样保留(写侧不吞证据)', () => {
    const root = freshRoot();
    writeBoard(root, [
      JSON.stringify(entry('r-done', 'claimed')),
      JSON.stringify(entry('r-done', 'terminal')),
      'garbage {{{',
    ]);
    appendBoard(root, entry('r-live', 'claimed', { writeSet: ['a.ts'] }));
    const got = readBoard(root);
    expect(got.some((e) => e.runId === 'r-done')).toBe(false);
    expect(got.some((e) => e.note?.includes('garbage'))).toBe(true); // 坏行证据仍在
  });

  /**
   * G-4(契约条款): board 超 1MB 且含终态条目 → compact 后 ≤1MB 且**所有活 run 条目仍在**。
   * G-5 证伪法(见文件头注释): 把 compact 反转为删活条目 → 本测试红 → 还原 → 绿。
   */
  test('G-4: 超 1MB 含终态 → compact 后 ≤1MB, 活 run 条目一个不丢', () => {
    const root = freshRoot();
    const live = [entry('r-live-1', 'claimed', { writeSet: ['a.ts'] }), entry('r-live-2', 'claimed', { writeSet: ['b.ts'] })];
    // 直接写盘构造超限板: 大量终态 run 的条目(每条约 300B) + 少数活条目
    const pad = 'x'.repeat(200);
    const lines: string[] = [];
    for (let i = 0; i < 4000; i++) {
      lines.push(JSON.stringify(entry(`r-done-${i}`, 'claimed', { writeSet: ['p.ts'], note: pad })));
      lines.push(JSON.stringify(entry(`r-done-${i}`, 'terminal', { outcome: 'ok' })));
    }
    lines.push(...live.map((e) => JSON.stringify(e)));
    writeBoard(root, lines);
    expect(statSync(boardFile(root)).size).toBeGreaterThan(1024 * 1024);

    appendBoard(root, entry('r-live-3', 'claimed', { writeSet: ['c.ts'] }));

    expect(statSync(boardFile(root)).size).toBeLessThanOrEqual(1024 * 1024); // compact 后 ≤1MB
    const got = readBoard(root);
    for (const l of live) {
      expect(got.some((e) => e.runId === l.runId && e.writeSet?.includes(l.writeSet![0]!))).toBe(true); // 活条目全在
    }
    expect(got.some((e) => e.runId === 'r-live-3')).toBe(true); // 新追加的也在
    expect(got.some((e) => e.runId.startsWith('r-done-'))).toBe(false); // 终态 run 全清
  });

  test('INV-2: 全活条目超 1MB → 一个活条目都不删, 留一行超限证据 note(fail-open)', () => {
    const root = freshRoot();
    const lines: string[] = [];
    for (let i = 0; i < 3500; i++) {
      lines.push(JSON.stringify(entry(`r-live-${i}`, 'claimed', { writeSet: ['p.ts'], note: 'y'.repeat(200) })));
    }
    writeBoard(root, lines);
    const before = readBoard(root);
    expect(before.length).toBe(3500);
    appendBoard(root, entry('r-extra', 'claimed', { writeSet: ['z.ts'] }));


    const got = readBoard(root);
    const liveEntries = got.filter((e) => e.event === 'claimed');
    expect(liveEntries.length).toBe(3501); // 3500 + 新追加, 一个没丢(INV-2)
    const overflowNote = got.find((e) => e.event === 'note' && e.note?.startsWith('run-board > 1MB after compact'));
    expect(overflowNote).toBeDefined(); // 留证据 note
    expect(overflowNote!.note).toContain('INV-2'); // 证据注明不删活条目的原因
    // 重复追加不刷屏: 第二次追加不新增第二条超限 note
    appendBoard(root, entry('r-extra-2', 'claimed', { writeSet: ['z2.ts'] }));
    const notes = readBoard(root).filter((e) => e.note?.startsWith('run-board > 1MB after compact'));
    expect(notes.length).toBe(1);
  });
});
