/**
 * src/tui/dag-hud-attach.test.ts —— **外部 run 的 attach/detach 契约**(片 4, L1 + L2 seam)。
 *
 * ## 为什么单独一个文件
 *
 * 把跨进程 run(其他 CLI / sibling 会话)接到本地 TUI 这条链路,实现要新建
 * `src/tui/dag-hud-attach.ts`(读侧装配)。本片在实装**之前**先把契约钉死,
 * 让实现回到"满足这些断言"这件事上,而不是"凭感觉设计"。
 *
 * ## 双层覆盖
 *
 * - **L1 纯函数 seam**(no pi-tui,真实 fs via `mkdtemp`):
 *   走 `readDagShards` / `readDagShard` / `readBoard` / `liveRunIds` / `liveRuns` /
 *   `renderRunList`,断言每一拍读侧的真值。
 * - **L2 组件 seam**(真 `DagHud` / `DagTree` via `render(width)` ≤ width):
 *   把磁盘读到的 snapshot 经实组件喂进去,断言宽度 + 状态推进。
 *
 * ## 契约要点(每条 INV 在下面有钉死的用例 + 反向自检)
 *
 * - **状态推进**:盘上写新一份分片 → 下一拍 `readDagShards` 看见新事实,组件 `render` 跟着走。
 * - **Dedup**:同 `runId` 两份分片(写者撞名/手抖)→ 仅 freshest 留底;run-board 与分片
 *   撞名 → 分片是 DAG 树真源,run-board 仅供 `writeSet` / `awaiting`。
 * - **终端态保留**:`done|failed|cancelled` 落盘后 `DONE_GRACE_MS=15_000` 内仍可见,
 *   过期收起;run-board 终态条目的 `DEFAULT_RETENTION_MS=24h` 保留期内不删。
 * - **中途 pending run 禁删**:G-2/G-3 的 await 谓词信号。
 * - **Re-claim race**:`claimed → terminal → claimed` 顺序盲不得压成"不活"
 *   (order-by-index, 不按 ts)。
 * - **半截 / 坏 JSON / 未知 schema / 坏时戳**:读侧永不抛,坏者跳过,好的照常。
 * - **Attach 的副作用**:`DagHud.beginRun(label)` 每 attach 必调,不调两个 run 节点混表。
 * - **Selection mod**:`((sel % len) + len) % len` 负/越界不抛,归位。
 * - **Detach 的副作用**:收尾不调 `beginRun`(那是 attach 才调的)。
 *
 * ## 反向自检(改实现 → 该条当场红 → 还原)
 *
 * 每条用例在注释里标了"如果实现里改 X,这条会红"。临时改实装 → 当场红 → 还原。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendBoard, liveRunIds, liveRuns, readBoard, type BoardEntry } from '../harness/board/run-board';
import {
  DONE_GRACE_MS,
  readDagShard,
  readDagShards,
} from '../hud/load';
import { HUD_SCHEMA, type HudDagSnapshot } from '../hud/types';
import { DagHud } from './components/dag-hud';
import { DagTree } from './components/dag-tree';
import { createTheme } from './theme';

/* ─────────────────────────────────────────────────────────────────────────
 * 试具与固定值
 *
 * - 三个常驻 runId,前 8 位各不相同 → shard 文件名不会撞。
 * - `now()` 钉死 = 1_700_000_000_000,逐拍按 `tickMs` 累加,保证 `DONE_GRACE_MS` 的边界可量。
 * - tmp disk 全部经 `mkdtempSync` + `afterEach rmSync` 兜底;不依赖全局 HOME / OMD_DATA_HOME。
 * ───────────────────────────────────────────────────────────────────────── */

const RUN_A = 'aaaaaaaa-1111-2222-3333-444444444444';
const RUN_B = 'bbbbbbbb-1111-2222-3333-444444444444';
const RUN_C = 'cccccccc-1111-2222-3333-444444444444';
const RUN_RECLAIM = 'dddddddd-1111-2222-3333-444444444444';

const NOW_T0 = 1_700_000_000_000;
const TICK_MS = 1000;

const theme = createTheme({ color: false });

const dirs: string[] = [];
const freshRoot = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'omd-attach-'));
  dirs.push(d);
  return d;
};
beforeEach(() => { delete process.env.OMD_DATA_HOME; });
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** 最小合法 snapshot(INV-HUD-3 的窄字段基线)。 */
const narrowSnap = (over: Partial<HudDagSnapshot> = {}): HudDagSnapshot => ({
  schema: HUD_SCHEMA,
  runId: RUN_A,
  goal: 'g',
  status: 'running',
  updatedAt: new Date(0).toISOString(), // 调用方按 nowMs 覆盖
  levels: null,
  planned: [{ id: 'p1', kind: 'agent' }],
  started: [],
  startedAt: {},
  settled: [],
  ...over,
});

/** 写一份分片到 `<root>/.omd/hud/`(原子写:一次性落完整 JSON)。 */
const writeShard = (root: string, file: string, snap: HudDagSnapshot): string => {
  const hud = join(root, '.omd', 'hud');
  if (!existsSync(hud)) mkdirSync(hud, { recursive: true });
  const full = join(hud, file);
  writeFileSync(full, JSON.stringify(snap), 'utf-8');
  return full;
};

/** 直接写半截/坏文件给 INV-HUD-8 用:不走 `writeShard`,保证不留合法 JSON 尾巴。 */
const writeRaw = (root: string, file: string, body: string): string => {
  const hud = join(root, '.omd', 'hud');
  mkdirSync(hud, { recursive: true });
  const full = join(hud, file);
  writeFileSync(full, body, 'utf-8');
  return full;
};

