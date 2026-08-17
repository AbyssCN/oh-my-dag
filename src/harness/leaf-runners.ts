/**
 * 叶执行注入接缝(INV-X1/X3):executor-dag 只认这些**接口形状**,不 import 任何执行实现。
 * 形状 = 私有上游 agent-leaf.ts / command-leaf.ts / model-router.ts 的公开契约原样
 * (provenance: 私有上游 worktree 时点)。
 * 实现方:宿主注入 pi-agent runner;或生产侧注入
 * omd-pi provider runner(随 provider slice)。测试注入 fake。
 */
import type { ModelUsage } from '../model/gateway';
import type { AgentEvent } from '@earendil-works/pi-agent-core';
import type { LeafProfile } from './profiles/profile';

// ── agent leaf(带工具的 pi session,能改文件)────────────────────────
export interface AgentLeafInput {
  /** 完整执行 prompt(已含 node 目标 + fan-in 上下文)。 */
  prompt: string;
  /** 'provider:modelId'。 */
  model: string;
  /**
   * 碰撞台账会话标识 (SDD S3, 只记不拦): 引擎侧 runId+节点维度稳定 id (如 `${runId}:${nodeId}`)。
   * runner 跨 run 复用 (MCP 长驻进程) → 会话只能**按调用**传, 不能烤进 runner 装配期。
   * 省略 = 本次调用不记 (runner 级 `AgentLeafRunnerOpts.touch` 仍在时回落其 session)。
   */
  touchSession?: string;
  /**
   * 本次调用允许调用的外部 MCP 工具 (SDD D-7): 引擎侧 `node.mcp ∪ 模板卡 mcp` 的去重并集
   * (元素 = server 名或 "server:tool", 同 C-5 闸判据)。缺省/空 = deny 全部副作用类 MCP 工具 ——
   * leaf 是执行叶子, 不声明不授权 (chat 座位的 'allow' 缺省不传染叶子)。runner 跨 run 复用 →
   * 只能**按调用**传, 不能烤进 runner 装配期 (同 touchSession 那条)。
   */
  mcpAllow?: string[];
  /**
   * 内部事件汇 (SDD D-8, 2026-08-11): runner 把本次调用的**内部工具事件** (tool_execution_start/end)
   * 转发给它 —— 引擎在节点调 runner 时挂节流转发器, 转成 DAG 的 `progress` 事件 (节流在引擎侧,
   * 与 chat 通道同形: 回调抛错被吞, 永不影响执行)。省略 = 不转发 (零开销, 老 runner 行为不变)。
   */
  onEvent?: (e: AgentEvent) => void;
  /**
   * 已解析的岗位档案 (SDD 2026-08-11-leaf-profile库 D-3): 引擎侧 `node.profile` 经 `resolveProfile`
   * 解出 → **按调用**传 (runner 跨节点复用, 不能烤进构造期 opts, 同 touchSession 那条)。
   * 省略 = 本次调用无 profile, 与 opts 级 `AgentLeafRunnerOpts.profile`(构造期兼容回退)二选一由
   * runner 实现决定优先序。profile 内容不进 promptVersion (INV-2, 与 persona 同边界)。
   */
  profile?: LeafProfile;
}

/**
 * leaf watchdog 采集的**单一真源形状** (2026-08-18 收敛; 此前 AgentLeafResult / LeafResult /
 * NodeCheckpoint 三处手抄同形, b87196e 加 grind 字段时只改了生产侧 —— 类型静默漂移的实证)。
 * 生产/透传/落盘三处都引用本接口: 加字段改这里, 漏改任何一处直接 tsc 红。
 *
 * 缺席语义 (NULL ≠ 0 ≠ 不适用, 全仓同一条纪律):
 * - 整个 `watchdog` 缺席 = 非 agent 叶 / 该 runner 不统计 / 老记录, **不代表**"量过了且没触发"。
 * - 存在时 `stalled`/`timedOut` 恒写 boolean —— `false` = 量过了且没发生, 不许用缺席表示 false。
 * - grind 三字段 (`advisorFiredAt`/`wrapupFiredAt`/`abortedByGrind`) 在**落盘真相**里是可选的:
 *   缺席 = S1 时代老记录 / 该 runner 不统计新档 (盘上真实存在这批 checkpoint, required 会让
 *   类型对旧数据撒谎); 现役生产侧的恒写纪律由 {@link LiveLeafWatchdog} 收紧到类型层。
 * - `touchTimelineMs`/`toolTimelineMs` 是距叶启动的相对毫秒数 (升序), 不是绝对时间戳。
 * - `spin` 仅在 `spinEvents > 0` 时出现, 同 drift-detector 惯例。
 */
