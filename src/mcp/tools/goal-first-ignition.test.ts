/**
 * S3 / C-3 / #250+#251 goal.ts 接线闸 —— 首跑点火预检 + 判据自证 + 终态分词的对外契约。
 *
 * 钉的不是模块实现本身 (那些在 slice 1 / 2 已绿), 而是**接线点**:
 *   · goal.ts 怎么调 ignition-preflight 与 checkIgnitionCriteria;
 *   · 怎么算 trueResume;
 *   · 终态 doneKind 怎么落进 registry 与 dag_status 文本;
 *   · 怎么拒 / 怎么放过。
 *
 * 覆盖 GWT 五条 + 三条不变量 (真 resume 路径行为不变 / 借道首跑路径 = 本契约的交付 /
 * 三值纪律)。
 *
 * 测法: 注入 stub commandRunner (零真命令), mkdtemp 仓根 (零盘外污染), 内存 registry
 * (跨进程持久化另由 run-done-kind.test.ts 钉)。
 */
import { afterEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createGoalTool } from './goal';
import { createDagTools } from './dag-tools';
import { RunRegistry } from '../run-registry';
import { CheckpointManager } from '../../harness/continuity/checkpoint-manager';
import { appendBoard, BOARD_RUN_ID } from '../../harness/board/run-board';
import type { ExecutorDagConfig } from '../../harness/dag/types';
import type { RunGoalResult, GoalClassification } from '../../harness/goal/run-goal';
import type { CommandLeafRunner } from '../../harness/leaf-runners';
import type { IgnitionRunCommand } from '../../harness/goal/ignition-criteria-check';

// ── 测试 fixtures ───────────────────────────────────────────────────────────

const SDD_WITH_NEW_FILES = [
  '# 测试契约',
  '## 目标',
  '干点活。',
  '## 契约',
  '- G-1 干完了。',
  '## 分解',
  '并行波形:{1} → {2}',
  '',
  '| 切片 | 写集 | 依赖 | verify |',
  '|---|---|---|---|',
  '| 1 新建模块 | src/new-mod.ts | — | bun test src/new-mod.ts && echo done |',
  '| 2 改造既有 | src/existing.ts, src/existing.test.ts | 1 | bun test src/existing.test.ts |',
].join('\n');

const emptyResult = (goal: string): RunGoalResult => ({
  goal,
  tier: 'simple',
  acceptance: { kind: 'executable', command: 'bun test', expectExit: 0 },
  stages: [],
  sources: [],
  repoContext: '',
  converged: true,
  outcome: 'success' as const,
  rounds: 1,
  reusedNodes: [],
});

const exploratoryResult = (goal: string): RunGoalResult => ({
  goal,
  tier: 'simple',
  acceptance: { kind: 'exploratory', learningGoal: '探索: 找方向', affordableLoss: '可承受: 探索型, 不强求落地' },
  stages: [],
  sources: [],
  repoContext: '',
  converged: true,
  outcome: 'success' as const,
  rounds: 1,
  reusedNodes: [],
});

const dirs: string[] = [];
const freshRoot = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'omd-first-ign-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const touchFile = (root: string, relPath: string): void => {
  const abs = join(root, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, '');
};

const tmpSdd = (root: string, text: string): string => {
  const p = join(root, 'docs', 'plan', 'sdd.md');
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
  return p;
};

const call = (tool: ReturnType<typeof createGoalTool>, args: Record<string, unknown>) =>
  tool.handler(args as never, {} as never) as Promise<{ content: { text: string }[]; isError?: boolean }>;

// ── goal tool 装配合成 ───────────────────────────────────────────────────────

interface MakeOpts {
  /** commandRunner 替身: 命令串 → 退出码。 */
  runner?: (command: string) => number | null;
  /** runGoal stub: 替换默认 emptyResult;若返回 undefined 则用 emptyResult。 */
  runGoalStub?: (goal: string) => RunGoalResult;
}

