/**
 * ⑱ **可避免性率** 的可执行契约 (#160 发射片 · D-5)。
 *
 * 数据源 = `readBoard(boardRoot)` (run-board 既有读者, 坏行自留证据) —— 与 ⑨/⑫ 那个
 * outcome 分布**不同源**: 留痕库是永久, 公告板是 24h 保留期。`readout()` 的 opts
 * 加 `boardRoot`; 注入夹具不传 → `avoidability: null` (没有数据源); 传了 → 段照出。
 *
 * GWT 4 (3 terminal / 1 intervened): 率 = 1/3。
 * GWT 4b (板文件缺席): 段照出, 三数为 0, boardMissing=true (NULL≠0, 「板不存在」
 *   与「板存在但零介入」分得开)。
 * GWT 5 (intervened 属于无 terminal 的 runId): **不进分子** —— 分子 ⊆ 分母。
 *
 * 完成判据 (s3): `bun test src/harness/omd-readout-avoidability.test.ts` 退出码 0。
 *
 * 零新依赖 (bun:test + 仓内 readBoard / appendBoard / readout)。boardRoot = 临时目录
 * 下的 mkdtemp 根, 用完 rm —— 与 ⑯/⑰ 那几段同款夹具 (omd-readout.test.ts:490-527)。
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendBoard, type BoardEntry } from './board/run-board';
import { readout } from '../../scripts/omd-readout';

const dirs: string[] = [];
const freshRoot = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'omd-readout-av-'));
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

/**
 * 让 `readout()` 跑通「有 boardRoot、db 是空 :memory:」这条路径的最简夹具。
 * 不需要真留痕数据 —— avoidability 的全部数据源在板, 不在 db; 用空 :memory:
 * 触发 emptyWorld 那条早退, 但 avoidability 段在 emptyWorld 里照常算出。
 */
const readoutAvoid = (boardRoot: string | null) =>
  readout({ db: new Database(':memory:'), boardRoot }).avoidability;

describe('omd-readout · ⑱ avoidability · ⑱ 数据源/窗口纪律', () => {
  test('没给 boardRoot → 整段 null (没有数据源, 不是零介入)', () => {
    // 注入夹具的默认形状 —— 与 omd-readout.test.ts 既有的 1800+ 用例保持一致,
    // 它们**绝不**会因为加了这一段而改行为。
    expect(readout({ db: new Database(':memory:') }).avoidability).toBeNull();
  });
});

describe('omd-readout · ⑱ avoidability · GWT 4 (完结 run × 介入) ', () => {
  test('3 terminal / 1 intervened → denominator 3 / numerator 1 / rate 1/3; boardMissing=false', () => {
    const root = freshRoot();
    appendBoard(root, entry('r1', 'claimed', { writeSet: ['a.ts'] }));
    appendBoard(root, entry('r1', 'terminal'));
    appendBoard(root, entry('r2', 'claimed', { writeSet: ['b.ts'] }));
    appendBoard(root, entry('r2', 'terminal'));
    appendBoard(root, entry('r3', 'claimed', { writeSet: ['c.ts'] }));
    appendBoard(root, entry('r3', 'terminal'));
    // 3 个完结 run, 唯一一个被人工介入
    appendBoard(root, entry('r2', 'intervened', { cause: 'empty-artifact' }));
    expect(readoutAvoid(root)).toEqual({
      denominator: 3,
      numerator: 1,
      rate: 1 / 3,
      boardMissing: false,
    });
  });

  test('3 terminal / 0 intervened → denominator 3 / numerator 0 / rate 0; 与「板缺席」分得开', () => {
    const root = freshRoot();
    for (const r of ['r1', 'r2', 'r3']) {
      appendBoard(root, entry(r, 'claimed', { writeSet: [`${r}.ts`] }));
      appendBoard(root, entry(r, 'terminal'));
    }
    const got = readoutAvoid(root);
    expect(got).toEqual({ denominator: 3, numerator: 0, rate: 0, boardMissing: false });
    // ⚠ 关键的 NULL≠0 纪律: rate=0 与「板文件缺席」必须长得**不一样**, 否则下游会
    // 把「还没记过任何一次」读成「跑了很多次一次都没介入」—— 那是 S-19 那一族。
    const missing = readoutAvoid(freshRoot());
    expect(missing).toEqual({ denominator: 0, numerator: 0, rate: null, boardMissing: true });
    expect(got).not.toEqual(missing);
  });
});

describe('omd-readout · ⑱ avoidability · GWT 4b (板文件缺席) ', () => {
  test('freshRoot 内无板 → 段照出, 三数 0, rate=null, boardMissing=true', () => {
    // 没 appendBoard, 也没让任何代码触过 `<root>/.omd/run-board.jsonl`。
    // 「板不存在」与「板存在但零介入」**可分辨**: 前者 boardMissing=true 且 rate=null;
    // 后者 boardMissing=false 且 rate=0 (见上一组用例)。
    expect(readoutAvoid(freshRoot())).toEqual({
      denominator: 0,
      numerator: 0,
      rate: null,
      boardMissing: true,
    });
  });
});

describe('omd-readout · ⑱ avoidability · GWT 5 (分子 ⊆ 分母) ', () => {
  test('intervened 属于无 terminal 的 runId → 不进分子', () => {
    const root = freshRoot();
    // 2 个完结 run (r1, r2) —— 这才是分母
    appendBoard(root, entry('r1', 'claimed', { writeSet: ['a.ts'] }));
    appendBoard(root, entry('r1', 'terminal'));
    appendBoard(root, entry('r2', 'claimed', { writeSet: ['b.ts'] }));
    appendBoard(root, entry('r2', 'terminal'));
    // r3 还没收尾 (在跑 / 孤儿): 介入已记, 但**没有** terminal —— 不进分子
    appendBoard(root, entry('r3', 'claimed', { writeSet: ['c.ts'] }));
    appendBoard(root, entry('r3', 'intervened', { cause: 'gate-rejected' }));
    expect(readoutAvoid(root)).toEqual({
      denominator: 2,
      numerator: 0,
      rate: 0,
      boardMissing: false,
    });
  });

  test('同一 runId 多条 intervened → 仍只计 1 (distinct runId, 不按行数)', () => {
    // 留痕层同样按 runId 归并 (omd-readout.test.ts:177-200 那条纪律), 这一面也按
    // runId 去重: 同 run 三次介入 + 一次 terminal = 分子 1, 不是 3。
    const root = freshRoot();
    appendBoard(root, entry('r1', 'claimed', { writeSet: ['a.ts'] }));
    appendBoard(root, entry('r1', 'terminal'));
    appendBoard(root, entry('r1', 'intervened', { cause: 'empty-artifact' }));
    appendBoard(root, entry('r1', 'intervened', { cause: 'assert-failed' }));
    appendBoard(root, entry('r1', 'intervened', { cause: 'gate-rejected' }));
    expect(readoutAvoid(root)).toEqual({
      denominator: 1,
      numerator: 1,
      rate: 1,
      boardMissing: false,
    });
  });
});
