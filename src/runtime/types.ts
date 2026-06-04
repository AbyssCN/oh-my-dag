/**
 * AgentRuntime port — valinor 控制平面与具体 agent runtime(数据平面)之间的隔离阀。
 *
 * 战略依据: docs/knowledge/research/valinor-runtime-sandbox-hosting-strategy-2026-05-29.md §4
 * (候选 ADR D61). dispatcher / DAG / event-stream 只认这个接口, 不认具体 runtime。
 *
 *   今天可有的实现:
 *     - PiRuntime          (in-process, Pi SDK, own the loop)   ← src/runtime/pi-runtime.ts
 *     - ClaudeCodeRCRuntime(包现有 rc-client, plan-B 双 adapter) ← 后续 step
 *
 * 设计约束 (M2 first-principles, 保持最小):
 *   - 零依赖: 本文件不 import 任何 runtime, 这样只引用接口的 valinor 代码不会强拉 Pi。
 *   - taskId 贯穿每个事件 → 多任务时调用方按 taskId 路由到 event-stream / DB。
 *   - 单事件总线 (onEvent) + 解订阅闭包, 跟 Pi `session.subscribe` 同形状, 映射零摩擦。
 */

/** 规整后的运行时事件 —— valinor 内部只认这套, 与具体 runtime 解耦。 */
export type RuntimeEvent =
  | { type: 'text'; taskId: string; delta: string }
  | { type: 'tool_start'; taskId: string; tool: string; args: unknown }
  | { type: 'tool_end'; taskId: string; tool: string; isError: boolean; result: unknown }
  | { type: 'turn'; taskId: string }
  | { type: 'done'; taskId: string }
  | { type: 'error'; taskId: string; message: string };

/** runtime 无关的 thinking 档位 (各 runtime 内部自行 clamp 到模型能力)。 */
export type ThinkingLevel = 'off' | 'low' | 'medium' | 'high' | 'xhigh';

/** 单次 dispatch 的可选覆盖项。 */
export interface DispatchOptions {
  /**
   * pi-ai provider id (如 'deepseek' / 'xiaomi-token-plan-ams' / 'anthropic')。
   * 省略则用 runtime 构造期 provider。配合 {@link model} 实现 per-node 模型路由
   * (DAG 节点 node.model = 'provider:modelId', 经 fleet.parseModelRef 拆 → 此处)。
   */
  provider?: string;
  /** 模型 id (如 'claude-opus-4-8' / 'deepseek-v4-flash'); 省略则用 runtime 默认。 */
  model?: string;
  /** thinking 档位; 省略则用 runtime 默认。 */
  thinkingLevel?: ThinkingLevel;
}

/**
 * 一个能跑 agent 任务的运行时。控制平面对它的全部期望就这四件事。
 */
export interface AgentRuntime {
  /** 实现标识, 用于路由 / 日志 (如 'pi' | 'cc-rc')。 */
  readonly kind: string;

  /**
   * 派一条任务给 runtime。resolve = 这一轮 prompt 跑完 (events 已经流过 onEvent)。
   * 流式输出 + 工具执行 + 结束都通过 {@link onEvent} 推出, 带 taskId。
   */
  dispatch(taskId: string, prompt: string, opts?: DispatchOptions): Promise<void>;

  /** 订阅事件流。返回解订阅闭包。 */
  onEvent(cb: (e: RuntimeEvent) => void): () => void;

  /** 中断指定任务 (当前实现以 session 粒度中断正在跑的那条)。 */
  interrupt(taskId: string): Promise<void>;

  /** 释放底层资源 (session / socket)。 */
  dispose(): Promise<void>;
}
