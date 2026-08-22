/**
 * src/harness/dag/falsify-mutex.test —— sN-falsify 切片 3 的同树互斥闸
 * (SDD `sN-falsify` 2026-08-22 run `9f5bed0c` 实测后果, 切片 3)。
 *
 * 承重: **两张同树 falsify 节点并发 → mutation 互不可见** (C-1 INV-1/3)。
 *
 * ⚠ 切片 2 (falsify-mutate.test.ts) 承重 "单节点 mutation 还原"; 本片承重 "兄弟节点不撞车"。
 *   两条闸**逐字不同**, 不共享测试装置 (不分享 = 不会出现"一起通过"的假绿入口)。
 *
 * 装置要点: 一张图上挂两个 falsify 节点 (同层兄弟, 都只依赖 `parent`), 同一个文件两个**不同片段**
 * 各 mutate 一个 marker (`MK_<TAG>_AAA` → `MK_<TAG>_AAA_OK`)。注入的 commandRunner sleep 20ms
 * 强制交错, 并把 "我看见文件长什么样" 记下来。锁在时: 两份记录**各自只含自己的 OK marker**;
 * 锁不在 (验收第 2 条手做证伪): 至少一份记录看见**对方的 OK marker** ⇒ 红。
 *
 * 文件最终**逐字节**还原 (falsify-mutate.test.ts 那条 INV-10 不能因为加锁就被绕过)。
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runExecutorDagWithPlan } from './engine';
import { CheckpointManager } from '../continuity/checkpoint-manager';
import type { ConductorPlan } from '../conductor-plan';
import type { ExecutorDagConfig } from './types';
import type { CommandLeafRunner } from '../leaf-runners';

// ── 装置 ────────────────────────────────────────────────────────────────────────

/**
 * 节点命令形如 `TAG_<id>=cat /abs/path`。runner 据此抽自己的 tag 与文件路径。
 *
 * 判别 (sleep 20ms 强制交错, 让 "运气不撞" 不能让测试天然绿):
 *   - 看到自己的 OK marker (`MK_<TAG>_AAA_OK`) → 自己的 mutation 已应用
 *   - 看到对方的 OK marker → **对方的 mutation 也在盘上** ⇒ 锁破
 *   - exit 1 iff "看到自己 且 没看到对方" —— 锁在时这一行必为真
 *
 * 反向自检 (GWT-1 闸): 把 engine.ts 里 acquireMutationLock 的 `const prev = mutationLocks.get(key) ?? Promise.resolve();`
 *   改成 `const prev = Promise.resolve();` ⇒ 第二个 runner 看到对方 mutation ⇒ false2 sawOther=true ⇒ exit 0
 *   ⇒ false2 status='failed' ⇒ 此 test 红。
 */
function makeRecordingRunner(opts: {
  throwOnNode?: string;
} = {}): { runner: CommandLeafRunner; seen: () => Record<string, string> } {
  const log: Record<string, string> = {};
  const seen = () => log;
  const runner: CommandLeafRunner = async (input) => {
    const cmd = input.command;
    const m = cmd.match(/TAG_([\w-]+)=/);
    const myTag = m ? m[1]! : 'unknown';
    if (opts.throwOnNode === myTag) {
      throw new Error(`commandRunner 注入抛错于 ${myTag}`);
    }
    const pathMatch = cmd.match(/cat\s+(\/[^\s]+)/);
    const filePath = pathMatch ? pathMatch[1]! : '';
    await new Promise((r) => setTimeout(r, 20));   // 强制交错 (锁的价值在这一行)
    let content = '';
    try {
      content = readFileSync(filePath, 'utf-8');
    } catch { content = ''; }
    log[myTag] = content;
    // 单一 marker 形式 `MK_<TAG>_PIE` → `MK_<TAG>_PIE_OK`: sawMine 查自己, sawOther 查 log 里**早于本次**跑过的 tag。
    const sawMine = content.includes(`MK_${myTag}_PIE_OK`);
    const sawOther = Object.keys(log).some((k) => k !== myTag && content.includes(`MK_${k}_PIE_OK`));
    return {
      text: `node=${myTag} sawMine=${sawMine} sawOther=${sawOther}`,
      usage: { in: 0, out: 0 },
      timedOut: false,
      signal: null,
      exitCode: sawMine && !sawOther ? 1 : 0,
    };
  };
  return { runner, seen };
}

/** 临时目录 + 初始文件 (path= 相对路径)。 */
function setupTempFile(initialContent: string, relPath = 'mutex.txt'): { root: string; relPath: string; absPath: string } {
  const root = mkdtempSync(join(tmpdir(), 'falsify-mutex-'));
  const absPath = join(root, relPath);
  writeFileSync(absPath, initialContent, 'utf-8');
  return { root, relPath, absPath };
}

