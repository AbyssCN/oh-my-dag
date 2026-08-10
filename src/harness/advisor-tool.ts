/**
 * src/harness/advisor-tool —— pi 通道座位的内部升档 advisor(NOTES 2026-08-10 裁决)。
 *
 * 镜像官方 server-side advisor tool 的语义,给非 Claude 座位(deepseek/kimi/gpt)同一个
 * 求教面:executor 调无参 `advisor` 工具 → 本模块把**本次运行的 transcript** 序列化,
 * 经 `callModel` 打显式配置的更强坐标,建议文本作 tool result 返回,executor 继续。
 * 两路对 leaf prompt **同名同义** —— 座位换通道不改 prompt。
 *
 * 官方语义的镜像点(逐条):advisor 无工具 · 单发 · 只回建议文本(thinking 由 callModel
 * 丢弃)· executor 自决何时求教(一期无机械触发,whenStuck 留二期)。
 * 刻意不同点:内部路建议是**明文**(全量可审计,官方 Opus-5 路是密文)· system prompt
 * 自有(官方不可配,这里可但只此一份,不按座位定制)。
 *
 * 截断数抄 hknet pi-advisor 实测:工具参数 ≤800 字符 · 工具结果 ≤2000 · 总量超 100k 删最旧。
 * 账:advisor 调用走 callModel 出口自动入账(advisor 坐标费率);归因 advised 座位落日志行
 * (ledger 无归因列,一期以 log + result details 承载 —— NOTES 记档)。
 */
import { Type } from 'typebox';
import type { AgentEvent, AgentMessage } from '@earendil-works/pi-agent-core';
import { logger } from '../logger';
import { callModel } from '../model';
import type { ModelResponse } from '../model/types';
import type { AnyOmdTool } from './agent-tools';

const ARG_CAP = 800;
const RESULT_CAP = 2_000;
const TEXT_CAP = 2_000;
const TOTAL_CAP = 100_000;

const cut = (s: string, cap: number): string => (s.length > cap ? `${s.slice(0, cap)}…[+${s.length - cap} chars]` : s);

export interface TranscriptRecorder {
  note(e: AgentEvent): void;
  /** 载入既往会话消息(chat 场景:advisor 该看到本轮之前的历史)。 */
  seed(messages: readonly AgentMessage[]): void;
  serialize(): string;
}

/** 事件流 → 文本 transcript。挂在与 filesTouched 同一条 emit 链上,循环换通道它不知道。 */
export function createTranscriptRecorder(): TranscriptRecorder {
  const lines: string[] = [];
  let total = 0;
  const push = (line: string): void => {
    lines.push(line);
    total += line.length;
    while (total > TOTAL_CAP && lines.length > 1) {
      total -= lines[0]!.length;
      lines.shift();
    }
  };
  const textOf = (content: unknown): string => {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content
      .filter((b): b is { type: 'text'; text: string } => (b as { type?: string })?.type === 'text')
      .map((b) => b.text)
      .join('');
  };
  return {
    note(e) {
      if (e.type === 'message_end') {
        const m = e.message as { role?: string; content?: unknown };
        if (m.role === 'assistant') {
          const t = textOf(m.content);
          if (t.trim()) push(`[assistant] ${cut(t, TEXT_CAP)}`);
        }
      } else if (e.type === 'tool_execution_start') {
        push(`[tool_call] ${e.toolName}(${cut(JSON.stringify(e.args ?? {}), ARG_CAP)})`);
      } else if (e.type === 'tool_execution_end') {
        const r = typeof e.result === 'string' ? e.result : JSON.stringify(e.result ?? '');
        push(`[tool_result${e.isError ? ' ERROR' : ''}] ${cut(r, RESULT_CAP)}`);
      }
    },
    seed(messages) {
      for (const m of messages) {
        const { role, content } = m as { role?: string; content?: unknown };
        if (role === 'user' || role === 'assistant') {
          const t = textOf(content);
          if (t.trim()) push(`[${role}] ${cut(t, TEXT_CAP)}`);
        }
      }
    },
    serialize: () => lines.join('\n'),
  };
}

/** 内部 advisor 的唯一 system prompt(官方不可配,这里只此一份 —— 不按座位定制)。 */
export const ADVISOR_SYSTEM_PROMPT =
  'You are a senior advisor reviewing another AI agent mid-task. You will receive the transcript of ' +
  'its work so far (its instructions, tool calls, results, and reasoning output). Give concise strategic ' +
  'guidance: is the current approach sound, what is being missed, what should it do next. If an error keeps ' +
  'recurring, diagnose the likely root cause. You have no tools — advise from the transcript only. ' +
  'Reply with the guidance text alone.';

export interface AdvisorToolOpts {
  /** advisor 坐标('provider:modelId')。显式配置才存在 —— 上游 resolveSeatAdvisor 保证。 */
  advisor: string;
  /** 被建议座位的坐标(归因日志用)。 */
  seatCoord: string;
  /** 本次运行的 transcript 提供者(每次求教现取,拿到的是最新进度)。 */
  transcript: () => string;
  /** 测试接缝:真 callModel 要真模型。 */
  callModelFn?: (req: Parameters<typeof callModel>[0]) => Promise<ModelResponse>;
}

/** 无参 `advisor` 工具 —— 与官方 server tool 同名同义,prompt 面经 promptSnippet 自动进系统提示。 */
export function createAdvisorTool(opts: AdvisorToolOpts): AnyOmdTool {
  return {
    name: 'advisor',
    label: 'advisor',
    description:
      'Consult a stronger advisor model for strategic guidance. It reads your full transcript and returns advice. Takes no arguments.',
    promptSnippet:
      'advisor — consult a stronger reviewer model before committing to an approach, when an error keeps recurring, or before declaring the task done. No arguments.',
    parameters: Type.Object({}),
    execute: async (_id: string, _params: Record<never, never>, signal?: AbortSignal) => {
      const t = opts.transcript();
      const r = await (opts.callModelFn ?? callModel)({
        model: opts.advisor,
        messages: [
          { role: 'system', content: ADVISOR_SYSTEM_PROMPT },
          { role: 'user', content: `Transcript of the agent's work so far:\n\n${t || '(no activity yet)'}\n\nGive your guidance.` },
        ],
        thinkingLevel: 'high',
        ...(signal ? { signal } : {}),
      });
      // 归因 advised 座位:ledger 无归因列,一期以日志行承载(NOTES 记档)。
      logger.info(
        { seat: opts.seatCoord, advisor: opts.advisor, in: r.usage.in, out: r.usage.out },
        '[advisor-tool] 内部升档求教完成',
      );
      return { content: [{ type: 'text' as const, text: r.text }], details: { advisor: opts.advisor, usage: r.usage } };
    },
  } as unknown as AnyOmdTool;
}
