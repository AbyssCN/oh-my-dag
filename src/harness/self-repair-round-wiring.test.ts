/**
 * self-repair-round-wiring.test.ts —— S3 片 2 接线闸 (2026-08-27)。
 *
 * 钉 INV-3 接线、INV-6 两轮不重复、INV-7 ledger 哈希三态、INV-8 存量不回退
 * 在 agent-leaf 闭包上的接线表现。纯函数契约 (INV-1/2/3/4/5) 在
 * self-repair-round.test.ts 钉, 本片只管 wiring。
 *
 * 反向自检:
 *  - 把 followUp body 改回 formatSelfCheckFollowUp 原样 → 「[判据 diff]」红。
 *  - 把 observe 里红 + 空数组改回赋 parsed → 「unparsable 字面」红。
 *  - 去掉 followUpHashes.push → 「ledger 哈希字段长度 = 2」红。
 *  - strategyForRound 传 round+1 → 「R2 = M1」红。
 */
import { describe, expect, test } from 'bun:test';
import {
  buildSelfCheckFollowUp,
  type SelfCheckOutcome,
} from './agent-leaf';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(import.meta.dir, 'agent-leaf.ts');
const SPIN_SRC = join(import.meta.dir, 'spin-route.ts');

const ALLOWLIST = ['bun', 'true', 'false', 'echo'];

function scriptRunner(outcomes: ReadonlyMap<string, SelfCheckOutcome>) {
  return async (input: { command: string; cwd: string; allowlist: readonly string[] }): Promise<SelfCheckOutcome> => {
    const r = outcomes.get(input.command);
    if (!r) throw new Error(`no scripted outcome for "${input.command}"`);
    return r;
  };
}

/** 单探针 — 永远让 oracle 跑出指定 exitCode/stdout; touched 序列按调用计数取。 */
function runnerFor(
  fixedExit: number,
  fixedStdout: string,
  touchedSeq: number[],
): { probe: ReturnType<typeof scriptRunner>; getTouchedSize: () => number } {
  const map = new Map<string, SelfCheckOutcome>([
    ['bun test x.test.ts', { kind: 'exited', exitCode: fixedExit, stdout: fixedStdout, stderr: '' }],
  ]);
  let i = 0;
  return {
    probe: scriptRunner(map),
    getTouchedSize: () => touchedSeq[Math.min(i++, touchedSeq.length - 1)]!,
  };
}

/**
 * 接线层视图: 让测试同时拥有 outer 闭包那种「observe 写 → body 读」的 wiring 形态。
 * observe 仿 runOnce 的接线 (D-2): 判红 + 提取空数组 ⇒ null, 其余照写。
 * getCurrentFailSet 让闭包读到 outer 状态, 构判据 diff 槽。
 */
