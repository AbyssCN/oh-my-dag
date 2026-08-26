/**
 * harness-prompts 的**组成钉**(同 agent-leaf-prompt-version.test.ts 的哲学:钉性质,不钉哈希值)。
 * 哈希随正文变,那正是它该变的时候;这里钉的是"变必须是有意识行为"的那些结构性质。
 *
 * ## 分层(2026-08-26 重构)
 *
 * 按**受众**分三层,不按来源分:
 *   - `SHARED_ENGINEERING_CORE` —— conductor 与 leaf 都拼。SSOT:同一条纪律只写一次。
 *   - `CONDUCTOR_*` —— 编排/终裁专属。
 *   - `LEAF_*` —— 执行位专属。
 *
 * 此前是按**来源**分(harness/ 文档蒸馏 vs 执行脚手架),那条边界没兑现:蒸馏层给 leaf 的
 * 那份因开关默认 false 而从不注入,于是设计上两层、生效的只有一层。
 *
 * 反向自检:每条钉都会红 —— 改拼序 → 前缀钉红;共享层在某一侧缺席 → SSOT 钉红;
 * 共享内容在 conductor 专属段里重复 → 不重复钉红;leaf 缺任一实测缺口锚 → 覆盖钉红。
 */
import { describe, expect, test } from 'bun:test';
import {
  SHARED_ENGINEERING_CORE,
  CONDUCTOR_HARNESS_CORE,
  CONDUCTOR_SITUATIONAL,
  LEAF_EXECUTION_CORE,
  LEAF_TOOL_ROUTING,
  buildConductorChatSystemPrompt,
} from './harness-prompts';
import { agentScaffold } from './agent-leaf';

const WEAK = {
  profile: 'weak' as const,
  model: 'deepseek:deepseek-v4-flash',
  toolRouting: true,
  disciplineCore: true,
};

describe('SSOT:共享层同时进两侧,且不在专属段里重复', () => {
  test('★ 共享层进 conductor 的 system prompt', () => {
    expect(buildConductorChatSystemPrompt({ cwd: '/r' })).toContain(SHARED_ENGINEERING_CORE);
  });

  test('★ 共享层进 leaf 的脚手架(weak 与 strong 两档都进)', () => {
    expect(agentScaffold(WEAK)).toContain(SHARED_ENGINEERING_CORE);
    expect(agentScaffold({ ...WEAK, profile: 'strong' })).toContain(SHARED_ENGINEERING_CORE);
  });

  test('★ 共享层的承重段不在 conductor 专属段里重复(重复 = 每轮付两遍 token)', () => {
    for (const anchor of ['<core-discipline>', '<silent-failure-modes>', '<scope-lock>']) {
      expect(CONDUCTOR_HARNESS_CORE).not.toContain(anchor);
      expect(CONDUCTOR_SITUATIONAL).not.toContain(anchor);
    }
  });

  test('★ 共享层的承重段不在 leaf 专属段里重复', () => {
    for (const anchor of ['<core-discipline>', '<silent-failure-modes>', '<scope-lock>']) {
      expect(LEAF_EXECUTION_CORE).not.toContain(anchor);
    }
  });

  test('★ 共享层自己三段齐全(丢一段 = 两侧同时残缺)', () => {
    for (const anchor of ['<core-discipline>', '<silent-failure-modes>', '<scope-lock>']) {
      expect(SHARED_ENGINEERING_CORE).toContain(anchor);
    }
  });
});

