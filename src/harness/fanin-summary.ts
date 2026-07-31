/**
 * src/harness/fanin-summary —— fan-in **定向摘要** (引擎接缝, 2026-07-21)。
 *
 * 问题: executor-dag 的 fan-in 把每个前驱的**全文** `depOutputs[d]` 注入 downstream
 * (buildLeafPrompt / map·primitive 的 <upstream>)。conductor-plan 只纸面劝导 "Fan-in carries
 * SUMMARIES, not full transcripts" —— 引擎并不强制。一个前驱喂 ≥2 个 consumer 时, 其全文被
 * 复制 ≥2 份灌进各 consumer, 上下文膨胀 + 破坏 prompt-cache (各 consumer prompt 分叉)。
 *
 * 机制 (三件套, Nick 令):
 *   ① 扇出≥2 触发 —— 只对"输出被 ≥2 个下游消费"的 producer 摘要 (摘要成本 1 发, 跨 ≥2 consumer 摊薄;
 *      扇出 1 无摊薄且单 consumer 常需全文 → 不摘)。
 *   ② output_schema 默认化 —— 摘要按结构化 schema 产出; producer 声明了 output_schema 则遵之,
 *      否则用 DEFAULT_FANIN_SCHEMA (定向 = 结论 + 产物锚 + 遗留)。
 *   ③ 全文指针 —— producer 全文落盘, 摘要视图附 `[full output … → <path>]`, 带工具的 agent
 *      consumer 需细节可自 Read (inproc consumer 靠摘要本身, artifacts 字段逐字保路径/符号)。
 *
 * 本模块 = 纯逻辑 + 注入式 generate (触发判定 / 落盘 / usage 折算留在 executor-dag, 因需 plan/continuity)。
 * fail-open: 摘要器失败 / 解析失败 → 调用方回退全文注入, 绝不断 DAG。
 */
import type { GenerateFn } from './executor-dag-types';
import type { ModelUsage } from '../model/gateway';

export interface FaninSummaryConfig {
  /** 开关。省略 = true (引擎内默认 ON, 同 caveman 的行为旋钮惯例; 经 config 可关)。 */
  enabled?: boolean;
  /** producer 输出 ≥ 此字符数才摘要 (短输出摘要纯亏 — 摘要器 input 就是全文)。省略 = 1800。 */
  minChars?: number;
  /** producer 的下游 consumer ≥ 此数才摘要 (扇出闸)。省略 = 2。 */
  minFanout?: number;
  /** 摘要模型 'provider:modelId'。省略 = config.leafModel (便宜档)。 */
  model?: string;
}

export const DEFAULT_FANIN_MIN_CHARS = 1800;
export const DEFAULT_FANIN_MIN_FANOUT = 2;

export interface NormalizedFaninConfig {
  enabled: boolean;
  minChars: number;
  minFanout: number;
  model?: string;
}

/** config 归一 (省略字段填默认)。 */
export function normalizeFaninConfig(c?: FaninSummaryConfig): NormalizedFaninConfig {
  return {
    enabled: c?.enabled ?? true,
    minChars: c?.minChars ?? DEFAULT_FANIN_MIN_CHARS,
    minFanout: c?.minFanout ?? DEFAULT_FANIN_MIN_FANOUT,
    ...(c?.model ? { model: c.model } : {}),
  };
}

/**
 * 默认 fan-in 摘要 schema (output_schema 默认化的兜底)。producer 未声明 output_schema 时用。
 * 定向 = 只留下游要的结论 + **产物锚逐字保留** (路径/符号/契约名不丢, 反 happy-path: 摘要最易丢的就是
 * 下游 synthesis 必需的 "哪个文件/哪个接口") + 遗留/矛盾 (下游查缺漏)。
 */
export const DEFAULT_FANIN_SCHEMA: Record<string, unknown> = {
  tldr: 'string — 1-2 句核心结论',
  key_points: ['string — 下游据以决策的要点'],
  artifacts: ['string — 产出的文件路径 / 符号 / 接口 / 契约名 (逐字保留, 无则空数组)'],
  open_questions: ['string — 遗留问题 / 矛盾 / 未覆盖项 (无则空数组)'],
};

/**
 * 冻结 system 前缀 (字节稳定 → 跨 fan-in 节点命中 prompt-cache; 改这段 = 全 fan-in 摘要 cache 失效)。
 */
export const FANIN_SUMMARY_SYSTEM =
  "You compress one DAG node's output into a DIRECTED fan-in summary for its downstream consumers. " +
  'Keep ONLY what a downstream node needs to proceed; drop all narration. PRESERVE VERBATIM every concrete ' +
  'artifact a consumer could need: file paths, symbol/function/type names, interface or contract names, ' +
  'numbers, and identifiers — never paraphrase these. Output ONLY a single JSON object matching the given ' +
  'schema. No prose, no code fence, no commentary.';

