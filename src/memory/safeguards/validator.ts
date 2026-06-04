/**
 * src/memory/safeguards/validator.ts — write-time fact guard (PLAN D54).
 *
 * Design source: agent-memory-frameworks-2026-05-29.md §5.7 (flow) + §5.4.
 *
 * validateFactWrite is the single gate every L3 write passes through. Its
 * contract is REJECT-BY-DEFAULT: a fact is accepted only when it clears every
 * check in order. The ordering matters — the ban check runs BEFORE the schema
 * check so a GDPR-toxic namespace is refused even when its payload is otherwise
 * schema-valid (ban ranks above schema).
 *
 *   1. malformed       — not an object, or no string `namespace`
 *   2. banned          — namespace matches a BAN LIST glob (banned:true)
 *   3. secret          — (opt-in: opts.scanSecrets) a string value matches a SECRET pattern
 *   4. schema          — FactNamespaceSchema.safeParse fails (incl. unlisted ns)
 *   5. no-source-anchor— neither source_event_id nor source_doc_id present
 *   6. confidence       — confidence missing/invalid (Zod covers it; asserted)
 *
 * 密钥脱敏闸 (步骤 3, opt-in, 研究稿 wright-compounding-self-learning-v2 §闸门 I, the owner 2026-06-03):
 *   只拦真正的 secrets (API key / token / password / 私钥 PEM) —— 泄漏即损失。命中即 REJECT。
 *   **仅自动学习路径** (opts.scanSecrets=true, dream consolidation): agent 偶遇的密钥不该被当事实
 *   持久化。**显式 remember 不开此闸** = 用户主权 (用户明示要记的含密钥, 系统不替他决定)。
 *   **不拦 PII** (邮箱 / IP / 身份) —— kernel 零 PII 禁令; GDPR 级 PII 禁令属 a sibling project domain pack (R5)。
 *   secret 泄漏 rank 同 ban → 排在 schema 前 (schema-valid 但夹带密钥的 fact 一样拒)。
 */
import {
  ConfidenceSchema,
  DEFAULT_SAFEGUARD,
  type ValidatedFact,
  type AssembledSafeguard,
} from './namespaces';

export type ValidateOk = { ok: true; validated: ValidatedFact };
export type ValidateErr = { ok: false; reason: string; banned?: boolean };
export type ValidateResult = ValidateOk | ValidateErr;

/**
 * 密钥类正则 (仅 secrets, 不含任何 PII)。每条高信噪比 prefix/结构锚定, 避免误伤普通文本。
 * 排序无关 (任一命中即拒)。新增前自检: 会不会命中合法 user / wright 族 fact 的散文?
 *
 * ⚠ 明确 OUT-OF-SCOPE (正则根本边界, 不假装覆盖 — 防"看起来全拦"的假安全感):
 *   1. **裸 context-free 高熵密钥** (无关键字/前缀锚的 40字符 AWS secret access key、裸 64-hex、
 *      裸 base64 blob)。无结构锚 → 任何正则都得拒一切高熵串 = 海量误伤合法 hash/id/base64 数据。
 *      真实缓解: 这类密钥在 runtime 事件里几乎总伴 `aws_secret_access_key:` 等关键字 → 由
 *      keyword-assignment 一条接住。真正裸到没有任何上下文的密钥超出 write-time 正则的能力域。
 *   2. **空格拆分的 key** (`sk-live abc...`)。真密钥不含空格, 非真实 consolidation 形态。
 *   scanForSecret 只递归 string/Array/plain-object (fact 来自 JSON.parse, 不会有 Map/Set 叶子)。
 */
export const SECRET_PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
  // PEM 私钥头 (RSA/EC/OPENSSH/DSA/PGP/通用)。结构唯一, 零误伤。
  { name: 'pem-private-key', re: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/ },
  // OpenAI / Anthropic / Stripe 风格 sk- / pk_live_ / rk_live_ 密钥。
  { name: 'sk-style-key', re: /\b(?:sk|rk|pk)[-_](?:live|test|proj|ant|[A-Za-z0-9])[A-Za-z0-9_-]{16,}\b/ },
  // AWS access key id。AKIA + 16 大写字母数字, 唯一前缀。(secret access key 见 keyword-assignment)
  { name: 'aws-access-key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  // GitHub classic token (ghp_/gho_/ghu_/ghs_/ghr_ + 36+)。
  { name: 'github-token', re: /\bgh[posru]_[A-Za-z0-9]{36,}\b/ },
  // GitHub fine-grained PAT (github_pat_ 现为默认前缀)。
  { name: 'github-pat', re: /\bgithub_pat_[A-Za-z0-9_]{40,}\b/ },
  // GitLab PAT (glpat-)。
  { name: 'gitlab-pat', re: /\bglpat-[A-Za-z0-9_-]{20,}\b/ },
  // Slack token (xoxb/xoxp/xoxa/xoxr/xoxs/xoxe-refresh)。
  { name: 'slack-token', re: /\bxox[baprse]-[A-Za-z0-9-]{10,}\b/ },
  // Google API key (AIza + 35)。
  { name: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  // Azure storage / 64-byte base64 key (88 字符末尾 ==, 长度+padding 双锚)。
  { name: 'azure-base64-key', re: /\b[A-Za-z0-9+/]{86}==/ },
  // JWT (三段 base64url, eyJ 头)。
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/ },
  // 关键字锚定的赋值。两头都治:
  //   - P1-4 容噪声: keyword 与 :/= 之间允许引号/括号/方括号 (JSON `"password":` / `password (prod):`)。
  //   - P1-3 防误杀: 值必须**高熵** (含字母 AND 数字, ≥10 字符) → `api_key: required` (无数字) 不命中,
  //     真密钥 (hunter2dummy / wJalr...EXAMPLE) 命中。dict 散文几乎无 letter+digit+10 的连续 token。
  {
    name: 'keyword-assignment',
    re: /\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|aws[_-]?secret[_-]?access[_-]?key|private[_-]?key)\b["'`)\]\s]*[:=]\s*["'`]?(?=[A-Za-z0-9+/_-]*[A-Za-z])(?=[A-Za-z0-9+/_-]*\d)[A-Za-z0-9+/_-]{10,}/i,
  },
];

