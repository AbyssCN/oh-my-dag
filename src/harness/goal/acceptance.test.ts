/**
 * D-I 验收分型 (2026-07-29) —— 判据轴的契约测试。零 live 模型 (generate 全注入)。
 *
 * 这一站要挡的是**作弊达标**: 执行体把判据改到自己够得着的地方然后诚实地报告"绿了"。
 * 挡法只有一个 —— 动手之前就把判卷标准冻结成一条**别人来跑**的命令。
 * 于是本闸盯三件事: ① 执行型必须拿得出**真跑得起来**的命令 ② 拿不出就诚实降级成探索型而不是
 * 留一个空判据 ③ 探索型必须有学习目标 + 可承受损失 (判不了成败, 至少定得了亏损上限)。
 */
import { describe, expect, test } from 'bun:test';
import {
  acceptanceCommandBlockReason,
  classifyGoal,
  classifyPrompt,
  isRunnableAcceptanceCommand,
  normalizeClassification,
  renderAcceptance,
  type AcceptanceSpec,
} from './acceptance';
import { DEFAULT_COMMAND_ALLOWLIST } from '../command-leaf';
import type { GenerateFn } from '../executor-dag-types';

const gen = (text: string): GenerateFn => async () => ({ text, usage: { in: 1, out: 1 } });

describe('可跑判定 —— 借执行期那一份闸, 不另抄一份', () => {
  test('白名单内 + 无元字符 → 可跑; && 链每环独立过闸', () => {
    expect(isRunnableAcceptanceCommand('bun test')).toBe(true);
    expect(isRunnableAcceptanceCommand('bun run tsc --noEmit && bun test')).toBe(true);
    expect(isRunnableAcceptanceCommand('bun test src/harness/goal/acceptance.test.ts')).toBe(true);
  });

  test('白名单外 / 元字符 / git 写 / 空 → 不可跑, 且给得出拒因', () => {
    expect(acceptanceCommandBlockReason('pytest -q')).toContain('not-allowed');
    expect(acceptanceCommandBlockReason('bun test; echo done')).toContain('shell-metachar');
    expect(acceptanceCommandBlockReason('bun test | tee log')).toContain('shell-metachar');
    // 危险命令闸排在白名单/元字符之前 —— 拒因给的是最要紧的那条, 不是最先匹配的那条。
    expect(acceptanceCommandBlockReason('bun test; rm -rf /')).toContain('dangerous');
    expect(acceptanceCommandBlockReason('git commit -am x')).toContain('git-write');
    expect(acceptanceCommandBlockReason('   ')).toContain('empty');
  });

  test('&& 链里**任一环**不合法 → 整条不可跑 (fail-closed, 防合法头环先执行)', () => {
    expect(isRunnableAcceptanceCommand('bun test && pytest')).toBe(false);
    expect(isRunnableAcceptanceCommand('bun test && git push')).toBe(false);
  });
});

