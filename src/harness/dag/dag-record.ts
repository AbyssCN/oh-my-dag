/**
 * src/harness/dag/dag-record —— omd DAG 运行**留痕层** (轻量持久, 治"无 node 记录/重建")。
 *
 * 把每次 runExecutorDag 的 ExecutorDagResult 落独立 SQLite (omd_dag_runs 表): plan / 拓扑层 /
 * 每 node {kind, status, deps} / token usage。→ 运行记录 + 审计 + **node 图谱可回溯重建**。
 *
 * 跟 OmdMemory (facts, Tier-1) 分开: 这是操作/审计数据, 不是认知 facts。
 * 这只留**记录** (轻量), 不做 CAS/lease/多租户/跨进程 resume。
 *
 * ⚠ 原注释还说"也跟 omd PG DAG 分开" —— **那个东西从来没建过**(Valinor 初版计划中的一层
 * Postgres 跨轮工作流, 表 valinor_workflow_nodes 全仓零命中)。拿一个不存在的东西当参照物,
 * 读的人只会以为自己漏了什么, 故删。见 `dag/engine.ts` 头注。
 */
import { Database } from 'bun:sqlite';
import type { Trailer } from '../report/trailer';
import type { AcceptanceOutcome } from '../acceptance-run';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { omdRepoRoot } from '../repo-root';
import type { ExecutorDagResult } from './engine';
import type { NodeFailureKind } from '../node-failure';
import type { LeafGateStates } from '../leaf-runners';
import { deriveRunOutcome, type RunOutcomeKind } from '../run-outcome';
import type { AcceptanceProbe } from '../goal/acceptance-gate';
import { isSpecWrite, type SpecWrite } from '../goal/spec-write';
import type { RollbackAnchor } from '../writeset/rollback-anchor';
import type { BlameRetryLedger } from './types';
import type { LoopLedger } from '../goal/loop-ledger';

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
   * R0 派卡记账位 (2026-08-17): plan 节点的 `template` (conductor 给该节点派的 agent 模板卡名)。
   * **缺席 = 没派卡**, 不编 '' —— 与「没记」(2026-08-17 之前的历史行) 靠 created_at 分开。
   * 从 **plan** 取 (同 command 那条纪律): 派卡是规划层决策, result 里没有它。
   * 消费方: 派卡率读数 (scripts/omd-readout.ts) + pack eval 的 per-card 归因 join。
   * 背景: 467 跑零派卡的读数就是因为此前没这个位, 只能 LIKE 扫 JSON 猜。
   */
  template?: string;
  /**
   * §8.5 效果指标 `[总写次数, no-op 次数]`(来自 `DagNodeResult.writeCounts`)。
   * **缺席 ≠ [0,0]**: 缺席 = 这条链上没人报(inproc/command 节点, 或早于 2026-07-31 的记录);
   * `[0,0]` = 这个节点跑了但一次文件都没写。
   */
  writeCounts?: [total: number, noop: number];
  /**
   * 本节点三道闸的**在场态**(2026-09-02,来自 `LeafResult.gates`)。
   *
   * 记它是为了让「多少节点根本没配写闸」变成一条**查得出来的**数。在此之前 `LeafGatePosture`
   * 只随结果出 leaf + 打一行日志 —— 而散在日志里的行**复制不出**碰撞台账那次
   * (`rows=2924 · strict=0 / inferred=0`)的发现:那一条是靠查账查出来的。
   *
   * ⚠ **三态,读的时候别互相替代**(§静默坑 1):
   *   · 字段缺席            = 这条链上没人报(command / inproc 节点、老行)—— **不是**"没配闸";
   *   · `'unavailable'`     = 报了,而这道闸这次**没配**;
   *   · `'enforced'`        = 判据面在场,闸真在判(≠ "没越界",那是另一件事)。
   * 于是"没配写闸的节点占比"的分母只能取**记了这一位的**节点,拿全量当分母会把老行读成没配。
   *
   * 同 `command` 存原文那条纪律:存**原始在场态**不存派生的比率 —— 比率的口径以后会改。
   */
  gates?: LeafGateStates;
  /**
   * fan-in 产物锚账 `[路径锚总数, LLM 摘要没保住的个数]`(来自 `LeafResult.faninAnchors`)。
   * **三态**(缺席 = 没做过摘要 · `[0,0]` = 做了但全文没有锚, 尺子不适用 · `[N,k]` = 丢了 k 个)
   * 与该字段的完整理由见 `executor-dag-types.ts` 的定义处, 这里不复述。
   */
  faninAnchors?: [anchors: number, lostByLlm: number];
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
   * 这个节点在 plan 上**显式声明**的 quorum 配额 (`requires`, 2026-08-30)。
   * 词表与判定在 `dag-scheduler.ts` 的 `quorumVerdict`: `'all'` / `'any'` / 整数 K。
   *
   * 记它是为了让「quorum 用没用」变成**这个账本量得出来的数**。此前节点投影只落
   * `{id,kind,status,deps,command,template,detector,outputHash}` —— `requires` 一个字都不入账,
   * 于是从这张表量出的是 `0/N`, 而那个 0 是**尺子的 0**, 不是计划的 0
   * (同期 114 份存档 plan 里 77 份带 `requires`)。假读数已产生过一次, 见
   * `docs/plan/2026-08-30-unwired-inventory.md` §2。
   *
   * ⚠ **缺席 ≠ `'all'`**: 调度器在 plan 没写时按 `'all'` 判 (`node.requires ?? 'all'`),
   *   但那是**判定期的缺省**, 不是声明。把缺省写进历史记录 = 把「conductor 没想过 quorum」
   *   伪装成「conductor 声明了全量」, 而这一位存在的全部理由正是数前者。
   *   (与 `maxRounds` 那一位刻意相反: 那里存缺省 1 是因为要量**引擎真跑的轮数上限**;
   *   这里要量的是**声明率**, 所以只存声明。两位问的不是同一个问题。)
   *
   * 三态: 缺席 = plan 没声明 / plan 里没有这个 id (map 动态扇出) / 早于 2026-08-30 的历史行
   * (三者靠 `created_at` 与 `deps` 分, 同 `template` 那条纪律) · `'all'|'any'` = 显式配额 ·
   * 整数 K = 显式达标数。词表外的值 (LLM 写了 `'most'` 之类) 按缺席读 —— 不编一个 kind,
   * 同 `parseAcceptanceProbe`。
   *
   * ⚠ 关于 `0` 与负数: `PlanSchema` 今天**拒**它们 (`conductor-plan.ts:317` 的
   *   `z.number().int().min(1)`), 所以经校验的 plan 里不该出现。但本层**照记不误**, 不做
   *   `>= 1` 过滤 —— 留痕层存原料: 真出现了 K=0, 那是"某条路绕过了 plan 校验"的证据
   *   (plan-patch / map 扇出 / checkpoint 重载), 把它抹成"没声明"就等于把这个异常藏了。
   *   判死的活归 `static-lint.ts` 的 `impossible-quorum`, 不归账本。
   */
  requires?: 'all' | 'any' | number;
  /**
   * 节点级 token 账五位列 (C-1, 2026-08-19)。与 run 级 `usage` 聚合 (conductorIn/Out +
   * leavesIn/Out/CacheHit) 分开: 那一位是**全图聚合**, 这一组是**每节点原值**。
   *
   * **2026-08-31 (G4) 之后** (本契约生效节点): 每行 tokensIn = 该节点**自身** generate
   *   调用, 不含子图/子叶份额 (子叶份额归 run 级 leavesIn, 与 conductor 节点行无关);
   *   ∑全行 tokensIn === conductorIn + leavesIn (单轮 run 上逐位相等)。
   * **2026-08-31 之前** (历史行): conductor 节点行 tokensIn = 自身 + 子图子叶份额,
   *   execute 行 leavesIn 可为 0 (子叶烧的 token 全部记在父 conductor 节点里)。这条病
   *   已在 `engine.ts` 的 conductor 子图展开 + map 展开里修掉, 老行原样保留 (不做
   *   历史数据迁移, 写死进注释不算 bug)。
   * **允许的差 = 跨轮/escalation 累计**: 行级 (dag_run 行) = 全轮累计 (run 多次 escalation
   *   时把每轮 conductor generate 都算进 conductorIn), 节点级 (nodes 数组) = 末轮
   *   (`engine.ts` 跨轮 `_nodeLastSettled` 的覆盖规则); 其它差全部来自跨层归属错,
   *   一律按 INV-1 / INV-2 修引擎侧。
   *
   * 存在理由是**事后还原不回来**: 节点级数据只能当场从 `LeafResult.usage` 摘; 它不进入
   * 全图聚合 (那是 sum), 而 sum 一旦写入磁盘就拆不回"哪几个节点贡献了大头" —— 而这正是
   * 留痕层该有的颗粒度 (N9 同族: 存原值, 派生的事读数板现算)。
   *
   * 五列同源同义, 共享一条**三态纪律** (INV-1):
   *   · 数字 = 真值 (含 0; "这个节点用了 0 个 input token" 是合法观察);
   *   · `null` = 来源报 null/缺席 (写 NULL 到 DB, **不许**编 0);
   *   · 整个字段缺席 = 早于本次改动的行 / 来源链没接 (老行 NULL)。
   *
   * ⚠ **0 与 NULL 严禁互换** (INV-1): 一条 inproc leaf 真没用过模型时 in=0 是事实; 而
   *   `cacheHit` 在 provider 不报时是 unknown, 写成 0 会把"没报"读成"零命中", 然后被算进
   *   命中率当分母。
   *
   * 来源 (C-1, 写入函数见 `record()` 的构造处):
   *   · `tokensIn` / `tokensOut`: `LeafResult.usage.in/out` (ModelUsage 必填, 几乎总有)。
   *   · `cacheHitTokens`: `LeafResult.usage.cacheHit` (ModelUsage 可选, provider 不报则 NULL)。
   *   · `durationMs` / `turns`: 引擎 settle 时写 (engine.ts C-1 段, `nodeStartedAt` 墙钟 / conductor rounds);
   *     拿不到 (早退分支 / 非 conductor) 写 NULL, 不留 0 当占位。(2026-09-03 核: 此前注释说「源头没接」已过时。)
   */
  tokensIn?: number | null;
  tokensOut?: number | null;
  cacheHitTokens?: number | null;
  durationMs?: number | null;
  turns?: number | null;
  /**
   * R-1 (2026-09-03): agent leaf 的工具调用次数与 **LLM 调用次数** (来源 LeafResult.toolCalls / llmCalls)。
   * null = 该节点没报 (非 agent 叶 / 老 runner / 老行), **绝不** `?? 0`。`llmCalls` 是「M3 调用/题」按
   * conductor / worker 分解的唯一引擎侧来源 (桥日志一文件一请求只能按批算)。读侧: omd-readout ⑲ 段。
   */
  toolCalls?: number | null;
  llmCalls?: number | null;
  /**
   * R-1 第 3 步 (2026-09-03, D-18): agent 叶实际用的 thinking 档与通道 (runner 回报)。
   * `null` = 派了 agent 叶但 runner 没报 (旧 runner / 替身); **缺席** = 非 agent 叶。两态不许互换 (§静默坑 1)。
   */
  thinking?: { level: 'off' | 'low' | 'medium' | 'high' | 'xhigh'; channel: 'pi' | 'sdk' } | null;
  /**
   * ⑥(c) injectedTokens (2026-08-19): 语义 ⊆ tokensIn, 标记**注入**部分 token
   * (来自预置上下文 / prompt cache / 模板 / 工具结果) 与自然生成的比例。Per-node。
   *
   * ⚠ 当前来源链未接通 (引擎采集片独占写点): 读到一律 `null`, 老行也 `null` (INV-1)。
   *   未来采集片接上后, 留痕层读侧不需要再动 —— 本字段已在 `r` 上 typeof === 'number'
   *   判一下就接住。
   */
  injectedTokens?: number | null;
  /**
   * **引擎外层轮号**(2026-08-21, C-0): 该节点落在引擎外层的第几轮 (跨轮身份)。
   * 真源 = `engine.ts` settle 处的 `currentEngineRound`。缺席 = 早于本次改动的节点 / 链未接。
   * 三态纪律同 C-1 五位列: 数字 / null / 缺席 必须分开念。
   */
  dagRound?: number | null;
  /**
   * **早轮同 id 节点被本轮覆盖时被落上的轮号**(2026-08-21, C-0 / INV-0-1)。
   *
   * 引擎在 settle 时给早轮那条 LeafResult 上写 `overriddenBy = currentEngineRound`;
   * 末轮那条 LeafResult 此位为 null (最后一轮不算被覆盖)。读数板用 `> 0` 判定覆盖
   * (报告.ts `computeWaste`),末轮 0 与 undefined 都不算浪费。
   *
   * ⚠ 0 不会从此处写出 (引擎落的就是 `currentEngineRound`, 起始 1 永远 ≥ 1);
   *   但**读侧**必须接受 0 是「存在但未被覆盖」的合法值。
   */
  overriddenBy?: number | null;
  /**
   * **节点级 self_check 自修环的落账** (P1 C-4, 2026-08-21)。真源 = `LeafResult.selfRepair`
   * (切片 3 在 agent-leaf 写, 引擎在 settle 透传, 见 dag/types.ts)。
   *
   * 三态严格区分 (INV-4-1, 与切片 1 的 INV-0-3 同一条根):
   *   - **整个字段缺席** = 该节点没有 self_check (旁路, INV-1-2) —「这条路不适用」;
   *   - `null` = self_check 存在但**被截断** (SDK 通道, INV-2-1) —「路在但截断」;
   *   - `{rounds, oracleExit, convergedAt}` = self_check 真的跑了 —
   *     `rounds` = 注了几次 follow-up; `oracleExit.length ∈ {rounds, rounds + 1}` (**INV-4-2**) ——
   *     差 1 = 跑了收尾 probe (收敛/闸拒), 差 0 = 环被轮数上限/零进展在 probe **之前**停掉,
   *     那一次 probe **不存在**, 不是「跑了没记上」(静默坑 1);
   *     `convergedAt !== null` ⟹ 末项 `=== expect_exit` (**INV-4-3**, **单向**不是充要 ——
   *     配了 `expect_output` 时退出码对而输出没匹配上, 末项 `=== expect_exit` 但 convergedAt 仍 `null`)。
   *     ⚠ 2026-09-02 按探针实测修正措辞 (此前写「=== rounds + 1」与「⟺」, 都比实装严);
   *     **实装未动**。真源 = `agent-leaf.ts` 的 `SelfRepairLedger`。
   *
   * 为什么 `null` 与 `{rounds: 0, …}` 必须**分开**: 前者是「路在但没听见」(下一步 = 看 SDK
   * 通道是否该重开), 后者是「判据一次就绿」(下一步 = 看判据强度是否合理) — 两个不同的下一步
   * 念同一句话会读错成其中之一, 而本字段**正是**为这两条不同的下一步而生的 (见 `zero-shot-success`
   * 与 `sdk-channel-mute` 这两条潜在的读数)。
   *
   * 三态在 record() 里靠 `r.selfRepair !== undefined` 严格守住: undefined → 不写键 (JSON 化后缺席),
   * null → 写 null (JSON 化后是字面量 null), 对象 → 原样写 — 任何 `?? 0` / `?? null` 都把这格抹掉。
   */
  selfRepair?: { rounds: number; oracleExit: number[]; convergedAt: number | null } | null;
  /**
   * **`run_acceptance` 台账**(P3 S2, 2026-09-02)。真源 = `LeafResult.acceptance`;三态守法与 `selfRepair`
   * 逐字同款 (缺席 / null / 对象), record() 靠 `!== undefined` 守。不加列: 节点级字段写在 `nodes` JSON 里。
   */
  acceptance?: { ran: boolean; rounds: number; last: AcceptanceOutcome | null } | null;
  /** P3 S3: 尾块三态 (缺席 / null=解析失败 / 对象), 真源 `LeafResult.selfReport`, record() 靠 `!== undefined` 守。 */
  selfReport?: (Trailer & { self_report: 'leaf' | 'missing' }) | null;
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
   * **本节点因预算拒派/环预算停而失败的原因** (P2e review-fix, 2026-09-02;词表见
   * `LeafResult.budgetStopped`, types.ts)。与 `failureKind` 分开的理由同它: 事后算不回来 ——
   * 一个被预算拒派的节点在盘上此前与任何别的 `failed` 节点没有区别, 契约声称"可 join
   * dag-runs.db 的节点派发记录"落了空 (哪儿都不落)。
   *
   * ⚠ 缺席 = 没被拒派 (真正跑过或不是预算成因的失败), **绝不**补一个空串/false —— 那正是把
   * "没被拒派"与"拒派了但没记"抹平。
   */
  budgetStopped?: string;
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
  /**
   * 这个节点这一跑是**被复用**的(D-21 跨轮复用:零 LLM 拿上轮结果接住),2026-08-06。
   *
   * ## 为什么非记不可:不记就只能靠推,而推的前提是假的
   *
   * 留痕层此前只存 run 级的 `reused` **计数**,节点面一个字都没有。读数板于是"按可证语义推":
   * 「节点在 plan 里、**不在执行结果里**、且更早跑过 → 那是复用」。
   * **而那个前提不成立** —— 复用节点**就在结果里**(引擎给它 `skipped: true` 并照常写进
   * `results`)。于是那条推断**恒返空集**,读数板印出「复用率 **0.0%**」和四格
   * `reused_success **0**`,而同一批记录里 32 条声明过复用、共 ~123 个节点。
   *
   * **那是个假零, 而且它读起来像"复用根本没在工作"** —— 与 ⑩ 段按 run 级计数算的
   * 21.9% 直接打架(同一页两个数,S-19 那一族)。
   *
   * ⚠ 缺席 ≠ `false`:缺席 = 早于本次改动的记录(那些行**推不出来也不许当 0**);
   *   `true` = 这一跑确实复用了它。
   */
  reused?: true;
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
  claimCheck?: { conductor: { rounds: number; nodes: number; findings: number }; flat: { nodes: number; findings: number }; trailer?: { nodes: number; findings: number } };
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
   * **这次跑坏了回得去吗**(D1, 2026-08-06)—— 起跑那一刻的 git 状态。
   *
   * 记它是为了让「从脏树起跑的比例」变成读数。D-AB 说「范围内写」可以放手是因为 git 就是
   * rollback,而 R2 的隔离档当时默认关着、只挂在一个入口上、**实测一次都没被用过** ——
   * 所以那句话的真实条件是「起跑时树干净」,而这一位此前没人记,于是那个比例根本算不出来。
   *
   * **这一列已经把那个比例算出来了**(2026-08-25 实测本机库):604 行里 546 带锚 ——
   * `dirty-tracked` 415 · `dirty-untracked` 80 · `clean` 49 · `not-a-repo` 2,九成从脏树起跑。
   * 那是 #253 (MCP 写型入口默认落隔离 worktree) 的实测依据之一;隔离档变默认之后这一列
   * 照记不误 —— head 档只是从默认变 opt-in,没有消失,而人一直在主树上写。
   *
   * ⚠ 五态别压平:`clean` / `dirty-tracked`(**没有回滚对象**)/ `dirty-untracked`(半个)/
   *   `not-a-repo` / `unknown`(查不了,**不是干净**)。缺席 = 早于本次改动的行。
   */
  rollback?: RollbackAnchor;
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
   * **这次 verifier 打回时,重修半径到底有多大**(2026-08-28)。
   *
   * 逐字来源 `ExecutorDagResult.blameRetry`(`engine.ts` 的 `blameRetry = {…}` 是唯一写点)。
   * 它是**为一个具体决定造的读数**,不是通用留痕:外环今天该往「节点处验收」(缩小白烧)还是
   * 「内容寻址的下游失效」(缩小重修半径)投,取决于两个数 ——
   *   · `closureSize / blameSize` = 闭包放大倍数。≈1 说明重修半径本来就小,再优化它没有收益;
   *   · `blameSize === 0` 的占比 = blame 围栏解析失败率(fail-open 到整轮重跑的频率)。
   * 这两个数**在这一列存在之前一个都读不到**:`BlameRetryLedger` 早就算出来了,只活在返回值里,
   * run 记录库三个全空,日志里也只有源码回声。算了不落盘 = 没算。
   *
   * ⚠ 缺席 = **这一跑没被 verifier 打回过**(或没配 verifier / 老行),不是「打回了但半径是 0」。
   *   `blameSize: 0` 才是「打回了且围栏没解析出来 ⇒ 走整轮」—— 两者的下一步相反
   *   (前者什么都不用做,后者要去修围栏协议),不许合并。
   */
  blameRetry?: BlameRetryLedger;
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
   *
   * `oracleInconclusive` (P2b-runtime, 2026-09-02, 可选): `oracle` 恒为 `false` 时的一个
   * 附加区分位 —— true = 那个 false 是"判据命令自己没给出判词" (harness-inconclusive),
   * 不是"命令给出了红判词"。零新列: 复用这个既有的 JSON 列, 不新开表结构。
   */
  criteria?: { judge: boolean; oracle: boolean; oracleInconclusive?: boolean };
  /** R-1 (2026-09-03): 编排循环父行的读数 (见 goal/loop-ledger.ts)。缺席 = NULL = 没走循环 / 老记录 / 子 run 行。 */
  loop?: LoopLedger;
  /**
   * **这次 goal 的验收探针结论**(entry:'solve' 专列, 历史行为 'dag_goal';词表在 `goal/acceptance.ts` 的
   * `AcceptanceProbe`, 这里不重写)。存的是它的**逐字 JSON** —— 五条分支怎么判出来的、
   * 降级/跳过时的原话 `why` 全部原样写入磁盘, 读数板按它算 G4 分母与各分支占比。
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
  /**
   * **这一跑的契约段有没有产出 spec 文件** (#209, entry:'solve' 专列; 词表在 `goal/spec-write.ts`)。
   *
   * 存在的理由是**事后量不出来**: 隔离档跑完 worktree 就被清, 分支合进 main 之后
   * `main..omd/run/<id>` 的新增也归零 —— 两个信号同时消失, 而扫基座树看到的是本来就有的
   * 145 份 `docs/plan/*.md`。这一位由 run-goal 在契约段收尾那一刻产出 (`onContract`),
   * **执行期事实**, 与盘上现在还在不在无关。
   *
   * 取值矩阵 (entry × 列值) —— 三格 NULL 语义不同:
   *   `solve` + 有效 JSON = 那一跑的逐字裁决 (`wrote` / `missing` / `not-needed`)。
   *   `solve` + NULL      = 历史行 / 契约段没走到记账点 (回调抛错) —— **没记**, 不进分母。
   *   其它入口 + NULL     = 对非 goal 入口**不适用** (`run` 没有契约段这个概念)。
   *   其它入口 + 有效 JSON = 写方状态错 (只该由 solve 写) —— 读数板忽略这一格。
   *
   * ⚠ 三值不是布尔 (判据 ②): 「无 spec」(契约段跑了空手而归, 要人看一眼) 与
   *   「不跑契约段」(simple 档 / 缺 agentRunner, 什么都不用做) 的下一步相反。
   *   坏 JSON / 词表外形状 = 按 NULL 读 (`isSpecWrite` 把关), 不编一个 kind。
   */
  specWrite?: SpecWrite;
  /** SH-1 图式卡 id (`shape_id` 列)。读侧 `rowToRecord` 早就在写这个键, 类型此前缺席; 缺席 = 老行 / 没声明。 */
  shapeId?: string;
}

