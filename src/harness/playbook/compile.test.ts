/**
 * src/harness/playbook/compile.test.ts —— 5 frozen tests for compilePlaybook + playbook-direct wiring.
 *
 * ## 反向自检写在每条 test 注释里 (改其断言 / 删掉对应 impl = 当场红)。
 *
 * 5 cases (转录自 S5 任务书):
 *   (a) Compile correctness — documentation-coverage → 6 nodes, 串行依赖, accept 命令形状
 *   (b) Unknown name rejected — 错误信息列 builtin 名
 *   (c) Mutual exclusion — sddPath + playbook 同给 → 拒, _runDag 永不调
 *   (d) negativeSample wiring — 内容错让命令真失败 = 编译过;内容对让命令过 = 编译拒
 *   (e) End-to-end fake engine — 6 节点, plan.name 形如 playbook-, r.path = 'playbook-direct'
 *
 * 接真模块:compilePlaybook ← ./compile (真);loadPlaybookForGoal ← ../goal/playbook-direct (真);
 * (c)/(e) 走**真 runGoal** + 假引擎 (`_runDag`), 照 sdd-direct.test.ts 的夹具 —— 验收修 2026-09-04: 原版复刻分支的测试
 * 没抓到「循环压过平铺图」的接线错。
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ConductorPlan } from '../conductor-plan';
import { runGoal, type RunGoalConfig } from '../goal/run-goal';
import type { AcceptanceSpec, GoalClassification } from '../goal/classify-acceptance';
import type { ExecutorDagConfig, ExecutorDagResult } from '../dag/types';
import { loadPlaybookForGoal } from '../goal/playbook-direct';
import { compilePlaybook } from './compile';
import { BUILTIN_PLAYBOOK_DIR, loadPlaybooks } from './load';
import type { Playbook } from './types';

let tmpDirs: string[] = [];
function makeTempCwd(): string {
  const dir = mkdtempSync(join(tmpdir(), 'omd-compile-test-'));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
  tmpDirs = [];
});

// ── 真 runGoal + 假引擎 (照 sdd-direct.test.ts 的 run 夹具; 不复刻分支) ────────────────
const ACC: AcceptanceSpec = { kind: 'executable', command: 'bun test', expectExit: 0 };
const classify = async (): Promise<GoalClassification> => ({ tier: 'complex', acceptance: ACC });
const execOk = (): ExecutorDagResult =>
  ({
    plan: { name: 'x', nodes: {} },
    results: {
      accept: { id: 'accept', status: 'done', kind: 'command', output: '', deps: [], usage: { in: 0, out: 0 } },
    },
    reusedNodes: [],
  }) as unknown as ExecutorDagResult;
async function runWithPlaybook(over: Partial<RunGoalConfig>) {
  const seenPlans: ConductorPlan[] = [];
  const seenCfg: ExecutorDagConfig[] = [];
  const config: RunGoalConfig = {
    cwd: makeTempCwd(),
    dag: { conductorModel: 'c:m', leafModel: 'l:m' } as ExecutorDagConfig,
    _classify: classify,
    _runDag: (async (plan: ConductorPlan, cfg: ExecutorDagConfig) => {
      seenPlans.push(plan);
      seenCfg.push(cfg);
      return execOk();
    }) as never,
    ...over,
  };
  const r = await runGoal('按 playbook 跑', config);
  return { r, seenPlans, seenCfg };
}

// ── 5 个 frozen test cases ──────────────────────────────────────────────────

// 反向自检 (a): 把 compilePlaybook 删掉 / 让 PlanSchema.parse 抛 → 这条 expect 立即红。
describe('compilePlaybook', () => {
  test('(a) compile correctness: built-in documentation-coverage → 6 nodes, serial chain, accept command shape', async () => {
    const cwd = makeTempCwd();
    const playbooks = loadPlaybooks(cwd);
    const pb = playbooks.get('documentation-coverage');
    expect(pb).toBeDefined();
    if (!pb) return;
    const plan: ConductorPlan = await compilePlaybook(pb, {
      cwd,
      playbookRoot: join(BUILTIN_PLAYBOOK_DIR, 'documentation-coverage'),
    });
    const ids = Object.keys(plan.nodes).sort();
    expect(ids).toEqual(['accept', 'step-1', 'step-2', 'step-3', 'step-4', 'step-5']);
    expect(plan.nodes['step-1']!.depends_on).toEqual([]);
    expect(plan.nodes['step-2']!.depends_on).toEqual(['step-1']);
    expect(plan.nodes['step-3']!.depends_on).toEqual(['step-2']);
    expect(plan.nodes['step-4']!.depends_on).toEqual(['step-3']);
    // step-5 reset:true → 仍在链上 (顺序是 playbook 语义), goal 前加「不读取上游」前言。证伪: 摘链 → 这两条红。
    expect(plan.nodes['step-5']!.depends_on).toEqual(['step-4']);
    expect(plan.nodes['step-5']!.goal).toContain('[reset]');
    expect(plan.nodes['step-1']!.goal).not.toContain('[reset]');
    expect('output_type' in plan.nodes['step-1']!).toBe(false);
    expect(plan.nodes['accept']!.depends_on).toEqual(['step-5']);
    expect(plan.nodes['accept']!.executor).toBe('command');
    expect(plan.nodes['accept']!.expect_exit).toBe(0);
    expect(plan.nodes['accept']!.command).toBe('grep -qx "PLAYBOOK_COMPLETE" PLAYBOOK_STATUS.md');
    for (let i = 1; i <= 5; i++) {
      expect(plan.nodes[`step-${i}`]!.executor).toBe('agent');
    }
  });

  // 反向自检 (d-up): 把 negativeSample 内容换成会让命令通过的 → compile 不该拒 → 这条红。
  test('(d-up) negativeSample wiring: sample content makes command PASS → compile REJECTS', async () => {
    const cwd = makeTempCwd();
    const tmpRoot = mkdtempSync(join(tmpdir(), 'omd-compile-fake-'));
    tmpDirs.push(tmpRoot);
    writeFileSync(join(tmpRoot, '1.md'), '# step 1\n', 'utf8');
    const fakePb: Playbook = {
      name: 'fake-failing',
      steps: [{ doc: '1.md' }],
      acceptance: {
        command: 'grep -qx "DONE" x.txt',
        negativeSample: { path: 'x.txt', content: 'DONE' }, // 内容让命令真过 → ring → compile 拒
      },
    };
    let threw = false;
    try {
      await compilePlaybook(fakePb, { cwd, playbookRoot: tmpRoot });
    } catch (err) {
      threw = true;
      const msg = String((err as Error).message ?? err);
      expect(msg).toMatch(/undiscriminating|ring|negativeSample|判别力/i);
    }
    expect(threw).toBe(true);
  });

  // 反向自检 (d-down): 把 negativeSample 内容换成不真的反 → compile 不该拒 → 这条红。
  test('(d-down) negativeSample wiring: sample content makes command FAIL → compile SUCCEEDS', async () => {
    const cwd = makeTempCwd();
    const tmpRoot = mkdtempSync(join(tmpdir(), 'omd-compile-fake-'));
    tmpDirs.push(tmpRoot);
    writeFileSync(join(tmpRoot, '1.md'), '# step 1\n', 'utf8');
    const fakePb: Playbook = {
      name: 'fake-passing',
      steps: [{ doc: '1.md' }],
      acceptance: {
        command: 'grep -qx "DONE" x.txt',
        negativeSample: { path: 'x.txt', content: 'NOT_DONE' },
      },
    };
    const plan = await compilePlaybook(fakePb, { cwd, playbookRoot: tmpRoot });
    expect(Object.keys(plan.nodes).sort()).toEqual(['accept', 'step-1']);
  });
});

// 反向自检 (b): 把 loadPlaybookForGoal 的 builtin 名列举拿掉 → 这条 expect 红。
describe('loadPlaybookForGoal', () => {
  test('(b) unknown playbook name → reject with message listing builtin names', () => {
    const cwd = makeTempCwd();
    let threw = false;
    try {
      loadPlaybookForGoal(cwd, 'does-not-exist');
    } catch (err) {
      threw = true;
      const msg = String((err as Error).message ?? err);
      expect(msg).toContain('documentation-coverage');
    }
    expect(threw).toBe(true);
  });
});

// 反向自检 (c): 拿掉 mutual-exclusion 闸 → _runDag 被调到 → expect(callCount).toBe(0) 红。
describe('runGoal with playbook (真接线)', () => {
  test('(c) mutual exclusion: sddPath + playbook 同给 → runGoal 抛, 错误同时提两名, 引擎零调用', async () => {
    const seen: ConductorPlan[] = [];
    await expect(
      runGoal('x', {
        cwd: makeTempCwd(),
        dag: { conductorModel: 'c:m', leafModel: 'l:m' } as ExecutorDagConfig,
        _classify: classify,
        _runDag: (async (plan: ConductorPlan) => { seen.push(plan); return execOk(); }) as never,
        sddPath: '/tmp/fake-sdd.md',
        playbook: 'documentation-coverage',
      }),
    ).rejects.toThrow(/sddPath.*playbook|playbook.*sddPath/);
    expect(seen).toHaveLength(0);
  });

  test('(e) 假引擎端到端: 引擎收到的是 playbook-* 平铺图 (6 节点), 不是编排循环; path=playbook-direct; 判据 = playbook 的 acceptance', async () => {
    const { r, seenPlans, seenCfg } = await runWithPlaybook({ playbook: 'documentation-coverage' });
    expect(seenPlans.length).toBeGreaterThanOrEqual(1);
    // 证伪: run-goal 的循环守卫改回 `else` → 这里收到 goal-orchestrating-loop → 红。
    expect(seenPlans[0]!.name).toBe('playbook-documentation-coverage');
    expect(Object.keys(seenPlans[0]!.nodes)).toHaveLength(6);
    expect(r.path).toBe('playbook-direct');
    expect(r.stages.filter((s) => s.summary.includes('playbook-direct')).length).toBe(3);
    // loop.maxRounds 5 → 升级轮 min(5,4)-1 = 3 (compile.ts 头注的映射)。证伪: 删 execCfg 那一行 → undefined → 红。
    expect(seenCfg[0]!.maxEscalations).toBe(3);
    expect(seenCfg[0]!.frozenNodes).toEqual(['accept']);
  });

  test('(b2) 未知 playbook 名 → runGoal 抛且列已知名, 引擎零调用', async () => {
    const seen: ConductorPlan[] = [];
    await expect(
      runGoal('x', {
        cwd: makeTempCwd(),
        dag: { conductorModel: 'c:m', leafModel: 'l:m' } as ExecutorDagConfig,
        _classify: classify,
        _runDag: (async (plan: ConductorPlan) => { seen.push(plan); return execOk(); }) as never,
        playbook: 'does-not-exist',
      }),
    ).rejects.toThrow(/documentation-coverage/);
    expect(seen).toHaveLength(0);
  });
});

// 反向自检 (builtin surface): A-3 闸失效 / 内置层缺 → 这条红。loadPlaybooks 真路径的额外保险。
describe('builtin playbook surface', () => {
  test('loadPlaybooks(cwd=empty temp) returns documentation-coverage from builtin layer', () => {
    const cwd = makeTempCwd();
    const playbooks = loadPlaybooks(cwd);
    expect(playbooks.has('documentation-coverage')).toBe(true);
  });
});

