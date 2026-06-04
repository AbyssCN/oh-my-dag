/**
 * src/memory/safeguards/universal-namespaces —— wright **通用默认记忆 pack** (P1#1, 面向所有人)。
 *
 * 跟 a sibling project domain pack (会计) 平行, 但这套**任何 wright instance 都自带** (开源打开即有):
 *   - `user.*` (6 facet): 记住**用户**的方方面面 (喜欢/在意/关注/会什么/是谁/要什么)。克制的 facet
 *     类型 + category/value 半结构字段 → 覆盖广而不堆 namespace ("太多数据"是失败模式, the owner 锁)。
 *   - `wright.*` (3 facet): wright 记住**自己** (擅长什么/什么打法管用/受什么限) —— 自我进化的底座。
 *     刻意**不**镜像 live 工具/skill 注册表 (那能自省, memorize 冗余); 只记靠经验才知道的自评胜任度。
 *
 * 每条 fact 仍走 kernel 机制 (source anchor + 3 级 confidence + supersede + dream curate)。
 * 无 banGlobs (ban 是辖区/domain 的事, 见 a sibling project pack)。
 */
import { z } from 'zod';
import {
  sourceAnchor,
  confidenceField,
  assembleSafeguard,
  type NamespacePack,
  type AssembledSafeguard,
} from './namespace-kernel';

// ---------------------------------------------------------------------------
// user.* —— 记住用户 (6 facet)。第一级 facet 类型克制, 第二级 category/value 内容开放。
// ---------------------------------------------------------------------------

const USER_BRANCHES = [
  // 他喜欢东西怎么做 (沟通/格式/语气/工具/作息 …)。
  z.object({
    namespace: z.literal('user.preference'),
    category: z.string().min(1),
    value: z.string().min(1),
    ...sourceAnchor,
    ...confidenceField,
  }),
  // 他在意/关注的领域话题。
  z.object({
    namespace: z.literal('user.interest'),
    topic: z.string().min(1),
    note: z.string().min(1).optional(),
    ...sourceAnchor,
    ...confidenceField,
  }),
  // 他当前的关注点 (转瞬, 新写覆盖同 focus)。
  z.object({
    namespace: z.literal('user.focus'),
    focus: z.string().min(1),
    started_at: z.coerce.date(),
    ...sourceAnchor,
    ...confidenceField,
  }),
  // 他的技能/专长。
  z.object({
    namespace: z.literal('user.expertise'),
    domain: z.string().min(1),
    level: z.enum(['expert', 'proficient', 'familiar']),
    ...sourceAnchor,
    ...confidenceField,
  }),
  // 他是谁: 价值观/工作风格/身份/性格。
  z.object({
    namespace: z.literal('user.trait'),
    category: z.string().min(1),
    statement: z.string().min(1),
    ...sourceAnchor,
    ...confidenceField,
  }),
  // 他要达成什么。
  z.object({
    namespace: z.literal('user.goal'),
    goal: z.string().min(1),
    status: z.enum(['active', 'paused', 'done']),
    horizon: z.enum(['now', 'quarter', 'year']),
    ...sourceAnchor,
    ...confidenceField,
  }),
];

// ---------------------------------------------------------------------------
// wright.* —— wright 记住自己 (3 facet)。自评 learned 自我认知, 非工具清单镜像。
// ---------------------------------------------------------------------------

const WRIGHT_BRANCHES = [
  // 我擅长什么 (领域 + 自评熟练度 spectrum: expert→weak)。
  z.object({
    namespace: z.literal('wright.capability'),
    area: z.string().min(1),
    level: z.enum(['expert', 'proficient', 'weak']),
    note: z.string().min(1).optional(),
    ...sourceAnchor,
    ...confidenceField,
  }),
  // 什么打法在什么情况管用/失败 (程序性学习, 自我进化核心燃料)。
  z.object({
    namespace: z.literal('wright.pattern'),
    situation: z.string().min(1),
    approach: z.string().min(1),
    outcome: z.enum(['worked', 'failed']),
    ...sourceAnchor,
    ...confidenceField,
  }),
  // 我的硬约束/边界/盲区 (预算/不可做/已知弱点)。
  z.object({
    namespace: z.literal('wright.limit'),
    kind: z.enum(['budget', 'boundary', 'blindspot']),
    statement: z.string().min(1),
    ...sourceAnchor,
    ...confidenceField,
  }),
];

// ---------------------------------------------------------------------------
// identity fields (supersession) + pack 装配。
// ---------------------------------------------------------------------------

export const USER_NAMESPACE_IDENTITY_FIELDS: Record<string, readonly string[]> = {
  'user.preference': ['category'],
  'user.interest': ['topic'],
  'user.focus': ['focus'],
  'user.expertise': ['domain'],
  'user.trait': ['category'],
  'user.goal': ['goal'],
};

export const WRIGHT_NAMESPACE_IDENTITY_FIELDS: Record<string, readonly string[]> = {
  'wright.capability': ['area'],
  'wright.pattern': ['situation', 'approach'],
  'wright.limit': ['kind', 'statement'],
};

const namespaceLiterals = (branches: readonly z.ZodObject<z.ZodRawShape>[]): string[] =>
  branches.map((b) => (b.shape.namespace as z.ZodLiteral<string>).value);

/** 通用 user.* pack (记住用户)。无 banGlobs。 */
export const USER_NAMESPACE_PACK: NamespacePack = {
  branches: USER_BRANCHES,
  allowedNamespaces: namespaceLiterals(USER_BRANCHES),
  identityFields: USER_NAMESPACE_IDENTITY_FIELDS,
  banGlobs: [],
};

/** 通用 wright.* pack (wright 记住自己)。无 banGlobs。 */
export const WRIGHT_NAMESPACE_PACK: NamespacePack = {
  branches: WRIGHT_BRANCHES,
  allowedNamespaces: namespaceLiterals(WRIGHT_BRANCHES),
  identityFields: WRIGHT_NAMESPACE_IDENTITY_FIELDS,
  banGlobs: [],
};

// 精确 per-namespace 类型不导出 (消费者只用共享字段; 单一 loose ValidatedFact 在 facade 定义)。

/**
 * 纯通用装配 (user.* + wright.*, **零 domain**)。任何 wright instance 都自带; domain-free 的前端
 * (TUI wright 自我记忆) 注入它 → 只收用户/自身 fact, 拒一切 domain (会计 client.* 等) namespace。
 * 无 banGlobs (GDPR 等 ban 属辖区/domain pack, 见 a sibling project)。
 */
export const UNIVERSAL_SAFEGUARD: AssembledSafeguard = assembleSafeguard([
  USER_NAMESPACE_PACK,
  WRIGHT_NAMESPACE_PACK,
]);
