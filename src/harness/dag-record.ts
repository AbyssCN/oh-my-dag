/**
 * src/harness/dag-record —— omd DAG 运行**留痕层** (轻量持久, 治"无 node 记录/重建")。
 *
 * 把每次 runExecutorDag 的 ExecutorDagResult 落独立 SQLite (omd_dag_runs 表): plan / 拓扑层 /
 * 每 node {kind, status, deps} / token usage。→ 运行记录 + 审计 + **node 图谱可回溯重建**。
 *
 * 跟 OmdMemory (facts, Tier-1) 分开: 这是操作/审计数据, 不是认知 facts。也跟 omd PG DAG 分开:
 * 这只留**记录** (轻量), 不做 CAS/lease/多租户/跨进程 resume (那是 omd 的活)。三同心圈的中间地带。
 */
import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { omdRepoRoot } from './repo-root';
import type { ExecutorDagResult } from './executor-dag';
import type { NodeFailureKind } from './node-failure';
import { deriveRunOutcome, type RunOutcomeKind } from './run-outcome';
import type { AcceptanceProbe } from './goal/acceptance';

export interface DagRunNode {
  id: string;
  kind: string;
  status: string;
  deps: string[];
  /**
   * `executor:'command'` 节点真正跑的那条命令 (其余 kind → undefined)。
   *
   * 记它是为了让**风险分级读数**成立 (R1, 2026-07-31): 分级是 `commandRiskTier(command)` 的
   * 纯函数结果, 所以留痕层只需要存原始命令, 不存级别 —— 级别的定义以后会改, 命令不会。
   * 存派生值等于把一份会漂的东西写进历史记录里, 而历史记录的全部价值是它不漂。
   */
  command?: string;
  /**
   * §8.5 效果指标 `[总写次数, no-op 次数]`(来自 `DagNodeResult.writeCounts`)。
   * **缺席 ≠ [0,0]**: 缺席 = 这条链上没人报(inproc/command 节点, 或早于 2026-07-31 的记录);
   * `[0,0]` = 这个节点跑了但一次文件都没写。
   */
  writeCounts?: [total: number, noop: number];
  /**
   * 这个节点实际打的模型坐标 `provider:modelId`(N9, 2026-07-31)。
   *
   * 记它**只为一件事: 让钱算得出来**。`computeCost` 按坐标查价表,而留痕库的 `usage` 只有
   * token 数 —— 于是「$/goal」这条轴此前**不是没做,是没有数据源**(N9 在读数板上试维度时当场撞到)。
   * 存坐标而不是存算好的美元数,同 `command` 存原文的那条理由:价表会改,坐标不会。
   *
   * 缺席 = 这个节点没打模型(command 叶)或早于本次改动的记录。
   */
  model?: string;
  /**
   * conductor 有没有把这个子节点标成 **D-Q 图内检测者**(`detector: true`)。
   *
   * 记它是为了让「detector 使用率」变成**每次 live 白拿的读数**。今天那个数只有
   * `scripts/eval-detector-usage.ts` 量得到, 而它量的是**规划期 prompt 上标没标**;
   * 真跑上标没标此前只能靠人读日志 —— 于是 "60% 天花板在生产上兑现成 0/N" 这句话
   * 每次都要重新数一遍。同 `command`: 存原始事实, 派生的比率由读数板现算。
   */
  detector?: true;
  /**
   * 失败输出的指纹 (sha1 前 12 位; 只对**失败的 command 节点**记)。
   *
   * 存在的理由是回答一个**设计问题**而不是排障: §8.4 熔断的键是「命令 + 逐字相同的失败」,
   * 而 2026-07-31 live 显示 conductor 每轮会把同一个断言重写一遍 (单引号换双引号), 于是
   * 「同一条命令」永远凑不齐第二次 —— 熔断够不到这类空转。
   *
   * 直觉的改法是「只看输出」, 但那是**错的**: `grep -q` 失败时没有输出, 于是所有静默失败的
   * grep 会指纹成同一条 —— 两个**不同**的断言各失败一次就误熔断, 比漏报坏得多。
   *
   * 所以先不改键, 改成**量**: 记下输出指纹, 让读数板算得出「输出逐字相同但命令文本不同」
   * 有多少组 (near-miss)。那个数才决定值不值得动键 —— 今天关于"命令会变"只有 n=1。
   */
  outputHash?: string;
  /** command 节点的退出码;**负数 = 闸拒**(与普通失败后续动作相反)。见 `DagNodeResult.exitCode`。 */
  exitCode?: number;
  /**
   * **没过的成因**(P1, 2026-07-31;词表与判据在 `node-failure.ts`)。
   *
   * 为什么这一位值得进历史记录,而 `command`/`detector` 那两位刻意只存原始事实:因为它**不是
   * 派生值**。`commandRiskTier(command)` 可以事后重算,而"这个节点为什么没过"事后**算不回来**
   * —— 退出码、心跳、产物闸的结果散在运行期,记录里只剩一个 `failed`。不当场记下来就永久丢了。
   *
   * ⚠ 缺席 ≠ `'unclassified'`:缺席 = 早于 2026-07-31 的记录(**没记**);
   * `'unclassified'` = 记了但引擎没能归类(**该去补标注的缺陷**)。读数板分开念。
   */
  failureKind?: NodeFailureKind;
  /**
   * conductor 内环**实跑完的轮数**(2026-08-06)。其它 kind 缺席。
   *
   * ## 为什么它值得单独一列:⑧ 那个 0 至今分不出四件事
   *
   * 读数板 ⑧ 段的判词写着「记了的跑 ≥ N 而**轮转次数**仍 ≈ 0 → 瓶颈是环只转一圈」。
   * 而「轮转次数」今天等于 `artifactMove.transitions`,那个数是 0 时至少压着四种情况,
   * **它们的下一步各不相同**:
   *   ① 图里根本没有 conductor 节点 —— 判据**不适用**(2026-08-06 实测:54 跑里 33 跑是这种);
   *   ② 有 conductor 但 `max_rounds` 缺省 1 —— 环存在而结构上不可能转第二圈
   *      (`executor-dag` 单轮档在跨轮比较**之前**就 return 了);
   *   ③ `max_rounds > 1` 而首轮就收敛 —— 环工作正常,这条判据确实没有付费对象;
   *   ④ 进了第二圈却在比较点之前退环(§8.4 熔断 / D-Q blocked / 预算轴)。
   * ① 靠 `kind` 就分得出(回溯既有记录也成立),②③④ 要的正是这两位。
   *
   * 这是 S-19 的同一形状落在**判词的读法**上:分母有了,而「分母为什么是 0」仍然没有分母。
   *
   * ⚠ 缺席 ≠ 0 ≠ 不适用:缺席 = 非 conductor 节点 / 早于本次改动的记录 / conductor 异常退出
   *   (`settle` 没跑到);`1` = 真的只跑完一轮。读数板分开念。
   */
  rounds?: number;
  /**
   * 这个 conductor 节点 plan 上写的内环**轮数上限**(`max_rounds ?? 1`)。
   *
   * 与 `rounds` 一起才分得出上面的 ②(`maxRounds === 1`:结构上没机会)和
   * ③(`maxRounds > 1 && rounds === 1`:有机会而首轮就收敛)—— 两者的下一步相反:
   * 前者要么改缺省要么收掉检测器,后者是「检测器没有付费对象」的**正面证据**。
   *
   * 存 `1` 而不是在 plan 没写时留空:缺省 1 是引擎**真正执行**的值(`executor-dag` 那一行),
   * 不是猜的。plan 里压根没有这个 id(map 动态扇出的子节点)才缺席 —— 那种才是真不知道。
   */
  maxRounds?: number;
}
export interface DagRunRecord {
  id: string;
  createdAt: number;
  planName: string;
  nodeCount: number;
  question: string | null;
  /**
   * 引擎 runId (continuity/checkpoint 用的那个)。**一个 runId 可以有多条记录** ——
   * `dag_goal` 一次跑两段图 (`goal-contract` / `goal-execute`), 各落一条。
   * 想算「这次 goal 花了多少」就按它归组, 而不是按主键。null = 记录方没给 (老行/图外调用)。
   */
  runId: string | null;
  /**
   * **这次执行是从哪个入口进来的** (2026-08-02)。取值 = MCP 工具名:
   * `dag_run` · `dag_run_plan` · `dag_resume` · `dag_goal` · `path_deliver`。
   *
   * 为什么值得单独一列: omd 今天有**四个会真跑图的入口**, 底下是同一台引擎 (全部收敛到
   * `runExecutorDagWithPlan`), 但**账本里认不出它们** —— 于是「入口是不是太多/会不会选错」
   * 只能靠感觉答, 没有读数。这一列把它变成可量的三件事:
   *   ① 各入口实际占比 (从来没人用的入口 = 该删的那个);
   *   ② `dag_run` 与 `dag_goal` 的结果分布差异 —— 前者失败率显著高 = 该走 goal 的活走了 run,
   *      **那就是"选错入口"的证据**, 而不是引擎不行;
   *   ③ 同一入口内的成本/轮数分布 (G3 按入口分层, 否则 goal 的两段账会把 dag_run 的均值带偏)。
   *
   * ⚠ 缺席 = 早于本次改动的行 (**没记**)。**不编一个 `'unknown'`** —— 那会把"这条链没接"
   * 伪装成"跑了但认不出入口", 而前者是缺陷后者是事实 (同 `observations` / `outcome` 的那条纪律)。
   */
  entry?: string;
  /** 拓扑层 (node 图谱模式) — 可据此重建执行结构。 */
  levels: string[][];
  nodes: DagRunNode[];
  usage: { conductorIn: number; conductorOut: number; leavesIn: number; leavesOut: number; leavesCacheHit: number };
  /**
   * 图外观察者本次的产出:`{kind, nodes}` 归组统计 + **原句**(2026-07-31 立,2026-08-05 补原句)。
   *
   * 记它的直接用处很具体:这些检测器今天全是**只报不拦**,要不要升成闸、阈值取几,
   * 取决于它在真跑上多久命中一次 —— 不记下来,那个数就要靠人去读日志重数一遍。
   *
   * ⚠ **原句是 2026-08-05 补的,补的是一个真缺口**:立这一列时的理由是"全文在
   * `_loop-<nodeId>.json` 里"。而那份 journal ① 只在 `max_rounds > 1`(会请 judge)时才写,
   * 单轮档整个不存在;② **每轮覆写**。于是「不报只拦不下来的那半」——**逐条人工核对**——
   * 在最常见的形状上根本无处可查。而 `unsupported-claim` 这类判据的拨闸决定,
   * 靠的正是逐条读原句判它是不是误伤。截到 400 字符:归组统计不需要长句,人工核对够用。
   * 缺席 = 早于本次改动的记录。
   */
  observations?: { kind: string; nodes: string[]; message?: string }[];
  /**
   * 「声称 vs 引擎记录」检出器这一跑跑过没有(2026-08-05)。
   *
   * ⚠ **缺席 ≠ 零检出**:该判据只活在 conductor 内环,而 `dag_run` 那条路可以一个 conductor
   * 节点都没有 —— 检出器够不着。首次 shadow 真跑就是这种,而账本当时记成 `observations: []`,
   * 与"检查过零检出"逐字相同。按 entry 数约一半流量走这条路 → **活体基率分母会错近一倍**。
   * 三态: 缺席 = 不适用(不进分母)· findings:0 = 检查过零检出 · findings>0 = 检出。
   */
  claimCheck?: { conductor: { rounds: number; nodes: number; findings: number }; flat: { nodes: number; findings: number } };
  /**
   * 「产物没变」判据(`loop-no-artifact-change`)这一跑**判得了多少次**(2026-08-06)。
   *
   * ⚠ 与上一位是**同一条纪律的第二个实例**,而这次它藏得更深:那条判据不但要有 conductor,
   * 还要那个内环**真的转到第二圈**且两轮都有产物信号。读数板 ⑧ 段此前拿运行次数当分母,
   * 把 53 跑 0 命中读成了"活体基率 ≈ 0" —— 可真正的分母(可比较的跨轮次数)一次都没被记过。
   *
   * 三态: 缺席 = 没记(老行)· `transitions:0` = 这一跑一次跨轮比较都没发生(**够不着**)·
   * `transitions-unobserved > 0` = 真判过, 那时 `findings` 才是活体基率的分子。
   */
  artifactMove?: { transitions: number; unobserved: number; findings: number };
  /**
   * **运行时**写竞争这一跑撞得上几次、真撞了几次(2026-08-06)。
   *
   * ⚠ 与 `observations` 里那条 `write-race` **同名不同义**:那一条是 `static-lint` 跑前按
   * `output_path` 声明判死的坏 plan;这一条是真跑时两个并发 leaf 撞在同一条**谁都没声明过**的
   * 路径上。前者改图,后者要问这两个 leaf 为什么碰同一个文件 —— **下一步相反,所以分开记**。
   *
   * 三态: 缺席 = 没记(老行)· `overlaps:0` = 这一跑压根没并发 · `pairs>0` = 真有撞得上的机会。
   *
   * ⚠ `pairsInferred`/`findingsInferred`(2026-08-06 补)是**推断口径**:把「命令原文点名要写、
   * 且那个文件在本节点执行窗口内变过」的候选并进来之后的数。它们与严格那两个**不许相加也不许
   * 互相替代** —— `pairsInferred - pairs` 是只有推断才看得见的那一块(证据更弱),
   * `overlaps - pairsInferred` 才是两条判据都够不着的那部分。缺席 = 早于本次改动的行。
   */
  writeRace?: { overlaps: number; pairs: number; findings: number; pairsInferred?: number; findingsInferred?: number };
  /**
   * **这张图是怎么结束的**(N5, 2026-07-31;词表在 `run-outcome.ts`)。
   *
   * 与 `nodes[].failureKind` 的分工:那一位是**每个节点**为什么没过,这一位是**整跑**的终止原因。
   * 后者可以从前者聚合(见 `deriveRunOutcome`),但**聚合规则本身是个判断** —— 一张图里同时有
   * `infra-error` 与 `assert-failed` 时读的人该先看栈还是先改断言,是这条规则说了算的。
   * 判断当场记下,读数板才不用每次自己重发明一遍(重发明必漂)。
   *
   * ⚠ 缺席 = 早于 2026-07-31 的行(**没记**),不是 `'unclassified'`(记了但归不了类)。
   */
  outcome?: RunOutcomeKind;
  /**
   * **DAG 级 verifier 这次判了什么**(N9, 2026-07-31;⚠ 名字勘误见下)。
   *
   * 来源逐字是 `ExecutorDagResult.verification`,而那一位**只由 `config.verifier` 写**
   * (executor-dag 里 `verification = { pass: verdict.pass, … }` 那一行是唯一的写点)——
   * 也就是跑完整张图之后那一发**跨模型 review 级审查**,不是冻结判据。
   *
   * ⚠ **2026-08-05 勘误**:这段原文写的是「冻结判据这次判了什么」,并把 {@link criteria} 那条
   * 「judge 与验收命令不一致的那一格」的理由抄在了这里。两者是**两个闸**:冻结判据的读数在
   * `criteria.oracle`(goal 路径按 runId 回填),本列从来不是它。按原文去读这一列,会把
   * 「verifier 说没过」念成「验收命令没过」—— 而这两件事的下一步相反(前者去看 review 意见,
   * 后者去看验收命令)。同图鉴里「注释写对了、断言写反了」那一族:标签错在读数上是静默的。
   *
   * ⚠ 缺席 = 这次没配 verifier(`dag_run` 早期路径)或早于本次改动,**不是** `pass:false`。
   */
  verification?: { pass: boolean; reason?: string };
  /**
   * 本次跨轮**复用**了几个节点(`ExecutorDagResult.reusedNodes` 的长度)+ 各节点用的模型坐标。
   *
   * 复用数进「效率轴」:一次外层重跑里有多少节点是零 LLM 拿上轮结果接住的。
   * 模型坐标是**定价的前提** —— `computeCost` 按坐标查价表,而 `usage` 只有 token 数;
   * 不记坐标,`$/goal` 这条轴就永远算不出来(N9 试维度时当场撞到的那一格)。
   *
   * ⚠ 缺席 = 没记;`reused: 0` = 记了且这次一个都没复用。
   */
  reused?: number;
  /**
   * **两条判据各自说了什么**(N9;`RunGoalResult.criteria` 的两位,按 runId 回填)。
   *
   * 与 {@link outcome} 的分工是本条存在的**全部**理由:`outcome` 在 `judge` 为假时一律落
   * `not-converged`,**不管冻结判据过没过** —— 于是「judge 说没收敛而判据其实过了」
   * (白转了几轮) 这一格在词表上被压掉了。两个布尔存着,那一格才看得见。
   *
   * 它是 **goal 级**的:`dag_goal` 一次落两条记录 (契约段 + 执行段),两条都会被回填成同一份;
   * 读数板据此按 runId 去重再数,**不按行数** —— 按行数会把一次 goal 数成两次。
   *
   * ⚠ 缺席 = 这次不是 goal 路径 (`dag_run` 没有 judge/冻结判据两条判据) 或早于本次改动。
   */
  criteria?: { judge: boolean; oracle: boolean };
  /**
   * **这次 goal 的验收探针结论**(entry:'solve' 专列, 历史行为 'dag_goal';词表在 `goal/acceptance.ts` 的
   * `AcceptanceProbe`, 这里不重写)。存的是它的**逐字 JSON** —— 五条分支怎么判出来的、
   * 降级/跳过时的原话 `why` 全部原样落盘, 读数板按它算 G4 分母与各分支占比。
   *
   * 取值矩阵 (entry × 列值) —— 两格 NULL 语义**不同**, 读数板按 entry 念, 不猜值:
   *   `dag_goal` + 有效 JSON = 那次 goal 的探针逐字 JSON (分类证据, 进 G4 分母)。
   *   `dag_goal` + NULL      = 历史行 / 探针没跑的行 —— 结局**没记** (无回填), 不进分母。
   *   其它入口 (如 `dag_run`) + NULL = 探针对非 goal 入口**不适用**, 不是"没记"。
   *   其它入口 + 有效 JSON   = 写方状态错 (探针只该由 dag_goal 写) —— 读数板忽略这一格, 不进分母。
   *   entry 缺席 (NULL)      = 历史 / 无法归类的行, 一律不进分母。
   *
   * ⚠ `'unknown'` **永不写入** —— 把「这条链没接」伪装成「记了但认不出分支」的那一格不存在。
   *   坏 JSON / 词表外形状 (读到) = 按 NULL 读 (视为未记录), 读数不崩。
   */
  acceptanceProbe?: AcceptanceProbe;
}

