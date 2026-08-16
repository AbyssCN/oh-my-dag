/**
 * src/harness/continuity/types.ts — W2 omd 侧 session continuity 类型定义 (SDD §2 C1).
 *
 * 所有 checkpoint/Judge/Halt 类型归口此处。消费方:
 *   - checkpoint-manager.ts (C2)
 *   - halt-judge.ts (C6)
 *   - executor-dag.ts (C4 集成)
 *   - noun-gate.ts (C5)
 *   - scripts/continuity-writer.ts (W1 回灌)
 */
import type { ModelUsage } from '../../model/gateway';
import type { NodeFailureKind } from '../node-failure';

/**
 * 单个 DAG 节点的 checkpoint 快照。
 * schemaVersion=1 以支撑未来迁移 (字段增删不改旧读)。
 */
export interface NodeCheckpoint {
  nodeId: string;
  leafKind: 'inproc' | 'agent' | 'command' | 'map' | 'primitive' | 'research' | 'conductor' | 'await';
  /**
   * done = 成功节点; failed = 失败节点 (issue #4: 留败因痕供事后诊断); skipped = 依赖未达
   * quorum 级联跳过 (D-7v2, 零执行)。resume 语义只认 done —— loadAllGreen / shouldSkip 均
   * 过滤 status==='done', 故 failed/skipped checkpoint 永不被当绿跳过, 只作审计留痕。
   */
  status: 'done' | 'failed' | 'skipped';
  /**
   * 失败节点 (issue #4) 的败因分类。**词表与每格判据的唯一定义处是 `../node-failure.ts`** ——
   * 这里只是把结果上那一位原样存下来 (P1, 2026-07-31: 此前留痕层当场重新推断一遍, 于是同一件事
   * 有两处独立判断, 天然会漂)。
   *
   * `'failed'` 是**历史字面量**: 2026-07-31 之前写入的行只有 stall/dep-skip/failed 三档,
   * 那个 `'failed'` 意思是"这个版本没细分", 与新词表的 `'unclassified'` ("细分了但归不了类")
   * 不是一回事 —— 读老库的时候别把两者并起来数。done 节点 undefined。
   */
  failureKind?: NodeFailureKind | 'failed';
  /** 实际所用模型坐标 (失败归因; inproc/agent leaf 有, command/无模型 → undefined)。 */
  model?: string;
  /**
   * 该节点写入的产物路径 (相对于 repo root)。
   * agent-leaf 从 tool-call 事件收集 Edit/Write file_path。
   * inproc/command leaf / 失败节点 → []。
   */
  /**
   * 这份 checkpoint 出自 conductor 内环的**第几轮**(2026-08-06, D-A)。
   *
   * ## 为什么它值得一位
   *
   * checkpoint 按 `(runId, nodeId)` **覆写**, 而多轮内环里同一个节点会跑好几次 ——
   * 于是盘上留下的那一份**说不出它是第几轮的**。后果不是审计洁癖:
   * 读数板 ⑧.7 拿 `createdAt - durationMs` 重建执行窗口来数并发写竞争, 而在多轮跑里
   * 两份 checkpoint 可能来自**不同的轮**, 把它们的窗口配成一对就是**跨轮伪影** ——
   * 「两个节点在不同轮里各跑一次」根本不是并发。
   *
   * 2026-08-06 实测代价: 历史上唯一那条"撞车"**整条落在多轮跑那一面** (单轮面 0/21,
   * 多轮面 1/9) —— 也就是说"并发写竞争确实发生"这个结论当时**排除不掉伪影**。
   *
   * ⚠ **缺席 ≠ 第 1 轮**: 缺席 = 这个节点不在 conductor 子图里(顶层节点没有"轮"这回事),
   *   或早于本次改动的记录。读数板分开念。
   */
  round?: number;
  outputPaths: string[];
  /** 每个 outputPath → sha256 前 16 hex 字符。轻量产物完整性检验。 */
  artifactHashes: Record<string, string>;
  /**
   * 该节点**读过**的文件路径 (D-12, agent-leaf 从 read 族 tool-call 事件收集)。
   *
   * 为什么进 checkpoint 而不只活在内存里: resume 跳过一个节点时, 它的 `filesRead` 本该随之
   * 还原 —— 否则续跑一次, 制品 lint 与读毒的观察面就静默窄一截 (漏报的正是"上次读过被拒制品"
   * 那种最该拦的节点)。缺席 = 老 checkpoint / 非 agent 节点 (向后兼容, 退回无观察)。
   */
  inputPaths?: string[];
  /** 模型用量。command leaf = null。 */
  tokenUsage: ModelUsage | null;
  /**
   * LeafResult.output 截断, ≤800 字符。失败节点 = 错误消息/最后输出截断 (issue #4 败因)。
   *
   * ⚠ **D-O (2026-07-29) 起 summary 只给人看, 不当数据源** —— 下游吃的输出全文改由
   * {@link outputText} 指向的制品承载。此前 resume 跳过一个节点时把这 800 字当它的输出注入下游,
   * 于是每续跑一次, 图上游的信息就被截断一次 (而截断是静默的: 下游只看到一段"看起来完整"的话)。
   *
   * ⚠ **失败节点的这一段是头+尾** (`failureExcerpt`, 2026-08-06), 成功节点仍是 `slice(0, 800)`。
   *   两者不同不是随意: 盘上 63 份真失败里撞到 800 上限的只有 2 份, 而那 2 份**全部**是
   *   `a && b && c` 链 —— 前两段成功的刷屏占满 800 字, 真正的失败判词在**尾巴上**被切掉。
   *   短于预算时原样返回, 故另外 61 份与改动前逐字相同 (历史读数仍可比)。
   */
  summary: string;
  /**
   * **D-O 产出面**: 本节点输出**全文**的落盘路径 (绝对路径, runDir 下的 `out-<nodeId>.txt`)。
   *
   * 三个用处: ① resume 跳过时还原全文而非 summary ② 中途直接读产物看成果 ③ 单独重跑某节点时,
   * 它的上游输入是别的节点的这份文件 (不是 800 字截断)。写失败 → 字段缺席 (fail-open, 退回 summary)。
   *
   * ⚠ **失败节点也有了** (2026-08-06): 落 `fail-<nodeId>.txt`, 与绿节点的 `out-<nodeId>.txt`
   *   刻意**不同名** —— 同一个 nodeId 在多轮内环里先失败后成功时, 同名会让失败全文被成功全文
   *   覆盖, 于是归档下来的失败 checkpoint (`<nodeId>.__r<k>.json`) 指向的是**成功的那份文本**。
   *   改动前实测: 150 份非绿 checkpoint 带全文的 **0** 份 —— 失败诊断只剩 800 字。
   *   ⚠ 失败节点的这份全文**不进 resume**: `loadAllGreen`/`shouldSkip` 只认 `status==='done'`,
   *   它纯粹是事后留痕。
   */
  outputText?: string;
  /**
   * **这次失败点名了哪些盘上真有的文件** (2026-08-06, `failure-trace.blamePathCandidates`)。
   *
   * 它是「路径 → 谁写的」反查的**起点**: 拿到路径才问得出"这一跑里哪个节点产出了它"。
   *
   * ⚠ **推断不是事实**, 与 `DagNodeResult.writeCandidates` 同一档证据、同一条纪律:
   *   **只进可见性, 不参与任何判定** —— 节点成败 / 产物闸 / judge 一律不看它。
   *   输出里出现一个路径 ≠ 那个路径就是病因 (一条 `bun test` 会把它跑过的每个文件都念一遍)。
   *
   * ⚠ 缺席 = 老记录 / 成功节点 / 这次输出里一个核得过的路径都没有 —— 三者今天分不开,
   *   而 `[]` 不写 (省一位)。要分开得再加一列, 别拿缺席当 0 用。
   *
   * ⚠ 盘上可达面 (改动前用同一判据回溯 150 份 800 字 summary): 真失败 63 份认出 27 份 (43%),
   *   分类差别很大 —— `empty-artifact` 71% · `failed` 50% · **`assert-failed` 仅 1/7 (14%)**。
   *   14% 那格量的是最窄的一格 (主流是 `[expect_exit 1, 实得 0]` 语义失败, 输出里根本没有文件),
   *   别把它当整条通道的可达率。
   */
  failurePaths?: string[];
  /**
   * **D-O 输入面**: 产出本 checkpoint 时, 每个直接依赖的**输出全文** sha256 前 16 hex。
   *
   * 补的是 resume 的一个真漏洞: 此前只有 `generation` (图**形态**签名) 守卫, 形态没变但上游节点
   * 重跑出了**不同内容**时, 下游 checkpoint 照样被当绿跳过 —— 拿旧输入的产物冒充新输入的产物。
   * 有它之后判据变成"形态没变 **且** 我吃到的东西没变"。
   *
   * 缺席 (老 checkpoint / 无依赖的根节点) → 不做输入面校验 (向后兼容, 退回原语义)。
   * 锚在**依赖的输出全文**而非"实际注入的 prompt": fan-in 定向摘要是 LLM 现生成的, 拿它做锚
   * 会让每次 resume 都判 stale。全文没变 = 输入语义没变。
   */
  inputHashes?: Record<string, string>;
  /** U1 map 节点: spec hash (INV-U3 两级 resume; spec 变 → 子树作废)。optional。 */
  expansionHash?: string;
  /**
   * **落盘时的语义 Merkle 指纹** (2026-07-29, 通道⑤-b)。
   *
   * 毒集的键是**指纹**不是 id (指纹刻意不含 id, 这样 conductor 重命名不破匹配)。resume 预载时
   * 要判"这个绿是不是被拒过的", 原先靠**当场重算** `merkleFingerprints(plan)` —— 对 plan-time
   * 节点成立, 对**运行时展开的子节点不成立**: map/conductor 的子节点是运行期才挂进 plan 的,
   * 预载那一刻它们根本不在图里, 重算够不着, 于是 judge 点名过的子节点照样被当绿跳过。
   *
   * 存下来就不用重算了。节点的 Merkle 指纹只依赖它的**祖先**, 而祖先在它跑起来的那一刻已经定死,
   * 所以落盘时算的值与轮末 judge 算的值一致 (后加的无关节点不影响)。
   */
  fingerprint?: string;
  /** noun-gate 注释标签 (W2: 注释 only; W1: 硬闸)。optional。 */
  nounAnnotations?: string[];
  /** 节点执行耗时 ms。 */
  durationMs: number;
  /** ISO-8601 创建时间。 */
  createdAt: string;
  /**
   * W4 SHADOW-3/4: checkpoint 落盘时的 DAG 代数签名 (computeDagGeneration)。
   * resume 时 currentGeneration 对不上 → 该 checkpoint 是过期 DAG 形态的, 丢弃重执行
   * (防"过期切点乱截"); 对得上 → 安全跳过 (幂等)。optional = 向后兼容旧 checkpoint。
   */
  generation?: string;
  /**
   * agent leaf watchdog 采集 (2026-08-12, S1 埋点)。**缺席语义**: 整个 `watchdog` 缺席 =
   * 非 agent 叶 / 老记录 (这条采集不适用或没接), 不代表"量过了且没触发"。
   *
   * 存在时 `stalled`/`timedOut` **必须恒写 boolean** —— `false` 是"量过了且没发生",
   * 不许用字段缺席去表示 false (NULL ≠ 0 ≠ 不适用, 与本仓其余可选字段同一条纪律)。
   *
   * `touchTimelineMs` = 每次 `filesTouched` 集合新增一个路径时距叶启动的相对毫秒数 (升序);
   * `toolTimelineMs` = 每次 `tool_execution_start` 距叶启动的相对毫秒数。两者都是相对值,
   * 不是绝对时间戳。
   *
   * `spin` 沿用既有 drift-detector 惯例, 仅在 `spinEvents > 0` 时出现。
   */
  watchdog?: {
    stalled: boolean;
    timedOut: boolean;
    touchTimelineMs: number[];
    toolTimelineMs: number[];
    spin?: { spinEvents: number; maxSameCount: number };
  };
  /**
   * 这个节点经 **bash 工具**跑过的命令 + 退出码(2026-08-16 补,#145 评论① 复盘)。
   *
   * 为什么补:run 1c9a4566 的五个 `empty-artifact` 节点,要回答的问题是
   * 「它这一轮到底动没动盘」——而这个问题的直接证据就是它跑了哪些命令。盘上一条都没有,
   * 判词里只截了前 3 条 × 40 字符,最后只能靠 `exec.log` 里 drift 观察者顺手打印的采样倒推。
   *
   * ⚠ 缺席 = 这条链上没人报(inproc 叶 / 老记录),**不是**"跑了但一次没用 bash"——
   * 后者是 `[]`。同 `LeafResult.shellRuns` 的三态。
   */
  shellRuns?: { command: string; exitCode?: number; ok: boolean }[];
  /** 工具调用次数(来自 `LeafResult.toolCalls`)。缺席 = 没报,不是 0。 */
  toolCalls?: number;
  /** `[写调用总数, 其中 no-op 数]`(§8.5 效果指标)。缺席 = runner 没报,不是 `[0,0]`。 */
  writeCounts?: [total: number, noop: number];
  /** 当前版本 = 1。迁移用。 */
  schemaVersion: 1;
}

