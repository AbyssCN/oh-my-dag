/**
 * src/harness/dag/writeset-evidence.test —— SDD s1 切片 1 反向自检 (2026-08-22)
 *
 * 反向自检模式: 每条 test 头注写明「把 engine.ts 那行删掉 / 改成 Y → 此 test 由绿转红」。
 * 判别力由反向自检表承重, 本文件不写"看它能跑"的乱炖用例。
 *
 * 覆盖:
 *   1. 纯函数层 (注入 runGit, 不起真 git)
 *   2. 闸层 (起真 git tree + 注入 agentRunner, 验 filesTouched 真的被补)
 *   3. 反向自检两行: 删 head 档护栏 ⇒ 第三条 GWT (head 档不许救) 当场红;
 *                     救援条件放成 `filesTouched.length === 0` ⇒ 第二条 (真 empty-done)
 *                     会在「写集无改动」分支被错误救回 → 红。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { runExecutorDagWithPlan } from './engine';
import { writeSetChangedSinceBaseline, type RunGit } from './writeset-evidence';
import { CheckpointManager } from '../continuity/checkpoint-manager';
import type { ConductorPlan } from '../conductor-plan';
import type { ExecutorDagConfig } from './types';
import type { GenerateFn } from './types';

// ── 测试装置 ─────────────────────────────────────────────────────────────────

/**
 * 在 mkdtemp 起的临时目录建一棵 git 仓, 落一次 commit, 返回目录路径。
 * 后续用例可在工作区改文件然后跑 helper。
 */
function makeGitTree(): string {
  const root = mkdtempSync(join(tmpdir(), 'writeset-evidence-'));
  spawnSync('git', ['init', '-q'], { cwd: root });
  spawnSync('git', ['config', 'user.email', 'test@local'], { cwd: root });
  spawnSync('git', ['config', 'user.name', 'test'], { cwd: root });
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'x.ts'), '// baseline\n');
  spawnSync('git', ['add', '-A'], { cwd: root });
  spawnSync('git', ['commit', '-q', '-m', 'baseline'], { cwd: root });
  return root;
}

/**
 * 把 helper 的纯函数那半测一遍。runGit 全注入, 不起真 git —— 这层测判别力就够了,
 * 真 git 路径由闸那半 (test 下半) 验。
 */
describe('writeSetChangedSinceBaseline (纯函数, 注入 runGit)', () => {
  test('INV-1 baseline 缺席 ⇒ changed 空 + reason no-baseline', () => {
    const r = writeSetChangedSinceBaseline({
      root: '/anywhere',
      writeSet: ['src/x.ts'],
      // baseline 故意缺席
    });
    expect(r.changed).toEqual([]);
    expect(r.reason).toBe('no-baseline');
  });

  test('INV-2 writeSet 空 ⇒ changed 空 + reason no-write-set', () => {
    const r = writeSetChangedSinceBaseline({
      root: '/anywhere',
      writeSet: [],
      baseline: 'HEAD',
    });
    expect(r.changed).toEqual([]);
    expect(r.reason).toBe('no-write-set');
  });

  test('INV-3 git 退出码非 0 ⇒ changed 空 + reason 带 git 错误原文 (fail-closed, 不吞证据)', () => {
    const runGit: RunGit = () => ({
      exitCode: 128,
      stdout: '',
      stderr: 'fatal: not a git repository (or any of the parent directories): .git',
    });
    const r = writeSetChangedSinceBaseline({
      root: '/not/a/repo',
      writeSet: ['src/x.ts'],
      baseline: 'HEAD',
      runGit,
    });
    expect(r.changed).toEqual([]);
    expect(r.reason).toContain('git-failed');
    expect(r.reason).toContain('not a git repository');
  });

  test('INV-4 git 输出非空 ⇒ 解析出的写集路径进 changed (含未跟踪 ?? 行)', () => {
    const runGit: RunGit = () => ({
      exitCode: 0,
      stdout: [
        ' M src/x.ts',          // 改动
        '?? src/new.ts',        // 未跟踪
        ' M docs/other.md',     // 写集外, 不应收
      ].join('\n'),
      stderr: '',
    });
    const r = writeSetChangedSinceBaseline({
      root: '/repo',
      writeSet: ['src/x.ts', 'src/new.ts'],
      baseline: 'HEAD',
      runGit,
    });
    expect(r.changed.sort()).toEqual(['src/new.ts', 'src/x.ts']);
    expect(r.reason).toBeUndefined();
  });

  test('INV-4b rename 行只取 -> 之前的段, 与写集求交', () => {
    const runGit: RunGit = () => ({
      exitCode: 0,
      stdout: 'R  src/old.ts -> src/new.ts\n',
      stderr: '',
    });
    const r = writeSetChangedSinceBaseline({
      root: '/repo',
      writeSet: ['src/old.ts'],
      baseline: 'HEAD',
      runGit,
    });
    expect(r.changed).toEqual(['src/old.ts']);
  });

  test('INV-5 git 输出空 ⇒ changed 空 + reason no-change (真 empty-done 走这条)', () => {
    const runGit: RunGit = () => ({ exitCode: 0, stdout: '', stderr: '' });
    const r = writeSetChangedSinceBaseline({
      root: '/repo',
      writeSet: ['src/x.ts'],
      baseline: 'HEAD',
      runGit,
    });
    expect(r.changed).toEqual([]);
    expect(r.reason).toBe('no-change');
  });
});