export interface DagRecorder {
  /** 落一次运行, 返回这条记录的主键 (**不是** runId — 见 DagRunRecord.runId)。 */
  record(
    result: ExecutorDagResult,
    meta?: { question?: string; id?: string; now?: number; runId?: string; entry?: string; acceptanceProbe?: AcceptanceProbe; specWrite?: SpecWrite },
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
   * 而 `record` 是每张图跑完就落的 —— 执行段那张图写入磁盘时, 验收命令还没判。
   * 一次 goal 的两条记录都写同一份 (读数板按 runId 去重, 不按行数)。
   */
  updateCriteria(runId: string, criteria: { judge: boolean; oracle: boolean; oracleInconclusive?: boolean }): void;
  /**
   * 回填 spec 写入磁盘裁决到该 runId 的**已有**记录 (#209)。
   *
   * 为什么既回填又随 `record` 走: 一次 solve 落两条记录 (契约段图 + 执行段图), 而这一位在
   * **契约段那张图已经写入磁盘之后**才算得出来 —— 只走 record 的话契约段那行恒 NULL, 而 NULL 在
   * 这张表里是"没记", 会被读数板念成缺数。回填补前一行, `record` 的 meta 管后一行, 两行同值。
   */
  updateSpecWrite(runId: string, specWrite: SpecWrite): void;
  /**
   * R-1 (2026-09-03): 回填编排循环的读数列到该 runId 的**父行** (`planName` 点名, 一般是 `goal-orchestrating-loop`)。
   * 子 run 行同 runId 但 plan_name 不同, 不被碰 —— 读侧按 plan_name 前缀分父子。
   */
  updateLoop(runId: string, planName: string, loop: LoopLedger): void;
  close(): void;
}

interface Row {
  id: string;
  /** SH-1: conductor 声明的图式卡 id。NULL = 没记 (老行 / 该跑没声明)。 */
  shape_id?: string | null;
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
  rollback: string | null;
  reused: number | null;
  blame_retry: string | null;
  criteria: string | null;
  loop: string | null;
  acceptance_probe: string | null;
  spec_write: string | null;
  // C-1 节点级五位列 (2026-08-19): nullable INTEGER, 缺席 = 来源链没接 / 老行 (NULL ≠ 0, INV-1)。
  tokens_in: number | null;
  tokens_out: number | null;
  cache_hit_tokens: number | null;
  duration_ms: number | null;
  turns: number | null;
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
      // #204: why 缺席合法 (没有弱段); 在就必须是字符串 —— 同 vacuity-only 那条的形状。
      if (keys.length === 1) return { kind: 'passed-both' };
      return keys.length === 2 && typeof o.why === 'string' ? { kind: 'passed-both', why: o.why } : undefined;
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

/** 只认 `SpecWrite` 的确切形状 (`isSpecWrite`); 坏 JSON / 词表外 kind / JSON null → undefined (= 未记录)。 */
function parseSpecWrite(raw: string): SpecWrite | undefined {
  try {
    const p: unknown = JSON.parse(raw);
    return isSpecWrite(p) ? p : undefined;
  } catch {
    return undefined;
  }
}

/**
 * plan 节点上的 `requires` → 留痕值。只认调度器的三个合法形状 (`'all'` / `'any'` / 有限整数);
 * 缺席 / 词表外 (`'most'` / 小数 / null / 对象) → `undefined` = **缺席**。
 *
 * ⚠ **绝不** `?? 'all'`: 调度器的 `node.requires ?? 'all'` 是判定期缺省, 这里是留痕期声明。
 *   补上缺省 = 把"没声明"读成"声明了全量", 而这一位存在的全部理由是数前者 (见 DagRunNode.requires)。
 * ⚠ `0` / 负数**不过滤**: PlanSchema 拒它们 (`conductor-plan.ts:317` `.int().min(1)`), 所以出现
 *   即异常 —— 而留痕层的活是把异常**记下来**, 不是替写方遮掉。真值判断 (`req ? …`) 会把 0
 *   抹成"没声明", 那正是把证据变成缺席的那一步。判死归 static-lint, 不归账本。
 */
function parseRequires(raw: unknown): 'all' | 'any' | number | undefined {
  if (raw === 'all' || raw === 'any') return raw;
  if (typeof raw === 'number' && Number.isInteger(raw)) return raw;
  return undefined;
}

function loopOf(raw: string | null): LoopLedger | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as LoopLedger;
    return v && typeof v === 'object' && v.path === 'orchestrating-loop' ? v : null;
  } catch (err) {
    // 坏 JSON = 没记 (读侧不编一个形状); 写侧永远写 JSON.stringify 的产物, 这里坏只可能是手改 —— 留一行证据 (仓规静默坑 ②)。
    console.warn(`[dag-record] loop 列坏 JSON → 按 NULL 读: ${String(err).slice(0, 120)}`);
    return null;
  }
}

