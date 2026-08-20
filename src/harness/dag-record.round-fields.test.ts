/**
 * src/harness/dag-record.round-fields.test.ts —— C-0 采集补口的反向闸 (2026-08-21)。
 *
 * 五条 GWT 钉死三件事:
 *   · **GWT-0a/b**  跨轮身份 + 覆盖标记 `overriddenBy` 的写入不变量 (INV-0-1);
 *   · **GWT-0c/d**  `injectedTokens` 三态纪律: 真值 / 真零 / 「没记」(INV-0-2、INV-0-3);
 *   · **GWT-0e**   旧库 (三字段皆缺) 不被当作 0 读 (INV-0-3) —— `omd-waste.ts` 该把整跑
 *                   计进 unknownRuns + missingColumns, 而不是用 0 代理。
 *
 * 验收面: `dag-record.record()` 写 → `recorder.get()` / `list()` 读出。`engine.ts` 的写入点
 * 由 engine 那边的端到端用例兜底 (本节点不直接接 engine)。
 *
 * ⚠ 证伪方式 (仓规: 一条永远绿的闸不是闸):
 *   · GWT-0a: 把 `record()` 的 `overriddenBy: typeof r.overriddenBy === 'number' ? r.overriddenBy : null`
 *     改成 `overriddenBy: typeof r.overriddenBy === 'number' ? r.overriddenBy : 0` → 末轮那条会落 0
 *     而不是 null → INV-0-1 失败。
 *   · GWT-0c: 把 `injectedTokens: typeof r.injectedTokens === 'number' ? r.injectedTokens : null`
 *     改成 `injectedTokens: typeof r.injectedTokens === 'number' ? r.injectedTokens : 0` →
 *     没设的 agent leaf 注入会被读成 0 → INV-0-3 失败 (「没记」≠ 0)。
 *   · GWT-0e: 把 waste/report 的 `if (!hasInjected)` 那道闸拿掉 → 旧库 injectedTokens 缺席会被
 *     读成 0 参与 handoffTax → value===0, unknownRuns=0 (与本测试期望相反) → 红。
 *   · GWT-0e (再): 把 `readDagRuns` 的 `usage: { conductorIn: 0, ... }` 那行改回原始 schema
 *     兼容写法 (塞个真数进去) → 不影响本闸, 但记着, 真跑会跑出 0/n=跑数, 那是错的。
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { createDagRecorder } from './dag-record';
import { computeWaste, readDagRuns } from './waste/report';
import type { ExecutorDagResult } from './dag/types';
import type { DagRunNode, DagRunRecord } from './dag-record';

/** mkdtemp 临时夹具根 — afterAll 清掉。 */
const TMP_ROOT = mkdtempSync(join(tmpdir(), 'dag-record-round-fields-'));

afterAll(() => {
  rmSync(TMP_ROOT, { recursive: true, force: true });
});

/**
 * 造一个最小可记的 ExecutorDagResult。`results[id]` 上的 `dagRound` / `overriddenBy` /
 * `injectedTokens` 由调用方按场景填 (与 engine.ts settle 时赋值的形状一致)。
 */
function fakeResult(planName: string, nodes: DagRunNode[]): ExecutorDagResult {
  const levels: string[][] = [];
  const byLevel = new Map<number, string[]>();
  for (const n of nodes) {
    const lvl = n.deps.length;
    if (!byLevel.has(lvl)) byLevel.set(lvl, []);
    byLevel.get(lvl)!.push(n.id);
  }
  for (const [, ids] of [...byLevel.entries()].sort((a, b) => a[0] - b[0])) levels.push(ids);
  return {
    plan: { name: planName, nodes: Object.fromEntries(nodes.map((n) => [n.id, { goal: 'x' }])) },
    levels,
    results: Object.fromEntries(nodes.map((n) => [
      n.id,
      {
        id: n.id,
        kind: 'inproc',
        status: n.status,
        deps: n.deps,
        output: '',
        usage: { in: n.tokensIn ?? 0, out: 0 },
        ...(typeof n.dagRound === 'number' ? { dagRound: n.dagRound } : {}),
        ...(typeof n.overriddenBy === 'number' ? { overriddenBy: n.overriddenBy } : {}),
        ...(typeof n.injectedTokens === 'number' ? { injectedTokens: n.injectedTokens } : {}),
      },
    ])) as ExecutorDagResult['results'],
    reusedNodes: [],
    usage: { conductor: { in: 0, out: 0 }, leavesIn: 0, leavesOut: 0, leavesCacheHit: 0 },
  } as unknown as ExecutorDagResult;
}

