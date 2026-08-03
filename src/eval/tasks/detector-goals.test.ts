/**
 * detector-goals 的**结构确定性测试** —— 零模型调用, 只验语料与纯函数。
 *
 * 守的是什么: `classify` 的"shaped"判定是**启发式** (词表命中即算), 它只用来算
 * "形状对了但没标 detector"这个差 —— 差才是 eval 要看的信号, 这个数**不是**
 * "conductor 有没有想到交叉检查"的精确测量。本文件测的是启发式本身的行为
 * (阈值、词表、严格布尔), 不测任何语义真值; 语料侧的语义判断留在
 * `scripts/eval-detector-usage.ts` 的报告里人工读。
 *
 * 为什么回归覆盖值得做: 词表/阈值的每次挪动都会静默改掉 eval 读数 —— 比如把
 * 依赖阈值从 2 降到 1, 单产出 + 检查词的 control 用例立刻被误算成"形状对了",
 * 差就被污染。把这些断言冻成判据, 语料或实现一偏, 这里先红。
 */
import { expect, test } from 'bun:test';
import { CHECK_WORDS, classify, DETECTOR_GOAL_CASES } from './detector-goals';
import type { ConductorPlan } from '../../harness/conductor-plan';

// ── fixtures ────────────────────────────────────────────────────────────────

function plan(nodes: ConductorPlan['nodes']): ConductorPlan {
  return { name: 'fixture', nodes };
}

/** 只填测试要用的字段; detector 缺省不传 (= 缺失, 与 schema 可选一致)。 */
/**
 * detector 收 `unknown` 是为了让"malformed 值不标"的用例能喂 'true'/1/null;
 * 返回类型钉回 schema 节点, 否则推断出的 `detector: {} | null` 配不进 ConductorPlan
 * (TS2322)。定向断言是契约允许的唯一宽松点, 不换 any / 不吞类型。
 */
function node(
  goal: string,
  dependsOn?: string[],
  detector?: unknown,
): ConductorPlan['nodes'][string] {
  return {
    goal,
    ...(dependsOn ? { depends_on: dependsOn } : {}),
    ...(detector !== undefined ? { detector } : {}),
  } as ConductorPlan['nodes'][string];
}

const pos = (checkGoal: string) =>
  plan({ a: node('写 a'), b: node('写 b'), c: node(checkGoal, ['a', 'b']) });

// ── CHECK_WORDS 冻结 ────────────────────────────────────────────────────────

/** 契约词表 (与 detector-goals.ts 的 CHECK_WORDS 逐项对应)。 */
const FROZEN_WORDS = [
  '一致', '口径', '冲突', '交叉', '核对', '对照', '比对', '校验', '检查',
  'consisten', 'cross', 'verif', 'compar', 'reconcil', 'conflict', 'mismatch',
] as const;

test('CHECK_WORDS 冻结: 词表逐项经 classify 命中 shaped, flags = i', () => {
  // 不断言 CHECK_WORDS.source —— Bun 对含非 ASCII 的正则源码序列化不稳定;
  // 词表冻结改走语义: 契约词表每一项都必须让 shaped 命中 (改词表 = 改 eval 读数)。
  expect(CHECK_WORDS).toBeInstanceOf(RegExp);
  expect(CHECK_WORDS.flags).toBe('i');
  for (const w of FROZEN_WORDS) {
    expect(classify(pos(`两份产出要${w}`)).shaped).toBe(true);
  }
});

// ── shaped: 依赖阈值 + 词表 ─────────────────────────────────────────────────

test('shaped: 依赖 ≥2 且有检查词 → true', () => {
  expect(classify(pos('两份口径必须一致')).shaped).toBe(true);
  expect(classify(pos('两段说明要交叉核对')).shaped).toBe(true);
});

test('shaped: 依赖 ≥2 但没有检查词 → false', () => {
  // "介绍/生成"不是检查词; 形状对了但词没命中 = 启发式说不算。
  expect(classify(pos('各自介绍同一个功能的批量导出')).shaped).toBe(false);
  expect(classify(pos('生成两份文件, 一份给用户一份给开发者')).shaped).toBe(false);
});

test('shaped: 有检查词但依赖 <2 → false', () => {
  expect(classify(plan({ a: node('写 a'), c: node('检查两段是否一致', ['a']) })).shaped).toBe(false);
  // 缺 depends_on = 0 依赖
  expect(classify(plan({ a: node('一致性检查') })).shaped).toBe(false);
});