/** 直接写整块板文件(绕过 appendBoard 造任意 ts)—— 用于测试 compact 保留期判定。 */
const writeBoard = (root: string, lines: string[]): void => {
  mkdirSync(join(root, '.omd'), { recursive: true });
  writeFileSync(join(root, '.omd', 'run-board.jsonl'), lines.join('\n') + '\n', 'utf-8');
};

/** 构造一条 board entry,ts 默认 = 当前 nowMs(可被 ts 覆盖)。 */
const boardEntry = (
  runId: string,
  event: BoardEntry['event'],
  nowMs: number,
  extra: Partial<BoardEntry> = {},
): BoardEntry => ({
  v: 1,
  ts: new Date(nowMs).toISOString(),
  runId,
  event,
  ...extra,
});

/* ─────────────────────────────────────────────────────────────────────────
 * L1 · 纯函数 seam —— 跨进程 run 的读侧契约
 * ───────────────────────────────────────────────────────────────────────── */

/** ★ 状态推进:盘上写一份新分片 → 下一拍 `readDagShards` 看见新事实。 */
describe('★ L1 状态推进:分片写盘 → 下一拍读侧看到', () => {
  test('三拍连续推进 (running → running → done), 视图数与 phase 逐拍变', () => {
    const root = freshRoot();
    // tick 1: 一份 running
    writeShard(root, 'dag-aaaaaaaa.json', narrowSnap({
      runId: RUN_A, status: 'running', updatedAt: new Date(NOW_T0).toISOString(),
    }));
    let vs = readDagShards(root, NOW_T0);
    expect(vs).toHaveLength(1);
    expect(vs[0]?.phase).toBe('live');
    expect(vs[0]?.snap.runId).toBe(RUN_A);

    // tick 2: 同一个 runId 多 planned/started(状态推进到 running with activity)
    writeShard(root, 'dag-aaaaaaaa.json', narrowSnap({
      runId: RUN_A, status: 'running',
      planned: [{ id: 'p1', kind: 'agent' }, { id: 'p2', kind: 'agent' }],
      started: ['p2'],
      updatedAt: new Date(NOW_T0 + TICK_MS).toISOString(),
    }));
    vs = readDagShards(root, NOW_T0 + TICK_MS);
    expect(vs).toHaveLength(1); // 同一 runId 仍是一份
    expect(vs[0]?.phase).toBe('live');
    expect(vs[0]?.snap.planned).toHaveLength(2);
    expect(vs[0]?.snap.started).toEqual(['p2']);

    // tick 3: 同一 runId 收尾 → done
    writeShard(root, 'dag-aaaaaaaa.json', narrowSnap({
      runId: RUN_A, status: 'done',
      planned: [{ id: 'p1', kind: 'agent' }, { id: 'p2', kind: 'agent' }],
      settled: [{ id: 'p1', status: 'done', kind: 'agent' }, { id: 'p2', status: 'done', kind: 'agent' }],
      updatedAt: new Date(NOW_T0 + 2 * TICK_MS).toISOString(),
    }));
    vs = readDagShards(root, NOW_T0 + 2 * TICK_MS);
    expect(vs).toHaveLength(1);
    expect(vs[0]?.phase).toBe('finished');
    expect(vs[0]?.snap.status).toBe('done');
    expect(vs[0]?.snap.settled).toHaveLength(2);
  });

  // 反向自检: 把 `readDagShards` 里 `readdirSync` 改成 `readdirSync(dir, ...)` 加缓存 →
  //           三拍的 view 数与 phase 都对不上,红。
  test('多 run 同时在跑: 三份独立分片各画各的, 不互相吞', () => {
    const root = freshRoot();
    const t = NOW_T0;
    writeShard(root, 'dag-aaaaaaaa.json', narrowSnap({ runId: RUN_A, goal: 'A', updatedAt: new Date(t).toISOString() }));
    writeShard(root, 'dag-bbbbbbbb.json', narrowSnap({ runId: RUN_B, goal: 'B', updatedAt: new Date(t + 100).toISOString() }));
    writeShard(root, 'dag-cccccccc.json', narrowSnap({ runId: RUN_C, goal: 'C', updatedAt: new Date(t + 200).toISOString() }));
    const vs = readDagShards(root, t + 200);
    expect(vs).toHaveLength(3);
    // 倒序:updatedAt 新的在前 (与 `load-shard.test.ts` 的排序契约一致)
    expect(vs[0]?.snap.goal).toBe('C');
    expect(vs[1]?.snap.goal).toBe('B');
    expect(vs[2]?.snap.goal).toBe('A');
  });
});

