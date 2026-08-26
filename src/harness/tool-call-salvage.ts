/**
 * src/harness/tool-call-salvage —— **模型不走 tool_calls 通道、把工具调用写进正文时的抢救解析**。
 *
 * ## 为什么有这个文件
 *
 * 2026-08-26 批 6 的终局根因是「MiniMax 文本假装调工具, 零真实写入」。当时的修法是桥加字节级
 * 透传道 (`be3555d1`), 修的是**我们这一侧把 tools 丢了**。但那只是两个失败模式里的一个:
 *
 *   ① 我们没把 tools 发过去 → 模型没法调          → 透传道修的是这条
 *   ② tools 发到了, 模型**自己**把调用写进正文     → **本文件修的是这条**
 *
 * 第二条在本仓此前零覆盖 (`ugrep -rn 'tool_call>' src/` 零命中)。而盘上有它存在的直接旁证:
 * `scripts/probes/m3-inproc-strip-think.ts` 记着 M3 首跑格式守 33~40%, 且 `src/model/seats.ts:312`
 * 明写 agent leaf 走 pi-agent-core 的栈、**不经** `minimax-native.ts` —— 那条路上模型的正文
 * 一个字都没被处理过。正文里真出现工具调用时, 后果不是"多几个字", 是**整个节点零产出**。
 *
 * 外部对照: iceCoder (`lbiceman/iceCoder`, 主力测试模型同为 MiniMax-M3) 的
 * `src/harness/text-format-tool-call-parsers.ts` 走的就是这条路。本文件的格式表参考它, 但
 * **两处刻意不同**, 见下面「与 iceCoder 的两处分歧」。
 *
 * ## 边界: 抢救**不是**放宽工具面
 *
 * 抢救出来的调用**必须命中已注册的工具名** (`known` 集合)。名字不认识 → 不抢救, 原文留在正文里。
 * 理由是本仓 §① 那条: 边界由引擎在工具调用那一刻机械拒。抢救若能凭空造出一个工具名, 就等于
 * 在文本层开了一道绕过工具面的门 —— 那比零产出危险得多。
 *
 * ## 与 iceCoder 的两处分歧 (都是刻意的)
 *
 * ① **未闭合尾块只报不执行。** iceCoder 会尽力解析被截断的 `<tool_call>` 尾块。我们不:
 *    被 maxTokens 砍断的调用, 参数**本身**就是截断的 —— 一次截断的 `write(path, content)`
 *    会把半个文件写上去, 而它在账本上和一次正常写入长得一模一样。宁可零产出, 不要半产出。
 *    检出仍然要留痕 (`truncated` 字段), 因为「被截断」和「压根没调」是两件事 (§NULL ≠ 0)。
 * ② **不做参数类型强转。** XML 形态的参数值天然是字符串, 而工具 schema 可能要 number/boolean。
 *    我们把字符串原样交出去, 让 schema 校验那一层去红 —— 在这里猜类型, 猜错了是静默的。
 *    JSON 形态的参数保留原生类型 (它本来就带类型信息)。
 */

import { logger } from '../logger';

/** 抢救出来的一次调用 (还没有 id —— id 由接线层按 pi 的 ToolCall 形状补)。 */
export interface SalvagedToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

/** 正文里被认出的一段区间 (剥离用)。 */
export interface TextSpan {
  start: number;
  end: number;
}

export interface SalvageParseResult {
  /** 认出来并且**可以执行**的调用 (已过 `known` 过滤, 顺序 = 正文里的出现顺序)。 */
  calls: SalvagedToolCall[];
  /** `calls` 对应的正文区间 —— 剥离只剥这些, 未闭合尾块与不认识的工具名原样留在正文里。 */
  spans: TextSpan[];
  /** 检出了未闭合的工具调用尾块 (被 maxTokens 砍断)。**不执行**, 只留痕。 */
  truncated: boolean;
  /** 认出了调用形状但工具名不在 `known` 里 —— 留痕用, 不执行。 */
  unknownNames: string[];
}

