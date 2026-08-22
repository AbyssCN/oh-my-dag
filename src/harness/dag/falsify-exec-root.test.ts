/**
 * src/harness/dag/falsify-exec-root.test —— sN-falsify 切片 1 的反向自检
 * (SDD `sN-falsify` 2026-08-22, 切片 1 = engine.ts:2947 的 mutation 根改用执行锚)。
 *
 * 本片承重 INV-1/2/3/4 —— 引擎解析 `falsifyMut.file` 时, `continuity.execRoot` 优先于
 * `repoRoot`, 二者皆无回落 `process.cwd()`; 给 `execRoot` 时, 状态锚那棵树一个字节都不许变。
 * 装置照 `falsify-mutate.test.ts:1-75` 现成写法 (mkdtempSync 临时树 + commandRunner 注入 +
 * CheckpointManager), 多做的一件事: **建两棵临时树**, `repoRoot` 与 `execRoot` 各指一棵。
 *
 * 反向自检 (写完每一跳手做一次, 不写完不交):
 *   1. `ugrep -n execRoot src/harness/dag/engine.ts` 必须恰好 2 处 (1 = 旧 rollback 那条,
 *      2 = 新 falsify 那条); 不唯一会让"没红"读成"没判别力"。
 *   2. 把 engine.ts:2947 的 `continuity?.execRoot ?? continuity?.repoRoot ?? process.cwd()`
 *      换回 `continuity?.repoRoot ?? process.cwd()` → 三个 GWT 必须红, 红的理由只准是
 *      「哪棵树 / 文件内容」(matches=0 / 状态锚被改 / 状态锚被还原), 不许是引擎中间量。
 *   3. 还原那一行 → 复绿。
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runExecutorDagWithPlan } from './engine';
import { CheckpointManager } from '../continuity/checkpoint-manager';
import type { CommandLeafResult } from '../leaf-runners';
import type { ConductorPlan } from '../conductor-plan';
import type { ExecutorDagConfig } from './types';
import type { CommandLeafRunner } from '../leaf-runners';

// ── 测试装置 ─────────────────────────────────────────────────────────────────

/**
 * 看文件说 exit 的 commandRunner: 命令里出现 mutated.txt 时取它, 否则取 default.txt。
 * 读 `mutated.txt`, 见到 MUTATION_MARKER 视为 mutation 已应用 → 返 exit 1; 否则 exit 0。
 * (照 falsify-mutate.test.ts:37-71 一字不差复制 —— 是它的私有 helper, 不导出, 故复刻。)
 */
function makeGreenByDefaultRunner(): { runner: CommandLeafRunner; readsCount: () => number } {
  let reads = 0;
  const runner: CommandLeafRunner = async (input) => {
    reads++;
    const file = input.command.includes('default.txt') ? 'default.txt' : 'mutated.txt';
    const abs = input.command.includes('/') ? input.command.split(/\s+/).find((t) => t.endsWith('.txt'))! : file;
    let content = '';
    try {
      content = readFileSync(abs, 'utf-8');
    } catch {
      content = '';
    }
    const sawMutation = content.includes('MUTATION_MARKER');
    return {
      text: `saw-mutation=${sawMutation}`,
      usage: { in: 0, out: 0 },
      timedOut: false,
      signal: null,
      exitCode: sawMutation ? 1 : 0,
    };
  };
  return { runner, readsCount: () => reads };
}

/**
 * 双树 runner: 同时读 aPath 与 bPath (用绝对路径注入), 只在「B 含 MUTATION_MARKER 且 A 不含」
 * 时返 exit 1; 其余情况 (A 含 / 都不含 / 路径读盘失败) 都返 exit 0。
 *
 * 这是 INV-1 / INV-4 那一条的核心证据: 错的引擎会去改 A, 这时 A 含 MUTATION_MARKER → exit 0;
 * 对的引擎改 B → B 含 / A 不含 → exit 1。**这条闸比单树 runner 严**: 改 A 哪怕改完又还原,
 * 闸也能在命令那一瞬抓到 (命令看到的内容是 mutated 后的)。
 */
function makeDualTreeRunner(aPath: string, bPath: string): CommandLeafRunner {
  return async () => {
    let aContent = '';
    let bContent = '';
    try { aContent = readFileSync(aPath, 'utf-8'); } catch { /* 缺 = 不含 */ }
    try { bContent = readFileSync(bPath, 'utf-8'); } catch { /* 缺 = 不含 */ }
    const aHas = aContent.includes('MUTATION_MARKER');
    const bHas = bContent.includes('MUTATION_MARKER');
    const ok = bHas && !aHas;
    return {
      text: `aHas=${aHas} bHas=${bHas}`,
      usage: { in: 0, out: 0 },
      timedOut: false,
      signal: null,
      exitCode: ok ? 1 : 0,
    };
  };
}

/** 在指定根下建一个文件, 返回 { root, relPath, absPath }。 */
function setupTempTree(root: string, relPath: string, content: string): { absPath: string } {
  const absPath = join(root, relPath);
  writeFileSync(absPath, content, 'utf-8');
  return { absPath };
}

