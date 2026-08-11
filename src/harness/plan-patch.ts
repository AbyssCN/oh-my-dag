/**
 * src/harness/plan-patch —— D-21 escalation patch 模式 (SDD v2 S3.6, G-21 强化)。
 *
 * 信任反转: S3.5 实证逐字指纹跨 LLM 重规划命中率低 (k3 每轮重措辞, 「逐字保留」指令 4 采样 1 中)
 * → 不再指望 conductor 逐字复述整图, 改让它只输出**节点补丁 JSON**, 引擎程序化 merge 到上轮 plan。
 * 未补丁节点字节不动 → D-21 语义指纹复用**按构造成立**, 零 LLM 信任。
 *
 * 补丁契约 (conductorPatchSystemPrompt 教给重规划 conductor):
 *   { "patch": { "<node_id>": { <改的字段> } | null, ... }, "outputs"?: string[] }
 *   - 节点值 = 对象: 浅 merge (只含改动字段; 字段值 null = 删该字段)
 *   - 节点值 = null: 删该节点 (若仍被他节点 depends_on 引用 → 整补丁拒收)
 *   - 新 id: 加节点 (完整节点字段, 同规划 schema)
 *   - 空 patch {}: 拓扑没问题, 只重跑失败节点 (done 节点全复用)
 *
 * 失败姿态: 解析/校验失败返回 error, 由 executor-dag 回退现行整图重规划 (SDD 钉死 fail-open)。
 */
import { z } from 'zod';
import { PlanSchema, extractPlanJson, type ConductorPlan } from './conductor-plan';

/** 补丁外形 (深校验走 merge 后整图 PlanSchema — 弱模型不可信原则, 代码校验不信格式)。 */
const PlanPatchSchema = z
  .object({
    patch: z.record(z.string(), z.union([z.null(), z.record(z.string(), z.unknown())])),
    outputs: z.array(z.string().min(1)).optional(),
  })
  .passthrough();

export type PlanPatch = z.infer<typeof PlanPatchSchema>;

/** 模型回复 → 补丁对象。extractPlanJson 的多锚点候选制直接复用 (fence/prose 鲁棒)。 */
export function parsePlanPatch(text: string): { ok: true; patch: PlanPatch } | { ok: false; error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(extractPlanJson(text));
  } catch (e) {
    return { ok: false, error: `not JSON: ${(e as Error).message}` };
  }
  const res = PlanPatchSchema.safeParse(raw);
  if (!res.success) {
    return { ok: false, error: res.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
  }
  return { ok: true, patch: res.data };
}

export interface AppliedPatch {
  plan: ConductorPlan;
  /** 改动审计 (日志/测试): 浅 merge 的节点 / 删除的节点 / 新增的节点。 */
  changed: string[];
  removed: string[];
  added: string[];
}

/** 浅 merge 一个节点: 只覆盖补丁给的字段; 字段值 null = 删字段。 */
function mergeNode(
  prev: Record<string, unknown> | undefined,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(prev ?? {}) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete out[k];
    else out[k] = v;
  }
  return out;
}

/**
 * 补丁 → 新 plan (纯函数)。未补丁节点从上轮 plan **原对象浅拷贝** (字段值全同 → 语义指纹
 * 必命中, D-21 复用按构造成立)。merge 后整图过 PlanSchema (加节点外形 / outputs 引用 /
 * map·primitive 交叉规则全兜住) + 悬挂依赖闸 + 模板注册表闸 (TPL-2 平价)。
 */
