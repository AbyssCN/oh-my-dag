/**
 * run-board 观察面 (#96) —— 渲染零写 + 三条语义。
 *
 * 这条网钉的是**那一跳**: 公告板的写侧与判定侧早就齐了 (`appendBoard` 五个生产调用方,
 * `liveRuns` 的 D-9 语义有闸), 缺的只是把它画出来 —— 盘上有数据、没人看得见, 本仓管这个
 * 形态叫空旋钮。所以这里的断言都盯**渲染有没有如实转述判定**, 不重测 `liveRuns` 自己。
 */
import { describe, expect, test } from 'bun:test';
import { TruncatedText } from '@earendil-works/pi-tui';
import { renderRunBoard, RUN_MARK } from './run-board';
import type { BoardEntry } from '../../harness/board/run-board';

const NOW = Date.parse('2026-08-19T00:10:00Z');
const e = (o: Partial<BoardEntry> & Pick<BoardEntry, 'runId' | 'event'>): BoardEntry =>
  ({ v: 1, ts: '2026-08-19T00:00:00Z', ...o }) as BoardEntry;

describe('#96 renderRunBoard —— 纯读零写的活 run 观察面', () => {
  test('空板 / 只有已终态的 run → `[]` (无源恒缺席, 不画空框)', () => {
    expect(renderRunBoard([], NOW)).toEqual([]);
    const done = [e({ runId: 'r1', event: 'claimed', writeSet: ['a.ts'] }), e({ runId: 'r1', event: 'terminal' })];
    // ★ 反向自检 (已实测会红): 把 liveRuns 换成"所有 claimed" (不减 terminal) → 这条红。
    expect(renderRunBoard(done, NOW)).toEqual([]);
  });

  test('活 run → 画 runId + 已跑时长 + 写集; 表头报活/产出两个计数', () => {
    const entries = [e({ runId: 'r1', event: 'claimed', writeSet: ['src/a.ts', 'src/b.ts'] })];
    const out = renderRunBoard(entries, NOW);
    expect(out[0]).toBe('run board · 1 活 · 0 产出');
    expect(out[1]).toBe(`${RUN_MARK.live} r1 10m · src/a.ts src/b.ts`);
  });

  test('写集超上限只报条数 (一个 run 声明 40 个文件不该吃掉整个侧栏)', () => {
    const entries = [e({ runId: 'r1', event: 'claimed', writeSet: ['a', 'b', 'c', 'd', 'e'] })];
    expect(renderRunBoard(entries, NOW, { maxWriteSet: 2 })[1]).toBe(`${RUN_MARK.live} r1 10m · a b +3`);
  });

  /**
   * NULL≠0 那条: **写集空**与**没声明写集**在盘上是同一个 `[]`(BoardEntry.writeSet 可缺席),
   * 但读的人要的是"这个 run 没说它要写哪儿" —— 画成空白会被读成"它不写盘"。
   */
  test('无写集 → 明写「未声明写集」, 不留空白', () => {
    expect(renderRunBoard([e({ runId: 'r1', event: 'claimed' })], NOW)[1]).toBe(`${RUN_MARK.live} r1 10m · (未声明写集)`);
  });

  /**
   * 时长缺席不许编 0: `claimed` 拿不到时刻 (老行 / 坏行) 时画 "0s" 会被读成"刚起跑",
   * 而真相是"没记"。缺就不画那一段。
   */
  test('拿不到 claimed 时刻 → 不画时长 (不编 0s)', () => {
    const entries = [e({ runId: 'r1', event: 'published', artifact: 'x' }), e({ runId: 'r2', event: 'claimed', writeSet: ['a'] })];
    // r2 有 ts → 有时长; 把 ts 抹掉那条走下面这行。
    const noTs = [{ v: 1, runId: 'r3', event: 'claimed', writeSet: ['a'] } as unknown as BoardEntry];
    expect(renderRunBoard(noTs, NOW)[1]).toBe(`${RUN_MARK.live} r3 · a`);
    expect(renderRunBoard(entries, NOW).some((l) => l.startsWith(`${RUN_MARK.live} r2 10m`))).toBe(true);
  });

  /**
   * **产物一旦发布就对下游有效, 哪怕产它的 run 已终态** —— 这正是 await-node 的语义
   * (它匹配 published.artifact, 不问那个 run 死没死)。把 published 过滤成"只画活 run 的"
   * 会让下游等一份明明已经在盘上的产物。
   */
  test('★ published 不随产它的 run 终态消失 (await-node 的语义, 别把它过滤掉)', () => {
    const entries = [
      e({ runId: 'r1', event: 'claimed', writeSet: ['a'] }),
      e({ runId: 'r1', event: 'published', artifact: 'sdd.md' }),
      e({ runId: 'r1', event: 'terminal' }),
    ];
    const out = renderRunBoard(entries, NOW);
    // ★ 反向自检 (已实测会红): 把 published 过滤成 `live.has(e.runId)` → 这条红, 且红的方式
    //   正是它防的那件事 —— 下游会以为产物不在。
    expect(out[0]).toBe('run board · 0 活 · 1 产出');
    expect(out[1]).toBe(`${RUN_MARK.published} sdd.md · r1`);
  });

  /**
   * 列宽治理必须走 pi-tui `TruncatedText`, **不许手工 `slice`**: `slice` 按 code unit 切,
   * 而全角字符占**两列** —— 切出来的行按列算是超宽的, 在真终端里会折行把看板拱变形。
   *
   * 断言方式: 拿 `TruncatedText` 自己算一遍当期望值。这不是重言式 —— 换成
   * `l.slice(0, width)` 时两者对全角文本给出**不同的串**, 这条当场红。
   * (⚠ 别断言 `l.length <= width`: `length` 数的是字符不是列, 第一版这么写就红错了地方。)
   */
  test('列宽治理走 TruncatedText (不手工 slice —— 全角按列占两格)', () => {
    const entries = [e({ runId: '很长很长的运行编号很长很长', event: 'claimed', writeSet: ['源文件/甲.ts'] })];
    const wide = renderRunBoard(entries, NOW);
    const narrow = renderRunBoard(entries, NOW, { width: 20 });
    expect(narrow).toEqual(wide.map((l) => new TruncatedText(l).render(20)[0]!));
    // 真的收窄了 (否则上面那条在"没收"时也成立)。
    expect(narrow.some((l, i) => l !== wide[i])).toBe(true);
  });

  test('★ 渲染零写: 入参数组本身不被改动 (观察面一旦写盘就成了参与者)', () => {
    const entries = [e({ runId: 'r1', event: 'claimed', writeSet: ['a'] }), e({ runId: 'r1', event: 'published', artifact: 'x' })];
    const before = JSON.stringify(entries);
    renderRunBoard(entries, NOW);
    expect(JSON.stringify(entries)).toBe(before);
  });
});
