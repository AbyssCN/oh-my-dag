/**
 * src/harness/dag/shape-id-wiring.test —— **SH-1**:conductor 声明的图式卡 id 一路到账本。
 *
 * ## 这一片在钉什么
 *
 * owner 2026-08-30 的原话:没有这一列,「每次 conductor 用的是哪张图式」无法判断,
 * **无法回溯之后哪些是好的,也没法做 conductor 优化**。
 *
 * 仓里原本只有一个**结构指纹** `shapeOf()`(`plan-passes/evidence-pass.ts`,形如
 * `n3/e3/agent=2,leaf=1`),它答的是「图长什么样」而不是「跟的哪张卡」——
 * 同一张卡能画出不同结构,不同卡也能撞出同一个指纹。**两者不能互相替代**,
 * 所以这一格只能由 conductor 自己声明,派生不出来。
 *
 * | | 钉什么 | 实装前为什么红 |
 * |---|---|---|
 * | SH-1a | plan 上的 `shape` 经 zod 存活(不被 strip) | `PlanSchema` 没这个字段 |
 * | SH-1b | 写进 `omd_dag_runs.shape_id`,读得回来 | 列不存在 |
 * | SH-1c | 没声明 → 该列 NULL / 读侧缺席(**不编空串**) | — (零回归护栏) |
 * | SH-1d | **未知 id 照样落盘**,不判 INVALID;已知/未知由 `isKnownShapeId` 在读侧分 | — (防「用了就炸」) |
 * | SH-1e | prompt 两档都列了 `"shape"?: string`,且给了填写指令 | 词表与散文缺任一 → 产出率 0(W1 教训) |
 *
 * ## 反向自检(逐条当场实跑过)
 *
 *  - 删 `PlanSchema` 的 `shape` 字段 → SH-1a 红(zod strip 掉)。
 *  - 删 dag-record 的 `shape_id` ALTER 那行 → SH-1b 红。
 *  - 把绑值改成 `result.plan.shape ?? ''` → SH-1c 红(空串把「没跟卡」伪装成「跟了一张没名字的卡」)。
 *  - 把 `shape` 的 zod 改成 `z.enum([...8 个 id])` → SH-1d 红(未知 id 让整张 plan 判 INVALID)。
 *  - 删 `renderShapesForPrompt` 末尾那三行指令 → SH-1e 红。
 */
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { PlanSchema, conductorSystemPrompt } from '../conductor-plan';
import { createDagRecorder } from './dag-record';
import { isKnownShapeId, renderShapesForPrompt, GRAPH_SHAPES } from '../shapes';
import type { ConductorPlan } from '../conductor-plan';
import type { ExecutorDagResult } from './types';

const planWith = (shape?: string): ConductorPlan =>
  ({
    name: 'p',
    ...(shape ? { shape } : {}),
    nodes: { a: { goal: 'g', executor: 'leaf' } },
  }) as ConductorPlan;

/** 造一份最小 ExecutorDagResult 喂 recorder。 */
const resultOf = (plan: ConductorPlan): ExecutorDagResult =>
  ({
    plan,
    sessionId: 's',
    levels: [['a']],
    results: { a: { id: 'a', status: 'done', kind: 'inproc', model: 'm', output: 'o', deps: [], usage: { in: 1, out: 1 }, filesTouched: [] } },
    usage: { conductor: { in: 0, out: 0 }, leavesIn: 1, leavesOut: 1, leavesCacheHit: 0 },
  }) as unknown as ExecutorDagResult;

/** 记一条, 读回该行的 shapeId(缺席则 undefined)。 */
function roundTrip(plan: ConductorPlan): { shapeId?: string; rawColumn: unknown } {
  const db = new Database(':memory:');
  const rec = createDagRecorder({ db });
  rec.record(resultOf(plan), { runId: 'r', entry: 'run' });
  const rows = rec.list(5) as unknown as { shapeId?: string }[];
  const raw = (db.query('SELECT shape_id FROM omd_dag_runs LIMIT 1').get() as { shape_id: unknown } | null)?.shape_id;
  rec.close();
  return { ...(rows[0]?.shapeId !== undefined ? { shapeId: rows[0].shapeId } : {}), rawColumn: raw };
}

describe('SH-1 图式卡 id 接线', () => {
  test('★ SH-1a: plan 上的 shape 经 zod 存活 (没这个字段的话会被 strip 掉)', () => {
    const parsed = PlanSchema.parse(planWith('one-decision-then-fanout'));
    expect((parsed as { shape?: string }).shape).toBe('one-decision-then-fanout');
  });

  test('★ SH-1b: 声明了 → 写进 shape_id 列, 读得回来', () => {
    const { shapeId, rawColumn } = roundTrip(planWith('research-lens'));
    expect(rawColumn).toBe('research-lens');
    expect(shapeId).toBe('research-lens');
  });

  test('★ SH-1c: 没声明 → 列为 NULL 且读侧缺席 (**不编空串**)', () => {
    const { shapeId, rawColumn } = roundTrip(planWith(undefined));
    expect(rawColumn).toBeNull(); // NULL ≠ '' —— 空串会把「没跟卡」伪装成「跟了张没名字的卡」
    expect(shapeId).toBeUndefined();
  });

  test('★ SH-1d: 未知 id 照样落盘, 不判 INVALID; 已知/未知由读侧分', () => {
    // 写侧: 拼错的 id 不该让整张 plan 炸 (同 executor:'await' 那条教训)
    expect(() => PlanSchema.parse(planWith('one-decison-then-fanout'))).not.toThrow(); // 故意拼错
    const { shapeId } = roundTrip(planWith('totally-made-up'));
    expect(shapeId).toBe('totally-made-up'); // 原始观测原样落盘
    // 读侧: 三态分得开
    expect(isKnownShapeId('research-lens')).toBe(true);
    expect(isKnownShapeId('totally-made-up')).toBe(false);
    expect(isKnownShapeId(undefined)).toBe(false);
  });

  test('★ SH-1e: prompt 里词表与指令**两半都在** (缺任一半那一格的产出率就是 0 —— W1 教训)', () => {
    // 词表那一半: 两档输出 schema 都列了 shape
    for (const lean of [false, true]) {
      const p = conductorSystemPrompt({ lean } as never);
      expect(p, `lean=${lean} 的输出 schema 里没有 "shape"`).toContain('"shape"?: string');
    }
    // 指令那一半: 告诉它怎么填、以及没跟卡时要省略
    const shapeLines = renderShapesForPrompt('full').join('\n');
    expect(shapeLines).toContain('"shape" field');
    expect(shapeLines).toContain('OMIT the field');
    // 卡表非空, 且指令里举的例子是真卡 (举一个不存在的卡等于教它编 id)
    expect(GRAPH_SHAPES.length).toBeGreaterThan(0);
    expect(isKnownShapeId('one-decision-then-fanout')).toBe(true);
  });
});
