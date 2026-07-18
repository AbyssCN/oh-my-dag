/**
 * plan/map-expand —— U1 动态扇出节点的**纯展开逻辑**(给定 lister 输出 → 子节点集)。
 *
 * STUDY (docs/knowledge/research/workflow-vs-dag-2026-07-11/STUDY.md) 裁决: 图外相对 Workflow
 * 最疼的缺口 = 工作清单 author-time 未知 (T2 conductor 幻觉造工具)。解 = map 节点运行时展开,
 * 且展开产物仍是 applicative 子节点 → 保住图外四样优势 (依赖 resume / 静态分析 / 可证明终止 / 可移植)。
 *
 * 本模块**只做纯逻辑**: 输入 (mapNodeId, spec, lister 已跑出的输出) → 输出子节点集。
 * **不跑 lister、不碰模型、不碰 DB** —— lister 执行 + 层调度 + resume 是 P1/P2 (executor-dag / checkpoint)。
 * 全同步纯函数 → 无 Date/random,完整可单测。
 *
 * 不变量 (SDD §2.2):
 *  INV-U2 稳定 id: 子 id = `${mapNodeId}::${key}`, key = keyBy 取值或内容 hash, **绝不用 index**;
 *                  展开前按 key 排序 → lister 输出重排不改子集 (resume 命根)。
 *  INV-U4 有界扇出: maxItems 硬顶, 截断记 truncated (调用方须 log, 无声截断违反 no-silent-caps)。
 *  INV-U5 禁嵌套 map: 模板 executor==='map' → 拒 (防无界递归; schema superRefine 已拒, 此处防御性二道闸)。
 *  INV-U8 产物路径不撞: 子节点 output_type:'file' 时 output_path 按 key 唯一化, 否则 N 子互相覆盖。
 */

/** map 展开规格 (对应 conductor-plan MapSpec 的运行时切面; 宽松 record 模板)。 */
export interface MapSpecLike {
  over: string;
  itemVar: string;
  keyBy?: string;
  template: Record<string, unknown>;
  maxItems?: number;
  concurrency?: number;
}

/** 一个展开出的子节点。 */
export interface MapChild {
  /** 稳定 id: `${mapNodeId}::${key}` (INV-U2)。 */
  id: string;
  /** 归一化稳定 key (排序 + id + 路径唯一化用)。 */
  key: string;
  /** 原始元素 (审计 + 下游收集)。 */
  item: unknown;
  /** 实例化后的模板节点 (${itemVar}/${key} 已插值, output_path 已唯一化)。 */
  node: Record<string, unknown>;
}

export type ExpandStatus = 'ok' | 'empty' | 'not_array' | 'nested_map';

export interface ExpandResult {
  status: ExpandStatus;
  /** 展开出的子节点 (status==='ok' 时非空; empty/not_array/nested_map 时为 [])。 */
  children: MapChild[];
  /** 被 maxItems 截断丢弃的元素数 (INV-U4; 调用方须 log)。 */
  truncated: number;
  /** not_array/nested_map 时的原因。 */
  error?: string;
}

/** 默认扇出硬顶 (INV-U4)。大仓审计 >64 → 分批 map (v1 DEFER, 先 64+log)。 */
export const DEFAULT_MAX_ITEMS = 64;

// ── 纯工具 ────────────────────────────────────────────────────────────────────

