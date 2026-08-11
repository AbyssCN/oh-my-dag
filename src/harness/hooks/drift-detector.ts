/**
 * drift-detector —— omd L0 自检: 检测 agent 在工具调用上 spinning (相同模式重复),
 * 经 `context` 事件注入 stuck-checklist 引导模型换策略 (SDD §11.2 `tool_call` 行 / GP-4)。
 *
 * 机制:
 *   ① per-session ring buffer 记 tool_call 签名 (toolName + 参数键; bash 含命令前缀)。
 *   ② 相同签名在 buffer 内出现 ≥ threshold 次 → spinningDetected = true。
 *   ③ 下次 `context` 事件 (LLM call 前) → 注入 caveman 斗模式 stuck-checklist 作为 user 消息。
 *   ④ agent_start 重置所有状态。
 *
 * fail-open 侧: 无 config/null config → inert, 不影响正常流程。
 * 默认阈值 4 次相同签 → 标记 spinning (覆盖实验: read+read+read+read; bash+bash+bash+bash)。
 */
import { logger } from '../../logger';
import { hashlinePatchPaths } from '../hashline';

export interface DriftDetectorConfig {
  /** 签名环形缓冲区容量。默认 20。*/
  maxSlots?: number;
  /** 相同签名出现 ≥ N 次触发 spinning。默认 4。*/
  threshold?: number;
  /**
   * 注入后是否每轮持续重注 (default **false**, 2026-06-03 修 context 膨胀):
   *   false = 检出 spin → 注一次 → 重置 flag。模型仍 spin (ring 仍 ≥阈值同 sig) 则下次重新检出再注;
   *           模型脱离 spin (sig 变了) 则不再注 → 无膨胀。这是想要的边沿行为。
   *   true  = flag 置位后只 agent_start 才清 → 即便脱离 spin 也每轮注 (会堆消息, 不推荐)。
   */
  repeatedInjection?: boolean;
  /**
   * 检出 spinning 时回调 (复利自学习 seam): 把 drift 事件发给 RuntimeSignalBus 持久化 →
   * dream consolidate 成 omd.limit/pattern fact。省略 = 不发 (纯 in-session 拦截, 不学习)。
   */
  onSpinning?: (info: { sig: string; sameCount: number }) => void;
  /**
   * **从 spinning 恢复**时回调 (复利自学习 producer #5 = `hard_problem` 的正解, clean_completion/
   * hard_problem 的高价值版本)。卡在 stuckSig 后, agent 做了 ≥ recoveryThreshold 个**不同**的新动作
   * (打破循环 = 真换了打法继续推进) → 发"难题已解开"信号, payload 带 {卡在什么, 怎么逃出}。
   * dream 学成 omd.pattern {situation:卡在X, approach:换成Y, outcome:worked} —— 正向 worked 食材喂 miner。
   * **精度优先** (≥2 distinct 而非 1): 宁可漏掉些恢复, 不把"探一下又卡回去"误判成恢复。每个 spin 回合至多发一次。
   */
  onRecovered?: (info: { stuckSig: string; escapeSigs: string[] }) => void;
  /** 恢复判定: spinning 后出现 ≥N 个不同的非-stuck 签名 = 打破循环。默认 2 (精度优先)。 */
  recoveryThreshold?: number;
}

const DEFAULT_MAX_SLOTS = 20;
const DEFAULT_THRESHOLD = 4;
const DEFAULT_RECOVERY_THRESHOLD = 2;

/**
 * 剥掉命令前导的 `cd <路径> &&` 链 —— **cd 段不是"这次在干什么", 是"在哪儿干"**。
 *
 * 2026-08-11 run 7d50fda2: 隔离 worktree 里叶子每条 bash 都写成
 * `cd /home/nick/repos/oh-my-dag/.omd/runs/<uuid> && <真命令>`, 而光 cd 段就 76 字符 >
 * 下面那个 50 字符窗口 → **全部 bash 命令并成同一个签名**, 12 条不同命令被报成空转 ×12。
 * 与 hashline_edit 那条 (2026-08-10, 落键名兜底把所有 patch 并成一个签名) 是同一种病:
 * 签名窗口落在了对所有调用都相同的那一段上。
 */
