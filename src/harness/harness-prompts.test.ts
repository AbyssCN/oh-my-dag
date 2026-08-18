/**
 * harness-prompts 的**组成钉**(同 agent-leaf-prompt-version.test.ts 的哲学:钉性质,不钉哈希值——
 * 哈希随正文变,那正是它该变的时候;这里钉的是"变必须是有意识行为"的那些结构性质)。
 *
 * 反向自检:每条钉都会红——改冻结段拼序 → 前缀钉红;默认开 harnessCore → 默认钉红;
 * 补焊块重复 DISCIPLINE_CORE 词条 → 互补钉红。
 */
import { describe, expect, test } from 'bun:test';
import { CONDUCTOR_HARNESS_CORE, CONDUCTOR_SITUATIONAL, LEAF_HARNESS_CORE, buildConductorChatSystemPrompt } from './harness-prompts';
import { agentScaffold } from './agent-leaf';
import { promptVersionOfText } from '../model/langfuse';

const WEAK = { profile: 'weak', model: 'deepseek:deepseek-v4-flash', toolRouting: true, disciplineCore: true } as const;

describe('conductor 档:冻结前缀在前,动态尾在后(cache 面结构)', () => {
  test('★ 输出以 CONDUCTOR_HARNESS_CORE 逐字开头 —— 冻结段是第一个 cache 面', () => {
    const p = buildConductorChatSystemPrompt({ cwd: '/w' });
    expect(p.startsWith(CONDUCTOR_HARNESS_CORE)).toBe(true);
  });

  test('★ 同配置重复拼装字节相同;换 cwd 只动尾部(分歧点在工具段之后)', () => {
    const tools = [{ name: 'dag_status', promptSnippet: 'dag_status: 查一个 run 的进度' }];
    const a1 = buildConductorChatSystemPrompt({ cwd: '/w1', tools });
    const a2 = buildConductorChatSystemPrompt({ cwd: '/w1', tools });
    const b = buildConductorChatSystemPrompt({ cwd: '/w2', tools });
    expect(a1).toBe(a2);
    // cwd 不同的两份,在 "Working root" 之前的前缀(冻结核 + 工具段)必须逐字相同。
    const head = (s: string) => s.slice(0, s.indexOf('Working root'));
    expect(head(a1)).toBe(head(b));
    expect(head(a1)).toContain('dag_status');
  });

  test('无 promptSnippet 的工具不产生空段;无工具时没有 "Available tools" 头', () => {
    const p = buildConductorChatSystemPrompt({ cwd: '/w', tools: [{ name: 'bare' }] });
    expect(p).not.toContain('Available tools');
    expect(p).not.toContain('\n\n\n');
  });

  test('冻结核覆盖蒸馏源的承重段(丢一段 = 蒸馏残缺,当场红)', () => {
    for (const anchor of [
      '<stance>', '<roles>', '<core-discipline>', '<final-ruling>',
      '<gates>', '<dispatch>', '<owner>', '<recommendation-restraint>',
      // 2026-08-07 第三趟清点的 F-1..F-4 (skill 方法论进 conductor)
      '<question-triage>', '<deliberation-order>', '<absent-upstream>', '<external-baseline>',
    ]) {
      expect(CONDUCTOR_HARNESS_CORE).toContain(anchor);
    }
  });

  test('★ 情境段拼在冻结核之后、工具快照之前(两个常量构成稳定前缀)', () => {
    const tools = [{ name: 'dag_status', promptSnippet: 'dag_status: 查一个 run 的进度' }];
    const p = buildConductorChatSystemPrompt({ cwd: '/w', tools });
    // 反向自检: 把 CONDUCTOR_SITUATIONAL 从 parts 里拿掉 → 第一条红;
    // 挪到 tools 之后 → 第二条红 (顺序钉的是 cache 面结构, 不是"在不在")。
    expect(p).toContain(CONDUCTOR_SITUATIONAL);
    expect(p.indexOf(CONDUCTOR_SITUATIONAL)).toBeLessThan(p.indexOf('Available tools'));
    expect(p.startsWith(`${CONDUCTOR_HARNESS_CORE}\n\n${CONDUCTOR_SITUATIONAL}`)).toBe(true);
  });

  test('情境段覆盖 12 块(丢一块当场红)', () => {
    for (const anchor of [
      '<cross-validation>', '<recall-discipline>', '<iteration-bound>',
      // Y-6 knowledge-boundary (2026-08-17 APoSD 蒸馏: 按知识边界分解, 反时序性分解)
      '<vertical-slicing>', '<knowledge-boundary>', '<scope-lock>',
      // 2026-08-18: conductor 不再读 CLAUDE.md (a426e09) 之后补进来的六块
      '<experiment-discipline>', '<ruler-honesty>', '<silent-failure-modes>',
      '<before-asserting>', '<solve-ignition>', '<output-style>',
    ]) {
      expect(CONDUCTOR_SITUATIONAL).toContain(anchor);
    }
  });

  test('★ 情境段与冻结核不重复(重复 = 每轮付两遍 token 且蒸馏走样)', () => {
    // 核里已焊的承重词不许在情境段再现 —— 分野是"常驻价值", 重复即分野失效。
    // 'Cost is the test' = 核 <question-triage> FACT 车道的 P-2 原句 —— 2026-08-18 补进来的
    // 六块刻意不重写它 (M3 那版草稿重写了, 会让同一条纪律每轮付两遍 token)。
    for (const dup of ['<gates>', '3 strikes', 'Anti-happy-path', 'ceremonial asking', 'Cost is the test']) {
      expect(CONDUCTOR_SITUATIONAL).not.toContain(dup);
    }
  });
});

