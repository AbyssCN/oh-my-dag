/**
 * S-37 下沉引擎: freezeCriterion.waiveRed 在 D-K 节点判红点 + 环内冻结判据点的接线
 * (2026-08-17, 拆解 `docs/plan/2026-08-17-墙钟四跑拆解.md` L5 节)。
 *
 * 闭包由调用方注入 —— 测试直接构造谓词, 不依赖 run-goal (s2 那侧在 `goal/accept-waiver.test.ts` 钉 GWT 7)。
 *
 * 6 条 GWT, 与契约 GWT 1-6 一一对应:
 *   GWT-1 D-K 红 + 失败集 ⊆ 基线 → done + 输出含赦免注记
 *   GWT-2 D-K 红 + 失败集 ∌ ⊆ 基线 → failed (新失败 C)
 *   GWT-3 D-K 红 + 解析不出失败名 (空集) → failed (INV-2)
 *   GWT-4 waiveRed 缺席 → 行为逐字节不变 (INV-1)
 *   GWT-5 环内冻结判据红 + waiveRed 非 null → freezeGreen=true, journal evidence 含赦免原文
 *   GWT-6 节点命令 ≠ 判据命令 → 不赦免 (INV-4)
 *   INV-5 (闸拒 = 负退出码) 单独钉: D-K 红是闸拒 → 恒 failed, waiveRed 不问。
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runExecutorDagWithPlan } from './engine';
import type { ConductorPlan } from '../conductor-plan';
import type { ExecutorDagConfig, GenerateFn } from './types';
import { CheckpointManager } from '../continuity/checkpoint-manager';

/** `bun test` 输出里 `(fail) <name>` 的标准格式 —— 与 accept-delta.ts:47 同源正则口径。 */
const failOutput = (names: string[]): string => names.map((n) => `(fail) ${n}`).join('\n');

/**
 * 模拟 run-goal 用 baselineSide.failSet 构造的闭包 (D-3 半):
 *   失败集非空 ∧ ⊆ 基线 → 返注记; 任意名字不在基线 → null; 空集 → null (解析不出名字)。
 */
const makeWaiver = (baseline: string[]) => (text: string): string | null => {
  const after = new Set<string>();
  for (const m of text.matchAll(/^\(fail\)\s+(.+?)(?:\s+\[[\d.]+m?s\])?$/gm)) after.add(m[1]!.trim());
  if (after.size === 0) return null; // 解析不出测试名 = 编译错 / 跑不起来 / 超时 (INV-2)
  const baselineSet = new Set(baseline);
  for (const n of after) if (!baselineSet.has(n)) return null; // 有新失败即不赦免
  return `存量红赦免 (S-37 下沉): ${after.size} 条失败全在基线 — ${[...after].sort().join(', ')}`;
};

/** 单 command 节点测试的 config 工厂 —— 注入零 LLM generate, 不跑环。 */
const cmdConfig = (extra: Partial<ExecutorDagConfig>): ExecutorDagConfig => ({
  conductorModel: 'test:conductor',
  leafModel: 'test:leaf',
  generate: (async () => ({ text: 'leaf-out', usage: { in: 0, out: 0 } })) as GenerateFn,
  agentTemplates: new Map(),
  ...extra,
});

const plan = (nodes: ConductorPlan['nodes']): ConductorPlan => ({ name: 'p', nodes });

