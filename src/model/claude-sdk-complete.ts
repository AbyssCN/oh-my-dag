/**
 * src/model/claude-sdk-complete —— callModel 的 Claude 订阅完成位通道(终审/judge/verifier 座)。
 *
 * `doRequest` 对 provider `claude-code:*` 分派到这里:单发 SDK query(tools 全空、无 MCP),
 * 返回与 piRequest 同形的 RawResult —— callModel 的重试 / 截断守卫 / schema 纠错 / 熔断 /
 * usage emit **全部在外层复用**,这里只做一次调用。
 * 决策记录:docs/plan/NOTES.md 2026-08-10;S1 通道(chat)见 src/harness/chat/claude-sdk-turn.ts。
 *
 * 与 API 通道的三处刻意差异:
 *   ① temperature / topP / maxTokens **不支持**(SDK 不暴露采样参数)。静默丢参会伪装成
 *      "模型行为变了",所以带了就 warn 留痕 —— 该不该坐这个座位是座位选择问题,不在这吞。
 *   ② thinkingLevel → SDK `effort`(off→low,其余同名直映;模型不支持的档 SDK 自己静默降级)。
 *   ③ 多轮纠错消息(schema 重试的 assistant+user 尾巴)**串行化成单 prompt**(角色标注)——
 *      SDK 单发不吃 assistant 轮。完成位语义本来就是单发判断,纠错轮少且短,可接受。
 */
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { logger } from '../logger';
import { emitModelUsage } from './accounting';
import type { ModelMessage, ModelRequest, ModelUsage } from './types';

/** 订阅通道的座位 provider(坐标形如 `claude-code:claude-fable-5`)。chat/leaf/completion 三路同源。 */
export const CLAUDE_SDK_PROVIDER = 'claude-code';

/** omd ThinkingLevel → SDK effort。off 没有对应档(adaptive thinking 关不掉)→ 取最低。 */
export function effortOf(level: ModelRequest['thinkingLevel']): NonNullable<Options['effort']> | undefined {
  if (!level) return undefined;
  return level === 'off' ? 'low' : level;
}

/** 与 RawResult(src/model/index.ts)同形 —— 这里不 import 它,免得 model/index 反向依赖本模块类型。 */
export interface SdkRawResult {
  text: string;
  usage: ModelUsage;
  raw: unknown;
  finishReason?: string;
}

type SdkQueryLike = (props: { prompt: string; options: Options }) => AsyncIterable<SDKMessage>;

let queryOverride: SdkQueryLike | null = null;
/** 测试接缝(同 pi-transport 的 depsOverride 惯例):真 SDK 要真订阅 + claude CLI。 */
export function setSdkCompleteQueryForTest(fn: SdkQueryLike | null): void {
  queryOverride = fn;
}

function textOf(content: ModelMessage['content']): string {
  if (typeof content === 'string') return content;
  const parts = content.filter((p): p is { type: 'text'; text: string } => (p as { type?: string }).type === 'text');
  if (parts.length !== content.length) {
    logger.warn({ dropped: content.length - parts.length }, '[claude-sdk-complete] 非文本 part 丢弃 (完成位不支持多模态)');
  }
  return parts.map((p) => p.text).join('');
}

/** system 抽出来,其余串行化(单 user 常态原样;纠错尾巴带角色标注)。 */
function serialize(messages: ModelMessage[]): { systemPrompt: string | undefined; prompt: string } {
  const system = messages.filter((m) => m.role === 'system').map((m) => textOf(m.content));
  const rest = messages.filter((m) => m.role !== 'system');
  const prompt =
    rest.length === 1
      ? textOf(rest[0]!.content)
      : rest.map((m) => `[${m.role}]\n${textOf(m.content)}`).join('\n\n');
  return { systemPrompt: system.length ? system.join('\n\n') : undefined, prompt };
}

/**
 * ⚠ 2026-08-26 调查记录 (n=26, 两次误归因后终局定案, 全过程见当日 bench 接入会话):
 * 症状 = 大 prompt 经 bench 桥 18/18 退化为 CC 角色扮演, 直调 8/8 干净。
 * **真根因在桥不在本通道**: 桥的消息过滤器把 pi openai 客户端发的 `developer` role
 * (OpenAI 新式 system) 静默丢弃, conductor 系统面整条蒸发, 模型在真空里退回 CC 默认
 * 行为 + 用户全局 `~/.claude/CLAUDE.md` 填充 (角色扮演的形态与用户 harness 条款逐句对应)。
 * 两次误归因均已撤销: ①"并发损坏"→加互斥 (证伪: 串行同脏); ②"独立部署加载用户 harness
 * 压过 systemPrompt"→隔离 CLAUDE_CONFIG_DIR (对照臂不纯: 那次"净"的其实是直调形状)。
 * **留存的真教训**: 系统面一旦缺席, 独立 CLI 的默认面 (CC harness + 用户 CLAUDE.md) 会
 * 填充真空 —— 隔离 CLAUDE_CONFIG_DIR 仍是脱离会话链部署的**卫生措施** (见
 * scripts/bench-bridge.ts 启动段), 但它不是本案修法; 修法 = 桥侧 role 归一。
 */
