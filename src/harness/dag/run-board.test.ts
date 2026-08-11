/**
 * 判卷载体 (冻结): run-board 管线 (S1 board + S2 preflight + S3 await) 的集成判据。
 * 外部判据: `bun test src/harness/dag/run-board.test.ts` → exit 0。
 *
 * 覆盖:
 * - G-1  ignitionPreflight: 活 run 写集相交 → blocked + overlap; force → ok 且板上留越闸 note
 *        (note 是证据不是通行证 —— 后续无 force 预检仍 blocked); 冲突 run 落 terminal → 冲突消失。
 * - G-2/G-3  await 谓词与中止: 谓词真源 = 板 (claimed 无 terminal = 活); 注入短 poll/deadline
 *        的等待循环按契约收敛 ('done' | 'aborted'); **中止 ≠ 终态** (abort 后 run 仍活, 板无伪造
 *        terminal, 写面仍被 preflight 挡)。
 * - G-4  compact: >1MB 含终态 → 追加后 ≤1MB, 活 run 条目全在; 且活 run 的写面证据在 compact
 *        后仍被 preflight 看见 (G-1 与 G-4 闭环)。
 *
 * ⚠ S3 缺口: src/harness/dag/await-node.ts 未落盘 (前驱切片 infra 失败, 429 弃置), 本文件把
 * await 契约冻结在**数据层** (谓词真源 = readBoard/liveRuns; 中止 = 注入 deadline, 单元级, 不等 3h)。
 * `waitForRunOnBoard` 是契约脚手架: await-node.ts 落盘后换成其真实 API, 断言不变。
 * G-5 变异证伪 (compact 反转为删活条目 → 本族测试红) 由 src/harness/board/run-board.test.ts 的
 * G-4 条款承担, 本文件不重做。
 *
 * 全程零网络、零 LLM (INV-6): 纯本地 tempdir + 板文件 IO, 确定性 (timer 裕度 ≫ poll 间隔)。
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { appendBoard, BOARD_RUN_ID, liveRuns, readBoard, type BoardEntry } from '../board/run-board';
import { ignitionPreflight } from '../goal/ignition-preflight';

const dirs: string[] = [];
const freshRoot = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'omd-dag-run-board-'));
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

/** 直接写板文件 (绕过 appendBoard 构造超限板): 父目录先建好。 */
const writeBoard = (root: string, lines: string[]): void => {
  mkdirSync(dirname(boardFile(root)), { recursive: true });
  writeFileSync(boardFile(root), lines.join('\n') + '\n', 'utf8');
};

/**
 * await 契约脚手架 (S3 await-node.ts 未落盘, 见文件头 ⚠):
 * 谓词 = 板上该 run 不再活 (claimed 无 terminal → 活); poll/deadline 可注入, 单元级, 不等 3h。
 * 返回收敛状态 + abort 时刻的活 run 快照 (中止 ≠ 终态 的判据)。
 */
const waitForRunOnBoard = async (
  root: string,
  runId: string,
  opts: { pollMs: number; deadlineMs: number },
): Promise<{ status: 'done' | 'aborted'; live: string[] }> => {
  const deadline = Date.now() + opts.deadlineMs;
  for (;;) {
    const live = [...liveRuns(readBoard(root)).keys()];
    if (!live.includes(runId)) return { status: 'done', live };
    if (Date.now() >= deadline) return { status: 'aborted', live };
    await Bun.sleep(opts.pollMs); // async 让外部 timer (terminal 落板) 有机会触发
  }
};

describe('G-1: ignitionPreflight (blocked + overlap + force 留账)', () => {
  test('活 run 写集相交 → blocked 且 conflicts 带精确 overlap', () => {
    const root = freshRoot();
    appendBoard(root, entry('r1', 'claimed', { writeSet: ['src/a.ts', 'src/shared.ts'] }));
    const rep = ignitionPreflight(root, ['src/shared.ts', 'src/b.ts']);
    expect(rep.verdict).toBe('blocked');
    expect(rep.conflicts).toEqual([{ runId: 'r1', overlap: ['src/shared.ts'] }]);
  });

  test('force → ok + 越闸 note 落板; note 是证据不是通行证', () => {
    const root = freshRoot();
    appendBoard(root, entry('r1', 'claimed', { writeSet: ['src/a.ts'] }));
    const rep = ignitionPreflight(root, ['src/a.ts'], { force: true });
    expect(rep.verdict).toBe('ok');
    const notes = readBoard(root).filter((e) => e.event === 'note' && e.runId === BOARD_RUN_ID);
    expect(notes).toHaveLength(1);
    expect(notes[0]!.note).toContain('r1');
    expect(notes[0]!.note).toContain('src/a.ts');
    // note 是证据不改判: r1 仍活, 无 force 再预检 → 仍 blocked, 且 note 不产生伪冲突
    const rep2 = ignitionPreflight(root, ['src/a.ts']);
    expect(rep2.verdict).toBe('blocked');
    expect(rep2.conflicts).toEqual([{ runId: 'r1', overlap: ['src/a.ts'] }]);
  });

  test('G-1→G-2 闭环: 冲突 run 落 terminal → 冲突消失, 预检转 ok', () => {
    const root = freshRoot();
    appendBoard(root, entry('r1', 'claimed', { writeSet: ['src/a.ts'] }));
    expect(ignitionPreflight(root, ['src/a.ts']).verdict).toBe('blocked');
    appendBoard(root, entry('r1', 'terminal', { outcome: 'ok' }));
    const rep = ignitionPreflight(root, ['src/a.ts']);
    expect(rep.verdict).toBe('ok');
    expect(rep.conflicts).toEqual([]);
  });
});