export interface DagRecorder {
  /** 落一次运行, 返回这条记录的主键 (**不是** runId — 见 DagRunRecord.runId)。 */
  record(
    result: ExecutorDagResult,
    meta?: { question?: string; id?: string; now?: number; runId?: string; entry?: string; acceptanceProbe?: AcceptanceProbe },
  ): string;
  /** 取一次运行 (重建 node 图谱)。 */
  get(id: string): DagRunRecord | null;
  /** 最近 N 次运行 (默认 50)。 */
  list(limit?: number): DagRunRecord[];
  /** 同一个引擎 runId 的全部记录 (时间序; goal 两段各一条)。 */
  listByRun(runId: string): DagRunRecord[];
  /**
   * 回填**两条判据**到该 runId 的全部记录 (N9)。
   *
   * 为什么是回填而不是随 `record` 一起写: 冻结判据的结论在**整趟 goal 收尾时**才有,
   * 而 `record` 是每张图跑完就落的 —— 执行段那张图落盘时, 验收命令还没判。
   * 一次 goal 的两条记录都写同一份 (读数板按 runId 去重, 不按行数)。
   */
  updateCriteria(runId: string, criteria: { judge: boolean; oracle: boolean }): void;
  close(): void;
}

interface Row {
  id: string;
  created_at: number;
  plan_name: string;
  node_count: number;
  question: string | null;
  run_id: string | null;
  entry: string | null;
  levels: string;
  nodes: string;
  usage: string;
  observations: string | null;
  outcome: string | null;
  verification: string | null;
  claim_check: string | null;
  artifact_move: string | null;
  write_race: string | null;
  reused: number | null;
  criteria: string | null;
  acceptance_probe: string | null;
}