/** DAG 维度元数据, 落 _dag.json。 */
export interface DagMetadata {
  runId: string;
  specSlug: string;
  goal: string;
  /** 按拓扑序排列的 nodeId 列表。 */
  nodeIds: string[];
  /** 节点依赖: nodeId → 上游 nodeId[]。 */
  deps: Record<string, string[]>;
  /** ISO-8601 创建时间。 */
  createdAt: string;
  /** W4 SHADOW-3: 本 DAG 形态的代数签名 (goal+nodeIds+deps)。resume 一致性校验锚。 */
  generation?: string;
  /**
   * plan-memory (SDD 2026-07-21 缺口①): 完整 ConductorPlan 全量 (节点 goal/executor/depends_on/
   * template/model)。此前只存骨架 (nodeIds+deps), 图的"肉"随进程丢弃 → 无法重放。
   * optional = 向后兼容旧 _dag.json (缺此字段 → 不可重放, 仅 resume)。
   * 类型用结构面而非 import ConductorPlan — continuity 层不依赖 conductor-plan 模块 (层次单向)。
   */
  plan?: { name: string; description?: string; nodes: Record<string, unknown> };
  /** plan-memory: 用户任务原文 (family 聚类的匹配键; resume/预构造路径可缺)。 */
  taskText?: string;
  /**
   * **运行时展开出来的子节点** (2026-07-30, 观察面补齐): map / conductor 节点在运行期挂进图的那些点。
   *
   * ⚠ **刻意与 `nodeIds` / `deps` / `plan` / `generation` 分开存**, 这不是洁癖:
   * `generation` = `computeDagGeneration({goal, nodeIds, deps})` 是 resume 的一致性锚, 而 resume
   * 重跑时引擎按**存下来的 plan** 重算一次代数去比对 checkpoint。把运行时子节点并进 nodeIds/plan,
   * 下一次 resume 算出来的代数就与盘上每一份 checkpoint 都对不上 → **整图全部作废重跑**,
   * 正是 continuity 存在的意义被自己吃掉。所以这里只是一份**观察记录**: 谁在运行期长出来了、
   * 挂在谁下面、什么 kind、有哪些边。`dag_resume` 一个字都不读它。
   *
   * 累积语义: 同 id 覆盖 (重展开得到同一个内容寻址 id = 同一个点), 不同 id 追加 (多轮重展开会
   * 留下每一轮的痕迹 —— 那正是"这个环到底试过哪些分解"的唯一记录)。
   */
  runtimeNodes?: Array<{
    /** 内容寻址子节点 id (`<parent>::<fp>`)。 */
    id: string;
    /** 展开它的那个 map/conductor 节点。 */
    parent: string;
    /** executor kind (leaf/agent/command/…)。 */
    kind: string;
    /** 该子节点的依赖 (含并进来的父节点外层上游)。 */
    deps: string[];
  }>;
}

