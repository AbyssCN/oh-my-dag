/**
 * src/harness/goal/chain-router —— 路由器 (D4 切片, 2026-08-31)
 *
 * 承 `docs/plan/2026-08-31-dynamic-workflow-design.md` §6 R1–R9:
 * solve 规划期加一层「路由 + 阶段链编译」。本文件 = 路由器部分 (切片 2);
 * 阶段链 IR + 编译器在 `./stage-chain` (切片 1), 接线在 `run-goal.ts` (切片 3)。
 *
 * ## 决策 (D-4 / D-6 / INV-6 落地)
 *
 * - **D-4** 路由器 = 单次结构化调用, 输出钳在封闭枚举
 *     (`GRAPH_SHAPES` ids ∪ 链模板 ∪ `'none'`)。v1 链模板 = 空集 (D-3 线性 + 无登记);
 *     所以 v1 路由只能命中 `GRAPH_SHAPES` 里的 shape id 或 inline StageChain (经 'chain' kind)
 *     或 `'none'`。
 * - **D-6** 路由命中后 conductor 无改拓扑权 (切片 3 接线时落, 本文件只产 RouteDecision)。
 * - **INV-6** 路由 fail-open 不吞证据: 解析失败 / 越界 id → 降级 'none', 但 logger
 *     必留一行带原始返回文本。
 *
 * ## 三件套
 *
 *   ① types (`RouteDecision` / `RouteRaw` / `RouteCaller` / `RouteLogger` / `RouteDeps`)
 *      → 切片 1 / 3 消费的冻结接口
 *   ② `parseRouteRaw(raw, logger?)`   → 纯函数: 钳到封闭枚举 + 留证据
 *   ③ `routeChain(goal, deps)`         → S2 冻结签名: 走装配好的 caller, 然后 parseRouteRaw
 *
 * ## 反向自检的统一形状 (本仓惯例, 同 stage-chain.test)
 *
 *   每条 GWT 配一份「已知违规样本」, 闸摘掉 → test 当场由绿转红。证伪方式写在 test 注释里,
 *   一行一锚。
 */
import { GRAPH_SHAPES } from '../shapes';
import type { StageChain } from './stage-chain';

// ── 公开类型 (S2 冻结接口; 实装偏离 = 回流改契约) ──────────────────────────

/**
 * S2 冻结: 路由结果。
 *   · 'shape'  → 命中一张图式卡 (shapeId ∈ GRAPH_SHAPES); 调用方按卡填节点
 *   · 'chain'  → 命中一条阶段链 (v1 = inline StageChain); 调用方走 compileChain
 *   · 'none'   → 未命中; 退现状自由规划
 */
export type RouteDecision =
  | { kind: 'shape'; shapeId: string }
  | { kind: 'chain'; chain: StageChain }
  | { kind: 'none' };

/**
 * deps = 路由期可见的外部上下文 (seats / 当前形状候选 / etc.)。
 * v1 不消费 — 留口子给 v2, 类型故意为开放 record 而非具体形状。
 * 读侧一律视为 opaque, 别开始加判 (那是切片 3 接线时的事)。
 */
export type RouteDeps = Readonly<Record<string, unknown>>;

/**
 * 单次结构化调用的原始返回 (D-4)。
 * 闭合 union — 但 shapeId 字符串允许越界, 越界由 parseRouteRaw 钳 (INV-6)。
 * chain.stages 允许为空数组 / 缺字段, 同样由 parseRouteRaw 钳。
 */
export type RouteRaw =
  | { kind: 'shape'; shapeId: string }
  | { kind: 'chain'; chain: StageChain }
  | { kind: 'none' };

/** 单次结构化调用的执行者 (D-4)。slice 3 实装时换成真 LLM/路由; v1 / 测试假它。 */
export type RouteCaller = (goal: string, deps: RouteDeps) => Promise<RouteRaw>;

/** 证据出口 (INV-6 fail-open 不吞证据)。测试时换 capture 数组。 */
export type RouteLogger = (line: string) => void;

// ── 封闭枚举 (D-4: GRAPH_SHAPES ids ∪ 链模板 ∪ 'none') ──────────────────

/**
 * GRAPH_SHAPES id 集合: 路由 shape 决策的合法目标。
 * 静态取自真源 `shapes/index.ts`, 不维护第二份 (与 STAGE_WORDS 同款做法, 仓规)。
 */
const SHAPE_IDS: ReadonlySet<string> = new Set(GRAPH_SHAPES.map((s) => s.id));

/**
 * 链模板 id 集合 (D-4)。v1 = 空集 (D-3 线性 + 无模板登记): 留常量占位, v2 接入链模板
 * 后此处取 `new Set(TEMPLATES.map(t => t.id))`, 并在 parseRouteRaw 的 'chain' 分支加一道
 * 「先按 id 查模板再走 inline」的查找。当前 RouteDecision 的 'chain' 分支只接 inline。
 */
const CHAIN_TEMPLATE_IDS: ReadonlySet<string> = new Set<string>();

// ── 模块级 caller / logger (切片 3 装配; 测试可换) ────────────────────────

