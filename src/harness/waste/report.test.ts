/**
 * src/harness/waste/report.test.ts —— 浪费尺子 (C-2, 2026-08-20) 的反向闸。
 *
 * 三条 GWT 钉死三件事:
 *   · **GWT-2a**  对照式反向闸 — F-clean 上**应该** value===0;上一轮代理实现
 *     (kind/reused/deps) 在 F-clean 上会给出 > 0 → 这条让代理实现立刻红。
 *     F-waste 上**应该** value > 0;代理实现若把「所有非 reused」当浪费,F-waste
 *     会跑出 1.0,与真值偏离。两条对照把"代理恒真"的空间打掉。
 *   · GWT-2b  缺数据 → value=null + missingColumns (INV-5),不编 0;
 *   · GWT-2c  CLI 把 INV-6 那行覆盖边界**字面**印出。
 *
 * ⚠ 已知上下游债 (留给后续闸环, 不在本节点修, 本节点只测 `computeWaste` 契约):
 *   · `src/harness/dag/dag-record.ts` 的 recorder (A 片独占) 暂未把 `dagRound` /
 *     `overriddenBy` 透到 JSON `nodes` 字段 —— 真表里这两个键缺席,
 *     `nodeWasteTokens` 在生产数据上必然 value=null。`report.ts` 已经按契约报
 *     unknown + missingColumns,**没有**回退到代理 (那正是 GWT-2a 防的回潮);
 *   · engine.ts 的 agent 路径上 `injectedTokens` 仍写 null → `handoffTax`
 *     也偏 unknown 偏多,等采集片接上即可,与本测试无关。
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { computeWaste, readDagRuns } from './report';
import type { DagRunNode, DagRunRecord } from '../dag/dag-record';

/** 仓根 (脚本路径从这里解析,跨 cwd 也行)。 */
const REPO_ROOT = join(import.meta.dir, '..', '..', '..');
/** mkdtemp 临时夹具根 — afterAll 清掉。 */
const TMP_ROOT = mkdtempSync(join(tmpdir(), 'omd-waste-test-'));

afterAll(() => {
  rmSync(TMP_ROOT, { recursive: true, force: true });
});

/** 满 schema —— 镜像 dag-record.ts 的 CREATE TABLE。readDagRuns 只读 levels/nodes,
 *  所以列够用即可 (C-1 五列也写上,与真表一致,见 GWT-2b 「旧库」对照)。 */
const FULL_SCHEMA = `
  CREATE TABLE omd_dag_runs (
    id              TEXT PRIMARY KEY,
    created_at      INTEGER NOT NULL,
    plan_name       TEXT NOT NULL,
    node_count      INTEGER NOT NULL,
    question        TEXT,
    run_id          TEXT,
    entry           TEXT,
    levels          TEXT NOT NULL,
    nodes           TEXT NOT NULL,
    usage           TEXT NOT NULL,
    tokens_in       INTEGER,
    tokens_out      INTEGER,
    cache_hit_tokens INTEGER,
    duration_ms     INTEGER,
    turns           INTEGER
  )
`;

/** 老库 schema —— 没有 C-1 五列,模拟 2026-08-19 之前的真表。 */
const LEGACY_SCHEMA = `
  CREATE TABLE omd_dag_runs (
    id              TEXT PRIMARY KEY,
    created_at      INTEGER NOT NULL,
    plan_name       TEXT NOT NULL,
    node_count      INTEGER NOT NULL,
    question        TEXT,
    run_id          TEXT,
    entry           TEXT,
    levels          TEXT NOT NULL,
    nodes           TEXT NOT NULL,
    usage           TEXT NOT NULL
  )
`;

