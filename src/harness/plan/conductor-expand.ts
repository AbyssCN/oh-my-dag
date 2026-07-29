/**
 * plan/conductor-expand —— **D-B 内容寻址子节点 id** 的纯展开逻辑 (P3 批次 3, 2026-07-29)。
 *
 * `executor:'conductor'` 节点在运行时让 conductor 现场画一张子图。子图的节点名是**模型起的**,
 * 而模型每次重画都可能换名 —— 这件事直接撞上 resume 的正确性:
 *
 *   `computeDagGeneration` 只哈希 **plan-time** 的 nodeIds+deps (子节点是运行期才有的, 不在里面),
 *   而 per-node checkpoint 是**按 id 存**的。于是「上次叫 impl-api、这次叫 write-endpoint」时,
 *   resume 会拿不到本该命中的绿; 更坏的是反过来 ——「上次的 impl-api 干的是 A、这次的 impl-api
 *   干的是 B」时, resume 会把 A 的产物当成 B 的绿, **张冠李戴**。
 *
 * 解法承 map 的 INV-U2 (`map-expand.ts`): **id 由内容决定, 不由名字决定**。
 * 区别只在"内容"是什么 —— map 的子节点同构 (模板 + 元素), key 取元素; conductor 的子节点异构
 * (各有各的 goal/executor/deps), key 取**这个节点自己的语义指纹**:
 *
 *   childId = `${parentId}::${merkleFp(child)}`
 *
 * 直接复用 `semantic-key.merkleFingerprints` —— 它本来就是为"对节点 id 重命名不敏感"设计的
 * (D-21 跨轮复用的匹配键), 指纹 = hash(自身语义字段 + 前驱指纹递归)。于是:
 *   - conductor 改名不改内容 → 指纹不变 → id 不变 → resume 命中 ✅
 *   - conductor 改内容 → 指纹变 → id 变 → **拿不到旧 checkpoint, 自然重跑** ✅
 *
 * ⚠ **id 只哈希"规格", 绝不哈希"上游输出"** —— 这是个很容易做错的岔口。把输入内容也哈希进 id,
 * 上游一变 id 就变 → checkpoint 永远找不到 → resume 退化成"每次全跑"。"我吃的东西变了"是
 * **另一个**问题, 由 D-O 的 `inputHashes` 在 checkpoint 那一层回答 (id 管身份, inputHashes 管新鲜度)。
 *
 * ⚠ 内容寻址顺带取消了 map 那种 `expansionHash` 粗粒度作废: 子节点内容一变 id 就变, 旧 checkpoint
 * 只是变成永不被引用的孤儿, 不需要显式清子树。孤儿不影响正确性 (`loadAllGreen` 按 id 查)。
 *
 * 本模块**只做纯逻辑**: 零 IO、零模型、零 Date/random → 完整可单测 (同 map-expand 的纪律)。
 */
import { merkleFingerprints } from '../plan-passes/semantic-key';
import type { ConductorPlan } from '../conductor-plan';

type PlanNode = ConductorPlan['nodes'][string];

/** 一个展开出的子节点。 */
export interface ConductorChild {
  /** 内容寻址的稳定 id: `${parentId}::${fp}` (D-B)。 */
  id: string;
  /** conductor 自己起的名 —— 只作审计/日志, **不参与任何判定**。 */
  originalId: string;
  /** 语义指纹 (id 的后半)。 */
  fingerprint: string;
  /** 子节点本体; `depends_on` 已重写成内容寻址 id (子图内) 或保留 (指向父节点的外层上游)。 */
  node: PlanNode;
}

export type ConductorExpandStatus = 'ok' | 'empty' | 'nested' | 'cycle';

export interface ConductorExpandResult {
  status: ConductorExpandStatus;
  children: ConductorChild[];
  /** 被 maxNodes 截断丢弃的节点数 (调用方须 log —— no-silent-caps)。 */
  truncated: number;
  /** nested/cycle 时的原因。 */
  error?: string;
}

/**
 * 子图节点数硬顶。**与 map 的 `DEFAULT_MAX_ITEMS` 同一个数, 不是独立调过的** ——
 * 没有证据支持给它一个不同的值, 就别假装有。
 */
export const DEFAULT_MAX_CHILDREN = 64;

/**
 * **D-D 禁嵌套** (照 INV-U5, D-10「无用例支撑先禁」纪律)。
 *
 * 禁 `conductor`: 无限递归展开面, 没有用例支撑限深。
 * 禁 `map`: 理由不只是"怕量级膨胀" (那是 maxNodes × maxItems 的复合上界) —— 更根本的是**它多余**:
 *   map 存在的意义是"工作清单在 plan-time 未知, 运行时才知道", 而 conductor 节点**本身就是运行时
 *   展开** —— 它展开的那一刻已经知道清单了, 直接吐 N 个节点即可, 不需要再套一层运行时扇出。
 */
const FORBIDDEN_CHILD_EXECUTORS = new Set(['conductor', 'map']);

/**
 * 纯展开: conductor 现场画的子图 → 内容寻址子节点集。
 *
 * @param parentId  conductor 节点自身 id (子 id 前缀)
 * @param subplan   conductor 吐出并已过 schema 的子图 (节点名是模型起的)
 * @param opts.maxNodes 硬顶, 缺省 {@link DEFAULT_MAX_CHILDREN}
 */
