/**
 * plan/conductor-judge —— **conductor 节点内环 judge 的 prompt 与解析** (D-E, 2026-07-29)。
 *
 * 从 `executor-dag.runConductorNode` 的闭包里抽出来, 理由不是好看: **实测要打的必须是生产那一份**。
 * eval 抄一份 prompt 去测, 测的就是抄的那份 —— 而这仓已经栽过一次"两处各写一份判据早晚先漂"
 * (D-I 抽 `commandBlockReason` 时同一条)。抽成单一真源后, `scripts/eval-conductor-judge.ts`
 * 打的与线上跑的逐字相同。
 *
 * 与**外层** judge (`plan/llm-judge`) 的两处刻意不同:
 *  ① 判的是**这一个节点的 goal**, 不是整轮 run 的 goal (D-E: 不另加全局验收层, 加了要回边)。
 *  ② **把可点名的 id 明写进 prompt**。外层不写 —— 它的 id 空间就是整张图, 模型看得见;
 *     内环的 id 是内容寻址的 `parent::fp`, 不给清单模型只能猜, 猜出来的全是幽灵。
 */
import type { ThinkingLevel } from '../../runtime/types';

/** 内环 judge 的裁决 (已过幽灵过滤)。 */
export interface ConductorVerdict {
  converged: boolean;
  /** 没达成时"还差什么" —— 下一轮**重展开**拿它当输入 (环的信息通道)。 */
  reason: string;
  /** 被点名"产出不作数"的子节点 id (已剔除图中不存在的)。 */
  rejected: string[];
  /** 模型点了但图里没有的 id —— 只作观测 (幻觉率), 不进 rejected。 */
  ghosts: string[];
}

/** 一个子节点在 judge 眼里的样子。 */
export interface JudgeChildView {
  /** 内容寻址 id —— **唯一合法的点名目标** (D-B)。 */
  id: string;
  /** conductor 起的可读名 (给人看; 只作别名)。 */
  originalId: string;
  status: string;
  output: string;
}

/**
 * **judge 视图**: 与节点对下游的 `output` **刻意分开渲染**。2026-07-29 实测逼出来的两条:
 *
 *  ① **正文里的名字必须和可点名的 id 摆在一起**。此前正文写 `[send-report]`, 而可点名的是
 *     `contract::a1b2…` —— prompt 里没有任何地方把两者对上, judge 就算看出哪一步是编的也**点不出来**,
 *     只能瞎猜或干脆不点。实测三臂全部 `rejectedNodes: []`。
 *  ② **不给"3/3 成功"这种成功统计做开场白**。那是给人看的摘要, 对 judge 是很强的"都好着呢"暗示;
 *     外层那份拿 100% 的 `summarizeDagResult` 从来没有这一行。
 *
 * 形状刻意贴近 `summarizeDagResult` (外层判官在同一批语料上 100% 的那个格式) —— 贴近它是有证据的
 * 选择, 不是口味。
 */
export function renderRoundForJudge(children: readonly JudgeChildView[]): string {
  return children
    .map((c) => `### ${c.id}  (${c.originalId}) [${c.status}]\n${c.output}`)
    .join('\n\n');
}

/**
 * 内环 judge 的 prompt。
 * @param goal      这个 conductor 节点自己的 goal
 * @param roundOutput 本轮子图的 **judge 视图** (见 {@link renderRoundForJudge})
 * @param childIds  本轮子节点 id —— **唯一合法的点名空间**
 */
export function conductorJudgePrompt(goal: string, roundOutput: string, childIds: readonly string[]): string {
  return [
    '你在判一个子任务**是否已经达成**。只回一个 JSON 对象, 别的不要。',
    `目标: ${goal}`,
    '',
    '本轮各步骤的产出:',
    roundOutput.slice(0, 6000),
    '',
    `可点名的步骤 id (**逐字照抄上面 ### 后面那一串**, 只能从这里选): ${childIds.join(', ')}`,
    '',
    '形状: {"converged":boolean,"failureReason":string,"rejectedNodes":string[]}',
    '- converged: 目标真的达成了才 true。**宁可判没达成**, 多跑一轮的代价远小于谎报完成。',
    '- failureReason: 没达成时写清**还差什么**, 下一轮会拿它重新分解 (包括"某个事实没查清楚"',
    '  这种需要补一个新步骤的情况 —— 直说, 下一轮画得出来)。',
    '- rejectedNodes: 哪些步骤的**产出不作数** (编的 / 空的 / 没按要求做)。宁可多点名不可漏点名:',
    '  漏点名会让那份产出在下一轮被当成已完成复用。没有就给空数组。',
  ].join('\n');
}

/** 内环 judge 的推理档: 判"达成没有"与"怎么分解"同属大脑簇, 不该比分解还弱。 */
export const CONDUCTOR_JUDGE_THINKING: ThinkingLevel = 'high';
/** 输出预算: 700 会被推理族的 reasoning 吃光 → 空裁决 (同 llm-judge 的教训)。 */
export const CONDUCTOR_JUDGE_MAX_TOKENS = 2048;

/**
 * 解析裁决。**抠 JSON 对象**容忍围栏与前后散文 (同 parsePlan 的做法)。
 * 解析不出来 → 抛, 由调用方 fail-closed 判未收敛 (judge 挂掉不该变成"那就算过了吧")。
 */
export function parseConductorVerdict(text: string, childIds: readonly string[]): ConductorVerdict {
  const s = text.indexOf('{');
  const e = text.lastIndexOf('}');
  if (s < 0 || e <= s) throw new Error('judge 无 JSON 对象');
  const v = JSON.parse(text.slice(s, e + 1)) as {
    converged?: unknown;
    failureReason?: unknown;
    rejectedNodes?: unknown;
  };
  const known = new Set(childIds);
  const named = Array.isArray(v.rejectedNodes)
    ? v.rejectedNodes.filter((x): x is string => typeof x === 'string')
    : [];
  return {
    converged: v.converged === true,
    reason: typeof v.failureReason === 'string' ? v.failureReason : '',
    rejected: named.filter((x) => known.has(x)),
    ghosts: named.filter((x) => !known.has(x)),
  };
}