/** Narrow `unknown` to a plain object without losing the unknown values. */
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * 递归扫描 fact 的所有字符串值 (含嵌套对象/数组), 命中任一 SECRET_PATTERN 返回 pattern 名, 否则 null。
 * 只看 string 叶子 —— namespace/数字/布尔不可能藏密钥。
 */
export function scanForSecret(value: unknown): string | null {
  if (typeof value === 'string') {
    for (const { name, re } of SECRET_PATTERNS) {
      if (re.test(value)) return name;
    }
    return null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = scanForSecret(item);
      if (hit !== null) return hit;
    }
    return null;
  }
  if (isRecord(value)) {
    for (const v of Object.values(value)) {
      const hit = scanForSecret(v);
      if (hit !== null) return hit;
    }
    return null;
  }
  return null;
}

/** validateFactWrite 选项。scanSecrets 决定是否跑密钥脱敏闸 (见下)。 */
export interface ValidateOpts {
  /**
   * 仅自动学习路径置 true → 跑密钥脱敏 (步骤 3)。**默认 false**。
   *
   * 这是"密钥脱敏仅自动学习路径"语义的落点 (研究稿 §闸门 I + the owner 2026-06-03):
   *   - dream consolidation 等**自动**写路径: 置 true。agent 偶然在 runtime 事件里碰到密钥,
   *     不该把它当"学到的事实"持久化 (泄漏即损失)。
   *   - 用户**显式** remember 工具: 保持默认 false = 绕过密钥闸。**用户主权** —— 用户明示要记的
   *     (含密钥), 系统不替他做隐私决定。
   * 默认 false (非 true) 是刻意的: floor 只管结构/ban/schema/anchor/confidence; 密钥扫描是对
   * **不可信自动源**的附加约束, 由该源显式 opt-in, 不污染通用写入语义。
   */
  scanSecrets?: boolean;
}

export function validateFactWrite(
  fact: unknown,
  safeguard: AssembledSafeguard = DEFAULT_SAFEGUARD,
  opts: ValidateOpts = {},
): ValidateResult {
  // 1. Structural floor — must be an object carrying a string namespace.
  if (!isRecord(fact) || typeof fact.namespace !== 'string') {
    return { ok: false, reason: 'malformed' };
  }
  const namespace = fact.namespace;

  // 2. BAN LIST — ranked above schema. A banned namespace is refused even with
  //    an otherwise schema-valid payload (data minimisation is law).
  const banned = safeguard.matchedBanGlob(namespace);
  if (banned !== null) {
    return { ok: false, reason: `banned:${banned}`, banned: true };
  }

  // 3. SECRET (opt-in, 仅自动学习路径) — 密钥类 (key/token/pw/PEM) 命中即拒, rank 同 ban (schema 前)。
  //    不拦 PII (R5 kernel 零 PII 禁令)。显式 remember 不开 scanSecrets → 用户主权可记密钥。
  if (opts.scanSecrets) {
    const secret = scanForSecret(fact);
    if (secret !== null) {
      return { ok: false, reason: `secret:${secret}` };
    }
  }

  // 4. Allowlist schema — an unlisted namespace fails the discriminatedUnion
  //    ("No matching discriminator") and is rejected here. safeguard 注入决定
  //    哪些 namespace 在 allowlist (universal user.*/wright.* / +a sibling project domain)。
  const parsed = safeguard.schema.safeParse(fact);
  if (!parsed.success) {
    // Keep the message terse; the structured issues live in the Zod error.
    const first = parsed.error.issues[0];
    const msg = first?.message ?? 'invalid';
    return { ok: false, reason: `schema:${msg}` };
  }
  // 装配 union 的 schema 是 z.ZodTypeAny (多 pack 合并, 见 namespace-kernel.assembleSafeguard) →
  // data 静态为 unknown; 运行时已过 reject-by-default 校验, cast 回 ValidatedFact (共享字段精确)。
  const validated = parsed.data as ValidatedFact;

  // 5. Source anchor — at least one of source_event_id / source_doc_id. (Kept
  //    out of the per-namespace Zod so the reason is explicit rather than a
  //    buried refinement message.)
  if (
    (validated.source_event_id === undefined || validated.source_event_id === '') &&
    (validated.source_doc_id === undefined || validated.source_doc_id === '')
  ) {
    return { ok: false, reason: 'no-source-anchor' };
  }

  // 6. Confidence — Zod already enforced it via the namespace schema, but assert
  //    explicitly so a future schema edit that drops the field cannot silently
  //    let an unconfident fact through.
  const conf = ConfidenceSchema.safeParse(validated.confidence);
  if (!conf.success) {
    return { ok: false, reason: 'confidence-invalid' };
  }

  return { ok: true, validated };
}