/**
 * **外层 fixpoint 轮journal** (INV-P2-6), 落 `_fixpoint.json`。
 *
 * ⚠ **D-F (2026-07-30) 之后它只服务两个手动 slash 命令** (`/iterate` · `/execute`)。自主 goal
 * 引擎的环已搬进 conductor 节点, 状态走下面的 {@link NodeLoopJournal} —— 所以 D-F 说的"作废
 * `_fixpoint.json`"准确说法是**降级到节点级**, 不是删掉这个概念 (删掉等于把"被拒产出借崩溃
 * 复活"那个缺陷换个方式重新引入)。
 *
 * `_dag.json` + per-node checkpoint 记的是**一张内层图**;外层 fixpoint (iterateExecutorDag) 的轮次、
 * 跨轮复用源、D-4 毒集此前全是进程内闭包变量 —— 进程一死全丢, 重跑从第 1 轮起、毒集清零
 * (**被拒的产出会因此复活**, 比不复用更坏)。这个文件就是那份缺失的外层状态。
 *
 * 写入时机 = **每轮 judge 判完之后**。死在一轮中途 → 该轮没有 journal, resume 重跑该轮;
 * 但该轮内部的绿节点仍由 per-node checkpoint 兜住, 不是从零。
 *
 * 类型用结构面而非 import ConductorPlan / LeafResult —— continuity 层不依赖 harness 上层 (层次单向,
 * 同 DagMetadata.plan 的处理)。
 */
