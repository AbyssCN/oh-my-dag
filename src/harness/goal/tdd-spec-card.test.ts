/**
 * D-J TDD 流程 + 防作弊条款 (2026-07-29) —— 它们进的是 **spec-author 卡**, 不是新节点类型。
 *
 * 为什么钉成测试而不是"写进卡就完了": 这些条款有一条**很容易被写歪的性质** —— 只留在卡上
 * 保护不了任何东西。执行体读的是 spec 契约, 不是这张卡; 卡的活是**要求起草者把条款抄进契约**。
 * 卡上少了"copy into the contract"这句, 整套防作弊就变成一段没人看的自我安慰。
 *
 * 另一半 (D-I 判卷标准真的流到了 spec prompt 与 execute 任务文本) 一并在此钉住 —— 判据只要
 * 有一处没到, 那一处就是作弊达标的入口。
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BUILTIN_AGENT_TEMPLATES } from '../agent-templates-builtin';
import { runGoal, type RunGoalConfig } from './run-goal';
import type { AcceptanceSpec, GoalClassification, GoalTier } from './classify-acceptance';
import type { ConductorPlan } from '../conductor-plan';
import type { ExecutorDagConfig, ExecutorDagResult } from '../dag/types';

const card = (): string => BUILTIN_AGENT_TEMPLATES.find((t) => t.name === 'spec-author')!.body;

describe('D-J — TDD 四段流程写进 spec 卡 (两个现成件的组合, 不加节点类型)', () => {
  test('四段齐全且点名 expect_exit 的红/绿两档', () => {
    const b = card();
    for (const slice of ['TEST', 'RED', 'IMPL', 'GREEN']) expect(b).toContain(slice);
    expect(b).toContain('expect_exit:1'); // 证红
    expect(b).toContain('expect_exit:0'); // 收敛
    expect(b).toContain('executor:"command"'); // 走现成节点, 不新造类型
  });

  test('红步与绿步必须同一条命令 (换条命令 = 换了个问题)', () => {
    expect(card()).toContain('SAME command');
  });

  test('明说"别在 shell 里取反" —— 那族写法会被闸拒绝执行, 看起来却像测试失败', () => {
    expect(card()).toContain('Do not negate a command in the shell');
  });

  test('红输出当制品往下传 (实现者要读的就是那段失败文本)', () => {
    expect(card()).toMatch(/artifact|carry the failure/i);
  });
});

describe('D-J — 防作弊条款, 且必须被抄进契约本身', () => {
  test('卡要求把条款抄进契约, 并说明理由 (留在卡上保护不了执行体)', () => {
    const b = card();
    expect(b).toContain('copy these into');
    expect(b).toContain('The executor reads the contract, not this card');
  });

  test('基线不可退', () => {
    expect(card()).toContain('BASELINE MUST NOT REGRESS');
  });

  test('通往绿灯的禁用路线**逐条点名** (泛泛说"别作弊"挡不住任何具体做法)', () => {
    const b = card();
    for (const named of ['skip', 'loosening an assertion', 'mocking out', 'deleting', 'widening a type']) {
      expect(b).toContain(named);
    }
  });

  test('判卷标准冻结: 判据错了是"报告一个发现", 不是"实施途中顺手改"', () => {
    const b = card();
    expect(b).toContain('MARKING SCHEME IS FROZEN');
    expect(b).toContain('not an edit to make while implementing');
  });

  test('实现/测试分离可审计: 点名 git diff --stat 闸', () => {
    const b = card();
    expect(b).toContain('git diff --stat');
    expect(b).toContain('IMPLEMENTATION/TEST SEPARATION IS AUDITABLE');
  });
});

// ── D-I 端到端接线 ─────────────────────────────────────────────────────────────

/** D-F: 执行段也是一张单 conductor 节点的图; 裁决盖在 leaf 的 converged 上。 */
const okExecute = (): ExecutorDagResult =>
  ({
    plan: { name: 'goal-execute', nodes: {} },
    results: { execute: { id: 'execute', status: 'done', kind: 'conductor', output: 'ok', deps: [], usage: { in: 1, out: 1 }, rounds: 1, converged: true } },
    reusedNodes: [],
  }) as unknown as ExecutorDagResult;

/** 两段共用 `_runDag`, 按 plan.name 路由 (契约段没给就返一个"什么都没分解出来"的空结果)。 */
const router = (h: { contract?: (p: ConductorPlan) => Promise<ExecutorDagResult>; execute?: (p: ConductorPlan) => Promise<ExecutorDagResult> }) =>
  (async (plan: ConductorPlan) =>
    plan.name === 'goal-execute'
      ? await (h.execute ?? (async () => okExecute()))(plan)
      : await (h.contract ?? (async () => ({ plan: { name: 'goal-contract', nodes: {} }, results: {} }) as unknown as ExecutorDagResult))(plan)) as never;

const cls =
  (tier: GoalTier, acceptance: AcceptanceSpec) =>
  async (): Promise<GoalClassification> => ({ tier, acceptance });