function rowToRecord(row: Row): DagRunRecord {
  // 探针列按**五条终局的确切形状**校验后读: 坏 JSON / 词表外 kind / 形状不对 / JSON null → undefined
  // (= 未记录) —— 一条写坏的记录不许让整张读数板崩, 也不许读出一个编造的分支。
  const probe = row.acceptance_probe ? parseAcceptanceProbe(row.acceptance_probe) : undefined;
  // #209 同一条纪律: 坏 JSON / 词表外形状 → undefined (= 未记录), 不让一行写坏的记录读出编造的分支。
  const sw = row.spec_write ? parseSpecWrite(row.spec_write) : undefined;
  return {
    id: row.id,
    createdAt: row.created_at,
    planName: row.plan_name,
    // SH-1: 原样返回。`undefined`(列不存在/老行) 与 `null`(有列但没声明) 都读成缺席,
    // 「是不是已知卡」由消费面 isKnownShapeId 判, 不在这里替它编。
    ...(row.shape_id ? { shapeId: row.shape_id } : {}),
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
    ...(row.rollback ? { rollback: JSON.parse(row.rollback) } : {}),
    // `reused: 0` 是"记了且一个没复用", NULL 是"没记" —— 两者不许合并。
    ...(row.reused !== null ? { reused: row.reused } : {}),
    // NULL = 这一跑没被打回过 (不适用); 有值 = 打回过, 里面的 `blameSize: 0` 才是「围栏没解析出来」。
    // 两格语义不同, 与 `reused` 那条同款纪律 —— 见 DagRunRecord.blameRetry 的注。
    ...(row.blame_retry ? { blameRetry: JSON.parse(row.blame_retry) } : {}),
    ...(row.criteria ? { criteria: JSON.parse(row.criteria) } : {}),
    // R-1: NULL = 没走循环 / 老记录 / 子 run 行 (不适用); 坏 JSON 按 NULL 读, 不编。
    ...(loopOf(row.loop) ? { loop: loopOf(row.loop)! } : {}),
    // 取值矩阵见 DagRunRecord.acceptanceProbe 的注: NULL = 没记 (非 goal / 探针没跑 / 老行); 坏 JSON 已按 NULL 读。
    ...(probe ? { acceptanceProbe: probe } : {}),
    // 同上 (#209): NULL = 没记 / 非 solve 入口不适用。词表外形状按 NULL 读, 不编一个 kind。
    ...(sw ? { specWrite: sw } : {}),
    // C-1 节点级五位列 (2026-08-19): 写在每个 DagRunNode 里 (JSON.parse(row.nodes) 已带回),
    // 这里**不**在顶层复读 —— 否则就成了 run 级聚合, 而那是 `usage` 那五位的活 (INV-3)。
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
  meta: { runId: string; entry: string; question?: string; acceptanceProbe?: AcceptanceProbe; specWrite?: SpecWrite },
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
      // #209: 同 acceptanceProbe 一样走可变 meta —— 契约段收尾时填进去, 执行段那张图写入磁盘时带上。
      ...(meta.entry === 'solve' && meta.specWrite ? { specWrite: meta.specWrite } : {}),
    });
  };
}