describe('leaf 档:opt-in 补焊,默认零字节变化(读数纪律)', () => {
  test('★ 默认 off:不传 harnessCore 与显式 false 字节相同,且不含补焊块', () => {
    expect(agentScaffold(WEAK)).toBe(agentScaffold({ ...WEAK, harnessCore: false }));
    expect(agentScaffold(WEAK)).not.toContain('<harness-core');
  });

  test('★ 开关改变 promptVersion(可分组), 拼位在 discipline 与 tool-routing 之间(元规则→补焊→工具细则)', () => {
    const on = agentScaffold({ ...WEAK, harnessCore: true });
    expect(promptVersionOfText(on)).not.toBe(promptVersionOfText(agentScaffold(WEAK)));
    const disciplineOnly = agentScaffold({ ...WEAK, toolRouting: false });
    const routingOnly = agentScaffold({ ...WEAK, disciplineCore: false });
    expect(on).toBe(`${disciplineOnly}\n\n${LEAF_HARNESS_CORE}\n\n${routingOnly}`);
  });

  test('strong 档开补焊 = 房规后追加(四条均属「模型再强也不自带」类)', () => {
    const strong = agentScaffold({ ...WEAK, profile: 'strong' });
    expect(agentScaffold({ ...WEAK, profile: 'strong', harnessCore: true })).toBe(
      `${strong}\n\n${LEAF_HARNESS_CORE}`,
    );
  });

  test("off 档 = 裸基线, harnessCore 不得染指 (A/B 对照臂纯净)", () => {
    expect(agentScaffold({ ...WEAK, profile: 'off', harnessCore: true })).toBe('');
  });

  test('★ 互补不重复:补焊块不复述 DISCIPLINE_CORE 已焊词条', () => {
    // DISCIPLINE_CORE 的承重词 (验证>信任 / 无根因不修 / think-in-code / 反 slop) 不许在补焊块再现 ——
    // 弱模型上下文窄, 重复 = 挤占; 出现即蒸馏走样。
    for (const dup of ['GP-1', 'GP-4', 'think-in-code', '反 slop', 'evidence-grounding']) {
      expect(LEAF_HARNESS_CORE).not.toContain(dup);
    }
    // 而它自己的四条必须都在。
    for (const anchor of ['三层真源', '绿 ≠ 对', '脏场景', '? 阀']) {
      expect(LEAF_HARNESS_CORE).toContain(anchor);
    }
  });
});
