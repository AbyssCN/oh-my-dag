/**
 * src/harness/dag/verifier-artifact-root.test —— SDD s1 切片 1 (2026-08-23) verifier 产物根换执行锚
 *
 * 承重事实: 隔离档 (`branchStrategy:'branch'`) 下, leaf 真写文件的那棵树是 `continuity.execRoot`,
 * 而产物根 (engine.ts:5076) 之前按 `continuity?.repoRoot ?? cwd` 解析。`repoRoot` = **状态锚**
 * (checkpoint 落哪儿, 隔离档下指主仓); `execRoot` = **执行锚** (leaf 真写的 worktree)。两棵树。
 * verifier 拿 `repoRoot` 去 `statSync(output_path)` ⇒ 一个**新写**的产物在主仓里当然不存在
 * ⇒ 判 `missing` ⇒ verifier 收到一条「产物没写」的假证据, 文件就在 worktree 里。
 *
 * 修后: `artifactRoot` 实参改取 `execRoot ?? repoRoot ?? cwd`, 与同族前四处逐字一致。
 * `verifier.ts` 的 `statSync` / 三态 / 判词一字不动 —— 它按给它的根判, 判得对, 错的是喂给它的根。
 *
 * 三条 GWT (与 SDD 切片 1 一字对应):
 *   G-1 ★ 隔离档 (`execRoot` ≠ `repoRoot`) ⇒ verifier 收到的 artifactRoot = execRoot (修前必红)。
 *   G-2 ★ 非隔离档 (不给 `execRoot`) ⇒ artifactRoot = repoRoot, 零回归 (与修前逐字相同)。
 *   G-3 ★ 直接调 `summarizeResults`, 同一 `output_path` 在 A 树存在 / B 树不存在 ⇒
 *          A 根下不含 `[missing]`, B 根下含 ⇒ **为什么值得改**的证据, 不经引擎。
 *
 * 反向自检 (本片手做, 图上不放 falsify 节点): 把 :5076 的实参换回
 * `continuity?.repoRoot ?? process.cwd()` ⇒ G-1 当场红 (收到的根回到 B 树)。
 *
 * 测试形状沿用 `rescue-anchor.test.ts`: mkdtempSync 建**两棵**树 + `continuity` 里 `execRoot`
 * 与 `repoRoot` 各指一棵 + 注入 `agentRunner` + 注入 `verifier` 记下收到的 artifactRoot。
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runExecutorDagWithPlan } from './engine';
import { summarizeResults } from '../verifier';
import { CheckpointManager } from '../continuity/checkpoint-manager';
import type { ConductorPlan } from '../conductor-plan';
import type { ExecutorDagConfig, GenerateFn } from './types';
import type { LeafResult } from './engine';

// ── 装置 ─────────────────────────────────────────────────────────────────────

function makeTree(label: string): string {
  return mkdtempSync(join(tmpdir(), `omd-verifier-anchor-${label}-`));
}

function rmTree(root: string): void {
  try { rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
}

/**
 * 跑一次 runExecutorDagWithPlan, 注入 verifier 记录收到的 `artifactRoot`。
 * 用单节点 agent executor + fake agentRunner, 让 leaf 必过 ⇒ 不短路, 必进 verifier。
 */
async function runOnce(opts: {
  isolation: boolean;
}): Promise<{ seenArtifactRoot: string | undefined; execTree: string; repoTree: string }> {
  const execTree = makeTree('exec');
  const repoTree = makeTree('repo');
  const plan: ConductorPlan = {
    name: 'verifier-anchor',
    nodes: { W: { goal: '写产物', executor: 'agent' } },
  };
  let seen: string | undefined;
  const verifier: NonNullable<ExecutorDagConfig['verifier']> = async (req) => {
    seen = req.artifactRoot;
    return { pass: true, reason: 'ok', usage: { in: 0, out: 0 } };
  };
  const generate: GenerateFn = async () => ({ text: 'unused', usage: { in: 1, out: 1 } });
  const cfg: ExecutorDagConfig = {
    conductorModel: 'test:conductor',
    leafModel: 'test:leaf',
    generate,
    agentTemplates: new Map(),
    agentRunner: async () => ({ text: 'done', usage: { in: 1, out: 1 } }),
    verifier,
    continuity: {
      manager: new CheckpointManager(mkdtempSync(join(tmpdir(), 'omd-verifier-anchor-ckpt-'))),
      runId: 'verifier-anchor-run',
      repoRoot: opts.isolation ? repoTree : execTree,
      // isolation=true ⇒ execRoot = execTree ≠ repoTree (隔离档形状)
      // isolation=false ⇒ execRoot 缺席 (非隔离档形状, INV-2 零回归)
      ...(opts.isolation ? { execRoot: execTree } : {}),
    },
  };
  try {
    await runExecutorDagWithPlan(plan, cfg);
    return { seenArtifactRoot: seen, execTree, repoTree };
  } finally {
    rmTree(execTree);
    rmTree(repoTree);
  }
}