/**
 * 引擎读数留痕库的**唯一**位置 —— 锚在 **omd 自己的仓根**, 不随 cwd 走。
 *
 * 2026-08-05 之前是 `join(cwd, '.omd', 'dag-runs.db')`(三个调用点各写一份)。那条口径的洞:
 * omd 经 MCP 可以从**任何** repo 的 session 发跑, 于是从别的 repo 发的跑, 记录进的是**那个
 * repo** 的 `.omd/dag-runs.db`。实测: `/home/dev/repos/other-repo` 底下真有一份, 而且是老
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
 * 中央台账不可写时的回退路径 (2026-08-26, bench 容器实测):
 * omd 以**只读挂载**分发时 (workbuddy-bench split-mount → /opt/omd/pkg), `mkdir <仓根>/.omd`
 * EROFS —— 而记账属四层理念的**告知层**, fail-open 不许挡主流程; 此前这里直接抛, 把整个
 * goal-worker 砸死在第一行, 是违反自家 ④ 层契约的实测样本。
 * 回退序: OMD_DATA_HOME → cwd/.omd (回到 2026-08-05 前的 per-cwd 口径, 代价 = 该跑不进中央
 * 读数板, 证据行必打)。
 */
export function ledgerPathWritable(): string {
  const central = ledgerPath();
  try {
    mkdirSync(dirname(central), { recursive: true });
    return central;
  } catch (e) {
    const fallbackRoot = process.env.OMD_DATA_HOME?.trim() || join(process.cwd(), '.omd');
    // fail-open 但留证据: 这一行是"为什么中央读数板缺了这跑"唯一的解释。
    process.stderr.write(
      `[omd/dag-record] 中央台账不可写 (${(e as Error).message}) → 回退 ${fallbackRoot}/dag-runs.db (该跑不进中央读数板)\n`,
    );
    return join(fallbackRoot, 'dag-runs.db');
  }
}

