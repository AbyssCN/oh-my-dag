/**
 * weak/repair —— L3 承重柱: schema-coerce + 同模型单次重问 → 仍错 fail-closed (SDD §6)。
 *
 * 弱模型常返"几乎对"的结构化输出: JSON 裹在 markdown ```fence 里 (MiMo eval: 纯 NLT
 * 0/3 死于 markdown 污染), 或漏一个字段。L3 是确定性修复闸, 不是"更强模型兜底"(被否):
 *
 *   1. coerce: 若 raw 是字符串, 剥 ```fence + 提取首个 JSON, 再 parse。
 *   2. validate: schema.safeParse。过 → 返 (attempts=1, repaired=false)。
 *   3. repair: 不过 → 把 issues 喂回**同一个模型**重问一次 (注入的 reprompt 回调)。
 *   4. re-validate: 过 → 返 (attempts=2, repaired=true); 仍不过 → **fail-closed**
 *      (ok:false), 绝不返一个半对的对象骗下游。
 *
 * reprompt 是注入的 (模型/传输无关), 故纯逻辑可测 (fake reprompt)。同模型单次 —— 不升级、
 * 不投票、不无限重试 (anti-slop: 弱模型 harness 是焊护栏, 不是堆算力)。
 */
import type { ZodType } from 'zod';

/** 从可能裹 markdown fence / 前后缀文字的字符串里提取首个 JSON 值。 */
export function extractJson(raw: string): unknown {
  let s = raw.trim();
  // 剥 ```json … ``` 或 ``` … ``` fence。
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence && fence[1]) s = fence[1].trim();
  // 退而求其次: 截取首个 { 或 [ 到对应末尾 (最外层平衡)。
  const start = s.search(/[[{]/);
  if (start === -1) {
    // 没有结构起点 —— 也许是裸标量 (数字/布尔/带引号串)。
    return JSON.parse(s);
  }
  const open = s[start];
  const close = open === '{' ? '}' : ']';
  const end = s.lastIndexOf(close);
  if (end > start) s = s.slice(start, end + 1);
  return JSON.parse(s);
}

/** raw → 候选值: 字符串走 extractJson (吞 parse 异常返 raw 原样让 schema 去判)。 */
function coerce(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  try {
    return extractJson(raw);
  } catch {
    return raw; // 让 schema.safeParse 给出结构化失败, 而非在此吞掉
  }
}

/** schema 校验失败时, 喂回模型重问。返回模型的新 raw 输出。 */
export type RepromptFn = (issues: string[], previousRaw: unknown) => Promise<unknown> | unknown;

export type RepairResult<T> =
  | { ok: true; value: T; attempts: 1 | 2; repaired: boolean }
  | { ok: false; reason: string; attempts: 1 | 2; issues: string[] };

export interface CoerceOrRepairOpts {
  /** 关掉重问 (只 coerce+validate 一次)。默认 false = 允许单次重问。 */
  noReprompt?: boolean;
}

/**
 * L3 核心: coerce → validate →(失败)单次重问 → re-validate →(仍失败)fail-closed。
 *
 * @param raw      模型原始输出 (string / 已解析对象皆可)。
 * @param schema   期望结构 (Zod)。
 * @param reprompt 同模型重问回调; 省略 / noReprompt → 跳过 step 3, 一次定生死。
 */
export async function coerceOrRepair<T>(
  raw: unknown,
  schema: ZodType<T>,
  reprompt?: RepromptFn,
  opts: CoerceOrRepairOpts = {},
): Promise<RepairResult<T>> {
  // attempt 1: coerce + validate
  const first = schema.safeParse(coerce(raw));
  if (first.success) {
    return { ok: true, value: first.data, attempts: 1, repaired: false };
  }
  const issues1 = first.error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`);

  // 无重问能力 → 一次定生死, fail-closed。
  if (!reprompt || opts.noReprompt) {
    return { ok: false, reason: 'schema-invalid (no-reprompt)', attempts: 1, issues: issues1 };
  }

  // attempt 2: 同模型单次重问
  let raw2: unknown;
  try {
    raw2 = await reprompt(issues1, raw);
  } catch (err) {
    // 重问本身炸 = fail-closed (不能因异常变 fail-open)。
    return {
      ok: false,
      reason: `reprompt-threw: ${(err as Error).message}`,
      attempts: 2,
      issues: issues1,
    };
  }
  const second = schema.safeParse(coerce(raw2));
  if (second.success) {
    return { ok: true, value: second.data, attempts: 2, repaired: true };
  }
  const issues2 = second.error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`);
  return { ok: false, reason: 'schema-invalid (after-repair)', attempts: 2, issues: issues2 };
}
