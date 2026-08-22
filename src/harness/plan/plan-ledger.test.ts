/**
 * plan-ledger 不变量 (plan-memory Phase A, SDD 2026-07-21):
 *   family 聚类 (A2 修复: 同/近同文本并族, 计数器随族涨) · 版本去重 (同 hash 同行, 结构变新版+parent 链) ·
 *   ok/verified 语义 · fail-open · rebuild 从 _dag.json 重建。
 */
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPlanLedger, normalizeTask, planHash, taskSimilarity } from './plan-ledger';

const PLAN_A = { name: 'review-diff', nodes: { collect: { executor: 'command', goal: 'git diff' }, review: { executor: 'leaf', goal: '审', depends_on: ['collect'] } } };
const PLAN_B = { name: 'review-diff', nodes: { collect: { executor: 'command', goal: 'git diff' }, review: { executor: 'leaf', goal: '审 (修复: SDD 目录已迁移)', depends_on: ['collect'] } } };

function mem() {
  return createPlanLedger({ db: new Database(':memory:') });
}

describe('taskSimilarity / planHash 纯函数', () => {
  test('CJK 近同文本 bigram Jaccard 高分; 无关任务低分', () => {
    expect(taskSimilarity('审查当前未提交的 diff 并出报告', '审查当前未提交的diff并出报告')).toBeGreaterThanOrEqual(0.8);
    expect(taskSimilarity('审查当前未提交的 diff 并出报告', '给 hud 模块铺单元测试')).toBeLessThan(0.3);
  });
  test('normalizeTask 移除全部空白 + 小写 (CJK 混排空白差异不破坏匹配)', () => {
    expect(normalizeTask('  Review   THE Diff \n now ')).toBe('reviewthediffnow');
    expect(normalizeTask('审查当前未提交的 diff 并出报告')).toBe(normalizeTask('审查当前未提交的diff并出报告'));
  });
  test('planHash 键序无关且结构敏感', () => {
    const a = { name: 'p', nodes: { x: { goal: 'g', executor: 'leaf' } } };
    const b = { name: 'p', nodes: { x: { executor: 'leaf', goal: 'g' } } };
    expect(planHash(a)).toBe(planHash(b));
    expect(planHash(PLAN_A)).not.toBe(planHash(PLAN_B));
  });
});

describe('record: family 聚类 (A2)', () => {
  test('同文本三次 → 同 family, runs=3; 计数在族不在版本孤行', () => {
    const l = mem();
    const r1 = l.record({ taskText: '审查当前未提交的 diff 并出报告', plan: PLAN_A, ok: true, verified: false })!;
    const r2 = l.record({ taskText: '审查当前未提交的 diff 并出报告', plan: PLAN_A, ok: true, verified: false })!;
    const r3 = l.record({ taskText: '审查当前未提交的diff并出报告', plan: PLAN_A, ok: true, verified: false })!; // 空白差异 → Jaccard 并族
    expect(r1.newFamily).toBe(true);
    expect(r2.familyId).toBe(r1.familyId);
    expect(r3.familyId).toBe(r1.familyId);
    const fams = l.families();
    expect(fams).toHaveLength(1);
    expect(fams[0]!.runs).toBe(3);
    expect(fams[0]!.okRuns).toBe(3);
  });

  test('无关任务 → 新 family', () => {
    const l = mem();
    const r1 = l.record({ taskText: '审查当前未提交的 diff', plan: PLAN_A, ok: true, verified: false })!;
    const r2 = l.record({ taskText: '给 hud 模块铺单元测试', plan: PLAN_A, ok: true, verified: false })!;
    expect(r2.familyId).not.toBe(r1.familyId);
    expect(l.families()).toHaveLength(2);
  });

  test('空 taskText → null 不记账', () => {
    const l = mem();
    expect(l.record({ taskText: '  ', plan: PLAN_A, ok: true, verified: false })).toBeNull();
    expect(l.families()).toHaveLength(0);
  });
});

describe('record: 版本去重 + parent 链', () => {
  test('同结构 → 同版本行计数++; 结构变 → v2 挂 parent', () => {
    const l = mem();
    const r1 = l.record({ taskText: 't', plan: PLAN_A, ok: true, verified: false, costUsd: 0.01 })!;
    const r2 = l.record({ taskText: 't', plan: PLAN_A, ok: false, verified: false, costUsd: 0.02 })!;
    expect(r2.planId).toBe(r1.planId);
    expect(r2.newVersion).toBe(false);
    const r3 = l.record({ taskText: 't', plan: PLAN_B, ok: true, verified: true })!;
    expect(r3.version).toBe(2);
    const versions = l.plans(r1.familyId);
    expect(versions).toHaveLength(2);
    expect(versions[0]!.runs).toBe(2);
    expect(versions[0]!.okRuns).toBe(1); // r2 ok=false
    expect(versions[0]!.totalCostUsd).toBeCloseTo(0.03, 10);
    expect(versions[1]!.parentId).toBe(r1.planId);
    expect(versions[1]!.verified).toBe(true);
  });

  test('planJson 取回完整图', () => {
    const l = mem();
    const r = l.record({ taskText: 't', plan: PLAN_A, ok: true, verified: false })!;
    expect(JSON.parse(l.planJson(r.planId)!)).toEqual(PLAN_A);
    expect(l.planJson('nope')).toBeNull();
  });
});

describe('rebuild: 从 continuity/_dag.json 重建 (db 是投影)', () => {
  test('含 plan+taskText 的重建入账; 旧 schema (缺 plan) 跳过; 坏 JSON 跳过', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ledger-rebuild-'));
    const mk = (run: string, meta: unknown): void => {
      mkdirSync(join(dir, run), { recursive: true });
      writeFileSync(join(dir, run, '_dag.json'), typeof meta === 'string' ? meta : JSON.stringify(meta));
    };
    mk('r1', { taskText: '审查 diff', plan: PLAN_A, createdAt: '2026-07-01T00:00:00Z' });
    mk('r2', { taskText: '审查 diff', plan: PLAN_A, createdAt: '2026-07-02T00:00:00Z' });
    mk('r3-old', { goal: '旧 schema 无 plan', nodeIds: ['x'], deps: {} });
    mk('r4-bad', '{not json');
    const l = mem();
    expect(l.rebuild(dir)).toBe(2);
    const fams = l.families();
    expect(fams).toHaveLength(1);
    expect(fams[0]!.runs).toBe(2);
    // 重建口径: ok=true/verified=false (战绩以在线记账为准)
    expect(l.plans(fams[0]!.id)[0]!.verified).toBe(false);
  });

  test('目录不存在 → 0', () => {
    expect(mem().rebuild('/no/such/dir')).toBe(0);
  });
});
