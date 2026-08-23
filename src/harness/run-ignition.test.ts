/**
 * 点火入参留档 + 续跑恢复(`run-ignition.ts`)。
 *
 * 现场(owner 2026-08-23 报):`resume` 只带 runId,其余入参由本次调用给 ——
 * 漏传一个就按缺省跑,而缺省未必是首跑那次的值。
 *
 * 判别力锚(照 `pathfinder/code-sync.test.ts` 的形状 —— 一个「什么都恢复」的闸量的是尺子):
 *  - 本次给了的**永远优先**,档案不许盖回去(改 SDD 后 resume 是 O-6 的正当用法);
 *  - `maxRounds` / `budget*` **不许**被恢复 —— 加预算续跑正是 resume 的用法,
 *    恢复它们会把 resume 变成空操作;
 *  - `ifAbsent` 首写者赢 —— 真续跑不许把首跑的值改掉。
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RECOVERABLE,
  loadIgnitionArgs,
  resolveResumeArgs,
  saveIgnitionArgs,
  type IgnitionRecord,
} from './run-ignition';

const world = (): string => mkdtempSync(join(tmpdir(), 'omd-ignition-'));

describe('resolveResumeArgs — 纯函数, 本次优先、档案兜底', () => {
  const saved: IgnitionRecord = {
    tool: 'dag_goal',
    runId: 'r1',
    at: 1,
    args: { sddPath: 'docs/plan/a.md', tier: 'simple', researchRounds: 2 },
  };

  test('★ 本次没给 ⇒ 从档案取回, 并点名取回了哪几位', () => {
    const { merged, recovered } = resolveResumeArgs('dag_goal', { resume: 'r1' }, saved);
    expect(merged.sddPath).toBe('docs/plan/a.md');
    expect(merged.tier).toBe('simple');
    expect(recovered.sort()).toEqual(['researchRounds', 'sddPath', 'tier']);
  });

  test('★ 本次给了 ⇒ 本次的赢, 档案不许盖回去 (改 SDD 后 resume 是正当用法)', () => {
    const { merged, recovered } = resolveResumeArgs(
      'dag_goal',
      { resume: 'r1', sddPath: 'docs/plan/NEW.md' },
      saved,
    );
    expect(merged.sddPath).toBe('docs/plan/NEW.md');
    expect(recovered).not.toContain('sddPath');
  });

  test('★ 判别力: maxRounds / budget* 一律**不恢复** —— 加预算续跑是 resume 的用法', () => {
    const withBudget: IgnitionRecord = {
      ...saved,
      args: { ...saved.args, maxRounds: 4, budgetTokens: 9_000_000, budgetMinutes: 90 },
    };
    const { merged, recovered } = resolveResumeArgs('dag_goal', { resume: 'r1' }, withBudget);
    expect(merged.maxRounds).toBeUndefined();
    expect(merged.budgetTokens).toBeUndefined();
    expect(merged.budgetMinutes).toBeUndefined();
    expect(recovered).toEqual(['sddPath', 'tier', 'researchRounds']);
  });

  test('★ 判别力: branchStrategy 不在恢复集里 (那一格由盘上有没有树判, 两处各判会漂)', () => {
    expect(RECOVERABLE.dag_goal).not.toContain('branchStrategy');
    const withBs: IgnitionRecord = { ...saved, args: { ...saved.args, branchStrategy: 'branch' } };
    expect(resolveResumeArgs('dag_goal', { resume: 'r1' }, withBs).merged.branchStrategy).toBeUndefined();
  });

  test('没档案 ⇒ 原样返回, 一位都不恢复 (缺席 ≠ 首跑没传)', () => {
    const { merged, recovered } = resolveResumeArgs('dag_goal', { resume: 'r1' }, null);
    expect(recovered).toEqual([]);
    expect(merged).toEqual({ resume: 'r1' });
  });

  test('工具对不上 ⇒ 不恢复 (dag_run 的档案不许喂给 dag_goal)', () => {
    const { recovered } = resolveResumeArgs('dag_run', { resume: 'r1' }, saved);
    expect(recovered).toEqual([]);
  });
});

describe('saveIgnitionArgs / loadIgnitionArgs — 落盘一侧', () => {
  test('存了再读回, 只留可恢复集里那几位 (别的不写进档案)', () => {
    const cwd = world();
    saveIgnitionArgs(cwd, 'r1', 'dag_goal', {
      sddPath: 'docs/plan/a.md',
      tier: 'simple',
      maxRounds: 4, // 不在可恢复集 ⇒ 不许落盘
      goal: '一大段目标文本', // 同上
    });
    const rec = loadIgnitionArgs(cwd, 'r1');
    expect(rec?.args).toEqual({ sddPath: 'docs/plan/a.md', tier: 'simple' });
    expect(rec?.tool).toBe('dag_goal');
  });

  test('★ ifAbsent 首写者赢: 已有档案 ⇒ 不覆盖 (真续跑不许改掉首跑的值)', () => {
    const cwd = world();
    saveIgnitionArgs(cwd, 'r1', 'dag_goal', { sddPath: 'FIRST.md' });
    saveIgnitionArgs(cwd, 'r1', 'dag_goal', { sddPath: 'SECOND.md' }, { ifAbsent: true });
    expect(loadIgnitionArgs(cwd, 'r1')?.args.sddPath).toBe('FIRST.md');
  });

  test('不带 ifAbsent ⇒ 覆盖 (给显式重写留口, 但调用方今天不用)', () => {
    const cwd = world();
    saveIgnitionArgs(cwd, 'r1', 'dag_goal', { sddPath: 'FIRST.md' });
    saveIgnitionArgs(cwd, 'r1', 'dag_goal', { sddPath: 'SECOND.md' });
    expect(loadIgnitionArgs(cwd, 'r1')?.args.sddPath).toBe('SECOND.md');
  });

  test('档案不存在 ⇒ null (不是 {}) —— 调用方要分得开「没档案」与「首跑没传」', () => {
    expect(loadIgnitionArgs(world(), 'nope')).toBeNull();
  });

  test('档案坏了 ⇒ null + 不抛 (fail-open, helper 里留证据)', () => {
    const cwd = world();
    saveIgnitionArgs(cwd, 'r1', 'dag_goal', { sddPath: 'a.md' });
    const p = join(cwd, '.omd', 'continuity', 'r1', 'ignition.json');
    expect(existsSync(p)).toBe(true);
    Bun.write(p, '{ 这不是 JSON');
    expect(() => loadIgnitionArgs(cwd, 'r1')).not.toThrow();
  });

  test('★ 端到端: 首跑留档 → resume 一位不给 ⇒ 全恢复', () => {
    const cwd = world();
    // 首跑 (含 detached 的 worker 回调那条路 —— 它也走 ifAbsent)
    saveIgnitionArgs(cwd, 'r9', 'dag_goal', { sddPath: 'docs/plan/x.md', tier: 'complex' }, { ifAbsent: true });
    // 真续跑: 只带 runId
    const { merged, recovered } = resolveResumeArgs('dag_goal', { resume: 'r9' }, loadIgnitionArgs(cwd, 'r9'));
    expect(merged.sddPath).toBe('docs/plan/x.md');
    expect(merged.tier).toBe('complex');
    expect(recovered.sort()).toEqual(['sddPath', 'tier']);
  });

  test('落盘权限 0600 (档案里有契约路径, 不给同机其他用户读)', () => {
    const cwd = world();
    saveIgnitionArgs(cwd, 'r1', 'dag_goal', { sddPath: 'a.md' });
    const p = join(cwd, '.omd', 'continuity', 'r1', 'ignition.json');
    expect(readFileSync(p, 'utf8')).toContain('a.md');
    const { statSync } = require('node:fs') as typeof import('node:fs');
    expect(statSync(p).mode & 0o777).toBe(0o600);
  });
});
