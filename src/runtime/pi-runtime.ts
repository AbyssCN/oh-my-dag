/**
 * PiRuntime — in-process agent runtime backed by the Pi SDK (own the loop).
 *
 * 战略依据: xihe-runtime-sandbox-hosting-strategy-2026-05-29.md §2 §4 (候选 ADR D61)。
 * 把 agent loop 收进 xihe 的 Bun 进程内 —— 无 tmux、无反向工程、无私有端点。
 * 取代 src/rc-client/ 那套逆向 Conductor 协议 (后者迁完即退役)。
 *
 * 实测对齐 (照 node_modules/@earendil-works/*.d.ts 写, 非文档摘要):
 *   - createAgentSession(options) → { session: AgentSession }
 *   - getModel('anthropic', 'claude-opus-4-8' | ...)   ← pi-ai 原生认识 4-5/4-6/4-7/4-8
 *   - session.subscribe(listener) → 解订阅闭包
 *   - session.prompt(text) → Promise<void> (跑完整一轮)
 *   - AgentSessionEvent 判别 union: message_update / tool_execution_* / turn_start / agent_end / auto_retry_end
 *
 * 范围 (M2, 保持最小): 单 AgentSession = 一次跑一条 task。多任务并发 = session 池
 * (Pi 的 createAgentSessionRuntime newSession/switchSession), 留作后续 step, 不在 keystone。
 */
import { join } from 'node:path';
import {
  createAgentSession,
  SessionManager,
  DefaultResourceLoader,
  getAgentDir,
  type AgentSession,
  type AgentSessionEvent,
  type ExtensionFactory,
} from '@earendil-works/pi-coding-agent';
import { getModel } from '@earendil-works/pi-ai';
import { logger } from '../logger';
import type { WrightController } from '../wright/controller';
import type { AgentRuntime, DispatchOptions, RuntimeEvent, ThinkingLevel } from './types';
import {
  installWrightHarness,
  buildAgentSystemPrompt,
  ccToolsToAllowlist,
  type WrightHarness,
  type AgentDef,
} from './harness';

/**
 * 默认 Opus 模型 id。可经构造参数 / XIHE_RUNTIME_MODEL 覆盖。
 * 注: 这里不硬编最新档, 由部署侧 (NAS) 设 env 选具体 Opus (如 claude-opus-4-8)。
 */
const DEFAULT_MODEL = 'claude-opus-4-5';
const DEFAULT_PROVIDER = 'anthropic';
const DEFAULT_THINKING: ThinkingLevel = 'medium';

/**
 * provider + model id → pi-ai Model。provider/model 来自 config/env (string),
 * 在此 runtime 边界处 cast 进 pi-ai 的依赖泛型 getModel(provider, keyof MODELS[provider])。
 * pi-ai 内建 31 provider (含 MiMo=xiaomi-token-plan-ams); apiKey 由 pi-ai 按
 * provider→env 映射 (getEnvApiKey) 自动解析, 调用方只需保证对应 env key 在。
 */
function resolveModel(provider: string, modelId: string) {
  return getModel(provider as Parameters<typeof getModel>[0], modelId as never);
}

export interface PiRuntimeOptions {
  /** 工作目录 (项目级 skill/extension/context 发现根)。默认 process.cwd()。 */
  cwd?: string;
  /** 模型 id。默认 DEFAULT_MODEL, 或 XIHE_RUNTIME_MODEL。 */
  model?: string;
  /** provider (pi-ai 31 内建之一, 如 'anthropic' | 'xiaomi-token-plan-ams')。默认 anthropic, 或 XIHE_RUNTIME_PROVIDER。 */
  provider?: string;
  /** thinking 档位。默认 medium。 */
  thinkingLevel?: ThinkingLevel;
  /** 启用 Wright harness (技能/身份/子代理 spawn_agent/hook 桥)。默认 false。 */
  harness?: boolean;
  /**
   * wright 本体 (灵魂 = code)。提供则此 runtime 作 controller 的 **daemon adapter** (SDD §4 V2.0):
   *   - provider / model / thinkingLevel 缺省取自 controller (而非 anthropic 默认)。
   *   - controller.toExtensionFactories() (含灵魂注入 extension) 经 DefaultResourceLoader 挂入 session。
   * 不提供则保持 V0/V1 行为 (anthropic 默认, 仅 harness 路径注入)。
   */
  controller?: WrightController;
}

/**
 * 纯函数: 把一个 Pi 事件映射成 xihe 的 RuntimeEvent (无副作用, 单测入口)。
 * 不关心的事件返回 null (由调用方丢弃)。
 */
