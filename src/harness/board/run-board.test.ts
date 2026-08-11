/**
 * run-board 测试(G-4/G-5 契约条款, 不是可选项)。
 *
 * ## G-4(2026-08-11 修订语义): compact 只删**已超保留期**的终态 run 条目
 * - 保留期默认 24h, 自 terminal 条目的 ts 起算; 丢弃必留证据行(fail-open 不吞证据)。
 * - 保留期内(刚写 terminal)的 run: claimed/published/terminal 条目 compact 后仍可读
 *   —— 它们是 await 谓词的满足/中止信号(G-2/G-3), 删了 await 方下一拍 poll 什么都看不见,
 *   只能傻等超时(D-5 竞态教训: run 7d50fda2)。
 * - 超 1MB 强制 compact: 后 ≤1MB 且所有活 run 条目仍在; 删超期后仍超 → 保留期对半, 直到满足。
 *
 * ## G-5 反向自检(证伪方式, 契约条款)
 * 证伪: 把 `run-board.ts` 的 `compactBoard` 保留期判定反转为「保留期内也删」
 * (例如把 `age > retention` 改成 `age >= 0`, 即修订前的「终态即清」), 跑本文件:
 * `bun test src/harness/board/run-board.test.ts`
 * → **G-4 那条(「保留期内 terminal/published 条目仍可读」)必须变红**(刚终态的 run 被删)。
 * 还原后再跑 → 全绿。
 * (变异亦可做成「活 run 条目也删」: stale 集合并入非终态 runId → 上面的 G-4 断言红(活 run 被删),
 *   还原后绿; 全活条目板(无终态 run)下该变异不触发删除块, 此时 INV-2 那条断言直接守住
 *   「一个活条目都不删」—— 任何真删活条目的实现都会让 INV-2 的长度/逐个在场断言变红。)
 *
 * 当前实装已是保留期 TTL(见 D-5 修订记录): 只删超保留期终态 run, 保留期内条目与活 run 不动,
 * 本文件 G-4 断言全绿 —— 上述变异还原法保证契约仍被证伪覆盖, 不退回「终态即清」。
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

/** G-4 保留期契约值: 默认 24h, 自 terminal 条目 ts 起算。 */
const RETENTION_MS = 24 * 60 * 60 * 1000;
const tsAgo = (ms: number): string => new Date(Date.now() - ms).toISOString();

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
  test('追加后顺手 compact: 刚写 terminal(保留期内)的 run 条目仍可读, 活 run 原样', () => {
    const root = freshRoot();
    appendBoard(root, entry('r-live', 'claimed', { writeSet: ['a.ts'] }));
    appendBoard(root, entry('r-done', 'claimed', { writeSet: ['b.ts'] }));
    appendBoard(root, entry('r-done', 'terminal', { outcome: 'ok' }));
    const got = readBoard(root);
    // G-4 修订语义: terminal 刚写入、未超 24h 保留期 → compact 不删(claimed/terminal 都在)
    expect(got.some((e) => e.runId === 'r-done' && e.event === 'claimed')).toBe(true);
    expect(got.some((e) => e.runId === 'r-done' && e.event === 'terminal')).toBe(true);
    expect(got.some((e) => e.runId === 'r-live')).toBe(true);
  });

  test('坏行在 compact 重写中原样保留(写侧不吞证据)', () => {
    const root = freshRoot();
    writeBoard(root, [
      JSON.stringify(entry('r-done', 'claimed', { ts: tsAgo(2 * RETENTION_MS) })), // 已超保留期 → compact 触发重写
      JSON.stringify(entry('r-done', 'terminal', { ts: tsAgo(2 * RETENTION_MS) })),
      'garbage {{{',
    ]);
    appendBoard(root, entry('r-live', 'claimed', { writeSet: ['a.ts'] }));
    const got = readBoard(root);
    expect(got.some((e) => e.runId === 'r-done')).toBe(false); // 超保留期终态条目被删
    expect(got.some((e) => e.note?.includes('garbage'))).toBe(true); // 坏行证据仍在
  });

  /**
   * G-4(契约条款, 2026-08-11 修订): board 超 1MB 且含**超保留期**终态条目 → compact 后 ≤1MB
   * 且所有活 run 条目仍在; 保留期内(刚写 terminal)的 run 其 terminal/published 仍可读
   * (G-2/G-3 满足/中止信号, 竞态回归点); 丢弃必留证据行。
   * G-5 证伪法(见文件头注释): 把保留期判定反转为「保留期内也删」→ 本测试红 → 还原 → 绿。
   */
  test('G-4: 超 1MB 强制 compact → ≤1MB, 活 run 全在, 保留期内 terminal/published 仍可读, 丢弃留证据行', () => {
    const root = freshRoot();
    const live = [entry('r-live-1', 'claimed', { writeSet: ['a.ts'] }), entry('r-live-2', 'claimed', { writeSet: ['b.ts'] })];
    // 直接写盘构造超限板: 大量**已超保留期**(48h 前)的终态 run(每条约 300B) + 少数活条目
    const pad = 'x'.repeat(200);
    const lines: string[] = [];
    for (let i = 0; i < 4000; i++) {
      lines.push(JSON.stringify(entry(`r-old-${i}`, 'claimed', { ts: tsAgo(2 * RETENTION_MS), writeSet: ['p.ts'], note: pad })));
      lines.push(JSON.stringify(entry(`r-old-${i}`, 'terminal', { ts: tsAgo(2 * RETENTION_MS), outcome: 'ok' })));
    }
    // 保留期内的终态 run: 刚写 terminal → G-2/G-3 的满足/中止信号, compact 后必须仍可读
    lines.push(JSON.stringify(entry('r-fresh', 'published', { artifact: 'out.zip' })));
    lines.push(JSON.stringify(entry('r-fresh', 'terminal', { outcome: 'ok' })));
    lines.push(...live.map((e) => JSON.stringify(e)));
    writeBoard(root, lines);
    expect(statSync(boardFile(root)).size).toBeGreaterThan(1024 * 1024);

    appendBoard(root, entry('r-live-3', 'claimed', { writeSet: ['c.ts'] })); // 触发强制 compact

    expect(statSync(boardFile(root)).size).toBeLessThanOrEqual(1024 * 1024); // compact 后 ≤1MB
    const got = readBoard(root);
    for (const l of live) {
      expect(got.some((e) => e.runId === l.runId && e.writeSet?.includes(l.writeSet![0]!))).toBe(true); // 活条目全在
    }
    expect(got.some((e) => e.runId === 'r-live-3')).toBe(true); // 新追加的也在
    expect(got.some((e) => e.runId.startsWith('r-old-'))).toBe(false); // 超保留期终态条目被删
    expect(got.some((e) => e.runId === 'r-fresh' && e.event === 'published')).toBe(true); // 保留期内 published 仍可读(G-2 满足信号)
    expect(got.some((e) => e.runId === 'r-fresh' && e.event === 'terminal')).toBe(true); // 保留期内 terminal 仍可读(G-3 中止信号)
    const discardNote = got.find((e) => e.event === 'note' && e.note?.startsWith('run-board compact dropped'));
    expect(discardNote).toBeDefined(); // 丢弃必留证据行(不吞证据)
  });

  test('G-4 续: 删超期后仍超 1MB → 保留期对半, 最终 ≤1MB 且活 run/保留期内终态仍在', () => {
    const root = freshRoot();
    // 13h 前: 24h 保留期下未超期 → 第一轮无可删; 对半(12h)后超期 → 逼出「仍超则保留期对半」
    const midTs = tsAgo(RETENTION_MS / 2 + 60 * 60 * 1000);
    const lines: string[] = [];
    for (let i = 0; i < 4000; i++) {
      lines.push(JSON.stringify(entry(`r-mid-${i}`, 'claimed', { ts: midTs, writeSet: ['p.ts'], note: 'y'.repeat(200) })));
      lines.push(JSON.stringify(entry(`r-mid-${i}`, 'terminal', { ts: midTs, outcome: 'ok' })));
    }
    lines.push(JSON.stringify(entry('r-fresh', 'published', { artifact: 'out.zip' })));
    lines.push(JSON.stringify(entry('r-fresh', 'terminal', { outcome: 'ok' })));
    lines.push(JSON.stringify(entry('r-live', 'claimed', { writeSet: ['a.ts'] })));
    writeBoard(root, lines);
    expect(statSync(boardFile(root)).size).toBeGreaterThan(1024 * 1024);

    appendBoard(root, entry('r-live-2', 'claimed', { writeSet: ['b.ts'] })); // 触发强制 compact

    expect(statSync(boardFile(root)).size).toBeLessThanOrEqual(1024 * 1024); // 保留期对半后最终 ≤1MB
    const got = readBoard(root);
    expect(got.some((e) => e.runId === 'r-live')).toBe(true); // 活 run 全在
    expect(got.some((e) => e.runId === 'r-live-2')).toBe(true);
    expect(got.some((e) => e.runId === 'r-fresh' && e.event === 'published')).toBe(true); // 保留期内 published 仍可读
    expect(got.some((e) => e.runId === 'r-fresh' && e.event === 'terminal')).toBe(true); // 保留期内 terminal 仍可读
    expect(got.some((e) => e.runId.startsWith('r-mid-'))).toBe(false); // 保留期对半后超期 → 被删
    const discardNote = got.find((e) => e.event === 'note' && e.note?.startsWith('run-board compact dropped'));
    expect(discardNote).toBeDefined(); // 丢弃必留证据行
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
    // INV-2 变异敏感锚点(G-5 证伪): 若 compact 把 stale 集合并入活 runId(「活条目也删」变异),
    // 下面两个断言必须红 —— 活条目是契约禁删对象, 删了即违约, 不许静默通过。
    expect(liveEntries.length).toBe(3501); // 3500 + 新追加, 一个没丢(INV-2)
    const liveIds = new Set(liveEntries.map((e) => e.runId));
    for (let i = 0; i < 3500; i++) expect(liveIds.has(`r-live-${i}`)).toBe(true); // 原 3500 条逐个在
    expect(liveIds.has('r-extra')).toBe(true); // 新追加的活条目也在
    const overflowNote = got.find((e) => e.event === 'note' && e.note?.startsWith('run-board > 1MB after compact'));
    expect(overflowNote).toBeDefined(); // 留证据 note
    expect(overflowNote!.note).toContain('INV-2'); // 证据注明不删活条目的原因
    // 重复追加不刷屏: 第二次追加不新增第二条超限 note
    appendBoard(root, entry('r-extra-2', 'claimed', { writeSet: ['z2.ts'] }));
    const notes = readBoard(root).filter((e) => e.note?.startsWith('run-board > 1MB after compact'));
    expect(notes.length).toBe(1);
  });
});
