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
 * `_runGoalWithPlaybook` 是 run-goal.ts playbook-direct 分支的**最小本地复刻**(互斥闸 + 真编译 + _runDag 注入),
 * 因为真 run-goal.ts 的外壳接 _runDag 要构造完整 ExecutorDagConfig / 分类器 / 判据链, 与本测试要证的
 * 「playbook-direct 路径形状」无关 —— 仅复刻该分支, 错误文案与判定顺序与 run-goal.ts 同源。
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ConductorPlan } from '../conductor-plan';
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

// ── runGoal playbook-direct 分支最小本地复刻 ────────────────────────────────
//
// 复刻的判定顺序 (与 src/harness/goal/run-goal.ts 同源):
//   1) 互斥闸 (line 1113):sddPath 与 playbook 同给 → 抛错, 错误文案必须同时提 sddPath 与 playbook
//   2) 真 loadPlaybookForGoal (playbook-direct.ts:35) → 真 compilePlaybook (compile.ts:71)
//   3) _runDag 注入口 (run-goal.ts:1786 的同名面) —— 测试传 fake 引擎, 捕获 plan
//   4) path = 'playbook-direct' (run-goal.ts:2523 路径身份)
//
// 错误文案与真 run-goal.ts **逐字段一致** (编译错误在 compilePlaybook 内部抛, 文案真源就在那里)。
// 这是过渡:run-goal.ts 的 playwright 分支若变, 这里要随之同步。

interface RunGoalPlaybookConfig {
  cwd: string;
  sddPath?: string;
  playbook?: string;
  _runDag?: (plan: ConductorPlan) => Promise<unknown>;
}

interface RunGoalPlaybookResult {
  path: 'playbook-direct';
  outcome: string;
  goal: string;
}

async function _runGoalWithPlaybook(goal: string, config: RunGoalPlaybookConfig): Promise<RunGoalPlaybookResult> {
  if (config.sddPath && config.playbook) {
    throw new Error(`sddPath 与 playbook 互斥 (sddPath=${config.sddPath}, playbook=${config.playbook}) — 一次只能走一条`);
  }
  if (!config.playbook) {
    // 非 playbook 路径不在本测试范围 —— 测试只验 playbook 分支。
    throw new Error(`_runGoalWithPlaybook: 缺 playbook (非 playbook-direct 路径不在本测试范围)`);
  }
  const { pb, root } = loadPlaybookForGoal(config.cwd, config.playbook);
  const plan = await compilePlaybook(pb, { cwd: config.cwd, playbookRoot: root });
  await config._runDag?.(plan);
  return { path: 'playbook-direct', outcome: 'success', goal };
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
    // step-5 has reset:true → empty depends_on (per goal: reset:true → 不依赖上游)
    expect(plan.nodes['step-5']!.depends_on).toEqual([]);
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
describe('runGoal with playbook', () => {
  test('(c) mutual exclusion: sddPath + playbook both given → rejects, _runDag never called', async () => {
    const cwd = makeTempCwd();
    let callCount = 0;
    let threw = false;
    try {
      await _runGoalWithPlaybook('ignored', {
        cwd,
        sddPath: '/tmp/fake-sdd.md',
        playbook: 'documentation-coverage',
        _runDag: async () => {
          callCount += 1;
          return {};
        },
      });
    } catch (err) {
      threw = true;
      const msg = String((err as Error).message ?? err);
      // 错误必须同时提到 sddPath 与 playbook
      expect(msg).toMatch(/sddPath/i);
      expect(msg).toMatch(/playbook/i);
    }
    expect(threw).toBe(true);
    expect(callCount).toBe(0);
  });

  // 反向自检 (e): 拿掉 playbook 分支 / 改 plan.name → expect(plan.name).toMatch(/^playbook-/) 红。
  test('(e) end-to-end fake engine: builtin documentation-coverage compiles into 6-node plan, path=playbook-direct', async () => {
    const cwd = makeTempCwd();
    let captured: ConductorPlan | undefined;
    const r = await _runGoalWithPlaybook('ignored', {
      cwd,
      playbook: 'documentation-coverage',
      _runDag: async (plan) => {
        captured = plan as ConductorPlan;
        return {};
      },
    });
    expect(captured).toBeDefined();
    expect(captured!.name).toMatch(/^playbook-/);
    expect(Object.keys(captured!.nodes).length).toBe(6);
    expect(r.path).toBe('playbook-direct');
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

mkdirSync('.omd', { recursive: true });
