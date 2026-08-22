/**
 * 产物闸「写域」s1 测试集 (SDD 2026-08-22 · C-1 · C-2 · 切片 1)。
 *
 * 闸的语义: `resolveMissingArtifacts` 只判**写域内** (root / repoRoot 之下) 的路径;
 * 写域外的绝对路径 (典型: `/tmp/_verifier_acceptance_helper.ts`) 走 `outOfScope`,
 * 不参与判死, 只留一行账。`LeafResult.filesTouched` 仍是原样 (D-2)。
 *
 * 两条闸测试:
 *   A. 单元 (`resolveMissingArtifacts` 直调) —— 钉住 C-1 的 INV-1..4。
 *   B. 闸决策 (`runExecutorDagWithPlan` 注 fake `agentRunner`) —— 钉住 C-2 的 INV-5..8 + D-3 承重。
 *
 * 反向自检 (SDD §反向自检切片 1):
 *   1. 把 `p.startsWith(r.endsWith('/') ? r : r + '/')` 改成 `false` ⇒ 写域内路径全被判写域外,
 *      B-WT-IN-DISK + B-IN-MISSING 两条当红 (判据被挖空了)。
 *   2. 把 `scopedTouched.length === 0` 改成 `false` ⇒ 「剔除后为空」被放行 ⇒ B-ONLY-OUT 当红 (D-3 承重)。
 *   ⚠ 两行 oldText **都不含 `|`** (含 TS `||` 也不行), 表格按 `|` 切列会静默截断 (run 75c39d15 实测)。
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveMissingArtifacts } from './engine';
import { runExecutorDagWithPlan } from './engine';
import type { ConductorPlan } from '../conductor-plan';
import type { GenerateFn } from './types';

// ─────────────────────────────────────────────────────────────────────────────
// A. 单元: resolveMissingArtifacts 写域识别 (C-1 · INV-1..4)
//
// 沿用 `artifact-gate-anchor.test.ts` 的临时树惯例 (mkdtempSync + 真文件); 不假 exists
// (本闸的契约就是「真实 `existsSync` 语义」, 假了等于没量)。
// ─────────────────────────────────────────────────────────────────────────────

/** 在临时根下建一棵 worktree 形状的树, 把指定相对路径全部写成非空文件。 */
function makeWorktreeWith(relPaths: string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'omd-scope-'));
  for (const rel of relPaths) {
    const abs = join(root, rel);
    mkdirSync(abs.slice(0, abs.lastIndexOf('/')), { recursive: true });
    writeFileSync(abs, '/* scope-gate test fixture */\n');
  }
  return root;
}

/** 清理临时树 (best-effort)。 */
function rmWorktree(root: string): void {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch { /* best-effort */ }
}

