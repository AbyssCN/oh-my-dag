/**
 * src/memory/safeguards/namespaces —— **装配 facade** (P1#1, R5, phase-2b 完成)。
 *
 * **wright core 编译零 domain** (phase-2b): 本 facade 只 import universal 装配, 不再 import a sibling project。
 * 默认装配 = `DEFAULT_SAFEGUARD` (= `UNIVERSAL_SAFEGUARD`: user.* 与 wright.*, **零 domain**)。
 * 不传 safeguard 的 caller/测试用它 → 默认只收用户/自身 fact, 拒一切 domain namespace。
 *
 * a sibling project (会计 domain + 辖区 ban 含 GDPR) 由 **调用边界注入** (`a sibling project` @ domain/a sibling project/
 * safeguard): daemon/a sibling project 装配 ValalMemory/DreamEngine 时显式传; dream 经
 * DreamEngine 构造器线到 restraint/router/purify; 测试显式 import a sibling project 注入。core 永不静态依赖它。
 */
import { globToRegExp, ConfidenceSchema, type Confidence, type ConfidenceLevel, type AssembledSafeguard } from './namespace-kernel';
import { UNIVERSAL_SAFEGUARD } from './universal-namespaces';

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
 *  wright 两族 universal namespace, 拒一切 domain namespace。a sibling project 行为需调用边界显式注入
 *  a sibling project。 */
export const DEFAULT_SAFEGUARD: AssembledSafeguard = UNIVERSAL_SAFEGUARD;

// ---- 公共面 (= DEFAULT_SAFEGUARD = universal 装配的派生导出) ----
export const FactNamespaceSchema = DEFAULT_SAFEGUARD.schema;
export const ALLOWED_NAMESPACES: readonly string[] = DEFAULT_SAFEGUARD.allowedNamespaces;
export const NAMESPACE_IDENTITY_FIELDS: Record<string, readonly string[]> = DEFAULT_SAFEGUARD.identityFields;
export const identityKeyOf = DEFAULT_SAFEGUARD.identityKeyOf as (fact: ValidatedFact) => string;
export const BANNED_NAMESPACE_GLOBS: readonly string[] = DEFAULT_SAFEGUARD.banGlobs;
export const BANNED_NAMESPACE_PATTERNS: readonly RegExp[] = BANNED_NAMESPACE_GLOBS.map(globToRegExp);
export const matchedBanGlob = DEFAULT_SAFEGUARD.matchedBanGlob;
