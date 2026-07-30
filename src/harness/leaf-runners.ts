/**
 * 叶执行注入接缝(INV-X1/X3):executor-dag 只认这些**接口形状**,不 import 任何执行实现。
 * 形状 = 私有上游 agent-leaf.ts / command-leaf.ts / model-router.ts 的公开契约原样
 * (provenance: 私有上游 worktree 时点)。
 * 实现方:宿主注入 pi-agent runner;或生产侧注入
 * omd-pi provider runner(随 provider slice)。测试注入 fake。
 */
import type { ModelUsage } from '../model/gateway';

// ── agent leaf(带工具的 pi session,能改文件)────────────────────────
export interface AgentLeafInput {
  /** 完整执行 prompt(已含 node 目标 + fan-in 上下文)。 */
  prompt: string;
  /** 'provider:modelId'。 */
  model: string;
}
export interface AgentLeafResult {
  text: string;
  usage: ModelUsage;
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
/** 注入点:executor-dag 的 command-kind 节点经此跑。 */
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