export interface LeafWatchdog {
  stalled: boolean;
  timedOut: boolean;
  touchTimelineMs: number[];
  toolTimelineMs: number[];
  /**
   * grind advisor 软看门狗触发时刻 (S3), 距叶启动的相对毫秒数, 与 `touchTimelineMs` 同口径。
   * 现役生产恒写: `null` = 量过了且没触发 (LiveLeafWatchdog 收紧); 缺席 = 老记录/不统计。
   * 触发后保持非空 —— 每叶至多 1 次, 不重试不硬停。
   */
  advisorFiredAt?: number | null;
  /** grind advisor 诊断原文 (S3)。缺席/undefined = 没触发; 触发时非空, 与 `advisorFiredAt` 成对。 */
  advisorAdvice?: string;
  /**
   * grind 二档 wrap-up 触发时刻 (2026-08-17, #146), 距叶启动的相对毫秒数, 同 `advisorFiredAt` 口径。
   * 现役生产恒写 `null` = 量过了且没触发 (INV-5); 缺席 = 老记录/不统计。触发后保持非空,
   * 严格次于 advisor, 各至多 1 次。
   */
  wrapupFiredAt?: number | null;
  /**
   * grind 三档 abort 是否触发 (2026-08-17, #146)。`false` = 量过且没发生, `true` = 三档全过
   * 仍停滞, 节点判 failed + failureKind 'spin-fused' (INV-5)。缺席 = 老记录/不统计。
   */
  abortedByGrind?: boolean;
  spin?: { spinEvents: number; maxSameCount: number };
}

/**
 * 现役 agent-leaf **生产侧**形状: grind 三字段恒写 (INV-5 —— 忘写任何一个 = tsc 红, 这正是
 * b87196e 那次漂移的类型层闸)。落盘/透传侧 (LeafResult / NodeCheckpoint) 用宽的 LeafWatchdog。
 */
export type LiveLeafWatchdog = LeafWatchdog & Required<Pick<LeafWatchdog, 'advisorFiredAt' | 'wrapupFiredAt' | 'abortedByGrind'>>;

