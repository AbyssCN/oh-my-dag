/**
 * src/harness/pathfinder/slice-compiler —— 票 → ConductorPlan 编译器 (组件 5, **零 LLM**)。
 *
 * D-7 adapter B: 散尽区域的 ruled **task** 票 + blockedBy 边 → 直接编译成 ConductorPlan (接缝),
 * 不经廉价模型从散文重推 (消除交接税 D-8)。只**组装不发明** (D-11): 票的 ruling/executorKind
 * 已由裁决定, 编译器只做形状搬运 + Zod 校验。
 *
 * 接缝: import ConductorPlan/PlanSchema from '../conductor-plan' (只读, 不改)。
 *
 * ★ ConductorPlan.executor 枚举 = 'agent'|'leaf'|'command'|'map', 与 Ticket.executorKind
 *   ('command'|'inproc'|'agent'|'map'|'primitive') **不同**。编译期映射 (见 toPlanExecutor):
 *   inproc→leaf (单发模型调用), primitive→leaf (票不带 primitive id/params, 降级为 leaf),
 *   command/agent/map 直通。这是唯一的 shape 适配。
 */
import { PlanSchema, type ConductorPlan } from '../conductor-plan';
import type { ExecutorKind, PathMap, Ticket } from './types';

/**
 * Ticket.executorKind → ConductorPlan.executor 枚举映射 (缺省 inproc → leaf)。
 * command/agent 直通。inproc/primitive/map → leaf:
 *  - inproc = 单发模型调用 = leaf 语义。
 *  - primitive 需 kind/primitive/params, map 需完整 MapSpec (lister/over/template) —— 票在编译期
 *    **不携带**这些 (D-11 只组装不发明), 强行 emit `executor:'map'` 会撞 PlanSchema 的
 *    map⇔executor 互 required 交叉校验。故 P0 降级为 leaf (runtime-finalize P1 可再展开)。
 */
function toPlanExecutor(kind: ExecutorKind | undefined): 'agent' | 'leaf' | 'command' | 'map' {
  switch (kind ?? 'inproc') {
    case 'command':
      return 'command';
    case 'agent':
      return 'agent';
    case 'map':
    case 'inproc':
    case 'primitive':
    default:
      return 'leaf';
  }
}

/** 取 region 内的票, 缺失即抛 (region 引用不存在的票 = 编译不出)。 */
function collectRegion(map: PathMap, regionTicketIds: string[]): Ticket[] {
  const byId = new Map(map.tickets.map((t) => [t.id, t]));
  return regionTicketIds.map((id) => {
    const t = byId.get(id);
    if (!t) throw new Error(`slice-compiler: region 引用不存在的票 "${id}"`);
    return t;
  });
}

/** region 内 (只含 region 成员的边) 环检测 → 有环即抛。 */
function assertAcyclic(region: Ticket[]): void {
  const inRegion = new Set(region.map((t) => t.id));
  const edges = new Map(region.map((t) => [t.id, t.blockedBy.filter((d) => inRegion.has(d))]));
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>(region.map((t) => [t.id, WHITE]));
  const visit = (id: string): void => {
    color.set(id, GRAY);
    for (const dep of edges.get(id) ?? []) {
      const c = color.get(dep);
      if (c === GRAY) throw new Error(`slice-compiler: region 内依赖成环 (cycle at "${dep}")`);
      if (c === WHITE) visit(dep);
    }
    color.set(id, BLACK);
  };
  for (const t of region) if (color.get(t.id) === WHITE) visit(t.id);
}

/**
 * 编译区域 → 已校验的 ConductorPlan (零 LLM)。
 * 每张 ruled task 票 → 一个 PlanNode (键 = 票 id):
 *  - goal = ruling ?? title
 *  - executor = toPlanExecutor(executorKind) (缺省 inproc→leaf)
 *  - depends_on = blockedBy ∩ region (region 外前置裁掉)
 * 抛错: region 空 / 含未裁票 / 含非 task 票 / 引用不存在 / region 内成环。
 * 出参经 PlanSchema 校验 (弱信任: 代码校验形状, 不信裸构造)。
 */
export function compileSlice(map: PathMap, regionTicketIds: string[]): ConductorPlan {
  if (regionTicketIds.length === 0) throw new Error('slice-compiler: region 为空, 编译不出节点 (plan 需 ≥1 node)');
  const region = collectRegion(map, regionTicketIds);
  const inRegion = new Set(region.map((t) => t.id));

  for (const t of region) {
    if (t.status !== 'ruled') throw new Error(`slice-compiler: region 含未裁票 "${t.id}" (status=${t.status}), 雾未散不能编译`);
    if (t.type !== 'task') throw new Error(`slice-compiler: region 含非 task 票 "${t.id}" (type=${t.type})`);
  }
  assertAcyclic(region);

  const nodes: Record<string, Record<string, unknown>> = {};
  for (const t of region) {
    const depends_on = t.blockedBy.filter((d) => inRegion.has(d));
    nodes[t.id] = {
      goal: t.ruling ?? t.title,
      executor: toPlanExecutor(t.executorKind),
      ...(depends_on.length > 0 ? { depends_on } : {}),
    };
  }

  const draft = { name: `pathfinder-slice:${map.slug}`, description: map.destination, nodes };
  const res = PlanSchema.safeParse(draft);
  if (!res.success) {
    throw new Error(`slice-compiler: 编出的 plan 未过 PlanSchema — ${res.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  return res.data;
}

/**
 * region 是否已散尽 (可编译): 当且仅当 region 内每票都是 ruled task 票, 且无 open blocker 指进来
 * (每个 blockedBy 指向的票 — region 内或外 — 都已裁)。不抛, 返回 {clear, reason?}。
 */
export function regionIsClear(map: PathMap, regionTicketIds: string[]): { clear: boolean; reason?: string } {
  const byId = new Map(map.tickets.map((t) => [t.id, t]));
  const ruled = new Set(map.tickets.filter((t) => t.status === 'ruled').map((t) => t.id));
  if (regionTicketIds.length === 0) return { clear: false, reason: 'region 为空' };
  for (const id of regionTicketIds) {
    const t = byId.get(id);
    if (!t) return { clear: false, reason: `未知票 "${id}"` };
    if (t.type !== 'task') return { clear: false, reason: `票 "${id}" 非 task (type=${t.type})` };
    if (t.status !== 'ruled') return { clear: false, reason: `票 "${id}" 未裁 (status=${t.status})` };
    for (const dep of t.blockedBy) {
      if (!ruled.has(dep)) return { clear: false, reason: `票 "${id}" 的前置 "${dep}" 未裁 (open blocker 指进来)` };
    }
  }
  return { clear: true };
}