function wiringDeps() {
  const state: { current: readonly string[] | null } = { current: null };
  return {
    getCurrentFailSet: () => state.current,
    observe: (info: { kind: string; exitCode?: number | null; stdout?: string }) => {
      if (info.kind === 'exited' && typeof info.stdout === 'string') {
        const red = info.exitCode !== 0; // 测试 spec.expect_exit 一律 0
        if (red) {
          const out = info.stdout;
          const set = new Set<string>();
          for (const m of out.matchAll(/^\(fail\)\s+(.+?)(?:\s+\[[\d.]+m?s\])?$/gm)) {
            set.add(m[1]!.trim());
          }
          const parsed = [...set].sort();
          state.current = parsed.length === 0 ? null : parsed;
        }
      }
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────
// INV-3 接线: 三态在闭包里走通
// ─────────────────────────────────────────────────────────────────────────

describe('INV-3 接线: 三态 (first-round / unparsable / diff) 在 followUp body 里可区分', () => {
  test('首轮 (rounds: 0 → 1) follow-up = 判据现场 + first-round + R1 (M7) 策略', async () => {
    const { probe, getTouchedSize } = runnerFor(1, '(fail) test:a\n', [0, 5]);
    const { followUp } = buildSelfCheckFollowUp({
      spec: { command: 'bun test x.test.ts', expect_exit: 0 },
      cwd: '/x',
      allowlist: ALLOWLIST,
      getTouchedSize,
      enabled: true,
      maxSelfRepair: 3,
      truncate: (s) => s,
      probe,
      observe: () => {},
    });
    const out = await followUp();
    expect(out).toHaveLength(1);
    const content = (out[0] as { role: 'user'; content: string }).content;
    expect(content).toContain('[self_check 未通过');
    expect(content).toContain('[判据现场]');
    expect(content).toContain('[判据 diff]');
    expect(content).toContain('first-round');
    expect(content).toContain('[上轮尝试与结果]');
    expect(content).toContain('[本轮策略]');
    expect(content).toContain('M7');
  });

  test('INV-3 GWT ② (wiring): 判红 + 空 (fail) 集 ⇒ unparsable 字面, 不出 added/removed', async () => {
    // R1 给非空 (fail) 集 → outer 写 state = ['a']; R2 给空 → outer 写 state = null
    // (D-2 三态 ②: 上轮有红集 + 本轮判红但无红集 ⇒ unparsable)
    const touched = [0, 5, 9];
    let i = 0;
    const map = new Map<string, SelfCheckOutcome>([
      ['bun test x.test.ts', { kind: 'exited', exitCode: 1, stdout: '(fail) a\n', stderr: '' }],
    ]);
    const { getCurrentFailSet, observe } = wiringDeps();
    const probe = scriptRunner(map);
    const getTouchedSize = () => touched[Math.min(i++, touched.length - 1)]!;
    const { followUp } = buildSelfCheckFollowUp({
      spec: { command: 'bun test x.test.ts', expect_exit: 0 },
      cwd: '/x',
      allowlist: ALLOWLIST,
      getTouchedSize,
      enabled: true,
      maxSelfRepair: 3,
      truncate: (s) => s,
      probe,
      getCurrentFailSet,
      observe,
    });
    await followUp(); // R1: prevFailSet=null ⇒ first-round; prevFailSet 滚动到 ['test:a']
    // 换 R2 stdout 为空 (无 (fail) 行)
    map.set('bun test x.test.ts', { kind: 'exited', exitCode: 1, stdout: '(no fail lines)\n', stderr: '' });
    const r2 = await followUp();
    const c2 = (r2[0] as { role: 'user'; content: string }).content;
    expect(c2).toContain('unparsable');
    expect(c2).not.toContain('added:');
    expect(c2).not.toContain('removed:');
  });

  test('INV-3 补洞: 上一轮**本身**不可解析 ⇒ 第 2 轮仍是 unparsable, 不许退回 first-round', async () => {
    // 终裁 2026-08-28 补: 生产里最常见的判据是 `tsc --noEmit` —— 它每轮判红, 而输出里
    // 从来没有 (fail) 行, 于是每一轮的红集都是 null。「没有上一轮」与「上一轮不可解析」
    // 是两件事 (静默坑 1: NULL ≠ NULL), 压成同一个 first-round 会让第 2 轮谎称自己是首轮,
    // 而这个判据恰恰**永远**走这条路 —— 三态在它身上退化成一态。
    const { probe, getTouchedSize } = runnerFor(2, 'error TS2554: expected 1 arg\n', [0, 5, 9]);
    const { getCurrentFailSet, observe } = wiringDeps();
    const { followUp } = buildSelfCheckFollowUp({
      spec: { command: 'bun test x.test.ts', expect_exit: 0 },
      cwd: '/x',
      allowlist: ALLOWLIST,
      getTouchedSize,
      enabled: true,
      maxSelfRepair: 3,
      truncate: (s) => s,
      probe,
      getCurrentFailSet,
      observe,
    });
    const r1 = await followUp();
    expect((r1[0] as { content: string }).content).toContain('first-round');
    const c2 = ((await followUp())[0] as { content: string }).content;
    expect(c2).toContain('unparsable');
    expect(c2).not.toContain('first-round');
  });

  test('INV-3 GWT ③ (wiring): 两侧都有可解析红集 ⇒ diff 字面, added/removed 与 INV-2 一致', async () => {
    // R1 给 a,b → outer 写 state = ['a','b']; R2 给 b,c → outer 写 state = ['b','c']
    // diff = added:[c], removed:[a]
    const touched = [0, 5, 9];
    let i = 0;
    const map = new Map<string, SelfCheckOutcome>([
      ['bun test x.test.ts', { kind: 'exited', exitCode: 1, stdout: '(fail) b\n(fail) a\n', stderr: '' }],
    ]);
    const { getCurrentFailSet, observe } = wiringDeps();
    const probe = scriptRunner(map);
    const getTouchedSize = () => touched[Math.min(i++, touched.length - 1)]!;
    const { followUp } = buildSelfCheckFollowUp({
      spec: { command: 'bun test x.test.ts', expect_exit: 0 },
      cwd: '/x',
      allowlist: ALLOWLIST,
      getTouchedSize,
      enabled: true,
      maxSelfRepair: 3,
      truncate: (s) => s,
      probe,
      getCurrentFailSet,
      observe,
    });
    await followUp(); // R1: first-round; 滚动 prevFailSet=['a','b']
    map.set('bun test x.test.ts', { kind: 'exited', exitCode: 1, stdout: '(fail) c\n(fail) b\n', stderr: '' });
    const r2 = await followUp();
    const c2 = (r2[0] as { role: 'user'; content: string }).content;
    expect(c2).toContain('diff');
    expect(c2).toContain('added: [c]');
    expect(c2).toContain('removed: [a]');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// INV-6 接线: 两轮 follow-up 不逐字重复
// ─────────────────────────────────────────────────────────────────────────

describe('INV-6 接线: 两轮 follow-up 不重复', () => {
  test('同节点两轮 red ⇒ sha256 不等 + 第 2 轮含 R2 (M1) 策略 + diff 状态', async () => {
    const touched = [0, 5, 9];
    let i = 0;
    const map = new Map<string, SelfCheckOutcome>([
      ['bun test x.test.ts', { kind: 'exited', exitCode: 1, stdout: '(fail) test:b\n(fail) test:a\n', stderr: '' }],
    ]);
    const { getCurrentFailSet, observe } = wiringDeps();
    const probe = scriptRunner(map);
    const getTouchedSize = () => touched[Math.min(i++, touched.length - 1)]!;
    const { followUp } = buildSelfCheckFollowUp({
      spec: { command: 'bun test x.test.ts', expect_exit: 0 },
      cwd: '/x',
      allowlist: ALLOWLIST,
      getTouchedSize,
      enabled: true,
      maxSelfRepair: 3,
      truncate: (s) => s,
      probe,
      getCurrentFailSet,
      observe,
    });
    const r1 = await followUp();
    const r2 = await followUp();
    expect(r1).toHaveLength(1);
    expect(r2).toHaveLength(1);
    const c1 = (r1[0] as { role: 'user'; content: string }).content;
    const c2 = (r2[0] as { role: 'user'; content: string }).content;
    expect(c1).not.toBe(c2);
    // R1 = M7, R2 = M1
    expect(c1).toContain('M7');
    expect(c2).toContain('M1');
    // 第 2 轮判据 diff 槽 = diff 状态 (因为 R1 已滚动存 a,b, R2 同样 a,b ⇒ diff 但 added/removed 都空)
    expect(c2).toContain('diff');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// INV-7 接线: ledger followUpHashes 三态
// ─────────────────────────────────────────────────────────────────────────

describe('INV-7 接线: ledger followUpHashes 缺席 / 空数组 / 长度 2', () => {
  test('有 self_check 但零轮 (首轮就绿) ⇒ ledger.followUpHashes = []', async () => {
    const map = new Map<string, SelfCheckOutcome>([
      ['bun test x.test.ts', { kind: 'exited', exitCode: 0, stdout: '0 fail', stderr: '' }],
    ]);
    const { followUp, ledger } = buildSelfCheckFollowUp({
      spec: { command: 'bun test x.test.ts', expect_exit: 0 },
      cwd: '/x',
      allowlist: ALLOWLIST,
      getTouchedSize: () => 0,
      enabled: true,
      maxSelfRepair: 2,
      truncate: (s) => s,
      probe: scriptRunner(map),
      observe: () => {},
    });
    await followUp(); // 首轮就绿 ⇒ 无 follow-up
    expect(ledger.rounds).toBe(0);
    expect(ledger.followUpHashes).toEqual([]);
  });

  test('两轮 red ⇒ ledger.followUpHashes.length === 2', async () => {
    const touched = [0, 5, 9];
    let i = 0;
    const map = new Map<string, SelfCheckOutcome>([
      ['bun test x.test.ts', { kind: 'exited', exitCode: 1, stdout: '(fail) test:a\n', stderr: '' }],
    ]);
    const { getCurrentFailSet, observe } = wiringDeps();
    const probe = scriptRunner(map);
    const getTouchedSize = () => touched[Math.min(i++, touched.length - 1)]!;
    const { followUp, ledger } = buildSelfCheckFollowUp({
      spec: { command: 'bun test x.test.ts', expect_exit: 0 },
      cwd: '/x',
      allowlist: ALLOWLIST,
      getTouchedSize,
      enabled: true,
      maxSelfRepair: 3,
      truncate: (s) => s,
      probe,
      getCurrentFailSet,
      observe,
    });
    await followUp();
    await followUp();
    expect(ledger.rounds).toBe(2);
    expect(ledger.followUpHashes).toBeDefined();
    expect(ledger.followUpHashes).toHaveLength(2);
    // 两轮哈希互不相等 (INV-6)
    const hs = ledger.followUpHashes!;
    expect(hs[0]).not.toBe(hs[1]);
    // 既存字段不变: oracleExit 在两轮 red 下长度 = rounds (每轮 probe push 一次)
    // (oracleExit.length === rounds + 1 这条 INV-4-2 只在最后 probe 转绿时成立 —— 见 leaf-self-check.test.ts)
    expect(ledger.oracleExit).toHaveLength(2);
    expect(ledger.convergedAt).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// INV-8 接线: 存量不回退 (源码面)
// ─────────────────────────────────────────────────────────────────────────

describe('INV-8 接线: 既有 wire-up 字面与 import 不被改动', () => {
  test('agent-leaf.ts 仍 import compareCriteriaFailures (片 1 集合比对实现被消费)', () => {
    const src = readFileSync(SRC, 'utf8');
    expect(src).toMatch(/from\s+['"]\.\/self-repair-round['"]/);
    expect(src).toMatch(/buildRepairFollowUp/);
    expect(src).toMatch(/compareCriteriaFailures|buildCriteriaDiff/);
  });

  test('agent-leaf.ts: observe 红 + 空数组 走 null 路径 (不写 parsed) ', () => {
    // 接线点必须出现 `parsed.length === 0` 或等价判别, 而不是恒真 `parsed !== null`。
    const src = readFileSync(SRC, 'utf8');
    // 老的恒真判别要消失
    expect(src).not.toMatch(/if\s*\(\s*parsed\s*!==\s*null\s*\)/);
  });

  test('spin-route.ts 改消费 compareCriteriaFailures (D-3)', () => {
    const src = readFileSync(SPIN_SRC, 'utf8');
    expect(src).toMatch(/from\s+['"]\.\/self-repair-round['"]/);
    expect(src).toMatch(/compareCriteriaFailures/);
  });

  test('spin-route.ts: no-history 字面与 judgeRungOutcome 行为逐字不变 (依赖既有 spin-route.test.ts)', () => {
    const src = readFileSync(SPIN_SRC, 'utf8');
    expect(src).toContain('本节点无 self_check,无判据可 diff');
  });
});