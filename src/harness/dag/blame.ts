/**
 * src/harness/dag/blame —— 质量闸打回的**责备集**语义 (SDD 2026-08-10-blame-scoped-node-retry, 切片 2)。
 *
 * 判卷产出从纯散文升级为「散文 + 结构化责备集」: 判官在判词里附一个 ```blame 围栏,
 * 内容是 JSON 数组 `[{"node": "<节点id>", "reason": "<为什么>"}]`。引擎据此只失效
 * 「被责备节点 + 其下游闭包」, 其余节点走既有 D-21 语义指纹复用 —— 打回不再恒等于整轮重来
 * (2026-08-10 实测基线: 一次打回 = 10–16 分钟整轮)。
 *
 * **fail-open 是硬边界** (SDD Non-goals): 没有围栏 / JSON 坏 / 空数组 → 返 undefined,
 * 调用方走现行整轮路径, 行为逐字节不变 (INV-1)。宁可退回慢路径, 不可凭坏数据定点漏跑。
 */

export interface BlameEntry {
  /** 被责备的节点 id (plan 里的键)。 */
  readonly node: string;
  /** 为什么 —— 会被 append 到该节点重跑 prompt (D-3), 所以写给执行体看。 */
  readonly reason: string;
}

/** 判词中责备集围栏: ```blame\n[...]\n``` (围栏语言标签即协议标记, 判官 prompt 与此常量同源)。 */
const BLAME_FENCE = /```blame\s*\n([\s\S]*?)```/;

/**
 * 从判词散文里解出责备集。任何不合形 → undefined (fail-open, 调用方回整轮)。
 * 空数组也算不合形: 「打回但谁都不怪」没有定点语义, 与其猜不如整轮。
 */
export function parseBlameVerdict(verdict: string): BlameEntry[] | undefined {
  const m = BLAME_FENCE.exec(verdict);
  if (!m) return undefined;
  try {
    const parsed: unknown = JSON.parse(m[1]!);
    if (!Array.isArray(parsed) || parsed.length === 0) return undefined;
    const entries: BlameEntry[] = [];
    for (const e of parsed) {
      if (typeof e !== 'object' || e === null) return undefined;
      const node = (e as Record<string, unknown>).node;
      const reason = (e as Record<string, unknown>).reason;
      if (typeof node !== 'string' || !node.trim() || typeof reason !== 'string') return undefined;
      entries.push({ node: node.trim(), reason });
    }
    return entries;
  } catch {
    return undefined; // JSON 坏 = 判官没守协议 → 整轮 (证据在判词原文里, 不吞)
  }
}

/**
 * 失效闭包 = blamed ∪ downstream(blamed) (D-2)。
 * `deps` 是 plan 形状: nodeId → 它依赖的节点 id 列表。下游 = 依赖链上任何一跳踩到 blamed 的节点。
 * blamed 里不在图上的 id **原样保留**进闭包 (调用方据此发现判官指认了幽灵节点 → 按 fail-open 整轮;
 * 静默丢弃会把「判官胡指」伪装成「定点成功」)。
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