export interface FixpointJournal {
  runId: string;
  /** 已判完的外层轮数; resume 从 completedRounds+1 起跑。 */
  completedRounds: number;
  /** D-4 指纹毒集 (累积不撤)。丢了它 = 复活被拒产出。 */
  poisoned: string[];
  /** 上一轮的 {plan, results} —— 跨轮复用 (D-21) 的匹配源。 */
  lastRound?: {
    plan: { name: string; description?: string; nodes: Record<string, unknown> };
    results: Record<string, unknown>;
  };
  /** judge 判未收敛却开不出一张可解析的票 → 上一轮整体不可信 (D-4 fail-closed)。 */
  distrustLastRound?: boolean;
  /** 上一轮的失败原因 (enrich 注入下一轮 input)。 */
  prevReason?: string;
  /** 上一轮是否已判收敛 (收敛后 resume 无事可做)。 */
  converged?: boolean;
  updatedAt: string;
  schemaVersion: 1;
}

/**
 * **节点级环 journal** (P3 D-A/D-F, 2026-07-29), 落 `_loop-<nodeId>.json`。
 *
 * 环从外层搬进 conductor 节点之后, 轮次与毒集也得跟着搬。**搬到哪里是查证过的**, 两个看似顺手的
 * 位置都不行:
 *
 *  ❌ **不能放 `NodeCheckpoint`**: checkpoint 只在节点 **done** 时写, 而环没收敛就没有 done ——
 *     崩在环中间等于毒集蒸发, 正好是要防的那件事 (INV-P2-6 说的"毒集丢了比不复用更坏")。
 *  ❌ **不能拿子节点 id 当毒集键**充数: 子节点 id 的后缀来自 `merkleFingerprints(**子图**)`
 *     (deps 只含图内边), 而 judge 铸票算的是 `merkleFingerprints(**轮结果整图**)`
 *     (deps 含并进来的父节点外层上游) —— **两个指纹不相等**, 不能互相代用。
 *
 * ✅ 于是就是这个: 结构与 {@link FixpointJournal} 同形, 键从 `runId` 降到 `runId + nodeId`,
 *    写入时机同样是**每轮 judge 判完之后**。所以 D-F 的「废 `_fixpoint.json`」准确说法是
 *    **「把 FixpointJournal 从 run 级降到节点级」** —— 概念删掉等于把缺陷换个方式重新引入。
 */