describe('S-37 下沉: D-K 节点判红点 (engine.ts:2751 附近)', () => {
  test('★ GWT-1: 节点命令=判据命令, exit 1, 失败集 {A} ⊆ 基线 {A,B} → done + 输出含赦免注记与 A', async () => {
    const r = await runExecutorDagWithPlan(
      plan({ accept: { goal: '判据', executor: 'command', command: 'test' } }),
      cmdConfig({
        commandRunner: async () => ({ text: failOutput(['A']), usage: { in: 0, out: 0 }, timedOut: false, signal: null, exitCode: 1 }),
        freezeCriterion: { command: 'test', waiveRed: makeWaiver(['A', 'B']) },
      }),
    );
    expect(r.results.accept!.status).toBe('done');
    const out = r.results.accept!.output;
    expect(out).toContain('[waiveRed:');
    expect(out).toContain('存量红赦免');
    expect(out).toContain('A');
  });

  test('★ GWT-2: 失败集 {A,C} 不 ⊆ 基线 {A} (C 是新失败) → failed 照旧', async () => {
    const r = await runExecutorDagWithPlan(
      plan({ accept: { goal: '判据', executor: 'command', command: 'test' } }),
      cmdConfig({
        commandRunner: async () => ({ text: failOutput(['A', 'C']), usage: { in: 0, out: 0 }, timedOut: false, signal: null, exitCode: 1 }),
        freezeCriterion: { command: 'test', waiveRed: makeWaiver(['A']) },
      }),
    );
    expect(r.results.accept!.status).toBe('failed');
    expect(r.results.accept!.output).not.toContain('[waiveRed:');
  });

  test('★ GWT-3: 退出码 1 但输出解析不出失败名 (空集) → failed 照旧 (INV-2)', async () => {
    // 编译错 / 跑不起来 / 超时 —— 解析不出 (fail) 行, 不赦免。
    const r = await runExecutorDagWithPlan(
      plan({ accept: { goal: '判据', executor: 'command', command: 'test' } }),
      cmdConfig({
        commandRunner: async () => ({ text: 'error TS2322: 类型不匹配 (无测试名)', usage: { in: 0, out: 0 }, timedOut: false, signal: null, exitCode: 1 }),
        freezeCriterion: { command: 'test', waiveRed: makeWaiver(['A', 'B']) },
      }),
    );
    expect(r.results.accept!.status).toBe('failed');
    expect(r.results.accept!.output).not.toContain('[waiveRed:');
  });

  test('★ GWT-4: waiveRed 缺席 → 行为与今天逐字节相同 (INV-1)', async () => {
    // 反向自检: 把 engine.ts:2751 那个 `if (!ok && !blocked)` 整块删了 → 本条红。
    const r = await runExecutorDagWithPlan(
      plan({ accept: { goal: '判据', executor: 'command', command: 'test' } }),
      cmdConfig({
        commandRunner: async () => ({ text: failOutput(['A']), usage: { in: 0, out: 0 }, timedOut: false, signal: null, exitCode: 1 }),
        freezeCriterion: { command: 'test' }, // 无 waiveRed
      }),
    );
    expect(r.results.accept!.status).toBe('failed');
    expect(r.results.accept!.output).not.toContain('[waiveRed:');
    // 也不该出现 `[expect_exit ...]` —— expectExit 缺省 0, 走的是 `want !== 0` 短路的另一支。
    expect(r.results.accept!.output).toBe(failOutput(['A']));
  });

  test('★ GWT-6: 节点命令 ≠ 判据命令 → 不赦免 (INV-4)', async () => {
    // 同串判据构造 (D-2): 只有当节点命令 == freezeCriterion.command 才走 waiveRed。
    // 其它 command 节点 (verify-red / slice verify) 永远不赦免。
    const r = await runExecutorDagWithPlan(
      plan({ other: { goal: '别的 command', executor: 'command', command: 'other-test' } }),
      cmdConfig({
        commandRunner: async () => ({ text: failOutput(['A']), usage: { in: 0, out: 0 }, timedOut: false, signal: null, exitCode: 1 }),
        freezeCriterion: { command: 'test', waiveRed: makeWaiver(['A', 'B']) },
      }),
    );
    expect(r.results.other!.status).toBe('failed');
    expect(r.results.other!.output).not.toContain('[waiveRed:');
  });

  test('★ INV-5: 闸拒 (退出码 -1) 恒 failed, waiveRed 不问 (D-4)', async () => {
    const r = await runExecutorDagWithPlan(
      plan({ accept: { goal: '判据', executor: 'command', command: 'rm -rf /' } }),
      cmdConfig({
        commandRunner: async () => ({ text: '[blocked: 危险命令]', usage: { in: 0, out: 0 }, timedOut: false, signal: null, exitCode: -1 }),
        freezeCriterion: { command: 'rm -rf /', waiveRed: makeWaiver(['A', 'B']) },
      }),
    );
    expect(r.results.accept!.status).toBe('failed');
    expect(r.results.accept!.output).not.toContain('[waiveRed:');
    expect(r.results.accept!.failureKind).toBe('gate-rejected'); // 闸拒 = -1, 分类器认出, waiveRed 没介入
  });
});

