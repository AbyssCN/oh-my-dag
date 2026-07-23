/**
 * src/harness/web/query-expand —— 检索 query 扩展 (一次廉价 flash 改写, 增益非链路)。
 *
 * 动机: 单 query 召回受术语/语言/角度限制 (中文问题搜不到英文一手源, 黑话搜不到通俗写法)。
 *   检索前加一次 flash 档改写: 让模型按问题结构自定改写数 (术语/语言/角度变体, 至少 1 条,
 *   不给上限) → 原 query + 全部改写各搜一轮 → 结果按 URL 去重 → 交给既有 source-tier 分档。
 *
 * 红线:
 *   - 扩展是**增益不是链路**: 改写调用失败 → 退回单 query, warn 不断链。
 *   - 爬取槽数不变 (成本天花板由 crawl N 定, 见 retrieveWeb): 改写只多几轮**搜索**, 不多爬。
 *   - 注入接缝: expander 是纯函数, 测试注入替身 → **永不真调模型**。
 */
import { send as defaultCallModel } from '../../model/gateway';

/** query → 改写查询列表 (不含原 query; caller 负责拼原 query 并去重)。 */
export type QueryExpander = (query: string, signal?: AbortSignal) => Promise<string[]>;

/** 改写器 system prompt (全文亦见任务报告)。 */
export const EXPAND_SYSTEM = `你是检索查询改写器。给定一个研究/检索问题, 产出一组"换个说法仍搜同一件事"的改写查询, 用于并行多轮检索、扩大召回。

规则:
1. 按问题结构自定改写数量, 至少 1 条, 上不封顶 —— 问题涉及的术语/语言/角度越多, 改写越多; 简单问题 1-2 条即可。
2. 改写维度 (按需组合, 不必每条都用):
   - 术语变体: 同义词、缩写全称、领域黑话 vs 通俗说法 (如 "LLM" ↔ "大语言模型")
   - 语言变体: 中英互译关键术语 (中文问题补一条英文检索, 反之亦然)
   - 角度变体: 换提问角度/侧重 (如 "X 怎么用" ↔ "X 最佳实践" ↔ "X 常见坑")
3. 每条改写必须仍指向原问题的同一信息需求, 不得漂移主题、不得窄化成子问题、不得夹带你猜的答案。
4. 不要复述原问题原文。
5. 只输出改写查询, 每行一条, 不加编号/项目符号/引号/解释。`;

/**
 * 从模型输出解析改写列表: 先试 JSON 数组, 否则逐行拆; 去项目符号/编号/引号,
 * 丢空行、丢与原 query 同文的行, 去重 (大小写+trim 归一)。
 */
export function parseRewrites(raw: string, original: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>([norm(original)]);
  const push = (s: string) => {
    const line = s.trim().replace(/^["'`]|["'`]$/g, '').trim();
    if (!line) return;
    const key = norm(line);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(line);
  };

  const trimmed = raw.trim();
  // JSON 数组优先 (模型偶尔无视"每行一条"输出 ["...","..."])
  if (trimmed.startsWith('[')) {
    try {
      const arr = JSON.parse(trimmed) as unknown;
      if (Array.isArray(arr)) {
        for (const item of arr) if (typeof item === 'string') push(item);
        return out;
      }
    } catch {
      /* 非合法 JSON → 落到逐行解析 */
    }
  }
  for (const rawLine of trimmed.split('\n')) {
    // 去 markdown 项目符号 / 有序编号前缀
    const line = rawLine.replace(/^\s*(?:[-*+•]|\d+[.)])\s*/, '');
    push(line);
  }
  return out;
}

function norm(s: string): string {
  return s.trim().toLowerCase();
}

/**
 * 默认改写器: 一次 flash 档模型调用。失败**照抛** (交给上层 expandQueries 兜底降级)。
 * @param opts.model 改写模型 (默认 env OMD_EXPAND_MODEL → deepseek:deepseek-v4-flash)。
 * @param opts._callModel 测试注入 (省略 = gateway send)。
 */
export function createModelQueryExpander(
  opts: { model?: string; _callModel?: typeof defaultCallModel } = {},
): QueryExpander {
  const call = opts._callModel ?? defaultCallModel;
  const model = opts.model ?? process.env.OMD_EXPAND_MODEL ?? 'deepseek:deepseek-v4-flash';
  return async (query, signal) => {
    const res = await call({
      model,
      messages: [
        { role: 'system', content: EXPAND_SYSTEM },
        { role: 'user', content: query },
      ],
      temperature: 0.3,
      signal,
    });
    return parseRewrites(res.text, query);
  };
}

/**
 * 安全扩展: 返回 [原 query, ...改写] (已去重)。expander 抛错 → warn + 退回 [原 query], 不断链。
 * expander 返回空 → 也只有原 query (无改写非错误)。
 */
export async function expandQueries(
  query: string,
  expander: QueryExpander | undefined,
  opts: { signal?: AbortSignal; onWarn?: (msg: string) => void } = {},
): Promise<string[]> {
  if (!expander) return [query];
  try {
    const rewrites = await expander(query, opts.signal);
    return [query, ...rewrites];
  } catch (e) {
    opts.onWarn?.(`query 扩展失败, 退回单 query: ${(e as Error).message}`);
    return [query];
  }
}