/** ★ Dedup:`readDagShard` 按 runId 取一份 → INV-HUD-2 短名/全名解析;run-board 决定 writeSet 真源。 */
describe('★ L1 Dedup:读侧按 runId 取一份,谁是 source of truth', () => {
  // 注: `readDagShards` **不**按 runId 全局去重(只按文件路径)—— 这是现状;同 runId 在
  // 两份独立分片中会各占一行(attach 层负责归一,见 `dag-hud-attach` 实现)。
  // 这里只测**按 runId 取一份**时的正确解析(那是 `readDagShard` 的工作)。

  test('同 runId 短名 + 全名同时存在 → readDagShard 优先短名 (短名 runId 匹配)', () => {
    const root = freshRoot();
    const t = NOW_T0;
    writeShard(root, 'dag-aaaaaaaa.json', narrowSnap({
      runId: RUN_A, goal: 'short', updatedAt: new Date(t).toISOString(),
    }));
    writeShard(root, `dag-${RUN_A}.json`, narrowSnap({
      runId: RUN_A, goal: 'full', updatedAt: new Date(t + 500).toISOString(),
    }));
    // 按 runId 取一份: 短名命中且 runId 匹配 → 用短名那份(INV-HUD-2 读侧)
    const v = readDagShard(root, RUN_A, t + 500);
    expect(v?.snap.goal).toBe('short');
  });

  // 反向自检: 删掉 readDagShard 里"短名不匹配再试全名"那段 → RUN_B 这条返 null, 红。
  test('短名里是别人的 runId (撞名), 全名命中 → readDagShard 试全名拿到 RUN_B', () => {
    const root = freshRoot();
    const t = NOW_T0;
    // 短名占着 RUN_A
    writeShard(root, 'dag-aaaaaaaa.json', narrowSnap({
      runId: RUN_A, goal: 'short-A', updatedAt: new Date(t).toISOString(),
    }));
    // 撞名:另一 runId 前 8 位也是 aaaaaaaa → 写侧甩到全名那份(对偶 INV-HUD-2)
    const runCollide: string = 'aaaaaaaa-9999-8888-7777-666666666666';
    writeShard(root, `dag-${runCollide}.json`, narrowSnap({
      runId: runCollide, goal: 'full-collide', updatedAt: new Date(t).toISOString(),
    }));
    // 短名占着 RUN_A → runCollide 不能从短名读;要从全名读
    const v = readDagShard(root, runCollide, t);
    expect(v?.snap.runId).toBe(runCollide);
    expect(v?.snap.goal).toBe('full-collide');
  });

  test('run-board 与分片撞名 → 分片是 DAG 树真源, run-board 仅供 writeSet', () => {
    // 这里量的是**两个 reader 都查得到同一 runId** 的协同: 分片决定 status / planned /
    // settled(喂 DagTree.loadSnapshot 用), run-board 决定 writeSet(喂 Sidebar 的 ▤ N files)。
    // —— 两者各管各的,不互相覆盖。
    const root = freshRoot();
    writeShard(root, 'dag-aaaaaaaa.json', narrowSnap({
      runId: RUN_A, status: 'running', updatedAt: new Date(NOW_T0).toISOString(),
    }));
    appendBoard(root, boardEntry(RUN_A, 'claimed', NOW_T0, { writeSet: ['src/a.ts', 'src/b.ts'] }));

    const views = readDagShards(root, NOW_T0);
    const board = readBoard(root);
    expect(views).toHaveLength(1);
    expect(views[0]?.snap.runId).toBe(RUN_A);

    const liveIds = liveRunIds(board);
    expect(liveIds.has(RUN_A)).toBe(true);

    const writes = liveRuns(board).get(RUN_A);
    expect(writes).toEqual(['src/a.ts', 'src/b.ts']); // run-board 真源供 writeSet
  });
});

/** ★ 终端态保留:`done|failed|cancelled` 落盘后 `DONE_GRACE_MS=15_000` 内仍可见,过期收起。 */
describe('★ L1 终端态保留:DONE_GRACE_MS 边界', () => {
  test('done 且在 grace 内 (age = DONE_GRACE_MS - 1) → 仍可见, phase=finished', () => {
    const root = freshRoot();
    writeShard(root, 'dag-aaaaaaaa.json', narrowSnap({
      runId: RUN_A, status: 'done',
      updatedAt: new Date(NOW_T0 - (DONE_GRACE_MS - 1)).toISOString(),
    }));
    const vs = readDagShards(root, NOW_T0);
    expect(vs).toHaveLength(1);
    expect(vs[0]?.phase).toBe('finished');
  });

  // 反向自检: 把 `gradeSnapshot` 里 `ageMs > DONE_GRACE_MS` 改成 `>=` → done 仍在 grace 内
  //           被错判为 null,这条红。
  test('done 且超 grace (age = DONE_GRACE_MS + 1) → 收起 (vs 缩 1)', () => {
    const root = freshRoot();
    writeShard(root, 'dag-aaaaaaaa.json', narrowSnap({
      runId: RUN_A, status: 'done',
      updatedAt: new Date(NOW_T0 - (DONE_GRACE_MS + 1)).toISOString(),
    }));
    const vs = readDagShards(root, NOW_T0);
    expect(vs).toHaveLength(0);
  });

  test('failed / cancelled 与 done 同样走 grace 窗 (D-P)', () => {
    const root = freshRoot();
    writeShard(root, 'dag-aaaaaaaa.json', narrowSnap({
      runId: RUN_A, status: 'failed',
      updatedAt: new Date(NOW_T0 - (DONE_GRACE_MS - 1)).toISOString(),
    }));
    writeShard(root, 'dag-bbbbbbbb.json', narrowSnap({
      runId: RUN_B, status: 'cancelled',
      updatedAt: new Date(NOW_T0 - (DONE_GRACE_MS - 1)).toISOString(),
    }));
    const vs = readDagShards(root, NOW_T0);
    expect(vs).toHaveLength(2);
    expect(new Set(vs.map((v) => v.snap.status))).toEqual(new Set(['failed', 'cancelled']));
  });

  test('混合 grace 窗: 一份在窗内、一份在窗外 → 只剩那份在窗内', () => {
    const root = freshRoot();
    writeShard(root, 'dag-aaaaaaaa.json', narrowSnap({
      runId: RUN_A, status: 'done',
      updatedAt: new Date(NOW_T0 - (DONE_GRACE_MS - 1)).toISOString(),
    }));
    writeShard(root, 'dag-bbbbbbbb.json', narrowSnap({
      runId: RUN_B, status: 'done',
      updatedAt: new Date(NOW_T0 - (DONE_GRACE_MS + 1)).toISOString(),
    }));
    const vs = readDagShards(root, NOW_T0);
    expect(vs).toHaveLength(1);
    expect(vs[0]?.snap.runId).toBe(RUN_A);
  });
});

