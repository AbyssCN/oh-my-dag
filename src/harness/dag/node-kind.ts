/**
 * src/harness/dag/node-kind —— 节点执行类别判定 (B1, dsh/cordis 吸收计划线 B)。
 *
 * 从 engine.ts `runNodeOnce` 的 if-链**逐字提取**的判定逻辑, 与执行体分离:
 * 本函数判"这是哪类节点", engine 里的 `nodeExecutors` 表定"这类节点谁来跑"。
 *
 * 忠实性约束 (行为保持重构, 单一变量 = 分发机制):
 *   - 判定顺序与原 if-链逐条相同 (primitive → map → conductor → await → command → research → leaf);
 *   - 带 guard 的三类 (primitive 缺 node.primitive / map 缺 node.map / await 缺 node.await)
 *     缺配套字段时回落 leaf —— 原链的 fall-through 语义原样保留;
 *   - **唯一刻意变化**: 词表外的 executor 字符串返回 null (原链静默落 inproc leaf)。
 *     engine 对 null fail-closed —— 与 command 负退出码闸同理, 这是给预构造 plan
 *     (不经 zod 校验) 的运行期硬闸; 经 parsePlan 的图 executor 被 schema 钳在词表内, 到不了这。
 *
 * 完整性: engine 的表类型是 `Record<NodeExecKind, …>` —— 表里删一行是 **tsc 编译错**,
 * 不是运行期惊喜 (B1 判据"表删一行 → fail-closed"的编译期形态)。
 */

export const NODE_EXEC_KINDS = ['primitive', 'map', 'conductor', 'await', 'command', 'research', 'leaf'] as const;
export type NodeExecKind = (typeof NODE_EXEC_KINDS)[number];

/** leaf 家族 executor 值 (agent/inproc 双模路由在 leaf 执行体内部, 不在这层分)。 */
const LEAF_FAMILY = new Set(['agent', 'leaf', 'inproc']);

export interface NodeKindProbe {
  kind?: string;
  primitive?: unknown;
  executor?: string;
  map?: unknown;
  await?: unknown;
}

/** 判定节点执行类别; null = 词表外 executor (调用方 fail-closed)。 */
export function nodeExecKind(node: NodeKindProbe): NodeExecKind | null {
  if (node.kind === 'primitive' && node.primitive) return 'primitive';
  if (node.executor === 'map' && node.map) return 'map';
  if (node.executor === 'conductor') return 'conductor';
  if (node.executor === 'await' && node.await) return 'await';
  if (node.executor === 'command') return 'command';
  if (node.executor === 'research') return 'research';
  if (node.executor === undefined || LEAF_FAMILY.has(node.executor)) return 'leaf';
  // map/await 缺配套字段 (上面 guard 没过) → 原链 fall-through 落 leaf, 忠实保留。
  if (node.executor === 'map' || node.executor === 'await') return 'leaf';
  return null;
}
