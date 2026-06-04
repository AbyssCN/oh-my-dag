/**
 * src/wright/memory-extension —— wright 自我记忆**接进交互 TUI** (the owner: memory 记 SQLite 要透明)。
 *
 * 注册 `remember` 工具: wright 把一条关于用户(user.*)或自己(wright.*)的 fact 写进 ValalMemory(SQLite),
 * 经 validateFactWrite 闸。两个透明化:
 *   - **存储 emoji** (the owner #4): 每次成功写入 `ctx.ui.notify('💾 …')` —— 用户看得见 wright 刚记了什么。
 *   - **human_verified 弹窗** (the owner #1): `verify:true` 时 `ctx.ui.confirm(...)` 请用户确认; 确认才升
 *     human_verified (self-evolve 永不可改它), 否则按 fact 自带的 agent confidence 记。
 *
 * 工具 execute 第 5 参 = ctx (pi 文档确认), 故 confirm/notify 可用。无 ui (headless/print) → 跳过 confirm,
 * 按 agent confidence 写 (人验需交互)。
 */
import { Type, type Static } from 'typebox';
import {
  defineTool,
  type ExtensionFactory,
  type ExtensionContext,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import type { WrightMemory } from './memory';
import { logger } from '../logger';

const REMEMBER_SCHEMA = Type.Object({
  fact: Type.Record(Type.String(), Type.Unknown(), {
    description:
      '要记的 fact 对象。namespace 限 user.*(记用户) / wright.*(记自己): ' +
      'user.preference{category,value} · user.interest{topic,note?} · user.focus{focus,started_at} · ' +
      'user.expertise{domain,level:expert|proficient|familiar} · user.trait{category,statement} · ' +
      'user.goal{goal,status:active|paused|done,horizon:now|quarter|year} · ' +
      'wright.capability{area,level:expert|proficient|weak,note?} · wright.pattern{situation,approach,outcome:worked|failed} · ' +
      'wright.limit{kind:budget|boundary|blindspot,statement}。' +
      '必带 source_event_id 或 source_doc_id + confidence (默认 {level:"agent_tentative",source_event_ids:["<ev>"],created_at:"<iso>"}; ≥3 源用 agent_confident)。',
  }),
  verify: Type.Optional(
    Type.Union([Type.Literal('user'), Type.Literal('ask')], {
      description:
        "记忆的人验意图: 'user' = 用户**明确说**要记住 → 直接存 human_verified, **不弹窗** (用户的话就是确认); " +
        "'ask' = wright **主动提议**永久锁定(用户没明说) → **弹窗**请用户确认, 确认才 human_verified; " +
        '省略 = wright 自己的观察 → 按 fact 自带 agent confidence 记, 不弹窗。三种都会写入并显示 💾。',
    }),
  ),
});
type RememberParams = Static<typeof REMEMBER_SCHEMA>;

function textResult(text: string, details: Record<string, unknown> = {}): {
  content: { type: 'text'; text: string }[];
  details: Record<string, unknown>;
} {
  return { content: [{ type: 'text', text }], details };
}

/** fact 的人读摘要 (弹窗/notify 用)。 */
function summarize(fact: Record<string, unknown>): string {
  const ns = String(fact.namespace ?? '?');
  const fields = Object.entries(fact)
    .filter(([k]) => !['namespace', 'confidence', 'source_event_id', 'source_doc_id'].includes(k))
    .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join(', ');
  return `${ns}: ${fields}`;
}

/** 时间戳注入 (extension 运行时有 Date; 仅此处一处, 便于测试替换)。 */
type NowFn = () => string;

export interface MemoryExtensionOpts {
  memory: WrightMemory;
  /** 验证者身份 (human_verified.by)。默认 'human' (通用无 PII)。 */
  verifiedBy?: string;
  /** 测试注入时间。默认 new Date().toISOString()。 */
  now?: NowFn;
}

export function createMemoryExtension(opts: MemoryExtensionOpts): ExtensionFactory {
  const verifiedBy = opts.verifiedBy ?? 'human';
  const now: NowFn = opts.now ?? (() => new Date().toISOString());

  return (pi) => {
    pi.registerTool(
      defineTool({
        name: 'remember',
        label: 'Remember',
        description: '把一条关于用户(user.*)或自己(wright.*)的 fact 写入长期记忆 (SQLite, 经 validateFactWrite 闸)。',
        promptSnippet: 'remember(fact, verify?) — 记一条 user.*/wright.* fact 进长期记忆。',
        parameters: REMEMBER_SCHEMA,
        executionMode: 'sequential',
        async execute(_id: string, params: RememberParams, _signal, _onUpdate, ctx: ExtensionContext) {
          const fact: Record<string, unknown> = { ...(params.fact as Record<string, unknown>) };
          let humanVerified = false;
          const markVerified = () => {
            fact.confidence = { level: 'human_verified', by: verifiedBy, verified_at: now() };
            humanVerified = true;
          };

          if (params.verify === 'user') {
            // 用户明确说要记 → 直接 human_verified, 不弹窗 (用户的话就是确认)。
            markVerified();
          } else if (params.verify === 'ask') {
            // wright 主动提议永久锁定 → 弹窗请用户确认 (the owner #1); 无交互 ui 则不升人验。
            if (await ctx?.ui?.confirm?.('确认永久记住?', summarize(fact))) markVerified();
          }
          // 省略 verify → 保 fact 自带 agent confidence (wright 自己的观察)。

          const res = await opts.memory.writeFact(fact);
          if (res.status === 'rejected') {
            ctx?.ui?.notify?.(`记忆被拒: ${res.reason}`, 'error');
            logger.warn({ ns: fact.namespace, reason: res.reason }, '[wright/remember] rejected');
            return textResult(`rejected: ${res.reason}`, { ok: false, reason: res.reason });
          }
          // 存储 emoji (the owner #4): 每次成功写入可见提醒。
          ctx?.ui?.notify?.(
            `💾 已记 ${String(fact.namespace)}${humanVerified ? ' ✅human-verified' : ''} (${res.action})`,
            'info',
          );
          logger.debug({ ns: fact.namespace, action: res.action, humanVerified }, '[wright/remember] written');
          return textResult(`ok (${res.action})`, { ok: true, id: res.id, action: res.action });
        },
      }) as unknown as ToolDefinition,
    );
  };
}
