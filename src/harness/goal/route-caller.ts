/**
 * src/harness/goal/route-caller —— 路由阶段的生产 LLM caller (D4.1 切片 2, 2026-09-01)
 *
 * 承 `docs/plan/2026-09-01-stage-chain-compiler.md` (§D4.1, D-2 / INV-2 / INV-3):
 *
 *  - **D-2** 装配位置 = run-goal 的 chain 块内, 惰性 (chain 关时不构造) 且幂等 (装过不重装)。
 *    本文件只造 caller, 装配由 `run-goal.ensureProductionRouteCaller` 在 `else if (chainOn && runnable)`
 *    入口调一次。模块默认 caller (chain-router 的 `_caller` 初始值) 永远返 `'none'` —— 不装配 = 零回退。
 *
 *  - **INV-2** 关断零成本: chain 开关关闭 (config.chain 与 env.OMD_CHAIN 都缺席) 时, `else if`
 *    分支不进, 本模块也不被 import / 装配 / 调用。
 *
 *  - **INV-3** 产物钳:
 *      · LLM 返回非 JSON           → 本层 throw, 由 chain-router.routeChain 的 catch 降级 'none' + 留证据
 *      · LLM 调用本身抛异常         → 同上 catch
 *      · 合法 JSON 但词表外 word    → 由 chain-router.parseRouteRaw 的封闭枚举钳
 *      · 合法 JSON 但 chain.stages 为空 → 同上
 *      · chain 形态错误 (map 缺 listFrom 等) → compileChain → validateChain 兜底
 *    本层**不重复实现**形状钳, 与 chain-router / stage-chain 共用同一份入参定义。
 *
 * ## 三件套 (切片 2 写集)
 *   ① `BuildRouteCallerDeps`     → 注入面 (leaf 坐标 + 一次 LLM 调用最小接口)
 *   ② `buildRouteCaller(deps)`   → 单次结构化调用 (D-4 = 1 跑)
 *   ③ `routeCallerPrompt(goal)`   → prompt 渲染 (词表与 Stage 字段从 stage-chain 原文注入, 不抄第二份)
 */
import type { RouteRaw, RouteCaller } from './chain-router';
import { STAGE_WORDS } from './stage-chain';

/** 注入面: 一次 LLM 调用的最小接口。runner (e.g., agentRunner) 与测试 fake 共用此形。 */
export interface RouteCallerCall {
  (input: { prompt: string; model: string }): Promise<{ text: string }>;
}

export interface BuildRouteCallerDeps {
  /** leaf 座位坐标 (config.dag.agentLeafModel ?? config.dag.leafModel, 便宜档)。 */
  leafCoord: string;
  /** 一次调用。抛错 → caller 包装后上抛, 由 chain-router.routeChain 的 catch 降级。 */
  call: RouteCallerCall;
}

/**
 * 单次结构化调用的 prompt (INV-3 词表原文注入):
 * - 词表来源 = `STAGE_WORDS` (stage-chain.ts:34), 不抄第二份。
 * - Stage 字段清单从 `Stage` 接口的 JSDoc 派生, 同源原则。
 *
 * 失败语义已下沉到 chain-router.routeChain —— 本函数产 prompt 即可, 不预判输出格式。
 */
