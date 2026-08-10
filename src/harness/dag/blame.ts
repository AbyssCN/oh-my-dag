/**
 * src/harness/dag/blame —— 质量闸打回的**责备集**语义 (SDD 2026-08-10-blame-scoped-node-retry, 切片 2)。
 *
 * 判卷产出从纯散文升级为「散文 + 结构化责备集」: 判官在判词里附一个 ```blame 围栏,
 * 内容是 JSON 数组, 条目二选一: `{"node": "<节点id>", "reason": "<为什么>"}` 点名节点,
 * 或 `{"artifact": "<产物id>", "reason": "<为什么>"}` 点名产物 (保留槽, 本期不接线重跑)。
 * 引擎据此只失效「被责备节点 + 其下游闭包」, 其余节点走既有 D-21 语义指纹复用 —— 打回不再
 * 恒等于整轮重来 (2026-08-10 实测基线: 一次打回 = 10–16 分钟整轮)。
 * 围栏外散文不进结构, 仍是打回事由正文。
 *
 * **fail-open 是硬边界** (SDD Non-goals): 没有围栏 / JSON 坏 / 空数组 → 返 undefined,
 * 调用方走现行整轮路径, 行为逐字节不变 (INV-1)。宁可退回慢路径, 不可凭坏数据定点漏跑。
 */

export type BlameEntry =
  | { node: string; reason: string }       // 点名节点 id
  | { artifact: string; reason: string };  // 点名产物 (保留槽, resolveBlameEntries 按 output_path 映射到节点)

/** 解析结果形: 合法责备集条目数组 (节点点名 + 产物点名保留槽)。undefined = 无围栏 / 坏 JSON / 空数组 → fail-open 整轮 (INV-1)。 */
export type BlameVerdict = BlameEntry[];

/** 判词中责备集围栏: ```blame\n[...]\n``` (围栏语言标签即协议标记; 冻结 schema 常量, 判官 prompt 与此同源)。 */
export const BLAME_FENCE = /```blame\s*\n([\s\S]*?)```/;

/**
 * 从判词散文里解出责备集。任何不合形 → undefined (fail-open, 调用方回整轮)。
 * 空数组也算不合形: 「打回但谁都不怪」没有定点语义, 与其猜不如整轮。
 * 条目缺 reason / reason 空串 / node 与 artifact 均缺或空白 → 整批拒 (半好数据比没数据更危险)。
 */
export function parseBlameVerdict(verdict: string): BlameVerdict | undefined {
  const m = BLAME_FENCE.exec(verdict);
  if (!m) return undefined;
  try {
    const parsed: unknown = JSON.parse(m[1]!);
    if (!Array.isArray(parsed) || parsed.length === 0) return undefined;
    const entries: BlameEntry[] = [];
    for (const e of parsed) {
      if (typeof e !== 'object' || e === null) return undefined;
      const rec = e as Record<string, unknown>;
      const reason = rec.reason;
      if (typeof reason !== 'string' || reason.trim() === '') return undefined;
      const node = rec.node;
      if (typeof node === 'string' && node.trim()) {
        entries.push({ node: node.trim(), reason });
        continue;
      }
      const artifact = rec.artifact;
      if (typeof artifact === 'string' && artifact.trim()) {
        entries.push({ artifact: artifact.trim(), reason });
        continue;
      }
      return undefined; // node/artifact 均缺 (或空白) → 整批拒, fail-open
    }
    return entries;
  } catch {
    return undefined; // JSON 坏 = 判官没守协议 → 整轮 (证据在判词原文里, 不吞)
  }
}

/**
 * 失效闭包 = blamed ∪ downstream(blamed) (D-2)。
 * `deps` 是 plan 形状: nodeId → 它依赖的节点 id 列表。下游 = 依赖链上任何一跳踩到 blamed 的节点。
 * blamed 里不在图上的 id **原样保留**进闭包 —— 调用方应**先过滤不在图内的 id** 再传入 (如 engine.ts
 * 以 `exec.plan.nodes` 预滤); 若调用方不预滤, 可在结果上检测 `closure \ deps` 非空 → 判官胡指 → fail-open。
 * 静默丢弃幽灵 id 会把「判官胡指」伪装成「定点成功」。
 */
export function invalidationClosure(blamed: readonly string[], deps: Readonly<Record<string, readonly string[]>>): Set<string> {
  const out = new Set(blamed);
  // 不动点迭代: 图小 (节点数十级), O(n²) 足够; 拓扑序不必假设。
  let grew = true;
  while (grew) {
    grew = false;
    for (const [node, nodeDeps] of Object.entries(deps)) {
      if (!out.has(node) && nodeDeps.some((d) => out.has(d))) {
        out.add(node);
        grew = true;
      }
    }
  }
  return out;
}

/**
 * 产物→节点解析结果。调用方据此决定: unresolved 非空 → 部分 blame 无法定点 → 按 fail-open 整轮。
 */
export interface BlameResolution {
  /** 解析出的节点 id 集合 (含直接点名 + 产物映射)。 */
  nodes: string[];
  /** 无法映射到任何节点的 artifact 条目 (调用方应 fail-open)。 */
  unresolved: BlameEntry[];
}

/**
 * 将 blame 条目中的 artifact 映射到产出节点 (D-2 前置)。
 * `nodes` 是 plan 的节点表 (ConductorPlan.nodes 或等形 `Record<string, { output_path?: string }>`)。
 * 映射策略: ① 精确匹配 `output_path` ② 回退 basename 匹配 (一个 basename 命中唯一节点才采纳;
 * 多节点同 basename → 不猜, 归入 unresolved)。直接点名 `node` 的条目不经映射直接入 nodes。
 *
 * 本期 artifact→node 映射是尽力而为 (best-effort): 缺 output_path 的节点、command 节点、同 basename
 * 冲突都归 unresolved。调用方见 unresolved 非空应 fail-open 走整轮 (宁可慢, 不可漏)。
 */
export function resolveBlameEntries(
  entries: readonly BlameEntry[],
  nodes: Readonly<Record<string, { output_path?: string }>>,
): BlameResolution {
  const resolved = new Set<string>();
  const unresolved: BlameEntry[] = [];

  // 预建 artifact→node 索引: output_path → [nodeId, ...]
  const byOutputPath = new Map<string, string[]>();
  const byBasename = new Map<string, string[]>();
  for (const [id, node] of Object.entries(nodes)) {
    const p = node.output_path?.trim();
    if (!p) continue;
    const prev = byOutputPath.get(p);
    if (prev) prev.push(id);
    else byOutputPath.set(p, [id]);
    const base = p.split('/').pop()!;
    const prevB = byBasename.get(base);
    if (prevB) prevB.push(id);
    else byBasename.set(base, [id]);
  }

  for (const e of entries) {
    if ('node' in e) {
      resolved.add(e.node);
      continue;
    }
    // artifact 条目: 尝试映射
    const artifactId = e.artifact.trim();
    // ① 精确 output_path 匹配
    const exact = byOutputPath.get(artifactId);
    if (exact && exact.length === 1) {
      resolved.add(exact[0]!);
      continue;
    }
    // ② basename 匹配 (唯一命中才采纳)
    const base = artifactId.split('/').pop()!;
    const baseHits = byBasename.get(base);
    if (baseHits && baseHits.length === 1) {
      resolved.add(baseHits[0]!);
      continue;
    }
    // ③ 映射失败 → 保留, 等调用方 fail-open
    unresolved.push(e);
  }

  return { nodes: [...resolved], unresolved };
}
