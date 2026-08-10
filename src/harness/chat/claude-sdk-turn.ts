/**
 * src/harness/chat/claude-sdk-turn —— Claude 订阅通道:共享 SDK 循环核 + conductor chat 消费者。
 *
 * 三个座位面共用一条订阅通道(NOTES 2026-08-10),分派点各在其位:
 *   chat(conductor)   → 本文件 runChatTurnSdk(agent.ts 顶部按坐标分派)
 *   agent leaf(worker)→ agent-leaf.ts 的 claude-code 分支,复用 claude-sdk-loop 的 runSdkAgentLoop
 *   completion(终审)  → src/model/claude-sdk-complete.ts(callModel 的 doRequest 分派)
 * 可行性探针:scripts/claude-sdk-probe.ts(S0)· scripts/claude-sdk-live-check.ts(S1)。
 *
 * 与 pi 通道的三处刻意差异(不是缺口,是委托):
 *   ① **上下文压缩不做**:SDK 自带 context 管理;`compactions` 恒 0 的语义是「委托给 SDK」。
 *   ② **会话双轨**:omd session-store 存投影(展示/审计真相),SDK 侧自持 transcript 供 resume;
 *      桥是 `.omd/chat/claude-sdk-sessions.json`(每轮 resume 会 fork 新 id,成功后重写)。
 *   ③ **账本**:claude-code 坐标刻意不进价表 → unpriced=true(订阅额度 ≠ $0 ≠ SDK 报的名义价)。
 *      chat 在这里逐条 emit;leaf **不在通道里 emit**(usage 随 AgentLeafResult 交回、引擎记账,
 *      与 pi leaf 同纪律 —— 通道自己记会双记)。
 *
 * 失败语义:result.subtype !== 'success' 或流中断 → 响亮上抛,一个字节不写(半轮不入库)。
 * leaf 例外:`tolerateAbort` 开着且确实是我们自己 abort(超时/停摆)→ 返已累积消息,
 * 由 leaf 的 stalled/timedOut 语义接手(优雅停,产物保留)。
 */
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { assistantText, loadProjectContext } from '../agent-leaf';
import { buildConductorChatSystemPrompt } from '../harness-prompts';
import { parseModelRef } from '../fleet';
import { logger } from '../../logger';
import { emitModelUsage } from '../../model/accounting';
import { CLAUDE_SDK_PROVIDER, effortOf } from '../../model/claude-sdk-complete';
import type { ModelUsage } from '../../model/types';
import { analyzeContextPressure } from './usage';
import type { ChatTurnOpts, ChatTurnResult } from './agent';

import { officialAdvisorModelId, runSdkAgentLoop } from '../claude-sdk-loop';

// 常量真源在 model 层;循环核/桥在 claude-sdk-loop。re-export 保住既有 import 面(agent.ts / 测试)。
export { CLAUDE_SDK_PROVIDER };
export { buildOmdSdkMcpBridge, runSdkAgentLoop, type SdkQueryFn, type SdkLoopOpts, type SdkLoopOut } from '../claude-sdk-loop';

// ── SDK 会话映射 sidecar(omd sessionId → SDK session_id;chat 专用) ─────────────
function sdkMapPath(cwd: string): string {
  return join(cwd, '.omd', 'chat', 'claude-sdk-sessions.json');
}

function readSdkSessionId(cwd: string, sessionId: string): string | undefined {
  try {
    const map = JSON.parse(readFileSync(sdkMapPath(cwd), 'utf8')) as Record<string, string>;
    return map[sessionId];
  } catch {
    return undefined; // 文件不存在 = 首轮,正常路径;损坏走下面 write 时整文件重建
  }
}

function writeSdkSessionId(cwd: string, sessionId: string, sdkSessionId: string): void {
  // fail-open 但不吞证据:写失败只降级续接(下轮 SDK 侧起新会话),必须留痕。
  try {
    const p = sdkMapPath(cwd);
    let map: Record<string, string> = {};
    try {
      map = JSON.parse(readFileSync(p, 'utf8')) as Record<string, string>;
    } catch {
      /* 首次或损坏 → 重建;旧映射丢失的后果同写失败,由下一行日志兜证据 */
    }
    map[sessionId] = sdkSessionId;
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, `${JSON.stringify(map, null, 2)}\n`);
  } catch (err) {
    logger.warn({ sessionId, sdkSessionId, err: (err as Error).message }, '[claude-sdk] 会话映射写失败 → 下轮 SDK 侧将起新会话');
  }
}