export function mapPiEvent(event: AgentSessionEvent, taskId: string): RuntimeEvent | null {
  switch (event.type) {
    case 'message_update':
      // 流式文本增量包在 assistantMessageEvent 里。
      if (event.assistantMessageEvent.type === 'text_delta') {
        return { type: 'text', taskId, delta: event.assistantMessageEvent.delta };
      }
      return null;
    case 'tool_execution_start':
      return { type: 'tool_start', taskId, tool: event.toolName, args: event.args };
    case 'tool_execution_end':
      return {
        type: 'tool_end',
        taskId,
        tool: event.toolName,
        isError: event.isError,
        result: event.result,
      };
    case 'turn_start':
      return { type: 'turn', taskId };
    case 'agent_end':
      // willRetry=true → 这一轮没真结束 (auto-retry 会再跑); 不能提前报 done。
      // 真正终态由后续 willRetry=false 的 agent_end (或 auto_retry_end 失败) 给出。
      return event.willRetry ? null : { type: 'done', taskId };
    case 'auto_retry_end':
      // 自动重试最终失败才报错; 重试成功不产生错误事件。
      return event.success
        ? null
        : { type: 'error', taskId, message: event.finalError ?? 'agent run failed' };
    default:
      return null;
  }
}

/** AgentSession 中 helper 实际用到的最小面 (便于注入 fake 单测, 不依赖 live API)。 */
interface ScopedSessionLike {
  setModel(model: import('@earendil-works/pi-ai').Model<any>): Promise<void>;
  setThinkingLevel(level: ThinkingLevel): void;
  subscribe(listener: (e: AgentSessionEvent) => void): () => void;
  prompt(text: string): Promise<void>;
  dispose(): void;
  /** 中止当前 run (settle 流 stopReason='aborted' → prompt() resolve)。可选: fake/旧 session 无此方法。 */
  abort?(): Promise<void>;
  /** 是否注册了某扩展事件 handler。pi AgentSession 公开此面; fake/旧 session 无。 */
  hasExtensionHandlers?(eventType: string): boolean;
}

/**
 * dispose 一个 session, 但**先发 `session_shutdown` 扩展事件**, 再 `dispose()`。
 *
 * 根因 (D73 "agent-leaf e2e hang"): pi 低层 `AgentSession.dispose()` 只 abort + invalidate extension
 * runner, **从不发 session_shutdown** —— 只有高层 `AgentSessionRuntime.dispose()` 发 (interactive/print
 * 模式才走)。而 pi-lsp 等扩展把子进程清理 (`typescript-language-server` 经 SIGTERM/SIGKILL) 挂在
 * `pi.on("session_shutdown")` 上。我们走低层 `createAgentSession` + `session.dispose()` → 该事件永不发 →
 * LSP server child 永驻 → bun event loop 不 drain → agent leaf **做完事进程退不出** (外层只能 SIGKILL,
 * 表象 = "320s 超时", 实为完成后挂死, 非模型 tool-loop spin)。
 *
 * 修法: dispose 前手动发 session_shutdown (reason 'quit', 与高层 dispose 一致) → 触发扩展 teardown。
 * 无 handler (无扩展 / fake) → 跳过直接 dispose; emit 失败不阻断 dispose。每个 AgentSession 有独立
 * ExtensionRunner (factory per-session 重跑, pi-lsp manager 隔离) → 发本 session 的 shutdown 只杀本
 * session 起的 server, 不影响其它 leaf。
 */
export async function disposeSessionWithShutdown(session: ScopedSessionLike): Promise<void> {
  try {
    if (session.hasExtensionHandlers?.('session_shutdown')) {
      // extensionRunner.emit 的 pi 类型是泛型受约束 (RunnerEmitEvent), 与 ScopedSessionLike 的窄面有逆变冲突 →
      // 局部 cast 访问 (运行期真实 AgentSession 必有此 getter; fake session hasExtensionHandlers=false 不到这)。
      const runner = (session as { extensionRunner?: { emit(e: unknown): Promise<unknown> } }).extensionRunner;
      await runner?.emit({ type: 'session_shutdown', reason: 'quit' });
    }
  } catch (err) {
    logger.warn({ err: (err as Error).message }, '[pi-runtime] session_shutdown 发射失败, 仍 dispose');
  } finally {
    session.dispose();
  }
}

/**
 * 把单次 dispatch 的 {@link DispatchOptions} 真正落到 session 上 (修 _opts 被忽略的 bug)。
 * model 覆盖经 resolveModel(provider, …) 解析; **provider 也 per-dispatch 可覆盖**
 * (opts.provider > 构造期 provider) → DAG 节点级模型路由 (node.model='provider:modelId')
 * 能把 leaf 路由到 DeepSeek 而非构造期默认。thinkingLevel 直接 set。opts 省略某项 = 不动。
 */