describe('G-2/G-3: await 谓词与中止 (数据层冻结, await-node.ts 未落盘)', () => {
  test('G-2 谓词: claimed 无 terminal = 活; terminal 落板 → 谓词翻转, 条目被顺手 compact 归档', () => {
    const root = freshRoot();
    appendBoard(root, entry('r1', 'claimed', { writeSet: ['src/a.ts'] }));
    expect(liveRuns(readBoard(root)).has('r1')).toBe(true); // 谓词真: 活
    appendBoard(root, entry('r1', 'terminal', { outcome: 'ok' }));
    expect(liveRuns(readBoard(root)).has('r1')).toBe(false); // 谓词翻: 终态
    // 终态 run 全部条目 (含 claimed) 已被 compact 归档 —— 板面只留活 run
    expect(readBoard(root).some((e) => e.runId === 'r1')).toBe(false);
  });

  test('G-3 done: 注入短 poll, terminal 落板后等待收敛 done, 板证据在', async () => {
    const root = freshRoot();
    appendBoard(root, entry('r1', 'claimed', { writeSet: ['src/a.ts'] }));
    const t = setTimeout(() => appendBoard(root, entry('r1', 'terminal', { outcome: 'ok' })), 30);
    try {
      const res = await waitForRunOnBoard(root, 'r1', { pollMs: 5, deadlineMs: 2000 });
      expect(res.status).toBe('done'); // 30ms ≪ 2000ms 裕度 → 必收敛 done, 无竞态
      expect(res.live).not.toContain('r1');
    } finally {
      clearTimeout(t);
    }
  });

  test('G-3 abort: 注入 deadline, run 不落终态 → aborted; 中止 ≠ 终态, 短 deadline 被尊重', async () => {
    const root = freshRoot();
    appendBoard(root, entry('r1', 'claimed', { writeSet: ['src/a.ts'] }));
    const t0 = Date.now();
    const res = await waitForRunOnBoard(root, 'r1', { pollMs: 5, deadlineMs: 60 });
    const elapsed = Date.now() - t0;
    expect(res.status).toBe('aborted');
    expect(res.live).toContain('r1'); // 中止 ≠ 终态: run 仍活
    expect(readBoard(root).some((e) => e.runId === 'r1' && e.event === 'terminal')).toBe(false); // 无伪造 terminal
    expect(elapsed).toBeLessThan(1000); // 注入的短 deadline 被尊重, 不是 3h
    // 闭环: abort 后写面仍在 → 无 force 预检仍 blocked
    expect(ignitionPreflight(root, ['src/a.ts']).verdict).toBe('blocked');
  });
});

describe('G-4: compact ≤1MB 且活条目仍在', () => {
  test('超 1MB 含终态 → 追加后 ≤1MB, 活 run 条目全在; 写面证据 compact 后仍被 preflight 看见', () => {
    const root = freshRoot();
    const live = [
      entry('r-live-1', 'claimed', { writeSet: ['src/a.ts'] }),
      entry('r-live-2', 'claimed', { writeSet: ['src/b.ts'] }),
    ];
    const pad = 'x'.repeat(200);
    const lines: string[] = [];
    for (let i = 0; i < 4000; i++) {
      lines.push(JSON.stringify(entry(`r-done-${i}`, 'claimed', { writeSet: ['p.ts'], note: pad })));
      lines.push(JSON.stringify(entry(`r-done-${i}`, 'terminal', { outcome: 'ok' })));
    }
    lines.push(...live.map((e) => JSON.stringify(e)));
    writeBoard(root, lines);
    expect(statSync(boardFile(root)).size).toBeGreaterThan(1024 * 1024);

    appendBoard(root, entry('r-live-3', 'claimed', { writeSet: ['src/c.ts'] }));

    expect(statSync(boardFile(root)).size).toBeLessThanOrEqual(1024 * 1024); // compact 后 ≤1MB
    const got = readBoard(root);
    for (const l of live) {
      expect(got.some((e) => e.runId === l.runId && e.writeSet?.includes(l.writeSet![0]!))).toBe(true); // 活条目全在
    }
    expect(got.some((e) => e.runId === 'r-live-3')).toBe(true); // 新追加的也在
    expect(got.some((e) => e.runId.startsWith('r-done-'))).toBe(false); // 终态 run 全清
    // G-1 ↔ G-4 闭环: compact 没丢活 run 的写面证据 → preflight 仍能挡冲突
    expect(ignitionPreflight(root, ['src/a.ts']).verdict).toBe('blocked');
  });
});
