/**
 * src/mcp/tools/chat —— `conductor_chat`:对话位入口(SDD 2026-08-09 远程指挥接缝,S1)。
 *
 * Claude(含手机 Remote)经它驱动 omd conductor:conductor 自裁 direct-答 vs 画图,
 * 一切执行的账记在 omd(`runChatTurn` 逐条 emitModelUsage)。会话持久(pi Session),
 * `sessionId` 省略 = 新会话;续接靠回执首行带回的 id。
 *
 * **D-1:headless 审批档 = 手只读 + 引擎工具全开。** MCP 路无 TTY,四档审批没人按 y;
 * write 自动放行等于把闸拆了 → 手只给 read/ls/grep,一切写走图(leaf 有自己的闸,工具即闸)。
 * 顺手成为 DAG-native(战略档 §7)的第一条 A/B 臂:与 TUI 档(六只手)同任务对比。
 *
 * **D-2:锁复用不新造。** session-store 的 `ensureWritable`(片 B 跨进程写锁)抢不到就抛,
 * 错误原文经 isError 透传给 Claude 侧 —— 判词里带持有者 pid。
 *
 * `runIds` 从工具回执里收集(`run`/`solve` 回执首行 `runId: <id>` 是钉死的形状),
 * Claude 侧可继续 `dag_status` 追;图 fire-and-forget,Claude 断线图照跑。
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { OmdMcpTool } from '../server';
import type { AnyOmdTool } from '../../harness/agent-tools';
import { createOmdAgentTools } from '../../harness/agent-tools';
import { createConductorChatTools } from '../../serve/chat-tools';
import { runChatTurn, type ChatTurnOpts } from '../../harness/chat/agent';
import type { OmdSessionStore } from '../../harness/chat/session-store';

/** D-1 的只读手。`chat.test.ts` 反向自检:write/edit/bash 不许出现在 headless 工具面。 */
export const HEADLESS_HANDS: readonly string[] = ['read', 'ls', 'grep'];

/**
 * S2:headless 档的 situational 追加块(冻结前缀外,经 systemPromptHook 拼在尾部,cache 不伤)。
 *
 * 两件事,都只在 headless 档成立所以不进共享常量:
 * ① 纠正 `<hands>` 段的漂移 —— 核里宣称六只手,本档只挂了只读三只,不声明的话
 *   conductor 会去调不存在的 edit/write/bash(pi 报未知工具,白烧轮次);
 * ② ? 阀的**输出形状**(阀纪律本身在核的 `<owner>` 段,这里只钉形状):
 *   `<omd-escalation lane>` 块,lane 语义承 SDD §1-S2,反向纪律(无岔口不冒阀)一并写死。
 */
export const HEADLESS_PROMPT_BLOCK = `<headless>
You are running headless over MCP — no TTY, no approval prompt, nobody to press y. Your hands are READ-ONLY: read / ls / grep only; edit, write and bash are NOT mounted in this mode. ALL writes and all verification go through the engine (omd_run / omd_solve) — a leaf's own tools are its gate.
Graphs are fire-and-forget: after dispatching, report the runId and END your reply — do NOT poll omd_status to completion inside this turn. Planning alone can take minutes; zero visible nodes right after dispatch means "still planning", not a dead run. The caller tracks progress across turns and will come back to you with results.
When you hit the ? valve (a fork you cannot rule on), emit it as a structured block inside your reply, exactly this shape:
<omd-escalation lane="claude|owner">
倾向: <one line>
理由: <one line>
定不了的点: <one line>
</omd-escalation>
lane="claude": the calling agent may rule (technical tie, acceptance ambiguity) — it will answer and continue this session. lane="owner": business direction / domain red line / irreversible — it must reach the human owner verbatim, the caller is forbidden to answer for them.
Do NOT emit the block when there is no genuine fork: a false escalation is the valve failing in the other direction.
</headless>`;

/** S2:从 reply 里解析阀块(lane 白名单;解析不出 = 没有阀,不猜)。 */
export function parseEscalation(reply: string): { lane: 'claude' | 'owner'; block: string } | null {
  const m = reply.match(/<omd-escalation\s+lane="(claude|owner)">([\s\S]*?)<\/omd-escalation>/);
  return m ? { lane: m[1] as 'claude' | 'owner', block: m[0] } : null;
}

export interface ConductorChatDeps {
  cwd: string;
  store: OmdSessionStore;
  /** conductor 座每轮现解(INV-MODEL-3:omd_set_role 改完下一句就换座)。 */
  resolveModel: () => string;
  /** 装配面(改名后)—— `createConductorChatTools` 按新名 (run/solve/…) 点名。 */
  tools: readonly OmdMcpTool[];
  /** 测试接缝:透传 runChatTurn 的 loopFn(真循环要真模型)。生产不传。 */
  loopFn?: ChatTurnOpts['loopFn'];
}