export async function applyDispatchOptions(
  session: Pick<ScopedSessionLike, 'setModel' | 'setThinkingLevel'>,
  opts?: DispatchOptions,
  provider: string = DEFAULT_PROVIDER,
): Promise<void> {
  if (!opts) return;
  if (opts.model !== undefined) {
    // per-dispatch provider 覆盖构造期 provider (per-node 路由的接缝)。
    await session.setModel(resolveModel(opts.provider ?? provider, opts.model));
  }
  if (opts.thinkingLevel !== undefined) {
    session.setThinkingLevel(opts.thinkingLevel);
  }
}

/**
 * 在一个 scoped (一次性) session 上跑一条 prompt, 收集流式文本, **保证 dispose** (修 session 泄漏)。
 * subscribe 与 prompt 都在 try 内 → 任何一步抛错都走 finally 释放 session + 解订阅,
 * 不再有 "subscribe 之后、prompt 之前抛错 → session 悬挂" 的泄漏路径。
 */
export async function runScopedSession(
  session: ScopedSessionLike,
  fullPrompt: string,
  opts?: { timeoutMs?: number },
): Promise<string> {
  let out = '';
  let unsub: (() => void) | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let timedOut = false;
  try {
    unsub = session.subscribe((e) => {
      if (e.type === 'message_update' && e.assistantMessageEvent.type === 'text_delta') {
        out += e.assistantMessageEvent.delta;
      }
    });
    // 有界中止 (可靠性来自模型之外): 弱模型 agent loop 偶尔不干净退出 (写完产物后空转,
    // pi 无 maxTurns/timeout, prompt() 永不 resolve → 外部 SIGKILL)。超时 → abort() settle 流,
    // prompt() resolve, 返已累积 out。产物 (文件写) 通常已在 spin 前落盘, abort 在轮间安全。
    if (opts?.timeoutMs && opts.timeoutMs > 0 && session.abort) {
      timer = setTimeout(() => {
        timedOut = true;
        void session.abort?.();
      }, opts.timeoutMs);
    }
    await session.prompt(fullPrompt);
  } finally {
    if (timer) clearTimeout(timer);
    unsub?.();
    // 先发 session_shutdown 再 dispose: 否则 pi-lsp 的 language-server 子进程不被清理 → 进程挂死 (见 helper 注释)。
    await disposeSessionWithShutdown(session);
  }
  if (timedOut) {
    logger.warn({ timeoutMs: opts?.timeoutMs, outLen: out.length }, '[runScopedSession] leaf 超时中止 (有界 abort, 返已累积输出)');
  }
  return out;
}

export class PiRuntime implements AgentRuntime {
  readonly kind = 'pi';

  private readonly opts: PiRuntimeOptions;
  private session: AgentSession | null = null;
  private harness: WrightHarness | null = null;
  private unsubSession: (() => void) | null = null;
  private currentTaskId: string | null = null;
  private readonly listeners = new Set<(e: RuntimeEvent) => void>();

  constructor(opts: PiRuntimeOptions = {}) {
    this.opts = opts;
  }

  /** provider 解析: 构造参数 > controller > XIHE_RUNTIME_PROVIDER env > 默认 anthropic。 */
  private resolveProvider(): string {
    return (
      this.opts.provider ??
      this.opts.controller?.provider ??
      process.env.XIHE_RUNTIME_PROVIDER ??
      DEFAULT_PROVIDER
    );
  }

  /** model 解析: 构造参数 > controller > XIHE_RUNTIME_MODEL env > 默认 Opus。 */
  private resolveModelId(): string {
    return (
      this.opts.model ??
      this.opts.controller?.model ??
      process.env.XIHE_RUNTIME_MODEL ??
      DEFAULT_MODEL
    );
  }