// ── 三条 GWT ─────────────────────────────────────────────────────────────────

describe('verifier 产物根换执行锚 (SDD 2026-08-23 · s1 切片 1)', () => {
  // G-1 ★ 隔离档 (execRoot ≠ repoRoot) ⇒ verifier 收到的 artifactRoot = execRoot (A 树)。
  // 修前必红: 实参 `repoRoot ?? cwd` ⇒ 收到的会是 B 树 (repoTree) ⇒ expect 落空。
  test('G-1 隔离档下 verifier 收到的 artifactRoot === execRoot (修前必红)', async () => {
    const { seenArtifactRoot, execTree, repoTree } = await runOnce({ isolation: true });
    expect(seenArtifactRoot).toBeDefined();
    expect(seenArtifactRoot).toBe(execTree);
    // 钉两个根不同 (证明这条用例确实在测隔离档, 不是退化到单根场景)
    expect(execTree).not.toBe(repoTree);
  });

  // G-2 ★ 非隔离档 (无 execRoot) ⇒ artifactRoot 回退 repoRoot, 与修前逐字相同 (INV-2 零回归)。
  test('G-2 非隔离档 (无 execRoot) ⇒ artifactRoot === repoRoot (零回归)', async () => {
    const { seenArtifactRoot, execTree } = await runOnce({ isolation: false });
    expect(seenArtifactRoot).toBeDefined();
    // 隔离档缺席 ⇒ 解析链 `execRoot ?? repoRoot ?? cwd` ⇒ 取 repoRoot = execTree (单根场景)。
    // 修前 `repoRoot ?? cwd` 同样得到 execTree ⇒ 这一条与修前逐字相同。
    expect(seenArtifactRoot).toBe(execTree);
  });

  // G-3 ★ **为什么值得改**的证据, 不经引擎, 纯函数: 同一 `output_path`, A 树真存在 / B 树没有
  // ⇒ A 根下汇总不含 `[missing]`, B 根下含 ⇒ 这就是「喂错根就出假 missing」的机制级证据。
  // verifier.ts:165 那段 `statSync` / 三态 / 判词一字不动 (INV-4)。
  test('G-3 同一 output_path 在 A 树存在 / B 树不存在 ⇒ summarizeResults 三态因此翻转', () => {
    const treeA = makeTree('a'); // 执行锚
    const treeB = makeTree('b'); // 状态锚
    try {
      // 只在 A 树上写产物 (模拟隔离档下 leaf 真写在 worktree 里, 主仓没有)
      writeFileSync(join(treeA, 'made.md'), '# 新内容\n');

      const plan: ConductorPlan = {
        name: 'g3',
        nodes: { W: { goal: '声明了 output_path', executor: 'leaf', output_path: 'made.md' } },
      };
      const results: Record<string, LeafResult> = {
        W: { id: 'W', status: 'done', kind: 'inproc', output: '', deps: [], usage: { in: 0, out: 0 }, filesTouched: ['made.md'] },
      };

      // A 根 (执行锚) ⇒ 文件在 ⇒ registered
      const summaryA = summarizeResults(plan, results, treeA);
      expect(summaryA).toContain('artifact: made.md [registered]');
      expect(summaryA).not.toContain('artifact: made.md [missing]');

      // B 根 (状态锚) ⇒ 文件不在 ⇒ missing (假证据: 文件明明在 A 树上)
      const summaryB = summarizeResults(plan, results, treeB);
      expect(summaryB).toContain('artifact: made.md [missing]');
      expect(summaryB).not.toContain('artifact: made.md [registered]');
    } finally {
      rmTree(treeA);
      rmTree(treeB);
    }
  });
});
