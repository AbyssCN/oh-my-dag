/**
 * review/review-plan 测试 —— 图形状(find_<dim> agent → verify map → judge)
 * + PlanSchema 校验 + cross-model per-node + spec 轴双路 + producesFiles 只读守卫。
 */
import { describe, expect, test } from 'bun:test';
import { PlanSchema } from '../conductor-plan';
import { compileReviewPlan, VERIFY_NODE_ID, JUDGE_NODE_ID, FIND_PREFIX } from './review-plan';
import type { ReviewDimension } from './index';

const G2_DIMS: ReviewDimension[] = ['correctness', 'security', 'boundary'];
const BASE = { diff: 'diff --git a/x.ts b/x.ts\n+const y = 1;', scope: 'x.ts', gate: 'G2' as const, dims: G2_DIMS };

describe('compileReviewPlan', () => {
  test('图形状: find_<dim> agent 并行 → verify map → judge leaf', () => {
    const plan = compileReviewPlan(BASE);
    const ids = Object.keys(plan.nodes);
    expect(ids).toEqual(['find_correctness', 'find_security', 'find_boundary', VERIFY_NODE_ID, JUDGE_NODE_ID]);
    for (const d of G2_DIMS) {
      const n = plan.nodes[`${FIND_PREFIX}${d}`]!;
      expect(n.executor).toBe('agent'); // 读代码库 → 带工具
      expect(n.depends_on).toBeUndefined(); // 兄弟并发
    }
    const verify = plan.nodes[VERIFY_NODE_ID]!;
    expect(verify.executor).toBe('map');
    expect(verify.depends_on).toEqual(['find_correctness', 'find_security', 'find_boundary']);
    const judge = plan.nodes[JUDGE_NODE_ID]!;
    expect(judge.executor).toBe('leaf');
    expect(judge.depends_on).toEqual([VERIFY_NODE_ID]);
    expect(judge.creative).toBe(true);
  });

  test('verify map spec: lister(leaf) + skeptic 模板(agent) + keyBy + 有界', () => {
    const map = (compileReviewPlan({ ...BASE, maxFindings: 12 }).nodes[VERIFY_NODE_ID] as unknown as { map: Record<string, unknown> }).map;
    expect((map.lister as { executor: string }).executor).toBe('leaf');
    expect(map.over).toBe('findings');
    expect(map.itemVar).toBe('finding');
    expect(map.keyBy).toBe('id');
    expect(map.maxItems).toBe(12);
    expect((map.template as { executor: string }).executor).toBe('agent');
  });

  test('cross-model per-node: findModel 落 find/lister, verifyModel 落 skeptic 子', () => {
    const plan = compileReviewPlan({ ...BASE, findModel: 'deepseek:v4', verifyModel: 'mimo:ultra' });
    expect(plan.nodes['find_correctness']!.model).toBe('deepseek:v4');
    const map = (plan.nodes[VERIFY_NODE_ID] as unknown as { map: { lister: { model: string }; template: { model: string } } }).map;
    expect(map.lister.model).toBe('deepseek:v4');
    expect(map.template.model).toBe('mimo:ultra'); // 跨模型证伪
  });

  test('spec 轴: 有 SDD → find_spec 节点; 无 SDD → 不发', () => {
    const withSdd = compileReviewPlan({ ...BASE, dims: [...G2_DIMS, 'spec'], sdd: { path: 'docs/plan/x.md', text: 'SDD 内容' } });
    expect(Object.keys(withSdd.nodes)).toContain('find_spec');
    expect((withSdd.nodes['find_spec']!.goal ?? '')).toContain('SDD 内容');
    const noSdd = compileReviewPlan({ ...BASE, dims: [...G2_DIMS, 'spec'], sdd: null });
    expect(Object.keys(noSdd.nodes)).not.toContain('find_spec');
  });

  test('产物过 PlanSchema 校验(map ⇔ executor:map 交叉约束)', () => {
    expect(PlanSchema.safeParse(compileReviewPlan(BASE)).success).toBe(true);
  });

  test('find goal 复用 buildReviewPrompt + 代码库访问纪律', () => {
    const goal = compileReviewPlan(BASE).nodes['find_correctness']!.goal ?? '';
    expect(goal).toContain('改动 diff'); // diff 注入
    expect(goal).toContain('代码库真身'); // 代码库访问纪律
    expect(goal).toContain('先自证伪'); // 三大误报自查
  });

  test('空 diff / 空 dims → 构造期炸', () => {
    expect(() => compileReviewPlan({ ...BASE, diff: '  ' })).toThrow();
    expect(() => compileReviewPlan({ ...BASE, dims: [] })).toThrow();
    // spec-only 且无 SDD → 无可发 find 节点 → 炸
    expect(() => compileReviewPlan({ ...BASE, dims: ['spec'], sdd: null })).toThrow();
  });

  test('回归守卫: find/verify goal 不触发 producesFiles 强写信号(只读叶会被产物闸误杀)', () => {
    const PRODUCES_FILES_RE = /(?:实现|创建|新建|写入|生成|修改|实装|落地)[^。\n]{0,40}\.(?:ts|tsx|js|jsx|mjs|cjs|sql|json|md|css|html|py|go|rs)\b/;
    const plan = compileReviewPlan(BASE);
    const findGoal = plan.nodes['find_correctness']!.goal ?? '';
    const verifyGoal = (plan.nodes[VERIFY_NODE_ID] as unknown as { map: { template: { goal: string } } }).map.template.goal;
    expect(PRODUCES_FILES_RE.test(findGoal)).toBe(false);
    expect(PRODUCES_FILES_RE.test(verifyGoal)).toBe(false);
    expect(findGoal).toContain('只读');
    expect(verifyGoal).toContain('只读');
  });
});