// ── 闸层测试: 真 git tree + runExecutorDagWithPlan ───────────────────────────

/**
 * 跟 engine.test.ts:1180 的形状对齐: 注入 agentRunner 返回 `{ text, usage, filesTouched: [] }`,
  * 用 mkdtempSync 起一棵 git 仓 + 一次 commit 当 baseline, 改文件后跑, 看 filesTouched 是否被补。
  */
describe('救援③ 闸层: filesTouched 空 + 写集相对 baseline 改动 → 补进 filesTouched', () => {
  let tree: string;

  beforeEach(() => {
    tree = makeGitTree();
  });

  afterEach(() => {
    rmSync(tree, { recursive: true, force: true });
  });

  /**
   * 跑一次空 run, 用 `runExecutorDagWithPlan` + 注入 generate / agentRunner。
   * `continuity` 给 `{ manager, runId, repoRoot, execRoot, rollbackBaseline }`,
   * 这里 `execRoot === repoRoot === tree` (单仓模拟, 隔离档下两层重叠)。
   */
  async function runOnce(opts: {
    rollbackBaseline?: string;
    filesTouched?: string[];
    goal?: string;
    agentText?: string;
    writeSet?: string[];
  }) {
    const plan: ConductorPlan = {
      name: 'writeset-rescue',
      nodes: {
        W: {
          goal: opts.goal ?? '改文件',
          executor: 'agent',
          // 产物闸需要 declaredArtifact=true 才跑; 给 output_path 触发。
          output_path: 'src/x.ts',
          write_set: opts.writeSet ?? ['src/x.ts'],
        },
      },
    };
    const generate: GenerateFn = async () => ({ text: 'unused', usage: { in: 1, out: 1 } });
    const checkpointRoot = mkdtempSync(join(tmpdir(), 'ckpt-'));
    const manager = new CheckpointManager(checkpointRoot);
    const cfg: ExecutorDagConfig = {
      conductorModel: 'test:conductor',
      leafModel: 'test:leaf',
      generate,
      agentTemplates: new Map(),
      agentRunner: async () => ({
        text: opts.agentText ?? '读了一下, 活已干完, 没改文件',
        usage: { in: 1, out: 1 },
        filesTouched: opts.filesTouched ?? [],
      }),
      continuity: {
        manager,
        runId: 'writeset-rescue-run',
        repoRoot: tree,
        execRoot: tree,
        ...(opts.rollbackBaseline !== undefined ? { rollbackBaseline: opts.rollbackBaseline } : {}),
      },
    };
    rmSync(checkpointRoot, { recursive: true, force: true });
    return runExecutorDagWithPlan(plan, cfg);
  }

  test('★ GWT-1 隔离档: 写集相对 baseline 有改动 ⇒ filesTouched 被补, 节点 done', async () => {
    // 工作区改一下, 让 git 相对 HEAD 看见未提交改动
    writeFileSync(join(tree, 'src', 'x.ts'), '// 上一轮已干完, 本轮只读\n');
    const r = await runOnce({
      rollbackBaseline: 'HEAD',
      filesTouched: [],
      writeSet: ['src/x.ts'],
      agentText: 'Read state — already in place; no edits this round.',
    });
    expect(r.results.W!.status).toBe('done');
    expect(r.results.W!.filesTouched).toEqual(['src/x.ts']);
  });

  test('★ GWT-2 真 empty-done: 写集相对 baseline 无改动 ⇒ 节点 failed (D-4 承重)', async () => {
    // 不改工作区, git 看见的相对 baseline 就是空 → 真 empty-done 仍判死
    const r = await runOnce({
      rollbackBaseline: 'HEAD',
      filesTouched: [],
      writeSet: ['src/x.ts'],
      agentText: '什么都没改。',
    });
    expect(r.results.W!.status).toBe('failed');
    expect(r.results.W!.failureKind).toBe('empty-artifact');
    // 防御: failureKind 必须是 empty-artifact, 不能是别的
  });

  test('★ GWT-3 head 档 (不给 rollbackBaseline) ⇒ 一字节都不生效, 行为同旧', async () => {
    writeFileSync(join(tree, 'src', 'x.ts'), '// 上一轮已干完\n');
    const r = await runOnce({
      // rollbackBaseline 故意缺席
      filesTouched: [],
      writeSet: ['src/x.ts'],
      agentText: '...',
    });
    expect(r.results.W!.status).toBe('failed');
    expect(r.results.W!.failureKind).toBe('empty-artifact');
  });
});

