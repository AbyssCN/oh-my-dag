/**
 * src/harness/continuity/spin-rung2-report.test.ts —— 节点级空转档 2 阶梯报告的
 * **持久化 + 读取面**契约闸 (SDD S2 片 4, 2026-08-25)。
 *
 * 报告形状 (`SpinLadderReport` / `SpinLadderReading`) 在 `../dag/spin-rung2.ts` 冻结 (片 1);
 * 引擎接线在 `../dag/engine.ts` (片 3); **本片只关心报告如何穿过 NodeCheckpoint (写入磁盘 / 重读)
 * 与 serve 读取面 (RunNodeView.checkpoint)**。两个出口读到的必须是同一份报告 (INV-7 字面:
 * "checkpoint 重读与 serve 读取面的结果与内存结果一致") —— 测试就是钉这一句。
 *
 * | GWT    | 钉的是什么 |
 * |--------|---|
 * | GWT-7a | NodeCheckpoint.spinLadderReport 透传 `saveCheckpoint → loadCheckpoint` 字节级一致 |
 * | GWT-7b | 字段缺席 (无 spin 史) 不被读成 `null` / 不被读成 `{}` —— INV-8 / NULL ≠ 0 |
 * | GWT-7c | `readRun` 暴露的 `RunNodeView.checkpoint.spinLadderReport` 与内存对象一致 |
 * | GWT-7d | `readings` 必恰含 `[r1, r2]` 两条, 每条都有 `dimension/criterionDiff/blockerSignature/outcome` 四字段 |
 *
 * ⚠ 怎么让它红 (反向自检, 必须真跑一次才认闸活着):
 *   · GWT-7a: saveCheckpoint 改成 `JSON.stringify` 前手动 `delete cp.spinLadderReport` → loadCheckpoint
 *            读回的对象上该字段缺席 → 严格 toEqual 失败。
 *   · GWT-7b: 把 spread 条件改成 `?? null` → 缺席被读成 null, 等式两边变 null vs undefined,
 *            @若测试只判字段在不在, 也会被 toBeNull 反向咬红。验证后保留 `in` 操作符 + toBeUndefined 双向断言。
 *   · GWT-7c: readRun 里把 `spinLadderReport` 那段 spread 删掉 → RunNodeView.checkpoint 上字段
 *             缺席 → 同 GWT-7a 反咬红。
 *   · GWT-7d: 把 `SpinLadderReport` readonly tuple 改成 `readonly SpinLadderReading[]` —— shape 检查
 *             仍过, length 检查仍过, 但少条 (删其一) 会判红。
 *
 * 注意 INV-9: 不动 `src/cli/runs-gc.ts` (另一窗口在途) · 不宣称阈值 owner 数值 · 不动归档幸存 → 红。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CheckpointManager } from './checkpoint-manager';
import type { NodeCheckpoint } from './types';
import {
  buildSpinLadderReport,
  type SpinLadderReport,
  type SpinLadderReading,
} from '../dag/spin-rung2';
import { readRun } from '../../serve/read-api';

let root: string;
let mgr: CheckpointManager;
let runId: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'omd-spin-rung2-report-'));
  delete process.env.OMD_DATA_HOME;
  mgr = new CheckpointManager(root);
  runId = `r-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  // readRun 必读的 _dag.json — 最小骨架, ids/deps/plan 都给齐, 让 readRun 不被早退
  const runDir = join(root, '.omd', 'continuity', runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, '_dag.json'),
    JSON.stringify({
      runId,
      goal: 'spin-rung2 report fixture',
      specSlug: 'spin-rung2-report-fixture',
      nodeIds: ['L1'],
      deps: { L1: [] },
      plan: { name: 'spin-rung2-report-fixture', nodes: { L1: { goal: 'fixture' } } },
      createdAt: new Date().toISOString(),
    }),
  );
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

// ── 报告构造 (委托 slice-1 builder, 不另写同义结构) ─────────────────────────
/**
 * 报告造一份档 1 + 档 2 都判败的样本 (本片最常见出口: 两档都判败 → 节点判 failed → 报告进
 * checkpoint)。判据 diff 槽走 `no-history` 字面 (无 self_check 史, 与 `spin-route.ts` 真实出口同形)。
 */
function mkFailingReport(): SpinLadderReport {
  const r1: SpinLadderReading = {
    dimension: 'spin-route',
    criterionDiff: { kind: 'no-history', literal: '本节点无 self_check,无判据可 diff' },
    blockerSignature: 'r1-stuck-no-tool-call',
    outcome: 'fail',
  };
  const r2: SpinLadderReading = {
    dimension: 'fresh-context',
    criterionDiff: { kind: 'no-history', literal: '本节点无 self_check,无判据可 diff' },
    blockerSignature: 'r2-stuck-same-bug',
    outcome: 'fail',
  };
  return buildSpinLadderReport({ rung1: r1, rung2: r2 });
}