describe('归一 —— 弱模型每一格都自己兜, 但两条轴兜的方向相反', () => {
  test('执行型 + 可跑命令 → 原样收下 (expectExit 恒 0: 总验收判绿)', () => {
    const c = normalizeClassification({ tier: 'simple', acceptance_kind: 'executable', command: '  bun test  ' });
    expect(c.tier).toBe('simple');
    expect(c.acceptance).toEqual({ kind: 'executable', command: 'bun test', expectExit: 0 });
  });

  test('执行型但命令跑不起来 → **降级探索型**, 原因写进学习目标 (不留空判据)', () => {
    const c = normalizeClassification({ tier: 'simple', acceptance_kind: 'executable', command: 'pytest -q' });
    expect(c.acceptance.kind).toBe('exploratory');
    // 降级必须说得出为什么 —— 否则它和"本来就是探索型"分不开, 而这两件事该被区别对待。
    expect(c.acceptance.kind === 'exploratory' && c.acceptance.learningGoal).toContain('not-allowed');
    expect(c.tier).toBe('simple'); // 成本轴不受判据轴降级牵连
  });

  test('执行型漏给 command → 同样降级 (执行型的全部意义就是那条命令)', () => {
    const c = normalizeClassification({ tier: 'complex', acceptance_kind: 'executable' });
    expect(c.acceptance.kind).toBe('exploratory');
  });

  test('探索型齐全 → 收下; 缺学习目标或可承受损失 → 兜底 (两样都没有 = 什么都没定)', () => {
    const ok = normalizeClassification({
      acceptance_kind: 'exploratory',
      learning_goal: '搞清楚有几种可行的 checkpoint 布局',
      affordable_loss: '两轮执行 + 一次真跑',
    });
    expect(ok.acceptance).toEqual({
      kind: 'exploratory',
      learningGoal: '搞清楚有几种可行的 checkpoint 布局',
      affordableLoss: '两轮执行 + 一次真跑',
    });

    const missing = normalizeClassification({ acceptance_kind: 'exploratory', learning_goal: '学点东西' });
    expect(missing.acceptance.kind).toBe('exploratory');
    expect(missing.acceptance.kind === 'exploratory' && missing.acceptance.affordableLoss).toBeTruthy();
  });

  test('tier 兜底方向 = complex (多接地一遍代价是钱; 误判 simple 代价是无证据契约被执行)', () => {
    expect(normalizeClassification({}).tier).toBe('complex');
    expect(normalizeClassification({ tier: '胡说' }).tier).toBe('complex');
    expect(normalizeClassification({ tier: 'SIMPLE' }).tier).toBe('simple');
  });

  test('判据轴兜底方向 = exploratory (假装机器可判而无人判, 比明说判不了坏得多)', () => {
    expect(normalizeClassification({}).acceptance.kind).toBe('exploratory');
    expect(normalizeClassification({ acceptance_kind: '随便' }).acceptance.kind).toBe('exploratory');
  });
});

describe('分类调用 —— 挂了就往保守档落, 不抛 (分类是路由不是闸)', () => {
  test('正常 JSON (含 ``` 围栏与前后散文) 也能抠出来', async () => {
    const c = await classifyGoal('给引擎加个字段', {
      generate: gen('好的:\n```json\n{"tier":"simple","acceptance_kind":"executable","command":"bun test"}\n```\n完毕'),
      model: 'c:m',
    });
    expect(c.tier).toBe('simple');
    expect(c.acceptance.kind).toBe('executable');
  });

  test('无 generate/model → 全保守档, 不抛', async () => {
    const c = await classifyGoal('g', {});
    expect(c).toEqual({ tier: 'complex', acceptance: expect.objectContaining({ kind: 'exploratory' }) });
  });

  test('模型吐垃圾 / 抛错 → 全保守档, 不抛', async () => {
    expect((await classifyGoal('g', { generate: gen('不是 JSON'), model: 'c:m' })).tier).toBe('complex');
    const boom: GenerateFn = async () => {
      throw new Error('429');
    };
    const c = await classifyGoal('g', { generate: boom, model: 'c:m' });
    expect(c.acceptance.kind).toBe('exploratory');
  });

  test('prompt 把白名单拼进去 —— 不给表就只能猜, 猜错即「假红」(承 conductor prompt 同一教训)', () => {
    const p = classifyPrompt('随便一个目标');
    for (const bin of ['bun', 'tsc', 'git', 'grep']) expect(p).toContain(bin);
    expect(p).toContain(DEFAULT_COMMAND_ALLOWLIST[0]!);
    expect(p).toContain('随便一个目标');
    // 两条轴必须被明说成互相独立, 否则模型会把 complex 顺手读成"判不了"。
    expect(p).toContain('互相独立');
  });
});

describe('冻结的判卷标准 —— 一份文本, 两处消费', () => {
  test('执行型: 命令 + 期望退出码 + 「不许中途改判据」', () => {
    const t = renderAcceptance({ kind: 'executable', command: 'bun test', expectExit: 0 });
    expect(t).toContain('执行型');
    expect(t).toContain('bun test');
    expect(t).toContain('期望退出码: 0');
    expect(t).toContain('不许');
  });

  test('探索型: 明说没有机器判据 + 学习目标 + 可承受损失', () => {
    const spec: AcceptanceSpec = { kind: 'exploratory', learningGoal: '摸清 X', affordableLoss: '两轮' };
    const t = renderAcceptance(spec);
    expect(t).toContain('没有机器判据');
    expect(t).toContain('摸清 X');
    expect(t).toContain('两轮');
    // 不许伪造一个判据 —— 这句必须在, 它是探索型最容易被违反的一条。
    expect(t).toContain('不要伪造');
  });
});