/**
 * 造一个运行留痕器。path 默认 `ledgerPath()` (持久); ':memory:' 或注入 db = 瞬时/测试。
 */
export function createDagRecorder(opts: { path?: string; db?: Database } = {}): DagRecorder {
  const path = opts.path ?? ledgerPathWritable();
  if (!opts.db && path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = opts.db ?? new Database(path);
  // C-1 独占 (2026-08-19): 20s busy timeout, 让并发读卡到锁释放而不是立刻 SQLITE_BUSY。
  // ⚠ 2026-08-21: 它必须排在 `journal_mode = WAL` **之前** —— busy_timeout 是连接级设置,
  // 只对其后的语句生效, 而 WAL 那条自己就要拿锁。排在后面 = WAL 那条用默认值 0, 一撞就 BUSY。
  db.run('PRAGMA busy_timeout = 20000');
  db.run('PRAGMA journal_mode = WAL');
  db.run(`
    CREATE TABLE IF NOT EXISTS omd_dag_runs (
      id              TEXT PRIMARY KEY,
      created_at      INTEGER NOT NULL,
      plan_name       TEXT NOT NULL,
      node_count      INTEGER NOT NULL,
      question        TEXT,
      run_id          TEXT,
      levels          TEXT NOT NULL,
      nodes           TEXT NOT NULL,
      usage           TEXT NOT NULL,
      tokens_in       INTEGER,
      tokens_out      INTEGER,
      cache_hit_tokens INTEGER,
      duration_ms     INTEGER,
      turns           INTEGER
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
  // D1 (2026-08-06): 起跑时「回得去吗」。老行留 NULL = **没记**, 不是 'clean'。
  if (!cols.includes('rollback')) db.run(`ALTER TABLE omd_dag_runs ADD COLUMN rollback TEXT`);
  if (!cols.includes('reused')) db.run(`ALTER TABLE omd_dag_runs ADD COLUMN reused INTEGER`);
  // 2026-08-28: 外环重修半径。老行留 NULL (= 没记 / 没被打回过, 不是 blameSize:0)。
  if (!cols.includes('blame_retry')) db.run(`ALTER TABLE omd_dag_runs ADD COLUMN blame_retry TEXT`);
  if (!cols.includes('criteria')) db.run(`ALTER TABLE omd_dag_runs ADD COLUMN criteria TEXT`);
  // 入口轴 (2026-08-02): 2026-08-02 之前建的表没这一列, 老行留 NULL (= 没记, 不是 'unknown')。
  if (!cols.includes('entry')) db.run(`ALTER TABLE omd_dag_runs ADD COLUMN entry TEXT`);
  // 同上 (goal 验收探针): 之前建的表没这一列, 老行留 NULL (= 没记, 不是 'unknown')。
  // 只由 entry='solve' (历史行 'dag_goal') 的 recordDagRun 写入 —— 见 DagRunRecord.acceptanceProbe 的取值矩阵。
  if (!cols.includes('acceptance_probe')) db.run(`ALTER TABLE omd_dag_runs ADD COLUMN acceptance_probe TEXT`);
  // 同上 (#209, 2026-08-19): spec 写入磁盘裁决。老行留 NULL (= 没记, 不是"没写入磁盘")——
  // 那两件事被混为一谈正是这一列存在的理由。只由 entry='solve' 的 recordDagRun 写入。
  if (!cols.includes('spec_write')) db.run(`ALTER TABLE omd_dag_runs ADD COLUMN spec_write TEXT`);
  // C-1 节点级五位列 (2026-08-19): 与 run 级 `usage` 聚合分开的每节点原值, 见 DagRunNode 的注。
  // 老行留 NULL (= 没记, 不是 0) —— 同上 (INV-1)。
  if (!cols.includes('tokens_in')) db.run(`ALTER TABLE omd_dag_runs ADD COLUMN tokens_in INTEGER`);
  if (!cols.includes('tokens_out')) db.run(`ALTER TABLE omd_dag_runs ADD COLUMN tokens_out INTEGER`);
  if (!cols.includes('cache_hit_tokens')) db.run(`ALTER TABLE omd_dag_runs ADD COLUMN cache_hit_tokens INTEGER`);
  // SH-1 图式卡 id (2026-08-30): conductor 声明它跟的是哪张卡。老行留 NULL ——
  // NULL = **没记**(这一列还不存在时建的行), 与「跑了但没跟卡」(那时写空/缺席) 不是一回事。
  // 值原样落盘, 不在写侧校验是不是已知卡 (见 ConductorPlan.shape 的注; 读侧用 isKnownShapeId 分)。
  if (!cols.includes('shape_id')) db.run(`ALTER TABLE omd_dag_runs ADD COLUMN shape_id TEXT`);
  if (!cols.includes('duration_ms')) db.run(`ALTER TABLE omd_dag_runs ADD COLUMN duration_ms INTEGER`);
  if (!cols.includes('turns')) db.run(`ALTER TABLE omd_dag_runs ADD COLUMN turns INTEGER`);
  // R-1 (2026-09-03): 编排循环父行的读数列 (JSON, 见 goal/loop-ledger.ts)。老行 / 非循环 run / 子 run 行 = NULL (没记 / 不适用)。
  if (!cols.includes('loop')) db.run(`ALTER TABLE omd_dag_runs ADD COLUMN loop TEXT`);
  db.run(`CREATE INDEX IF NOT EXISTS omd_dag_runs_run_id ON omd_dag_runs (run_id)`);
  const ins = db.query(
    `INSERT INTO omd_dag_runs (id, created_at, plan_name, node_count, question, run_id, entry, levels, nodes, usage, observations, claim_check, artifact_move, write_race, rollback, outcome, verification, reused, blame_retry, criteria, acceptance_probe, spec_write, shape_id, tokens_in, tokens_out, cache_hit_tokens, duration_ms, turns)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const byId = db.query(`SELECT * FROM omd_dag_runs WHERE id = ?`);
  const recent = db.query(`SELECT * FROM omd_dag_runs ORDER BY created_at DESC LIMIT ?`);
  const byRun = db.query(`SELECT * FROM omd_dag_runs WHERE run_id = ? ORDER BY created_at ASC`);
  const upd = db.query(`UPDATE omd_dag_runs SET criteria = ? WHERE run_id = ?`);
  // R-1: 只回填**父行** (plan_name 点名), 派发出的子 run 行 (plan_name 以 conductor- 开头) 这一列保持 NULL —— 它们是分母来源, 不是持有者。
  const updLoop = db.query(`UPDATE omd_dag_runs SET loop = ? WHERE run_id = ? AND plan_name = ?`);
  const updSpec = db.query(`UPDATE omd_dag_runs SET spec_write = ? WHERE run_id = ?`);

  return {
    record(result, meta = {}) {
      const id = meta.id ?? crypto.randomUUID();
      const createdAt = meta.now ?? Date.now();
      // 命令从 **plan** 取而不是从 result 取: result 里没有它 (`DagNodeResult` 只记执行面),
      // 而 plan 是这次跑的那张图的原文。plan 里没有对应 id (map 动态扇出的子节点) → undefined, 不编。
      const planNodes = result.plan.nodes as Record<
        string,
        { command?: string; detector?: unknown; max_rounds?: unknown; template?: string; requires?: unknown } | undefined
      >;
      // 这一跑复用了哪些节点 —— 引擎给的是 id 列表, 留痕层此前只存了它的**长度**。
      const reusedIds = new Set(result.reusedNodes ?? []);
      const nodes: DagRunNode[] = Object.values(result.results).map((r) => {
        const cmd = planNodes[r.id]?.command;
        // 内环形状 (2026-08-06): 只对 conductor 记 —— 别的 kind 上这两位没有意义, 记了就是编。
        // `maxRounds` 从 **plan** 取 (同 command 那条): result 里没有它, 而缺省 1 是引擎真跑的值。
        // plan 里没有这个 id (map 动态扇出) → 两位都缺席, 那才是真不知道。
        const planNode = planNodes[r.id];
        // quorum 声明 (2026-08-30): 三个合法形状之外 (含 undefined) 一律 undefined = 缺席。
        const req = parseRequires(planNode?.requires);
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
          // R0: 派卡从 plan 取; 缺席 = 没派 (map 动态子节点无 plan 行 → 缺席 = 真不知道, 同 loopShape)。
          ...(typeof planNode?.template === 'string' && planNode.template.trim() ? { template: planNode.template } : {}),
          ...(planNodes[r.id]?.detector === true ? { detector: true as const } : {}),
          // quorum 声明 (2026-08-30): 从 **plan** 取 (同 command/template/max_rounds 那条 —— result
          // 只记执行面)。**只落显式声明**: `planNode.requires` 缺席 → 这一位缺席, **绝不**补一个
          // `?? 'all'` —— 那是调度器判定期的缺省, 把它写进历史记录就把"没声明"变成"声明了全量",
          // 而这一位量的正是声明率。词表外的值按缺席读 (不编 kind)。
          ...(req !== undefined ? { requires: req } : {}),
          ...(outHash ? { outputHash: outHash } : {}),
          ...(typeof r.exitCode === 'number' ? { exitCode: r.exitCode } : {}),
          ...(r.failureKind ? { failureKind: r.failureKind } : {}),
          ...(r.budgetStopped ? { budgetStopped: r.budgetStopped } : {}),
          ...(r.writeCounts ? { writeCounts: r.writeCounts } : {}),
          // 闸在场态 (2026-09-02): 只搬运, 一个字不补。runner 没报 → 这一位缺席,
          // **绝不**补一个 `?? { writeAllow: 'unavailable', ... }` —— 那正是把"没记"写成
          // "查过且没配"的抹平, 而这一位量的恰恰是配没配。
          ...(r.gates ? { gates: r.gates } : {}),
          // 缺席 = 这个节点没做过 fan-in 摘要;`[0,0]` 是**有意义的一格**(做了但全文没有锚)。
          // 用 `!== undefined` 是为了把这个意图写出来 —— ⚠ 不是因为真值判断会出错:
          // 数组恒为真值(`[]` 也是), 所以 `r.faninAnchors ?` 在这里**行为完全一样**
          // (`writeCounts` 那条用的就是它)。首版注释在这里写反了, 是变异验证当场抓出来的。
          // 真正会抹平这一格的是**查元素**的写法, 例如 `r.faninAnchors?.[0] ?` —— 那种
          // "顺手优化掉没用的零" 会把「不适用」变成「没记」。dag-record.test.ts 那条用例钉的就是它。
          ...(r.faninAnchors !== undefined ? { faninAnchors: r.faninAnchors } : {}),
          ...(r.model ? { model: r.model } : {}),
          ...loopShape,
          // 复用面 (2026-08-06): 不记就只能靠推, 而推的前提是假的 —— 见 DagRunNode.reused。
          ...(reusedIds.has(r.id) ? { reused: true as const } : {}),
          // C-1 节点级 token/duration/turns 五位列 (2026-08-19): `r.usage.in/out` 是 ModelUsage 必填,
          // 几乎总有; `cacheHit` 是 ModelUsage 可选, provider 不报 → null; `durationMs` / `turns`
          // 在 LeafResult 上**当前没接**, 一律 null, **绝不** `?? 0` 顶替 (INV-1: NULL ≠ 0)。
          // JS 端允许 null (类型 `number | null`), 与 rowToRecord 的读侧对称。
          tokensIn: typeof r.usage?.in === 'number' ? r.usage.in : null,
          tokensOut: typeof r.usage?.out === 'number' ? r.usage.out : null,
          cacheHitTokens: typeof r.usage?.cacheHit === 'number' ? r.usage.cacheHit : null,
          durationMs: typeof (r as { durationMs?: unknown }).durationMs === 'number' ? (r as { durationMs: number }).durationMs : null,
          turns: typeof (r as { turns?: unknown }).turns === 'number' ? (r as { turns: number }).turns : null,
          // R-1: 两个计数只搬运 (LeafResult 上缺席 → null, 不是 0)。
          toolCalls: typeof r.toolCalls === 'number' ? r.toolCalls : null,
          llmCalls: typeof r.llmCalls === 'number' ? r.llmCalls : null,
          // R-1 第 3 步: 只对 agent 叶落这一格 (没报 = null); 非 agent 叶缺席 —— 「不适用」与「没记」分开。
          ...(r.kind === 'agent' ? { thinking: r.thinking ?? null } : {}),
          // ⑥(c) 同上接住形状: 当前来源链未通 → 一律 null; 采集片接上后本行无需再动。
          injectedTokens: typeof r.injectedTokens === 'number' ? r.injectedTokens : null,
          // C-0 (2026-08-21): 跨轮身份 (引擎在 settle 时写 currentEngineRound)。读侧允许 `null` (= 没记 / 链未接),
          // `undefined` 缺席与 `null` 不许互换 (INV-0-3) —— 真源 LeafResult 上未声明的字段也走 null 通道。
          dagRound: typeof r.dagRound === 'number' ? r.dagRound : null,
          // C-0 (2026-08-21, INV-0-1): 引擎在 settle 时给早轮那条落 `overriddenBy = currentEngineRound` (起始 1);
          // 末轮那条 / 单轮节点 = null。「最后一轮不算被覆盖」的不变量在 engine.ts 守住, 留痕层只做搬运。
          overriddenBy: typeof r.overriddenBy === 'number' ? r.overriddenBy : null,
          // C-4 (2026-08-21, INV-4-1): 三态严格区分。`r.selfRepair === undefined` (节点根本
          // 没 self_check) → 不写键 (JSON 化后 = 缺席); `null` (SDK 通道截断, INV-2-1) → 写 null;
          // 对象 → 原样写。**严禁** `?? null` / `?? {rounds:0,...}` — 任一种都会把"缺席"读成
          // 截断或判据一次就绿, 抹掉下一条不变量。
          ...(r.selfRepair !== undefined ? { selfRepair: r.selfRepair } : {}),
          // P3 S2: 同一条三态纪律。
          ...(r.acceptance !== undefined ? { acceptance: r.acceptance } : {}),
          ...(r.selfReport !== undefined ? { selfReport: r.selfReport } : {}),
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
        result.rollback ? JSON.stringify(result.rollback) : null,
        // N5: run 级终止原因。**在这里算而不是让调用方传** —— 两个调用面 (dag_run / dag_goal)
        // 各算一遍就是两处会漂的独立判断, 而 `deriveRunOutcome` 是纯函数、读的就是这份 result。
        deriveRunOutcome(result),
        // N9 判据轴: 冻结判据的判词。缺席 (引擎没跑验收) → NULL, 不编一个 pass:false。
        result.verification ? JSON.stringify({ pass: result.verification.pass, reason: result.verification.reason }) : null,
        // N9 效率轴: 跨轮复用了几个节点。`reusedNodes` 缺席 = 这条链没报 → NULL 而不是 0。
        result.reusedNodes ? result.reusedNodes.length : null,
        // 外环重修半径 (2026-08-28): 缺席 = 这一跑没被 verifier 打回过 → NULL, 不编一个
        // `blameSize:0` (那是「打回了但围栏没解析出来」, 下一步完全不同)。
        result.blameRetry ? JSON.stringify(result.blameRetry) : null,
        // criteria 在整趟 goal 收尾时才有 → 这里恒 NULL, 由 updateCriteria 回填。
        null,
        // goal 验收探针 (契约): 只持久化 entry='dag_goal'; 其它入口即使误传也必须留 NULL。
        // 缺席 → NULL, 不编 'unknown'; 存一份紧凑 JSON, 绝不双编码。
        // t7 词表: 'solve' (写侧新词; 'dag_goal' 只在历史行, 写侧不再产生)。
        meta.entry === 'solve' && meta.acceptanceProbe !== undefined ? JSON.stringify(meta.acceptanceProbe) : null,
        // #209 spec 写入磁盘裁决: 同上, 只持久化 entry='solve'; 其它入口误传必须留 NULL
        // (那一格的语义是"契约段对这个入口不适用", 不是"没记")。
        meta.entry === 'solve' && meta.specWrite !== undefined ? JSON.stringify(meta.specWrite) : null,
        // SH-1 图式卡 id (2026-08-30): 直接读 `result.plan.shape` —— 不让调用方传, 同
        // `deriveRunOutcome` 那条理由: 两个调用面各传一遍就是两处会漂的独立判断。
        // 缺席 → NULL(这一跑没跟卡, 合法状态); **不校验是不是已知卡**, 原样落盘,
        // 「已知/未知/缺席」三态由消费面 `isKnownShapeId` 分(见 ConductorPlan.shape 的注)。
        result.plan.shape ?? null,
        // C-1 节点级五位列 (2026-08-19): 表列**只作 schema 兼容**(老库 ALTER 通道), 真值在
        // `nodes` JSON 里(per-node)。**严禁求和压平** —— 把 NULL/0/不适用抹成一格的正是 INV-1 禁的,
        // 真要走"一跑用了多少 token"该读 `usage.conductor/leaves` (run 级聚合 = 那两位的活), 或
        // 读数板按 JSON `nodes[]` 现算。**不**在 SQL 行层面做这一层聚合。
        // (硬约束 ↔ 上一版 5 个 SUM-IIFE 直接违反, 已收回: 一律 NULL, 与 GWT-1c 老行同形态。)
        null, // tokens_in      —— schema 仅占位
        null, // tokens_out     —— schema 仅占位
        null, // cache_hit_tokens —— schema 仅占位
        null, // duration_ms    —— schema 仅占位
        null, // turns          —— schema 仅占位
      );
      return id;
    },
    updateCriteria(runId, criteria) {
      upd.run(JSON.stringify(criteria), runId);
    },
    updateSpecWrite(runId, specWrite) {
      updSpec.run(JSON.stringify(specWrite), runId);
    },
    updateLoop(runId, planName, loop) {
      updLoop.run(JSON.stringify(loop), runId, planName);
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
