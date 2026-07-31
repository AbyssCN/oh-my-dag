/**
 * eval-tasks/grade —— 金标点判分器 (矩阵 eval 与 e2e eval 共用一把尺)。
 *
 * 两道确定性闸压住判官放水:
 *  1. 命中必须附**逐字引用**, 判官编不出原文就判不了命中;
 *  2. 引用回原文做 includes 校验 —— 判官说命中但引用不在候选正文里, 由代码驳回 (模型外可靠性)。
 */
import { z } from 'zod';
import { send } from '../../src/model/gateway';
import type { EvalTask } from './diverge-tasks';

/** 判官必须在**所有臂之外** (gpt 族不进任何 arm 池), 否则自家族判自家好。 */
export const GRADER = process.env.EVAL_GRADER || 'openai-codex:gpt-5.6-sol';

const GRADE_SCHEMA = z.object({
  findings: z.array(z.object({ id: z.coerce.string(), hit: z.coerce.boolean(), quote: z.coerce.string() })),
});

export function gradePrompt(task: EvalTask, answer: string): string {
  const list = task.seeds.map((s) => `- ${s.id}: ${s.text}`).join('\n');
  return `你是严格的评分员。下面是一道${task.kind === 'council' ? '设计题' : '挑错题'}、一份候选作答、以及一份**金标点清单**。
逐个金标点判断: 候选作答有没有**实质性地**提出这一点。

判定纪律 (严格):
- 命中 = 候选真的指出了这个问题**并且**表达出它的实质 (机制/后果/处理方向至少中一项), 措辞可不同。
- 只出现相关名词、泛泛一句"要注意 X"、或只写了这个领域的通用套话 → **不算命中**。
- 候选提了相关的一半但方向相反 (例如说了要靠 X, 而金标是"不能靠 X") → 不算命中。
- 命中必须附 quote: 从候选作答里**逐字**摘一段 (≤120 字) 作为证据; 摘不出逐字证据 → 判不命中。
- 不命中时 quote 留空字符串。宁可漏判也不要放水。

题面:
---
${task.brief}
---

候选作答:
---
${answer}
---

金标点清单:
${list}

输出 JSON: {"findings":[{"id":"<金标点 id>","hit":true/false,"quote":"<逐字证据或空>"}]}, 每个金标点恰好一条。`;
}

/** 判一份作答 → 命中的 seed id 集 + 证据。判官失败抛错, 由调用方决定跳过还是重试。 */
export async function gradeAnswer(
  task: EvalTask,
  answer: string,
  grader = GRADER,
): Promise<{ hits: Set<string>; quotes: Record<string, string> }> {
  const r = await send({
    model: grader,
    messages: [{ role: 'user', content: gradePrompt(task, answer) }],
    maxTokens: 4096,
    responseSchema: GRADE_SCHEMA,
    meta: { role: 'eval-grade' },
  });
  const parsed = r.parsed as z.infer<typeof GRADE_SCHEMA> | undefined;
  const hits = new Set<string>();
  const quotes: Record<string, string> = {};
  if (!parsed) throw new Error('grader 未结构化输出');
  const valid = new Set(task.seeds.map((s) => s.id));
  for (const f of parsed.findings) {
    if (!f.hit || !valid.has(f.id)) continue;
    const q = f.quote.trim();
    // 引用回原文校验: 取前 40 字做子串匹配 (容忍判官在尾部截断/补省略号)。
    if (q.length >= 8 && answer.includes(q.slice(0, Math.min(40, q.length)))) {
      hits.add(f.id);
      quotes[f.id] = q;
    }
  }
  return { hits, quotes };
}