/** 只认 `AcceptanceProbe` 五条终局的**确切形状**; 词表外 kind / 形状不对 / JSON null → undefined (= 未记录)。 */
function parseAcceptanceProbe(raw: string): AcceptanceProbe | undefined {
  let p: unknown;
  try {
    p = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof p !== 'object' || p === null) return undefined;
  const o = p as Record<string, unknown>;
  const keys = Object.keys(o);
  switch (o.kind) {
    case 'passed-both':
      return keys.length === 1 ? { kind: 'passed-both' } : undefined;
    case 'exploratory':
      return keys.length === 1 ? { kind: 'exploratory' } : undefined;
    case 'vacuity-only':
      // why 缺席合法 (探针没原话); 在就必须是字符串, 不许是 null。
      if (keys.length === 1) return { kind: 'vacuity-only' };
      return keys.length === 2 && typeof o.why === 'string' ? { kind: 'vacuity-only', why: o.why } : undefined;
    case 'demoted':
      return keys.length === 2 && typeof o.why === 'string' ? { kind: 'demoted', why: o.why } : undefined;
    case 'skipped':
      return keys.length === 2 && typeof o.why === 'string' ? { kind: 'skipped', why: o.why } : undefined;
    default:
      return undefined;
  }
}

function rowToRecord(row: Row): DagRunRecord {
  // 探针列按**五条终局的确切形状**校验后读: 坏 JSON / 词表外 kind / 形状不对 / JSON null → undefined
  // (= 未记录) —— 一条写坏的记录不许让整张读数板崩, 也不许读出一个编造的分支。
  const probe = row.acceptance_probe ? parseAcceptanceProbe(row.acceptance_probe) : undefined;
  return {
    id: row.id,
    createdAt: row.created_at,
    planName: row.plan_name,
    nodeCount: row.node_count,
    question: row.question,
    runId: row.run_id ?? null,
    // 缺席 = 早于 2026-08-02 的行 (没记)。**不编 'unknown'** —— 见 DagRunRecord.entry 的注。
    ...(row.entry ? { entry: row.entry } : {}),
    levels: JSON.parse(row.levels),
    nodes: JSON.parse(row.nodes),
    usage: JSON.parse(row.usage),
    // 缺席 = 早于 2026-07-31 的行。**不编一个 `[]`** —— 那会把「没记」伪装成「一条观察都没有」。
    ...(row.observations ? { observations: JSON.parse(row.observations) } : {}),
    // 同上: 缺席不编一个 'unclassified' —— 「没记」与「归不了类」的结论相反。
    ...(row.outcome ? { outcome: row.outcome as RunOutcomeKind } : {}),
    // 同上 (N9): 缺席不编一个 `pass:false` —— 「没验」与「验了没过」的结论相反。
    ...(row.verification ? { verification: JSON.parse(row.verification) } : {}),
    ...(row.claim_check ? { claimCheck: JSON.parse(row.claim_check) } : {}),
    // 同上: 缺席不编一个 `transitions:0` —— 「没记」与「一次都没判得了」的下一步不同。
    ...(row.artifact_move ? { artifactMove: JSON.parse(row.artifact_move) } : {}),
    // 同上: 缺席不编一个 `overlaps:0` —— 「没记」与「这一跑没并发」的下一步不同。
    ...(row.write_race ? { writeRace: JSON.parse(row.write_race) } : {}),
    // `reused: 0` 是"记了且一个没复用", NULL 是"没记" —— 两者不许合并。
    ...(row.reused !== null ? { reused: row.reused } : {}),
    ...(row.criteria ? { criteria: JSON.parse(row.criteria) } : {}),
    // 取值矩阵见 DagRunRecord.acceptanceProbe 的注: NULL = 没记 (非 goal / 探针没跑 / 老行); 坏 JSON 已按 NULL 读。
    ...(probe ? { acceptanceProbe: probe } : {}),
  };
}