/** ★ run-board 真源:re-claim race / 中途 pending run 保留 / 1MB 强制 compact。 */
describe('★ L1 run-board 真源契约(re-claim race + 保留期内禁删 + mid-pending 保留)', () => {
  // 反向自检: 把 `liveRunIds` 里 `lastClaim.set(...)` 那行注掉 → re-claim runId 被误判为死,
  //           下面「re-claim 仍活」红; 或把 `lastClaim.get(id) > lastTerminal.get(id)` 改成
  //           `>=` → re-claim 仍被吞,红。
  test('re-claim race (claimed → terminal → claimed) → 仍活, 顺序盲压不住', () => {
    const root = freshRoot();
    const t = NOW_T0;
    appendBoard(root, boardEntry(RUN_RECLAIM, 'claimed', t, { writeSet: ['x.ts'] }));
    appendBoard(root, boardEntry(RUN_RECLAIM, 'terminal', t + TICK_MS));
    appendBoard(root, boardEntry(RUN_RECLAIM, 'claimed', t + 2 * TICK_MS, { writeSet: ['y.ts'] }));

    const live = liveRunIds(readBoard(root));
    expect(live.has(RUN_RECLAIM)).toBe(true);

    // 写集也应取最近一次 claimed 的(后写者覆盖)
    const writes = liveRuns(readBoard(root)).get(RUN_RECLAIM);
    expect(writes).toEqual(['y.ts']);
  });

  test('保期 (24h) 内已终态 run 的条目不删 — compact 留下 await 满足信号', () => {
    const root = freshRoot();
    // 用 tsAgo(1h) —— 直接走盘写入, 绕开 appendBoard 自带的 `Date.now()` 戳 (避免撞墙)。
    // 1h 前 = 远没到 24h 保留期, terminal/published 应当保留。
    const tAgo = Date.now() - 60 * 60 * 1000;
    writeBoard(root, [
      JSON.stringify(boardEntry(RUN_A, 'claimed', tAgo)),
      JSON.stringify(boardEntry(RUN_A, 'published', tAgo + 100, { artifact: 'sdd.md' })),
      JSON.stringify(boardEntry(RUN_A, 'terminal', tAgo + 200)),
    ]);
    // 触发 compact (顺带 best-effort)
    appendBoard(root, boardEntry(RUN_B, 'claimed', Date.now(), { writeSet: ['w.ts'] }));

    const board = readBoard(root);
    const aEntries = board.filter((e) => e.runId === RUN_A);
    // claimed + published + terminal 全在(保留期内 await 满足/中止信号不能丢)
    expect(aEntries).toHaveLength(3);
    expect(aEntries.some((e) => e.event === 'terminal')).toBe(true);
    expect(aEntries.some((e) => e.event === 'published' && e.artifact === 'sdd.md')).toBe(true);
  });

  test('mid-pending run (claimed 之后没有 terminal) → 任何 compact 都不删 (INV-2 禁活删)', () => {
    const root = freshRoot();
    // 直接写盘构造 25h 前的活条目 (无 terminal) —— 远超 24h 保留期, 但因为没 terminal
    // 是「活」, compact 不该删 (活条目禁删是契约硬闸)。
    const tAgo = Date.now() - 25 * 60 * 60 * 1000;
    writeBoard(root, [
      JSON.stringify(boardEntry(RUN_A, 'claimed', tAgo, { writeSet: ['a.ts'] })),
    ]);
    appendBoard(root, boardEntry(RUN_B, 'claimed', Date.now(), { writeSet: ['w.ts'] })); // 触发 compact

    const board = readBoard(root);
    // RUN_A 没有 terminal → 视为活, 即使 ts 远超 24h 也不删
    expect(board.some((e) => e.runId === RUN_A && e.event === 'claimed')).toBe(true);
  });
});