/** 造工具, 收 runGoal 看到的 dag config 与 registry。commandRunner 默认 passing (exit 0)。 */
const make = (opts: MakeOpts = {}) => {
  const seen: { dag?: ExecutorDagConfig }[] = [];
  const root = freshRoot();
  const registry = new RunRegistry();
  const runner = opts.runner ?? (() => 0);
  const commandRunner: CommandLeafRunner = async ({ command }) => ({
    text: '',
    usage: { in: 0, out: 0 },
    timedOut: false,
    signal: null,
    exitCode: runner(command),
  });
  const stub: (g: string) => RunGoalResult = opts.runGoalStub ?? emptyResult;
  const tool = createGoalTool({
    runGoal: async (goal, cfg) => {
      seen.push({ dag: cfg.dag });
      return stub(goal);
    },
    runRegistry: registry,
    cwd: root,
    buildConfig: () => ({ conductorModel: 'c:m', leafModel: 'l:m' }),
    continuity: { manager: new CheckpointManager(root), repoRoot: root },
    commandRunner,
  });
  return { tool, seen, registry, root, runner };
};

// ════════════════════════════════════════════════════════════════════════════
// D-1: trueResume = registry 有记录 ∨ journal 在场; 两者都缺 = 借道首跑
// ════════════════════════════════════════════════════════════════════════════