// ── 反向自检: 两行各能证伪 ──────────────────────────────────────────────────

describe('反向自检 — 把两行各改一行, 判别力是否成立', () => {
  let tree: string;
  beforeEach(() => { tree = makeGitTree(); });
  afterEach(() => { rmSync(tree, { recursive: true, force: true }); });

  /**
   * 证伪 #1 (writeset-evidence.ts 那行 `if (!args.baseline)`):
   *   旧文 `if (!args.baseline) return ...` ⇒ helper 短路 no-baseline;
   *   改成 `if (false)` ⇒ head 档也走 git, 第三条 GWT 不再判死。
   */
  test('★ 反向自检 1: head 档护栏删了, GWT-3 当场红', async () => {
    writeFileSync(join(tree, 'src', 'x.ts'), '// 改动\n');
    const plan: ConductorPlan = {
      name: 'writeset-rescue',
      nodes: { W: { goal: '改', executor: 'agent', output_path: 'src/x.ts', write_set: ['src/x.ts'] } },
    };
    const generate: GenerateFn = async () => ({ text: '', usage: { in: 0, out: 0 } });
    const ckpt = mkdtempSync(join(tmpdir(), 'ckpt-'));
    const manager = new CheckpointManager(ckpt);
    const cfg: ExecutorDagConfig = {
      conductorModel: 'test:conductor',
      leafModel: 'test:leaf',
      generate,
      agentTemplates: new Map(),
      agentRunner: async () => ({ text: '...', usage: { in: 1, out: 1 }, filesTouched: [] }),
      continuity: { manager, runId: 'r', repoRoot: tree, execRoot: tree /* 故意不给 rollbackBaseline */ },
    };
    rmSync(ckpt, { recursive: true, force: true });
    const r = await runExecutorDagWithPlan(plan, cfg);
    // 真绿值: 节点 failed (head 档不动) — 即 head 档护栏删了, 这一条会变 done, 当场证伪。
    expect(r.results.W!.status).toBe('failed');
  });

  /**
   * 证伪 #2 (engine.ts 那行 `filesTouched.length === 0 && writeSetEvidence.changed.length > 0`):
   *   旧文要求**有证据才救** ⇒ 真 empty-done (无改动) 仍判死;
   *   改成 `filesTouched.length === 0` ⇒ 无证据也救, GWT-2 (真 empty-done) 被错误救回。
   */
  test('★ 反向自检 2: 救援条件放成 `filesTouched.length === 0`, GWT-2 当场红', async () => {
    // 工作区**不**改, 写集相对 baseline 无改动
    const plan: ConductorPlan = {
      name: 'writeset-rescue',
      nodes: { W: { goal: '改', executor: 'agent', output_path: 'src/x.ts', write_set: ['src/x.ts'] } },
    };
    const generate: GenerateFn = async () => ({ text: '', usage: { in: 0, out: 0 } });
    const ckpt = mkdtempSync(join(tmpdir(), 'ckpt-'));
    const manager = new CheckpointManager(ckpt);
    const cfg: ExecutorDagConfig = {
      conductorModel: 'test:conductor',
      leafModel: 'test:leaf',
      generate,
      agentTemplates: new Map(),
      agentRunner: async () => ({ text: '...', usage: { in: 1, out: 1 }, filesTouched: [] }),
      continuity: { manager, runId: 'r', repoRoot: tree, execRoot: tree, rollbackBaseline: 'HEAD' },
    };
    rmSync(ckpt, { recursive: true, force: true });
    const r = await runExecutorDagWithPlan(plan, cfg);
    // 真绿值: 节点 failed (真 empty-done, 不能被无证据地救) — 条件放成 `=== 0` 会变 done, 当场证伪。
    expect(r.results.W!.status).toBe('failed');
    expect(r.results.W!.failureKind).toBe('empty-artifact');
  });
});