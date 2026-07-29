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
import type { AcceptanceSpec, GoalClassification, GoalTier } from './acceptance';
import type { ExecutorDagConfig } from '../executor-dag-types';
import type { IterateResult } from '../plan/iterate';

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

const okIterate = (): IterateResult =>
  ({ rounds: [{ round: 1, result: {}, verdict: {} }], finalRound: { round: 1, result: { reusedNodes: [] }, verdict: {} }, converged: true, status: 'converged' }) as unknown as IterateResult;

const cls =
  (tier: GoalTier, acceptance: AcceptanceSpec) =>
  async (): Promise<GoalClassification> => ({ tier, acceptance });

function cfg(dag: Partial<ExecutorDagConfig> = {}, extra: Partial<RunGoalConfig> = {}): RunGoalConfig {
  return {
    cwd: mkdtempSync(join(tmpdir(), 'omd-dij-')),
    dag: { conductorModel: 'c:m', leafModel: 'l:m', ...dag } as ExecutorDagConfig,
    _today: () => '2026-07-29',
    _iterate: (async () => okIterate()) as never,
    ...extra,
  };
}

describe('D-I — 判卷标准流到每一处该到的地方', () => {
  const EXEC: AcceptanceSpec = { kind: 'executable', command: 'bun run tsc --noEmit && bun test', expectExit: 0 };

  test('complex 档: spec 起草 prompt 与 execute 任务文本拿到**同一份**判卷标准', async () => {
    let specPrompt = '';
    let task = '';
    let agentCall = 0;
    await runGoal('加一个字段', {
      ...cfg({
        agentRunner: async ({ prompt }) => {
          if (agentCall++ === 0) return { text: 'src/x.ts:1 — 事实', usage: { in: 1, out: 1 } };
          specPrompt = prompt;
          return { text: '# SDD', usage: { in: 1, out: 1 }, filesTouched: [] };
        },
      }),
      _classify: cls('complex', EXEC),
      _iterate: (async (t: string) => {
        task = t;
        return okIterate();
      }) as never,
    });
    for (const text of [specPrompt, task]) {
      expect(text).toContain('## 判卷标准 (冻结 — 执行型)');
      expect(text).toContain('bun run tsc --noEmit && bun test');
      expect(text).toContain('期望退出码: 0');
    }
  });

  test('simple 档也附判卷标准 —— 它不产 spec, 判据没有别的落点', async () => {
    let task = '';
    await runGoal('重命名', {
      ...cfg(),
      _classify: cls('simple', EXEC),
      _iterate: (async (t: string) => {
        task = t;
        return okIterate();
      }) as never,
    });
    expect(task).toContain('## 判卷标准');
    expect(task).toContain('bun run tsc --noEmit && bun test');
  });

  test('探索型: 任务文本明说没有机器判据, 且带上可承受损失 (不许伪造一个判据)', async () => {
    let task = '';
    const r = await runGoal('摸清 checkpoint 有哪几种布局', {
      ...cfg(),
      _classify: cls('complex', { kind: 'exploratory', learningGoal: '有哪几种可行布局', affordableLoss: '两轮执行' }),
      _iterate: (async (t: string) => {
        task = t;
        return okIterate();
      }) as never,
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
