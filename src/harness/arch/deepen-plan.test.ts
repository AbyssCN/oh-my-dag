/**
 * arch/deepen-plan 测试 —— 图形状 (每热点 1 agent 叶 + synthesis 依赖全部) + PlanSchema 校验
 * + producesFiles 强写信号回归守卫 (只读叶不许被产物闸误杀)。
 */
import { describe, expect, test } from 'bun:test';
import { PlanSchema } from '../conductor-plan';
import { DESIGN_VOCAB } from '../review/design-vocab';
import { buildDeepenPlan, SYNTH_NODE_ID } from './deepen-plan';
import type { Hotspot } from './hotspots';

const HOTSPOTS: Hotspot[] = [
  { dir: 'src/harness/plan', touches: 4, files: [{ path: 'src/harness/plan/planner.ts', touches: 3 }, { path: 'src/harness/plan/types.ts', touches: 1 }] },
  { dir: 'src/harness/review', touches: 3, files: [{ path: 'src/harness/review/run.ts', touches: 3 }] },
  { dir: 'src/model', touches: 2, files: [] }, // scope 空热点也能进图
];

describe('buildDeepenPlan', () => {
  test('图形状: 每热点 1 个 agent 扫描叶 + synthesis 依赖全部', () => {
    const plan = buildDeepenPlan(HOTSPOTS);
    const ids = Object.keys(plan.nodes);
    expect(ids).toEqual(['scan_1', 'scan_2', 'scan_3', SYNTH_NODE_ID]);
    for (const id of ['scan_1', 'scan_2', 'scan_3']) {
      expect(plan.nodes[id]!.executor).toBe('agent');
      expect(plan.nodes[id]!.depends_on).toBeUndefined(); // 兄弟并发, 无假依赖
    }
    const synth = plan.nodes[SYNTH_NODE_ID]!;
    expect(synth.executor).toBe('leaf');
    expect(synth.depends_on).toEqual(['scan_1', 'scan_2', 'scan_3']);
    expect(synth.creative).toBe(true); // 交付物 prose 护质量
  });

  test('产物过 PlanSchema 校验 (safeParse 二次验证)', () => {
    const plan = buildDeepenPlan(HOTSPOTS);
    const res = PlanSchema.safeParse(plan);
    expect(res.success).toBe(true);
  });

  test('扫描叶 goal 注入 DESIGN_VOCAB + 热点文件明细 + 固定候选格式', () => {
    const plan = buildDeepenPlan(HOTSPOTS);
    const goal = plan.nodes['scan_1']!.goal ?? '';
    expect(goal).toContain('<design-vocab');
    expect(goal).toContain('deletion test');
    expect(goal).toContain('src/harness/plan/planner.ts');
    expect(goal).toContain('## C<序号>');
    expect(goal).toContain('只读'); // 只读纪律钉在 goal 里
    // DESIGN_VOCAB 是整块注入 (单一真相源, 不是摘抄)
    expect(goal).toContain(DESIGN_VOCAB);
  });

  test('synthesis goal 含跨热点去重 + 排名 + 截断指令', () => {
    const goal = buildDeepenPlan(HOTSPOTS, { maxCandidates: 5 }).nodes[SYNTH_NODE_ID]!.goal ?? '';
    expect(goal).toContain('跨热点');
    expect(goal).toContain('leverage');
    expect(goal).toContain('C1..C5');
  });

  test('回归守卫: goal 不触发 executor-dag 的 producesFiles 强写信号 (只读叶会被产物闸误杀)', () => {
    // 与 executor-dag.ts 的判别正则同步 (改那边记得核这边)。
    const PRODUCES_FILES_RE = /(?:实现|创建|新建|写入|生成|修改|实装|落地)[^。\n]{0,40}\.(?:ts|tsx|js|jsx|mjs|cjs|sql|json|md|css|html|py|go|rs)\b/;
    const plan = buildDeepenPlan(HOTSPOTS);
    for (const [id, node] of Object.entries(plan.nodes)) {
      expect({ id, hit: PRODUCES_FILES_RE.test(node.goal ?? '') }).toEqual({ id, hit: false });
    }
  });

  test('零热点 → 抛错 (图至少 1 叶)', () => {
    expect(() => buildDeepenPlan([])).toThrow();
  });
});