test('shaped: 中文替代词逐个命中', () => {
  for (const w of ['一致', '口径', '冲突', '交叉', '核对', '对照', '比对', '校验', '检查']) {
    expect(classify(pos(`两份要${w}`)).shaped).toBe(true);
  }
});

test('shaped: 英文词干命中且大小写不敏感', () => {
  for (const w of ['Consistency', 'cross-check', 'Verification', 'compare', 'Reconciling', 'CONFLICT', 'Mismatch']) {
    expect(classify(pos(`two docs ${w}`)).shaped).toBe(true);
  }
});

test('shaped: 无关目标 / 缺 goal → false', () => {
  expect(classify(pos('写两个文件, 各写各的')).shaped).toBe(false);
  expect(classify(plan({ a: node('写 a'), b: node('写 b'), c: { depends_on: ['a', 'b'] } })).shaped).toBe(false);
});

// ── marked: 严格布尔 ────────────────────────────────────────────────────────

test('marked: 只有 detector === true 才算', () => {
  expect(classify(plan({ a: node('写 a', [], true) })).marked).toBe(true);
  expect(classify(plan({ a: node('写 a', [], false) })).marked).toBe(false);
  expect(classify(plan({ a: node('写 a') })).marked).toBe(false);
  // 真值但非严格布尔 → 不算 (弱模型常给字符串 'true')
  expect(classify(plan({ a: node('写 a', [], 'true') })).marked).toBe(false);
  expect(classify(plan({ a: node('写 a', [], 1) })).marked).toBe(false);
});

// ── 聚合 ────────────────────────────────────────────────────────────────────

test('marked 与 shaped 跨节点独立聚合 (标了的不必是形状对的)', () => {
  expect(classify(plan({ a: node('写 a', [], true), b: node('写 b'), c: node('两份口径要一致', ['a', 'b']) }))).toEqual(
    { marked: true, shaped: true, nodes: 3 },
  );
  expect(classify(plan({ a: node('写 a', [], true) }))).toEqual({ marked: true, shaped: false, nodes: 1 });
  expect(classify(pos('两份口径要一致'))).toEqual({ marked: false, shaped: true, nodes: 3 });
});

test('nodes = 每个节点都数上', () => {
  expect(classify(plan({})).nodes).toBe(0);
  expect(classify(plan({ a: node('写 a') })).nodes).toBe(1);
  expect(classify(plan({ a: node('写 a'), b: node('写 b'), c: node('写 c') })).nodes).toBe(3);
});

// ── 语料结构 (冻结判据) ─────────────────────────────────────────────────────

/** 规范 ID 表 (契约) —— 顺序即语料顺序, 不许重排 / 增删。 */
const CANONICAL_IDS = [
  'two-audiences',
  'zh-en-promise',
  'three-modules-errors',
  'estimate-assumptions',
  'single-file-grep',
  'typecheck-test',
  'one-design-doc',
] as const;

test('DETECTOR_GOAL_CASES: id 顺序 = 规范表, 无重复', () => {
  expect(DETECTOR_GOAL_CASES.map((c) => c.id)).toEqual([...CANONICAL_IDS]);
});

test('DETECTOR_GOAL_CASES: 字段类型 (id/goal/why 非空字符串, kind 限 worthy/control)', () => {
  for (const c of DETECTOR_GOAL_CASES) {
    expect(c.id.length).toBeGreaterThan(0);
    expect(c.goal.length).toBeGreaterThan(0);
    expect(c.why.length).toBeGreaterThan(0);
    expect(['worthy', 'control']).toContain(c.kind);
  }
});
test('DETECTOR_GOAL_CASES: id 唯一, kind 只含 worthy/control, 两组都非空', () => {
  const ids = DETECTOR_GOAL_CASES.map((c) => c.id);
  expect(new Set(ids).size).toBe(ids.length);
  for (const c of DETECTOR_GOAL_CASES) {
    expect(['worthy', 'control']).toContain(c.kind);
  }
  expect(DETECTOR_GOAL_CASES.filter((c) => c.kind === 'worthy')).not.toHaveLength(0);
  expect(DETECTOR_GOAL_CASES.filter((c) => c.kind === 'control')).not.toHaveLength(0);
});