export interface AgentLeafResult {
  text: string;
  usage: ModelUsage;
  /**
   * 本次调用**脚手架**的版本哈希(2026-07-31)—— 进 Langfuse 的 `promptVersion`。
   *
   * 为什么由 runner 报而不是让 executor 从 prompt 反算:runner 按本次模型档在三套脚手架里挑
   * (strong-core / discipline+tool-routing / off),挑了哪套只有它自己知道;而整条 prompt 里
   * 含本节点的 goal 与上游材料,**逐节点都不同** —— 拿它算出来的"版本"每个节点一个值,
   * 分不了组,等于没有版本。省略 = 不登记版本(inproc leaf 那条路由 system 段算,见 promptVersionOf)。
   */
  promptVersion?: string;
  /** 本次 leaf 经 write/edit 族工具触碰的文件(continuity 接缝;去重)。**相对路径的根见 cwd。** */
  filesTouched?: string[];
  /**
   * 本次 leaf 经 **read 族工具**读过的文件(D-12,与 filesTouched 同形、同一个 cwd 根)。
   *
   * 为什么要它: `filesTouched` 只记**写**,于是"B 读了 A 写的文件但图上没有 A→B 这条边"这类
   * **图外数据流**在引擎眼里完全不存在 —— 制品级毒因此只抓得到写方(而写方本来就已被指纹票抓到),
   * 真正抓不到的消费方 B 恰恰是唯一的增量(SDD D-12)。有了它,`plan/artifact-lint` 才报得出
   * 「未声明的制品依赖」,复用滤镜才拦得住「读过被拒制品的节点」(INV-P2-4/5)。
   *
   * ⚠ **诚实边界**: 只收单文件读工具(`read` / `hashline_read`)。`grep`/`ls`/`glob` 是**检索**不是
   * 消费,把它们记进来会让 lint 淹在噪声里(一次 grep 命中十个文件不等于依赖那十个文件)。
   * bash 里的 `cat` 同样收不到 —— 与 filesTouched 漏 bash 重定向是同一条已知边界。
   */
  filesRead?: string[];
  /**
   * filesTouched 里相对路径的**解析根** = 本 runner 的 cwd。
   *
   * 为什么必须由结果自己带: 产物校验闸原本拿 `continuity?.repoRoot ?? process.cwd()` 当根 ——
   * 而 agent runner 的 cwd 可以是任意目录 (worktree / 子项目)。两者不一致时, 闸拿错根去查存在性,
   * **把写对了文件的节点判成 empty-done**, 下游整片级联 skip。2026-07-26 实测复现:
   * filesTouched=["eval-app/src/board.ts"] 文件真在 worktree 里, 闸却按 omd 仓根查 → 误杀。
   * 省略 = 调用方回落老行为。
   */
  cwd?: string;
  /**
   * 本次 leaf 的工具调用次数 (按 tool_execution_start 计)。**prompt 档的路由效率读数** ——
   * 工具路由那一段教的就是"该用 codegraph 时别拿 grep 凑", 而档位改动的效果只有在这个量上
   * 才看得见 (同样过闸, 调了 8 次工具还是 30 次, 差的是钱和墙钟)。省略 = 该 runner 不统计。
   */
  toolCalls?: number;
  /** 早期心跳闸判定的停摆(issue #5): provider 挂起/排队, 未等满硬超时即中止。executor 据此标 failed +
   *  留 stall 败因(而非把近零输出当 done)。省略/false = 正常完成或硬超时。 */
  stalled?: boolean;
  /**
   * 空转熔断理由(2026-08-14, drift fuse)。非空 = 循环被熔断闸硬停(软注入没拉回来的深度空转),
   * executor 据此标 failed + `spin-fused` 败因。省略 = 没熔断。与 `stalled` 分开:那是 provider
   * 没反应,这是模型有反应地原地打转 —— 下一步相反(见 node-failure 的 spin-fused 注)。
   */
  spinFused?: string;
  /**
   * agent leaf watchdog 采集 (2026-08-12, S1 埋点)。形状与缺席语义的真源 = {@link LeafWatchdog};
   * 生产侧取恒写收紧版 {@link LiveLeafWatchdog} (grind 三字段 required, INV-5)。
   */
  watchdog?: LiveLeafWatchdog;
  /**
   * 本次 leaf 的空转累计 (2026-08-03, G5)。缺席 = 没跑 drift 检测 (关掉了 / 非 agent leaf)。
   *
   * **以数据回传而不是回调**: drift 的 `onSpinning`/`onRecovered` 是函数, 而隔离档的 leaf
   * 跑在 bwrap 子进程里, 只有 JSON 安全的东西过得了那道边界 —— 那两个回调在隔离档上
   * 结构性接不了, 这就是它们至今零消费者的原因。本字段是频率读数; 停机语义在 `spinFused`
   * (2026-08-14 起, 读数收够后由熔断闸接)。
   */
  spin?: { spinEvents: number; maxSameCount: number; stuckSigs: string[] };
  /**
   * **效果指标** (2026-07-31, 承 Loop Engineering §8.5「静默失败」)。省略 = 该 runner 不统计。
   *
   * `filesTouched` 回答的是「碰过哪些文件」, 而 §8.5 指出那还不够:
   *
   * > 工具调用确确实实发生了, 返回码也是成功的, **但产出物没有任何实质变化** …… 比如 agent
   * > "修改"了一个文件, 但写入的内容和原文件完全一致。这类失败连"报错"这个最基本的警报信号都没有。
   *
   * 我们已经为这条链付过两次账, 每次都只补深一级:
   *   2026-07-29 —— 补「文件**真在盘上**」(反捏造判词打在真做完的活上)
   *   2026-08-03 S1 —— 补「文件**里写了什么**」(judge 看不见内容 → 内容验收类目标倾向永不收敛)
   * 第三级就是这一条: **写进去的和原来一样, 等于没写**。前两级都拦不住它 —— 文件在、内容也在,
   * 只是这次调用什么都没改变。
   *
   * 只报不判: 本字段不参与产物闸的通过与否 (一次 no-op 写完全可能是正当的 —— 上一轮已经写对了、
   * 这一轮复核了一遍)。它的用途是**让"看起来做了"和"真的做了"在读数上分得开**, 判要不要因此
   * 判失败, 得先有分布。
   */
  writeEffects?: FileWriteEffect[];
  /**
   * 本次 leaf 的**工具调用序列**(按发生顺序,2026-08-16)。省略 = 该 runner 不统计。
   *
   * 有界:超过 {@link TOOL_STEPS_CAP} 时保**头 + 尾**(同 `failureExcerpt` 的截断口径 ——
   * 中间截掉是因为两头才是诊断要看的:开头是它怎么起手,结尾是它卡在哪)。
   * 截了多少写在 {@link AgentLeafResult.toolStepsDropped},**不许静默截断**。
   */
  toolSteps?: ToolStep[];
  /** 被截掉的步数。缺席/0 = 没截。有值时 `toolSteps` 是头尾拼的,中间不连续。 */
  toolStepsDropped?: number;
  /**
   * 本次 leaf 经 **bash 工具**跑过的命令 + 退出码(2026-08-05)。省略 = 该 runner 不统计。
   *
   * 为什么补这条: agent leaf 手里有 bash,「我跑了 `bun test`,3/3 通过」是**诚实自验**的
   * 主要形状 —— 而引擎此前对它零记录(`toolCalls` 只有次数)。于是「产物声称的引擎校验动作 ⊆
   * 引擎记录的动作」这个谓词的**记录集缺了主要合法元素**,子集检查的误报是结构性的:
   * 真跑过测试的诚实节点与顺手编一句的节点,在引擎眼里长得一模一样。
   *
   * ⚠ `exitCode` 缺席 ≠ 0:命令被闸拒 / 起不来 / 平台没给退出码都是缺席,
   * 编一个 0 出来就是把"没记"伪装成"跑通了"。`ok` 由 exitCode===0 判,缺席即 false。
   */
  shellRuns?: ShellRun[];
  /**
   * **L0 写后即验注入了几条**(2026-08-16)。缺席/0 = 一条都没注(该 runner 不统计,
   * 或这个 leaf 从头到尾写的文件都解析得过)。
   *
   * 为什么要这个读数:这一层的收益是**避免掉的东西**(一次整节点冷重跑),
   * 而避免掉的东西不留痕 —— 不记它的话,"它起没起作用"事后无从判断。
   * 判法是把它与本节点的终态配起来看:
   *
   * | `parseNudges` | 节点终态 | 读法 |
   * |---|---|---|
   * | > 0 | done | **自愈成功**:一次冷重跑被省掉了(或者它本来就在分刀改 —— 见下方混淆项) |
   * | > 0 | `broken-artifact` | 注了但没修好 —— 硬闸照常接住,只多花了几十 token |
   * | 0 | `broken-artifact` | **这一层漏了** —— 损坏不是经受控写工具造成的(bash 重定向?),去看 `shellRuns` |
   *
   * ⚠ **混淆项要写在这**:「注了 + done」里分不出「它是被提醒才修的」与「它本来就要
   * 分两刀改、下一刀自然修好」。分开这两者需要节点内的因果,而那是 `toolSteps` 的活。
   * 所以这一格**不许**被读成"省下了 N 次重跑" —— 它是上界不是点估计。
   */
  parseNudges?: number;
}
/** 一次 bash 工具调用的确定性痕迹(命令原文 + 退出码)。 */
export interface ShellRun {
  /** 命令原文(截断防爆;截断标注见 executor 的 facts 渲染)。 */
  command: string;
  /** 内核给的退出码。**缺席 = 没拿到**(闸拒 / 起不来 / 被中止),不是 0。 */
  exitCode?: number;
  /** `exitCode === 0`。缺席的退出码一律 false —— 不许把"没记"读成"跑通了"。 */
  ok: boolean;
}
/** 一次成功的写调用**实际改变了什么**(§8.5 效果指标)。 */
export interface FileWriteEffect {
  /** 写的目标路径(与 filesTouched 同一个 cwd 根)。 */
  path: string;
  /** 写后行数 − 写前行数。文件此前不存在 → 写前按 0 行算(于是新建文件的 delta = 全文行数)。 */
  lineDelta: number;
  /**
   * 写完之后内容与写之前**逐字相同** = 这次调用什么都没做。
   *
   * ⚠ 新建一个**空文件**也是 `noop: false`(此前不存在 → 现在存在, 那是真变化)。
   * 判据是「内容变没变」, 不是「delta 是不是 0」—— 换掉同样多的行, delta = 0 而 noop = false。
   */
  noop: boolean;
}
/**
 * 一步工具调用的**确定性痕迹**(2026-08-16,#145 提议 2 复盘补的那一位)。
 *
 * ## 为什么这一位非补不可
 *
 * 已有的三本账各答各的,**没有一本答得了"它按什么顺序做了什么"**:
 * `toolCalls` 只有次数 · `watchdog.toolTimelineMs` 只有时间戳没有名字 ·
 * `drift.stuckSigs` 只在**空转时**才有签名。于是下面这些问题今天结构上答不出来:
 *
 * - **hashline stale 之后有没有重新接地**。`hashline.ts:16` 是 **fail-soft** 的:
 *   stale 标签被拒只返一段文本,靠 `hashline.ts:66` 那条 prompt 规则叫模型
 *   「STOP,重 hashline_read 接地,别在没重读的输出上继续叠行号编辑(会复合腐烂)」——
 *   而本仓已有**五个** "prompt 规则按不住" 的实例。判据的可执行版就是一句序列判断:
 *   *「这个节点里出现了 `hashline_edit` 的 noop,而此后没有一次 `hashline_read` 就又发了 edit」*
 *   —— 零启发式、零模型判断,但它**要求知道顺序**,而顺序今天没人记。
 * - **§8.5 那条攒了一年的分布**(`leaf-runners.ts` 的 `writeEffects` 注:「要不要因此判失败,
 *   得先有分布」)。今天只有 `[写调用数, noop 数]` 两个标量,分不出"复核了一遍"(正当)
 *   与"被 stale 连拒三次"(病)—— 而这两者的下一步正相反。
 *
 * ## 只记**看得见**的,不记推断
 *
 * 工具名与路径都取自 pi 的 `tool_execution_start/end` 事件原文;`noop` 取自同一次调用的
 * `diffWriteEffect`。**不猜**:非读写工具没有 `path`(bash 的写目标是另一条链的活)。
 */
