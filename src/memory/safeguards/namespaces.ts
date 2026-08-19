/**
 * src/memory/safeguards/namespaces —— **装配 facade** (P1#1, R5, phase-2b 完成)。
 *
 * **omd core 编译零 domain** (phase-2b): 本 facade 只 import universal 装配, 不再 import a sibling project。
 * 默认装配 = `DEFAULT_SAFEGUARD` (= `UNIVERSAL_SAFEGUARD`: user.* 与 omd.*, **零 domain**)。
 * 不传 safeguard 的 caller/测试用它 → 默认只收用户/自身 fact, 拒一切 domain namespace。
 *
 * a sibling project (会计 domain + 辖区 ban 含 GDPR) 由 **调用边界注入** (`a sibling project` @ domain/a sibling project/
 * safeguard): daemon/a sibling project 装配 ValalMemory/DreamEngine 时显式传; dream 经
 * DreamEngine 构造器线到 restraint/router/purify; 测试显式 import a sibling project 注入。core 永不静态依赖它。
 */
import { assembleSafeguard, globToRegExp, ConfidenceSchema, type Confidence, type ConfidenceLevel, type AssembledSafeguard } from './namespace-kernel';
import { UNIVERSAL_SAFEGUARD, USER_NAMESPACE_PACK, OMD_NAMESPACE_PACK } from './universal-namespaces';
import { CONTINUITY_NAMESPACE_PACK } from './continuity-namespace';

// ---- 通用机制 re-export ----
export { ConfidenceSchema };
export type { Confidence, ConfidenceLevel, AssembledSafeguard };

/**
 * L3 fact 类型 (loose): 共享字段精确 (validator/dream 用), per-namespace 字段经 `[k]: unknown` 动态。
 * reject-by-default 的精确性由**运行时** schema 保证, 非编译期类型。
 */
export interface ValidatedFact {
  namespace: string;
  source_event_id?: string;
  source_doc_id?: string;
  confidence: Confidence;
  [k: string]: unknown;
}
export type FactNamespace = string;

// ---- 可注入装配 ----
export { UNIVERSAL_SAFEGUARD };
/** 默认装配 (= UNIVERSAL, **零 domain**)。不传 safeguard 的 caller/测试用它 —— 只收 user 与
 *  omd 两族 universal namespace, 拒一切 domain namespace。a sibling project 行为需调用边界显式注入
 *  a sibling project。 */
export const DEFAULT_SAFEGUARD: AssembledSafeguard = UNIVERSAL_SAFEGUARD;

/**
 * **宿主进程**装配 (= universal + continuity)。MCP / TUI 这类**开共享库**的进程用它。
 *
 * 不变量:**读一个库的 safeguard, 它的 schema 必须覆盖那个库里出现过的每一个 namespace。**
 * 读路不是"只走库不走闸" —— `store.liveFactsByNamespace` / `liveTentativeFacts` / `fact()`
 * 三处都 `safeguard.schema.parse(payload)`。分支缺了那个 namespace ⇒ parse 抛:
 *   - `listCheckpoints` 有 `catch → []` ⇒ **静默空列表**(#206 实测:写入侧成功、读面恒空);
 *   - `liveTentativeFacts` 没有 catch ⇒ 整趟扫描抛。
 * 而 `sinkCheckpoint` 把 continuity 写进的就是 `resolveMemoryDbPath` 那个共享库,
 * 所以宿主装配必须带上 continuity 分支。**写入面仍窄**:写入侧另用
 * `CONTINUITY_SAFEGUARD`(只 continuity 一格),见 `continuity-namespace.ts`。
 */
export const HOST_SAFEGUARD: AssembledSafeguard = assembleSafeguard([
  USER_NAMESPACE_PACK,
  OMD_NAMESPACE_PACK,
  CONTINUITY_NAMESPACE_PACK,
]);

// ---- 公共面 (= DEFAULT_SAFEGUARD = universal 装配的派生导出) ----
export const FactNamespaceSchema = DEFAULT_SAFEGUARD.schema;
export const ALLOWED_NAMESPACES: readonly string[] = DEFAULT_SAFEGUARD.allowedNamespaces;
export const NAMESPACE_IDENTITY_FIELDS: Record<string, readonly string[]> = DEFAULT_SAFEGUARD.identityFields;
export const identityKeyOf = DEFAULT_SAFEGUARD.identityKeyOf as (fact: ValidatedFact) => string;
export const BANNED_NAMESPACE_GLOBS: readonly string[] = DEFAULT_SAFEGUARD.banGlobs;
export const BANNED_NAMESPACE_PATTERNS: readonly RegExp[] = BANNED_NAMESPACE_GLOBS.map(globToRegExp);
export const matchedBanGlob = DEFAULT_SAFEGUARD.matchedBanGlob;