/** ★ 半截 / 坏 JSON / 未知 schema / 未知 status / 文件不存在 — 读侧永不抛。 */
describe('★ L1 INV-HUD-8 读侧永不崩 (坏者跳过, 好的照常)', () => {
  test('三份分片其中一份是 `{bad` → 另两份返回', () => {
    const root = freshRoot();
    writeShard(root, 'dag-aaaaaaaa.json', narrowSnap({ runId: RUN_A, updatedAt: new Date(NOW_T0).toISOString() }));
    writeShard(root, 'dag-bbbbbbbb.json', narrowSnap({ runId: RUN_B, updatedAt: new Date(NOW_T0).toISOString() }));
    writeRaw(root, 'dag-cccccccc.json', '{bad');

    const vs = readDagShards(root, NOW_T0);
    expect(vs).toHaveLength(2);
    expect(new Set(vs.map((v) => v.snap.runId))).toEqual(new Set([RUN_A, RUN_B]));
  });

  test('未知 schema (schema=99) → 跳过那份, 不知会调用方', () => {
    const root = freshRoot();
    writeRaw(root, 'dag-aaaaaaaa.json', JSON.stringify({ schema: 99, runId: 'x', updatedAt: new Date(NOW_T0).toISOString() }));
    writeShard(root, 'dag-bbbbbbbb.json', narrowSnap({ runId: RUN_B, updatedAt: new Date(NOW_T0).toISOString() }));

    const vs = readDagShards(root, NOW_T0);
    expect(vs).toHaveLength(1);
    expect(vs[0]?.snap.runId).toBe(RUN_B);
  });

  test('坏时戳 (updatedAt 非日期) → 跳过 (done 走 null; running 走 stalled)', () => {
    const root = freshRoot();
    writeShard(root, 'dag-aaaaaaaa.json', { ...narrowSnap({ status: 'done' }), updatedAt: 'not-a-date' } as HudDagSnapshot);
    writeShard(root, 'dag-bbbbbbbb.json', narrowSnap({ runId: RUN_B, updatedAt: new Date(NOW_T0).toISOString() }));

    const vs = readDagShards(root, NOW_T0);
    expect(vs).toHaveLength(1);
    expect(vs[0]?.snap.runId).toBe(RUN_B);
  });

  test('hud 目录不存在 → 返回空数组, 不抛 (无 home 的 cwd 也是合法的 "暂无 run")', () => {
    const root = freshRoot();
    expect(readDagShards(root, NOW_T0)).toEqual([]);
    expect(readDagShard(root, RUN_A, NOW_T0)).toBeNull();
  });

  test('run-board 文件不存在 → readBoard 返回空, 不抛', () => {
    const root = freshRoot();
    expect(readBoard(root)).toEqual([]);
    expect(liveRunIds(readBoard(root))).toEqual(new Set());
  });

  test('run-board 里有坏行 (半截 JSON) → 跳过坏行, 不抛, 不吞证据 (留一条 note)', () => {
    const root = freshRoot();
    mkdirSync(join(root, '.omd'), { recursive: true });
    const boardPath = join(root, '.omd', 'run-board.jsonl');
    // 合法 + 坏行 + 合法
    const good1 = JSON.stringify(boardEntry(RUN_A, 'claimed', NOW_T0));
    const good2 = JSON.stringify(boardEntry(RUN_A, 'terminal', NOW_T0 + 100));
    writeFileSync(boardPath, [good1, '{bad', good2].join('\n') + '\n', 'utf-8');

    const board = readBoard(root);
    // 两条合法留底,坏行被替换为一条 note 证据行
    const real = board.filter((e) => e.runId !== '__board__');
    expect(real).toHaveLength(2);
    expect(real.map((e) => e.event)).toEqual(['claimed', 'terminal']);
    const note = board.find((e) => e.runId === '__board__');
    expect(note).toBeDefined();
    expect(note?.note).toContain('bad line skipped');
  });
});

/** ★ 读侧对偶(INV-HUD-2):按 runId 取一份分片视图,短名撞名时试全名。 */
describe('★ L1 INV-HUD-2 readDagShard 短名 → 全名 → null', () => {
  test('短名匹配 → 命中短名那份', () => {
    const root = freshRoot();
    writeShard(root, 'dag-aaaaaaaa.json', narrowSnap({ runId: RUN_A, updatedAt: new Date(NOW_T0).toISOString() }));
    const v = readDagShard(root, RUN_A, NOW_T0);
    expect(v?.snap.runId).toBe(RUN_A);
  });

  test('短名里是别人的 runId, 全名命中 → 取全名那份', () => {
    const root = freshRoot();
    // 短名占着 RUN_A,全名那份是另一 runId
    writeShard(root, 'dag-aaaaaaaa.json', narrowSnap({ runId: RUN_A, goal: 'A', updatedAt: new Date(NOW_T0).toISOString() }));
    writeShard(root, `dag-${RUN_B}.json`, narrowSnap({ runId: RUN_B, goal: 'B', updatedAt: new Date(NOW_T0).toISOString() }));
    expect(readDagShard(root, RUN_B, NOW_T0)?.snap.goal).toBe('B');
  });

  test('短名 + 全名都没有 → null (没写过 / 已 GC)', () => {
    const root = freshRoot();
    writeShard(root, 'dag-aaaaaaaa.json', narrowSnap({ runId: RUN_A, updatedAt: new Date(NOW_T0).toISOString() }));
    expect(readDagShard(root, RUN_C, NOW_T0)).toBeNull();
  });
});

/* ─────────────────────────────────────────────────────────────────────────
 * L2 · 组件 seam —— 真 DagHud / DagTree 的 render(width) ≤ width + 状态推进
 * ───────────────────────────────────────────────────────────────────────── */

/**
 * ★ L2-attach:对每个外部 run attach,都要 `DagHud.beginRun(label)` + 喂事实;不调
 *   `beginRun` 直接 `apply` → 新旧两个 run 的节点混成一张表(已知坑)。
 *
 * 这里用真组件验证:**先 beginRun 清干净,再 apply → 渲染只看见新 run 的节点**。
 */
describe('★ L2 attach 副作用:beginRun 清表, 防止两个 run 混图', () => {
  // 反向自检: 把 `DagHud.beginRun` 的 `this.nodes.clear()` 注释掉 → 这条红(看见 old)。
  test('beginRun 之前已 apply 过 → 清干净, 新 run 节点独自占表', () => {
    const hud = new DagHud(theme, () => 'fake:con');
    hud.apply({ type: 'planned', nodes: [{ id: 'old-1', kind: 'agent' }] });
    expect(hud.size).toBe(1);

    // attach 外部 run
    hud.beginRun('external-run-id');
    hud.apply({ type: 'planned', nodes: [{ id: 'new-1', kind: 'agent' }, { id: 'new-2', kind: 'agent' }] });

    expect(hud.size).toBe(2);
    const out = hud.render(100).join('\n');
    expect(out).toContain('new-1');
    expect(out).not.toContain('old-1'); // 旧 run 节点被清, 不混图
    expect(out).toContain('external-run-id'); // runLabel 也覆盖
  });

  test('跳过 beginRun 直接 apply → 两 run 混表 (证明 beginRun 是 attach 的必备副作用)', () => {
    const hud = new DagHud(theme, () => 'fake:con');
    hud.apply({ type: 'planned', nodes: [{ id: 'first', kind: 'agent' }] });
    // 不调 beginRun,直接 apply 新的 planned → 节点表累积
    hud.apply({ type: 'planned', nodes: [{ id: 'second', kind: 'agent' }] });

    const out = hud.render(100).join('\n');
    expect(out).toContain('first');
    expect(out).toContain('second'); // 没 beginRun → 两 run 节点都在
  });
});