/**
 * 工具序列上限(头 300 + 尾 100)。实测量级:run C 单节点最多 125 步、空转熔断那次 84 步 ——
 * 400 足够装下正常与病态两类,而不至于让一次跑飞的节点把 checkpoint 撑爆。
 */
export const TOOL_STEPS_CAP = 400;
/** 截断时保留的头部步数(尾部 = `TOOL_STEPS_CAP - TOOL_STEPS_HEAD`)。 */
export const TOOL_STEPS_HEAD = 300;

export interface ToolStep {
  /** 工具名原文(`bash` / `read` / `hashline_read` / `hashline_edit` / `write` / `edit` / …)。 */
  tool: string;
  /** 目标路径。读写工具才有;`hashline_edit` 一个 patch 多文件时取第一个(全集在 filesTouched)。 */
  path?: string;
  /** 这次调用报错了(pi 的 `isError`)。**缺席 = 没报错**,不是"不知道"。 */
  error?: boolean;
  /**
   * 写工具专用:写完之后内容与写前**逐字相同**。
   * ⚠ 这正是 hashline stale 被拒的指纹 —— 工具返回"成功"(fail-soft 返文本),而盘上没动。
   */
  noop?: boolean;
}

/** 注入点:executor-dag 的 agent-kind 节点经此跑。 */
export type AgentLeafRunner = (input: AgentLeafInput) => Promise<AgentLeafResult>;