describe('A · resolveMissingArtifacts · 写域外剔除 (C-1)', () => {
  // ─────────── A-1 · 承重 ───────────
  test('A-1 · 写域内路径在盘上 ⇒ 不进 outOfScope, 也不进 missing', () => {
    // 修前必红: 没引入 `outOfScope` 字段时, 返回值类型里没这字段, `expect(...).toEqual({...})`
    // (下面对 outOfScope 那一行) 必红; 修后绿。
    // 修后这条是承重 — 写域内路径仍按今天逐字判定, `artifact-gate-anchor.test.ts` 的钉子不动。
    const wt = makeWorktreeWith(['src/x/on-disk.ts']);
    try {
      const mainRoot = '/repo/never/exists/main-A';
      const result = resolveMissingArtifacts({
        root: wt,
        repoRoot: mainRoot,
        filesTouched: [`${wt}/src/x/on-disk.ts`],
      });
      expect(result.outOfScope).toEqual([]);
      expect(result.missing).toEqual([]);
    } finally {
      rmWorktree(wt);
    }
  });

  // ─────────── A-2 · SDD GWT 钉 ───────────
  test('A-2 · 写域内盘上没有 ⇒ 进 missing, 不进 outOfScope (今天逐字相同)', () => {
    // SDD GWT3 钉: 「写域内但盘上不存在」与今天逐字相同 ——
    //   不该因为新增了 `outOfScope` 就被偷偷踢出判据。
    const wt = makeWorktreeWith([]);
    try {
      const mainRoot = '/repo/never/exists/main-B';
      const result = resolveMissingArtifacts({
        root: wt,
        repoRoot: mainRoot,
        filesTouched: [`${wt}/src/gone.ts`],
      });
      expect(result.outOfScope).toEqual([]);
      expect(result.missing).toEqual([`${wt}/src/gone.ts`]);
    } finally {
      rmWorktree(wt);
    }
  });

  // ─────────── A-3 · 现场钉 ───────────
  test('A-3 · 写域外绝对路径 (/tmp/_helper) ⇒ 进 outOfScope, 不进 missing / 不被 stat', () => {
    // SDD GWT1 钉: `/tmp/_verifier_acceptance_helper.ts` 这种一次性脚本走剔除 —
    //   既不进 `missing` 也不进 `probed` (不替它 stat, 闸看不见)。
    //   `probed` 不留它 = 拿 `Object.keys(probed)` 验。
    const wt = makeWorktreeWith(['src/x/on-disk.ts']);
    try {
      const tmpHelper = '/tmp/_verifier_acceptance_helper.ts';
      const result = resolveMissingArtifacts({
        root: wt,
        repoRoot: '/repo/never/exists/main-C',
        filesTouched: [`${wt}/src/x/on-disk.ts`, tmpHelper],
      });
      expect(result.outOfScope).toEqual([tmpHelper]);
      expect(result.missing).toEqual([]);
      expect(Object.keys(result.probed)).not.toContain(tmpHelper); // 不替它 stat
      expect(Object.keys(result.probed)).toContain(`${wt}/src/x/on-disk.ts`); // 写域内仍 stat
    } finally {
      rmWorktree(wt);
    }
  });

  // ─────────── A-4 · 相对路径一律写域内 ───────────
  test('A-4 · 相对路径一律算写域内 (D-4), 不进 outOfScope', () => {
    // SDD D-4 钉: 相对路径按 `${root}/${p}` 解析, 构造上就在域内 ⇒ 行为逐字不变。
    const wt = makeWorktreeWith(['src/r/exists.ts']);
    try {
      const result = resolveMissingArtifacts({
        root: wt,
        repoRoot: '/repo/never/exists/main-D',
        filesTouched: ['src/r/exists.ts', 'src/r/missing.ts'],
      });
      expect(result.outOfScope).toEqual([]);
      // 今天逐字相同的判定 (与 GWT4 等价, 多了一行 `outOfScope` 断言)。
      expect(result.missing).toEqual(['src/r/missing.ts']);
    } finally {
      rmWorktree(wt);
    }
  });

  // ─────────── A-5 · 锚回组 (INV-4 回归) ───────────
  test('A-5 · 主干绝对路径 + worktree 锚回 ⇒ missing / probed 与今天逐字相同', () => {
    // SDD GWT4 钉: 既有 `artifact-gate-anchor.test.ts` 那条主干绝对 + worktree 锚回组,
    //   在加了 `outOfScope` 字段后, `missing` / `probed` 一字不变。
    const wt = makeWorktreeWith(['src/x/foo.test.ts']);
    try {
      const mainRoot = '/repo/never/exists/main-E';
      const result = resolveMissingArtifacts({
        root: wt,
        repoRoot: mainRoot,
        filesTouched: [`${mainRoot}/src/x/foo.test.ts`],
      });
      expect(result.outOfScope).toEqual([]); // 主干绝对路径以 repoRoot 开头 ⇒ 写域内
      expect(result.missing).toEqual([]);
      expect(result.probed[`${mainRoot}/src/x/foo.test.ts`]).toEqual([
        `${mainRoot}/src/x/foo.test.ts`,
        `${wt}/src/x/foo.test.ts`,
      ]);
    } finally {
      rmWorktree(wt);
    }
  });

  // ─────────── A-6 · repoRoot 下也算写域内 ───────────
  test('A-6 · 绝对路径以 repoRoot 开头 ⇒ 写域内, 不进 outOfScope (D-1 双根都收)', () => {
    // SDD D-1 钉: 两个根都收 (锚回式 INV-2 已经这么做了); 主干绝对路径以 repoRoot 开头 ⇒ 写域内。
    const wt = makeWorktreeWith([]);
    try {
      const mainRoot = '/repo/never/exists/main-F';
      const result = resolveMissingArtifacts({
        root: wt, // worktree 锚点 ≠ 主干根
        repoRoot: mainRoot, // 但路径以它开头
        filesTouched: [`${mainRoot}/src/anywhere.ts`],
      });
      // 锚回不命中 (worktree 里没这文件) ⇒ 进 missing; 但它**是写域内** (以 repoRoot 开头),
      //   所以不进 outOfScope。这是 INV-4 锚回钉: 写域 = root 或 repoRoot 之下。
      expect(result.outOfScope).toEqual([]);
      expect(result.missing).toEqual([`${mainRoot}/src/anywhere.ts`]);
    } finally {
      rmWorktree(wt);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B. 闸决策: runExecutorDagWithPlan 注入 fake agentRunner, 验判死 / 放行 (C-2)
//
// 沿用 `engine.test.ts:1180` 的形状 (`runExecutorDagWithPlan` + `agentRunner: async () => ...`),
// 这是闸决策测试的精确先例。`declaredArtifact` 触发路径 = 节点声明 `output_path`,
// `filesTouched` 是 leaf 自报清单; 闸在 `engine.ts:3586` 那一带判。
// ─────────────────────────────────────────────────────────────────────────────

/** 最小化 makeConfig / plan, 与 engine.test.ts 同形态 (避开 import 链的依赖传染)。 */
function fakeGenerate(): GenerateFn {
  return async () => ({ text: 'stub', usage: { in: 1, out: 1 } });
}
const tinyConfig = (generate: GenerateFn) => ({
  conductorModel: 'test:conductor',
  leafModel: 'test:leaf',
  generate,
  agentTemplates: new Map(),
});
const tinyPlan = (nodes: ConductorPlan['nodes']): ConductorPlan => ({ name: 'test-plan', nodes });

describe('B · 闸决策 · 写域外剔除 ≠ 放宽 (C-2 · D-3 承重)', () => {
  // ─────────── B-1 · 现场钉 ───────────
  test('B-1 · 写域内 + 写域外 都有, 写域内在盘上 ⇒ 节点 done (/tmp 进 outOfScope)', async () => {
    // SDD GWT 钉: 写域内一个文件在盘上 + 写域外一个 `/tmp` 脚本 (本测试不真造它 ——
    //   本测试只验闸「不替它 stat」⇒ 不存在也不进 missing)。
    // 不传 `continuity` ⇒ `repoRoot = process.cwd()`, `root = artifactRoot = wt`, 两个根不同
    //   ⇒ `/tmp/...` 不在任一根下 ⇒ 进 outOfScope; `${wt}/src/...` 在 root 下 ⇒ 写域内命中。
    const wt = makeWorktreeWith(['src/x/on-disk.ts']);
    try {
      const generate = fakeGenerate();
      const r = await runExecutorDagWithPlan(
        tinyPlan({ W: { goal: '改文件', executor: 'agent', output_path: 'src/x/on-disk.ts' } }),
        {
          ...tinyConfig(generate),
          // artifactRoot 在 LeafResult 上不在 ExecutorDagConfig 上 ——
          //   引擎用 `r.cwd` 覆盖 (engine.ts:3471), cwd 字段就是它的来源。
          agentRunner: async () => ({
            text: '改完了',
            usage: { in: 1, out: 1 },
            cwd: wt,
            filesTouched: [`${wt}/src/x/on-disk.ts`, '/tmp/_verifier_acceptance_helper.ts'],
          }),
        },
      );
      expect(r.results.W!.status).toBe('done');
      // D-2: LeafResult.filesTouched 是观测面, 不因剔除而变短。
      expect(r.results.W!.filesTouched).toEqual([
        `${wt}/src/x/on-disk.ts`,
        '/tmp/_verifier_acceptance_helper.ts',
      ]);
    } finally {
      rmWorktree(wt);
    }
  });

  // ─────────── B-2 · 钉 D-3 ───────────
  test('B-2 · 只报 /tmp/_helper (写域内一个都没有) ⇒ 节点 failed (D-3 承重)', async () => {
    // SDD GWT 钉 D-3: 剔除 ≠ 放行 — 只碰过 `/tmp` 的节点 `scopedTouched` 为空
    //   ⇒ 仍按「filesTouched 空」判死。这条修前修后都必须红 (节点 failed)。
    //   修后变绿 = 闸被偷偷放宽, D-3 失守 ⇒ 立刻回滚。
    const generate = fakeGenerate();
    const r = await runExecutorDagWithPlan(
      tinyPlan({ W: { goal: '验收', executor: 'agent', output_path: 'src/x/never-declared.ts' } }),
      {
        ...tinyConfig(generate),
        agentRunner: async () => ({
          text: '验收完了',
          usage: { in: 1, out: 1 },
          filesTouched: ['/tmp/_verifier_acceptance_helper.ts'],
        }),
      },
    );
    expect(r.results.W!.status).toBe('failed');
    expect(r.results.W!.failureKind).toBe('empty-artifact');
    // D-2: LeafResult.filesTouched 仍是原样 (含 `/tmp` 那条) ——
    //   它是观测面, 下游写域闸 / 产物视图另有消费者, 不因闸的剔除而变短。
    expect(r.results.W!.filesTouched).toEqual(['/tmp/_verifier_acceptance_helper.ts']);
  });

  // ─────────── B-3 · 写域内盘上没有 ───────────
  test('B-3 · 写域内但盘上不存在 ⇒ 节点 failed, missing 列出 (与今天逐字相同)', async () => {
    // SDD GWT 钉: 写域内盘上没有的路径仍判 missing ⇒ 节点 failed ——
    //   加了写域剔除后, 写域内路径的判定与今天逐字相同。
    const wt = makeWorktreeWith([]);
    try {
      const generate = fakeGenerate();
      const r = await runExecutorDagWithPlan(
        tinyPlan({ W: { goal: '改文件', executor: 'agent', output_path: 'src/x/gone.ts' } }),
        {
          ...tinyConfig(generate),
          // artifactRoot 在 LeafResult 上不在 ExecutorDagConfig 上 ——
          //   引擎用 `r.cwd` 覆盖 (engine.ts:3471), cwd 字段就是它的来源。
          agentRunner: async () => ({
            text: '声称改了',
            usage: { in: 1, out: 1 },
            cwd: wt,
            filesTouched: [`${wt}/src/x/gone.ts`],
          }),
        },
      );
      expect(r.results.W!.status).toBe('failed');
      expect(r.results.W!.failureKind).toBe('empty-artifact');
      expect(r.results.W!.filesTouched).toEqual([`${wt}/src/x/gone.ts`]);
    } finally {
      rmWorktree(wt);
    }
  });

  // ─────────── B-4 · 相对路径 一字不变 ───────────
  test('B-4 · 写域内相对路径在盘上 ⇒ 节点 done (D-4 钉)', async () => {
    // SDD D-4 钉: 相对路径按 root 解析, 构造上就在域内 ——
    //   闸对相对路径的判定与今天逐字相同。
    const wt = makeWorktreeWith(['src/r/rel.ts']);
    try {
      const generate = fakeGenerate();
      const r = await runExecutorDagWithPlan(
        tinyPlan({ W: { goal: '改文件', executor: 'agent', output_path: 'src/r/rel.ts' } }),
        {
          ...tinyConfig(generate),
          // artifactRoot 在 LeafResult 上不在 ExecutorDagConfig 上 ——
          //   引擎用 `r.cwd` 覆盖 (engine.ts:3471), cwd 字段就是它的来源。
          agentRunner: async () => ({
            text: '改完了',
            usage: { in: 1, out: 1 },
            cwd: wt,
            filesTouched: ['src/r/rel.ts'],
          }),
        },
      );
      expect(r.results.W!.status).toBe('done');
      expect(r.results.W!.filesTouched).toEqual(['src/r/rel.ts']);
    } finally {
      rmWorktree(wt);
    }
  });
});