function stripCdPrefix(cmd: string): string {
  let out = cmd.trimStart();
  // 链式 `cd a && cd b && 真命令` 逐段剥 (`;` 同理); 路径里不含 `&|;` 是这条正则的前提,
  // 不成立时不剥 —— 剥错比不剥坏 (会把真命令的头吃掉)。
  for (;;) {
    const next = out.replace(/^cd\s+[^&;|]+?\s*(?:&&|;)\s*/, '');
    if (next === out) return out;
    out = next;
  }
}

/**
 * 从一次工具调用计算归一化签名。含目标参数值 (不含 transient 字段如 timeout)。
 *
 * 入参是 **(工具名, 参数对象)** 而不是某个宿主的事件类型 —— 检测逻辑与"事件长什么样"无关,
 * 而两个宿主 (agent leaf 的低层循环 / 交互 TUI 的 extension) 的事件字段名恰好不同
 * (`args` vs `input`)。绑死其中一个, 另一个就得再抄一份, 而抄出来的那份迟早先漂。
 */
export function computeSig(toolName: string, input: unknown): string {
  const args = (input ?? {}) as Record<string, unknown>;
  // bash: 命令前缀比参数键更区分是否 spinning
  if (toolName === 'bash') {
    const cmd = typeof args.command === 'string' ? args.command : '';
    const prefix = stripCdPrefix(cmd.replace(/[\n\r]/g, ' ')).slice(0, 50);
    return `bash:${prefix}`;
  }
  // read/write/edit/grep/ls/find: 含目标路径或模式第一参数
  const path = args.file_path ?? args.path ?? args.pattern;
  if (typeof path === 'string' && path.length > 0) {
    return `${toolName}:${path.slice(0, 60)}`;
  }
  // hashline_edit/read: 参数是 patch/内容文本, 无 file_path —— 落键名兜底会把**所有**调用并成
  // 一个签名 `hashline_edit:patch` (2026-08-10 S2/S3 实测: 连改 4 刀即误报 spinning, 单 run 20 次)。
  // 从 ¶PATH#TAG 头取首个目标文件做签名 —— 提取用 hashline 的单真源, 不抄第二份正则。
  const patch = args.patch ?? args.content;
  if (typeof patch === 'string') {
    const target = hashlinePatchPaths(patch)[0];
    if (target) return `${toolName}:${target.slice(0, 60)}`;
  }
  const keys = Object.keys(args).sort().join(',');
  return `${toolName}:${keys}`;
}

/** stuck-checklist 文本 (omd caveman 斗模式)。*/
const STUCK_CHECKLIST = `⚠️ [omd/drift] 检测到工具调用模式重复, 疑似 spinning。自检:
① root cause 真复现了吗?
② 手上是根因还是症状?
③ 同类先例查了吗 (codegraph / recall)?
④ 换个认知模式试试?
⑤ 卡 3 次以上 → 输出当前认知+已试方案, 寻求新方向。`;

/**
 * 检测核 —— **与宿主无关的状态机**。宿主只需在每次工具调用后 `note()`, 在每次 LLM 调用前
 * `takeInjection()`; 返回非 null 就把那段文本作为一条 user 消息注进去。
 */
export interface DriftTracker {
  /** 记一次工具调用 (spinning 判定 + 恢复判定都在这里推进)。 */
  note(toolName: string, input: unknown): void;
  /** 本次 LLM 调用前是否要注 stuck-checklist; 要注则返文本 (并按 repeatedInjection 复位)。 */
  takeInjection(): string | null;
  /** 新一轮 agent 开始 (清全部状态)。 */
  reset(): void;
  /**
   * 本次 leaf 至今的空转累计 (2026-08-03, G5)。
   *
   * **为什么是数据而不是回调**: `onSpinning`/`onRecovered` 是函数, 而隔离档的 leaf 跑在
   * bwrap 子进程里, opts 只透传 **JSON 安全**的部分 (`sandboxed-leaf.ts` 的 `serializableOpts`
   * 明确剔除函数)。也就是说那两个回调在隔离档上**结构性接不了** —— 这就是为什么它们至今
   * 零消费者: 不是忘了接, 是那条路上接不了。信号要出 leaf, 只能随结果**以数据形式**回来。
   *
   * ⚠ 只报不数: 这里给的是频率读数, **不带任何停机语义**。要不要把它升成 BLOCKED、K 取几,
   * 得先有"它在真跑上多久命中一次"的读数 —— 那正是这个字段存在的理由 (同 observations 的注)。
   */
  summary(): DriftSummary;
}