/**
 * 造一个 `ExecutorDagConfig.onComplete` 钩子, 把每张跑完的图记进留痕器。
 *
 * 存在的理由是**别让两个调用面各写一遍**: `dag_run`/`dag_run_plan` 与 `dag_goal` 都要记, 而
 * "记什么/怎么归组"这件事只该有一处定义 —— 尤其 `runId` 那一位: 记漏了, 「一次 goal 花了多少」
 * 就永远算不出来 (goal 一次落两条, 不按 runId 归组就是两笔无主的账)。
 *
 * `prev` 给了就先调它 —— 调用方自己的 onComplete 不许被留痕悄悄吃掉。
 *
 * `entry` **刻意必填** (2026-08-02): 它的用处全在「各入口的分布/对比」上, 而分布最怕的不是
 * 缺一列, 是**缺一个入口** —— 少接一处的症状是那个入口在读数里凭空消失, 与"没人用它"长得一模一样
 * (`dag_run` / `dag_run_plan` 第一版就漏过一处, 见本文件头注)。设成必填 = 新增入口时 tsc 当场红,
 * 逼你回答"这个入口叫什么", 而不是让它静默落 NULL。
 *
 * `acceptanceProbe` 只在 `entry === 'solve'` (旧 'dag_goal', 已是历史行专词) 时传入并持久化; 其它入口即使误传也会被丢弃、
 * 列留 NULL —— 见 DagRunRecord.acceptanceProbe 的取值矩阵。
 */
