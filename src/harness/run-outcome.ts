/**
 * src/harness/run-outcome —— **run / goal / stage 级的终止原因词表** (N5, 2026-07-31)。
 *
 * ## 为什么在 P1 之后还要有这个文件
 *
 * P1(`node-failure.ts`)把**节点**为什么没过抬成了一等字段,而**它上面那两层没动**:
 *
 *   · `GoalStage.status` 仍是 `done | failed | skipped` —— 与 P1 出手前的节点级一模一样;
 *   · run 级(`ExecutorDagResult`)压根没有一个「这次是怎么结束的」的字段。
 *
 * 代价是实测出来的。2026-07-31 第二跑 live 里 §8.4 熔断正确命中 → BLOCKED 出口,而 goal 摘要
 * 那一行印的是:
 *
 *   ```
 *   [failed] execute — 2 轮阻塞: 同一条命令已经以**逐字相同**的方式失败 2 次…
 *   ```
 *
 * **一次判定正确的 BLOCKED 被念成 `failed`。** 摘要底下另有一行「阻塞(需外部输入)」读对了,
 * 于是同一份输出里两行互相打架 —— 而上线闸 G5 的判据是「触发**并被正确读**」,差的就是这半格。
 *
 * ## 做法与 P1 同构(四条)
 *
 * ① **加一位,不拆词表**:`status` 三态一字未动(全仓的 `=== 'done'` 消费者行为不变),
 *    新增 `outcome`。粗态由细态推出,反过来不成立。
 * ② **每一格的判据是它自己的直接证据**,不许拿别的状态的补集凑。
 * ③ **「不知道」独立成格**:{@link RunOutcomeKind} 的 `unclassified`,以及 `resumable: null`。
 * ④ **两格的 `nextAction` 一样 → 它们该合并**。stage 级的「跑了但空手而归」就是这么并出来的:
 *    勘察空输出 / research 零来源 / spec 未落盘,在节点级是三格(P1 分得开),在 stage 级
 *    下一步是同一句「重跑这一步」→ 合成 `empty-result` 一格。
 *
 * ## 与 P1 词表的分工(别把两份表混着读)
 *
 * `NodeFailureKind` 回答「**一个节点**为什么没过」,这里回答「**一次运行/一个阶段**怎么结束的」。
 * 后者是前者的聚合但**不是并集** —— 见 {@link deriveRunOutcome} 里那张映射表与它的优先级:
 * 一张图里同时有 `infra-error` 和 `assert-failed` 时,run 级只念前者(止损动作以最强的那条为准)。
 *
 * 也因此这里**有 SUCCESS 那一格而 P1 没有**:P1 那张表只在 `status !== 'done'` 时才有意义,
 * 这张表描述的是**五态**(SUCCESS/STALLED/BLOCKED/EXHAUSTED/ERROR),成了也要占一格。
 */
import type { NodeFailureKind } from './node-failure';
import type { ExecutorDagResult } from './executor-dag-types';

/**
 * 一次运行 / 一个阶段**怎么结束的**。
 *
 * ⚠ 加新格之前先回答两个问题:① 它的直接证据是什么(不是"排除了别的")
 * ② 拿到它的人要做的事,跟现有哪一格都不一样吗 —— 一样就别加,归进去。
 */
export type RunOutcomeKind =
  /** 达成且被判过。goal: judge 说成了 **且** 冻结判据退出码对;run: 全部节点 `done`。 */
  | 'success'
  /** 轮数跑完而 judge 判未达标(无阻塞/无预算停/无取消)。再给几轮**可能**就成。 */
  | 'not-converged'
  /** judge 说成了、**冻结判据没过**(D-I 要抓的那种作弊达标 —— 也可能是判据本身是虚的)。 */
  | 'oracle-failed'
  /** 环判定「没有外部输入推不动」(空转 / §8.4 熔断 / 检测者喊停)。**加轮数没用。** */
  | 'blocked'
  /** 预算耗尽而停(第四条停止轴)。与 `blocked` 分开的理由是下一步不同:加预算 resume 很可能就成。 */
  | 'budget-exhausted'
  /** 被 owner 协作式叫停(D-P)。不是环的结论,是外部事件 —— 已跑完的全在盘上。 */
  | 'cancelled'
  /**
   * **五态里此前在上层空着的那一格**:引擎自己出事(阶段抛错 / 节点无结果 / 心跳停摆)。
   * 与 `not-converged` 的分界是**谁的毛病**:那格是活没干成,这格是活没能开始干。
   */
  | 'infra-error'
  /** 配置面缺件(无 agentRunner/commandRunner/researchRunner)→ 这一步压根起不来。**别重试。** */
  | 'missing-capability'
  /**
   * **`skipped` 的正当那一格**:档位/conductor 判定这一步不必跑(simple 档不产 spec、
   * conductor 判无需外部调研)。什么都不用做 —— 与 `empty-result` 分开的全部理由就在这句话。
   */
  | 'not-needed'
  /**
   * **跑了但空手而归**:勘察步空输出 / research 零来源 / spec 未落盘。
   *
   * 它与 `not-needed` 在旧的 `skipped|failed` 二选一里最容易被并掉,而两者的下一步相反:
   * 「不需要勘察」什么都不用做,「勘察跑了却什么都没找到」需要人看一眼。
   */
  | 'empty-result'
  /**
   * **「不知道」的那一格**:结束了,但没有任何生产点标注原因。
   *
   * 不是兜底垃圾桶,是可以被数出来的**缺陷指标** —— 读数板上它非零 = 引擎里还有一条
   * 收尾路径没交代自己是怎么回事。⚠ 与「字段整个缺席」(早于 2026-07-31 的记录)不是一回事。
   */
  | 'unclassified';