describe('C-3 / D-1 trueResume 判定', () => {
  test('GWT★: resume=未知 id ∧ 无 journal → 借道首跑, runGoal 收到的 config.continuity.resume 缺席', async () => {
    const { tool, seen } = make();
    // 选一个不会撞 OMD_DATA_HOME 下其它测试残留的 unique runId
    const ghostId = 'borrow-first-ign-test';
    await call(tool, { goal: '干点活', resume: ghostId });
    await Bun.sleep(1);
    // ★ 借道首跑语义: runId 复用 (register/reopen 那条分支没动), 但 continuity.resume 不注入
    expect(seen[0]?.dag?.continuity?.runId).toBe(ghostId);
    expect(seen[0]?.dag?.continuity?.resume).toBeUndefined();
  });

  test('GWT★: resume=已 failed 记录的 runId → 真 resume, continuity.resume=true 注入 (真 resume 不回归)', async () => {
    const { tool, seen, registry } = make();
    registry.register('real', { goal: '上轮' });
    registry.start('real');
    registry.fail('real', '挂了');
    await call(tool, { goal: '接着干', resume: 'real' });
    await Bun.sleep(1);
    expect(seen[0]?.dag?.continuity?.runId).toBe('real');
    expect(seen[0]?.dag?.continuity?.resume).toBe(true);
  });

  test('★: resume=未知 id ∧ journal 在场 (runs.db 丢失后) → 真 resume (两证据 ∨)', async () => {
    // ⚠ 隔离测试: 在自己的 tmp root 里造一个 journal, 用 unique runId 避免与其它测试
    // (共用 OMD_DATA_HOME 解析出来的 ~/.omd/projects/<slug>/continuity) 撞车。
    const root = freshRoot();
    const cm = new CheckpointManager(root);
    const ghostId = 'fixpoint-journal-test-1';
    cm.writeFixpointJournal(ghostId, {
      runId: ghostId,
      completedRounds: 1,
      poisoned: [],
      updatedAt: new Date().toISOString(),
      schemaVersion: 1,
    });
    const seen: { dag?: ExecutorDagConfig }[] = [];
    const tool = createGoalTool({
      runGoal: async (g, cfg) => {
        seen.push({ dag: cfg.dag });
        return emptyResult(g);
      },
      runRegistry: new RunRegistry(), // 无 record — 模拟 runs.db 丢失
      cwd: root,
      buildConfig: () => ({ conductorModel: 'c:m', leafModel: 'l:m' }),
      continuity: { manager: cm, repoRoot: root },
      commandRunner: async () => ({ text: '', usage: { in: 0, out: 0 }, timedOut: false, signal: null, exitCode: 0 }),
    });
    await call(tool, { goal: '接着干', resume: ghostId });
    await Bun.sleep(1);
    expect(seen[0]?.dag?.continuity?.runId).toBe(ghostId);
    expect(seen[0]?.dag?.continuity?.resume).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// INV-9: sddPath ∧ !trueResume 时, 预检过 → 跑 checkIgnitionCriteria
// ════════════════════════════════════════════════════════════════════════════

describe('C-3 / INV-9 ignition-criteria-check 接线', () => {
  test('GWT★: sddPath ∧ board 有写集相交活 run → 预检拒 (isError), registry 无该 run', async () => {
    const { tool, registry, root } = make();
    // 板上铺一条 live run 写集与新 sdd 的写集相交 (src/new-mod.ts)
    appendBoard(root, {
      v: 1,
      ts: new Date().toISOString(),
      runId: 'live-rival',
      event: 'claimed',
      writeSet: ['src/new-mod.ts'],
    });
    const sddPath = tmpSdd(root, SDD_WITH_NEW_FILES);
    const out = await call(tool, { goal: 'sddPath 点火', sddPath });
    expect(out.isError).toBe(true);
    expect(out.content[0]!.text).toContain('点火预检拒绝');
    expect(out.content[0]!.text).toContain('live-rival');
    // ★ 拒了的 run 不进 registry (D-5: 无 debris)
    expect(registry.listRuns()).toHaveLength(0);
  });

  test('GWT★: sddPath ∧ 无冲突 ∧ 某片 verify stub 预绿 → criteria-check 拒, 文本报该片 id', async () => {
    // 板上无冲突;runner 默认 passing (exit 0) → 预绿 → 拒
    const { tool, root } = make();
    const sddPath = tmpSdd(root, SDD_WITH_NEW_FILES);
    const out = await call(tool, { goal: 'sddPath 点火', sddPath });
    expect(out.isError).toBe(true);
    expect(out.content[0]!.text).toContain('点火判据自证拒绝');
    // ★ 文本报出预绿的那一片 (切片 1: 写集含新建文件 src/new-mod.ts, verify=本片写集内 → 走 pre-green 闸)
    expect(out.content[0]!.text).toContain('slice 1');
    expect(out.content[0]!.text).toContain('pre-green');
    expect(out.content[0]!.text).toContain('#251');
  });

  test('★: sddPath ∧ verify 真实会失败 (runner exit 1) → criteria-check ok, run 继续', async () => {
    const { tool, seen, root } = make({ runner: () => 1 });
    const sddPath = tmpSdd(root, SDD_WITH_NEW_FILES);
    const out = await call(tool, { goal: 'sddPath 点火', sddPath });
    expect(out.isError).toBeUndefined();
    await Bun.sleep(1);
    expect(seen).toHaveLength(1);
  });

  test('★: sddPath ∧ 真 resume → 预检与 criteria-check 都不跑 (零回归真续跑路径)', async () => {
    const { tool, seen, registry, root } = make();
    registry.register('resume-real', { goal: '上轮' });
    registry.start('resume-real');
    registry.fail('resume-real', '挂了');
    // 故意在板上铺一条与 SDD 写集相交的活 run —— 真 resume 不该被它挡住。
    appendBoard(root, {
      v: 1,
      ts: new Date().toISOString(),
      runId: 'live-rival',
      event: 'claimed',
      writeSet: ['src/new-mod.ts'],
    });
    const sddPath = tmpSdd(root, SDD_WITH_NEW_FILES);
    const out = await call(tool, { goal: '续跑', sddPath, resume: 'resume-real' });
    expect(out.isError).toBeUndefined();
    await Bun.sleep(1);
    expect(seen[0]?.dag?.continuity?.resume).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// INV-10 / INV-11: 终态分词 — doneKind 走 meta + dag_status 文本含它
// ════════════════════════════════════════════════════════════════════════════

describe('C-3 / INV-10 INV-11 终态分词消费面', () => {
  test('GWT★: exploratory converged → meta.doneKind="exploratory-unverified" 且 dag_status 文本含它', async () => {
    const { tool, registry, root } = make({ runGoalStub: exploratoryResult });
    // 触发一个 goal run (无 sddPath) 走完整 .then → succeed 带 doneKind
    const out = await call(tool, { goal: '探索型目标' });
    expect(out.isError).toBeUndefined();
    await Bun.sleep(10); // fire-and-forget .then
    const runId = /runId: (\S+)/.exec(out.content[0]!.text)![1]!;
    const rec = registry.getRecord(runId);
    expect(rec).not.toBeNull();
    expect(rec!.meta.doneKind).toBe('exploratory-unverified');
    expect(rec!.status).toBe('done');
  });

  test('★: executable converged → meta.doneKind="verified"', async () => {
    const { tool, registry } = make({ runGoalStub: emptyResult });
    const out = await call(tool, { goal: '执行型目标' });
    await Bun.sleep(10);
    const runId = /runId: (\S+)/.exec(out.content[0]!.text)![1]!;
    expect(registry.getRecord(runId)!.meta.doneKind).toBe('verified');
  });

  test('★: dag_status 文本在 done 且 meta.doneKind 存在时加一行 doneKind: <值>', async () => {
    const { tool, registry, root } = make({ runGoalStub: exploratoryResult });
    const out = await call(tool, { goal: '探索' });
    await Bun.sleep(10);
    const runId = /runId: (\S+)/.exec(out.content[0]!.text)![1]!;
    // ★ INV-11: dag_status 消费面 (在 dag-tools.ts 接线) 加一行 doneKind: <值>
    const dagStatus = createDagTools({
      engine: { runExecutorDag: async () => ({} as never), runExecutorDagWithPlan: async () => ({} as never) },
      runRegistry: registry,
      continuity: { manager: new CheckpointManager(root), repoRoot: root },
    }).find((t) => t.name === 'dag_status')!;
    const stOut = await call(dagStatus, { runId });
    expect(stOut.isError).toBeUndefined();
    const fullText = stOut.content.map((c) => c.text).join('\n');
    expect(fullText).toContain('doneKind: exploratory-unverified');
  });

  test('★ 三值纪律: doneKind 缺席的 run 不输出 doneKind 行 (NULL ≠ 不适用)', async () => {
    const { tool, registry, root } = make();
    // 直接 register+start+succeed (不带 doneKind) —— 老路径 / dag_run 入口
    registry.register('non-goal', { goal: 'g' });
    registry.start('non-goal');
    registry.succeed('non-goal', 'ok'); // 无 doneKind
    const dagStatus = createDagTools({
      engine: { runExecutorDag: async () => ({} as never), runExecutorDagWithPlan: async () => ({} as never) },
      runRegistry: registry,
      continuity: { manager: new CheckpointManager(root), repoRoot: root },
    }).find((t) => t.name === 'dag_status')!;
    const stOut = await call(dagStatus, { runId: 'non-goal' });
    const fullText = stOut.content.map((c) => c.text).join('\n');
    expect(fullText).not.toContain('doneKind:');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// INV-12 不变量 (真 resume 路径行为字节不变)
// ════════════════════════════════════════════════════════════════════════════

describe('C-3 / INV-12 真 resume 路径不变量', () => {
  test('★: 真 resume (registry 有 failed) → 预检与 criteria-check 都不跑, continuity.resume=true', async () => {
    // 已在 D-1 第一组测试覆盖过真 resume 的 continuity.resume=true。
    // 这里加一条防御: 真 resume 上, 故意制造一个「写集相交活 run」, 也不应被预检挡掉。
    const { tool, seen, registry, root } = make();
    registry.register('resume-real-2', { goal: '上轮' });
    registry.start('resume-real-2');
    registry.fail('resume-real-2', '挂了');
    appendBoard(root, {
      v: 1,
      ts: new Date().toISOString(),
      runId: 'live-rival-2',
      event: 'claimed',
      writeSet: ['src/new-mod.ts', 'src/existing.ts'],
    });
    const sddPath = tmpSdd(root, SDD_WITH_NEW_FILES);
    const out = await call(tool, { goal: '续跑', sddPath, resume: 'resume-real-2' });
    expect(out.isError).toBeUndefined();
    await Bun.sleep(1);
    expect(seen[0]?.dag?.continuity?.resume).toBe(true);
  });

  test('★: 借道首跑 (无盘上证据) → 预检与 criteria-check 跑 (worker 路径不再静默跳过)', async () => {
    // 这是 GWT 的反面: 借道首跑上, 预检与 criteria-check 都跑 (旧版完全跳过)。
    // 用一个写集与 SDD 不冲突、verify 又会失败 (runner exit 1) 的场景,
    // 证明 handler 走到了 checkIgnitionCriteria (即没被「!resume」短路掉)。
    const { tool, seen, root } = make({ runner: () => 1 });
    const sddPath = tmpSdd(root, SDD_WITH_NEW_FILES);
    // 不传 resume —— 但模拟 worker `--run-id` 路径: 给一个**未知** runId (无 record 无 journal)
    const out = await call(tool, { goal: 'sddPath 点火', sddPath, resume: 'worker-ghost' });
    // 预检过 (板上无冲突) ∧ criteria-check 过 (runner exit 1) → run 起
    expect(out.isError).toBeUndefined();
    await Bun.sleep(1);
    expect(seen[0]?.dag?.continuity?.runId).toBe('worker-ghost');
    expect(seen[0]?.dag?.continuity?.resume).toBeUndefined(); // ★ 借道首跑 = 不注入
  });
});
