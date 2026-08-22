/**
 * src/tui/ext/protocol —— **宿主 ↔ 扩展子进程的线上契约**(S15a,2026-08-07)。
 *
 * ## 为什么要有子进程
 *
 * owner 裁决:扩展加载走沙箱不走白名单。而 **bwrap 隔离的是进程,不是模块** ——
 * in-process 的宿主没有任何办法被它包住。所以扩展必须跑在子进程里,钩子走 IPC。
 *
 * ## 为什么 IPC 够用
 *
 * 静态体检(`docs/plan/2026-08-07-pi-ext-surface-scan.md`)量出来的事实:
 * pi 的组件契约是 `render(width) => string[]`,`ctx.sessionManager` 是
 * **`ReadonlySessionManager`(只读)** —— 这些都可序列化。真正不可代理的只有 `fork` 一类,
 * 命中 1/16。
 *
 * ## 帧格式:一行一个 JSON
 *
 * 不用长度前缀,因为 stdout 里混进来的**任何非 JSON 行都要能被认出来并当证据留着** ——
 * 扩展 `console.log` 一句的话,长度前缀协议会直接错位解不出来,而行协议只是多一条"看不懂的行"。
 */

/**
 * D1 事件词表 v2 (2026-08-17, dsh/cordis 吸收线 D): 每个事件的**分发语义是公开契约**
 * (学 dsh 的 @mode 纪律 —— 语义属于事件, 不属于订阅者):
 *
 * - **observe**: 引擎执行流的只读通知。宿主发帧后**不消费回复** —— 扩展崩溃/超时/返回什么,
 *   都结构上够不到 run 的结果与任何 prompt (前缀零字节是构造保证, 不是约定)。
 * - **gate**: 宿主消费回复且有闸。`before_agent_start` = append-only 闸 (下方
 *   enforceAppendOnly) + **超时/崩溃走声明默认 = 放行原串** (一个挂了的扩展不许拖死对话轮)。
 *
 * 词表外事件在**加载期**被体检拒 (missingApis 对 `on:<词表外>` 红) —— 不发布不能兑现的事件,
 * 注册了没人发的事件也不许静默跑。
 */
export const OBSERVE_EVENTS = ['after_plan', 'before_node', 'after_node', 'on_verdict', 'on_escalation'] as const;
export const GATE_EVENTS = ['before_agent_start'] as const;
export const SUPPORTED_EVENTS = [...GATE_EVENTS, ...OBSERVE_EVENTS] as const;
export const SUPPORTED_API = ['on', 'registerTool'] as const;

export type SupportedEvent = (typeof SUPPORTED_EVENTS)[number];
export type ObserveEvent = (typeof OBSERVE_EVENTS)[number];

/** 事件 → 分发语义 (Record 全覆盖: 新事件不声明语义是编译错)。 */
export const EVENT_MODES: Record<SupportedEvent, 'observe' | 'gate'> = {
  before_agent_start: 'gate',
  after_plan: 'observe',
  before_node: 'observe',
  after_node: 'observe',
  on_verdict: 'observe',
  on_escalation: 'observe',
};

/** 扩展声明的工具 —— **纯数据**。`execute` 留在子进程里,宿主经 IPC 代理调用。 */
export interface ToolDecl {
  name: string;
  description: string;
  promptSnippet?: string;
  /** typebox/JSON-schema 对象。宿主原样转给工具面,不解释内容。 */
  parameters: unknown;
  /** 声明 true = 扩展作者确认工具只做沙箱叶内安全操作。未声明/非 true → 进隔离叶时剥除 + warn。 */
  sandboxSafe?: boolean;
}

export type HostMsg =
  | { t: 'event'; id: number; event: SupportedEvent; payload: unknown }
  | { t: 'tool'; id: number; name: string; params: unknown }
  | { t: 'shutdown' };

export type ChildMsg =
  /**
   * 加载完成。`touched` = 扩展**碰过的所有 API 名**(含没实现的)——
   * 宿主拿它做**加载期体检**:碰了没实现的就拒绝加载并逐条列出,
   * 而不是让它半残地跑起来。
   */
  | { t: 'ready'; tools: ToolDecl[]; events: string[]; touched: string[] }
  | { t: 'result'; id: number; ok: true; value: unknown }
  | { t: 'result'; id: number; ok: false; error: string }
  /** 子进程自己活不下去(import 失败等)。**带原文**,不许只说"加载失败"。 */
  | { t: 'fatal'; error: string };

/** 序列化一帧(末尾换行)。 */
export function encodeFrame(msg: HostMsg | ChildMsg): string {
  return `${JSON.stringify(msg)}\n`;
}

/**
 * 把流里攒的字节切成帧。
 *
 * @returns `frames` 解出来的帧 · `rest` 剩下的半行 · `garbage` **解不出来的整行**
 *   —— 那多半是扩展自己 `console.log` 的东西。**不丢**:调用方要把它记下来,
 *   否则"扩展往 stdout 打了字导致协议错乱"这件事永远查不出来。
 */
export function decodeFrames(buf: string): { frames: unknown[]; rest: string; garbage: string[] } {
  const parts = buf.split('\n');
  const rest = parts.pop() ?? '';
  const frames: unknown[] = [];
  const garbage: string[] = [];
  for (const line of parts) {
    if (!line.trim()) continue;
    try {
      frames.push(JSON.parse(line));
    } catch {
      garbage.push(line);
    }
  }
  return { frames, rest, garbage };
}

/**
 * **`systemPrompt` 只能追加,不能替换**(owner 裁决 ①)。
 *
 * @returns `ok` 时给追加后的串;不 ok 时给**原串**与拒绝理由 —— 调用方据此 block + 提醒。
 *
 * ⚠ 判据是「以原串开头」而不是「长度变长」:后者挡不住"把开头改一个字再接一大段"。
 * 冻结前缀改一个字 = 对应 cache 面全失效,那正是这条闸要守的钱。
 */
export function enforceAppendOnly(
  original: string,
  returned: unknown,
): { ok: true; value: string } | { ok: false; value: string; reason: string } {
  if (returned === undefined || returned === null) return { ok: true, value: original };
  if (typeof returned !== 'string') {
    return { ok: false, value: original, reason: `systemPrompt is not a string (${typeof returned})` };
  }
  if (!returned.startsWith(original)) {
    return { ok: false, value: original, reason: 'systemPrompt was REPLACED rather than appended - frozen prefix must not change' };
  }
  return { ok: true, value: returned };
}
