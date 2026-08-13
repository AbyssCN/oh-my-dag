/**
 * 内部升档 advisor 契约测试。钉四条:recorder 截断/封顶口径(抄 hknet 实测数)/
 * 工具单发把 transcript 真交给 advisor 坐标 / advisor 失败响亮(反向自检)/
 * chat pi 路注入(工具面 + prompt 面 + seed 既往会话)。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentEvent, AgentMessage } from '@earendil-works/pi-agent-core';
import { ADVISOR_SYSTEM_PROMPT, createAdvisorTool, createTranscriptRecorder } from './advisor-tool';
import { runChatTurn } from './chat/agent';
import { createOmdSessionStore, resetSessionCacheForTest } from './chat/session-store';

describe('transcript recorder', () => {
  test('★ 三类事件入录;参数 ≤800 / 结果 ≤2000 截断可见(带余量标注)', () => {
    const r = createTranscriptRecorder();
    r.note({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: '想法' }] } as unknown as AgentMessage });
    r.note({ type: 'tool_execution_start', toolCallId: 'c1', toolName: 'bash', args: { command: 'x'.repeat(900) } });
    r.note({ type: 'tool_execution_end', toolCallId: 'c1', toolName: 'bash', result: 'y'.repeat(2500), isError: false } as AgentEvent);
    const t = r.serialize();
    expect(t).toContain('[assistant] 想法');
    expect(t).toContain('[tool_call] bash(');
    expect(t).toContain('…[+'); // 截断留痕, 不静默吞
    expect(t.split('\n')[1]!.length).toBeLessThan(900);
  });

  test('★ 总量超 100k 删最旧(留最新进度,advisor 看的是现在不是开头)', () => {
    const r = createTranscriptRecorder();
    for (let i = 0; i < 200; i++) {
      r.note({ type: 'tool_execution_end', toolCallId: `c${i}`, toolName: 't', result: `${i}:${'z'.repeat(1900)}`, isError: false } as AgentEvent);
    }
    const t = r.serialize();
    expect(t.length).toBeLessThanOrEqual(101_000);
    expect(t).toContain('199:'); // 最新在
    expect(t).not.toContain('[tool_result] 0:'); // 最旧被删
  });
});

describe('advisor 工具', () => {
  test('★ 无参 schema;单发把 transcript + 自有 system prompt 交给 advisor 坐标;建议文本原样回', async () => {
    let seen: { model?: string; system?: string; user?: string } = {};
    const tool = createAdvisorTool({
      advisor: 'openai-codex:gpt-5.6-sol',
      seatCoord: 'deepseek:deepseek-v4-flash',
      transcript: () => '[assistant] 我卡住了',
      callModelFn: async (req) => {
        seen = {
          model: req.model!,
          system: req.messages[0]!.content as string,
          user: req.messages[1]!.content as string,
        };
        return { text: '建议:先写复现测试', usage: { in: 10, out: 5 }, raw: {}, model: req.model!, attempts: 1 };
      },
    });
    expect(Object.keys((tool.parameters as { properties?: object }).properties ?? {})).toEqual([]);
    const r = await tool.execute('id1', {} as never);
    expect((r.content[0] as { text: string }).text).toBe('建议:先写复现测试');
    expect(seen.model).toBe('openai-codex:gpt-5.6-sol');
    expect(seen.system).toBe(ADVISOR_SYSTEM_PROMPT);
    expect(seen.user).toContain('我卡住了');
  });

  test('★ advisor 调用失败 → 抛(循环转 isError 回给 executor,任务不死 —— 反向自检)', async () => {
    const tool = createAdvisorTool({
      advisor: 'x:y', seatCoord: 's', transcript: () => '',
      callModelFn: async () => { throw new Error('advisor 掉线'); },
    });
    await expect(tool.execute('id1', {} as never)).rejects.toThrow('advisor 掉线');
  });
});

describe('chat pi 路注入', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'omd-advisor-chat-'));
    resetSessionCacheForTest();
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  test('★ opts.advisor 在 → 本轮工具面含 advisor 且 prompt 面列举它;不在 → 都不在(不自动选)', async () => {
    const store = createOmdSessionStore(root);
    const seen: { tools?: string[]; systemPrompt?: string } = {};
    const fakeLoop = async (
      prompts: AgentMessage[],
      context: { messages: AgentMessage[]; tools: { name: string }[]; systemPrompt: string },
    ): Promise<AgentMessage[]> => {
      seen.tools = context.tools.map((t) => t.name);
      seen.systemPrompt = context.systemPrompt;
      return [...prompts, { role: 'assistant', content: [{ type: 'text', text: 'ok' }], timestamp: 2, stopReason: 'stop' } as unknown as AgentMessage];
    };
    await runChatTurn({
      store, sessionId: 's1', prompt: 'x', model: 'deepseek:deepseek-v4-flash', cwd: root,
      advisor: 'openai-codex:gpt-5.6-sol', loopFn: fakeLoop as never,
    });
    expect(seen.tools).toContain('advisor');
    expect(seen.systemPrompt).toContain('advisor — consult a stronger reviewer model');

    await runChatTurn({
      store, sessionId: 's2', prompt: 'x', model: 'deepseek:deepseek-v4-flash', cwd: root,
      loopFn: fakeLoop as never,
    });
    expect(seen.tools).not.toContain('advisor');
  });
});