describe('conductor 档:冻结前缀在前,动态尾在后(cache 面结构)', () => {
  test('★ 输出以 共享层 + 冻结核 + 情境段 逐字开头 —— 三者构成稳定前缀', () => {
    const p = buildConductorChatSystemPrompt({ cwd: '/r' });
    expect(
      p.startsWith(`${SHARED_ENGINEERING_CORE}\n\n${CONDUCTOR_HARNESS_CORE}\n\n${CONDUCTOR_SITUATIONAL}`),
    ).toBe(true);
  });

  test('★ 同配置重复拼装字节相同;换 cwd 只动尾部', () => {
    const a1 = buildConductorChatSystemPrompt({ cwd: '/a' });
    const a2 = buildConductorChatSystemPrompt({ cwd: '/a' });
    const b = buildConductorChatSystemPrompt({ cwd: '/b' });
    expect(a1).toBe(a2);
    const head = (s: string): string => s.slice(0, s.lastIndexOf('Working root:'));
    expect(head(a1)).toBe(head(b));
  });

  test('无 promptSnippet 的工具不产生空段;无工具时没有 "Available tools" 头', () => {
    const p = buildConductorChatSystemPrompt({ cwd: '/r', tools: [{ name: 'x' }] });
    expect(p).not.toContain('Available tools');
    expect(p).not.toContain('\n\n\n');
  });

  test('冻结核覆盖编排专属段(丢一段 = 蒸馏残缺,当场红)', () => {
    for (const anchor of [
      '<stance>', '<roles>', '<final-ruling>',
      '<gates>', '<dispatch>', '<owner>', '<recommendation-restraint>',
      '<question-triage>', '<deliberation-order>', '<absent-upstream>', '<external-baseline>',
      '<terminology>',
    ]) {
      expect(CONDUCTOR_HARNESS_CORE).toContain(anchor);
    }
  });

  test('★ 术语消歧在冻结核而非 output-style —— 它是领域知识, 不是说话方式', () => {
    expect(CONDUCTOR_HARNESS_CORE).toContain('Disambiguate the overloaded engine names');
    expect(CONDUCTOR_SITUATIONAL).not.toContain('Disambiguate the overloaded engine names');
  });

  test('★ output-style 不再挟带禁用词表(禁用词已由 owner 裁定不再是纪律)', () => {
    for (const w of ['落盘', '抓手', '闭环', '赋能']) {
      expect(CONDUCTOR_SITUATIONAL).not.toContain(w);
    }
  });

  test('情境段覆盖编排专属块(knowledge-boundary 留在这里 —— 它讲怎么切节点, leaf 不分解)', () => {
    for (const anchor of [
      '<cross-validation>', '<recall-discipline>', '<iteration-bound>', '<vertical-slicing>',
      '<knowledge-boundary>', '<experiment-discipline>', '<ruler-honesty>',
      '<before-asserting>', '<solve-ignition>', '<output-style>',
    ]) {
      expect(CONDUCTOR_SITUATIONAL).toContain(anchor);
    }
  });
});

describe('leaf 档:三档脚手架 + 实测缺口覆盖', () => {
  test('★ weak 档 = 共享层 + 执行核 + 工具路由(拼序: 共享 → 执行 → 工具)', () => {
    expect(agentScaffold(WEAK)).toBe(
      `${SHARED_ENGINEERING_CORE}\n\n${LEAF_EXECUTION_CORE}\n\n${LEAF_TOOL_ROUTING}`,
    );
  });

  test('★ strong 档也拼共享层(承重纪律与模型强弱无关), 但不拼工具路由细则', () => {
    const strong = agentScaffold({ ...WEAK, profile: 'strong' });
    expect(strong).toContain(SHARED_ENGINEERING_CORE);
    expect(strong).not.toContain(LEAF_TOOL_ROUTING);
  });

  test("★ off 档 = 裸基线, 一个字节都不注入 (A/B 对照臂纯净)", () => {
    expect(agentScaffold({ ...WEAK, profile: 'off' })).toBe('');
  });

  test('★ 执行核覆盖六条实测缺口(每条对应一次真实失败, 丢一条就会重演)', () => {
    for (const anchor of [
      'repo-checks',
      'write-set',
      'Runtime evidence',
      'value import',
      'spin',
      'frozen criteria',
    ]) {
      expect(LEAF_EXECUTION_CORE).toContain(anchor);
    }
  });

  test('★ 执行核带 P-1 与 P-2 —— leaf 的报告是引擎判定的输入, 不是包装纸', () => {
    expect(LEAF_EXECUTION_CORE).toContain('Look, do not infer');
    expect(LEAF_EXECUTION_CORE).toContain('Cost is the test');
    expect(LEAF_EXECUTION_CORE).toContain('Reporting');
    expect(LEAF_EXECUTION_CORE).toContain('did I oversell');
  });

  test('★ 执行核不复述共享层已焊的词条(弱模型上下文窄, 重复 = 挤占)', () => {
    for (const dup of ['No commit without verification', 'Dig to root cause', 'NULL is not 0']) {
      expect(LEAF_EXECUTION_CORE).not.toContain(dup);
    }
  });
});
