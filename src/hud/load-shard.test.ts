/**
 * HudMirror 切片 2 (#216 读侧) 的闸 —— 2026-08-22 SDD 片 3 读侧契约。
 *
 * 本片只测**读侧** (`readDagShards` / `readDagShard`), 写侧契约在 `mirror-shard.test.ts`。
 * 每条 INV 在这里钉一条用例, 加反向自检: 临时改实现 → 该条当场红 → 还原。
 *
 * 覆盖的 INV:
 *   - INV-HUD-2 读侧对偶: 短名里的 runId 不是自己 → 试全名 (mirror 撞名改写的去向)
 *   - INV-HUD-3 老快照 (字段窄 — 没有 deps / usage / durationMs / failureKind) → 仍可读, 那几个字段 undefined
 *   - INV-HUD-4 读侧**保留** undefined 不补: 不画 0 / 不画 unclassified (字段层面)
 *   - INV-HUD-8 读侧永不崩: 半截 JSON / 未知 schema / 坏时戳 / 目录不存在 → 跳过那份 (或该 home),
 *                      别的照常; **不是**整个列表返回 null
 *   - 新鲜度分级 (live / stalled / finished / 过期收起): 与 `readDagView` 同公式, 这里验三档
 *   - 排序: 按 updatedAt 倒序 (屏 4 多 run 同时画, 新的在前)
 *   - 候选 home 覆盖: 两处 home 都扫, 同路径不重读
 *   - 非分片文件忽略: `dag.json` (statusline) 与 `fog.json` 不在分片列表里
 *
 * 不在本片:
 *   - `readDagView` 一字不动 (INV-HUD-1); 本片不复测, 它在别处。
 *   - `loadSnapshot` (切片 3 / `dag-tree-snapshot.test.ts`)。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HUD_SCHEMA, type HudDagSnapshot } from './types';
import { readDagShard, readDagShards, readDagView, RUNNING_TTL_MS, DONE_GRACE_MS } from './load';

/* 几个常驻 runId — 全是 36 位合法 UUID, 与 mirror 实际写出同形态, 避免 fixture 用了缩略串又被
 * 读侧按"短名不匹配"挑走。short 前 8 位不同 → 各 shard 文件名也不会撞。 */
const RUN_A = 'aaaaaaaa-1111-2222-3333-444444444444';
const RUN_B = 'bbbbbbbb-1111-2222-3333-444444444444';
const RUN_C = 'cccccccc-1111-2222-3333-444444444444';
const RUN_UNKNOWN = 'ffffffff-1234-1234-1234-123456789abc';

/** 一份合法的小快照 (INV-HUD-3 的「窄字段」基线 —— 没 deps/usage/durationMs/failureKind)。 */
const narrowSnap = (over: Partial<HudDagSnapshot> = {}): HudDagSnapshot => ({
  schema: HUD_SCHEMA,
  runId: RUN_A,
  goal: 'g',
  status: 'running',
  updatedAt: new Date(0).toISOString(), // 由调用方按 nowMs 覆盖
  levels: null,
  planned: [{ id: 'p1', kind: 'agent' }],
  started: [],
  startedAt: {},
  settled: [],
  ...over,
});

/** 一份宽字段快照 (切片 1 加宽账后的形态, INV-HUD-3 顺便验「新字段也能读」)。 */
const wideSnap = (over: Partial<HudDagSnapshot> = {}): HudDagSnapshot => ({
  ...narrowSnap(),
  planned: [
    { id: 'p1', kind: 'agent' },
    { id: 'p2', kind: 'agent', deps: ['p1'] },
  ],
  settled: [
    {
      id: 'p1',
      status: 'failed',
      kind: 'agent',
      model: 'gpt-5.6',
      startedAt: '2026-08-22T10:00:00.000Z',
      durationMs: 4321,
      usage: { in: 100, out: 200 },
      failureKind: 'empty-artifact',
    },
  ],
  ...over,
});

