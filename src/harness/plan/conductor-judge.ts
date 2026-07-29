/**
 * plan/conductor-judge —— conductor 节点内环 judge 的**视图渲染 + 点名过滤**。
 *
 * ⚠ **判词本身刻意不在这里** —— 内环直接复用外层那份 `makeLlmConvergenceJudge`
 * (`plan/llm-judge.ts`)。这不是省事, 是 2026-07-29 实测逼出来的:
 *
 *   我原先另写了一份内环判词, 实测 `fabricated` 段 (节点声称"已发送/已送达"却没有任何真做过的
 *   痕迹) **30 次里 9 次判「已达成」**, 而外层那份在同一段上是 **100%**。
 *   差别不在模型 —— 在外层判词里有这么一条, 我那份没有:
 *     「结果是**真实交付物**而非捏造的数据/假执行确认 (如凭空编客户数据、"已发送/已录入" 这类
 *      没真做却声称做了的); 捏造 → converged=false」
 *   外层还多一步强制动作: 先从任务里抽出所有**明确要求**, 再逐条对照。
 *
 * 这就是"两处各写一份判据早晚先漂"的又一次现形, 只不过这次漂的是**判卷标准本身**, 而代价是
 * 三成的谎报完成。所以内环不再有自己的判词, 只保留两件真正内环特有的东西:
 *
 *  ① {@link renderRoundForJudge} —— 子图渲染成外层判词认得的 `### <id> [状态]` 形状;
 *  ② {@link splitNamedIds} —— 点名过滤。内环的 id 是内容寻址的 `parent::fp`, 模型可能照抄正文里
 *     那个好读的别名, 那些要当幽灵剔掉 (外层的 id 空间就是整张图, 没有这个问题)。
 */

/** 一个子节点在 judge 眼里的样子。 */
export interface JudgeChildView {
  /** 内容寻址 id —— **唯一合法的点名目标** (D-B)。 */
  id: string;
  /** conductor 起的可读名 (给人看; 只作别名, 点名点它无效)。 */
  originalId: string;
  status: string;
  output: string;
}

/**
 * **judge 视图**: 与节点对下游的 `output` **刻意分开渲染**。两条都是实测逼出来的:
 *
 *  ① **可点名的 id 必须就在正文里**。此前正文只写可读名 `[send-report]`, 而可点名的是
 *     `contract::a1b2…` —— prompt 里没有任何地方把两者对上, judge 就算看出哪一步是编的也
 *     **点不出来**。实测三臂全部 `rejectedNodes: []`。
 *  ② **不给"3/3 成功"这种成功统计做开场白**。那是给人看的摘要, 对 judge 是很强的"都好着呢"暗示;
 *     外层那份拿 100% 的 `summarizeDagResult` 从来没有这一行。
 *
 * 形状**逐字对齐外层判词引用的那个** (`### <id> [状态]`, 见 llm-judge.judgePrompt 的「逐字照抄」)。
 *
 *  ③ **不给可读别名**。这一条也是实测改的: 先前把 conductor 起的名当别名附在状态后
 *     (`### <id> [done]  (send-report)`), 结果模型照抄那个好读的名字去点名 → **幽灵率 12~17%**,
 *     而幽灵被过滤掉就等于漏点名, `one-failed` 段的召回全因此从 100% 掉到 50~60%。
 *     别名在这个视图里**没有任何用处** (它只给 judge 看, 人看的是节点对下游的 output),
 *     纯粹是个诱饵。删掉。
 */
export function renderRoundForJudge(children: readonly JudgeChildView[]): string {
  return children.map((c) => `### ${c.id} [${c.status}]\n${c.output}`).join('\n\n');
}

/**
 * 点名过滤: 分出**图里真有的** id 与幽灵。
 * 幽灵不进毒集 (点了不存在的 id ≡ 零信息), 但要留痕 —— 它是内环特有的幻觉面:
 * 模型很可能照抄正文里那个好读的别名而不是内容寻址 id。
 */
export function splitNamedIds(
  named: readonly string[] | undefined,
  childIds: readonly string[],
): { rejected: string[]; ghosts: string[] } {
  const known = new Set(childIds);
  const list = (named ?? []).filter((x): x is string => typeof x === 'string');
  return { rejected: list.filter((x) => known.has(x)), ghosts: list.filter((x) => !known.has(x)) };
}