// ── chat 消费者(conductor 座位) ────────────────────────────────────────────────
export async function runChatTurnSdk(opts: ChatTurnOpts): Promise<ChatTurnResult> {
  const { modelId } = parseModelRef(opts.model);
  const tools = opts.tools ?? [];
  const existing = await opts.store.open(opts.sessionId);
  const priorCount = existing ? (await existing.messages()).length : 0;

  let systemPrompt = buildConductorChatSystemPrompt({
    cwd: opts.cwd,
    tools,
    contextFiles: opts.contextFiles ?? loadProjectContext(opts.cwd),
  });
  if (opts.systemPromptHook) {
    try {
      systemPrompt = await opts.systemPromptHook(systemPrompt);
    } catch (err) {
      logger.warn({ err: (err as Error).message }, '[claude-sdk] systemPrompt 钩子抛了 → 用原串');
    }
  }

  const resume = readSdkSessionId(opts.cwd, opts.sessionId);
  const effort = effortOf(opts.thinkingLevel ?? 'high');
  // 官方 advisor(claude-code 座只认 claude-code:* advisor;Fable main 的配对拒绝由 CLI 处理:不挂 + 通知)。
  const advisorModel = officialAdvisorModelId(opts.advisor, opts.model);
  const out = await runSdkAgentLoop({
    prompt: opts.prompt,
    systemPrompt,
    tools,
    modelId,
    modelCoord: opts.model,
    ...(effort ? { effort } : {}),
    ...(advisorModel ? { advisorModel } : {}),
    ...(resume ? { resume } : {}),
    cwd: opts.cwd,
    ...(opts.onEvent ? { onEvent: opts.onEvent } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
    ...(opts.sdkQueryFn ? { sdkQueryFn: opts.sdkQueryFn } : {}),
  });
  const result = out.result!; // 非 tolerateAbort 路:runSdkAgentLoop 保证 success 才返回

  // 逐条 emit 不汇总:每条 assistant 是一次独立 API 调用,calls 语义与 pi 通道一致。
  for (const u of out.usages) {
    try {
      emitModelUsage(u, opts.model, 'chat');
    } catch (err) {
      logger.warn({ err: (err as Error).message, model: opts.model }, '[claude-sdk] 用量入账失败 (已吞, 不影响这一轮)');
    }
  }

  // ── 成功之后才落任何东西(半轮不入库,与 pi 通道同纪律) ────────────────────────
  const userMsg = { role: 'user', content: opts.prompt, timestamp: Date.now() } as AgentMessage;
  const newMessages: AgentMessage[] = [userMsg, ...out.generated];
  const titleSource = opts.prompt.replace(/\s+/g, ' ').trim();
  const session = existing ?? (await opts.store.create(opts.sessionId, titleSource.length > 60 ? `${titleSource.slice(0, 60)}…` : titleSource));
  for (const m of newMessages) await session.append(m);
  writeSdkSessionId(opts.cwd, opts.sessionId, result.session_id);

  const after = priorCount + newMessages.length;
  const windowTokens =
    Object.values((result.modelUsage ?? {}) as Record<string, { contextWindow?: number }>)[0]?.contextWindow ?? 1_000_000;
  const total: ModelUsage = out.usages.reduce<ModelUsage>(
    (acc, u) => ({ in: acc.in + u.in, out: acc.out + u.out, cacheHit: (acc.cacheHit ?? 0) + (u.cacheHit ?? 0) }),
    { in: 0, out: 0, cacheHit: 0 },
  );
  return {
    sessionId: opts.sessionId,
    messageCount: after,
    reply: out.generated.map(assistantText).join(''),
    newMessages,
    usage: total,
    pressure: analyzeContextPressure({ systemPrompt, messages: await session.messages(), windowTokens }),
    compactions: 0, // 委托给 SDK 的通道恒 0 —— 语义是「SDK 自管」,不是「没压」(见文件头注 ①)
  };
}
