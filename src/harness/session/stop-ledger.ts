/**
 * src/harness/session/stop-ledger —— W3 独立增量 Stop-ledger parser(Open-1/Open-5 冻结)。
 *
 * 纯函数、确定性、无副作用:不碰文件系统/进程/Git/HEAD/env,不 grep transcript,
 * 只消费结构化 JSONL 源串(Open-3:结构化 W3 输出是唯一输入,无 transcript grep/raw-text 替代)。
 *
 * 规则(冻结 Markdown 为行为真源):
 * - `type:'assistant'` 行 → 一条 entry,ordinal 从 1 按源序连续;
 * - tokenBucket = input + cache_read + cache_creation(冻结公式,E-P1;output 不计),
 *   usage 读 `message.usage`(CC assistant 规范位置;缺/非对象则回退顶层 usage 兼容合成 fixture),
 *   缺键/缺失/非对象/非有限数 → null(best-effort,不伪造数、不溢出成 Infinity);
 * - assistantText = text 块逐字按序 + tool_use 抽取材料(Bash command / 文件路径,同 W1 excerpt 约定),
 *   抽取材料逐字不截断;无内容 → null;
 * - user 行(含 `<system-reminder` / `<task-notification` / skill 前导 精确前缀)与未知 line.type
 *   (GWT-3 allowlist)不产生 entry、不报错、不污染 assistantText;合法 JSON 但非 record 同忽略;
 * - lastUserAsk(仅从 `type:'user'` 记录提取, 完整解析成功后按源行逆序选择):
 *   content 非空 string → 原串;array 含任一 `tool_result` → 该记录无 candidate;
 *   否则取首个非空 `text` 原串;其余形状无 candidate(不 trim、不折叠、不解析);
 *   原始 `startsWith("<system-reminder")` / `startsWith("<task-notification")` /
 *   `startsWith("Base directory for this skill:")` 三前缀均跳过继续(精确前缀, 不 trim/不折叠/不泛化),
 *   其他 candidate → `found`(value 为原串 `.slice(0,200)`), 耗尽 → `empty`;
 * - 空行/全空白跳过;malformed 非空行 → typed error(1-based 源行号 + 非空 message),
 *   含 `type:'assistant'` 但 message 非对象的结构损坏行同样 typed error,绝不静默跳过也不抛异常
 *   (fail-open 值语义,GWT-6)。
 *
 * @module
 */

// ─── Public types(冻结 API)─────────────────────────────────────────────────

export interface StopLedgerEntry {
  readonly ordinal: number;
  readonly tokenBucket: number | null;
  readonly assistantText: string | null;
}

export type LastUserAsk =
  | Readonly<{ status: 'found'; value: string; sourceLine: number }>
  | Readonly<{ status: 'empty'; value: null; sourceLine: null }>;

export interface StopLedger {
  readonly entries: readonly StopLedgerEntry[];
  readonly lastUserAsk: LastUserAsk;
}

export interface StopLedgerParseError {
  readonly line: number;
  readonly message: string;
}

export type StopLedgerParseResult =
  | Readonly<{ ok: true; ledger: StopLedger }>
  | Readonly<{ ok: false; error: StopLedgerParseError }>;

// ─── helpers ────────────────────────────────────────────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 冻结 token 公式:input + cache_read + cache_creation(output 不计);三键任一缺失/非数/非有限 → null。 */
function tokenBucketOf(usage: unknown): number | null {
  if (!isRecord(usage)) return null;
  const { input_tokens, cache_read_input_tokens, cache_creation_input_tokens } = usage;
  if (
    typeof input_tokens !== 'number' ||
    !Number.isFinite(input_tokens) ||
    typeof cache_read_input_tokens !== 'number' ||
    !Number.isFinite(cache_read_input_tokens) ||
    typeof cache_creation_input_tokens !== 'number' ||
    !Number.isFinite(cache_creation_input_tokens)
  ) {
    return null;
  }
  const bucket = input_tokens + cache_read_input_tokens + cache_creation_input_tokens;
  return Number.isFinite(bucket) ? bucket : null;
}