/** 两棵临时树 + 同名同路径文件, 各塞不同内容。 */
function setupTwoTrees(relPath: string, aContent: string, bContent: string): {
  repoRoot: string; execRoot: string; aAbs: string; bAbs: string;
  cleanup: () => void;
} {
  const repoRoot = mkdtempSync(join(tmpdir(), 'falsify-repo-'));
  const execRoot = mkdtempSync(join(tmpdir(), 'falsify-exec-'));
  const aAbs = join(repoRoot, relPath);
  const bAbs = join(execRoot, relPath);
  writeFileSync(aAbs, aContent, 'utf-8');
  writeFileSync(bAbs, bContent, 'utf-8');
  return {
    repoRoot, execRoot, aAbs, bAbs,
    cleanup: () => {
      try { rmSync(repoRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
      try { rmSync(execRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
    },
  };
}

function oneCommandPlan(command: string): ConductorPlan {
  return { name: 'falsify-exec-root', nodes: { test: { executor: 'command', command, goal: 'test node' } } };
}

function makeConfig(extra: Partial<ExecutorDagConfig>): ExecutorDagConfig {
  return {
    conductorModel: 'test:conductor',
    leafModel: 'test:leaf',
    agentTemplates: new Map(),
    ...extra,
  };
}

/** 同时给 `repoRoot` (状态锚) 和 `execRoot` (执行锚) —— 两棵不同的临时树。 */
function makeBothRootConfig(repoRoot: string, execRoot: string, extra: Partial<ExecutorDagConfig> = {}): ExecutorDagConfig {
  return makeConfig({
    ...extra,
    continuity: {
      manager: new CheckpointManager(repoRoot),
      runId: 'test-run',
      repoRoot,
      execRoot,
    },
  });
}

/** 只给 `repoRoot` 不给 `execRoot` —— 验 INV-2 零回归。 */
function makeRepoOnlyConfig(repoRoot: string, extra: Partial<ExecutorDagConfig> = {}): ExecutorDagConfig {
  return makeConfig({
    ...extra,
    continuity: {
      manager: new CheckpointManager(repoRoot),
      runId: 'test-run',
      repoRoot,
    },
  });
}

function withMutate(
  plan: ConductorPlan,
  nodeId: string,
  mutate: { file: string; oldText: string; newText: string },
  expects_nonzero: boolean,
): ConductorPlan {
  const node = plan.nodes[nodeId]! as Record<string, unknown>;
  return {
    ...plan,
    nodes: {
      ...plan.nodes,
      [nodeId]: {
        ...node,
        mutate,
        expects_nonzero,
      } as ConductorPlan['nodes'][string],
    },
  };
}

// ── GWT 主闸 ──────────────────────────────────────────────────────────────────────

describe('sN-falsify 切片 1 — mutation 根改用执行锚 (C-1 / INV-1..4)', () => {
  test('GWT-1 (INV-1): execRoot 与 repoRoot 各指一棵树 → 改 execRoot 那棵, repoRoot 逐字节不变', async () => {
    // 反向自检 (GWT-1 闸):
    //   把 engine.ts:2947 的 `continuity?.execRoot ?? continuity?.repoRoot ?? process.cwd()`
    //   换回 `continuity?.repoRoot ?? process.cwd()` →
    //     (a) repoRoot=A 里没 oldText → engine 走 A 的 mutated.txt → matches=0 → status=failed
    //         (output 含 'matches=0'); A 字节不变, B 字节不变。
    //     (b) 或 repoRoot=A 里有 oldText (本片 GWT-3 形状) → engine 走 A → A 被改 → A 字节不变
    //         (还原了), 但 B 字节仍不变。**双树 runner 的 B 含 MUTATION_MARKER 那一刀抓不到**
    //         → exit 0 → status=failed。
    //   故本片两种 A 形状都拒; 反向自检红: 验证「execRoot 优先于 repoRoot」承重。
    const relPath = 'mutated.txt';
    const { repoRoot, execRoot, aAbs, bAbs, cleanup } = setupTwoTrees(
      relPath,
      'alpha beta gamma\n',           // A 树: 没 oldText
      'hello world\n',                 // B 树: 含 oldText
    );
    try {
      const runner = makeDualTreeRunner(aAbs, bAbs);
      // 命令里同时带两棵树绝对路径, 让 runner 能各自读到。
      const cmd = `cat ${aAbs} && cat ${bAbs}`;
      const plan = oneCommandPlan(cmd);
      const plan2 = withMutate(plan, 'test', { file: relPath, oldText: 'hello world\n', newText: 'MUTATION_MARKER\n' }, true);
      const r = await runExecutorDagWithPlan(plan2, makeBothRootConfig(repoRoot, execRoot, { commandRunner: runner }));
      // mutation 应用在 B → runner 看到 B 含 MUTATION_MARKER 且 A 不含 → exit 1 → expects_nonzero → done。
      expect(r.results.test!.status).toBe('done');
      expect(r.results.test!.exitCode).toBe(1);
      // 状态锚 A 逐字节不变 (INV-4)。
      expect(readFileSync(aAbs, 'utf-8')).toBe('alpha beta gamma\n');
      // 执行锚 B 跑完逐字节还原 (INV-10, 顺带钉)。
      expect(readFileSync(bAbs, 'utf-8')).toBe('hello world\n');
    } finally { cleanup(); }
  });

  test('GWT-2 (INV-2): 只给 repoRoot 不给 execRoot → 行为与今天逐字相同 (零回归)', async () => {
    // 反向自检 (GWT-2 闸):
    //   这条**故意钉老行为**——把 engine.ts:2947 改成只在「execRoot 缺」才走原路径 (例如把
    //   `execRoot ?? repoRoot ?? cwd` 错成 `repoRoot ?? execRoot ?? cwd`), 这条会红:
    //   现状是 repoRoot 唯一时, mutation 落在 repoRoot, 还原后 repoRoot 文件逐字节不变。
    //   若优先级倒挂, repoRoot 仍命中 (因为只有它), 行为巧合相同 —— 所以本条主要防的是
    //   **完全失去回退** (例如把 `?? process.cwd()` 那条删了, 单根路径解析时挂掉)。
    const relPath = 'mutated.txt';
    const { root, absPath } = setupTempFileLike('hello world\n', relPath);
    try {
      const { runner } = makeGreenByDefaultRunner();
      const plan = oneCommandPlan(`cat ${absPath}`);
      const plan2 = withMutate(plan, 'test', { file: relPath, oldText: 'hello world\n', newText: 'MUTATION_MARKER\n' }, true);
      const r = await runExecutorDagWithPlan(plan2, makeRepoOnlyConfig(root, { commandRunner: runner }));
      // 与 falsify-mutate.test.ts GWT-1 同形: mutation 应用 → exit 1 → expects_nonzero → done, 文件还原。
      expect(r.results.test!.status).toBe('done');
      expect(r.results.test!.exitCode).toBe(1);
      expect(readFileSync(absPath, 'utf-8')).toBe('hello world\n');
      expect(readFileSync(absPath, 'utf-8')).not.toContain('MUTATION_MARKER');
    } finally { cleanupSingleTemp(root); }
  });

  test('GWT-3 (INV-4): 两棵树都含 oldText → 改的仍是 execRoot 那棵, repoRoot 逐字节不变', async () => {
    // 反向自检 (GWT-3 闸):
    //   把 engine.ts:2947 换回 `continuity?.repoRoot ?? process.cwd()` →
    //     engine 用 repoRoot=A → A 被改 → A 含 MUTATION_MARKER, B 不含 → 双树 runner exit 0
    //     → expects_nonzero → status=failed。
    //   故本条必红: 验证「双树都含 oldText 时仍只改 execRoot」承重, 不被「先到先得」之类的退化
    //   写法蒙混。
    const relPath = 'mutated.txt';
    const { repoRoot, execRoot, aAbs, bAbs, cleanup } = setupTwoTrees(
      relPath,
      'beta beta\nREPO_TAIL\n',  // A 树: 也含 oldText "beta beta\n"
      'beta beta\nEXEC_TAIL\n',  // B 树: 含 oldText "beta beta\n"
    );
    try {
      const runner = makeDualTreeRunner(aAbs, bAbs);
      const cmd = `cat ${aAbs} && cat ${bAbs}`;
      const plan = oneCommandPlan(cmd);
      const plan2 = withMutate(plan, 'test', { file: relPath, oldText: 'beta beta\n', newText: 'MUTATION_MARKER\n' }, true);
      const r = await runExecutorDagWithPlan(plan2, makeBothRootConfig(repoRoot, execRoot, { commandRunner: runner }));
      // 改 B (含 MUTATION_MARKER) 不改 A → exit 1 → done。
      expect(r.results.test!.status).toBe('done');
      expect(r.results.test!.exitCode).toBe(1);
      // A 逐字节不变 (INV-4 核心)。
      expect(readFileSync(aAbs, 'utf-8')).toBe('beta beta\nREPO_TAIL\n');
      expect(readFileSync(aAbs, 'utf-8')).not.toContain('MUTATION_MARKER');
      // B 跑完逐字节还原 (INV-10)。
      expect(readFileSync(bAbs, 'utf-8')).toBe('beta beta\nEXEC_TAIL\n');
    } finally { cleanup(); }
  });
});

// ── 临时单树小工具 (GWT-2 用, 与 falsify-mutate.test.ts:74-84 同形) ────────────

function setupTempFileLike(initialContent: string, relPath: string): { root: string; absPath: string } {
  const root = mkdtempSync(join(tmpdir(), 'falsify-exec-root-single-'));
  const absPath = join(root, relPath);
  writeFileSync(absPath, initialContent, 'utf-8');
  return { root, absPath };
}

function cleanupSingleTemp(root: string): void {
  try { rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
}
