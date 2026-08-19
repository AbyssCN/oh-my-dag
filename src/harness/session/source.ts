/**
 * src/harness/session/source —— **会话来源缝**(#211)。
 *
 * 蒸馏器(`writer.ts`)只吃两样东西:**一段紧凑摘录文本** + **这一刻的 ctx token 真值**。
 * 本模块就是那条缝:谁能吐出自己的对话记录,谁就能接上,而下游(9 段蒸馏 · 验真闸 ·
 * noun-gate · checkpoint.md · sink→facts · latest.json)**只有一份实现**。
 *
 * 今天两个实现:
 * - `ccTranscriptSource` —— Claude Code 的 transcript JSONL(按字节偏移增量读);
 * - `omdSessionSource` —— omd 自己的 `OmdSession`(按条目序号增量读)。
 *
 * 再接一家(Codex / Gemini CLI / 任何 agent)= 再写一个 `SessionSource`,不动蒸馏器。
 *
 * ## 摘录格式是**共享**的,不是各写各的
 *
 * `U:` 用户 · `A:` 助手正文 · `T:` 工具调用 · `R:` 工具结果 —— 蒸馏 prompt 是照这个形状调的,
 * 所以行的拼法与截断上限收在本模块里(`lineU/lineA/lineT/lineR` + `capExcerpt`),
 * 各 source 只负责**认出**自己格式里的那四类东西。
 *
 * @module
 */
import { openSync, readSync, fstatSync, closeSync } from 'node:fs';
import { SYSTEM_REMINDER_PREFIX, TASK_NOTIFICATION_PREFIX, SKILL_PREAMBLE_PREFIX } from './stop-ledger';

// ─── Public types ───────────────────────────────────────────────────────────

export interface SessionExcerpt {
  /** 蒸馏器吃的紧凑摘录。**空串 = 无新增**(writer 据此跳过重蒸馏)。 */
  readonly text: string;
  /**
   * 下次从哪里续读。**语义由 source 自己定义**(CC = 字节偏移,omd = 条目序号)——
   * writer 只负责原样存进 `state.json` 再原样还回来,不解释它。
   */
  readonly cursor: number;
  /**
   * 这一刻的 ctx token 真值。**量不到 = `null`,不伪造也不填 0**(仓规坑①:
   * 「没量到」与「量到 0」塌成一个值就永远分不开)。
   */
  readonly ctxTokens: number | null;
}

export interface SessionSource {
  /** source 名字,落进 `state.json` —— 同一个 session 换了 source 时看得见。 */
  readonly kind: string;
  read(cursor: number): Promise<SessionExcerpt>;
}

// ─── 共享的摘录格式(各 source 只认内容,不各自定格式)──────────────────────

/** 喂便宜模型的摘录上限。 */
export const MAX_EXCERPT_CHARS = 100_000;

const USER_CAP = 500;
const ASSISTANT_CAP = 800;
const TOOL_NAME_ARG_CAP = 160;
const TOOL_RESULT_CAP = 200;

/** 与 W3 parser 同名单的三精确前缀 (D-4): 噪音 user 文本不进 `U:` 行。 */
export function isNoiseUserText(s: string): boolean {
  return (
    s.startsWith(SYSTEM_REMINDER_PREFIX) ||
    s.startsWith(TASK_NOTIFICATION_PREFIX) ||
    s.startsWith(SKILL_PREAMBLE_PREFIX)
  );
}

export const lineU = (t: string): string => `U: ${t.slice(0, USER_CAP)}`;
export const lineA = (t: string): string => `A: ${t.slice(0, ASSISTANT_CAP)}`;
export const lineT = (name: string, brief: string): string => `T: ${name} ${brief.slice(0, TOOL_NAME_ARG_CAP)}`;
export const lineR = (t: string): string => `R: ${t.slice(0, TOOL_RESULT_CAP)}`;

/** 行数组 → 摘录文本(超上限取尾部,并**说明截过**——不静默丢内容)。 */
export function capExcerpt(lines: readonly string[]): string {
  const text = lines.join('\n');
  return text.length > MAX_EXCERPT_CHARS ? `…(更早内容已截)\n${text.slice(-MAX_EXCERPT_CHARS)}` : text;
}

/** 工具入参 → 一行简报(四个惯用键优先,都没有就整包 JSON 截断)。CC 与 omd 共用。 */
export function toolBrief(input: unknown): string {
  if (input === null || typeof input !== 'object') return String(input ?? '');
  const inp = input as Record<string, unknown>;
  const picked = inp.file_path ?? inp.command ?? inp.query ?? inp.prompt;
  return picked !== undefined && picked !== null ? String(picked) : JSON.stringify(inp).slice(0, 120);
}

// ─── source ①: Claude Code transcript JSONL ─────────────────────────────────

const TRANSCRIPT_CHUNK_CAP = 6 * 1024 * 1024;

/**
 * transcript JSONL → 紧凑对话摘录。
 *
 * ⚠ 这是**全仓唯一**认 Claude Code 记录格式(`type:'user'|'assistant'` + `message.content` 块)
 * 的地方。要再接一家 agent,写一个新的 `SessionSource`,别在别处再解析一遍这个形状。
 */