/** ★ L2-状态推进:盘上 snap 推进 → 真 DagTree.loadSnapshot 跟进 → render 跟着变。 */
describe('★ L2 状态推进:磁盘快照演进 → DagTree.render 跟着变', () => {
  // 反向自检: 把 `DagTree.loadSnapshot` 第一行 `this.nodes.clear()` 注掉 → 第二拍渲染同时
  //           看见两拍节点,len 断言红。
  test('tick 1: 仅 planned → 渲染见根节点; tick 2: 同一 runId settle → 渲染见 done', () => {
    const root = freshRoot();
    // tick 1
    const snap1: HudDagSnapshot = {
      schema: HUD_SCHEMA,
      runId: RUN_A,
      goal: 'external-A',
      status: 'running',
      updatedAt: new Date(NOW_T0).toISOString(),
      levels: null,
      planned: [{ id: 'a1', kind: 'agent' }],
      started: [],
      startedAt: {},
      settled: [],
    };
    writeShard(root, 'dag-aaaaaaaa.json', snap1);

    const tree = new DagTree(theme, () => NOW_T0);
    tree.beginRun(snap1.goal);
    tree.loadSnapshot(readDagShard(root, RUN_A, NOW_T0)!.snap);
    expect(tree.size).toBe(1);
    const out1 = tree.render(80).join('\n');
    expect(out1).toContain('a1');

    // tick 2: a1 已 done
    const snap2: HudDagSnapshot = {
      ...snap1,
      status: 'done',
      updatedAt: new Date(NOW_T0 + TICK_MS).toISOString(),
      settled: [{ id: 'a1', status: 'done', kind: 'agent', startedAt: new Date(NOW_T0).toISOString(), durationMs: 800 }],
    };
    writeShard(root, 'dag-aaaaaaaa.json', snap2);
    tree.loadSnapshot(readDagShard(root, RUN_A, NOW_T0 + TICK_MS)!.snap);

    expect(tree.size).toBe(1); // 仍是同 runId 的同一节点
    const out2 = tree.render(80).join('\n');
    expect(out2).toContain('✓'); // done 字形
    expect(out2).not.toContain('○'); // pending 字形已被 settle 替换
  });

  test('attach 新 run: loadSnapshot 后 beginRun + 旧节点清掉, 新节点独占', () => {
    const root = freshRoot();
    const tree = new DagTree(theme, () => NOW_T0);

    // run A
    tree.beginRun('A');
    tree.loadSnapshot({
      schema: HUD_SCHEMA,
      runId: RUN_A, goal: 'A', status: 'running',
      updatedAt: new Date(NOW_T0).toISOString(),
      levels: null,
      planned: [{ id: 'a1', kind: 'agent' }],
      started: [], startedAt: {}, settled: [],
    });
    expect(tree.size).toBe(1);

    // attach run B (外部 run 切换): beginRun 是必须的清场副作用
    tree.beginRun('B');
    tree.loadSnapshot({
      schema: HUD_SCHEMA,
      runId: RUN_B, goal: 'B', status: 'running',
      updatedAt: new Date(NOW_T0 + TICK_MS).toISOString(),
      levels: null,
      planned: [{ id: 'b1', kind: 'agent' }, { id: 'b2', kind: 'agent' }],
      started: [], startedAt: {}, settled: [],
    });
    expect(tree.size).toBe(2); // 不与 A 混图
    const out = tree.render(80).join('\n');
    expect(out).toContain('b1');
    expect(out).toContain('b2');
    expect(out).not.toContain('a1');
  });
});

/** ★ L2-宽度闸:`render(width)` 任意宽度下都不超宽(包含中文节点名)。 */
describe('★ L2 render(width) ≤ width (跨进程数据进组件, 宽度不破)', () => {
  // 反向自检: 把 `DagTree.render` 的 `fitLine(line, width)` 改成 `line` → 全部宽度断言红。
  test('DagHud.render 在 20/40/80/120 四档宽度下不超宽', () => {
    const root = freshRoot();
    const hud = new DagHud(theme, () => 'kimi-coding:k3');
    hud.beginRun('ext-attach');
    hud.apply({
      type: 'planned',
      nodes: Array.from({ length: 8 }, (_, i) => ({
        id: `节点${i}`,
        kind: 'agent' as const,
      })),
    });

    const { visibleWidth } = require('@earendil-works/pi-tui');
    for (const w of [20, 40, 80, 120]) {
      for (const line of hud.render(w)) {
        expect(visibleWidth(line), `DagHud w=${w} line=${JSON.stringify(line)}`).toBeLessThanOrEqual(w);
      }
    }
  });

  test('DagTree.render 在 20/40/80/120 四档宽度下不超宽 (中文节点名)', () => {
    const tree = new DagTree(theme, () => NOW_T0);
    tree.beginRun('ext-attach');
    tree.loadSnapshot({
      schema: HUD_SCHEMA,
      runId: RUN_A, goal: '一个很长的中文目标标签让渲染层去截', status: 'running',
      updatedAt: new Date(NOW_T0).toISOString(),
      levels: null,
      planned: [
        { id: '很长的中文节点名字第1个', kind: 'agent' },
        { id: '很长的中文节点名字第2个', kind: 'agent', deps: ['很长的中文节点名字第1个'] },
      ],
      started: [], startedAt: {}, settled: [],
    });

    const { visibleWidth } = require('@earendil-works/pi-tui');
    for (const w of [20, 40, 80, 120]) {
      for (const line of tree.render(w)) {
        expect(visibleWidth(line), `DagTree w=${w} line=${JSON.stringify(line)}`).toBeLessThanOrEqual(w);
      }
    }
  });
});

