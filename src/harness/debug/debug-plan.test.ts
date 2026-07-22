/**
 * debug/debug-plan 测试 —— 图形状(scope_lock agent → hypotheses map → judge leaf)
 * + PlanSchema 校验 + map spec 合法 + codegraph 降级双路 + producesFiles 只读守卫。
 */
import { describe, expect, test } from 'bun:test';
import { PlanSchema } from '../conductor-plan';
import { compileDebugPlan, JUDGE_NODE_ID, HYPOTHESES_NODE_ID, SCOPE_NODE_ID } from './debug-plan';

const BASE = { failure: 'GET /orders 返回别人的订单(scope 过滤缺失?)', cgAvailable: true } as const;

describe('compileDebugPlan', () => {
  test('图形状: scope_lock(agent) → hypotheses(map) → judge(leaf)', () => {
    const plan = compileDebugPlan(BASE);
    expect(Object.keys(plan.nodes)).toEqual([SCOPE_NODE_ID, HYPOTHESES_NODE_ID, JUDGE_NODE_ID]);

    const scope = plan.nodes[SCOPE_NODE_ID]!;
    expect(scope.executor).toBe('agent');
    expect(scope.depends_on).toBeUndefined();

    const hyp = plan.nodes[HYPOTHESES_NODE_ID]!;
    expect(hyp.executor).toBe('map');
    expect(hyp.depends_on).toEqual([SCOPE_NODE_ID]);

    const judge = plan.nodes[JUDGE_NODE_ID]!;
    expect(judge.executor).toBe('leaf');
    expect(judge.depends_on).toEqual([HYPOTHESES_NODE_ID]);
    expect(judge.creative).toBe(true); // 提修提议 prose 护质量
  });

  test('map spec: lister(leaf) + verify-leaf(agent) 模板 + keyBy 稳定身份 + 有界扇出', () => {
    const map = (compileDebugPlan({ ...BASE, maxHypotheses: 4 }).nodes[HYPOTHESES_NODE_ID] as { map: Record<string, unknown> }).map;
    expect((map.lister as { executor: string }).executor).toBe('leaf');
    expect(map.over).toBe('hypotheses');
    expect(map.itemVar).toBe('hyp');
    expect(map.keyBy).toBe('id'); // resume 稳定(INV-U2)
    expect(map.maxItems).toBe(4); // 有界扇出(INV-U4)
    expect((map.template as { executor: string }).executor).toBe('agent'); // verify 读真码引 file:line
  });

  test('产物过 PlanSchema 校验(map ⇔ executor:map 交叉约束 + 非嵌套 map)', () => {
    expect(PlanSchema.safeParse(compileDebugPlan(BASE)).success).toBe(true);
  });

  test('codegraph 双路: 可用→符号导航; 不可用→ugrep 降级', () => {
    const up = compileDebugPlan({ ...BASE, cgAvailable: true }).nodes[SCOPE_NODE_ID]!.goal ?? '';
    expect(up).toContain('codegraph');
    expect(up).toContain('codegraph_impact');
    const down = compileDebugPlan({ ...BASE, cgAvailable: false }).nodes[SCOPE_NODE_ID]!.goal ?? '';
    expect(down).toContain('ugrep');
    expect(down).toContain('降级');
  });

  test('lister goal 注入失败症状 + red 证据 + 已证伪反馈(三振循环)', () => {
    const map = (compileDebugPlan({
      ...BASE,
      redEvidence: 'AssertionError: expected 403 got 200',
      priorRefuted: ['R1: 索引缺失假设已排除'],
    }).nodes[HYPOTHESES_NODE_ID] as unknown as { map: { lister: { goal: string } } }).map;
    const g = map.lister.goal;
    expect(g).toContain('GET /orders');
    expect(g).toContain('AssertionError'); // red 证据进 lister
    expect(g).toContain('已被证伪'); // 反馈避重复猜
    expect(g).toContain('R1: 索引缺失假设已排除');
  });

  test('judge goal 钉无根因不修 + 只提议 + NONE 分支驱动三振', () => {
    const g = compileDebugPlan(BASE).nodes[JUDGE_NODE_ID]!.goal ?? '';
    expect(g).toContain('无根因不修');
    expect(g).toContain('只提议');
    expect(g).toContain('ROOT_CAUSE: NONE');
  });

  test('空 failure → 构造期炸', () => {
    expect(() => compileDebugPlan({ failure: '  ', cgAvailable: true })).toThrow();
  });

  test('回归守卫: scope_lock / verify-leaf goal 不触发 producesFiles 强写信号(只读叶会被产物闸误杀)', () => {
    // 与 executor-dag.ts 的判别正则同步(改那边记得核这边)。
    const PRODUCES_FILES_RE = /(?:实现|创建|新建|写入|生成|修改|实装|落地)[^。\n]{0,40}\.(?:ts|tsx|js|jsx|mjs|cjs|sql|json|md|css|html|py|go|rs)\b/;
    const plan = compileDebugPlan(BASE);
    const scopeGoal = plan.nodes[SCOPE_NODE_ID]!.goal ?? '';
    const verifyGoal = (plan.nodes[HYPOTHESES_NODE_ID] as unknown as { map: { template: { goal: string } } }).map.template.goal;
    expect(PRODUCES_FILES_RE.test(scopeGoal)).toBe(false);
    expect(PRODUCES_FILES_RE.test(verifyGoal)).toBe(false);
    // 只读纪律正面钉在 goal 里
    expect(scopeGoal).toContain('只读');
    expect(verifyGoal).toContain('不许改任何文件');
  });
});