/** 定向摘要 user prompt: producer 目标 + **下游 consumer 的目标** (定向的来源) + schema + 全文。 */
export function buildFaninSummaryPrompt(args: {
  producerGoal?: string;
  output: string;
  depGoals: string[];
  schema: Record<string, unknown>;
}): string {
  const { producerGoal, output, depGoals, schema } = args;
  const goalLine = producerGoal ? `Producer node goal: ${producerGoal}\n` : '';
  const consumers = depGoals.length
    ? `Downstream consumers will use this output to:\n${depGoals.map((g, i) => `  ${i + 1}. ${g}`).join('\n')}\n`
    : 'Downstream consumers will synthesize this with sibling outputs.\n';
  // **按不变性排序**(2026-07-31): 节点无关的指令 + schema 先, 节点专属的 goal/consumers/output 后。
  //
  // 此前 `Producer node goal:` 是第一行 —— 于是同一层 8 个兄弟的 prompt **在第一行就分叉**,
  // 能共享的只剩 system 那一段。live 实测这一层 cacheHit 全 0%, 而隔离复现时它稳定命中 128 token
  // (= system 的长度), 也就是说上限本来就只有 system 那么多。
  //
  // ⚠ 别把这条读成"省了很多钱": 实测这一层占整跑 input 的 ~1.2%, 前缀从 451 撑到 784 字符,
  //   拿回的是 ~700 token/跑。做它是因为**顺序错了**(不变的东西排在会变的后面, 白扔掉可缓存性),
  //   不是因为收益大。真正的大头在 agent leaf 那边 (84~98%)。
  //
  // schema 通常是 DEFAULT_FANIN_SCHEMA(共享);producer 自带 output_schema 时这里分叉 ——
  // 那种节点本来也不该与兄弟共享前缀, 不比今天差。
  return (
    'Summarize the producer output below, DIRECTED at exactly what the downstream consumers need. ' +
    'Return ONLY a JSON object with this shape (values are field instructions):\n' +
    `${JSON.stringify(schema)}\n\n` +
    `${goalLine}${consumers}\n` +
    `--- Producer output (${output.length} chars) ---\n${output}`
  );
}

/**
 * JSON 提取 (复用 map lister 技法: 剥 code fence → 首 '{' 到末 '}')。
 * 非对象 / parse 失败 → null (调用方全文兜底)。
 */
export function parseFaninSummary(text: string): Record<string, unknown> | null {
  try {
    const stripped = text.replace(/```(?:json)?/g, '').trim();
    const s = stripped.indexOf('{');
    const e = stripped.lastIndexOf('}');
    if (s < 0 || e <= s) return null;
    const obj = JSON.parse(stripped.slice(s, e + 1)) as unknown;
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
    return obj as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** 组装注入视图: 定向摘要 (紧凑 JSON, `<fan-in-summary>` 标记) + 全文指针 (落盘则附)。 */
export function composeFaninView(
  summary: Record<string, unknown>,
  fullPath: string | null,
  fullLen: number,
): string {
  const body = JSON.stringify(summary);
  const pointer = fullPath
    ? `\n[full output ${fullLen} chars → ${fullPath} — Read it if you need detail beyond this summary]`
    : '';
  return `<fan-in-summary>\n${body}${pointer}\n</fan-in-summary>`;
}

/**
 * 跑一次定向摘要 (注入 generate)。返回解析后的 summary JSON + usage。
 * 解析失败 → summaryJson=null (调用方全文兜底)。**本函数只做"调用+解析", 不落盘/不判触发。**
 */
export async function runFaninSummary(args: {
  generate: GenerateFn;
  model: string;
  producerGoal?: string;
  output: string;
  depGoals: string[];
  schema: Record<string, unknown>;
  /** 观测名 (哪个节点的 fan-in 摘要)。省略 = 回落通用名。 */
  traceName?: string;
  /** 这份摘要是**哪个节点的**产出压出来的 —— 观测面上挂到该节点的 span 下。 */
  traceNodeId?: string;
}): Promise<{ summaryJson: Record<string, unknown> | null; usage: ModelUsage }> {
  const { generate, model, producerGoal, output, depGoals, schema, traceName, traceNodeId } = args;
  const user = buildFaninSummaryPrompt({ producerGoal, output, depGoals, schema });
  const r = await generate({
    // 这一发此前在观测面上是**匿名**的 —— 重启后第一跑里两条叫 `omd-leaf` 的大调用就是它,
    // 而它既不是 leaf 也不是 conductor, 是 fan-in 摘要。审 prompt 时最容易被误读成"某个 leaf 很贵"。
    ...(traceName ? { traceName } : {}),
    ...(traceNodeId ? { traceNodeId } : {}),
    messages: [
      { role: 'system', content: FANIN_SUMMARY_SYSTEM },
      { role: 'user', content: user },
    ],
    model,
    thinkingLevel: 'low', // 压缩非推理: 低档省成本
  });
  return { summaryJson: parseFaninSummary(r.text), usage: r.usage };
}