describe('S-37 下沉: 环内冻结判据点 (engine.ts:2227 附近)', () => {
  test('★ GWT-5: 判据命令红 + waiveRed 非 null → 环提前收敛 + journal evidence 含赦免原文', async () => {
    // 写 journal → 必须配 CheckpointManager (continuity), 否则 writeLoopJournal 短路返。
    // 反向自检: 把 freezeGreen IIFE 里 `if (!ok && !blocked && fc.waiveRed)` 那块删了 →
    //   本条红 (converged=false, journal evidence 不含赦免)。
    const root = mkdtempSync(join(tmpdir(), 'omd-s37-'));
    const mgr = new CheckpointManager(root);
    try {
      // 单子节点 conductor: 让环至少跑 1 轮, 触发 freezeGreen IIFE。
      // max_rounds=1 + freezeCriterion → 不走 maxRounds===1 早返 (`engine.ts:2220`), 进 loop body。
      const generate: GenerateFn = async () => ({ text: 'leaf-out', usage: { in: 0, out: 0 } });
      const r = await runExecutorDagWithPlan(
        { name: 'p', nodes: { execute: { goal: 'root', executor: 'conductor', max_rounds: 1 } } },
        {
          conductorModel: 'test:conductor',
          leafModel: 'test:leaf',
          generate,
          agentTemplates: new Map(),
          commandRunner: async () => ({ text: failOutput(['A']), usage: { in: 0, out: 0 }, timedOut: false, signal: null, exitCode: 1 }),
          freezeCriterion: { command: 'test', waiveRed: makeWaiver(['A', 'B']) },
          continuity: { manager: mgr, runId: 's37-waive', repoRoot: root },
        },
      );
      // 冻结判据绿 → settle(last, round, true) → converged=true
      expect(r.results.execute!.converged).toBe(true);
      // journal 必须写「success + 赦免原文」
      const journal = mgr.loadNodeLoopJournal('s37-waive', 'execute');
      expect(journal).not.toBeNull();
      const stop = journal!.stop;
      expect(stop?.kind).toBe('success');
      expect(stop?.evidence).toContain('赦免');
      expect(stop?.evidence).toContain('A');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('★ 环内冻结判据红 + waiveRed 返 null → 不赦免 (新失败 C 不在基线 {A})', async () => {
    const root = mkdtempSync(join(tmpdir(), 'omd-s37-'));
    const mgr = new CheckpointManager(root);
    try {
      const generate: GenerateFn = async () => ({ text: 'leaf-out', usage: { in: 0, out: 0 } });
      const r = await runExecutorDagWithPlan(
        { name: 'p', nodes: { execute: { goal: 'root', executor: 'conductor', max_rounds: 1 } } },
        {
          conductorModel: 'test:conductor',
          leafModel: 'test:leaf',
          generate,
          agentTemplates: new Map(),
          commandRunner: async () => ({ text: failOutput(['A', 'C']), usage: { in: 0, out: 0 }, timedOut: false, signal: null, exitCode: 1 }),
          freezeCriterion: { command: 'test', waiveRed: makeWaiver(['A']) },
          continuity: { manager: mgr, runId: 's37-no-waive', repoRoot: root },
        },
      );
      // freezeGreen 走 waived 路径但返 null → freezeGreen=false → 环继续 / 跑满 / judge 决定。
      // 本测断言「不进赦免路径」: journal evidence **不含**「赦免」二字。
      const journal = mgr.loadNodeLoopJournal('s37-no-waive', 'execute');
      // journal 可能没 stop (环没收尾, 1 轮没在环内 stop), 或 stop.evidence 不含赦免
      const ev = journal?.stop?.evidence ?? '';
      expect(ev).not.toContain('赦免');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});