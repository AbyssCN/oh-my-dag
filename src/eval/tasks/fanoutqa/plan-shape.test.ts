/**
 * `plan-shape` 分类器的**反向自检闸**(仓规:每条闸都要证明它真的会红)。
 *
 * 一个恒返回同一格的分类器,跑出来的分布图会非常好看,而且**看不出它坏了** ——
 * 那正是交接 21 §八.6 那条(采集器自己撒谎)的形状。所以这里每一格都摆一个已知样本,
 * 并额外断言"五格不是同一格"。
 *
 * ⚠ 这条闸**不**判"引擎该画哪一格"(那是读数,不是判据),只判"给定这张图,分类器认得对"。
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ConductorPlan } from '../../../harness/conductor-plan';
import { classifyPlanShape, tally, bucketOf, FANOUT_MIN_WIDTH, type PlanShapeClass } from './plan-shape';
import { dagShape, fanoutDemand, scoringPoints, type FanOutQuestion } from './gold-dag';
import { fanoutTaskText } from './task-text';

type Nodes = ConductorPlan['nodes'];
const plan = (nodes: Nodes): ConductorPlan => ({ name: 'probe', nodes });

/** [列清单] → [map 扇 N 份] —— 规划期不知道清单时唯一诚实的画法。 */
const RUNTIME: ConductorPlan = plan({
  list: { goal: '列出前五顺位' },
  each: {
    goal: '逐个查击球手别',
    depends_on: ['list'],
    executor: 'map',
    map: { lister: { goal: '列出前五顺位' }, over: 'picks', itemVar: 'pick', template: { goal: '查 ${pick}' } },
  },
  write: { goal: '汇总成清单', depends_on: ['each'] },
});

/** [列清单] → [槽位1..3] → [汇总]:节点数写死在规划期, 但至少挂在 lister 之后。 */
const BOUND: ConductorPlan = plan({
  list: { goal: '列出前五顺位' },
  s1: { goal: '查第 1 位', depends_on: ['list'] },
  s2: { goal: '查第 2 位', depends_on: ['list'] },
  s3: { goal: '查第 3 位', depends_on: ['list'] },
  write: { goal: '汇总', depends_on: ['s1', 's2', 's3'] },
});

/** level 0 就是三个具名实体 —— 清单是规划期编出来的, 没有任何节点去查它。 */
const UNBOUND_GUESSED: ConductorPlan = plan({
  a: { goal: '查 Pat Burrell 的击球手别' },
  b: { goal: '查 Mark Mulder 的击球手别' },
  c: { goal: '查 Corey Patterson 的击球手别' },
  write: { goal: '汇总', depends_on: ['a', 'b', 'c'] },
});

/**
 * level 0 三路**不同角度**的独立调研 —— 一个实体名都没编, 是正当形状。
 * 取自真样本(run 2026-08-05, `smallest country … UEFA` 那题)。
 */
const UNBOUND_ANGLES: ConductorPlan = plan({
  championship_inventory: { goal: '取 UEFA 欧洲杯条目, 列出多次夺冠的国家', executor: 'agent' },
  population_inventory: { goal: '取各国人口数字', executor: 'agent' },
  independent_audit: { goal: '独立从头解一遍全题', executor: 'agent' },
  synthesize_answer: {
    goal: '三份证据对账后产出答案',
    depends_on: ['championship_inventory', 'population_inventory', 'independent_audit'],
  },
});

/** 串成一条线。 */
const CHAIN: ConductorPlan = plan({
  a: { goal: '列清单' },
  b: { goal: '逐个查', depends_on: ['a'] },
  c: { goal: '汇总', depends_on: ['b'] },
});

/** 两个节点 = 基本没分解。 */
const COLLAPSED: ConductorPlan = plan({
  a: { goal: '查清所有实体的值' },
  b: { goal: '写出来', depends_on: ['a'] },
});

const CASES: ReadonlyArray<[PlanShapeClass, ConductorPlan]> = [
  ['runtime-fanout', RUNTIME],
  ['static-parallel-bound', BOUND],
  ['static-parallel-unbound', UNBOUND_GUESSED],
  ['chain', CHAIN],
  ['collapsed', COLLAPSED],
];

