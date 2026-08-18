/**
 * src/harness/chat/history-recall —— 压缩遮蔽段的回捞纯函数(SDD 2026-08-18-recallable-compaction-chat,切片 1)。
 *
 * 契约:`docs/plan/2026-08-18-recallable-compaction-chat.md` C-1(接口冻结)与 D-7(范围定义,唯一真源)。
 *
 * ## 零 IO、重放确定
 * 三个函数都只是 `entries()`(分支条目序列,根→叶)的纯函数:不读文件、不用时钟/随机/LLM。
 * 同一份条目数组连跑两次输出 byte 相同(闸:G2,`history-recall.test.ts`)。
 *
 * ## D-7 遮蔽范围(不许另发明)
 * span(C) = 分支路径上「前一条 compaction 之后(无则从根)到 C 之前」的全部**消息型**条目
 * (`entry.type === 'message'`);shadowed(C) = span(C) 去掉末尾 `retainedTail.length` 条。
 * retainedTail 是消息副本、不带 entry id ⇒ **只能按条数对位**,不许按 id / role / 内容匹配。
 * 空 span:count 显式为 0(NULL ≠ 0,不省略字段);startSeq 与 endSeq 相等 —— 都取 C.seq,
 * 它是「定义只依赖条目序列」约束下空 span 唯一可推导的边界值。
 */
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { OmdSession } from './session-store';

export interface ShadowedSpan {
  compactionEntryId: string;
  /** shadowed(C) 首条消息型条目 seq;空 span 时与 endSeq 相等且 count = 0。 */
  startSeq: number;
  /** shadowed(C) 末条消息型条目 seq。 */
  endSeq: number;
  /** shadowed(C) 条数。NULL ≠ 0:空 span 显式 count = 0,不省略字段。 */
  count: number;
}

export type BranchEntries = Awaited<ReturnType<OmdSession['entries']>>;

/** 消息型条目(结构性收窄;pi 的 `Entry` 联合里有它,不必 import 整个联合)。 */
interface MessageEntryLike {
  type: 'message';
  id: string;
  seq: number;
  parentId: string | null;
  timestamp: number;
  message: AgentMessage;
}

interface CompactionEntryLike {
  type: 'compaction';
  id: string;
  seq: number;
  retainedTail: AgentMessage[];
}

interface ResolvedSpan {
  span: ShadowedSpan;
  messages: MessageEntryLike[];
}

/** D-7 的范围计算:一条 compaction 一条 span,retainedTail 按条数对位(见文件头)。 */
function resolveSpans(entries: BranchEntries): ResolvedSpan[] {
  const resolved: ResolvedSpan[] = [];
  let spanStart = 0; // 本 span 的窗口起点:前一条 compaction 之后(无则从根)。
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    if (entry.type !== 'compaction') continue;
    const compaction = entry as CompactionEntryLike;
    const messages = entries
      .slice(spanStart, i)
      .filter((x): x is MessageEntryLike => x.type === 'message');
    const shadowed = messages.slice(0, Math.max(0, messages.length - compaction.retainedTail.length));
    resolved.push({
      messages: shadowed,
      span: {
        compactionEntryId: compaction.id,
        startSeq: shadowed.length > 0 ? shadowed[0]!.seq : compaction.seq,
        endSeq: shadowed.length > 0 ? shadowed[shadowed.length - 1]!.seq : compaction.seq,
        count: shadowed.length,
      },
    });
    spanStart = i + 1;
  }
  return resolved;
}

function findResolved(entries: BranchEntries, compactionEntryId: string): ResolvedSpan {
  const found = resolveSpans(entries).find((r) => r.span.compactionEntryId === compactionEntryId);
  if (!found) {
    throw new Error(`[history-recall] 不存在 compaction 条目: ${JSON.stringify(compactionEntryId)}`);
  }
  return found;
}

/** 一条 AgentMessage 的正文文本(纯函数;toolCall 块与未知块都给确定性的字面形式)。 */
function messageText(m: AgentMessage): string {
  const content = (m as { content?: unknown }).content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (block === null || typeof block !== 'object') return '';
        const b = block as Record<string, unknown>;
        if (b.type === 'text' && typeof b.text === 'string') return b.text;
        if (b.type === 'toolCall' && typeof b.name === 'string') {
          const raw = b.arguments ?? b.input;
          return `[toolCall ${b.name} ${typeof raw === 'string' ? raw : JSON.stringify(raw ?? {})}]`;
        }
        return JSON.stringify(block);
      })
      .filter((s) => s !== '')
      .join('\n');
  }
  if (content == null) return '';
  return JSON.stringify(content);
}