export async function sdkCompleteRaw(modelId: string, messages: ModelMessage[], req: ModelRequest): Promise<SdkRawResult> {
  if (req.temperature !== undefined || req.topP !== undefined || req.maxTokens !== undefined) {
    logger.warn(
      { model: `${CLAUDE_SDK_PROVIDER}:${modelId}`, temperature: req.temperature, topP: req.topP, maxTokens: req.maxTokens },
      '[claude-sdk-complete] 采样/上限参数在订阅通道不支持 —— 已忽略 (差异①)',
    );
  }
  const { systemPrompt, prompt } = serialize(messages);
  const abort = new AbortController();
  req.signal?.addEventListener('abort', () => abort.abort(), { once: true });
  const effort = effortOf(req.thinkingLevel);
  const coord = `${CLAUDE_SDK_PROVIDER}:${modelId}`;
  const q = (queryOverride ?? (query as unknown as SdkQueryLike))({
    prompt,
    options: {
      model: modelId,
      tools: [],
      allowedTools: [],
      strictMcpConfig: true, // 完成位无工具, 全局 MCP schema 纯浪费 (两臂实测省 ~23k/发)
      // P0 (owner 验收 2026-08-10, run bff8c5ce): 曾是 1。CLI 侧 harness 自己会造额外轮
      // (模型试发一次 tool_use —— 工具面空、非交互 = 自动 deny —— deny 也消耗一轮; 触发非确定,
      // 同形复现两次未塌但生产塌了)。8 = 有界余量: 工具全 deny 下多的轮只能是文本续写, 撑不爆。
      maxTurns: 8,
      abortController: abort,
      ...(systemPrompt !== undefined ? { systemPrompt } : {}),
      ...(effort ? { effort } : {}),
    },
  });

  let lastStop: string | null | undefined;
  // 兜底累积 (流断时才用): 真源是 result.modelUsage —— SDK 文档明说 per-message usage 是
  // main-loop-only 且验收实测 out 严重低估 (整份 plan 只记 out=4)。
  const fallback: ModelUsage = { in: 0, out: 0, cacheHit: 0 };
  let result: Extract<SDKMessage, { type: 'result' }> | undefined;
  let threw: unknown = null;
  try {
    for await (const msg of q) {
      if (msg.type === 'assistant') {
        const u = msg.message.usage as
          | { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }
          | undefined;
        if (u) {
          const hit = u.cache_read_input_tokens ?? 0;
          fallback.in += (u.input_tokens ?? 0) + hit + (u.cache_creation_input_tokens ?? 0);
          fallback.out += u.output_tokens ?? 0;
          fallback.cacheHit = (fallback.cacheHit ?? 0) + hit;
        }
        lastStop = msg.message.stop_reason as string | null;
      } else if (msg.type === 'result') {
        result = msg;
      }
    }
  } catch (err) {
    threw = err; // 先记账再抛 (P1): 失败路的 token 也真烧了订阅额度。
  }

  const mu = result
    ? (result as { modelUsage?: Record<string, { inputTokens?: number; outputTokens?: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number }> }).modelUsage
    : undefined;
  const usage: ModelUsage = mu && Object.keys(mu).length > 0
    ? Object.values(mu).reduce<ModelUsage>(
        (acc, v) => ({
          in: acc.in + (v.inputTokens ?? 0) + (v.cacheReadInputTokens ?? 0) + (v.cacheCreationInputTokens ?? 0),
          out: acc.out + (v.outputTokens ?? 0),
          cacheHit: (acc.cacheHit ?? 0) + (v.cacheReadInputTokens ?? 0),
        }),
        { in: 0, out: 0, cacheHit: 0 },
      )
    : fallback;

  // 失败路入账 (P1)。成功路不在这记 —— callModel 出口统一 emit, 这里再记就是双计。
  const emitFailureUsage = (): void => {
    if (usage.in === 0 && usage.out === 0) return; // 一个 token 都没花 (如 spawn 失败) → 无账可记
    try {
      emitModelUsage(usage, coord);
    } catch (err) {
      logger.warn({ err: (err as Error).message, model: coord }, '[claude-sdk-complete] 失败路入账失败 (已吞)');
    }
  };
  if (threw !== null) {
    emitFailureUsage();
    throw threw;
  }
  if (!result) {
    emitFailureUsage();
    throw new Error('[claude-sdk-complete] 流结束但没收到 result 消息 (CLI 中断?)');
  }
  if (result.subtype !== 'success') {
    // 外层 callModel 按 transport 错重试 + 熔断该坐标(订阅窗口耗尽被冷却正是想要的行为)。
    emitFailureUsage();
    throw new Error(`[claude-sdk-complete] provider 错误: ${result.subtype}`);
  }
  return {
    text: (result as { result?: string }).result ?? '',
    usage,
    raw: result,
    finishReason: lastStop === 'max_tokens' ? 'length' : 'stop',
  };
}