/**
 * headless 对话位的工具面(D-1)。抽成导出函数是为了让闸看得见 ——
 * 「对话位到底拿到了哪些工具」长在 handler 内联块里就没有任何测试盯得住(chat-seat 同理)。
 */
export function buildHeadlessChatTools(deps: Pick<ConductorChatDeps, 'cwd' | 'tools'>): AnyOmdTool[] {
  return [
    ...createOmdAgentTools({ cwd: deps.cwd }).filter((t) => HEADLESS_HANDS.includes(t.name)),
    ...createConductorChatTools(deps.tools),
  ];
}

/**
 * 本轮派生的图:包 `omd_run`/`omd_solve` 的 execute,从回执首行收 runId。
 * `[TOOL ERROR]` 前缀的回执不收 —— 没真起跑的 run 不算派生(回执里那个 id 已随 fail 归档)。
 */
function collectRunIds(tools: AnyOmdTool[], sink: string[]): AnyOmdTool[] {
  return tools.map((t) => {
    if (t.name !== 'omd_run' && t.name !== 'omd_solve') return t;
    const inner = t.execute.bind(t);
    return {
      ...t,
      async execute(...args: Parameters<AnyOmdTool['execute']>) {
        const res = await inner(...args);
        const text = (res as { content?: { text?: string }[] }).content?.[0]?.text ?? '';
        const m = text.startsWith('[TOOL ERROR]') ? null : text.match(/^runId:\s*(\S+)/m);
        if (m) sink.push(m[1]!);
        return res;
      },
    } as AnyOmdTool;
  });
}

export function createConductorChatTool(deps: ConductorChatDeps): OmdMcpTool {
  // 装配期建一次(createOmdAgentTools 持 NodeExecutionEnv 资源);runIds 收集器 per-call 包装。
  const baseTools = buildHeadlessChatTools(deps);
  return {
    name: 'conductor_chat',
    description:
      'Chat with the omd conductor (persistent session): it answers directly or plans DAG runs. Omit sessionId to start new.',
    inputSchema: {
      prompt: z.string().describe('Your message to the conductor'),
      sessionId: z
        .string()
        .optional()
        .describe('Continue an existing session (omit = new; the id comes back in the reply header)'),
    },
    handler: async (args) => {
      const { prompt, sessionId } = args as { prompt?: string; sessionId?: string };
      if (!prompt?.trim()) {
        return { content: [{ type: 'text' as const, text: 'conductor_chat: prompt required' }], isError: true };
      }
      const sid = sessionId ?? randomUUID();
      const runIds: string[] = [];
      try {
        const r = await runChatTurn({
          store: deps.store,
          sessionId: sid,
          prompt,
          model: deps.resolveModel(),
          cwd: deps.cwd,
          tools: collectRunIds(baseTools, runIds),
          // S2:headless 块拼在整份 prompt 尾部 —— 冻结前缀逐字不动,cache 面不伤。
          systemPromptHook: async (p) => `${p}\n\n${HEADLESS_PROMPT_BLOCK}`,
          ...(deps.loopFn ? { loopFn: deps.loopFn } : {}),
        });
        const pressure =
          r.pressure.ratio === null
            ? `used=${r.pressure.usedTokens} window=未知`
            : `${Math.round(r.pressure.ratio * 100)}% (${r.pressure.usedTokens}/${r.pressure.windowTokens})`;
        const escalation = parseEscalation(r.reply);
        const head = [
          `sessionId: ${sid}`,
          `runIds: ${runIds.length ? runIds.join(', ') : '(无)'}`,
          // S2:阀在头行点名, lane=owner 的调用方**禁代答**(原样转人);块全文在正文里。
          ...(escalation ? [`escalation: lane=${escalation.lane}(阀块在正文,owner 级禁代答)`] : []),
          `usage: in=${r.usage.in} out=${r.usage.out}${r.usage.cacheHit !== undefined ? ` cacheHit=${r.usage.cacheHit}` : ''}`,
          `pressure: ${pressure}`,
        ].join('\n');
        return { content: [{ type: 'text' as const, text: `${head}\n---\n${r.reply}` }] };
      } catch (err) {
        // 锁拒(D-2)/ provider 错 → 错误原文透传;半轮不入库由 runChatTurn 保证(判据 3)。
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: `conductor_chat: ${msg}` }], isError: true };
      }
    },
  };
}