/**
 * **这一跑花的钱,该不该算进「每次成功要花多少」的分子**(LoopX 对照, 2026-08-05)。
 *
 * 来源是 LoopX 那条 quota 纪律:`spend-slot` 只在**验证 + 写回**之后调用,静默 skip /
 * preflight 失败 / dry-run **不消耗额度**。omd 没有额度制,它的对应物是**读数板的分母口径** ——
 * 今天 `cost_per_success` 的分子是该组**全部** run 的 token,于是一次 429、一次配置缺件、
 * 一次"这步不必跑",和一次真跑一样重。那让「每次成功的成本」同时在量引擎效率和环境噪声。
 *
 * ⚠ 这四格**不是** `nextAction` 的粗化(那条「两格下一步一样才该合并」的规矩管的是
 * {@link RunOutcomeKind} 本身)。这里问的是**另一个问题**,只有一句:
 *
 *   > 这笔消耗,是"为了达成目标而花的"吗?
 *
 * 所以 `not-needed`(什么都不用做)和 `infra-error`(修基建)下一步完全不同,在这条轴上
 * 却是同一格 —— 两者都不是"为达成目标花的钱"。细粒度的分辨仍由 `RunOutcomeKind` 保留,
 * 这一层只是它在**成本口径**上的投影。
 */
export type SpendBucket =
  /** 为达成目标而花的。**没成也算** —— 轮数用尽、判据没过、预算触顶都是引擎真在试。 */
  | 'delivery'
  /** 花了,但被**外部**挡住:再多的钱也换不来这一格的进展。单独一桶,别并进 overhead。 */
  | 'blocked'
  /** 引擎/配置/外部事件的开销:压根没起来、判定不必跑、基建出事、owner 叫停。 */
  | 'overhead'
  /** 引擎没交代自己怎么收的尾 —— **不许**并进任何一桶(并了就再也分不出来)。 */
  | 'unclassified';

export interface RunOutcomeInfo {
  /** 往 Loop Engineering §4.4 五态归到哪一格。`null` = 书上没有对应格(别硬凑)。 */
  loopState: 'SUCCESS' | 'STALLED' | 'BLOCKED' | 'EXHAUSTED' | 'ERROR' | 'UNKNOWN' | null;
  /** 见 {@link SpendBucket}。加新 outcome 格时类型会强制回答这一位 —— 那是有意的。 */
  spendBucket: SpendBucket;
  /** **判成这一格的直接证据**。当契约看:证据变了,这一格的含义就变了。 */
  evidence: string;
  /** 拿到这一格的人该做什么。两格的这一句一样 → 它们大概该合并。 */
  nextAction: string;
  /**
   * **原样 `resume`(同 runId、不改任何输入)有没有用**。`null` = 不知道。
   *
   * ⚠ 这一位问的**不是**「重试有没有用」而是「**原样**接着跑有没有用」——
   * `budget-exhausted` 要先加预算(所以是 false:原样 resume 会立刻再次撞上限),
   * `cancelled` 才是真的原样接着跑就行。这两格若共用一句话,加预算那一步就会被漏掉。
   */
  resumable: boolean | null;
}

/**
 * 词表的**唯一定义处**。摘要渲染、读数板、人,都从这里读语义,不各自在自己那边重写一份。
 */