export function applyPlanPatch(
  prev: ConductorPlan,
  patch: PlanPatch,
  opts: { knownTemplates?: ReadonlySet<string>; allowedIds?: ReadonlySet<string> } = {},
): { ok: true; applied: AppliedPatch } | { ok: false; error: string } {
  const nodes: Record<string, unknown> = { ...prev.nodes };
  const changed: string[] = [];
  const removed: string[] = [];
  const added: string[] = [];
  // D-2 越界机器闸: 补丁 touch 的每个 id 须在 blame 闭包内, 「只修不发明」从 prompt 嘱咐
  // 变会红的闸 (157 次同因事故的根因面) — 不依赖任何措辞, 补丁一律先过这关再 merge。
  if (opts.allowedIds) {
    for (const id of Object.keys(patch.patch)) {
      if (!opts.allowedIds.has(id)) {
        return { ok: false, error: `补丁 touch 闭包外节点: ${id} (闭包外, 只许改 ${[...opts.allowedIds].join(', ')})` };
      }
    }
  }
  for (const [id, val] of Object.entries(patch.patch)) {
    if (val === null) {
      if (!(id in nodes)) return { ok: false, error: `patch 删除不存在的节点: ${id}` };
      delete nodes[id];
      removed.push(id);
    } else if (id in nodes) {
      nodes[id] = mergeNode(nodes[id] as Record<string, unknown>, val);
      changed.push(id);
    } else {
      nodes[id] = mergeNode(undefined, val);
      added.push(id);
    }
  }
  // 悬挂依赖闸: 删掉的节点仍被引用 → 拒收 (引擎把幻象 dep 当已满足, 静默改 quorum 语义 — 不许)。
  for (const [id, n] of Object.entries(nodes)) {
    for (const d of ((n as { depends_on?: string[] }).depends_on ?? [])) {
      if (removed.includes(d)) {
        return { ok: false, error: `节点 ${id} 依赖被删除的节点 ${d} (删节点须同时补丁消费者的 depends_on)` };
      }
    }
  }
  // outputs: 补丁给了则整体替换; 否则继承上轮并剔除被删节点 (剩余引用交 PlanSchema superRefine)。
  const outputs = patch.outputs ?? prev.outputs?.filter((id) => !removed.includes(id));
  const candidate = {
    name: prev.name,
    ...(prev.description ? { description: prev.description } : {}),
    nodes,
    ...(outputs && outputs.length > 0 ? { outputs } : {}),
  };
  const res = PlanSchema.safeParse(candidate);
  if (!res.success) {
    return { ok: false, error: `merge 后整图校验失败: ${res.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}` };
  }
  // TPL-2 平价: 补丁引入的模板名须在注册表 (规划层拒, 驱动重试/回退, 同 parsePlan)。
  if (opts.knownTemplates) {
    for (const id of [...changed, ...added]) {
      const tpl = (nodes[id] as { template?: string } | undefined)?.template;
      if (tpl && !opts.knownTemplates.has(tpl)) {
        return { ok: false, error: `unknown template: ${tpl} (节点 ${id}) — 只能取: ${[...opts.knownTemplates].join(', ')}` };
      }
    }
  }
  // 返回 candidate 而非 res.data: zod 重解析会按 schema 键序重建对象; candidate 里未补丁节点
  // 与上轮是**同一对象引用** → 字节不动按构造成立 (最强复用保证), 校验只当闸不当变换。
  return { ok: true, applied: { plan: candidate as ConductorPlan, changed, removed, added } };
}


/**
 * D-1 请求侧差量: 补丁重规划的 user 消息不再发整张 prior plan JSON (烧钱), 只发
 * blame 闭包节点全文 + 闭包外节点单行清单 (`id: goal首行`)。闭包外节点反正字节冻结
 * (D-2 机器闸拒 touch), 发全文纯属重灌。返回值直接拼进 tryPatchReplan 的 user 消息
 * (取代原 prevPlanJson), 判词由调用方另行 append (与今天姿态一致)。
 */
export function buildPatchRequest(prev: ConductorPlan, closure: ReadonlySet<string>): string {
  const closureNodes: Record<string, unknown> = {};
  const frozenLines: string[] = [];
  for (const [id, node] of Object.entries(prev.nodes)) {
    if (closure.has(id)) {
      closureNodes[id] = node;
    } else {
      const goal = (node as { goal?: unknown }).goal;
      const firstLine = typeof goal === 'string' ? goal.split('\n')[0] : '(no goal)';
      frozenLines.push(`${id}: ${firstLine}`);
    }
  }
  const body = {
    name: prev.name,
    ...(prev.description ? { description: prev.description } : {}),
    nodes: closureNodes,
    ...(prev.outputs?.length ? { outputs: prev.outputs } : {}),
  };
  const frozenBlock = frozenLines.length
    ? `\n\n[闭包外节点, 字节冻结, 补丁不许 touch]\n${frozenLines.join('\n')}`
    : '';
  return `${JSON.stringify(body, null, 1)}${frozenBlock}`;
}