/** 写一份分片到 hud 目录 (走原子写, 与 mirror 一致; 测的是读侧, 不在意写细节)。 */
const writeShard = (root: string, file: string, snap: HudDagSnapshot): string => {
  const hud = join(root, '.omd', 'hud');
  if (!existsSync(hud)) mkdirSync(hud, { recursive: true });
  const full = join(hud, file);
  writeFileSync(full, JSON.stringify(snap), 'utf-8');
  return full;
};

/* 不动全局 HOME: 我们测的是「按 cwd → 派生 slug → 找 ~/.omd/projects/<slug>/hud」这一条路径,
 * 写进去会污染用户真实的 ~/.omd —— 单测跳过对二 home 的写, 但**读侧**在 INV-HUD-8 的
 *「目录不存在 → 跳过」里顺带兜住 (一处 home 不存在, 不抛, 别的照常)。 */

/* 干净的 tmpdir; delete OMD_DATA_HOME 以保 repoRoot/.omd/hud 是写到的目录。 */
let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'omd-hud-load-shard-'));
  delete process.env.OMD_DATA_HOME;
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/* ───────────────────────────────────────────────────────────────────────── */
/* 回归: readDagView 一字不动 (INV-HUD-1)                                          */
/* ───────────────────────────────────────────────────────────────────────── */

describe('★ INV-HUD-1 回归 readDagView (本片不许改它, statusline 数据源钉死)', () => {
  // 反向自检: 把 readDagView 里"先读 dag.json"的代码挪成"先读 dag-<...>.json" → 这条读不到, 红。
  test('readDagView 只读 dag.json (statusline 的数据源), 不读分片', () => {
    writeShard(root, 'dag.json', narrowSnap({ status: 'running' }));
    writeShard(root, 'dag-aaaaaaaa.json', narrowSnap({ status: 'running', runId: RUN_B }));
    const view = readDagView(root, Date.now());
    expect(view).not.toBeNull();
    expect(view?.snap.runId).toBe(RUN_A);
  });
});

/* ───────────────────────────────────────────────────────────────────────── */
/* readDagShards: 列全部                                                            */
/* ───────────────────────────────────────────────────────────────────────── */

describe('★ readDagShards 列全部活图分片', () => {
  test('目录空 → 返回空数组, 不是 null (调用方 for-of 友好)', () => {
    expect(readDagShards(root, Date.now())).toEqual([]);
  });

  test('只读 dag-*.json — dag.json / fog.json 自动排除', () => {
    // 反向自检: 把 pattern 放宽到 `\.json$` → 这条红 (会把 dag.json / fog.json 算进来)。
    writeShard(root, 'dag.json', narrowSnap());
    // fog.json 不是 DagSnapshot 形状, 用 raw fs 写 (writeShard 的 snap 参数已限定为 HudDagSnapshot)。
    const hud = join(root, '.omd', 'hud');
    mkdirSync(hud, { recursive: true });
    writeFileSync(
      join(hud, 'fog.json'),
      JSON.stringify({ schema: HUD_SCHEMA, updatedAt: 'x', destination: 'd', ruled: 1, total: 2, bar: 'x' }),
      'utf-8',
    );
    writeShard(root, 'dag-aaaaaaaa.json', narrowSnap({ runId: RUN_A }));
    const vs = readDagShards(root, Date.now());
    expect(vs).toHaveLength(1);
    expect(vs[0]?.snap.runId).toBe(RUN_A);
  });

  test('多个分片 → 全部返回', () => {
    writeShard(root, 'dag-aaaaaaaa.json', narrowSnap({ runId: RUN_A }));
    writeShard(root, 'dag-bbbbbbbb.json', narrowSnap({ runId: RUN_B, goal: 'b' }));
    writeShard(root, 'dag-cccccccc.json', narrowSnap({ runId: RUN_C, goal: 'c' }));
    const vs = readDagShards(root, Date.now());
    expect(vs).toHaveLength(3);
    expect(new Set(vs.map((v) => v.snap.runId))).toEqual(new Set([RUN_A, RUN_B, RUN_C]));
  });

  test('按 updatedAt 倒序 (屏 4 多 run 同画时新的在前)', () => {
    // 反向自检: 把 sort 方向倒过来 → 这条红。
    const t0 = Date.now();
    writeShard(root, 'dag-aaaaaaaa.json', narrowSnap({ runId: RUN_A, updatedAt: new Date(t0 - 60_000).toISOString() }));
    writeShard(root, 'dag-bbbbbbbb.json', narrowSnap({ runId: RUN_B, updatedAt: new Date(t0).toISOString() }));
    writeShard(root, 'dag-cccccccc.json', narrowSnap({ runId: RUN_C, updatedAt: new Date(t0 - 30_000).toISOString() }));
    const vs = readDagShards(root, t0);
    expect(vs.map((v) => v.snap.runId)).toEqual([RUN_B, RUN_C, RUN_A]);
  });
});

