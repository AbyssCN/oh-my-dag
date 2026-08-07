/**
 * #13 逐字引文丢失探针 —— 反向自检(每条闸都要证明它真的会红)。
 *
 * 来源:F2 三对复测 11 个失分**无一例外**是「关键词✗ 出处✓」,而关键词是从英文原文逐字核过的锚点。
 * 沿链取证(run 02971fc7):`answer_q5` 产出含 `budget` 原句 ✓ → 紧邻的 `assemble_draft`(8→1 汇总)✗。
 * 本组第一条用的就是那次的真实形状(英文原句 → 中文转述)。
 */
import { describe, expect, test } from 'bun:test';
import { detectVerbatimDrop, extractQuotedSpans } from './observers';

const q = (s: string): string => `"${s}"`;
const UP = [
  `q5: HierFlow allocates budget by search necessity. 原句 ${q('HierFlow allocates budget according to a search-necessity proxy rather than uniformly')}`,
  `q7: SGH 对 plan 有硬约束。原句 ${q('an execution plan is an immutable commitment for the duration of a plan version')}`,
  `q4: HLER 前置检查。原句 ${q('dataset-aware feasibility screening raises the feasible rate from 41% to 87%')}`,
];

describe('detectVerbatimDrop (#13)', () => {
  test('红: 汇总节点把三段原句全转述成中文 → 报', () => {
    const own = 'q5: HierFlow 按搜索必要性分配预算。 q7: SGH 要求计划版本内不可变。 q4: HLER 用数据集审计提升可行率。';
    const o = detectVerbatimDrop('assemble_draft', UP, own);
    expect(o?.kind).toBe('verbatim-drop');
    expect(o?.message).toContain('assemble_draft');
    expect(o?.message).toContain('3 段逐字引文');
  });

  test('绿: 留下哪怕一段原句 → 不报 (判据管"通道断没断", 不管留几段)', () => {
    const own = `q5: 见原句 ${q('HierFlow allocates budget according to a search-necessity proxy rather than uniformly')};其余略。`;
    expect(detectVerbatimDrop('assemble_draft', UP, own)).toBeNull();
  });

  test('绿: 单入节点不是汇总 → 不报 (接力不是 fan-in)', () => {
    expect(detectVerbatimDrop('relay', [UP[0]!], '全部转述')).toBeNull();
  });

  test('绿: 上游引文不足 3 段 → 不报 (一两段可能只是碰巧)', () => {
    expect(detectVerbatimDrop('n', [UP[0]!, '没有引文的上游'], '全部转述')).toBeNull();
  });

  test('绿: 上游根本没引文 → 不报 (不是每张图都在做逐字接地)', () => {
    expect(detectVerbatimDrop('n', ['纯分析文字一', '纯分析文字二', '纯分析文字三'], '汇总')).toBeNull();
  });

  test('extractQuotedSpans: 三种引号都认, 短片段不算引文', () => {
    const long = 'x'.repeat(30);
    expect(extractQuotedSpans(`"${long}"`)).toHaveLength(1);
    expect(extractQuotedSpans(`“${long}”`)).toHaveLength(1);
    expect(extractQuotedSpans(`\`${long}\``)).toHaveLength(1);
    // 短引号是术语标注不是引文 —— 收进来会让判据在任何图上都命中
    expect(extractQuotedSpans('"budget" 与 "immutable"')).toHaveLength(0);
  });
});

// ── 接线: 真跑一张 3→1 的汇总图, 探针必须点火并进 observations ──────────────────
import { runExecutorDagWithPlan } from '../dag/engine';
import type { ConductorPlan } from '../conductor-plan';
import type { ExecutorDagConfig, GenerateFn } from '../dag/types';

const LONG = (s: string): string => `${s} ${'补足长度到阈值以上的原文片段内容'.repeat(2)}`;

/** 三个上游各带一段够长引文; 汇总节点按 paraphrase 开关决定留不留。 */
const makeGen = (paraphrase: boolean): GenerateFn => async (req) => {
  const user = req.messages.find((m) => m.role === 'user');
  const t = typeof user?.content === 'string' ? user.content : '';
  const which = /omd leaf: (\w+)/.exec(t)?.[1] ?? '';
  if (which.startsWith('src')) return { text: `证据: "${LONG(which)}"`, usage: { in: 1, out: 1 } };
  // 汇总节点: 转述 = 一段不留; 保真 = 原样带回上游的引文
  if (paraphrase) return { text: '综合: 三条证据都指向同一结论(已改写)。', usage: { in: 1, out: 1 } };
  const quoted = [...t.matchAll(/"([^"\n]{24,})"/g)].map((m) => `"${m[1]}"`).join(' ');
  return { text: `综合(逐字保留): ${quoted}`, usage: { in: 1, out: 1 } };
};

const sumPlan = (): ConductorPlan =>
  ({
    name: 'sum',
    nodes: {
      src1: { goal: '出证据 1' },
      src2: { goal: '出证据 2' },
      src3: { goal: '出证据 3' },
      merge: { goal: '汇总三条证据', depends_on: ['src1', 'src2', 'src3'] },
    },
  }) as unknown as ConductorPlan;

const cfg = (generate: GenerateFn): ExecutorDagConfig => ({
  conductorModel: 'c:m',
  leafModel: 'l:m',
  generate,
  agentTemplates: new Map(),
});

describe('#13 探针接线 (settle 内点火, 只报不拦)', () => {
  test('汇总节点转述掉全部引文 → observations 里出现 verbatim-drop, 且不拦执行', async () => {
    const r = await runExecutorDagWithPlan(sumPlan(), cfg(makeGen(true)));
    // observations 空时按引擎既有约定省略字段 (同 cancelled) —— 这里缺席与空数组同义, 不是三态。
    const hit = (r.observations ?? []).filter((o) => o.kind === 'verbatim-drop');
    expect(hit).toHaveLength(1);
    expect(hit[0]!.nodes).toEqual(['merge']);
    expect(r.results.merge?.status).toBe('done'); // 只报不拦
  });

  test('汇总节点逐字保留 → 不报 (证明不是恒报的空转断言)', async () => {
    const r = await runExecutorDagWithPlan(sumPlan(), cfg(makeGen(false)));
    expect((r.observations ?? []).filter((o) => o.kind === 'verbatim-drop')).toHaveLength(0);
    expect(r.results.merge?.status).toBe('done');
  });
});