import type { RunOutcomeKind } from '../run-outcome';

/**
 * 内环**一轮**里两道闸各自的裁决(2026-08-06)。三态与两态刻意都不压平:
 *
 * · `criterion: 'none'` = 这一跑**没配**冻结判据 —— 不是"判据没过";
 * · `judge: 'unreachable'` = judge 调不通 —— 不是"judge 说没成"。
 *
 * 两处若各自并进"没过"那一侧,`判据红 ∧ judge 说收敛` 这个要观测的组合就会被噪声灌满。
 */
export interface RoundVerdict {
  /** 第几轮(与 `NodeCheckpoint.round` 同一套编号)。 */
  round: number;
  /** 冻结判据这一道:绿 / 红 / 没配。 */
  criterion: 'green' | 'red' | 'none';
  /** judge 这一道:说收敛 / 说没成 / 调不通。 */
  judge: 'converged' | 'rejected' | 'unreachable';
}

export interface NodeLoopJournal {
  runId: string;
  /** 拥有这个环的节点 id (conductor 节点)。 */
  nodeId: string;
  /** 已判完的内环轮数; resume 从 completedRounds+1 起跑。 */
  completedRounds: number;
  /**
   * 毒集: 内环 judge 点名过的**子节点 id** (累积不撤)。
   *
   * ⚠ 键取 **id 而不是指纹**, 与外层毒集刻意不同 —— 因为子节点 id 本身就是内容寻址的 (D-B):
   * "同一个 id" 已经等价于"同一份规格 + 同一批祖先规格"。而指纹在这里反而不好使: 子图指纹
   * (deps 只含图内边) 与轮结果整图指纹 (deps 含并进来的父节点外层上游) **不相等**, 用哪个都得
   * 在两个键空间之间来回翻译。id 一把钥匙同时开两把锁: 拦 resume 复活, 也拦跨轮复用。
   */
  poisoned: string[];
  /** 上一轮的失败原因 —— 注入下一轮**重展开**的 prompt (环的信息通道就是它)。 */
  prevReason?: string;
  /** r1 片3 (INV-R1-4): 各轮发现文本 (截 400 字, 只喂词袋聚类) — noveltySeq 的计算底料。 */
  noveltyTexts?: string[];
  /** r1 片3: 累计簇数序列 (每轮一个) — hasCollapsed 的输入; 从不触发或总触发都读得出来。 */
  noveltySeq?: number[];
  /**
   * **每一轮两道闸各说了什么** (2026-08-06)。
   *
   * ## 它解锁的是一个**早就写好、却一直判不了**的决定
   *
   * D-I「以判据为准」今天只在**绿**的方向兑现: 判据绿 → 直接收敛, judge 的票只记录。
   * 红的方向没有对称守卫 —— 判据红时 `if (verdict.converged)` 仍能让 judge 宣布收敛。
   * 上一程查过要不要补, 判据先钉死在「出现过 `判据红 ∧ judge 说收敛` 才补」,
   * 免得给一个够不着的分支加兜底 (本仓 `loop-engineering-audit` ❌-9)。
   *
   * **而那个条件到今天都判不了 —— 因为逐轮的两个布尔谁都没记。**
   * journal 里的 `converged` 是**节点级最终结论**, 答不了"第 2 轮判据红时 judge 说了什么"。
   * 这一位就是补那个缺口: 记下来之后, 那条预先声明的判据变成一次 grep。
   *
   * ⚠ **只记不判**: 环的行为一个字没改。攒到条件成立再补守卫, 不成立就把这条从待办里划掉。
   * ⚠ 缺席 = 老记录 / 这个环没走到判决点。`criterion: 'none'` = **没配冻结判据**
   *   (与"配了但红了"是两件事, 别合并 —— 前者是这条通道不适用, 后者才是判据红)。
   */
  verdicts?: RoundVerdict[];
  /** 已判收敛 (resume 时无事可做, 直接返上次结论)。 */
  converged?: boolean;
  /** 上一轮的产出摘要 (收敛后 resume 要拿它当本节点的 output)。 */
  lastOutput?: string;
  /**
   * **这个环凭什么停的** (N6, 2026-07-31)。
   *
   * 此前 journal 只记「收敛与否」—— 而"没收敛"底下至少压着四种停法, 它们的下一步完全不同:
   * 轮数用尽(加轮数)· 阻塞(要外部输入, 加轮数没用)· 预算停(先加预算)· 取消(原样续)。
   * G5 首次触发之后这条更值钱: **一次真 BLOCKED 的证据此前只活在日志里**, resume 读不回来,
   * 而日志是会滚掉的。
   *
   * `kind` 直接借 run 级词表 (N5 的 {@link RunOutcomeKind}) —— 不新造一套词:
   * 内环的停止轴与 run 级的终止原因问的是同一个问题, 两套词早晚会漂, 而漂了之后
   * 「journal 说 blocked、摘要说 failed」正是 N5 刚治好的那个病。
   * `evidence` 是**判成这一格的直接证据原文**(熔断的那句话 / 检测者的判词 / 预算数字),
   * 不是复述 —— 事后要能拿它复盘"当时到底看见了什么"。
   */
  stop?: {
    kind: RunOutcomeKind;
    evidence: string;
    /** 停在第几轮 (与 completedRounds 可能差 1: 停在一轮**判完之后**还是**开跑之前**)。 */
    atRound: number;
  };
  updatedAt: string;
  schemaVersion: 1;
}