export function recordDagRun(
  recorder: DagRecorder,
  meta: { runId: string; entry: string; question?: string; acceptanceProbe?: AcceptanceProbe },
  prev?: (result: ExecutorDagResult) => void | Promise<void>,
): (result: ExecutorDagResult) => Promise<void> {
  return async (result) => {
    if (prev) await prev(result);
    recorder.record(result, {
      runId: meta.runId,
      entry: meta.entry,
      ...(meta.question ? { question: meta.question } : {}),
      // t7 词表迁移 (2026-08-04): goal 入口现写 'solve'; 'dag_goal' 只存在于历史行 (读侧归一), 写侧不再产生。
      ...(meta.entry === 'solve' && meta.acceptanceProbe ? { acceptanceProbe: meta.acceptanceProbe } : {}),
    });
  };
}

/**
 * 引擎读数留痕库的**唯一**位置 —— 锚在 **omd 自己的仓根**, 不随 cwd 走。
 *
 * 2026-08-05 之前是 `join(cwd, '.omd', 'dag-runs.db')`(三个调用点各写一份)。那条口径的洞:
 * omd 经 MCP 可以从**任何** repo 的 session 发跑, 于是从别的 repo 发的跑, 记录进的是**那个
 * repo** 的 `.omd/dag-runs.db`。实测: `/home/nick/repos/bluebell` 底下真有一份, 而且是老
 * schema、**连 `claim_check` 列都没有** —— 想靠"日常使用被动攒样本"时, 攒到的是一堆互相看
 * 不见的碎库, 而读数板只读其中一份。**那种缺数长得像"引擎没记"**, 是本仓最贵的一类静默失效。
 *
 * ⚠ 代价 (明写, 不是漏): 别的项目的跑也进这张表, `question` / `plan_name` 会出现别仓的任务。
 *   要按项目分开看只能靠这两列 —— 表本身不再按 repo 分区。这是 owner 2026-08-05 的取舍:
 *   这张表量的是**引擎自身**的行为 (claim_check / outcome / criteria), 不是"当前项目的工作态";
 *   后者 (runs.db / continuity / hud) 仍然 per-repo, 一个字没改。
 */
