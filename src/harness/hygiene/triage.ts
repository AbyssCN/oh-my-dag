/**
 * src/harness/hygiene/triage —— 分诊叶输出的 zod 钳 + fail-closed 回退 (契约 D-3 / INV-3)。
 *
 * ## 为什么四个字段全必填
 *
 * 盘上实测 (NOTES 2026-08-28 plan-critic): 明确写了 remediation 的可选字段, M3 两轮都没填,
 * 换 Opus 也没填。结论不是"提示词还不够狠", 是**别把可选字段当数据通道**。
 * 于是这里四个字段全进 zod 必填, 缺一个整条进 `fallback`, 由调用方按 D-3 降 `ticket`。
 *
 * ## 回退必须可见 (§静默坑 1)
 *
 * `fallback` 里装的是 **itemId**, 不是"出了点问题"。三种来历都会进这个数组:
 *   · 整段 JSON 解析不了 → 期望集里全部 id 进;
 *   · 单条不合 schema → 那条的 id (取得到才放, 取不到的由"期望集里缺席"这一路兜住) 进;
 *   · 条目 id 不在期望集 (模型编了一个 id) → 那个**编出来的 id** 也进, 让人看见它编了什么。
 * 分不清这三种时不许合成一个 `unknown` —— 调用方需要知道是"批量塌"还是"个别条坏"。
 *
 * **整批塌时错误原文经返回值交出去** (`parseError`), 不吞在 catch 里 (仓规 §静默坑 2):
 * 「这批 JSON 坏在哪」是下一步唯一有用的信息, 只有调用方拿得到它才谈得上修分诊提示词。
 */
import { z } from 'zod';
import { reproAllowed } from './repro-allow';

export type Disposition = 'delete' | 'keep' | 'ticket';

export interface TriageEntry {
  itemId: string;
  disposition: Disposition;
  reason: string;
  reproCmd: string;
}

/** 四字段全必填; reason 不许空串 (空 reason 等于没分诊)。 */
export const TriageEntrySchema: z.ZodType<TriageEntry> = z.object({
  itemId: z.string().min(1),
  disposition: z.enum(['delete', 'keep', 'ticket']),
  reason: z.string().min(1),
  reproCmd: z.string().min(1),
});

/** 从模型自由文本里抠出 JSON 数组 —— 认 ```json 围栏, 也认裸数组。 */
function extractJsonArray(raw: string): string | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(raw);
  const body = fenced ? fenced[1]! : raw;
  const start = body.indexOf('[');
  const end = body.lastIndexOf(']');
  if (start < 0 || end <= start) return null;
  return body.slice(start, end + 1);
}

/**
 * 分诊叶原文 → 合法条目 + 回退 id 清单。
 *
 * `entries` 只装**三重都过**的条目: schema 过 ∧ itemId ∈ 期望集 ∧ reproCmd 过白名单。
 * 其余一律进 `fallback` (调用方降 ticket)。期望集里没被任何合法条目覆盖的 id 也进 `fallback` ——
 * 「模型漏答」与「模型答坏」的下一步是同一个 (降 ticket), 但两者都不许被读成"这条没问题"。
 */
export function parseTriageBatch(
  raw: string,
  expectedIds: string[],
): { entries: TriageEntry[]; fallback: string[]; parseError?: string } {
  const expected = new Set(expectedIds);
  const fallback = new Set<string>();
  const entries: TriageEntry[] = [];

  const json = extractJsonArray(raw);
  if (json === null) {
    return { entries: [], fallback: [...expected], parseError: `原文里找不到 JSON 数组 (前 120 字: ${raw.slice(0, 120)})` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (e) {
    // fail-open 吞异常但不吞证据: 错误原文经返回值交给调用方 (它才能据此改提示词)。
    return { entries: [], fallback: [...expected], parseError: `JSON.parse 失败: ${(e as Error).message}` };
  }
  // TS 收窄用 —— `extractJsonArray` 只交出 `[` 开头的片段, 解析得出来就一定是数组,
  // 所以这条实践上到不了; 留着是为了让下面的 for-of 有类型, 不是为了防一个不会发生的场景。
  if (!Array.isArray(parsed)) {
    return { entries: [], fallback: [...expected], parseError: `顶层不是数组, 而是 ${typeof parsed}` };
  }

  for (const row of parsed) {
    const res = TriageEntrySchema.safeParse(row);
    if (!res.success) {
      // id 取得到就把它记下来 (让人看到坏在哪一条); 取不到的由下面"期望集缺席"那一路兜。
      const maybeId = (row as { itemId?: unknown } | null)?.itemId;
      if (typeof maybeId === 'string' && maybeId) fallback.add(maybeId);
      continue;
    }
    const entry = res.data;
    if (!expected.has(entry.itemId)) {
      // 模型编了一个不存在的 id —— 把它原样记进 fallback, 别静静丢掉。
      fallback.add(entry.itemId);
      continue;
    }
    if (!reproAllowed(entry.reproCmd).ok) {
      fallback.add(entry.itemId);
      continue;
    }
    entries.push(entry);
  }

  const covered = new Set(entries.map((e) => e.itemId));
  for (const id of expected) if (!covered.has(id)) fallback.add(id);
  return { entries, fallback: [...fallback] };
}

/** 回退条目 → 确定性的 `ticket` 分诊 (D-3: 回退可见, 不静默)。 */
export function fallbackToTickets(fallback: string[], why: string): TriageEntry[] {
  return fallback.map((itemId) => ({
    itemId,
    disposition: 'ticket' as const,
    reason: `分诊回退 (${why}) — 未拿到可信分诊, 按 D-3 降 ticket 交人裁`,
    reproCmd: 'git log -1',
  }));
}