/**
 * **goal 前置阶段 journal** (2026-07-29), 落 `_goal.json`。
 *
 * `dag_goal` 的前四段 (classify / survey / research / spec) 是**编排代码**不是图 —— 它们不经 conductor、
 * 不进 DAG、没有 per-node checkpoint。于是崩在任何一段, resume 都得从 classify 重跑一遍:
 * research 是真联网 (实测 104s + token), spec 写的文件会被覆盖重写。**最贵的两段白烧。**
 *
 * 修法承 Claude Code `/loop` 的形状: **不造状态机, 靠幂等再入** —— 每段把结论写进世界,
 * 入口先看世界。于是 "resume" 不是一条特殊代码路径, 就是"再跑一遍, 已经有的自然跳过"
 * (与 `shouldSkip` 同一纪律: 存在 ∧ 有效 → 跳)。
 *
 * ⚠ `goal` 字段是**防误用闸**: 同一个 runId 换个 goal 再跑, 上次的仓内事实/研究证据对新 goal 无效,
 * 复用它们等于拿错证据写契约。goal 文本不匹配 → 整份 journal 作废。
 */
export interface GoalStageJournal {
  runId: string;
  /** 产出这批制品的 goal 原文 (不匹配则整份作废)。 */
  goal: string;
  tier?: 'simple' | 'complex';
  /** survey 阶段的仓内事实 (file:line 行)。 */
  repoContext?: string;
  /** research 证据正文 (零来源时为空 —— 与"假 grounded 不进 spec"同判据)。 */
  evidence?: string;
  sources?: string[];
  /** spec 落盘路径 (未落盘则无)。 */
  specPath?: string;
  updatedAt: string;
  schemaVersion: 1;
}

/**
 * 停机闸栈 (L1-L3) 判定结果。
 * - continue: 继续执行下一节点/轮。
 * - stop: 停机, 携带原因与可选证据。
 */
export type HaltVerdict =
  | { kind: 'continue'; reason?: string }
  | {
      kind: 'stop';
      reason:
        | 'all_green'
        | 'hard_fail'
        | 'judge_ok'
        | 'judge_impossible'
        | 'cap_exhausted'
        | 'degraded';
      /** 可选证据文本 (如 judge reason / oracle 输出片段)。 */
      evidence?: string;
    };

/**
 * L2 goal judge 模型输出 (responseSchema 强制校验用, INV-3 validated parse)。
 */
export interface JudgeVerdict {
  /** true = goal 已达到, 可收敛; false = 仍需继续。 */
  ok: boolean;
  /** true = agent 自称 goal 不可达 (如"无法完成"), judge 独立确认。 */
  impossible: boolean;
  /** 必须引用输入中的事实。禁提输入外的路径/符号。 */
  reason: string;
}