export function excerpt(chunk: string): string {
  const out: string[] = [];
  for (const line of chunk.split('\n')) {
    if (!line.trim()) continue;
    let j: { type?: string; message?: { content?: unknown } };
    try {
      j = JSON.parse(line);
    } catch {
      continue;
    }
    const content = j?.message?.content;
    if (j.type === 'user') {
      if (typeof content === 'string') {
        if (!isNoiseUserText(content)) out.push(lineU(content));
        continue;
      }
      if (!Array.isArray(content)) continue;
      for (const p of content as Array<Record<string, unknown>>) {
        if (p.type === 'text' && typeof p.text === 'string' && !isNoiseUserText(p.text)) out.push(lineU(p.text));
        if (p.type === 'tool_result') {
          const raw = p.content;
          const t =
            typeof raw === 'string'
              ? raw
              : Array.isArray(raw)
                ? raw.map((c: Record<string, unknown>) => (c.text as string) || '').join(' ')
                : '';
          if (t) out.push(lineR(t));
        }
      }
    } else if (j.type === 'assistant' && Array.isArray(content)) {
      for (const p of content as Array<Record<string, unknown>>) {
        if (p.type === 'text' && p.text) out.push(lineA(String(p.text)));
        if (p.type === 'tool_use') out.push(lineT(String(p.name), toolBrief(p.input)));
      }
    }
  }
  return capExcerpt(out);
}

function readChunk(path: string, from: number, cap: number): { text: string; end: number } {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    let start = Math.min(Math.max(from, 0), size);
    if (size - start > cap) start = size - cap;
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    const text = buf.toString('utf-8');
    const lastNl = text.lastIndexOf('\n');
    return { text: lastNl >= 0 ? text.slice(0, lastNl) : text, end: start + (lastNl >= 0 ? lastNl + 1 : 0) };
  } finally {
    closeSync(fd);
  }
}

/**
 * CC transcript source。cursor = **字节偏移**。
 *
 * `ctxTokens` 恒 `null` —— CC 那条路的真值来自 ledger 尾(`latestCtxTokens`),
 * writer 会在 source 给不出时回落到它。这里不重算一遍:两处各算一份就是同一个数两个来源。
 */
export function ccTranscriptSource(path: string): SessionSource {
  return {
    kind: 'cc-transcript',
    read(cursor: number): Promise<SessionExcerpt> {
      const { text, end } = readChunk(path, cursor, TRANSCRIPT_CHUNK_CAP);
      return Promise.resolve({ text: excerpt(text), cursor: end, ctxTokens: null });
    },
  };
}

// ─── source ②: omd 自己的会话 ───────────────────────────────────────────────

/** `OmdSession.entries()` 的结构面(只取本模块要的两个键,不 import pi 类型)。 */
export interface OmdEntryLike {
  readonly type: string;
  readonly message?: unknown;
}

export interface OmdSessionSourceDeps {
  /** 会话条目(**append-only**,根→叶序)。 */
  entries: () => Promise<readonly OmdEntryLike[]>;
  /** 这一刻的 ctx token 真值;省略 = `null`(不伪造)。 */
  ctxTokens?: () => number | null;
}

/** 一条 omd 消息 → 摘录行(0..n 行)。omd 的块名与 CC 不同:`toolCall` / role `toolResult`。 */
function omdMessageLines(message: unknown): string[] {
  if (message === null || typeof message !== 'object') return [];
  const m = message as Record<string, unknown>;
  const role = typeof m.role === 'string' ? m.role : '';
  const content = m.content;
  const out: string[] = [];

  const textOf = (blocks: unknown): string[] => {
    if (typeof blocks === 'string') return blocks ? [blocks] : [];
    if (!Array.isArray(blocks)) return [];
    const acc: string[] = [];
    for (const block of blocks) {
      if (block === null || typeof block !== 'object') continue;
      const b = block as Record<string, unknown>;
      if (b.type === 'text' && typeof b.text === 'string' && b.text) acc.push(b.text);
    }
    return acc;
  };

  if (role === 'user') {
    for (const t of textOf(content)) if (!isNoiseUserText(t)) out.push(lineU(t));
    return out;
  }
  if (role === 'toolResult') {
    for (const t of textOf(content)) out.push(lineR(t));
    return out;
  }
  if (role === 'assistant') {
    for (const t of textOf(content)) out.push(lineA(t));
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block === null || typeof block !== 'object') continue;
        const b = block as Record<string, unknown>;
        // pi 的工具块叫 `toolCall`, 入参键是 `arguments`(部分通道回落 `input`)。
        if (b.type === 'toolCall' && typeof b.name === 'string') {
          out.push(lineT(b.name, toolBrief(b.arguments ?? b.input)));
        }
      }
    }
    return out;
  }
  return out;
}

/**
 * omd 会话 source。cursor = **已蒸馏的条目数**。
 *
 * ⚠ 为什么按 `entries()` 而不是 `messages()`:`messages()` 是**投影**,压缩之后会从最后一条
 * compaction 起截断 —— 数组会**变短**,拿它的下标当游标,一次压缩就把游标指到未来去了。
 * `entries()` 是 append-only 的原始条目,单调,才当得起游标。
 * 分支切换仍可能让条目数回退(`findEntriesOnBranch` 换了一条路径),所以游标越界时**回到 0**
 * 重读 —— 与 CC 那条 `if (start > size) start = 0` 的 transcript 轮换守卫同形。
 */
export function omdSessionSource(deps: OmdSessionSourceDeps): SessionSource {
  return {
    kind: 'omd-session',
    async read(cursor: number): Promise<SessionExcerpt> {
      const entries = await deps.entries();
      const from = cursor >= 0 && cursor <= entries.length ? cursor : 0;
      const lines: string[] = [];
      for (const e of entries.slice(from)) {
        if (e.type !== 'message') continue; // compaction / model_change 等条目不进摘录
        lines.push(...omdMessageLines(e.message));
      }
      return {
        text: capExcerpt(lines),
        cursor: entries.length,
        ctxTokens: deps.ctxTokens?.() ?? null,
      };
    },
  };
}