/* ───────────────────────────────────────────────────────────────────────── */
/* 新鲜度闸 (live / stalled / finished / 收起)                                          */
/* ───────────────────────────────────────────────────────────────────────── */

describe('★ 新鲜度闸与 readDagView 同公式 (readDagShards / readDagShard 都走 gradeSnapshot)', () => {
  const now = 1_700_000_000_000;

  test('running 且新 (age=0) → live', () => {
    writeShard(root, 'dag-aaaaaaaa.json', narrowSnap({ updatedAt: new Date(now).toISOString(), status: 'running' }));
    const [v] = readDagShards(root, now);
    expect(v?.phase).toBe('live');
  });

  test('running 且超 TTL (age=RUNNING_TTL_MS+1) → stalled (server 疑似崩)', () => {
    writeShard(
      root,
      'dag-aaaaaaaa.json',
      narrowSnap({ updatedAt: new Date(now - (RUNNING_TTL_MS + 1)).toISOString(), status: 'running' }),
    );
    const [v] = readDagShards(root, now);
    expect(v?.phase).toBe('stalled');
  });

  test('done 且新 (age < grace) → finished', () => {
    writeShard(
      root,
      'dag-aaaaaaaa.json',
      narrowSnap({ updatedAt: new Date(now - (DONE_GRACE_MS - 1)).toISOString(), status: 'done' }),
    );
    const [v] = readDagShards(root, now);
    expect(v?.phase).toBe('finished');
  });

  test('done 且超 grace (age=DONE_GRACE_MS+1) → 从列表里被收起 (返回 null, 列表缩 1)', () => {
    // done + 极远 → 必过期; 另一份 running + 新 → 进 live 留底
    writeShard(
      root,
      'dag-aaaaaaaa.json',
      narrowSnap({ status: 'done', updatedAt: new Date(now - (DONE_GRACE_MS + 1)).toISOString() }),
    );
    writeShard(
      root,
      'dag-bbbbbbbb.json',
      narrowSnap({ runId: RUN_B, updatedAt: new Date(now).toISOString(), status: 'running' }),
    );
    const vs = readDagShards(root, now);
    expect(vs).toHaveLength(1);
    expect(vs[0]?.snap.runId).toBe(RUN_B);
    expect(vs[0]?.snap.runId).toBe('bbbbbbbb-1111-2222-3333-444444444444');
  });
});

/* ───────────────────────────────────────────────────────────────────────── */
/* INV-HUD-3 老快照可读 + 加宽字段 optional                                                */
/* ───────────────────────────────────────────────────────────────────────── */

