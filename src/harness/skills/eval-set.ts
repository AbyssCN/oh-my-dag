/**
 * src/harness/skills/eval-set — 从 SKILL.md description 的 Trigger/Skip 段构 trigger eval-set。
 *
 * **R6 grounded 源**: 不从 route_hit 提 query (touchSkill 不记 query, 不可 ground)。改从 description 里
 * 已有的 `Trigger: a / b / c. Skip: x / y.` 约定段抽 —— 这是 omd skill 的现成结构 (commit/verify/…
 * 全遵此式)。Trigger 段 → should_trigger:true; Skip 段 → false。
 *
 * 输出形状对齐官方 run_eval.py 实测接口 (scripts/run_eval.py:225 `eval_set: list[dict]`,
 * 每项 `item["query"]` + `item["should_trigger"]`)。
 */

/** 一条 trigger eval 样例 (run_eval.py 吃的形状)。 */
export interface TriggerEvalItem {
  query: string;
  should_trigger: boolean;
}

/** 清洗单条: 去首尾空白 + 去尾标点。括注已在 splitSegment 段级先剥 (括注内含 / 不能先 split)。 */
function cleanQuery(raw: string): string {
  return raw.replace(/[.。;；,，]+$/g, '').trim();
}

/**
 * 从一段文本 (Trigger 或 Skip 段) 切出查询词。
 * **顺序关键**: 先段级去括注 (如 "仅验证不提交 (/verify)" 的 `(/verify)` 含 `/`, 必须先剥再 split),
 * 再按 / 分, 清洗, 去空去重。
 */
function splitSegment(seg: string): string[] {
  const noParens = seg.replace(/[（(][^）)]*[）)]/g, ''); // 段级先剥括注 (中英括号)
  const out: string[] = [];
  const seen = new Set<string>();
  for (const part of noParens.split('/')) {
    const q = cleanQuery(part);
    if (q && !seen.has(q)) { seen.add(q); out.push(q); }
  }
  return out;
}

/**
 * 从 description 抽 Trigger/Skip 查询。无 Trigger 段 → positive 空 (调用方决定是否报错)。
 * Trigger 段 = "Trigger:" 之后到 "Skip:" 或结尾; Skip 段 = "Skip:" 之后到结尾。
 */
export function extractTriggerQueries(description: string): { positive: string[]; negative: string[] } {
  const trigMatch = description.match(/Trigger:\s*([\s\S]*?)(?:\s*Skip:|$)/i);
  const skipMatch = description.match(/Skip:\s*([\s\S]*)$/i);
  return {
    positive: trigMatch ? splitSegment(trigMatch[1]!) : [],
    negative: skipMatch ? splitSegment(skipMatch[1]!) : [],
  };
}

/** 组装 run_eval.py 形状的 eval-set 数组 (positive→true, negative→false)。 */
export function buildTriggerEvalSet(description: string): TriggerEvalItem[] {
  const { positive, negative } = extractTriggerQueries(description);
  return [
    ...positive.map((query) => ({ query, should_trigger: true })),
    ...negative.map((query) => ({ query, should_trigger: false })),
  ];
}