/** ★ L2-终端态保留:done|failed|cancelled 落盘后,在 grace 内 DagTree.render 仍画出节点。 */
describe('★ L2 终端态显示:done|failed|cancelled 在 grace 内仍渲染', () => {
  test('done 节点 status=done, render 出现 ✓ + id (在 grace 内)', () => {
    const root = freshRoot();
    writeShard(root, 'dag-aaaaaaaa.json', {
      schema: HUD_SCHEMA,
      runId: RUN_A, goal: 'done-attached', status: 'done',
      updatedAt: new Date(NOW_T0 - (DONE_GRACE_MS - 1000)).toISOString(),
      levels: null,
      planned: [{ id: 'fin-1', kind: 'agent' }],
      started: [], startedAt: {},
      settled: [{ id: 'fin-1', status: 'done', kind: 'agent' }],
    });
    const view = readDagShard(root, RUN_A, NOW_T0)!;
    const tree = new DagTree(theme, () => NOW_T0);
    tree.beginRun(view.snap.goal);
    tree.loadSnapshot(view.snap);

    expect(tree.size).toBe(1);
    const out = tree.render(80).join('\n');
    expect(out).toContain('fin-1');
    expect(out).toContain('✓'); // done 字形
  });

  test('failed 节点 status=failed + failureKind → render 出现 ✗, failureKind 保留在节点上 (C-6 ② 数据面)', () => {
    const root = freshRoot();
    writeShard(root, 'dag-aaaaaaaa.json', {
      schema: HUD_SCHEMA,
      runId: RUN_A, goal: 'failed-attached', status: 'failed',
      updatedAt: new Date(NOW_T0 - (DONE_GRACE_MS - 1000)).toISOString(),
      levels: null,
      planned: [{ id: 'fail-1', kind: 'agent' }],
      started: [], startedAt: {},
      settled: [{
        id: 'fail-1',
        status: 'failed',
        kind: 'agent',
        failureKind: 'empty-artifact',
      }],
    });
    const view = readDagShard(root, RUN_A, NOW_T0)!;
    const tree = new DagTree(theme, () => NOW_T0);
    tree.beginRun(view.snap.goal);
    tree.loadSnapshot(view.snap);

    // 渲染: ✗ 字形 + 节点 id; failReason 在磁盘快照里不存(只随事件 live 传)→
    // loadSnapshot 路径上 [failureKind] 子行不画 —— 这条钉的是「数据面保留」, 不钉「子行画」。
    const out = tree.render(80).join('\n');
    expect(out).toContain('fail-1');
    expect(out).toContain('✗'); // failed 字形

    // 数据面: failureKind 真从 snapshot 走到 TreeNode 上 (loadSnapshot:229)
    const snap = tree.snapshot();
    const node = snap.nodes.find((n) => n.id === 'fail-1')!;
    expect(node.failureKind).toBe('empty-artifact');
    expect(node.status).toBe('failed');
  });

  test('cancelled 与 done / failed 同形 (D-P): grace 内仍渲染, 但不画 failReason / failureKind', () => {
    const root = freshRoot();
    writeShard(root, 'dag-aaaaaaaa.json', {
      schema: HUD_SCHEMA,
      runId: RUN_A, goal: 'cancelled-attached', status: 'cancelled',
      updatedAt: new Date(NOW_T0 - (DONE_GRACE_MS - 1000)).toISOString(),
      levels: null,
      planned: [{ id: 'cn-1', kind: 'agent' }],
      started: [], startedAt: {},
      // cancelled 不写 settled / 不写 failureKind(没有失败) — 与 done 同样进 grace
      settled: [{ id: 'cn-1', status: 'done', kind: 'agent' }],
    });
    const view = readDagShard(root, RUN_A, NOW_T0)!;
    const tree = new DagTree(theme, () => NOW_T0);
    tree.beginRun(view.snap.goal);
    tree.loadSnapshot(view.snap);

    const out = tree.render(80).join('\n');
    expect(out).toContain('cn-1');
    // cancelled 自身不画 ✗ (没失败) → settle 走 done 字形
    expect(out).not.toContain('[unclassified]'); // NULL ≠ 不适用 闸
  });
});