/** 稳定 stringify (键排序) → 内容 hash 输入确定。 */
function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const obj = v as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(',')}}`;
}

/** FNV-1a 32-bit → 8-hex (无 crypto 依赖, 确定性, 够作 id 消歧/内容 key fallback)。 */
function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** 点路径取值: getPath({a:{b:1}}, 'a.b') → 1。 */
function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const seg of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

/** key 归一化为 id/路径安全串 (小写, 非 [a-z0-9] → '-', 收缩, 去首尾 '-')。 */
function sanitizeKey(raw: string): string {
  const s = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return s || 'x'; // 全非法字符 → 兜底非空 (避免空 key 撞 id)
}

/** ${itemVar}/${itemVar.field}/${key} 插值; 未解析的 token 保留字面 (可见失败, 便于调试)。 */
function interpolate(str: string, bindings: { itemVar: string; item: unknown; key: string }): string {
  return str.replace(/\$\{([^}]+)\}/g, (whole, expr: string) => {
    const e = expr.trim();
    if (e === 'key') return bindings.key;
    if (e === bindings.itemVar) {
      const it = bindings.item;
      return it === null || typeof it !== 'object' ? String(it) : stableStringify(it);
    }
    if (e.startsWith(`${bindings.itemVar}.`)) {
      const v = getPath(bindings.item, e.slice(bindings.itemVar.length + 1));
      return v === undefined ? whole : String(v);
    }
    return whole;
  });
}

/** 扩展名前插 key: 'audit.md' + 'a' → 'audit.a.md' (INV-U8 唯一化)。 */
function insertKeyBeforeExt(path: string, key: string): string {
  const dot = path.lastIndexOf('.');
  const slash = path.lastIndexOf('/');
  if (dot > slash && dot >= 0) return `${path.slice(0, dot)}.${key}${path.slice(dot)}`;
  return `${path}.${key}`;
}

/**
 * map spec 的确定性 hash(INV-U3 两级 resume 的"spec 半边")。
 * 只吃 spec(lister/over/itemVar/keyBy/template/maxItems),不吃运行时子集 —— resume 时
 * spec hash 变 = lister/模板改了 → 作废整棵 map 子树;不变 → 子节点各自按 checkpoint 续。
 */
export function mapSpecHash(spec: MapSpecLike & { lister?: unknown }): string {
  return fnv1a(
    stableStringify({
      lister: spec.lister ?? null,
      over: spec.over,
      itemVar: spec.itemVar,
      keyBy: spec.keyBy ?? null,
      template: spec.template,
      maxItems: spec.maxItems ?? DEFAULT_MAX_ITEMS,
    }),
  );
}

// ── 展开 ──────────────────────────────────────────────────────────────────────

/**
 * 纯展开: map 节点 + lister 已跑出的输出 → 子节点集。
 * @param mapNodeId 父 map 节点 id (子 id 前缀)
 * @param spec      MapSpec 运行时切面
 * @param listerOutput lister 的结构化输出 (P1 已跑; 此处只读它的 over 键)
 */
export function expandMapNode(
  mapNodeId: string,
  spec: MapSpecLike,
  listerOutput: Record<string, unknown> | null | undefined,
): ExpandResult {
  // INV-U5 防御性二道闸 (schema superRefine 是一道)。
  if ((spec.template as { executor?: string })?.executor === 'map')
    return { status: 'nested_map', children: [], truncated: 0, error: 'INV-U5: 模板禁为 map' };

  const arr = listerOutput ? (listerOutput as Record<string, unknown>)[spec.over] : undefined;
  if (!Array.isArray(arr))
    return { status: 'not_array', children: [], truncated: 0, error: `over 键 '${spec.over}' 非数组` };
  if (arr.length === 0) return { status: 'empty', children: [], truncated: 0 };

  // 每元素取 key: keyBy 取路径值 > 原始元素(string/number)取值本身(可读) > 对象内容 hash。
  const keyed = arr.map((item) => {
    let base: string;
    if (spec.keyBy) {
      const raw = getPath(item, spec.keyBy);
      base = raw !== undefined && raw !== null ? sanitizeKey(String(raw)) : fnv1a(stableStringify(item));
    } else if (item === null || typeof item !== 'object') {
      base = sanitizeKey(String(item)); // 原始元素 → 值本身作 key
    } else {
      base = fnv1a(stableStringify(item)); // 对象无 keyBy → 内容 hash
    }
    return { item, key: base };
  });

  // key 撞车消歧 (INV-U2 唯一): 同 key 追加内容 hash 短尾, 保持确定。
  const seen = new Map<string, number>();
  for (const k of keyed) {
    const n = seen.get(k.key) ?? 0;
    seen.set(k.key, n + 1);
    if (n > 0) k.key = `${k.key}-${fnv1a(stableStringify(k.item)).slice(0, 6)}`;
  }

  // 按 key 排序 → 顺序无关 (INV-U2: lister 重排不改子集/顺序)。
  keyed.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  const maxItems = spec.maxItems ?? DEFAULT_MAX_ITEMS;
  const truncated = Math.max(0, keyed.length - maxItems);
  const kept = keyed.slice(0, maxItems);

  // 模板是否已用 ${key} token 显式放置 key (放了就别再唯一化, 防重复)。
  const rawOutPath = typeof spec.template.output_path === 'string' ? spec.template.output_path : undefined;
  const hadKeyToken = rawOutPath ? /\$\{\s*key\s*\}/.test(rawOutPath) : false;

  const children: MapChild[] = kept.map(({ item, key }) => {
    const node: Record<string, unknown> = structuredClone(spec.template);
    const bindings = { itemVar: spec.itemVar, item, key };
    // 字符串字段插值 (goal/command/persona/output_path)。
    for (const f of ['goal', 'command', 'persona', 'output_path'] as const) {
      if (typeof node[f] === 'string') node[f] = interpolate(node[f] as string, bindings);
    }
    // INV-U8: file 类唯一化 output_path (模板未用 ${key} token 时才自动插)。
    if (node.output_type === 'file' && typeof node.output_path === 'string' && !hadKeyToken)
      node.output_path = insertKeyBeforeExt(node.output_path as string, key);
    return { id: `${mapNodeId}::${key}`, key, item, node };
  });

  return { status: 'ok', children, truncated };
}