// ── 形态词表 ────────────────────────────────────────────────────────────────
// 每一条都配一个真实见过的例子。加新形态时**必须**同时加例子, 否则下一个人不知道它防的是谁。

/** `<tool_call>…</tool_call>` / `<tool-call>…</tool-call>` —— Qwen / MiniMax / GLM 系常见。 */
const XML_TOOL_CALL_RE = /<tool[_-]call>([\s\S]*?)<\/tool[_-]call>/gi;

/** `<invoke name="write">…</invoke>` —— Anthropic 风格被模型学去之后自己手写出来的形态。 */
const XML_INVOKE_RE = /<invoke\b([^>]*)>([\s\S]*?)<\/invoke>/gi;

/** `<function=write>…</function>` —— Llama / 部分 OSS 微调的形态。 */
const XML_FUNCTION_RE = /<function=([\w.-]+)>([\s\S]*?)<\/function>/gi;

/** ```` ```json {…} ``` ```` —— 最常见的"模型以为要给你贴 JSON"形态。 */
const FENCED_JSON_RE = /```(?:json|tool_call|tool|tools)?\s*\n([\s\S]*?)```/gi;

/** `<invoke>` / `<function=…>` 内部的具名参数。 */
const XML_PARAM_ATTR_RE = /<(?:parameter|arg)\s+name=["']([\w.-]+)["'][^>]*>([\s\S]*?)<\/(?:parameter|arg)>/gi;
/** `<parameter=path>…</parameter>` —— 同族的等号写法。 */
const XML_PARAM_EQ_RE = /<parameter=([\w.-]+)>([\s\S]*?)<\/parameter>/gi;
/**
 * **方括号参数** `[<task_id>bg_46rq7i]`(2026-08-26 补)。
 *
 * 来源: 对照 iceCoder 的 `text-format-tool-call-parsers.ts` 时点名的漏项之一。
 * `(?!\/)` 排掉 `[</tag>]` 那种闭合行 —— 不排的话它会被读成一个名叫 `/tag` 的参数。
 * 值域 `[^\]]*` 不跨 `]`: 方括号形态本身不支持值里带 `]`, 强行贪婪只会吃掉后面的参数。
 */
const BRACKET_PARAM_RE = /\[<(?!\/)([a-zA-Z_][\w.-]*)>([^\]]*)\]/g;
/**
 * **通道分隔符** `<]minimax[>`(2026-08-26 补)。各厂商命名不同, 形态都是 `<]token[>`。
 *
 * 它不是调用的一部分, 是通道标记。两件事都要做:
 *   ① 抢救成功时**从可见正文里剥掉** —— 否则用户会看到一串 `<]minimax[>`;
 *   ② 它也可以**当调用区的开标签**用(见 {@link CHANNEL_REGION_RE})。
 */