/** usage 规范位置:`message.usage`(CC assistant 记录承载 observed usage);缺/非对象回退顶层 usage。 */
function usageOf(record: Record<string, unknown>): unknown {
  const msgUsage = isRecord(record.message) ? record.message.usage : undefined;
  return isRecord(msgUsage) ? msgUsage : record.usage;
}

/** content 块 → 抽取材料:text 逐字按序;tool_use 取 file_path/command/query/prompt(同 W1 excerpt)。 */
function assistantTextOf(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
    } else if (block.type === 'tool_use' && typeof block.name === 'string' && isRecord(block.input)) {
      const inp = block.input;
      const brief = inp.file_path || inp.command || inp.query || inp.prompt || JSON.stringify(inp);
      parts.push(`T: ${block.name} ${String(brief)}`);
    }
  }
  return parts.length > 0 ? parts.join('\n') : null;
}

/** user content → candidate 原串(D-1);无 candidate 返回 null。不 trim、不折叠、不解析。 */
function userCandidateOf(content: unknown): string | null {
  if (typeof content === 'string') return content.length > 0 ? content : null;
  if (!Array.isArray(content)) return null;
  for (const block of content) {
    if (isRecord(block) && block.type === 'tool_result') return null; // 任一 tool_result → 整条无 candidate
  }
  for (const block of content) {
    if (isRecord(block) && block.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
      return block.text; // 首个非空 text 原串
    }
  }
  return null;
}

// 冻结前缀:原始字符串精确 startsWith, 不做 trim/大小写折叠/XML/slash 泛化(D-3)。
export const TASK_NOTIFICATION_PREFIX = '<task-notification';
export const SYSTEM_REMINDER_PREFIX = '<system-reminder';
export const SKILL_PREAMBLE_PREFIX = 'Base directory for this skill:';

/** 逆序状态机(D-2):完整解析成功后选最后真实 ask;三精确前缀 skip+continue 逆扫, 耗尽 → empty。 */
function selectLastUserAsk(candidates: readonly { line: number; value: string }[]): LastUserAsk {
  for (let i = candidates.length - 1; i >= 0; i--) {
    const c = candidates[i]!;
    if (
      c.value.startsWith(SYSTEM_REMINDER_PREFIX) ||
      c.value.startsWith(TASK_NOTIFICATION_PREFIX) ||
      c.value.startsWith(SKILL_PREAMBLE_PREFIX)
    ) {
      continue;
    }
    return { status: 'found', value: c.value.slice(0, 200), sourceLine: c.line };
  }
  return { status: 'empty', value: null, sourceLine: null };
}

// ─── parser ─────────────────────────────────────────────────────────────────

export function parseStopLedger(source: string): StopLedgerParseResult {
  const entries: StopLedgerEntry[] = [];
  const userCandidates: { line: number; value: string }[] = [];
  const lines = source.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim()) continue; // 空行/全空白跳过
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      return { ok: false, error: { line: i + 1, message: `第 ${i + 1} 行不是合法 JSON: ${detail}` } };
    }
    if (!isRecord(record)) continue; // 裸值/非 record → 忽略
    if (record.type === 'user') {
      // D-1:user candidate 仅从 message.content 提取;形状无 candidate 不报错。
      const content = isRecord(record.message) ? record.message.content : undefined;
      const candidate = userCandidateOf(content);
      if (candidate !== null) userCandidates.push({ line: i + 1, value: candidate });
      continue;
    }
    if (record.type !== 'assistant') continue; // 未知 type → 忽略
    if (!isRecord(record.message)) {
      // 已知 assistant 类型但结构损坏(message 非对象)→ typed error,不静默吞成 null 字段。
      return { ok: false, error: { line: i + 1, message: `第 ${i + 1} 行 assistant 记录缺 message 对象` } };
    }
    const message = record.message;
    entries.push({
      ordinal: entries.length + 1,
      tokenBucket: tokenBucketOf(usageOf(record)),
      assistantText: assistantTextOf(message.content),
    });
  }
  return { ok: true, ledger: { entries, lastUserAsk: selectLastUserAsk(userCandidates) } };
}
