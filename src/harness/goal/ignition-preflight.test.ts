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

describe('ignitionPreflight 票源注入面 (D-1 ticket-source)', () => {
  test('票上已注 writeSet → crystallized advisory 按票读, 扫描依赖零调用', () => {
    const root = freshRoot();
    // 关键: 在磁盘上铺一条会与 ticket.writeSet 相交的结晶 SDD —— 今日若隐式触发扫描,
    // 这条会从 docs/plan 里爬出来, 进 advisories, 把本测试当场变红。
    writeSdd(root, 'disk-only-sdd.md', ['1 写 disk | src/a.ts | — | bun test src/a.test.ts']);
    let scanCalls = 0;
    // 注入面: 可选扫描依赖 (criterion_design 注入点 #2) —— 替身不读磁盘, 返空。
    const crystallizedProvider = (_root: string) => {
      scanCalls++;
      return [];
    };
    // 注入面: 传入的票源 (criterion_design 注入点 #1) —— 票上已写 writeSet。
    const ticket = { writeSet: ['src/a.ts', 'src/b.ts'] };
    const rep = ignitionPreflight(root, ticket.writeSet, {
      crystallizedProvider,
      ticketSource: ticket,
    });
    // 票上已有 writeSet → 不应触发 docs/plan 扫描 (注入扫描依赖零调用)。
    expect(scanCalls).toBe(0);
    // 关键判据: 若隐式回退到默认 crystallizedSdds (即隐式扫描磁盘), 上面铺的
    // docs/plan/disk-only-sdd.md 必然进 advisories —— 断言为空即是「确认未扫磁盘」。
    expect(rep.advisories).toEqual([]);
    // verdict/conflicts 不变 (注入面只影响 crystallized advisory 来源)。
    expect(rep.verdict).toBe('ok');
    expect(rep.conflicts).toEqual([]);
  });

  test('票缺席 (ticket 缺省) → 回落目录扫描, fail-open 不抛', () => {
    const root = freshRoot();
    let scanCalls = 0;
    const crystallizedProvider = (_root: string) => {
      scanCalls++;
      return []; // 与 myWriteSet 不交 → 无 advisory, 但调用本身仍要被断言。
    };
    const rep = ignitionPreflight(root, ['src/a.ts'], {
      crystallizedProvider,
      // ticket 缺省 = 走扫描 (fail-open)。
    });
    // 票缺席 → 扫描依赖应被调用。
    expect(scanCalls).toBeGreaterThanOrEqual(1);
    expect(rep.verdict).toBe('ok');
    expect(rep.conflicts).toEqual([]);
    // 板上无活 run → advisories 为空 (只是确认未崩)。
    expect(rep.advisories).toEqual([]);
  });
  test('票注 writeSet: [] (显式空数组, 字段在场但空) → 扫描依赖零调用, advisory 空', () => {
    const root = freshRoot();
    // 关键: 在磁盘铺一条写集会与本 run 相交的 SDD —— 若隐式回退扫描, 会进 advisories 翻红。
    writeSdd(root, 'disk-only-sdd.md', ['1 写 disk | src/a.ts | — | bun test src/a.test.ts']);
    let scanCalls = 0;
    const crystallizedProvider = (_root: string) => {
      scanCalls++;
      return [];
    };
    // 字段在场但为空数组 —— 重点是 !== undefined, 不是 truthiness。
    const ticket = { writeSet: [] as string[] };
    const rep = ignitionPreflight(root, ['src/a.ts'], {
      crystallizedProvider,
      ticketSource: ticket,
    });
    // 字段在场 (即便空) → 不应触发 docs/plan 扫描 (D-1: 字段在场优先, 不看值)。
    expect(scanCalls).toBe(0);
    // 空 union 自身不与任何东西相交 → advisory 空。双重证据: 即使忽略字段在场判据,
    // 磁盘候选 SDD 也会因 scanCalls === 0 而无机会被读到, 故 advisories 必空。
    expect(rep.advisories).toEqual([]);
    expect(rep.verdict).toBe('ok');
    expect(rep.conflicts).toEqual([]);
  });

  test('票源写集与本 run 写集部分相交 → advisory 标 "(ticket)" 源, 扫描依赖零调用', () => {
    const root = freshRoot();
    let scanCalls = 0;
    // 注入的扫描依赖返一条写集「绝不与本 run 相交」的 SDD —— 即使被错误调用,
    // 它也产不出 advisory; 但若 ticket 源被正确采用, 票源那条应触发 advisory。
    const crystallizedProvider = (_root: string) => {
      scanCalls++;
      return [{ file: 'wrong-source.md', union: ['src/disk-only.ts'] }];
    };
    // ticket 写集 ≠ myWriteSet 但与 myWriteSet 有真交集 → 触发 advisory 路径且不被自过滤。
    const ticket = { writeSet: ['src/a.ts', 'src/ticket-only.ts'] };
    const rep = ignitionPreflight(root, ['src/a.ts', 'src/mine-only.ts'], {
      crystallizedProvider,
      ticketSource: ticket,
    });
    // 字段在场 → 扫描依赖零调用 (票源压制)。
    expect(scanCalls).toBe(0);
    // 关键: advisory 一定包含 ticket 写集中的共享文件 (src/a.ts), 标签是 '(ticket)'
    // —— 证明 advisory 真出自票源, 不是磁盘/Provider 的 'wrong-source.md'。
    expect(rep.advisories).toHaveLength(1);
    expect(rep.advisories[0]).toContain('docs/plan/(ticket)');
    expect(rep.advisories[0]).toContain('src/a.ts');
    expect(rep.advisories[0]).not.toContain('wrong-source.md');
    expect(rep.advisories[0]).not.toContain('src/disk-only.ts');
    expect(rep.verdict).toBe('ok');
    expect(rep.conflicts).toEqual([]);
  });

  test('ticketSource 对象在场但 writeSet 字段缺省 → 按字段在场性判, 回落默认扫描', () => {
    const root = freshRoot();
    // 铺一条磁盘 SDD, 与本 run 写集相交 —— 若 ticketSource 对象的「在场性」
    // 错误地压制了扫描, 此条不会进 advisory, 测试翻红。
    writeSdd(root, 'fallback-sdd.md', ['1 写 fallback | src/a.ts | — | bun test src/a.test.ts']);
    // ticketSource 对象在场, 但 writeSet 字段缺席 —— 应当按 writeSet !== undefined 判,
    // 而非 ticketSource 自身的存在性。运行时 writeSet 是 undefined → 回落扫描。
    const rep = ignitionPreflight(root, ['src/a.ts', 'src/mine-only.ts'], {
      ticketSource: {} as { writeSet: string[] },
    });
    // 关键: 字段不在场 → 应当走默认扫描 (crystallizedSdds), 看到上面铺的 SDD。
    // mine 含 'src/mine-only.ts' 超出 SDD 写集, 防止 self-filter (sddSet.size === mine.size 且逐字相等) 误吞 advisory。
    expect(rep.advisories).toHaveLength(1);
    expect(rep.advisories[0]).toContain('docs/plan/fallback-sdd.md');
    expect(rep.advisories[0]).toContain('src/a.ts');
    expect(rep.verdict).toBe('ok');
    expect(rep.conflicts).toEqual([]);
  });

  test('ticketSource 票源 + 板上活 run 冲突 → 冲突闸独立走板上, advisory 路径仍按票读', () => {
    const root = freshRoot();
    // 活 run r1 占 src/a.ts —— 与本 run 写集真交, 触发 conflict 路径。
    appendBoard(root, entry('r1', 'claimed', { writeSet: ['src/a.ts'] }));
    // 注入扫描依赖 —— 若 ticket 源错误地失效, 这条假数据会出现在 advisories。
    let scanCalls = 0;
    const crystallizedProvider = (_root: string) => {
      scanCalls++;
      return [{ file: 'wrong.md', union: ['src/disk-only.ts'] }];
    };
    // ticket 写集与 mine 真交 (src/mine-only.ts), 但与活 run r1 的写集不交 —— 这样
    // ticket 源会触发 advisory (不构成「写集与某活 run 相交 = 已被占用」的 ignited 跳过)。
    const ticket = { writeSet: ['src/mine-only.ts', 'src/ticket-only.ts'] };
    const rep = ignitionPreflight(root, ['src/a.ts', 'src/mine-only.ts'], {
      crystallizedProvider,
      ticketSource: ticket,
    });
    // 冲突来自板上 r1 (与 ticket 源无关) → verdict blocked, conflict 字段精确。
    expect(rep.verdict).toBe('blocked');
    expect(rep.conflicts).toEqual([{ runId: 'r1', overlap: ['src/a.ts'] }]);
    // ticket 源在场 → provider 零调用 (票源压制扫描)。
    expect(scanCalls).toBe(0);
    // advisory 路径按票读, 标签 '(ticket)', 不带 'wrong.md'。
    expect(rep.advisories).toHaveLength(1);
    expect(rep.advisories[0]).toContain('docs/plan/(ticket)');
    expect(rep.advisories[0]).toContain('src/mine-only.ts');
    expect(rep.advisories[0]).not.toContain('wrong.md');
  });

  test('ticketSource 在场 + force:true → 越闸 ok + 板上留 note, advisory 仍按票读', () => {
    const root = freshRoot();
    appendBoard(root, entry('r1', 'claimed', { writeSet: ['src/a.ts'] }));
    let scanCalls = 0;
    const crystallizedProvider = (_root: string) => {
      scanCalls++;
      return [{ file: 'wrong.md', union: ['src/disk-only.ts'] }];
    };
    const ticket = { writeSet: ['src/mine-only.ts', 'src/ticket-only.ts'] };
    const rep = ignitionPreflight(root, ['src/a.ts', 'src/mine-only.ts'], {
      force: true,
      crystallizedProvider,
      ticketSource: ticket,
    });
    // force → 越闸 ok (conflict 仍在报告里, 板上留 note 证据)。
    expect(rep.verdict).toBe('ok');
    expect(rep.conflicts).toEqual([{ runId: 'r1', overlap: ['src/a.ts'] }]);
    const notes = readBoard(root).filter((e) => e.event === 'note' && e.runId === BOARD_RUN_ID);
    expect(notes).toHaveLength(1);
    expect(notes[0]!.note).toContain('越闸');
    // ticket 源在场 → provider 零调用 (force 不影响 advisory 路径)。
    expect(scanCalls).toBe(0);
    expect(rep.advisories).toHaveLength(1);
    expect(rep.advisories[0]).toContain('docs/plan/(ticket)');
    expect(rep.advisories[0]).toContain('src/mine-only.ts');
    expect(rep.advisories[0]).not.toContain('wrong.md');
  });

});