// ── command leaf(确定性 CLI,零 LLM)────────────────────────────────
export interface CommandLeafInput {
  /** 要跑的 CLI 命令串(conductor 产出,经闸+白名单校验)。 */
  command: string;
}
export interface CommandLeafResult {
  text: string;
  usage: ModelUsage;
  exitCode: number;
}
/**
 * 注入点:executor-dag 的 command-kind 节点经此跑。
 *
 * ⚠ **实现方不许在这后面加缓存**(2026-08-01,量过之后删掉了原来那个):同一命令串必须每次真跑。
 * 判据与实测读数见 `command-leaf.ts` 里 `CommandLeafRunnerOpts` 下方那段注 + 图鉴 S-9。
 */
export type CommandLeafRunner = (input: CommandLeafInput) => Promise<CommandLeafResult>;

// ── research leaf(真 web 检索 + 有界内环的研究节点)──────────────────
export interface ResearchLeafInput {
  /** 研究问题 (= 节点 goal, 已含 fan-in 上下文)。 */
  question: string;
  /** 上游节点输出当事实锚 (防幻觉); 省略 = 只有问题本身。 */
  groundTruth?: string;
  /** 镜头数上限 (广度旋钮)。 */
  k?: number;
  /** second-pass 轮数上限 (**有界内环** — INV-GOAL-4: 节点内环必须有界)。 */
  rounds?: number;
  /** 镜头分解: 缺省/true = conductor 按问题自适应出镜头; false = 固定档 (省一次分解调用)。 */
  council?: boolean;
  /** 深档: 种子 query 作者化 (3-4 个互补角度各自检索) + provider 池全并行去重。默认关。 */
  deep?: boolean;
  /**
   * S2 (2026-08-10): 报告文件名基准 —— dag_research 进程化后 runId 由调用方 (母进程) 生成,
   * 透传下来让报告与 registry runId 同源 (一 run 两 id 必漂)。省略 = 内部自造 (executor
   * research 节点原语义, 零变化)。
   */
  runId?: string;
}
export interface ResearchLeafResult {
  /** 研究终稿正文 (进下游节点的 fan-in)。 */
  text: string;
  usage: ModelUsage;
  /**
   * **真抓到正文的 URL** (INV-GOAL-2 的证据面)。空数组 = 没有任何真检索痕迹 →
   * executor 判 failed, 拒绝"引用来自模型记忆"的假 grounded 通过。
   */
  sources: string[];
  /** 报告全文落盘路径 (宽出: 节点输出只带终稿, 细节自己 Read)。 */
  reportPath?: string;
}
/** 注入点:executor-dag 的 research-kind 节点经此跑。未注入 = research 节点判 failed (不静默降级)。 */
export type ResearchLeafRunner = (input: ResearchLeafInput) => Promise<ResearchLeafResult>;

// ── leaf 模型路由(ε-greedy bandit;静态 fallback = no-op)──────────────
export interface LeafModelRouter {
  /** 给 bucket 选模型坐标;pool 空/单 → 返 fallback(no-op = 静态)。 */
  select(bucket: string, fallback: string, category?: string): string;
  /** 记一次 reward(∈[0,1])给 (bucket, model);pool ≤1 或 model ∉ pool → no-op。 */
  recordReward(bucket: string, model: string, reward: number): void;
}
