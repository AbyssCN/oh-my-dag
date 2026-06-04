/**
 * drift-detector —— wright L0 自检: 检测 agent 在工具调用上 spinning (相同模式重复),
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
import type { ExtensionFactory, ToolCallEvent } from '@earendil-works/pi-coding-agent';
import { logger } from '../../logger';

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
   * dream consolidate 成 wright.limit/pattern fact。省略 = 不发 (纯 in-session 拦截, 不学习)。
   */
  onSpinning?: (info: { sig: string; sameCount: number }) => void;
  /**
   * **从 spinning 恢复**时回调 (复利自学习 producer #5 = `hard_problem` 的正解, clean_completion/
   * hard_problem 的高价值版本)。卡在 stuckSig 后, agent 做了 ≥ recoveryThreshold 个**不同**的新动作
   * (打破循环 = 真换了打法继续推进) → 发"难题已解开"信号, payload 带 {卡在什么, 怎么逃出}。
   * dream 学成 wright.pattern {situation:卡在X, approach:换成Y, outcome:worked} —— 正向 worked 食材喂 miner。
   * **精度优先** (≥2 distinct 而非 1): 宁可漏掉些恢复, 不把"探一下又卡回去"误判成恢复。每个 spin 回合至多发一次。
   */
  onRecovered?: (info: { stuckSig: string; escapeSigs: string[] }) => void;
  /** 恢复判定: spinning 后出现 ≥N 个不同的非-stuck 签名 = 打破循环。默认 2 (精度优先)。 */
  recoveryThreshold?: number;
}

const DEFAULT_MAX_SLOTS = 20;
const DEFAULT_THRESHOLD = 4;
const DEFAULT_RECOVERY_THRESHOLD = 2;

/** 从 tool_call 事件计算归一化签名。含目标参数值 (不含 transient 字段如 timeout)。*/
function computeSig(event: ToolCallEvent): string {
  // bash: 命令前缀比参数键更区分是否 spinning
  if (event.toolName === 'bash') {
    const cmd = (event.input as { command?: string })?.command ?? '';
    const prefix = cmd.replace(/[\n\r]/g, ' ').slice(0, 50);
    return `bash:${prefix}`;
  }
  // read/write/edit/grep/ls/find: 含目标路径或模式第一参数
  const input = event.input as Record<string, unknown> | undefined;
  const path = input?.file_path ?? input?.path ?? input?.pattern;
  if (typeof path === 'string' && path.length > 0) {
    return `${event.toolName}:${path.slice(0, 60)}`;
  }
  const keys = Object.keys(input ?? {}).sort().join(',');
  return `${event.toolName}:${keys}`;
}

/** stuck-checklist 文本 (wright caveman 斗模式)。*/
const STUCK_CHECKLIST = `⚠️ [wright/drift] 检测到工具调用模式重复, 疑似 spinning。自检:
① root cause 真复现了吗?
② 手上是根因还是症状?
③ 同类先例查了吗 (codegraph / recall)?
④ 换个认知模式试试?
⑤ 卡 3 次以上 → 输出当前认知+已试方案, 寻求新方向。`;

/**
 * 造 drift-detector extension。每个 agent 循环内跟踪 tool_call 签名,
 * 检测 spinning 后经 context 事件注入 stuck-checklist。
 */
export function createDriftDetectorHook(config: DriftDetectorConfig = {}): ExtensionFactory {
  const maxSlots = config.maxSlots ?? DEFAULT_MAX_SLOTS;
  const threshold = config.threshold ?? DEFAULT_THRESHOLD;
  const repeatedInjection = config.repeatedInjection ?? false;
  const recoveryThreshold = config.recoveryThreshold ?? DEFAULT_RECOVERY_THRESHOLD;

  return (pi) => {
    // --- per-session 易变状态 ---
    let ring: string[] = [];
    let spinningDetected = false;
    // 恢复追踪 (producer #5): 卡在 stuckSig 后, 收集打破循环的不同新签名。
    let stuckSig: string | null = null;
    let escapeSigs: string[] = [];
    let recoveryEmitted = false; // 每个 spin 回合至多发一次恢复

    const reset = () => {
      ring = [];
      spinningDetected = false;
      stuckSig = null;
      escapeSigs = [];
      recoveryEmitted = false;
    };

    pi.on('agent_start', reset);

    pi.on('tool_call', (event, _ctx) => {
      const sig = computeSig(event);

      ring.push(sig);
      if (ring.length > maxSlots) ring.shift();

      if (!spinningDetected) {
        const sameCount = ring.filter((s) => s === sig).length;
        if (sameCount >= threshold) {
          spinningDetected = true;
          // 新 spin 回合: 记住卡在什么, 重置恢复窗口 (即便上回合已恢复, 这次又卡了 = 新难题)。
          stuckSig = sig;
          escapeSigs = [];
          recoveryEmitted = false;
          logger.warn(
            { toolName: event.toolName, sig, sameCount, ringSize: ring.length },
            '[wright/drift] spinning detected',
          );
          // 复利自学习 seam: 发 drift 事件给 bus 持久化 → dream 学成 wright.limit。回调抛不阻断检测。
          try {
            config.onSpinning?.({ sig, sameCount });
          } catch (err) {
            logger.warn({ err: (err as Error).message }, '[wright/drift] onSpinning callback threw');
          }
        }
      }

      // 恢复追踪: 卡过 (stuckSig) 且本回合未发过恢复 → 收集打破循环的不同新签名。
      if (stuckSig !== null && !recoveryEmitted && sig !== stuckSig && !escapeSigs.includes(sig)) {
        escapeSigs.push(sig);
        if (escapeSigs.length >= recoveryThreshold) {
          recoveryEmitted = true;
          const recovered = { stuckSig, escapeSigs: [...escapeSigs] };
          logger.info(recovered, '[wright/drift] recovered from spinning (hard_problem 信号)');
          try {
            config.onRecovered?.(recovered);
          } catch (err) {
            logger.warn({ err: (err as Error).message }, '[wright/drift] onRecovered callback threw');
          }
          stuckSig = null; // 回合结束, 等下一次 spin 才重开
        }
      }
      // 观察者模式: 不 block, 不放行 (返回 {} = pass through)。
      return {};
    });

    pi.on('context', (event, _ctx) => {
      if (!spinningDetected) return;
      const checklistMsg = {
        role: 'user' as const,
        content: [{ type: 'text' as const, text: STUCK_CHECKLIST }],
      };
      event.messages.push(checklistMsg as never);
      logger.debug('[wright/drift] stuck-checklist injected via context');
      // reportedInjection=false 则注入一次后不再注 (repeatedInjection=true 持续监控)。
      if (!repeatedInjection) spinningDetected = false;
      return { messages: event.messages };
    });
  };
}