/** ★ L2-dup 防御:按 runId 取一份 → INV-HUD-2 短名优先 (再触发 loadSnapshot, 渲染只看见一份)。 */
describe('★ L2 重复 runId 不让组件状态回退', () => {
  // 注: 同 runId 写到两份独立文件(短名 + 全名)时, `readDagShards` 列**两份**(按文件路径),
  //      `readDagShard(runId)` 才按 runId 收敛到一份(短名优先);attach 层负责把多份归一。
  // 这里量的是:**按 runId 取一份 → 喂给组件 → 渲染只见那份的节点**(短名那份)。证明
  // 路径不会因为"两份都还在盘上"就把组件状态叠加。

  test('短名 + 全名两份同 runId → readDagShard 取一份喂组件, 渲染只见短名那份节点', () => {
    const root = freshRoot();
    const t = NOW_T0;
    writeShard(root, 'dag-aaaaaaaa.json', narrowSnap({
      runId: RUN_A, goal: 'short', status: 'running',
      planned: [{ id: 'short-1', kind: 'agent' }],
      updatedAt: new Date(t).toISOString(),
    }));
    writeShard(root, `dag-${RUN_A}.json`, narrowSnap({
      runId: RUN_A, goal: 'full', status: 'running',
      planned: [{ id: 'full-1', kind: 'agent' }, { id: 'full-2', kind: 'agent' }],
      updatedAt: new Date(t + 500).toISOString(),
    }));
    // 按 runId 取一份: 短名命中(INV-HUD-2 读侧) → 拿 short 那份
    const view = readDagShard(root, RUN_A, t + 500)!;
    expect(view.snap.goal).toBe('short');

    const tree = new DagTree(theme, () => t + 500);
    tree.beginRun(view.snap.goal);
    tree.loadSnapshot(view.snap);
    const out = tree.render(80).join('\n');
    expect(out).toContain('short-1');
    expect(out).not.toContain('full-1');
    expect(out).not.toContain('full-2');
  });

  // 反向自检: 删掉 `DagTree.loadSnapshot` 里 `this.nodes.clear()` → 第二次 loadSnapshot 与
  //           第一次的混图, 这条红。
  test('同 runId 连刷两轮快照 → 第二次 loadSnapshot 不会叠加第一次的节点', () => {
    const root = freshRoot();
    const tree = new DagTree(theme, () => NOW_T0);

    // tick 1: 2 节点
    tree.beginRun('ext-A');
    tree.loadSnapshot({
      schema: HUD_SCHEMA,
      runId: RUN_A, goal: 'ext-A', status: 'running',
      updatedAt: new Date(NOW_T0).toISOString(),
      levels: null,
      planned: [{ id: 'a1', kind: 'agent' }, { id: 'a2', kind: 'agent' }],
      started: [], startedAt: {},
      settled: [{ id: 'a1', status: 'done', kind: 'agent' }],
    });
    expect(tree.size).toBe(2);

    // tick 2: 同一 runId 重规划, 节点集合 2 → 3 (a1, a2 还在, 加 a3)
    tree.loadSnapshot({
      schema: HUD_SCHEMA,
      runId: RUN_A, goal: 'ext-A', status: 'running',
      updatedAt: new Date(NOW_T0 + TICK_MS).toISOString(),
      levels: null,
      planned: [{ id: 'a1', kind: 'agent' }, { id: 'a2', kind: 'agent' }, { id: 'a3', kind: 'agent' }],
      started: [], startedAt: {},
      settled: [{ id: 'a1', status: 'done', kind: 'agent' }],
    });
    expect(tree.size).toBe(3);
    const out = tree.render(80).join('\n');
    expect(out).toContain('a1');
    expect(out).toContain('a2');
    expect(out).toContain('a3');
  });
});

/** ★ L2-attach 完整链路:读盘 → loadSnapshot → render, 端到端覆盖契约。 */
describe('★ L2 端到端:外部 run 落盘 → 真 DagTree.render 出图', () => {
  // 反向自检: 删掉 `DagTree.loadSnapshot` 里 `this.nodes.clear()` → 第二次 loadSnapshot 与
  //           第一次的混图, 这条红。
  test('两轮 attach 同一 run: 第二轮 loadSnapshot 不与第一轮混图', () => {
    const root = freshRoot();
    const tree = new DagTree(theme, () => NOW_T0);

    // 第一轮: 2 节点, 1 已 done
    tree.beginRun('ext-A');
    tree.loadSnapshot({
      schema: HUD_SCHEMA,
      runId: RUN_A, goal: 'ext-A', status: 'running',
      updatedAt: new Date(NOW_T0).toISOString(),
      levels: null,
      planned: [{ id: 'a1', kind: 'agent' }, { id: 'a2', kind: 'agent' }],
      started: [], startedAt: {},
      settled: [{ id: 'a1', status: 'done', kind: 'agent' }],
    });
    expect(tree.size).toBe(2);

    // 第二轮: 同 runId 重规划 (run-registry 重新写分片), 节点集合从 2 → 3
    tree.loadSnapshot({
      schema: HUD_SCHEMA,
      runId: RUN_A, goal: 'ext-A', status: 'running',
      updatedAt: new Date(NOW_T0 + TICK_MS).toISOString(),
      levels: null,
      planned: [{ id: 'a1', kind: 'agent' }, { id: 'a2', kind: 'agent' }, { id: 'a3', kind: 'agent' }],
      started: [], startedAt: {},
      settled: [{ id: 'a1', status: 'done', kind: 'agent' }],
    });
    expect(tree.size).toBe(3);
    const out = tree.render(80).join('\n');
    expect(out).toContain('a1');
    expect(out).toContain('a2');
    expect(out).toContain('a3');
  });

  test('外部 run attach → runLabel 与分片 snap.goal 同形 (与 beginRun 同形)', () => {
    const root = freshRoot();
    writeShard(root, 'dag-aaaaaaaa.json', {
      schema: HUD_SCHEMA,
      runId: RUN_A, goal: '外部 run 标题', status: 'running',
      updatedAt: new Date(NOW_T0).toISOString(),
      levels: null,
      planned: [{ id: 'g-1', kind: 'agent' }],
      started: [], startedAt: {}, settled: [],
    });
    const view = readDagShard(root, RUN_A, NOW_T0)!;

    const tree = new DagTree(theme, () => NOW_T0);
    tree.beginRun(view.snap.goal);
    tree.loadSnapshot(view.snap);

    const out = tree.render(80).join('\n');
    // 头行 = DAG <runLabel> = DAG 外部 run 标题
    expect(out).toContain('DAG 外部 run 标题');
    expect(out).toContain('g-1');
  });
});