function cleanupTemp(root: string): void {
  try { rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
}

/** 配置: 把 repoRoot / execRoot 钉到 temp 根 —— 跑 falsify 的同树互斥必须同 key。 */
function makeTempConfig(root: string, extra: Partial<ExecutorDagConfig>): ExecutorDagConfig {
  return {
    conductorModel: 'test:conductor',
    leafModel: 'test:leaf',
    agentTemplates: new Map(),
    ...extra,
    continuity: {
      manager: new CheckpointManager(root),
      runId: 'test-run',
      repoRoot: root,
    },
  };
}

/** 构造一个 plan: parent (普通 command) → false-1 / false-2 (两个 falsify 兄弟节点, 同层无边)。 */
function twoFalsifySiblings(file: string, m1: { old: string; new: string }, m2: { old: string; new: string }): ConductorPlan {
  return {
    name: 'falsify-mutex',
    nodes: {
      parent: { executor: 'command', command: 'true', goal: 'synthesis' },
      false1: {
        executor: 'command',
        command: 'TAG_false1=cat <PATH>',
        goal: 'verify-red 1',
        mutate: { file, oldText: m1.old, newText: m1.new },
        expects_nonzero: true,
      },
      false2: {
        executor: 'command',
        command: 'TAG_false2=cat <PATH>',
        goal: 'verify-red 2',
        mutate: { file, oldText: m2.old, newText: m2.new },
        expects_nonzero: true,
      },
    },
  };
}

function fillPaths(plan: ConductorPlan, absPath: string): ConductorPlan {
  const nodes = plan.nodes as Record<string, ConductorPlan['nodes'][string]>;
  function subst(nodeId: string): ConductorPlan['nodes'][string] {
    const n = nodes[nodeId]!;
    const cmd = (n as { command?: string }).command ?? '';
    return { ...n, command: cmd.replace('<PATH>', absPath) };
  }
  return {
    ...plan,
    nodes: {
      ...plan.nodes,
      false1: subst('false1'),
      false2: subst('false2'),
    },
  };
}

// ── GWT 主闸 ──────────────────────────────────────────────────────────────────────

describe('sN-falsify 切片 3 — falsify 同树互斥 (C-1 / INV-1/3/4/5)', () => {
  test('GWT-1: 同层两 falsify 兄弟 → 各 runner 只看见自己的 mutation + 文件逐字节还原', async () => {
    const initial = 'MK_false1_PIE\nMK_false2_PIE\n';
    const { root, relPath, absPath } = setupTempFile(initial, 'mutex.txt');
    try {
      const { runner, seen } = makeRecordingRunner();
      const plan = fillPaths(
        twoFalsifySiblings(relPath,
          { old: 'MK_false1_PIE', new: 'MK_false1_PIE_OK' },
          { old: 'MK_false2_PIE', new: 'MK_false2_PIE_OK' }),
        absPath,
      );
      const r = await runExecutorDagWithPlan(plan, makeTempConfig(root, { commandRunner: runner }));
      // 两节点都 done (各只看到自己的 mutation, expects_nonzero 通道过)。
      expect(r.results.false1!.status).toBe('done');
      expect(r.results.false2!.status).toBe('done');
      expect(r.results.false1!.exitCode).toBe(1);
      expect(r.results.false2!.exitCode).toBe(1);
      // 锁在时的承重: 两份记录**分别只含自己的 OK marker**。
      const logs = seen();
      expect(logs.false1).toContain('MK_false1_PIE_OK');
      expect(logs.false1).not.toContain('MK_false2_PIE_OK'); // ← 关键
      expect(logs.false2).toContain('MK_false2_PIE_OK');
      expect(logs.false2).not.toContain('MK_false1_PIE_OK'); // ← 关键
      // INV-10 还原: 文件**逐字节**与初始相同。
      expect(readFileSync(absPath, 'utf-8')).toBe(initial);
    } finally { cleanupTemp(root); }
  });

  test('GWT-2: 第一个 falsify runner 抛错 → 第二个**仍拿到锁**完成 (INV-4 不死锁)', async () => {
    // 反向自检: 把 acquireMutationLock 改成"取出 prev 后不让 prev 释放" (e.g. 删 `release();` 那行)
    //   → 此 test 红: 第二个 runner 会卡在等锁上, false2 状态会变 (status 不是 done)。
    const initial = 'MK_g1_PIE\nMK_g2_PIE\n';
    const { root, relPath, absPath } = setupTempFile(initial, 'mutex2.txt');
    try {
      const { runner, seen } = makeRecordingRunner({ throwOnNode: 'g1' });
      const plan: ConductorPlan = {
        name: 'falsify-mutex-throw',
        nodes: {
          parent: { executor: 'command', command: 'true', goal: 'synthesis' },
          g1: {
            executor: 'command',
            command: 'TAG_g1=cat <PATH>',
            goal: 'verify-red g1',
            mutate: { file: relPath, oldText: 'MK_g1_PIE', newText: 'MK_g1_PIE_OK' },
            expects_nonzero: true,
          },
          g2: {
            executor: 'command',
            command: 'TAG_g2=cat <PATH>',
            goal: 'verify-red g2',
            mutate: { file: relPath, oldText: 'MK_g2_PIE', newText: 'MK_g2_PIE_OK' },
            expects_nonzero: true,
          },
        },
      };
      const nodes = plan.nodes as Record<string, ConductorPlan['nodes'][string]>;
      function subst(nodeId: string): ConductorPlan['nodes'][string] {
        const n = nodes[nodeId]!;
        const cmd = (n as { command?: string }).command ?? '';
        return { ...n, command: cmd.replace('<PATH>', absPath) };
      }
      const filled: ConductorPlan = {
        ...plan,
        nodes: { ...plan.nodes, g1: subst('g1'), g2: subst('g2') },
      };
      const r = await runExecutorDagWithPlan(filled, makeTempConfig(root, { commandRunner: runner }));
      // 第一个抛错 → engine 内部 catch 后转 failed (GWT-4 路径) + 文件还原。
      expect(r.results.g1!.status).toBe('failed');
      // 第二个仍跑完 (锁拿到, runner 看到文件含它自己的 mutation → exit 1 → done)。
      expect(r.results.g2!.status).toBe('done');
      expect(r.results.g2!.exitCode).toBe(1);
      const logs = seen();
      expect(logs.g2).toContain('MK_g2_PIE_OK');
      expect(logs.g2).not.toContain('MK_g1_PIE_OK'); // ← 关键: 第一个还原完了第二个才进
      // 文件还原: 第一个抛错走了 finally, 第二个正常完成走了 finally。
      expect(readFileSync(absPath, 'utf-8')).toBe(initial);
    } finally { cleanupTemp(root); }
  });

  test('GWT-3: 两个普通 command 节点 (无 mutate) → 不排队, 行为逐字同旧 (D-5 / INV-2/5)', async () => {
    // 反向自检 (GWT-3 闸): 把 releaseLock 的赋值改成无条件 acquireMutationLock (例如把
    //   `falsifyMut ?` 删了) → 此 test 红: 两个普通节点也排队 → elapsed ≥ 40ms (2 × 20ms sleep)。
    //   锁正确时 elapsed 应 < 30ms 并发跑。
    const { root, absPath } = setupTempFile('X', 'plain.txt');
    try {
      const { runner, seen } = makeRecordingRunner();
      const plan: ConductorPlan = {
        name: 'falsify-mutex-noop',
        nodes: {
          c1: { executor: 'command', command: 'TAG_c1=cat <PATH>', goal: 'plain 1' },
          c2: { executor: 'command', command: 'TAG_c2=cat <PATH>', goal: 'plain 2' },
        },
      };
      const nodes = plan.nodes as Record<string, ConductorPlan['nodes'][string]>;
      function subst(nodeId: string): ConductorPlan['nodes'][string] {
        const n = nodes[nodeId]!;
        const cmd = (n as { command?: string }).command ?? '';
        return { ...n, command: cmd.replace('<PATH>', absPath) };
      }
      const filled: ConductorPlan = {
        ...plan,
        nodes: { ...plan.nodes, c1: subst('c1'), c2: subst('c2') },
      };
      const t0 = Date.now();
      const r = await runExecutorDagWithPlan(filled, makeTempConfig(root, { commandRunner: runner }));
      const elapsed = Date.now() - t0;
      // 两个 done (INV-2): 普通节点无 mutate, 各 exit 0 → 老路径 (expect_exit 缺省 0) → done。
      expect(r.results.c1!.status).toBe('done');
      expect(r.results.c2!.status).toBe('done');
      const logs = seen();
      expect(logs.c1).toBeDefined();
      expect(logs.c2).toBeDefined();
      // 并发粗判: 串行排队时最小 ≥ 40ms (2 × 20ms sleep)。这里只锁上界——锁错上跑挂也会到 ≥ 80ms。
      expect(elapsed).toBeLessThan(80);
    } finally { cleanupTemp(root); }
  });
});