const CHANNEL_DELIM_RE = /<\][a-zA-Z][\w.-]*\[>/g;
/**
 * 以通道分隔符开头、以 `</tool_call>` / `</invoke>` 收尾的调用区 —— **没有**正规开标签的形态。
 * 有正规开标签时这条会与 {@link XML_TOOL_CALL_RE} 的区间重叠而被跳过(见 overlaps 判据)。
 */
const CHANNEL_REGION_RE = /<\][a-zA-Z][\w.-]*\[>([\s\S]*?)<\/(?:tool[_-]?call|invoke)>/gi;
/** `<invoke name="x">` 属性里的工具名。 */
const INVOKE_NAME_RE = /name=["']([\w.-]+)["']/i;

/** 未闭合尾块的开标签 (闭合的已被上面吃掉, 剩下的就是被砍断的)。 */
const UNCLOSED_OPEN_RE = /<(?:tool[_-]call|invoke\b|function=)/i;

/** 正文里"看起来像工具调用"的最短判据 —— 用于便宜的前置短路 (省掉全套正则)。 */
const SHAPE_HINT_RE =
  /<tool[_-]call>|<invoke\b|<function=|"(?:name|tool|function_name)"\s*:\s*"|"tool_calls"\s*:\s*\[/i;

/**
 * 便宜的前置判据: 正文里**有没有可能**藏着工具调用。
 * 恒为 `parseEmbeddedToolCalls` 的必要非充分条件 —— false 时可以放心跳过全套解析。
 */
export function containsEmbeddedToolCalls(text: string): boolean {
  return SHAPE_HINT_RE.test(text);
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/**
 * **全文件唯一的 `JSON.parse` 入口。**
 *
 * 合成一处不是洁癖: 抢救是一个**探测**流程 —— 每一个围栏块、每一个 XML 块都要试着当 JSON 读,
 * 读不通是常态而不是故障。若每处各写一个 `try/catch`, 这个文件就会凭空多出五个沉默 catch
 * (`scripts/catch-evidence-scan.ts` 的绊线会当场记账), 而它们防的是同一件事。
 *
 * `logger.debug` 是真证据不是凑数: 生产环境 debug 是空函数 (零成本), 而排查
 * 「为什么这条明明像 JSON 的块没被抢救」时, 这一行是唯一能回答的地方。
 */
function tryJson(text: string, where: string): unknown | undefined {
  try {
    return JSON.parse(text);
  } catch (err) {
    logger.debug({ where, err: String(err), head: text.slice(0, 120) }, '[tool-call-salvage] 候选块不是合法 JSON');
    return undefined;
  }
}

/**
 * 一个 JSON 值 → 调用 (认三种壳):
 *   `{name, arguments}` · `{tool, args|arguments|parameters|input}` · `{function:{name, arguments}}`
 * `arguments` 是字符串时再 parse 一层 (OpenAI 线协议就是字符串, 模型照抄很常见)。
 */
function callFromJson(value: unknown): SalvagedToolCall | null {
  const obj = asRecord(value);
  if (!obj) return null;
  const fn = asRecord(obj.function);
  const name =
    typeof obj.name === 'string' ? obj.name
    : typeof obj.tool === 'string' ? obj.tool
    : typeof obj.function_name === 'string' ? obj.function_name
    : fn && typeof fn.name === 'string' ? fn.name
    : null;
  if (!name) return null;
  const rawArgs = fn?.arguments ?? obj.arguments ?? obj.args ?? obj.parameters ?? obj.input ?? {};
  // 参数串坏了 = 这不是一次可执行的调用。**不猜**, 整条丢弃 (半个参数比没有更危险)。
  const args =
    typeof rawArgs === 'string' ? asRecord(tryJson(rawArgs, 'arguments-string')) : asRecord(rawArgs);
  if (!args) return null;
  return { name, arguments: args };
}

/** XML 块正文 → 参数表 (两种具名写法都收; 都没有则试着把整块当 JSON 读)。 */
function paramsFromXmlBody(body: string): Record<string, unknown> | null {
  const args: Record<string, unknown> = {};
  let found = false;
  for (const m of body.matchAll(XML_PARAM_ATTR_RE)) {
    args[m[1]!] = m[2]!;
    found = true;
  }
  for (const m of body.matchAll(XML_PARAM_EQ_RE)) {
    args[m[1]!] = m[2]!;
    found = true;
  }
  for (const m of body.matchAll(BRACKET_PARAM_RE)) {
    args[m[1]!] = m[2]!;
    found = true;
  }
  if (found) return args;
  const trimmed = body.trim();
  if (!trimmed.startsWith('{')) return null;
  return asRecord(tryJson(trimmed, 'xml-body'));
}

interface Candidate {
  call: SalvagedToolCall;
  span: TextSpan;
}

/**
 * 两个区间**有没有交叠**。
 *
 * ⚠ 判据从"包含"改成"交叠"(2026-08-26, 随通道分隔符一起补): 通道形态里
 * `<]minimax[><tool_call>…</tool_call>` 的通道区从分隔符起算, **起点比** `<tool_call>` 区**更早**,
 * 于是它不被包含、只与之交叠。按包含判会让同一次调用被认两遍。
 */
function overlaps(a: TextSpan, b: TextSpan): boolean {
  return a.start < b.end && b.start < a.end;
}

/** 从正文里抠出所有候选调用 (还没过 `known` 过滤)。 */
function collectCandidates(text: string): {
  candidates: Candidate[];
  consumed: TextSpan[];
  /** 通道分隔符自身的区间 —— 不是调用, 但抢救成功时要从可见正文里剥掉。 */
  noise: TextSpan[];
} {
  const candidates: Candidate[] = [];
  const consumed: TextSpan[] = [];
  const noise: TextSpan[] = [...text.matchAll(CHANNEL_DELIM_RE)].map((m) => ({
    start: m.index!,
    end: m.index! + m[0].length,
  }));

  // ① <tool_call>…</tool_call>: 内部要么是 JSON, 要么是具名参数。
  for (const m of text.matchAll(XML_TOOL_CALL_RE)) {
    const span = { start: m.index!, end: m.index! + m[0].length };
    consumed.push(span);
    const body = m[1]!.trim();
    let call = callFromJson(tryJson(body, 'tool_call-block'));
    if (!call) {
      // 具名参数形态: 名字得从 <function=…> / <name>…</name> 里找。
      const nameM = /<function=([\w.-]+)>/i.exec(body) ?? /<name>([\w.-]+)<\/name>/i.exec(body);
      const args = paramsFromXmlBody(body);
      if (nameM && args) call = { name: nameM[1]!, arguments: args };
    }
    if (call) candidates.push({ call, span });
  }

  // ② <invoke name="x">…</invoke>
  for (const m of text.matchAll(XML_INVOKE_RE)) {
    const span = { start: m.index!, end: m.index! + m[0].length };
    if (consumed.some((s) => overlaps(span, s))) continue; // 已被 ① 吃掉
    consumed.push(span);
    const nameM = INVOKE_NAME_RE.exec(m[1]!);
    const args = paramsFromXmlBody(m[2]!);
    if (nameM && args) candidates.push({ call: { name: nameM[1]!, arguments: args }, span });
  }

  // ③ <function=name>…</function>
  for (const m of text.matchAll(XML_FUNCTION_RE)) {
    const span = { start: m.index!, end: m.index! + m[0].length };
    if (consumed.some((s) => overlaps(span, s))) continue;
    consumed.push(span);
    const args = paramsFromXmlBody(m[2]!);
    if (args) candidates.push({ call: { name: m[1]!, arguments: args }, span });
  }

  // ④ ```json … ``` 围栏
  for (const m of text.matchAll(FENCED_JSON_RE)) {
    const span = { start: m.index!, end: m.index! + m[0].length };
    if (consumed.some((s) => overlaps(span, s))) continue;
    const parsed = tryJson(m[1]!.trim(), 'fenced-json');
    if (parsed === undefined) continue;
    // `{tool_calls: [...]}` 整包 / 单条 / 裸数组三种都收。
    const list =
      Array.isArray(parsed) ? parsed
      : Array.isArray(asRecord(parsed)?.tool_calls) ? (asRecord(parsed)!.tool_calls as unknown[])
      : [parsed];
    const calls = list.map(callFromJson).filter((c): c is SalvagedToolCall => c !== null);
    if (calls.length === 0) continue;
    consumed.push(span);
    for (const call of calls) candidates.push({ call, span });
  }

  // ⑤ 通道区: `<]minimax[>…</tool_call>` —— **通道分隔符当开标签**, 没有正规的 `<tool_call>` 开头。
  //    正规开标签存在时 (`<]minimax[><tool_call>…</tool_call>`), 这条的区间与 ① 的交叠 → 被跳过,
  //    于是同一次调用不会被认两遍。分隔符本身进 noise, 由调用方在抢救成功时从正文剥掉。
  for (const m of text.matchAll(CHANNEL_REGION_RE)) {
    const span = { start: m.index!, end: m.index! + m[0].length };
    if (consumed.some((s) => overlaps(span, s))) continue;
    const body = m[1]!;
    const nameM = /<function=([\w.-]+)>/i.exec(body) ?? /<name>([\w.-]+)<\/name>/i.exec(body) ?? INVOKE_NAME_RE.exec(body);
    const args = paramsFromXmlBody(body);
    if (!nameM || !args) continue;
    consumed.push(span);
    candidates.push({ call: { name: nameM[1]!, arguments: args }, span });
  }

  // ⑥ 裸 JSON: **只在整段正文就是一个 JSON 对象时**收。
  //    刻意不做"从散文里抠 JSON" —— 那会抠到模型自己在解释「我本来打算调 write」的示例上,
  //    把一段说明变成一次真实写入。整段即 JSON 时没有这个歧义。
  if (candidates.length === 0) {
    const trimmed = text.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      const parsed = tryJson(trimmed, 'bare-json');
      if (parsed !== undefined) {
        const list =
          Array.isArray(parsed) ? parsed
          : Array.isArray(asRecord(parsed)?.tool_calls) ? (asRecord(parsed)!.tool_calls as unknown[])
          : [parsed];
        const calls = list.map(callFromJson).filter((c): c is SalvagedToolCall => c !== null);
        if (calls.length > 0) {
          const span = { start: text.indexOf(trimmed), end: text.indexOf(trimmed) + trimmed.length };
          consumed.push(span);
          for (const call of calls) candidates.push({ call, span });
        }
      }
    }
  }

  return { candidates, consumed, noise };
}

/**
 * 正文 → 可执行的调用 + 剥离区间。
 *
 * @param known 已注册的工具名集合。**必传** —— 见文件头「抢救不是放宽工具面」。
 */
export function parseEmbeddedToolCalls(text: string, known: ReadonlySet<string>): SalvageParseResult {
  const { candidates, consumed, noise } = collectCandidates(text);
  const calls: SalvagedToolCall[] = [];
  const spans: TextSpan[] = [];
  const unknownNames: string[] = [];
  for (const c of candidates) {
    if (!known.has(c.call.name)) {
      if (!unknownNames.includes(c.call.name)) unknownNames.push(c.call.name);
      continue;
    }
    calls.push(c.call);
    if (!spans.some((s) => s.start === c.span.start && s.end === c.span.end)) spans.push(c.span);
  }
  // 通道分隔符只在**真抢救到了**的时候才剥。一条都没抢救到 = 这条消息我们不动它,
  // 那时把 `<]token[>` 挖掉就是在替模型改一段我们并不理解的正文。
  if (calls.length > 0) for (const n of noise) spans.push(n);
  // 未闭合尾块: 把已认出的区间挖掉之后, 剩下的正文里还有开标签 = 被砍断了。
  const rest = stripSpans(text, consumed);
  const truncated = UNCLOSED_OPEN_RE.test(rest);
  spans.sort((a, b) => a.start - b.start);
  return { calls, spans, truncated, unknownNames };
}

/** 按区间挖掉正文 (区间可无序/可重叠)。 */
export function stripSpans(text: string, spans: readonly TextSpan[]): string {
  if (spans.length === 0) return text;
  const sorted = [...spans].sort((a, b) => a.start - b.start);
  const merged: TextSpan[] = [{ ...sorted[0]! }];
  for (let i = 1; i < sorted.length; i++) {
    const cur = sorted[i]!;
    const last = merged[merged.length - 1]!;
    if (cur.start <= last.end) last.end = Math.max(last.end, cur.end);
    else merged.push({ ...cur });
  }
  let out = '';
  let cursor = 0;
  for (const s of merged) {
    out += text.slice(cursor, s.start);
    cursor = s.end;
  }
  out += text.slice(cursor);
  return out.trim();
}