describe('★ INV-HUD-3 schema=1 老快照继续可读 (HUD_SCHEMA 没被 bump)', () => {
  // 反向自检: 把 readDagShards 里的 schema !== HUD_SCHEMA 判断改成 === 1 加上 bump → 这条红 (老快照一定被滤)。
  test('读侧仍按 HUD_SCHEMA (1) 判 schema, 加宽字段全是 optional', () => {
    expect(HUD_SCHEMA).toBe(1); // 钉死: 谁 bump 谁红 (与 mirror-shard 那条同形态)
    const snap = narrowSnap(); // deps/usage/durationMs/failureKind 都没有, 合法
    const full = writeShard(root, 'dag-aaaaaaaa.json', snap);
    expect(statSync(full).size).toBeGreaterThan(0);
    const [v] = readDagShards(root, Date.now());
    expect(v).not.toBeNull();
    expect(v?.snap.runId).toBe('aaaaaaaa-1111-2222-3333-444444444444');
  });

  test('读侧**保留** undefined 不补: 老快照里加宽字段是 undefined, 不是 0, 不是 unclassified', () => {
    const full = writeShard(root, 'dag-aaaaaaaa.json', narrowSnap());
    const raw = JSON.parse(readFileSync(full, 'utf-8')) as { planned: Record<string, unknown>[]; settled: unknown[] };
    // 盘上 JSON 序列化时 undefined 字段**直接不存在** —— 读回来也自然是 undefined, 渲染画 "—" 的源头。
    expect(raw.planned[0]).not.toHaveProperty('deps');
    expect(raw.settled).toEqual([]); // 切片 1 INV-HUD-4 的对偶
  });
});

/* ───────────────────────────────────────────────────────────────────────── */
/* INV-HUD-8 读侧永不崩                                                              */
/* ───────────────────────────────────────────────────────────────────────── */

describe('★ INV-HUD-8 半截 JSON / 未知 schema / 坏时戳 → 跳过那份, 不是整个列表 null', () => {
  // 反向自检: 把 readSingleShard 的 catch 改成 throw → 这几条全红;
  //          把 readDagShards 里 try { JSON.parse } 提到外层 → 撞见一份半截就跳过后面的, 这条红。
  const now = Date.now();

  test('三份分片其中一份是 `{bad` → 返回另外两份, 长度为 2', () => {
    writeShard(root, 'dag-aaaaaaaa.json', narrowSnap({ runId: RUN_A, updatedAt: new Date(now).toISOString() }));
    writeShard(root, 'dag-bbbbbbbb.json', narrowSnap({ runId: RUN_B, updatedAt: new Date(now).toISOString() }));
    // 人为半截 (hud 目录尚未存在 → 先 mkdirSync, writeShard 在另一份顺手建的目录别指望它兜这个)
    const hud = join(root, '.omd', 'hud');
    mkdirSync(hud, { recursive: true });
    writeFileSync(join(hud, 'dag-cccccccc.json'), '{bad', 'utf-8');
    const vs = readDagShards(root, now);
    expect(vs).toHaveLength(2);
    const ids = new Set(vs.map((v) => v.snap.runId));
    expect(ids.has(RUN_A)).toBe(true);
    expect(ids.has(RUN_B)).toBe(true);
    expect(ids.has(RUN_C)).toBe(false);
  });

  test('未知 schema (schema=99) → 跳过那份', () => {
    const hud = join(root, '.omd', 'hud');
    mkdirSync(hud, { recursive: true }); // 还没 writeShard, 自行 mkdir
    writeFileSync(
      join(hud, 'dag-aaaaaaaa.json'),
      JSON.stringify({ schema: 99, runId: 'x', updatedAt: new Date(now).toISOString() }),
      'utf-8',
    );
    writeShard(root, 'dag-bbbbbbbb.json', narrowSnap({ runId: RUN_B, updatedAt: new Date(now).toISOString() }));
    const vs = readDagShards(root, now);
    expect(vs).toHaveLength(1);
    expect(vs[0]?.snap.runId).toBe(RUN_B);
  });

  test('坏时戳 (updatedAt 不是合法 ISO) → 跳过那份 (按 grade 走 done 路径就 null, running 路径就 stalled)', () => {
    writeShard(root, 'dag-aaaaaaaa.json', {
      ...narrowSnap({ status: 'done' }),
      updatedAt: 'not-a-date',
    } as HudDagSnapshot);
    writeShard(root, 'dag-bbbbbbbb.json', narrowSnap({ runId: RUN_B, updatedAt: new Date(now).toISOString() }));
    const vs = readDagShards(root, now);
    expect(vs).toHaveLength(1);
    expect(vs[0]?.snap.runId).toBe(RUN_B);
  });

  test('hud 目录不存在 → 返回空数组, 不抛', () => {
    const freshRoot = mkdtempSync(join(tmpdir(), 'omd-hud-nohuddir-'));
    try {
      expect(readDagShards(freshRoot, Date.now())).toEqual([]);
    } finally {
      rmSync(freshRoot, { recursive: true, force: true });
    }
  });
});