/** 给一个节点造一个 DagRunNode (仅本测试用)。 */
const mkNode = (overrides: Partial<DagRunNode> & { id: string }): DagRunNode => ({
  kind: 'inproc',
  status: 'done',
  deps: [],
  tokensIn: 100,
  ...overrides,
});

describe('C-0 dag-record.round-fields', () => {
  // ─────────────────────────────────────────────────────────────────────────
  // GWT-0a/b — 跨轮身份 + 覆盖标记 (INV-0-1)
  //   末轮那条 `overriddenBy` 必须为 null (「最后一轮不算被覆盖」); 早轮那条必须落 `currentEngineRound`。
  //   只跑过一轮的节点: `dagRound===1`, `overriddenBy===null`。
  // ─────────────────────────────────────────────────────────────────────────
  describe('GWT-0a/b — dagRound / overriddenBy 跨轮身份 + 覆盖标记', () => {
    test('GWT-0a: 同 id 节点在轮 1 与轮 2 各跑一次 → 轮 1 overriddenBy===2, 轮 2 overriddenBy===null', () => {
      const rec = createDagRecorder({ path: ':memory:' });
      // 轮 1 那条
      const id1 = rec.record(fakeResult('r1', [mkNode({
        id: 'a',
        deps: [],
        tokensIn: 100,
        dagRound: 1,
        overriddenBy: 2, // 引擎 settle 时: 早轮那条被本轮覆盖, 落 currentEngineRound (= 2)
      })]));
      // 轮 2 那条
      const id2 = rec.record(fakeResult('r2', [mkNode({
        id: 'a',
        deps: [],
        tokensIn: 80,
        dagRound: 2,
        overriddenBy: null, // 末轮 (本轮是最后一轮) → 不设
      })]));

      const n1 = rec.get(id1)!.nodes[0]!;
      const n2 = rec.get(id2)!.nodes[0]!;
      expect(n1.dagRound).toBe(1);
      expect(n1.overriddenBy).toBe(2); // 早轮那条: 被本轮覆盖 → 落 2
      expect(n2.dagRound).toBe(2);
      expect(n2.overriddenBy).toBeNull(); // 末轮: 不算被覆盖 (INV-0-1)
      rec.close();
    });

    test('GWT-0b: 只跑过一轮的节点 → dagRound===1, overriddenBy===null', () => {
      const rec = createDagRecorder({ path: ':memory:' });
      const id = rec.record(fakeResult('solo', [mkNode({
        id: 'root',
        deps: [],
        tokensIn: 50,
        dagRound: 1,
        overriddenBy: null, // 单轮节点从未被覆盖
      })]));
      const n = rec.get(id)!.nodes[0]!;
      expect(n.dagRound).toBe(1);
      expect(n.overriddenBy).toBeNull();
      rec.close();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GWT-0c/d — injectedTokens 三态 (INV-0-2、INV-0-3)
  //   有上游注入 → > 0 且 < tokensIn (注入只是输入的一部分);
  //   无上游的根节点 → injectedTokens === 0 (已知的零, 不是 null)。
  // ─────────────────────────────────────────────────────────────────────────
  describe('GWT-0c/d — injectedTokens 三态', () => {
    test('GWT-0c: 有上游注入 → injectedTokens > 0 且 < tokensIn', () => {
      const rec = createDagRecorder({ path: ':memory:' });
      const id = rec.record(fakeResult('with-up', [mkNode({
        id: 'child',
        deps: ['parent'],
        tokensIn: 1000,
        injectedTokens: 250, // 上游 1000 字符 → 250 token (chars/4)
      })]));
      const n = rec.get(id)!.nodes[0]!;
      expect(n.injectedTokens).toBe(250);
      expect(n.tokensIn).toBe(1000);
      expect(n.injectedTokens!).toBeGreaterThan(0);
      expect(n.injectedTokens!).toBeLessThan(n.tokensIn!); // 注入只是输入的一部分 (INV-0-2)
      rec.close();
    });

    test('GWT-0d: 无上游的根节点 → injectedTokens === 0 (不是 null — 已知的零)', () => {
      const rec = createDagRecorder({ path: ':memory:' });
      const id = rec.record(fakeResult('root-only', [mkNode({
        id: 'root',
        deps: [],
        tokensIn: 500,
        injectedTokens: 0, // 无 dep → 真注入零
      })]));
      const n = rec.get(id)!.nodes[0]!;
      expect(n.injectedTokens).toBe(0); // 已知零, 不是 null (INV-0-2、INV-0-3)
      expect(n.injectedTokens).not.toBeNull();
      rec.close();
    });

    test('agent leaf 注入数不到 → 写 null (INV-0-3: 「拿不到」≠ 「零」)', () => {
      const rec = createDagRecorder({ path: ':memory:' });
      // base 结果上**不**带 injectedTokens → 读侧写 null, 不是 0
      const result = {
        plan: { name: 'agent-leaf', nodes: { a: { goal: 'x' } } },
        levels: [['a']],
        results: {
          a: {
            id: 'a',
            kind: 'agent' as const,
            status: 'done' as const,
            deps: [],
            output: '',
            usage: { in: 100, out: 0 },
            // 没有 injectedTokens 字段
          },
        },
        reusedNodes: [],
        usage: { conductor: { in: 0, out: 0 }, leavesIn: 0, leavesOut: 0, leavesCacheHit: 0 },
      } as unknown as ExecutorDagResult;
      const id = rec.record(result);
      const n = rec.get(id)!.nodes[0]!;
      expect(n.injectedTokens).toBeNull(); // 拿不到 → null, 不是 0
      rec.close();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GWT-0e — 旧库三字段皆缺 → omd-waste 不被假数据 (INV-0-3)
  //   全部节点的 dagRound / overriddenBy / injectedTokens 都缺席 → waste 报告
  //   仍报 (null) + unknownRuns = 该库跑数 + missingColumns 列名 (三字段都在)。
  //   cacheHitTokens 可缺 (旧行无数据, 已知)。
  // ─────────────────────────────────────────────────────────────────────────
  describe('GWT-0e — 旧库三字段皆缺时 omd-waste 不被假数据', () => {
    test('GWT-0e: 全旧节点 → nodeWasteTokens/handoffTax.value=null, missingColumns 列名三字段都在', () => {
      // 构造一份「全是旧行」的库: 节点 JSON 不带 dagRound / overriddenBy / injectedTokens
      const dbPath = join(TMP_ROOT, 'old.db');
      const db = new Database(dbPath);
      db.run(`
        CREATE TABLE omd_dag_runs (
          id TEXT PRIMARY KEY, created_at INTEGER NOT NULL,
          plan_name TEXT NOT NULL, node_count INTEGER NOT NULL,
          levels TEXT NOT NULL, nodes TEXT NOT NULL, usage TEXT NOT NULL
        )
      `);
      // 10 跑, 每跑 3 个节点, 全无三字段
      for (let i = 0; i < 10; i++) {
        const nodes: DagRunNode[] = [
          { id: 'a', kind: 'inproc', status: 'done', deps: [], tokensIn: 100 },
          { id: 'b', kind: 'inproc', status: 'done', deps: ['a'], tokensIn: 200 },
          { id: 'c', kind: 'inproc', status: 'done', deps: ['a'], tokensIn: 150 },
        ];
        db.run(
          `INSERT INTO omd_dag_runs VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            `r-${i}`,
            Date.now(),
            'old-plan',
            nodes.length,
            JSON.stringify([['a'], ['b', 'c']]),
            JSON.stringify(nodes),
            JSON.stringify({ conductorIn: 0, conductorOut: 0, leavesIn: 0, leavesOut: 0, leavesCacheHit: 0 }),
          ],
        );
      }
      db.close();

      const records = readDagRuns(dbPath);
      expect(records).toHaveLength(10);
      const report = computeWaste(records as readonly DagRunRecord[]);
      // 三字段皆缺 → nodeWasteTokens / handoffTax 应 value=null (不被假数据)
      expect(report.nodeWasteTokens.value).toBeNull();
      expect(report.handoffTax.value).toBeNull();
      // missingColumns 必须点名三字段 (cacheHitTokens 仍可缺, 旧行没数据, 不在本闸范围)
      expect(report.missingColumns).toContain('dagRound');
      expect(report.missingColumns).toContain('overriddenBy');
      expect(report.missingColumns).toContain('injectedTokens');
      // unknownRuns = 该库跑数 (INV-0-3: 整跑进 unknownRuns, 不进 0)
      expect(report.nodeWasteTokens.unknownRuns).toBe(10);
      expect(report.handoffTax.unknownRuns).toBe(10);
    });
  });
});