/** 默认 caller: 不调任何真 LLM, 直接 'none'。让 slice 3 装配前 routeChain 是无害 no-op。 */
let _caller: RouteCaller = async () => ({ kind: 'none' });

/** 默认 logger: 落 stderr。 */
let _logger: RouteLogger = (line) => {
  console.warn(line);
};

/**
 * 装配入口 (切片 3 = `run-goal.ts` 启动时调一次)。
 * 不导出默认值 — 故意强制 slice 3 显式注入, 杜绝「漏装 = 静默走 'none'」的隐形 fallback。
 * 但 logger 可选 — 不传就保持模块默认 console.warn。
 */
export function configureRouteCaller(caller: RouteCaller, logger?: RouteLogger): void {
  _caller = caller;
  if (logger) _logger = logger;
}

/** 测试用: 把 caller / logger 重置到模块默认, 防用例间状态污染。 */
export function _resetRouteCallerForTest(): void {
  _caller = async () => ({ kind: 'none' });
  _logger = (line) => {
    console.warn(line);
  };
}

// ── 路由器主体 (S2 冻结签名 routeChain(goal, deps) -> RouteDecision) ──────

/**
 * 单次结构化调用 → RouteDecision (S2 冻结签名)。
 *
 * 三类 fail-open (INV-6, 全部留证据):
 *   · caller 抛异常                          → 'none' + logger 留行
 *   · raw 不是对象 / kind 越界                → 'none' + logger 留行
 *   · kind='shape' 但 shapeId 不在 SHAPE_IDS  → 'none' + logger 留行
 *   · kind='chain' 但 chain.stages 缺失/空     → 'none' + logger 留行
 *
 * 合法路径:
 *   · kind='shape' 且 shapeId ∈ SHAPE_IDS   → 原样传
 *   · kind='chain' 且 chain.stages.length>0  → 原样传 (编译期闸由 compileChain 兜底)
 *   · kind='none'                            → 原样传
 *
 * 注意: caller 的语义切片 — chain.kind 是 inline StageChain 而非模板 id, 与本切片
 * `RouteDecision.chain: StageChain` (S2 冻结) 一致; 模板化留 v2 (见 CHAIN_TEMPLATE_IDS)。
 */
export async function routeChain(goal: string, deps: RouteDeps): Promise<RouteDecision> {
  let raw: RouteRaw;
  try {
    raw = await _caller(goal, deps);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    _logger(
      `[chain-router] 结构化调用抛异常 — 降级 'none' (INV-6); ` +
        `goal="${truncate(goal, 80)}"; error=${msg}`,
    );
    return { kind: 'none' };
  }
  return parseRouteRaw(raw, _logger);
}

/**
 * 把 RouteRaw 钳到 RouteDecision, 满足 INV-6 的封闭枚举钳 + 证据留痕。
 *
 * 拆出来 = 纯函数, 测试可以直接喂 raw 而不必绕 caller; 同时让 routeChain 主体薄到
 * 只剩 try/catch + parseRouteRaw, 出错定位容易。
 *
 * logger 可选 — 不传走模块默认 (routeChain 走的就是模块默认, 这里给独立调用方留口子)。
 */
export function parseRouteRaw(
  raw: RouteRaw,
  logger: RouteLogger = _logger,
): RouteDecision {
  if (!raw || typeof raw !== 'object') {
    logger(
      `[chain-router] raw 非对象 — 降级 'none' (INV-6); raw=${safeStringify(raw)}`,
    );
    return { kind: 'none' };
  }

  const kind = (raw as { kind?: unknown }).kind;

  if (kind === 'none') {
    return { kind: 'none' };
  }

  if (kind === 'shape') {
    const id = (raw as { shapeId?: unknown }).shapeId;
    if (typeof id !== 'string' || !SHAPE_IDS.has(id)) {
      logger(
        `[chain-router] shapeId="${String(id)}" 不在 GRAPH_SHAPES 枚举内 — ` +
          `降级 'none' (INV-6); raw=${safeStringify(raw)}`,
      );
      return { kind: 'none' };
    }
    return { kind: 'shape', shapeId: id };
  }

  if (kind === 'chain') {
    const chain = (raw as { chain?: unknown }).chain;
    const stages = chain && typeof chain === 'object'
      ? (chain as { stages?: unknown }).stages
      : undefined;
    if (!Array.isArray(stages) || stages.length === 0) {
      logger(
        `[chain-router] chain.stages 缺失或空 — 降级 'none' (INV-6); raw=${safeStringify(raw)}`,
      );
      return { kind: 'none' };
    }
    return { kind: 'chain', chain: chain as StageChain };
  }

  // kind 越界 (不在 union 三选一内)
  logger(
    `[chain-router] raw.kind="${String(kind)}" 不在封闭枚举内 — 降级 'none' (INV-6); ` +
      `raw=${safeStringify(raw)}`,
  );
  return { kind: 'none' };
}

// ── helpers ──────────────────────────────────────────────────────────────

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function safeStringify(o: unknown): string {
  try {
    return JSON.stringify(o);
  } catch {
    return String(o);
  }
}