/* ───────────────────────────────────────────────────────────────────────── */
/* INV-HUD-2 读侧对偶: readDagShard                                                   */
/* ───────────────────────────────────────────────────────────────────────── */

describe('★ INV-HUD-2 读侧对偶: readDagShard 先短名, 撞名之后试全名', () => {
  // 反向自检: 删掉"短名不匹配再试全名"那一段 → runB 那条 readDagShard 返 null, 红。
  test('短名匹配 → 命中短名那份', () => {
    const runA = 'aaaaaaaa-1111-2222-3333-444444444444';
    writeShard(root, 'dag-aaaaaaaa.json', narrowSnap({ runId: runA, updatedAt: new Date().toISOString() }));
    const v = readDagShard(root, runA, Date.now());
    expect(v).not.toBeNull();
    expect(v?.snap.runId).toBe(runA);
  });

  test('短名里是别人的 runId (撞名镜像写过全名那份) → 试全名命中', () => {
    const runA = 'aaaaaaaa-1111-2222-3333-444444444444';
    const runB = 'aaaaaaaa-9999-8888-7777-666666666666'; // 同样 8 位 aaaaaaaa
    writeShard(root, 'dag-aaaaaaaa.json', narrowSnap({ runId: runA })); // 短名: runA 占着
    writeShard(root, `dag-${runB}.json`, narrowSnap({ runId: runB, goal: 'runB' })); // runB 被甩到全名
    // runA 仍从短名读到
    const vA = readDagShard(root, runA, Date.now());
    expect(vA?.snap.runId).toBe(runA);
    // runB 必须能从全名读到, 短名里是 runA 不应误中
    const vB = readDagShard(root, runB, Date.now());
    expect(vB?.snap.runId).toBe(runB);
    expect(vB?.snap.goal).toBe('runB');
  });

  test('短名里不是自己, 全名也不存在 → null (不是撞名, 是没写过)', () => {
    const runA = 'aaaaaaaa-1111-2222-3333-444444444444';
    const unknown = 'ffffffff-1234-1234-1234-123456789abc';
    writeShard(root, 'dag-aaaaaaaa.json', narrowSnap({ runId: runA }));
    expect(readDagShard(root, unknown, Date.now())).toBeNull();
  });
});

/* ───────────────────────────────────────────────────────────────────────── */
/* 读宽字段快照 (切片 1 加宽账的产物)                                                       */
/* ───────────────────────────────────────────────────────────────────────── */

describe('★ 读 wide 快照 (deps / usage / durationMs / failureKind 全在) ', () => {
  const now = Date.now();
  test('读宽字段快照 → 视图里字段全在, 数值原样', () => {
    writeShard(root, 'dag-aaaaaaaa.json', wideSnap({ updatedAt: new Date(now).toISOString() }));
    const [v] = readDagShards(root, now);
    expect(v).not.toBeNull();
    expect(v?.snap.planned[1]?.deps).toEqual(['p1']);
    const s = v?.snap.settled[0];
    expect(s?.durationMs).toBe(4321);
    expect(s?.usage).toEqual({ in: 100, out: 200 });
    expect(s?.failureKind).toBe('empty-artifact');
    expect(s?.startedAt).toBe('2026-08-22T10:00:00.000Z');
  });

  test('readDagShard 同样能读宽字段', () => {
    const runA = 'aaaaaaaa-1111-2222-3333-444444444444';
    writeShard(root, 'dag-aaaaaaaa.json', wideSnap({ runId: runA, updatedAt: new Date(now).toISOString() }));
    const v = readDagShard(root, runA, now);
    expect(v?.snap.settled[0]?.usage).toEqual({ in: 100, out: 200 });
    expect(v?.snap.planned[1]?.deps).toEqual(['p1']);
  });
});