export const RUN_OUTCOME_INFO: Record<RunOutcomeKind, RunOutcomeInfo> = {
  success: {
    spendBucket: 'delivery',
    loopState: 'SUCCESS',
    evidence: 'goal: judge 判收敛 且 冻结判据退出码符合期望;run: 全部节点 status=done;stage: 该阶段拿到了它该产的东西',
    nextAction: '收工 —— 去看产物',
    resumable: false,
  },
  'not-converged': {
    spendBucket: 'delivery',
    loopState: 'STALLED',
    evidence: '轮数用尽而 judge 判未达标(且 blocked/budgetStopped/cancelled 三者皆空)',
    nextAction: '加 maxRounds 后 resume —— 再给几轮可能就成;连续两次落这格再去看是不是任务本身没写清',
    resumable: true,
  },
  'oracle-failed': {
    spendBucket: 'delivery',
    loopState: 'STALLED',
    evidence: 'judge 判收敛,而环外冻结判据节点 status ≠ done(D-I)',
    nextAction:
      '**先人看一眼是哪一边错** —— 产物没真达标(作弊达标)还是判据本身是虚的(G4)。两种的修法相反,加轮数对哪种都不对症',
    // 不知道该归哪边之前, 原样 resume 有没有用是答不了的 —— 拍一个 false 会挡掉"判据虚但产物对"那半边。
    resumable: null,
  },
  blocked: {
    spendBucket: 'blocked',
    loopState: 'BLOCKED',
    evidence: 'LeafResult.blocked 非空(环空转 / §8.4 动作级熔断 / 图外检测者喊停)',
    nextAction: '**别加轮数** —— 判据是确定性的,再转多少轮都一样;由 owner 看一眼并给外部输入',
    resumable: false,
  },
  'budget-exhausted': {
    spendBucket: 'delivery',
    loopState: 'EXHAUSTED',
    evidence: 'LeafResult.budgetStopped 非空(预算轴触顶而停)',
    nextAction: '**先加预算**再 resume=<同一 runId> —— 原样接着跑会立刻再次撞上限',
    resumable: false,
  },
  cancelled: {
    spendBucket: 'overhead',
    // 书上五态描述的是"环自己怎么收的尾", 协作式取消是**外部事件**打断了它 —— 硬归进 EXHAUSTED
    // 会让读数板把"人叫停的"和"资源耗尽的"混成一笔账, 而那两笔账的下一步完全不同。
    loopState: null,
    evidence: 'ExecutorDagResult.cancelled 有值 / RunGoalResult.cancelled 有值',
    nextAction: 'resume=<同一 runId> 原样接着跑 —— 已跑完的节点与轮次全在盘上',
    resumable: true,
  },
  'infra-error': {
    spendBucket: 'overhead',
    loopState: 'ERROR',
    evidence: '阶段抛错 / execute 节点无结果(引擎没跑到它)/ 节点级归到 infra-error 或 stall',
    nextAction: '看栈 / 换池;连续同因 = 引擎缺陷,不是运气',
    resumable: true,
  },
  'missing-capability': {
    spendBucket: 'overhead',
    loopState: 'BLOCKED',
    evidence: '配置面缺件(无 agentRunner / commandRunner / researchRunner)',
    nextAction: '**别重试** —— 缺的是能力不是运气;补配置再跑',
    resumable: false,
  },
  'not-needed': {
    spendBucket: 'overhead',
    loopState: null,
    evidence: '档位或 conductor 判定这一步不必跑(simple 档不产 spec / conductor 判无需外部调研)',
    nextAction: '什么都不用做 —— 这不是缺口',
    resumable: false,
  },
  'empty-result': {
    spendBucket: 'delivery',
    loopState: 'STALLED',
    evidence: '这一步跑了,但产出为空(勘察空输出 / research 零来源 / spec 未落盘)',
    nextAction: '重跑这一步 / 换检索式 —— **它跑了却什么都没找到, 与「不需要」不是一回事**',
    resumable: true,
  },
  unclassified: {
    spendBucket: 'unclassified',
    loopState: 'UNKNOWN',
    evidence: '结束了,但生产点没有标注原因',
    nextAction: '**去补标注** —— 这个数非零说明引擎里还有一条没交代自己的收尾路径',
    resumable: null,
  },
};

/** 词表全序(读数板按它出分布;确定性顺序,免得每次跑出来的表行序不一样)。 */
export const RUN_OUTCOME_ORDER = Object.keys(RUN_OUTCOME_INFO) as RunOutcomeKind[];