function cfg(dag: Partial<ExecutorDagConfig> = {}, extra: Partial<RunGoalConfig> = {}): RunGoalConfig {
  return {
    cwd: mkdtempSync(join(tmpdir(), 'omd-dij-')),
    dag: { conductorModel: 'c:m', leafModel: 'l:m', ...dag } as ExecutorDagConfig,
    _today: () => '2026-07-29',
    _runDag: router({}),
    ...extra,
  };
}

describe('D-I — 判卷标准流到每一处该到的地方', () => {
  const EXEC: AcceptanceSpec = { kind: 'executable', command: 'bun run tsc --noEmit && bun test', expectExit: 0 };

  /**
   * D-G′ 之后契约段变成一个 conductor 节点。owner 定的方案 A: **判卷标准留在那个节点之外**,
   * 由 classify 在环外算好、冻进它的 goal 当输入 —— 放进子图就等于让执行体自己的环去产出判据,
   * 而环每轮重画, 判据也就跟着能变。这条测试钉的就是"两处拿到同一份, 且都在动手之前"。
   */
  // D-26/D-27 (2026-09-02): 契约段的唯一触发换成了 sddPath, 不再由 tier='complex' 自动展开
  // conductor 子图。这条测试原来钉的是"契约段 goal 与 execute 任务文本两处拿到同一份判卷标准" ——
  // 那两处里的第一处 (自动契约段) 已撤销, 现在只剩 execute 任务文本这一处落点。零契约段调用这条
  // 不变量另钉在 contract-stage-gate.test.ts (INV-11), 这里只留"判卷标准仍流到 execute 任务文本"。
  test('complex 档 (无 sddPath): execute 任务文本仍带判卷标准 (契约段不再自动展开)', async () => {
    let task = '';
    await runGoal('加一个字段', {
      ...cfg(),
      _classify: cls('complex', EXEC),
      _runDag: router({
        execute: async (plan) => {
          task = String(plan.nodes.execute!.goal);
          return okExecute();
        },
      }),
    });
    expect(task).toContain('## 判卷标准 (冻结 — 执行型)');
    expect(task).toContain('bun run tsc --noEmit && bun test');
    expect(task).toContain('期望退出码: 0');
  });

  test('simple 档也附判卷标准 —— 它不产 spec, 判据没有别的落点', async () => {
    let task = '';
    await runGoal('重命名', {
      ...cfg(),
      _classify: cls('simple', EXEC),
      _runDag: router({
        execute: async (plan) => {
          task = String(plan.nodes.execute!.goal);
          return okExecute();
        },
      }),
    });
    expect(task).toContain('## 判卷标准');
    expect(task).toContain('bun run tsc --noEmit && bun test');
  });

  test('探索型: 任务文本明说没有机器判据, 且带上可承受损失 (不许伪造一个判据)', async () => {
    let task = '';
    const r = await runGoal('摸清 checkpoint 有哪几种布局', {
      ...cfg(),
      _classify: cls('complex', { kind: 'exploratory', learningGoal: '有哪几种可行布局', affordableLoss: '两轮执行' }),
      _runDag: router({
        execute: async (plan) => {
          task = String(plan.nodes.execute!.goal);
          return okExecute();
        },
      }),
    });
    expect(task).toContain('没有机器判据');
    expect(task).toContain('两轮执行');
    expect(r.acceptance.kind).toBe('exploratory');
  });

  test('分型进 classify 阶段摘要与 RunGoalResult (降级不许只活在日志里)', async () => {
    const r = await runGoal('g', { ...cfg(), _classify: cls('simple', EXEC) });
    expect(r.acceptance).toEqual(EXEC);
    const s = r.stages.find((x) => x.stage === 'classify')!;
    expect(s.summary).toContain('验收=执行型');
    expect(s.summary).toContain('bun run tsc --noEmit && bun test');
  });

  test('显式 tier 只压成本轴, 压不到判据轴 ("我知道这活儿轻" ≠ "我知道这活儿怎么判")', async () => {
    const exploratory: AcceptanceSpec = { kind: 'exploratory', learningGoal: 'L', affordableLoss: 'A' };
    const r = await runGoal('g', { ...cfg(), tier: 'simple', _classify: cls('complex', exploratory) });
    expect(r.tier).toBe('simple'); // 显式压过分类
    expect(r.acceptance).toEqual(exploratory); // 判据轴照旧来自分类
  });
});

// ── item 12 (D-G′) 方案 A —— 撤销 (D-26/D-27, 2026-09-02) ──────────────────────
//
// 这一整块原来钉的是「tier='complex' 且无 sddPath → 自动展开一个 executor:'conductor' 节点
// 勘察/调研/起草一份 SDD」。契约段门控换成 sddPath 之后 (INV-11), 这条自动转录路径整体撤销:
// 无 sddPath 时契约段三 stage 一律 skipped、conductor 契约段调用计数为 0 —— 这块测的正是
// 撤销掉的那个节点长什么样, 该节点已不存在, 留着只会让这个文件对现状撒谎。
// 新覆盖面: contract-stage-gate.test.ts (INV-11 两格) + classify-route-once.test.ts (INV-12)。