/** 三段式标签。message 条目实际只装 user / assistant / toolResult 三种角色;未知角色按原名输出。 */
const ROLE_LABEL: Record<string, string> = { user: 'User', assistant: 'Assistant', toolResult: 'Tool result' };

function renderMessage(m: AgentMessage): string {
  const role = (m as { role?: string }).role ?? '';
  return `${ROLE_LABEL[role] ?? role}: ${messageText(m)}`;
}

export function listShadowedSpans(entries: BranchEntries): ShadowedSpan[] {
  return resolveSpans(entries).map((r) => r.span);
}

/**
 * 渲染某条 compaction 的 shadowed 消息(顺序 = 条目序,根→叶)。
 *
 * `offset` / `nextOffset` 单位 = 渲染文本的**字符位**(JS string.length 口径),
 * `nextOffset` 是「下次从哪里续读」:budgetChars 截断时在场,渲染完**缺席**(不是 undefined)。
 * 空 span → `{ text: '' }`。`offset` 越界(≥ 全长)按已读完处理;负值按 0 收。
 */
export function renderShadowedTranscript(
  entries: BranchEntries,
  compactionEntryId: string,
  opts?: { offset?: number; budgetChars?: number },
): { text: string; nextOffset?: number } {
  const { messages } = findResolved(entries, compactionEntryId);
  const text = messages.length > 0 ? `${messages.map((m) => renderMessage(m.message)).join('\n')}\n` : '';
  const from = Math.min(text.length, Math.max(0, Math.floor(opts?.offset ?? 0)));
  const budget = opts?.budgetChars === undefined ? undefined : Math.floor(opts.budgetChars);
  if (budget === undefined || from + budget >= text.length) {
    return { text: text.slice(from) };
  }
  const to = from + budget;
  return { text: text.slice(from, to), nextOffset: to };
}

/** snippet 命中点前后各带的字符数(确定性常量,不随输入变)。 */
const SNIPPET_CONTEXT_CHARS = 120;

/**
 * 在 shadowed 段里做纯字面扫描(大小写敏感,零索引零 LLM)。
 *
 * `scanned` = 检查过的条目数 = 定界用的 compaction 条目 + 被搜正文的消息型条目
 * (于是 `scanned` ≥ spans 总数**结构性成立**,G1 的钉法);
 * `matched` = 命中 ≥1 次的**条目**数(一条多命中仍计 1,取首个命中点切 snippet);
 * `truncated` = 有命中因 `limit` 被丢下。query 为空串、compactionEntryId 不存在 → 抛。
 */
export function searchShadowedSpans(
  entries: BranchEntries,
  query: string,
  opts?: { compactionEntryId?: string; limit?: number },
): {
  snippets: Array<{ compactionEntryId: string; seq: number; snippet: string }>;
  scanned: number;
  matched: number;
  truncated: boolean;
} {
  if (query === '') throw new Error('[history-recall] 搜索 query 不能为空串');
  const all = resolveSpans(entries);
  const spans =
    opts?.compactionEntryId === undefined
      ? all
      : all.filter((r) => r.span.compactionEntryId === opts.compactionEntryId);
  if (opts?.compactionEntryId !== undefined && spans.length === 0) {
    throw new Error(`[history-recall] 不存在 compaction 条目: ${JSON.stringify(opts.compactionEntryId)}`);
  }
  const limit = opts?.limit === undefined ? Infinity : Math.max(0, Math.floor(opts.limit));
  const snippets: Array<{ compactionEntryId: string; seq: number; snippet: string }> = [];
  let scanned = 0;
  let matched = 0;
  for (const r of spans) {
    scanned += 1; // 定界用的 compaction 条目
    for (const m of r.messages) {
      scanned += 1;
      const text = messageText(m.message);
      const hit = text.indexOf(query);
      if (hit === -1) continue;
      matched += 1;
      if (snippets.length >= limit) continue;
      const from = Math.max(0, hit - SNIPPET_CONTEXT_CHARS);
      const to = Math.min(text.length, hit + query.length + SNIPPET_CONTEXT_CHARS);
      const snippet = `${from > 0 ? '…' : ''}${text.slice(from, to)}${to < text.length ? '…' : ''}`;
      snippets.push({ compactionEntryId: r.span.compactionEntryId, seq: m.seq, snippet });
    }
  }
  return { snippets, scanned, matched, truncated: matched > snippets.length };
}