/**
 * scripts/claude-sdk-live-check.ts —— S1 现场验收:Fable conductor 经 SDK 通道完成真任务。
 *
 * 【判据 —— 动手前钉死】
 * ✅ 成 = ① 回复含 package.json 的真实 name 与 version(工具真读了盘,不是编的)
 *        ② 账本出口(emitModelUsage)见 ≥1 笔:model='claude-code:claude-fable-5',
 *           origin='chat',in>0(通道归因正确 —— 订阅座的 token 记到 claude-code 坐标上)
 *        ③ newMessages 里有 toolResult 消息(工具循环真发生)
 *        ④ session store 落 ≥3 条 + sidecar 映射文件有本会话的 SDK session_id
 * ❌ 塌 = 任一不满足;塌了记读数原文定方向(auth / 桥 / 映射 / 账本)。
 * 对照基线:同工具面在 pi 通道(deepseek)早已全绿(agent.test.ts)—— 单一变量 = 通道。
 *
 * 跑法:bun run scripts/claude-sdk-live-check.ts
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HEADLESS_HANDS } from '../src/mcp/tools/chat';
import { createOmdAgentTools } from '../src/harness/agent-tools';
import { runChatTurn } from '../src/harness/chat/agent';
import { createOmdSessionStore } from '../src/harness/chat/session-store';
import { observeModelUsage } from '../src/model/accounting';
import type { ModelUsage } from '../src/model/types';

const repo = process.cwd();
const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')) as { name: string; version: string };
const storeRoot = mkdtempSync(join(tmpdir(), 'omd-sdk-live-'));
const store = createOmdSessionStore(storeRoot);
const sessionId = `live-${Date.now()}`;

const emits: { u: ModelUsage; model: string; origin: string }[] = [];
const un = observeModelUsage((u, model, origin) => emits.push({ u, model, origin }));

try {
  const r = await runChatTurn({
    store,
    sessionId,
    prompt: 'Read package.json in the repo root and tell me exactly the package name and version. Use the read tool.',
    model: 'claude-code:claude-fable-5',
    cwd: repo,
    tools: createOmdAgentTools({ cwd: repo }).filter((t) => HEADLESS_HANDS.includes(t.name)),
  });
  const map = JSON.parse(readFileSync(join(repo, '.omd', 'chat', 'claude-sdk-sessions.json'), 'utf8')) as Record<string, string>;
  const hasToolResult = r.newMessages.some((m) => (m as { role?: string }).role === 'toolResult');
  const ledgerHit = emits.filter((e) => e.model === 'claude-code:claude-fable-5' && e.origin === 'chat' && e.u.in > 0);
  const signals = {
    replyHasTruth: r.reply.includes(pkg.name) && r.reply.includes(pkg.version),
    ledgerAttributed: ledgerHit.length >= 1,
    toolLoopHappened: hasToolResult,
    persisted: r.messageCount >= 3 && typeof map[sessionId] === 'string',
  };
  console.log(JSON.stringify({ check: 'claude-sdk-live-fable', signals, readings: {
    reply: r.reply, usage: r.usage, calls: ledgerHit.length, messageCount: r.messageCount,
    sdkSessionId: map[sessionId], pressurePct: r.pressure,
  } }, null, 2));
  process.exit(Object.values(signals).every(Boolean) ? 0 : 1);
} finally {
  un();
  rmSync(storeRoot, { recursive: true, force: true });
}