describe('plan-shape 分类器', () => {
  for (const [expected, p] of CASES) {
    test(`认得出 ${expected}`, () => {
      expect(classifyPlanShape(p).cls).toBe(expected);
    });
  }

  test('反向自检: 五格互不相同 (分类器不是常函数)', () => {
    const seen = new Set(CASES.map(([, p]) => classifyPlanShape(p).cls));
    expect(seen.size).toBe(CASES.length);
  });

  test('运行时扇出优先于节点数 —— 2 节点的 [lister→map] 不许被判成 collapsed', () => {
    const tiny = plan({
      list: { goal: '列清单' },
      each: {
        goal: '逐个查',
        depends_on: ['list'],
        executor: 'map',
        map: { lister: { goal: '列清单' }, over: 'xs', itemVar: 'x', template: { goal: '查 ${x}' } },
      },
    });
    expect(classifyPlanShape(tiny).shape.nodes).toBe(2); // 按节点数它确实"小"
    expect(classifyPlanShape(tiny).cls).toBe('runtime-fanout'); // 但语义上它是最对的那张
  });

  test('executor:conductor 同样算运行时扇出 (两个件都是为这个形状造的)', () => {
    const p = plan({
      list: { goal: '列清单' },
      sub: { goal: '现场重画子图', depends_on: ['list'], executor: 'conductor', max_nodes: 8 },
    });
    expect(classifyPlanShape(p).cls).toBe('runtime-fanout');
  });

  test('宽度阈值就是 FANOUT_MIN_WIDTH: 宽 2 不算扇出, 宽 3 算', () => {
    const wide = (n: number): ConductorPlan =>
      plan(Object.fromEntries([
        ['list', { goal: '列清单' }],
        ...Array.from({ length: n }, (_, i) => [`s${i}`, { goal: `查第 ${i}`, depends_on: ['list'] }] as const),
      ]) as Nodes);
    expect(classifyPlanShape(wide(FANOUT_MIN_WIDTH - 1)).cls).toBe('chain');
    expect(classifyPlanShape(wide(FANOUT_MIN_WIDTH)).cls).toBe('static-parallel-bound');
  });

  test('tally 数得对, 且没被判到的格是 0 不是 undefined (NULL≠0, 仓规第一条)', () => {
    const t = tally(CASES.map(([, p]) => classifyPlanShape(p)));
    expect(t['runtime-fanout']).toBe(1);
    expect(t.chain).toBe(1);
    const only = tally([classifyPlanShape(CHAIN)]);
    expect(only['runtime-fanout']).toBe(0); // 存在且为 0
    expect(Object.keys(only).length).toBe(5);
  });

  /**
   * **把已知的盲点写成断言**,而不是写成一句会被读漏的散文。
   * 这条测试通过 = 分类器**确实分不开**这两种;哪天有人做出能分开的判据,它会红,
   * 那正是该回来改文档与报告口径的时刻。
   */
  test('⚠ 已知盲点: "编实体名" 与 "多视角并行" 结构上同一格', () => {
    expect(classifyPlanShape(UNBOUND_GUESSED).cls).toBe('static-parallel-unbound');
    expect(classifyPlanShape(UNBOUND_ANGLES).cls).toBe('static-parallel-unbound');
  });

  test('需求分档: 边界不漏也不重', () => {
    expect(bucketOf(2)).not.toBe(bucketOf(3));
    expect(bucketOf(4)).not.toBe(bucketOf(5));
    expect(bucketOf(7)).not.toBe(bucketOf(8));
    expect(bucketOf(45)).toBe(bucketOf(8));
  });
});

/**
 * `fanoutDemand` 的两条反例闸 —— 它存在的**全部理由**就是这两条,
 * 少了任何一条就该退回单用金标宽度(或单用答案键数),那正是 2026-08-05 差点走上的路。
 */
describe('fanoutDemand: 金标宽度与答案键数各自会漏的那一半', () => {
  test('人把分解写粗了(宽 1, 答案 5 键)→ 需求仍是 5', () => {
    const q = {
      decomposition: [
        { id: 'a', question: '最大的洲是哪个' },
        { id: 'b', question: '亚洲面积最小的 5 国人口各是多少', depends_on: ['a'] },
      ],
      answer: { A: 1, B: 2, C: 3, D: 4, E: 5 },
    };
    expect(dagShape(q.decomposition).width).toBe(1); // 金标宽度看不见那 5 次查证
    expect(scoringPoints(q.answer)).toBe(5);
    expect(fanoutDemand(q)).toBe(5);
  });

  test('标量答案藏起宽扇出(宽 5, 答案 1 个数)→ 需求仍是 5', () => {
    const q = {
      decomposition: [
        { id: 'l', question: '最近五任市长是谁' },
        ...['m1', 'm2', 'm3', 'm4', 'm5'].map((id) => ({ id, question: `${id} 生于何处`, depends_on: ['l'] })),
      ],
      answer: 2,
    };
    expect(scoringPoints(q.answer)).toBe(1); // 答案键数看不见那 5 次查证
    expect(dagShape(q.decomposition).width).toBe(5);
    expect(fanoutDemand(q)).toBe(5);
  });

  test('⚠ 真数据自证: dev 里 fanoutDemand ≤2 的题极少 —— FanOutQA 没有窄端', () => {
    const dev = JSON.parse(
      readFileSync(join(import.meta.dir, 'data', 'fanout-final-dev.json'), 'utf8'),
    ) as FanOutQuestion[];
    const narrow = dev.filter((q) => fanoutDemand(q) <= 2).length;
    expect(dev.length).toBe(310);
    // 钉住这个数: 它是"窄档必须从 2Wiki 来"那条决策的唯一依据, 数据换了要重新裁。
    expect(narrow).toBe(3);
    // 反向自检: 主峰确实在宽端 (免得上面那条靠"分类器恒 0"过关)
    expect(dev.filter((q) => fanoutDemand(q) >= 5).length).toBeGreaterThan(200);
  });
});

describe('FanOutQA 任务文本 (冻结面)', () => {
  test('带上语料 epoch 与逐实体格式要求', () => {
    const t = fanoutTaskText('Who are the G7 leaders?');
    expect(t).toContain('Who are the G7 leaders?');
    expect(t).toContain('2023-11-20');
    expect(t).toMatch(/实体: 值/);
  });

  test('⚠ 不许提示分解/并行 —— 提示了就量成"听不听话", 不再是"认不认得出"', () => {
    const t = fanoutTaskText('Q');
    for (const banned of ['分解', '并行', '子问题', 'map', '扇出', 'DAG']) {
      expect(t).not.toContain(banned);
    }
  });
});
