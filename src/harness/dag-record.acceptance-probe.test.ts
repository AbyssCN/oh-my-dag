/**
 * acceptance_probe 列的**集成面** (goal 验收探针, 2026-08-02) —— 写 → 存 → 读 → 读数板, 一条链。
 *
 * 探针裁决 (`AcceptanceProbe`, 词表在 `goal/acceptance.ts`) 只由 entry='dag_goal' 的
 * `recordDagRun` 随 record 落盘。这条文件在**同一个 :memory: 连接**上把整条生产链跑一遍:
 *
 *  ① 迁移面: 老库 (无 acceptance_probe 列) 经 `createDagRecorder` 就地补列, 老行留 NULL;
 *  ② 正向:   dag_goal 的探针经**生产 recordDagRun** 落盘, 逐字紧凑 JSON 读得回来 (五条 kind 全过);
 *  ③ 反向自检: entry='dag_run' 及其余非 goal 入口**不许**拿到探针 —— SQL 层真 NULL;
 *  ④ NULL 两义: dag_goal+NULL (历史/未记) 与 dag_run+NULL (不适用) 都是 NULL, 但 entry
 *     把两格分得开; 读数板 (`readout`) 只把「dag_goal 且探针非 NULL」算进 G4 分母。
 *
 * 与 dag-record.test.ts / omd-readout.test.ts 同一套隔离姿势: 注入 `new Database(':memory:')`,
 * `readout` 与留痕器**共用同一连接** (两个 :memory: 连接互不相通)。
 *
 * ⚠ 断言纪律: 正向/反向/NULL 的证明**全部走生产 recorder** (`recordDagRun` / `rec.record`) +
 * 其读回 (`get` / `listByRun`) + `readout`; 原始 SQL 只用于**检查落盘值** (`rawProbe`) 与两处
 * 没有生产路径、不得不手工造的坏行 (老表结构 / 坏 JSON —— 写坏 JSON 没有合法入口, 只能 INSERT)。
 */
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createDagRecorder, recordDagRun } from './dag-record';
import type { ExecutorDagResult } from './dag/types';
import type { AcceptanceProbe } from './goal/acceptance-gate';
import { readout } from '../../scripts/omd-readout';

/** 最小可记的一张图结果 (只填 record 真读的那几个字段) —— 与 dag-record.test.ts 同款。 */
const fakeResult = (planName: string): ExecutorDagResult =>
  ({
    plan: { name: planName, nodes: { a: { goal: 'x' } } },
    levels: [['a']],
    results: { a: { id: 'a', kind: 'inproc', status: 'done', deps: [], output: '', usage: { in: 1, out: 1 } } },
    reusedNodes: [],
    usage: { conductor: { in: 10, out: 20 }, leavesIn: 100, leavesOut: 50, leavesCacheHit: 0 },
  }) as unknown as ExecutorDagResult;

/** 直接读 SQL 列原文 —— 证明的是**落盘值**, 不是 TS 读回 (后者已经过 rowToRecord 解释)。 */
const rawProbe = (db: Database, id: string): string | null =>
  (db.query(`SELECT acceptance_probe FROM omd_dag_runs WHERE id = ?`).get(id) as { acceptance_probe: string | null })
    .acceptance_probe;

/** 五条终局全量 (vacuity-only 的 why 有/无都算) —— why 原话取 acceptance.ts 的冻结文本。 */
const ALL_KINDS: AcceptanceProbe[] = [
  { kind: 'passed-both' },
  { kind: 'vacuity-only' },
  { kind: 'vacuity-only', why: '[omd/goal] 分类器没给反面样本 → 判别力探针跳过 (这条判据只过了空世界自检)' },
  { kind: 'demoted', why: 'command_block' },
  { kind: 'skipped', why: '无分类器 (缺 generate/model)' },
  { kind: 'exploratory' },
];