/** 最小可记的失败 checkpoint (与 engine 真实出口同形, status=failed + failureKind='spin-fused')。 */
function mkFailedCheckpoint(overrides: Partial<NodeCheckpoint> = {}): NodeCheckpoint {
  return {
    nodeId: 'L1',
    leafKind: 'agent',
    status: 'failed',
    failureKind: 'spin-fused',
    outputPaths: [],
    artifactHashes: {},
    tokenUsage: { in: 8000, out: 200 },
    summary: 'two consecutive spins, both rungs failed',
    durationMs: 12_345,
    createdAt: '2026-08-25T00:00:00.000Z',
    schemaVersion: 1,
    ...overrides,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// GWT-7a — NodeCheckpoint.spinLadderReport 透传 save↔load 字节级一致
// ────────────────────────────────────────────────────────────────────────────
describe('GWT-7a — NodeCheckpoint.spinLadderReport save↔load 字节级一致', () => {
  test('写入磁盘前的报告对象 === 写入磁盘后 loadCheckpoint 读回的报告对象 (深相等)', () => {
    const report = mkFailingReport();
    const cp = mkFailedCheckpoint({ spinLadderReport: report });
    mgr.saveCheckpoint(runId, cp);

    const back = mgr.loadCheckpoint(runId, 'L1');
    expect(back).not.toBeNull();
    expect(back!.spinLadderReport).toBeDefined();
    // 深相等: 四字段 × 两档 = 八格, 任一漂必红
    expect(back!.spinLadderReport).toEqual(report);
    // 形态 (readings 长度 = 2) 也直接读, 防 `toEqual` 把多余字段也吞了
    expect(back!.spinLadderReport!.readings).toHaveLength(2);
  });

  test('readings[0] = 档 1 (spin-route), readings[1] = 档 2 (fresh-context) — 位置即档位', () => {
    const report = mkFailingReport();
    mgr.saveCheckpoint(runId, mkFailedCheckpoint({ spinLadderReport: report }));
    const back = mgr.loadCheckpoint(runId, 'L1')!;
    expect(back.spinLadderReport!.readings[0]!.dimension).toBe('spin-route');
    expect(back.spinLadderReport!.readings[1]!.dimension).toBe('fresh-context');
  });

  test('写入磁盘的文件里有 spinLadderReport 字符串 (纯存在性 — 防 IMPL 把它半路丢)', () => {
    const cp = mkFailedCheckpoint({ spinLadderReport: mkFailingReport() });
    mgr.saveCheckpoint(runId, cp);
    const onDisk = readFileSync(join(root, '.omd', 'continuity', runId, 'L1.json'), 'utf-8');
    expect(onDisk).toContain('spinLadderReport');
    // 报告里两条 reading 的 blocker 原文也应在盘上 (防字段名对了但内容丢了)
    expect(onDisk).toContain('r1-stuck-no-tool-call');
    expect(onDisk).toContain('r2-stuck-same-bug');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// GWT-7b — 字段缺席 (无 spin 史) 不被读成 null / 不被读成 {} (NULL ≠ 0)
// ────────────────────────────────────────────────────────────────────────────
describe('GWT-7b — 节点无 spin 史 → checkpoint 上 spinLadderReport 字段缺席 (INV-8)', () => {
  test('不带 spinLadderReport 字段的 checkpoint → load 后字段是 undefined (不是 null, 不是 {})', () => {
    const cp = mkFailedCheckpoint(); // 不带 spinLadderReport
    mgr.saveCheckpoint(runId, cp);
    const back = mgr.loadCheckpoint(runId, 'L1');
    expect(back).not.toBeNull();
    // 'in' 操作符比 .field !== undefined 更稳: 即便改成 undefined 也咬得到
    expect('spinLadderReport' in back!).toBe(false);
    expect(back!.spinLadderReport).toBeUndefined();
    // 反向: 不是 null (「路在但被截断」), 也不是 {} (空对象冒充)
    expect(back!.spinLadderReport).not.toBeNull();
  });

  test('存量节点 (无自修 / 无 spin 史) 行为与切片前逐字节相同 — failureKind / status 不变', () => {
    const cp = mkFailedCheckpoint({ failureKind: 'spin-fused' });
    mgr.saveCheckpoint(runId, cp);
    const back = mgr.loadCheckpoint(runId, 'L1')!;
    expect(back.status).toBe('failed');
    expect(back.failureKind).toBe('spin-fused');
    expect(back.spinLadderReport).toBeUndefined();
    // 既有字段一律不变 (INV-8: 存量语义不回退)
    expect(back.tokenUsage).toEqual({ in: 8000, out: 200 });
    expect(back.summary).toBe('two consecutive spins, both rungs failed');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// GWT-7c — readRun 暴露的 RunNodeView.checkpoint.spinLadderReport 与内存对象一致
// ────────────────────────────────────────────────────────────────────────────
describe('GWT-7c — readRun 暴露的 RunNodeView.checkpoint.spinLadderReport = 内存报告', () => {
  test('写入磁盘后 readRun 读回的 checkpoint.spinLadderReport 与内存对象深相等', () => {
    const report = mkFailingReport();
    mgr.saveCheckpoint(runId, mkFailedCheckpoint({ spinLadderReport: report }));
    const detail = readRun(root, runId);
    expect(detail).not.toBeNull();
    const nodeView = detail!.nodes.find((n) => n.id === 'L1');
    expect(nodeView).toBeDefined();
    expect(nodeView!.checkpoint).not.toBeNull();
    expect(nodeView!.checkpoint!.spinLadderReport).toBeDefined();
    expect(nodeView!.checkpoint!.spinLadderReport).toEqual(report);
  });

  test('无 spinLadderReport 的失败节点 → readRun 的 checkpoint 上字段缺席 (不在 JSON 里)', () => {
    mgr.saveCheckpoint(runId, mkFailedCheckpoint()); // 不带报告
    const detail = readRun(root, runId)!;
    const nodeView = detail.nodes.find((n) => n.id === 'L1')!;
    expect(nodeView.checkpoint).not.toBeNull();
    // 在 JSON 序列化里缺席 ≠ 字面 undefined; JSON.parse 后访问是 undefined
    expect(nodeView.checkpoint!.spinLadderReport).toBeUndefined();
    expect('spinLadderReport' in nodeView.checkpoint!).toBe(false);
  });

  test('成功节点 (status=done) 不携带 spinLadderReport 字段 — INV-8 / 报告只属于阶梯失败', () => {
    const cp: NodeCheckpoint = {
      ...mkFailedCheckpoint(),
      status: 'done',
      failureKind: undefined,
    };
    delete (cp as { failureKind?: string }).failureKind; // 成功节点无 failureKind
    mgr.saveCheckpoint(runId, cp);
    const detail = readRun(root, runId)!;
    const nodeView = detail.nodes.find((n) => n.id === 'L1')!;
    expect(nodeView.checkpoint!.status).toBe('done');
    expect(nodeView.checkpoint!.spinLadderReport).toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// GWT-7d — readings 必恰含 [r1, r2] 两条, 每条四字段齐备 (INV-7 字面)
// ────────────────────────────────────────────────────────────────────────────
describe('GWT-7d — readings 必恰含 [r1, r2] 两条, 每条四字段齐备 (INV-7)', () => {
  test('保存后 readings.length === 2 (档 1 + 档 2); 缺档直接判红', () => {
    const report = mkFailingReport();
    mgr.saveCheckpoint(runId, mkFailedCheckpoint({ spinLadderReport: report }));
    const back = mgr.loadCheckpoint(runId, 'L1')!;
    expect(back.spinLadderReport!.readings).toHaveLength(2);
    // 元组类型的两个位置都要在
    expect(back.spinLadderReport!.readings[0]).toBeDefined();
    expect(back.spinLadderReport!.readings[1]).toBeDefined();
  });

  test('每条 reading 都齐 dimension/criterionDiff/blockerSignature/outcome 四个字段 (INV-7)', () => {
    const report = mkFailingReport();
    mgr.saveCheckpoint(runId, mkFailedCheckpoint({ spinLadderReport: report }));
    const back = mgr.loadCheckpoint(runId, 'L1')!;
    for (const r of back.spinLadderReport!.readings) {
      expect(typeof r.dimension).toBe('string');
      expect(r.dimension.length).toBeGreaterThan(0);
      expect(r.criterionDiff).toBeDefined();
      expect(r.criterionDiff).not.toBeNull();
      expect(typeof r.blockerSignature).toBe('string');
      expect(r.blockerSignature.length).toBeGreaterThan(0);
      expect(typeof r.outcome).toBe('string');
      expect(['success', 'fail', 'pending']).toContain(r.outcome);
    }
  });

  test('readings[0].outcome = fail ∧ readings[1].outcome = fail → 试尽如实 (两档齐败)', () => {
    const report = mkFailingReport();
    mgr.saveCheckpoint(runId, mkFailedCheckpoint({ spinLadderReport: report }));
    const back = mgr.loadCheckpoint(runId, 'L1')!;
    expect(back.spinLadderReport!.readings[0]!.outcome).toBe('fail');
    expect(back.spinLadderReport!.readings[1]!.outcome).toBe('fail');
  });
});