export function routeCallerPrompt(goal: string): string {
  return [
    '你是一台 router。读下面这段 goal, 产出**严格一段 JSON**, 不要解释、不要代码块前缀。',
    '',
    'JSON 形 (三选一):',
    '  · `{"kind":"none"}` — 没合适形状, 走默认规划',
    '  · `{"kind":"shape","shapeId":"<id>"}` — 命中一张图式卡 (id 必须在下表)',
    '  · `{"kind":"chain","chain":{"stages":[<stage>,...]}}` — 命中一条阶段链',
    '',
    `阶段链词表 (8 词, 词表外直接被拒): ${STAGE_WORDS.join(', ')}`,
    '',
    '每个 stage 字段 (Stage 接口原文):',
    '  · id: string              — 链内唯一',
    '  · word: StageWord         — 见上方词表',
    '  · goal?: string           — 文本槽; research/agent/verify/judge/synthesize 必填',
    '  · command?: string        — word="command" 必填',
    '  · primitive?: { id, params } — word="primitive" 必填',
    '  · listFrom?: { stage, extractor } — word="map" 必填',
    '  · perItem?: string        — word="map" 必填, ${item} 由引擎插值',
    '',
    '约束:',
    '  · stages 至少 1 个',
    '  · 闭合的形状 (map 必带 listFrom + perItem, command 必带 command)',
    '  · 必填槽缺失 / 词表外 → caller 端的 parseRouteRaw / validateChain 会拒, 应当尽量避免',
    '  · 任何非 JSON 输出 → caller 视为无路由命中',
    '',
    `## goal\n${goal}`,
  ].join('\n');
}

/**
 * 从 LLM raw 文本抽一个 JSON 对象。三类失败:
 *   · 不是 JSON (含被 ``` 包裹的合法 JSON)
 *   · 顶层不是对象 (比如 `[]` 或 `"oops"`)
 *   · JSON.parse 抛
 * 全部归 `{ ok:false, raw }`, **raw 留给上层日志一行带片段** (INV-3 fail-open 留证据);
 * JSON.parse 抛时败因经 `parseError` 一并交出 (仓规 §静默坑 2: 吞异常不许吞证据)。
 */
export function tryParseJson(
  text: string,
): { ok: true; value: RouteRaw } | { ok: false; raw: string; parseError?: string } {
  const trimmed = text.trim();
  // 剥外层代码块包裹 (模型爱贴 ```json ... ```); 仅剥**外层**一对, 不递归 (deep 包含是另一份契约)
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const candidate = fenced ? fenced[1]!.trim() : trimmed;
  // 仅对象形可解构 (RouteRaw union 都是对象); 数组与字面量直接判否
  if (!candidate.startsWith('{')) {
    return { ok: false, raw: trimmed };
  }
  let obj: unknown;
  try {
    obj = JSON.parse(candidate);
  } catch (err) {
    return { ok: false, raw: trimmed, parseError: (err as Error).message };
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { ok: false, raw: trimmed };
  }
  return { ok: true, value: obj as RouteRaw };
}

/**
 * 装配一个生产 RouteCaller。
 *
 * 构造期检: `leafCoord` 非空, `call` 是函数。两者缺一抛 `Error` (fail-loud, 不静默等到第一次跑)。
 * 运行期: LLM 抛异常 → 包装 `Error` 上抛 (chain-router.routeChain 的 catch 接住 + 留证据);
 * LLM 返非 JSON → `tryParseJson` 失败 → 同样上抛 (消息含原文前 200 字)。
 *
 * 不装配 = `chain-router._caller` 仍指向默认 no-op caller (`{kind:'none'}`),
 * 即开了 `chain` 开关但装配层漏装也不会炸, 只走零回退。
 */
export function buildRouteCaller(deps: BuildRouteCallerDeps): RouteCaller {
  if (!deps.leafCoord || typeof deps.leafCoord !== 'string') {
    throw new Error('buildRouteCaller: leafCoord 必填非空字符串 (INV-2 配置面)');
  }
  if (typeof deps.call !== 'function') {
    throw new Error('buildRouteCaller: call 必填为函数 (INV-2 配置面)');
  }
  return async (goal: string, _routeDeps): Promise<RouteRaw> => {
    let text: string;
    try {
      const r = await deps.call({ prompt: routeCallerPrompt(goal), model: deps.leafCoord });
      text = typeof r.text === 'string' ? r.text : '';
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`[route-caller] LLM 调用抛异常: ${msg}`);
    }
    const parsed = tryParseJson(text);
    if (!parsed.ok) {
      // 上抛让 chain-router.routeChain 的 catch 走 'none' + 留 INV-3 证据行
      throw new Error(`[route-caller] 返回非 JSON: ${parsed.raw.slice(0, 200)}`);
    }
    return parsed.value;
  };
}