  /** 懒初始化 session: 第一次 dispatch 才建, 之后复用 (保持 prompt cache 热)。 */
  private async ensureSession(): Promise<AgentSession> {
    if (this.session) return this.session;

    const provider = this.resolveProvider();
    const modelId = this.resolveModelId();
    const model = resolveModel(provider, modelId);
    const controller = this.opts.controller;

    const cwd = this.opts.cwd ?? controller?.cwd ?? process.cwd();

    // extensionFactories 来源: controller (灵魂注入 + wright 原生 fail-closed 闸)。
    // harness (技能/身份/子代理) 不贡献 extensionFactory —— hook 子进程桥已删 (V2-HOOK), 改原生经 controller。
    const extensionFactories: ExtensionFactory[] = [];
    if (controller) extensionFactories.push(...controller.toExtensionFactories());
    if (this.opts.harness && !this.harness) {
      this.harness = installWrightHarness({ cwd, spawn: (def, prompt) => this.spawnSubAgent(def, prompt) });
    }

    // 身份注入两条互补路径, 不重复:
    //   - controller present → 灵魂经 extensionFactories (before_agent_start) 注入 baked WRIGHT_IDENTITY。
    //   - 仅 harness          → 项目 CLAUDE.md 经 appendSystemPrompt 注入 (legacy, V0/V1 行为)。
    const appendCLAUDEmd = this.opts.harness && !controller && this.harness?.identity;

    let resourceLoader: DefaultResourceLoader | undefined;
    if (this.opts.harness || extensionFactories.length > 0) {
      resourceLoader = new DefaultResourceLoader({
        cwd,
        agentDir: getAgentDir(),
        ...(this.opts.harness ? { additionalSkillPaths: [join(cwd, '.claude', 'skills')] } : {}),
        ...(appendCLAUDEmd ? { appendSystemPrompt: [this.harness!.identity] } : {}),
        ...(extensionFactories.length ? { extensionFactories } : {}),
      });
      await resourceLoader.reload();
    }

    const { session } = await createAgentSession({
      cwd,
      model,
      thinkingLevel: this.opts.thinkingLevel ?? controller?.thinkingLevel ?? DEFAULT_THINKING,
      sessionManager: SessionManager.inMemory(),
      ...(resourceLoader ? { resourceLoader } : {}),
      ...(this.harness ? { customTools: this.harness.customTools } : {}),
    });

    this.session = session;
    this.unsubSession = session.subscribe((e) => this.handlePiEvent(e));
    logger.info(
      {
        kind: this.kind,
        provider,
        model: modelId,
        harness: !!this.harness,
        controller: !!controller,
        skills: this.harness?.skills.skills.length ?? 0,
      },
      '[runtime] pi session ready',
    );
    return session;
  }

  async dispatch(taskId: string, prompt: string, opts?: DispatchOptions): Promise<void> {
    const session = await this.ensureSession();
    this.currentTaskId = taskId;
    // 单次 dispatch 的 model / thinking 覆盖落到 session (修 opts 被忽略); 用 runtime 的 provider。
    await applyDispatchOptions(session, opts, this.resolveProvider());
    logger.debug({ taskId, model: opts?.model, thinkingLevel: opts?.thinkingLevel }, '[runtime] dispatch');
    await session.prompt(prompt);
  }

  onEvent(cb: (e: RuntimeEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  async interrupt(_taskId: string): Promise<void> {
    if (this.session) await this.session.abort();
  }

  async dispose(): Promise<void> {
    this.unsubSession?.();
    this.unsubSession = null;
    // 先发 session_shutdown 再 dispose: daemon 长驻 session 同样会泄漏 pi-lsp 子进程 (重启/换 workflow 时累积)。
    if (this.session) await disposeSessionWithShutdown(this.session);
    this.session = null;
    this.listeners.clear();
  }

  /** 嵌套 sub-agent: 独立 in-memory session, def 指令前置到 prompt。(live, NAS 验) */
  private async spawnSubAgent(def: AgentDef, prompt: string): Promise<string> {
    const modelId = this.opts.model ?? process.env.XIHE_RUNTIME_MODEL ?? DEFAULT_MODEL;
    const model = resolveModel(this.resolveProvider(), modelId);
    // def.tools (CC frontmatter allowlist) → pi tools allowlist; undefined = 继承全部。
    const tools = ccToolsToAllowlist(def.tools);
    const { session } = await createAgentSession({
      cwd: this.opts.cwd ?? process.cwd(),
      model,
      thinkingLevel: 'medium',
      sessionManager: SessionManager.inMemory(),
      ...(tools ? { tools } : {}),
    });
    // subscribe + prompt + dispose 收进 runScopedSession, 保证任何路径都释放 session (修泄漏)。
    return runScopedSession(session, `${buildAgentSystemPrompt(def)}\n\n# 任务\n${prompt}`);
  }

  private handlePiEvent(event: AgentSessionEvent): void {
    const mapped = mapPiEvent(event, this.currentTaskId ?? 'unknown');
    if (mapped) this.emit(mapped);
  }

  private emit(e: RuntimeEvent): void {
    for (const l of this.listeners) {
      try {
        l(e);
      } catch (err) {
        logger.warn({ err: (err as Error).message }, '[runtime] listener threw');
      }
    }
  }
}