/** 一次 leaf 的空转累计 —— 只报不拦, 进 `observations` 当频率读数。 */
export interface DriftSummary {
  /** 检出 spinning 的回合数 (卡住→逃出算一回合)。 */
  spinEvents: number;
  /** 单个签名在环里重复的最高次数 —— 卡得多深。 */
  maxSameCount: number;
  /** 卡住过的签名 (去重, 截断保平); 排障时"卡在什么上"比"卡了几次"更有用。 */
  stuckSigs: string[];
}

/** 造一个 drift 检测核 (per-session 状态; 每个 leaf / session 建一份)。 */
export function createDriftTracker(config: DriftDetectorConfig = {}): DriftTracker {
  const maxSlots = config.maxSlots ?? DEFAULT_MAX_SLOTS;
  const threshold = config.threshold ?? DEFAULT_THRESHOLD;
  const repeatedInjection = config.repeatedInjection ?? false;
  const recoveryThreshold = config.recoveryThreshold ?? DEFAULT_RECOVERY_THRESHOLD;

  let ring: string[] = [];
  let spinningDetected = false;
  // 空转累计 (G5 读数, 只报不拦) —— 跨 reset **不清**: 它量的是"这个 leaf 整场卡了多少",
  // 而 reset 是每轮 agent 开始时清环用的; 跟着清就只剩最后一轮, 那不是要问的问题。
  let spinEvents = 0;
  let maxSameCount = 0;
  const stuckSigsSeen: string[] = [];
  // 恢复追踪 (producer #5): 卡在 stuckSig 后, 收集打破循环的不同新签名。
  let stuckSig: string | null = null;
  let escapeSigs: string[] = [];
  let recoveryEmitted = false; // 每个 spin 回合至多发一次恢复

  return {
    reset() {
      ring = [];
      spinningDetected = false;
      stuckSig = null;
      escapeSigs = [];
      recoveryEmitted = false;
      // ⚠ spinEvents / maxSameCount / stuckSigsSeen **刻意不清** —— 见 DriftTracker.summary 的注。
    },

    summary() {
      return { spinEvents, maxSameCount, stuckSigs: [...stuckSigsSeen] };
    },

    note(toolName, input) {
      const sig = computeSig(toolName, input);

      ring.push(sig);
      if (ring.length > maxSlots) ring.shift();

      if (!spinningDetected) {
        const sameCount = ring.filter((s) => s === sig).length;
        if (sameCount >= threshold) {
          spinningDetected = true;
          // G5 读数累计 (只报不拦): 回合数 + 卡得多深 + 卡在什么上。
          spinEvents++;
          if (sameCount > maxSameCount) maxSameCount = sameCount;
          if (!stuckSigsSeen.includes(sig) && stuckSigsSeen.length < 12) stuckSigsSeen.push(sig);
          // 新 spin 回合: 记住卡在什么, 重置恢复窗口 (即便上回合已恢复, 这次又卡了 = 新难题)。
          stuckSig = sig;
          escapeSigs = [];
          recoveryEmitted = false;
          logger.warn({ toolName, sig, sameCount, ringSize: ring.length }, '[omd/drift] spinning detected');
          // 复利自学习 seam: 发 drift 事件给 bus 持久化 → dream 学成 omd.limit。回调抛不阻断检测。
          try {
            config.onSpinning?.({ sig, sameCount });
          } catch (err) {
            logger.warn({ err: (err as Error).message }, '[omd/drift] onSpinning callback threw');
          }
        }
      }

      // 恢复追踪: 卡过 (stuckSig) 且本回合未发过恢复 → 收集打破循环的不同新签名。
      if (stuckSig !== null && !recoveryEmitted && sig !== stuckSig && !escapeSigs.includes(sig)) {
        escapeSigs.push(sig);
        if (escapeSigs.length >= recoveryThreshold) {
          recoveryEmitted = true;
          const recovered = { stuckSig, escapeSigs: [...escapeSigs] };
          logger.info(recovered, '[omd/drift] recovered from spinning (hard_problem 信号)');
          try {
            config.onRecovered?.(recovered);
          } catch (err) {
            logger.warn({ err: (err as Error).message }, '[omd/drift] onRecovered callback threw');
          }
          stuckSig = null; // 回合结束, 等下一次 spin 才重开
        }
      }
    },

    takeInjection() {
      if (!spinningDetected) return null;
      // repeatedInjection=false 则注入一次后不再注 (true 持续监控)。
      if (!repeatedInjection) spinningDetected = false;
      return STUCK_CHECKLIST;
    },
  };
}