export function ledgerPath(): string {
  return join(omdRepoRoot(), '.omd', 'dag-runs.db');
}

/**
 * 造一个运行留痕器。path 默认 `ledgerPath()` (持久); ':memory:' 或注入 db = 瞬时/测试。
 */
export function createDagRecorder(opts: { path?: string; db?: Database } = {}): DagRecorder {
  const path = opts.path ?? ledgerPath();
  if (!opts.db && path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = opts.db ?? new Database(path);
  db.run('PRAGMA journal_mode = WAL');
  db.run(`
    CREATE TABLE IF NOT EXISTS omd_dag_runs (
      id         TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      plan_name  TEXT NOT NULL,
      node_count INTEGER NOT NULL,
      question   TEXT,
      run_id     TEXT,
      levels     TEXT NOT NULL,
      nodes      TEXT NOT NULL,
      usage      TEXT NOT NULL
    )
  `);
  // 就地补列: `CREATE TABLE IF NOT EXISTS` 对**已存在**的老表一个字都不改, 于是 2026-08-02 之前
  // 建过库的机器会拿着无 run_id 的表跑进 INSERT 然后崩。查 pragma 再 ALTER (老行 run_id = NULL,
  // 正是 DagRunRecord.runId 契约里说的那一格)。
  const cols = (db.query(`PRAGMA table_info(omd_dag_runs)`).all() as { name: string }[]).map((c) => c.name);
  if (!cols.includes('run_id')) db.run(`ALTER TABLE omd_dag_runs ADD COLUMN run_id TEXT`);
  // 同上: 2026-07-31 之前建的表没这一列, 老行留 NULL (= 没记, 与 '[]' 不是一回事)。
  if (!cols.includes('observations')) db.run(`ALTER TABLE omd_dag_runs ADD COLUMN observations TEXT`);
  // 同上 (N5): 2026-07-31 之前建的表没这一列, 老行留 NULL (= 没记)。
  if (!cols.includes('outcome')) db.run(`ALTER TABLE omd_dag_runs ADD COLUMN outcome TEXT`);
  // 同上 (N9): 判据轴与效率轴的数据源。老行留 NULL (= 没记)。
  if (!cols.includes('verification')) db.run(`ALTER TABLE omd_dag_runs ADD COLUMN verification TEXT`);
  if (!cols.includes('claim_check')) db.run(`ALTER TABLE omd_dag_runs ADD COLUMN claim_check TEXT`);
  // 同上 (2026-08-06): 「产物没变」判据的分母。老行留 NULL (= 没记, 不是 transitions:0)。
  if (!cols.includes('artifact_move')) db.run(`ALTER TABLE omd_dag_runs ADD COLUMN artifact_move TEXT`);
  // 同上 (2026-08-06): 运行时写竞争。老行留 NULL (= 没记, 不是 overlaps:0)。
  if (!cols.includes('write_race')) db.run(`ALTER TABLE omd_dag_runs ADD COLUMN write_race TEXT`);
  if (!cols.includes('reused')) db.run(`ALTER TABLE omd_dag_runs ADD COLUMN reused INTEGER`);
  if (!cols.includes('criteria')) db.run(`ALTER TABLE omd_dag_runs ADD COLUMN criteria TEXT`);
  // 入口轴 (2026-08-02): 2026-08-02 之前建的表没这一列, 老行留 NULL (= 没记, 不是 'unknown')。
  if (!cols.includes('entry')) db.run(`ALTER TABLE omd_dag_runs ADD COLUMN entry TEXT`);
  // 同上 (goal 验收探针): 之前建的表没这一列, 老行留 NULL (= 没记, 不是 'unknown')。
  // 只由 entry='solve' (历史行 'dag_goal') 的 recordDagRun 写入 —— 见 DagRunRecord.acceptanceProbe 的取值矩阵。
  if (!cols.includes('acceptance_probe')) db.run(`ALTER TABLE omd_dag_runs ADD COLUMN acceptance_probe TEXT`);
  db.run(`CREATE INDEX IF NOT EXISTS omd_dag_runs_run_id ON omd_dag_runs (run_id)`);
  const ins = db.query(
    `INSERT INTO omd_dag_runs (id, created_at, plan_name, node_count, question, run_id, entry, levels, nodes, usage, observations, claim_check, artifact_move, write_race, outcome, verification, reused, criteria, acceptance_probe)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const byId = db.query(`SELECT * FROM omd_dag_runs WHERE id = ?`);
  const recent = db.query(`SELECT * FROM omd_dag_runs ORDER BY created_at DESC LIMIT ?`);
  const byRun = db.query(`SELECT * FROM omd_dag_runs WHERE run_id = ? ORDER BY created_at ASC`);
  const upd = db.query(`UPDATE omd_dag_runs SET criteria = ? WHERE run_id = ?`);

  return {
    record(result, meta = {}) {
      const id = meta.id ?? crypto.randomUUID();
      const createdAt = meta.now ?? Date.now();
      // 命令从 **plan** 取而不是从 result 取: result 里没有它 (`DagNodeResult` 只记执行面),
      // 而 plan 是这次跑的那张图的原文。plan 里没有对应 id (map 动态扇出的子节点) → undefined, 不编。
      const planNodes = result.plan.nodes as Record<
        string,
        { command?: string; detector?: unknown; max_rounds?: unknown } | undefined
      >;
      const nodes: DagRunNode[] = Object.values(result.results).map((r) => {
        const cmd = planNodes[r.id]?.command;
        // 内环形状 (2026-08-06): 只对 conductor 记 —— 别的 kind 上这两位没有意义, 记了就是编。
        // `maxRounds` 从 **plan** 取 (同 command 那条): result 里没有它, 而缺省 1 是引擎真跑的值。
        // plan 里没有这个 id (map 动态扇出) → 两位都缺席, 那才是真不知道。
        const planNode = planNodes[r.id];
        const loopShape =
          r.kind === 'conductor'
            ? {
                ...(typeof r.rounds === 'number' ? { rounds: r.rounds } : {}),
                ...(planNode ? { maxRounds: typeof planNode.max_rounds === 'number' ? planNode.max_rounds : 1 } : {}),
              }
            : {};
        // 只对失败的 command 节点算 —— 成功的输出不是"零位移"的证据, 记了只是噪声。
        const outHash =
          cmd && r.status !== 'done'
            ? new Bun.CryptoHasher('sha1').update((r.output ?? '').trim()).digest('hex').slice(0, 12)
            : undefined;
        return {
          id: r.id,
          kind: r.kind,
          status: r.status,
          deps: r.deps,
          ...(typeof cmd === 'string' && cmd.trim() ? { command: cmd } : {}),
          ...(planNodes[r.id]?.detector === true ? { detector: true as const } : {}),
          ...(outHash ? { outputHash: outHash } : {}),
          ...(typeof r.exitCode === 'number' ? { exitCode: r.exitCode } : {}),
          ...(r.failureKind ? { failureKind: r.failureKind } : {}),
          ...(r.writeCounts ? { writeCounts: r.writeCounts } : {}),
          ...(r.model ? { model: r.model } : {}),
          ...loopShape,
        };
      });
      const usage = {
        conductorIn: result.usage.conductor.in,
        conductorOut: result.usage.conductor.out,
        leavesIn: result.usage.leavesIn,
        leavesOut: result.usage.leavesOut,
        leavesCacheHit: result.usage.leavesCacheHit,
      };
      ins.run(
        id,
        createdAt,
        result.plan.name,
        Object.keys(result.plan.nodes).length,
        meta.question ?? null,
        meta.runId ?? null,
        meta.entry ?? null,
        JSON.stringify(result.levels),
        JSON.stringify(nodes),
        JSON.stringify(usage),
        JSON.stringify(
          (result.observations ?? []).map((o) => ({ kind: o.kind, nodes: o.nodes, message: o.message.slice(0, 400) })),
        ),
        // 三态: NULL = 这条路没有 conductor 子图 (检出器**不适用**, 不进活体基率分母);
        // findings:0 = 检查过零检出; findings>0 = 检出。**不编一个 0** —— 那正是首次 shadow 真跑
        // 撞到的坑: `observations: []` 把"够不着"伪装成了"查过没发现"。
        result.claimCheck ? JSON.stringify(result.claimCheck) : null,
        // 三态同上一列: NULL = 没记; transitions:0 = 这一跑连一次跨轮比较都没发生 (判据够不着);
        // transitions-unobserved > 0 = 真判过, 那时 findings 才是活体基率的分子。
        result.artifactMove ? JSON.stringify(result.artifactMove) : null,
        // 三态同上: NULL = 没记; overlaps:0 = 这一跑压根没并发; pairs>0 = 真有撞得上的机会。
        result.writeRace ? JSON.stringify(result.writeRace) : null,
        // N5: run 级终止原因。**在这里算而不是让调用方传** —— 两个调用面 (dag_run / dag_goal)
        // 各算一遍就是两处会漂的独立判断, 而 `deriveRunOutcome` 是纯函数、读的就是这份 result。
        deriveRunOutcome(result),
        // N9 判据轴: 冻结判据的判词。缺席 (引擎没跑验收) → NULL, 不编一个 pass:false。
        result.verification ? JSON.stringify({ pass: result.verification.pass, reason: result.verification.reason }) : null,
        // N9 效率轴: 跨轮复用了几个节点。`reusedNodes` 缺席 = 这条链没报 → NULL 而不是 0。
        result.reusedNodes ? result.reusedNodes.length : null,
        // criteria 在整趟 goal 收尾时才有 → 这里恒 NULL, 由 updateCriteria 回填。
        null,
        // goal 验收探针 (契约): 只持久化 entry='dag_goal'; 其它入口即使误传也必须留 NULL。
        // 缺席 → NULL, 不编 'unknown'; 存一份紧凑 JSON, 绝不双编码。
        // t7 词表: 'solve' (写侧新词; 'dag_goal' 只在历史行, 写侧不再产生)。
        meta.entry === 'solve' && meta.acceptanceProbe !== undefined ? JSON.stringify(meta.acceptanceProbe) : null,
      );
      return id;
    },
    updateCriteria(runId, criteria) {
      upd.run(JSON.stringify(criteria), runId);
    },
    get(id) {
      const row = byId.get(id) as Row | null;
      return row ? rowToRecord(row) : null;
    },
    list(limit = 50) {
      return (recent.all(limit) as Row[]).map(rowToRecord);
    },
    listByRun(runId) {
      return (byRun.all(runId) as Row[]).map(rowToRecord);
    },
    close() {
      db.close();
    },
  };
}