export function expandConductorNode(
  parentId: string,
  subplan: ConductorPlan,
  opts: { maxNodes?: number } = {},
): ConductorExpandResult {
  const entries = Object.entries(subplan.nodes);
  if (entries.length === 0) return { status: 'empty', children: [], truncated: 0 };

  // ── D-D 禁嵌套 (先于一切: 嵌套子图连指纹都不该算) ──
  for (const [name, node] of entries) {
    const ex = (node as { executor?: string }).executor;
    if (ex && FORBIDDEN_CHILD_EXECUTORS.has(ex)) {
      return {
        status: 'nested',
        children: [],
        truncated: 0,
        error: `D-D 禁嵌套: 子节点 '${name}' 的 executor='${ex}' 不允许 (conductor 已是运行时展开, 不需要再套一层)`,
      };
    }
  }

  // ── 环检测: 外层图由建图闸保证无环, 子图是模型现画的, 得自己查 ──
  // (merkleFingerprints 内部有环防御会返 '∞cycle', 但那会让**多个**节点拿到同一个占位指纹 →
  //  id 相撞。所以环必须在算指纹之前就拒掉, 不能靠指纹层兜。)
  const cycle = findCycle(subplan);
  if (cycle) {
    return { status: 'cycle', children: [], truncated: 0, error: `子图有环: ${cycle.join(' → ')}` };
  }

  // ── D-B: 语义指纹 = 内容寻址的 key ──
  const fps = merkleFingerprints(subplan);

  // 同指纹消歧: 结构完全相同的兄弟 (如 best-of-N 的 N 个同 goal 候选) 会拿到同一个指纹 ——
  // 判重/复用层**故意**把它们看作等价, 但作为 id 必须互不相同。按 (指纹, 原名) 定序后追加序号,
  // 于是分配是确定的。⚠ conductor 给这几个孪生节点改名可能让序号互换 —— 无害: 它们规格与依赖
  // 逐字相同, 本就可互换 (这正是它们同指纹的原因)。
  const order = [...entries].sort(([a], [b]) => {
    const fa = fps.get(a)!;
    const fb = fps.get(b)!;
    return fa === fb ? (a < b ? -1 : a > b ? 1 : 0) : fa < fb ? -1 : 1;
  });
  const seen = new Map<string, number>();
  const keyOf = new Map<string, string>(); // originalId → 最终 key
  for (const [name] of order) {
    const fp = fps.get(name)!;
    const n = seen.get(fp) ?? 0;
    seen.set(fp, n + 1);
    keyOf.set(name, n === 0 ? fp : `${fp}-${n}`);
  }

  const maxNodes = opts.maxNodes ?? DEFAULT_MAX_CHILDREN;
  const truncated = Math.max(0, order.length - maxNodes);
  const kept = order.slice(0, maxNodes);
  const keptNames = new Set(kept.map(([name]) => name));

  const idOf = (name: string): string => `${parentId}::${keyOf.get(name)!}`;

  const children: ConductorChild[] = kept.map(([name, node]) => {
    const raw = (node.depends_on ?? []) as string[];
    // dep 重写: 指向子图内的 → 换成内容寻址 id; 指向子图外的 → **原样保留**。
    // 后者是刻意的: conductor 节点自己在外层有上游, 子节点引用它们是合法且有用的
    // (调用方会把父节点的 depends_on 并进每个子节点, 见 executor-dag 的接线)。
    // 被 maxNodes 截断掉的兄弟会在这里变成"外层未知 id" → 由执行器按幻象 dep 处理 (视为已满足),
    // 与 topoLevels/外层调度对未知 dep 的既有语义一致。
    const rewritten = raw.map((d) => (keptNames.has(d) ? idOf(d) : d));
    return {
      id: idOf(name),
      originalId: name,
      fingerprint: keyOf.get(name)!,
      node: { ...node, ...(rewritten.length ? { depends_on: rewritten } : {}) } as PlanNode,
    };
  });

  return { status: 'ok', children, truncated };
}

/**
 * 找一条环 (DFS 三色)。只看子图内部的边, 外部引用不算边 (它们由外层调度保证已完成)。
 * @returns 环上的节点名序列 (首尾同名), 无环 → null。
 */
function findCycle(subplan: ConductorPlan): string[] | null {
  const nodes = subplan.nodes;
  const state = new Map<string, 0 | 1 | 2>(); // 0/未访 1/在栈 2/完成
  const stack: string[] = [];

  const visit = (id: string): string[] | null => {
    if (state.get(id) === 2) return null;
    if (state.get(id) === 1) return [...stack.slice(stack.indexOf(id)), id];
    state.set(id, 1);
    stack.push(id);
    for (const d of (nodes[id]?.depends_on ?? []) as string[]) {
      if (!(d in nodes)) continue; // 外部引用不是子图内的边
      const found = visit(d);
      if (found) return found;
    }
    stack.pop();
    state.set(id, 2);
    return null;
  };

  for (const id of Object.keys(nodes)) {
    const found = visit(id);
    if (found) return found;
  }
  return null;
}