/**
 * `report.ts` 用 `hasAnyDataField` 判列"存不存在":任何节点上有该字段且为 number 即算存在。
 * `DagRunNode` 接口本身没声明 dagRound/overriddenBy (A 片独占那片 schema,见 `report.ts:43`),
 * 这里局部扩展用于造夹具。语义:
 *   · dagRound     跨轮身份 — 同一 id 在不同轮上各落一条,值 = 引擎外层轮号
 *   · overriddenBy 上一轮同 id 节点被本轮覆盖时被落上的轮号;末轮同 id 不设 (= undefined)
 *   · 0 是合法"存在但未被覆盖"值,`> 0` 才算被覆盖
 */
type DagRunNodeX = DagRunNode & {
  dagRound?: number;
  overriddenBy?: number;
};

interface SeedRow {
  id: string;
  planName: string;
  levels: string[][];
  nodes: DagRunNodeX[];
}

/** 把一组 run 写入临时 sqlite 库。 */
function seedDb(dbPath: string, schema: string, rows: SeedRow[]): void {
  const db = new Database(dbPath);
  db.run(schema);
  for (const r of rows) {
    db.run(
      `INSERT INTO omd_dag_runs
         (id, created_at, plan_name, node_count, run_id, levels, nodes, usage)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        r.id,
        Date.now(),
        r.planName,
        r.nodes.length,
        null,
        JSON.stringify(r.levels),
        JSON.stringify(r.nodes),
        JSON.stringify({ conductorIn: 0, conductorOut: 0, leavesIn: 0, leavesOut: 0, leavesCacheHit: 0 }),
      ],
    );
  }
  db.close();
}

/** 把 SeedRow 直接喂给 computeWaste (GWT-2a 用,避免再 round-trip 过 sqlite)。 */
function asRecord(r: SeedRow): DagRunRecord {
  return {
    id: r.id,
    createdAt: 0,
    planName: r.planName,
    nodeCount: r.nodes.length,
    question: null,
    runId: null,
    levels: r.levels,
    nodes: r.nodes as DagRunNode[],
    usage: { conductorIn: 0, conductorOut: 0, leavesIn: 0, leavesOut: 0, leavesCacheHit: 0 },
  };
}

describe('C-2 浪费尺子 (report.ts) 反向闸', () => {
  // ─────────────────────────────────────────────────────────────────────────
  // GWT-2a — 对照式反向闸
  //   上一轮代理判据 (「非 reused 节点 / 有 deps 的节点」) 在「多轮里全 reused」和
  //   「无 deps」的夹具上会给出 > 0,与真值偏离 → 等于没闸。F-clean + F-waste 对照
  //   把代理恒真的空间打掉。
  //
  // 关键实装契约 (C-2):
  //   · nodeWasteTokens 读 dagRound + overriddenBy;任一缺 → value=null + 整跑 unknownRuns
  //     + missingColumns 列名。**严禁**用「非 reused leaf」「deps 非空」代理顶替。
  //   · handoffTax 读 injectedTokens;缺 → value=null + 整跑 unknownRuns。
  //   · hasAnyDataField 判 "列存在":**任何**节点字段是 number 即 true (0 是合法存在)。
  //
  // 证伪方式 (a): 把 `hasDagRound || hasOverriddenBy` 那个 null 分支去掉,改成
  //   「非 reused 节点 tokensIn / 全图」代理 → F-clean 上会有 reused:false 节点,
  //   代理会给出 > 0 → 红 (F-clean.value===0 失败)。
  // 证伪方式 (b): 把 handoffTax 改成「deps 非空的 tokensIn / 全图」代理 → F-clean 上
  //   有 deps 节点,代理给出 > 0 → 红 (F-clean.value===0 失败)。
  // 证伪方式 (c): 把 `if (typeof ovr === 'number' && ovr > 0)` 改成 `typeof ovr === 'number'`
  //   → F-clean 上所有节点 overriddenBy:0 会被当成"被覆盖" → wastedTokens > 0 → 红
  //   (F-clean.nodeWasteTokens.value===0 失败)。
  // 证伪方式 (d): 把 `if (!hasInjected)` 分支去掉,直接跑循环,F-clean 上 injectedTokens:0
  //   是 number 不进 unknown,handoffTokensAll=0,value=0 — 这条不会红 (因为 0/正=0),
  //   所以 F-clean 验 0 不验 null 是有意义的边界 (代理会把 deps 非空算进 → 红)。
  // ─────────────────────────────────────────────────────────────────────────
  describe('GWT-2a — 对照式反向闸 (F-clean 必须 value===0, F-waste 必须 value>0)', () => {
    test('F-clean: 多轮全新节点 + injectedTokens 全 0 → nodeWasteTokens.value === 0 且 handoffTax.value === 0', () => {
      // 3 轮 (rounds=3, maxRounds=5),但每轮节点 id 都不同 — 引擎跨轮身份层没有任何
      // 同 id 重出 → 不该有 overriddenBy 标记 → 分子 = 0。injectedTokens 全部 0 → 分子 = 0。
      // 给 overriddenBy:0 + injectedTokens:0 是让 hasAnyDataField 判 "列存在"
      // (0 是 number) — 否则值是 null 而不是 0,与契约期望不符。
      const nodes: DagRunNodeX[] = [
        { id: 'c', kind: 'conductor', status: 'ok', deps: [], rounds: 3, maxRounds: 5 },
        { id: 'a1', kind: 'leaf', status: 'ok', deps: [], tokensIn: 100, dagRound: 1, overriddenBy: 0, injectedTokens: 0 },
        { id: 'b1', kind: 'leaf', status: 'ok', deps: [], tokensIn: 200, dagRound: 1, overriddenBy: 0, injectedTokens: 0 },
        { id: 'a2', kind: 'leaf', status: 'ok', deps: [], tokensIn: 100, dagRound: 2, overriddenBy: 0, injectedTokens: 0 },
        { id: 'b2', kind: 'leaf', status: 'ok', deps: [], tokensIn: 200, dagRound: 2, overriddenBy: 0, injectedTokens: 0 },
        { id: 'a3', kind: 'leaf', status: 'ok', deps: [], tokensIn: 100, dagRound: 3, overriddenBy: 0, injectedTokens: 0 },
        { id: 'b3', kind: 'leaf', status: 'ok', deps: [], tokensIn: 200, dagRound: 3, overriddenBy: 0, injectedTokens: 0 },
      ];
      const report = computeWaste([asRecord({
        id: 'f-clean', planName: 'clean', levels: [['c'], ['a1', 'b1'], ['a2', 'b2'], ['a3', 'b3']], nodes,
      })]);
      // 核心断言:契约正确实现下,这两条必须是**零**(不是 null)
      expect(report.nodeWasteTokens.value).toBe(0);
      expect(report.handoffTax.value).toBe(0);
      // 列真存在 — missingColumns 不该列这三个名
      expect(report.missingColumns).not.toContain('dagRound');
      expect(report.missingColumns).not.toContain('overriddenBy');
      expect(report.missingColumns).not.toContain('injectedTokens');
      // 没浪费 → 跑贡献了数
      expect(report.nodeWasteTokens.n).toBe(1);
      expect(report.nodeWasteTokens.unknownRuns).toBe(0);
      expect(report.handoffTax.n).toBe(1);
      expect(report.handoffTax.unknownRuns).toBe(0);
    });

    test('F-waste: 同身份跨轮首轮被覆盖 + 下游有注入 → nodeWasteTokens.value > 0 且 handoffTax.value > 0', () => {
      // 2 轮,round 1 的 a 被 round 2 同 id 覆盖 → overriddenBy=2 → 浪费 tokensIn(a@r1)=100。
      // round 1/2 的 b 都有 deps=['a'] + injectedTokens>0 → handoffTax 分子 > 0。
      const nodes: DagRunNodeX[] = [
        { id: 'c', kind: 'conductor', status: 'ok', deps: [], rounds: 2, maxRounds: 5 },
        { id: 'a', kind: 'leaf', status: 'ok', deps: [], tokensIn: 100, dagRound: 1, overriddenBy: 2, injectedTokens: 50 },
        { id: 'b', kind: 'leaf', status: 'ok', deps: ['a'], tokensIn: 300, dagRound: 1, overriddenBy: 0, injectedTokens: 150 },
        { id: 'a', kind: 'leaf', status: 'ok', deps: [], tokensIn: 100, dagRound: 2, injectedTokens: 50 },
        { id: 'b', kind: 'leaf', status: 'ok', deps: ['a'], tokensIn: 300, dagRound: 2, injectedTokens: 150 },
      ];
      const report = computeWaste([asRecord({
        id: 'f-waste', planName: 'waste', levels: [['c'], ['a', 'b'], ['a', 'b']], nodes,
      })]);
      // 分子/分母验算:
      //   nodeWasteTokens: 浪费 = a@r1 (overriddenBy=2>0) = 100; 总 = 100+300+100+300 = 800
      //     → 100/800 = 0.125 > 0
      //   handoffTax: 注入 = 50+150+50+150 = 400; 总 tokensIn = 800 → 400/800 = 0.5 > 0
      expect(report.nodeWasteTokens.value).not.toBeNull();
      expect(report.nodeWasteTokens.value!).toBeGreaterThan(0);
      expect(report.handoffTax.value).not.toBeNull();
      expect(report.handoffTax.value!).toBeGreaterThan(0);
      // 数值钉死 — 防止「代理实现给出非直觉数」静默通过
      expect(report.nodeWasteTokens.value!).toBeCloseTo(100 / 800, 5);
      expect(report.handoffTax.value!).toBeCloseTo(400 / 800, 5);
    });

    test('F-clean + F-waste 在真 sqlite 库上跑一遍 (readDagRuns → computeWaste 整链) — 双断言', () => {
      // 验证 readDagRuns 解析 JSON 没把 dagRound/overriddenBy/injectedTokens 丢掉:
      // 与上一条用 asRecord 直喂对比,确保 db round-trip 后两个指标行为一致。
      const dbPath = join(TMP_ROOT, 'gwt-2a-fixtures.db');
      const clean: SeedRow = {
        id: 'f-clean',
        planName: 'clean',
        levels: [['c'], ['a1', 'b1'], ['a2', 'b2'], ['a3', 'b3']],
        nodes: [
          { id: 'c', kind: 'conductor', status: 'ok', deps: [], rounds: 3, maxRounds: 5 },
          { id: 'a1', kind: 'leaf', status: 'ok', deps: [], tokensIn: 100, dagRound: 1, overriddenBy: 0, injectedTokens: 0 },
          { id: 'b1', kind: 'leaf', status: 'ok', deps: [], tokensIn: 200, dagRound: 1, overriddenBy: 0, injectedTokens: 0 },
          { id: 'a2', kind: 'leaf', status: 'ok', deps: [], tokensIn: 100, dagRound: 2, overriddenBy: 0, injectedTokens: 0 },
          { id: 'b2', kind: 'leaf', status: 'ok', deps: [], tokensIn: 200, dagRound: 2, overriddenBy: 0, injectedTokens: 0 },
        ],
      };
      const waste: SeedRow = {
        id: 'f-waste',
        planName: 'waste',
        levels: [['c'], ['a', 'b'], ['a', 'b']],
        nodes: [
          { id: 'c', kind: 'conductor', status: 'ok', deps: [], rounds: 2, maxRounds: 5 },
          { id: 'a', kind: 'leaf', status: 'ok', deps: [], tokensIn: 100, dagRound: 1, overriddenBy: 2, injectedTokens: 50 },
          { id: 'b', kind: 'leaf', status: 'ok', deps: ['a'], tokensIn: 300, dagRound: 1, overriddenBy: 0, injectedTokens: 150 },
          { id: 'a', kind: 'leaf', status: 'ok', deps: [], tokensIn: 100, dagRound: 2, injectedTokens: 50 },
          { id: 'b', kind: 'leaf', status: 'ok', deps: ['a'], tokensIn: 300, dagRound: 2, injectedTokens: 150 },
        ],
      };
      seedDb(dbPath, FULL_SCHEMA, [clean, waste]);
      const records = readDagRuns(dbPath);
      expect(records.length).toBe(2);
      const report = computeWaste(records);
      // F-clean 跑贡献 nodeWasteTokens=0, handoffTax=0;F-waste 跑贡献 > 0。
      // F-clean tokensIn 总和 = 100+200+100+200 = 600 (4 leaf,a1/b1/a2/b2 各 100/200/100/200)。
      // 两跑合并:
      //   nodeWasteTokens: 浪费 = 0 (clean) + 100 (waste: a@r1 overriddenBy=2>0) = 100
      //     总 tokensIn = 600 + 800 = 1400 → 100/1400 ≈ 0.0714
      //   handoffTax: 注入 = 0 (clean) + 400 (waste) = 400;总 = 1400 → 400/1400 ≈ 0.2857
      expect(report.nodeWasteTokens.value).toBeCloseTo(100 / 1400, 5);
      expect(report.handoffTax.value).toBeCloseTo(400 / 1400, 5);
      expect(report.nodeWasteTokens.n).toBe(2);
      expect(report.handoffTax.n).toBe(2);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GWT-2b — 缺列不抛 + value=null + missingColumns 点名
  //
  // 契约 (INV-5):「没记」≠ 0 → value=null,跑数进 unknownRuns,列名进 missingColumns。
  //
  // 证伪方式 (a): 把 `value: ... : null` 改成 `value: 0` → 三个 ratio 全红 (null ≠ 0)。
  // 证伪方式 (b): 把 `tokensUnknown += 1` 改成 `tokensAll += runTokens` → unknownRuns=0,
  //   n=3 → 红。
  // 证伪方式 (c): readDagRuns 的 try/catch 改成 throw → records 抛异常 → expect 不通过。
  // 证伪方式 (d): missingColumns.push 行被删 → expect(...).toContain('dagRound') 红。
  // ─────────────────────────────────────────────────────────────────────────
  describe('GWT-2b — 老库缺数据列 → value=null + 全跑 unknownRuns + missingColumns 点名', () => {
    test('老库 (LEGACY_SCHEMA) + JSON 节点无新字段 → 三个 ratio value=null, n=0, unknownRuns=跑数, missingColumns 列名', () => {
      // 3 跑,每跑只一个最朴素的 leaf,没有任何 C-1 / dagRound / overriddenBy /
      // injectedTokens / cacheHitTokens 字段 → 老库的典型形态。
      const dbPath = join(TMP_ROOT, 'gwt-2b-legacy.db');
      const nodes: DagRunNodeX[] = [
        { id: 'a', kind: 'leaf', status: 'ok', deps: [] },
      ];
      seedDb(dbPath, LEGACY_SCHEMA, [
        { id: 'r1', planName: 'p', levels: [['a']], nodes },
        { id: 'r2', planName: 'p', levels: [['a']], nodes },
        { id: 'r3', planName: 'p', levels: [['a']], nodes },
      ]);
      const records = readDagRuns(dbPath);
      expect(records.length).toBe(3);
      const report = computeWaste(records);
      // 三个 ratio:n=0, unknownRuns=3, value=null
      expect(report.nodeWasteTokens.value).toBeNull();
      expect(report.nodeWasteTokens.n).toBe(0);
      expect(report.nodeWasteTokens.unknownRuns).toBe(3);
      expect(report.handoffTax.value).toBeNull();
      expect(report.handoffTax.n).toBe(0);
      expect(report.handoffTax.unknownRuns).toBe(3);
      expect(report.cacheHitRate.value).toBeNull();
      expect(report.cacheHitRate.n).toBe(0);
      expect(report.cacheHitRate.unknownRuns).toBe(3);
      // waveWidth 用 levels 算 — 不混在 unknownRuns
      expect(report.waveWidth.n).toBe(3);
      expect(report.waveWidth.unknownRuns).toBe(0);
      expect(report.waveWidth.value).toEqual([{ width: 1, runs: 3 }]);
      // missingColumns 点名四个缺列
      expect(report.missingColumns).toContain('dagRound');
      expect(report.missingColumns).toContain('overriddenBy');
      expect(report.missingColumns).toContain('injectedTokens');
      expect(report.missingColumns).toContain('cacheHitTokens');
    });

    test('readDagRuns on missing file → [] 不抛', () => {
      const records = readDagRuns(join(TMP_ROOT, 'does-not-exist.db'));
      expect(records).toEqual([]);
    });

    test('readDagRuns on empty DB (schema 在, 零行) → computeWaste 不抛, 三个 ratio value=null, unknownRuns=0', () => {
      const dbPath = join(TMP_ROOT, 'gwt-2b-empty.db');
      const db = new Database(dbPath);
      db.run(FULL_SCHEMA);
      db.close();
      const records = readDagRuns(dbPath);
      expect(records.length).toBe(0);
      const report = computeWaste(records);
      // 空库:unknownRuns=0 (因为没有跑),value=null
      expect(report.nodeWasteTokens.value).toBeNull();
      expect(report.nodeWasteTokens.unknownRuns).toBe(0);
      expect(report.handoffTax.value).toBeNull();
      expect(report.handoffTax.unknownRuns).toBe(0);
      expect(report.cacheHitRate.value).toBeNull();
      expect(report.cacheHitRate.unknownRuns).toBe(0);
      expect(report.waveWidth.value).toEqual([]);
      expect(report.waveWidth.unknownRuns).toBe(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GWT-2c — CLI 印 INV-6 + missingColumns
  //
  // 契约:CLI stdout 必须字面包含 `dream/extract-* 未纳入采集, 按座位求和是下界`。
  // 跑空夹具库 → 不抛 + 退出码 0 + 边界行可见。
  //
  // 证伪方式 (a): 把 COVERAGE_BOUNDARY 常量改了字面 → toContain 红。
  // 证伪方式 (b): 把 printHuman 末尾的 console.log(COVERAGE_BOUNDARY) 删了 → toContain 红。
  // 证伪方式 (c): 把空库路径换成会抛的 schema(比如压根没 CREATE TABLE)→ readDagRuns 返 []
  //   但 CLI 仍打印 INV-6 行 —— 设计:边界声明无论库为何状态都要可见。
  // ─────────────────────────────────────────────────────────────────────────
  describe('GWT-2c — CLI 印 INV-6 + missingColumns', () => {
    test('omd-waste on empty fixture db prints INV-6 boundary + missingColumns line + exits 0', async () => {
      const dbPath = join(TMP_ROOT, 'gwt-2c-empty.db');
      const db = new Database(dbPath);
      db.run(FULL_SCHEMA); // 表在,零行
      db.close();

      const proc = Bun.spawn({
        cmd: ['bun', join(REPO_ROOT, 'scripts/omd-waste.ts'), '--db', dbPath],
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      const exitCode = await proc.exited;
      // 空库合法,不该 exit 1;stderr 应该空 (内部错才写)
      expect(exitCode).toBe(0);
      expect(stderr).toBe('');
      // 边界行字面照搬
      expect(stdout).toContain('dream/extract-* 未纳入采集, 按座位求和是下界');
      // missingColumns 顶层摘要行也必须印 (实装契约)
      expect(stdout).toContain('missingColumns:');
    });

    test('omd-waste on missing file → 不抛, 仍印 INV-6 (边界声明永远可见)', async () => {
      const proc = Bun.spawn({
        cmd: ['bun', join(REPO_ROOT, 'scripts/omd-waste.ts'), '--db', join(TMP_ROOT, 'does-not-exist.db')],
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const stdout = await new Response(proc.stdout).text();
      const exitCode = await proc.exited;
      expect(exitCode).toBe(0); // 文件不在 → readDagRuns 返 [],CLI 仍正常退出
      expect(stdout).toContain('dream/extract-* 未纳入采集, 按座位求和是下界');
    });
  });
});