describe('迁移 · 老库就地补 acceptance_probe 列', () => {
  test('加列之前的表 (无此列) 经 createDagRecorder 补列; 老行读回「没记」, 新行照常写', () => {
    const db = new Database(':memory:');
    // 逐字重建 2026-08-02 探针列加入之前的表结构 —— `CREATE TABLE IF NOT EXISTS` 对已存在的表
    // 一个字都不改, 少了这个 ALTER, 任何早建过库的机器都会在第一次 INSERT 上崩。
    db.run(`
      CREATE TABLE omd_dag_runs (
        id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, plan_name TEXT NOT NULL,
        node_count INTEGER NOT NULL, question TEXT, run_id TEXT, levels TEXT NOT NULL,
        nodes TEXT NOT NULL, usage TEXT NOT NULL,
        observations TEXT, outcome TEXT, verification TEXT, reused INTEGER, criteria TEXT, entry TEXT
      )
    `);
    // 老行: 探针列**根本不存在** —— 不是"写了 NULL", 迁移后它读出来就是「没记」那一格。
    db.run(`INSERT INTO omd_dag_runs (id, created_at, plan_name, node_count, question, run_id, entry, levels, nodes, usage)
            VALUES ('old-goal', 1, '老图', 1, NULL, 'g-old', 'dag_goal', '[]', '[]', '{}')`);

    const rec = createDagRecorder({ db }); // 真迁移路径: PRAGMA 查列 → ALTER ADD COLUMN
    const cols = (db.query(`PRAGMA table_info(omd_dag_runs)`).all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain('acceptance_probe');

    const old = rec.get('old-goal')!;
    expect(old.entry).toBe('dag_goal');
    expect(old.acceptanceProbe).toBeUndefined(); // 没记 —— 不是任何编出来的分支
    expect(rawProbe(db, 'old-goal')).toBeNull(); // 列补出来了, 老行那格真 NULL

    // 补列之后新 dag_goal 带探针照常写得进去。
    const fresh = rec.record(fakeResult('goal-contract'), {
      runId: 'g-new', entry: 'solve', now: 2, acceptanceProbe: { kind: 'passed-both' },
    });
    expect(rec.get(fresh)!.acceptanceProbe).toEqual({ kind: 'passed-both' });
    rec.close();
  });

  test('readout 不迁移: 无此列的老表上只 SELECT, 探针整列读成 NULL, G4 分母为零, 不炸', () => {
    const db = new Database(':memory:');
    db.run(`CREATE TABLE omd_dag_runs (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, plan_name TEXT NOT NULL,
            node_count INTEGER NOT NULL, question TEXT, run_id TEXT, levels TEXT NOT NULL, nodes TEXT NOT NULL,
            usage TEXT NOT NULL, observations TEXT, outcome TEXT, verification TEXT, reused INTEGER, criteria TEXT, entry TEXT)`);
    db.run(`INSERT INTO omd_dag_runs (id, created_at, plan_name, node_count, run_id, entry, levels, nodes, usage)
            VALUES ('old-1', 1, '老图', 1, 'g1', 'dag_goal', '[]', '[]', '{}')`);
    const r = readout({ db }); // readout 自己只 SELECT, 缺列补 NULL AS —— 历史路径的数据前提
    expect(r.runs[0]!.acceptanceProbe).toBeNull();
    expect(r.g4_sampling).toEqual({ denominator: 0, passedBoth: 0, vacuityOnly: 0, demoted: 0, skipped: 0, exploratory: 0 });
    db.close();
  });
});

describe('dag_goal · 探针经生产 recordDagRun 落盘, 逐字读回 (正向)', () => {
  test('五条 kind (含 why 有/无) 全部 round-trip: TS 读回 = 原对象, SQL 列 = 紧凑 JSON, 无双编码', async () => {
    const db = new Database(':memory:');
    const rec = createDagRecorder({ db });
    for (const [i, probe] of ALL_KINDS.entries()) {
      const hook = recordDagRun(rec, { runId: `g-${i}`, entry: 'solve', acceptanceProbe: probe });
      await hook(fakeResult('goal-contract'));
      const [row] = rec.listByRun(`g-${i}`);
      expect(row!.acceptanceProbe).toEqual(probe); // 读回 = 原对象 (词表内确切形状)
      expect(rawProbe(db, row!.id)).toBe(JSON.stringify(probe)); // 逐字紧凑 JSON —— 无双编码/无多余键
      // 盘上原话 JSON.parse 回来整份深比 (why 里的引号/中文在 stringify 后不丢字)。
      expect(JSON.parse(rawProbe(db, row!.id)!)).toEqual(probe);
    }
    rec.close();
  });

  test('一次 goal 两段图 (契约/执行) 带同一份探针; 读数板按 runId 归并, 分母只计一次', async () => {
    const db = new Database(':memory:');
    const rec = createDagRecorder({ db });
    const probe: AcceptanceProbe = { kind: 'demoted', why: 'command_block' };
    const hook = recordDagRun(rec, { runId: 'g1', entry: 'solve', acceptanceProbe: probe });
    await hook(fakeResult('goal-contract'));
    await hook(fakeResult('goal-execute'));
    const both = rec.listByRun('g1');
    expect(both).toHaveLength(2);
    for (const r of both) {
      expect(r.acceptanceProbe).toEqual(probe);
      expect(rawProbe(db, r.id)).toBe(JSON.stringify(probe)); // 两段都落盘
    }
    const run = readout({ db }).runs.find((x) => x.run_id === 'g1')!;
    expect(run.attempts).toBe(2);
    expect(run.acceptanceProbe).toEqual(probe); // 归并后仍是那一份
    const g = readout({ db }).g4_sampling;
    expect(g.denominator).toBe(1); // ★ 一次 goal 只进一次分母, 不许按行数算成 2
    expect(g.demoted).toBe(1);
    rec.close();
  });
});

describe('缺席 → SQL NULL (历史/未记), 不是任何编出来的分支', () => {
  test('dag_goal 但探针没跑 (没传) → 列 NULL, 读回缺席', async () => {
    const db = new Database(':memory:');
    const rec = createDagRecorder({ db });
    await recordDagRun(rec, { runId: 'g-noprobe', entry: 'solve', question: 'x' })(fakeResult('goal-contract'));
    const [row] = rec.listByRun('g-noprobe');
    expect(row!.acceptanceProbe).toBeUndefined();
    expect(rawProbe(db, row!.id)).toBeNull();
    rec.close();
  });

  test('连 meta 都没有的裸 record → 同 NULL (图外调用方不欠探针)', () => {
    const db = new Database(':memory:');
    const rec = createDagRecorder({ db });
    const id = rec.record(fakeResult('/audit'));
    expect(rec.get(id)!.acceptanceProbe).toBeUndefined();
    expect(rawProbe(db, id)).toBeNull();
    rec.close();
  });
});

describe('反向自检 · 非 dag_goal 入口不许拿到 acceptance_probe', () => {
  test('dag_run / dag_run_plan / dag_resume / path_deliver → SQL 层真 NULL, TS 读回缺席', async () => {
    const db = new Database(':memory:');
    const rec = createDagRecorder({ db });
    const entries = ['run', 'dag_run_plan', 'dag_resume', 'map_deliver'] as const;
    for (const entry of entries) {
      await recordDagRun(rec, { runId: `r-${entry}`, entry, question: '图', acceptanceProbe: { kind: 'passed-both' } })(fakeResult(entry));
    }
    for (const entry of entries) {
      const [row] = rec.listByRun(`r-${entry}`);
      expect(row!.acceptanceProbe).toBeUndefined();
      expect(rawProbe(db, row!.id)).toBeNull(); // ★ 反向自检钉的就是这一格: 列必须真 NULL
    }
    rec.close();
  });

  test('同一连接上先落带探针的 goal、紧邻再落 dag_run —— 探针不串行', async () => {
    const db = new Database(':memory:');
    const rec = createDagRecorder({ db });
    await recordDagRun(rec, { runId: 'g1', entry: 'solve', acceptanceProbe: { kind: 'passed-both' } })(fakeResult('goal-contract'));
    await recordDagRun(rec, { runId: 'r1', entry: 'run' })(fakeResult('plain-run'));
    expect(rawProbe(db, rec.listByRun('g1')[0]!.id)).toBe('{"kind":"passed-both"}');
    expect(rawProbe(db, rec.listByRun('r1')[0]!.id)).toBeNull(); // 同库、紧邻写入, 仍 NULL
    rec.close();
  });
});

describe('NULL 两义 · 同一列 NULL, 两种含义, entry 分得开', () => {
  test('dag_goal+NULL (历史/未记) 与 dag_run+NULL (不适用) 在读数板上都能认回各自入口, 都进不了分母', async () => {
    const db = new Database(':memory:');
    const rec = createDagRecorder({ db });
    await recordDagRun(rec, { runId: 'g-hist', entry: 'solve', question: '老 goal' })(fakeResult('goal-contract'));
    await recordDagRun(rec, { runId: 'r1', entry: 'run' })(fakeResult('plain-run'));
    const r = readout({ db });
    const goal = r.runs.find((x) => x.run_id === 'g-hist')!;
    const run = r.runs.find((x) => x.run_id === 'r1')!;
    // 两格在列上都是 NULL (都没记探针) —— 但含义不同: 「没记」vs「不适用」, 读数板按 entry 念, 不猜值。
    expect(goal.entry).toBe('solve');
    expect(run.entry).toBe('run');
    expect(goal.acceptanceProbe).toBeNull();
    expect(run.acceptanceProbe).toBeNull();
    // 两种 NULL 都进不了 G4 分母 —— 分母只认「dag_goal 且探针非 NULL」, 没有 'unknown' 桶。
    expect(r.g4_sampling.denominator).toBe(0);
    expect(r.g4_sampling).toEqual({ denominator: 0, passedBoth: 0, vacuityOnly: 0, demoted: 0, skipped: 0, exploratory: 0 });
    rec.close();
  });
});

describe('readout · G4 采样: 五条 kind → 三个展示桶, 每 run 一次', () => {
  test('分母 = dag_goal 且探针非 NULL 的 run; exploratory = demoted + skipped + exploratory', async () => {
    const db = new Database(':memory:');
    const rec = createDagRecorder({ db });
    // 六条带探针的 goal + 一条历史 NULL goal + 一条 dag_run (反向) —— 后两条不许进分母。
    const probes: { runId: string; probe: AcceptanceProbe }[] = [
      { runId: 'g-passed', probe: { kind: 'passed-both' } },
      { runId: 'g-vac-noy', probe: { kind: 'vacuity-only' } },
      { runId: 'g-vac-why', probe: { kind: 'vacuity-only', why: '[omd/goal] 分类器没给反面样本 → 判别力探针跳过 (这条判据只过了空世界自检)' } },
      { runId: 'g-demoted', probe: { kind: 'demoted', why: 'command_block' } },
      { runId: 'g-skipped', probe: { kind: 'skipped', why: '无分类器 (缺 generate/model)' } },
      { runId: 'g-expl', probe: { kind: 'exploratory' } },
    ];
    for (const { runId, probe } of probes) {
      await recordDagRun(rec, { runId, entry: 'solve', acceptanceProbe: probe })(fakeResult('goal-contract'));
    }
    await recordDagRun(rec, { runId: 'g-hist', entry: 'solve', question: 'x' })(fakeResult('goal-contract'));
    await recordDagRun(rec, { runId: 'r1', entry: 'run' })(fakeResult('plain-run'));

    const g = readout({ db }).g4_sampling;
    expect(g).toEqual({ denominator: 6, passedBoth: 1, vacuityOnly: 2, demoted: 1, skipped: 1, exploratory: 3 });
    // exploratory 展示桶 = demoted + skipped + exploratory 三 kind 之和 (两条分支最终 acceptance 都是探索型)。
    expect(g.exploratory).toBe(g.demoted + g.skipped + 1);
    rec.close();
  });
});

describe('readout · 同 runId 多次 attempt 的探针归并', () => {
  test('归并 = 首个非 NULL 探针 (按 created_at); 两段带不同探针时取最早那段', async () => {
    const db = new Database(':memory:');
    const rec = createDagRecorder({ db });
    // 两段都带探针且**不同**: 归并取最早那段 (created_at 100), 不许挑后写的。
    rec.record(fakeResult('goal-contract'), { runId: 'g-merge', entry: 'solve', now: 100, acceptanceProbe: { kind: 'passed-both' } });
    rec.record(fakeResult('goal-execute'), { runId: 'g-merge', entry: 'solve', now: 200, acceptanceProbe: { kind: 'exploratory' } });
    // 第一段没探、第二段才有 → 归并 = 第二段 (首个非 NULL, 不是"最早那条记录")。
    rec.record(fakeResult('goal-contract'), { runId: 'g-late', entry: 'solve', now: 300 });
    rec.record(fakeResult('goal-execute'), { runId: 'g-late', entry: 'solve', now: 400, acceptanceProbe: { kind: 'skipped', why: '分类调用或解析失败' } });

    const runs = readout({ db }).runs;
    expect(runs.find((x) => x.run_id === 'g-merge')!.acceptanceProbe).toEqual({ kind: 'passed-both' });
    expect(runs.find((x) => x.run_id === 'g-late')!.acceptanceProbe).toEqual({ kind: 'skipped', why: '分类调用或解析失败' });
    rec.close();
  });
});

/**
 * ⚠ 这一组原本断言的是**反过来的行为**(「窗口外的探针不进分母」), 2026-08-03 当天改掉。
 *
 * 那是 T11 那一跑随新列一起产出的, 逻辑上自洽 —— 但它把**闸的判据**搭在了**展示窗口**上。
 * run 表按冻结契约只显示「最早 limit 个」, 于是历史 run 一超过 limit,
 * **以后每跑一次都落在窗口外**, G4 的采样分母永远停在同一个数, 而板上看不出它停了。
 * 同一个坑当天先咬了 G3 的分母一次 (连跑三次 live, `--limit 20` 下 entry 分布一动不动)。
 *
 * 现在的契约是**展示归展示, 判据归判据**: 窗口只截那张 run 表, `g4_sampling` 与
 * `gate_denominators` 一律全量。窗口本身没改 —— 它是刻意钉死的截断端, 不动。
 */
describe('readout · 闸的采样分母不受展示窗口截断', () => {
  test('探针 run 落在展示窗口外, 分母照样含它 (窗口只截 runs 表)', () => {
    const db = new Database(':memory:');
    const rec = createDagRecorder({ db });
    rec.record(fakeResult('a'), { runId: 'r1', entry: 'run', now: 100 });
    rec.record(fakeResult('b'), { runId: 'r2', entry: 'run', now: 200 });
    rec.record(fakeResult('c'), { runId: 'g1', entry: 'solve', now: 300, acceptanceProbe: { kind: 'passed-both' } });
    // limit=2 → runs 表只显示最早两条 (r1/r2), 但 g1 的探针**必须**照样进分母。
    expect(readout({ db, limit: 2 }).runs.map((x) => x.run_id)).toEqual(['r1', 'r2']); // 窗口确实截了
    expect(readout({ db, limit: 2 }).g4_sampling.denominator).toBe(1); // …而判据没跟着缩
    expect(readout({ db, limit: 3 }).g4_sampling.denominator).toBe(1);
    rec.close();
  });
});

describe('坏行 (读路径) · 词表外形状一律按 NULL 读, 不编桶, 不炸整块板', () => {
  test('坏 JSON / JSON null / unknown kind / 多余键 / why 非字符串 / demoted 缺 why → recorder 缺席, readout NULL', () => {
    const db = new Database(':memory:');
    const rec = createDagRecorder({ db });
    // 写坏 JSON 没有生产入口 (record 永远 stringify 合法对象) —— 只能直接 INSERT 模拟写坏的库。
    const bad = [
      '{oops',                              // 坏 JSON
      'null',                               // JSON null
      '{"kind":"unknown"}',                 // 词表外 kind
      // ⚠ `{"kind":"passed-both","why":"x"}` **2026-08-19 (#204) 从坏形状挪走了**: 那一格现在合法 ——
      // `why` 装「零判别力的判据段」与「反面世界降级过」两类附注 (探针过了, 但这次过得值多少钱)。
      // 契约扩的是可选字段, 旧记录 (无 why) 照样解析, 所以这是兼容扩展不是破坏。
      // 坏形状那一侧改由下面这条守: why 在但**不是字符串**照旧拒。
      '{"kind":"passed-both","why":123}',   // why 非字符串 (数字不许进盘)
      '{"kind":"vacuity-only","why":null}', // why 非字符串 (null 不许进盘)
      '{"kind":"demoted"}',                 // demoted 缺 why (形状不对)
    ];
    for (const [i, raw] of bad.entries()) {
      db.run(
        `INSERT INTO omd_dag_runs (id, created_at, plan_name, node_count, question, run_id, entry, levels, nodes, usage, observations, outcome, verification, reused, criteria, acceptance_probe)
         VALUES (?, ?, '坏探针', 1, NULL, ?, 'dag_goal', '[["a"]]', '[]', '{}', NULL, NULL, NULL, NULL, NULL, ?)`,
        [`bad-${i}`, 100 + i, `g-bad-${i}`, raw],
      );
    }
    // recorder 读回: 词表外一律 undefined (= 未记录)。
    for (let i = 0; i < bad.length; i++) {
      expect(rec.get(`bad-${i}`)!.acceptanceProbe).toBeUndefined();
    }
    // readout 读回: NULL, 不进 G4 分母, 不发明 'unknown' 桶, 也不崩。
    const r = readout({ db });
    for (const run of r.runs) expect(run.acceptanceProbe).toBeNull();
    expect(r.g4_sampling).toEqual({ denominator: 0, passedBoth: 0, vacuityOnly: 0, demoted: 0, skipped: 0, exploratory: 0 });
    rec.close();
  });
});