/**
 * **节点级成因 → run 级终止原因**的映射。`null` = 这一格**不作数**(不是"归不了类"):
 *
 *   · `dep-skip` —— 级联跳过,真因在上游那个节点身上,拿它当 run 的终止原因是把因果读反了;
 *   · `subgraph-failed` —— 聚合体,它的子节点就在同一份 `results` 里且各自已归好类。
 *
 * 两者若参与聚合,一张图里每失败一个节点就会多出一串跟着它的"失败",读数板上的分布会被
 * 级联量整体拉偏 —— 那正是 D-7v2 当初把 `dep-skip` 单独成格要避免的。
 */
const NODE_TO_RUN: Record<NodeFailureKind, RunOutcomeKind | null> = {
  'assert-failed': 'not-converged',
  'gate-rejected': 'blocked',
  stall: 'infra-error',
  'empty-artifact': 'not-converged',
  'no-sources': 'not-converged',
  'missing-capability': 'missing-capability',
  'infra-error': 'infra-error',
  'dep-skip': null,
  'subgraph-failed': null,
  // 2026-08-06: 轮数用尽走 `blocked` 而**不是** `infra-error` —— 它与 `gate-rejected` 同类
  // (再试也没用, 要改的是条件本身), 与"引擎出事该看栈"正相反。此前它顶着 infra-error,
  // 而 infra-error 在 RUN_OUTCOME_SEVERITY 里排第一 → 整跑结论被一个"没轮次了"盖成"引擎坏了"。
  'rounds-exhausted': 'blocked',
  unclassified: 'unclassified',
};

/**
 * 聚合优先级:**止损动作最强的那一格赢**。
 *
 * 一张图里同时有 `infra-error`(引擎出事)与 `assert-failed`(断言没成立)时,run 级念前者 ——
 * 因为读的人下一步该去看栈,而不是去改断言。`unclassified` 垫底:它只在**没有任何一格归得上**
 * 时才成为 run 的结论,否则一个没标注的节点会把整跑的成因盖掉。
 */
const RUN_OUTCOME_SEVERITY: RunOutcomeKind[] = ['infra-error', 'blocked', 'missing-capability', 'not-converged', 'unclassified'];

/**
 * 从一张跑完的图推 run 级终止原因。**纯函数、只读入参** —— 留痕与测试共用同一份判断,
 * 不各写一遍(同一件事两处独立判断天然会漂,P1 已经为这条付过一次账)。
 *
 * 顺序是**先看外部事件,再看图内**:取消是"人打断了它",这件事优先于图里发生了什么;
 * 反过来会让一次被叫停的 run 因为半路某个节点没过而被记成 `not-converged`。
 */
export function deriveRunOutcome(result: Pick<ExecutorDagResult, 'results' | 'cancelled'>): RunOutcomeKind {
  if (result.cancelled) return 'cancelled';
  const nodes = Object.values(result.results);
  if (nodes.length > 0 && nodes.every((n) => n.status === 'done')) return 'success';
  const seen = new Set<RunOutcomeKind>();
  for (const n of nodes) {
    if (n.status === 'done') continue;
    const mapped = n.failureKind ? NODE_TO_RUN[n.failureKind] : 'unclassified';
    if (mapped) seen.add(mapped);
  }
  for (const k of RUN_OUTCOME_SEVERITY) if (seen.has(k)) return k;
  // 走到这里 = 有没过的节点, 但它们全是 dep-skip / subgraph-failed (真因在别处) 或者一张空图。
  // 空图不编 success —— "什么都没跑" 与 "全跑过了" 不是一回事。
  return 'unclassified';
}

/**
 * ## 这里**刻意没有**归一化闸(与 P1 的 `withFailureKind` 的分野)
 *
 * P1 需要那道闸,是因为 `LeafResult.failureKind` 是**可选**字段、有 18 个生产点 —— 漏标一个
 * 编译器不会响。这里两层的 `outcome` 都是**必填**(`GoalStage.outcome` / `RunGoalResult.outcome`),
 * run 级那一位则由 {@link deriveRunOutcome} 单点算出 —— **漏标在这里是编译错误**。
 *
 * 再加一道运行期闸就是同一件事两处兜底(而两处兜底必然漂,本仓已经为它付过一次账),
 * 且那道闸的分支从第一天起就够不着 —— 又一个"机制在、零消费者"。
 * ⚠ 若哪天把 `outcome` 改成可选,这道闸就得补回来:那一刻编译器不再是闸了。
 */
