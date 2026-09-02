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
 *
 * **§2 周预算闸**(`mcp/budget.ts`):轮前一道(超限 → 不跑轮,回 `lane="owner"` 阀块)、
 * 派图前一道(超限 → `omd_run`/`omd_solve` 拒派)。已在飞的图不动。
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { OmdMcpTool } from '../server';
import type { AnyOmdTool } from '../../harness/agent-tools';
import { createOmdAgentTools } from '../../harness/agent-tools';
import { createConductorChatTools } from '../../serve/chat-tools';
import { createHistoryTools } from './history';
import { Type } from '@sinclair/typebox';
import { createLeadTools, formatRejection, invokeLeadTool } from '../../harness/lead/tools/index';
import type { LeadCtx, LeadTool } from '../../harness/lead/types';
import { allowlistForRoot } from '../../harness/command-leaf';
import { effectiveFanout } from '../../harness/fleet';
import { tryResolveSeatModel } from '../../model/role-models';
import { runChatTurn, type ChatTurnOpts } from '../../harness/chat/agent';
import { resolveSeatAdvisor } from '../../model/role-models';
import type { OmdSessionStore } from '../../harness/chat/session-store';
import {
  checkWeeklyBudget,
  renderBudgetEscalation,
  renderBudgetLine,
  usageLedgerDir,
  type WeeklyBudgetStatus,
} from '../budget';

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

/**
 * S-C 路由阶梯 (契约 C-1, 真源 = grill 票 1 判卷 + `.omd/router-prompt-draft.md`)。
 * 与 HEADLESS_PROMPT_BLOCK 同层: situational 追加块, 冻结核零字节改 (cache 面不伤)。
 * 英文承 conductor 正文惯例 (D-3: 混排让 cache/遵从读数不可比)。
 */
export const ROUTING_LADDER_BLOCK = `<routing-ladder>
Before acting on any task, classify it by four observables — declare first, then act:
  W = does it write files (any byte in the repo)?  yes / no
  N = estimated files touched: 0 / 1-2 / 3-8 / >8-or-uncountable
  X = cross-module (top-level dirs touched): 1 / >=2
  O = mechanical oracle (one command that judges pass/fail by itself): have / none / build
If you cannot fill N or X, that itself is the reading — go look first (L1), then classify. Never skip this because the task "feels small".

L0 direct answer — W=no and the answer is already in this turn's context. No tool calls. If you catch yourself writing "based on my impression / generally", or a quantifier (always / all / only / never) without the number behind it, drop to L1 and look.
L1 read-only self-check — W=no, the answer lives in the repo. Budget: <=6 read-only calls (read / ls / grep / omd_recall / omd_status / omd_runs / omd_node_output). Escalate to L2 when: 6 calls without locating it; W turns out to be yes; or you need to run a command (you have no bash — running anything means a graph).
L2 single graph (omd_run) — W=yes, N<=8, X=1, O=have (an existing command), and the fix is already decided (you can state the change in one sentence). Budget: one graph, redraw <=1; second red → stop and report, do not redraw again. The task text must contain: goal + acceptance command + boundaries (what not to touch). Dispatch, report the runId, END the turn. Small decided tasks (N<=2): you may pre-build a ConductorPlan JSON and call omd_run_plan instead — it skips the planning segment entirely (measured 2026-08-10: 64% of run graphs write <=2 files yet pay the full planning wall-clock).
L3 full loop (omd_solve) — W=yes and (N>8 or X>=2 or O=none/build or the fix is undecided). Budget: one solve; its token/minute caps are wired in and not yours to change; never dispatch the same goal twice in one turn. Do NOT wrap an L2 task in solve "to be safe" — the research/spec phases are real money and buy nothing there.
L4 escalation chain — L3 criteria hold, plus any of: schema / auth / irreversible surface; external research needed; the previous L3 came back blocked or oracle-failed. You do not have the tools for that chain — emit the ? valve (<omd-escalation>, lane per the headless block). Empty-handed escalation is not escalation: state your leaning + reason + the one undecidable point.

The FIRST line of every reply, verbatim format:
route: L<n> · W=<yes|no> N=<0|1-2|3-8|>8|?> X=<1|>=2|?> O=<have|none|build|?>
Cannot fill a field → write "?" — never invent. Your declared route is compared against the route derived from your actual tool calls; mismatches are read out, so writing it honestly beats writing it favorably.
</routing-ladder>`;

/**
 * C-1 route 自述行解析。解析不出 = **null**(NULL ≠ 0 ≠ L0 —— 把「没申报」记成
 * 「直答」会让 L0 命中数虚高,而 L0 恰恰是最该被怀疑的一档)。
 * 只抽 level;W/N/X/O 保留原文 —— 派生比对在读侧 (ab-snapshot) 做,这里不重造。
 */
export function parseRouteLine(reply: string): { level: 'L0' | 'L1' | 'L2' | 'L3' | 'L4'; raw: string } | null {
  const m = reply.match(/^route:\s*(L[0-4])\b.*$/m);
  return m ? { level: m[1] as 'L0' | 'L1' | 'L2' | 'L3' | 'L4', raw: m[0] } : null;
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
  /**
   * §2 周预算闸的读数源(默认:现读 `.omd/tui-usage.jsonl` 的滚动 7 天窗口)。
   * **每次调用都重新读** —— 轮前一次、每次派图前一次,所以轮中途跨线也拦得住。
   */
  budget?: () => WeeklyBudgetStatus;
}

/** Read-only leaf hands are resource-bearing and therefore created once per conductor tool. */
function buildHeadlessHands(cwd: string): AnyOmdTool[] {
  return createOmdAgentTools({ cwd }).filter((t) => HEADLESS_HANDS.includes(t.name));
}

/**
 * P3 S6b (契约 D-22 / INV-1): conductor_chat 的 lead 卡上下文。与 solve 侧 (`run-goal.ts` `leadCtxOf`) 同形,
 * 差别只在来源: chat 位没有 run, 判据缺席 (best_of 据此拒)、座位从座位表现解、并发 cap 走 fleet 真源。
 */
function leadCtxForChat(cwd: string, tools: readonly OmdMcpTool[]): LeadCtx {
  const seat = (id: 'agent' | 'escalation' | 'verifier'): string => {
    try {
      return tryResolveSeatModel(id)?.model ?? '';
    } catch {
      return '';
    }
  };
  return {
    cwd,
    writeRoot: cwd,
    allowlist: allowlistForRoot(cwd),
    maxFanout: effectiveFanout({}, process.env),
    seats: { worker: seat('agent'), escalation: seat('escalation'), verify: seat('verifier') },
    // 装配面里有 dag_research 只说明工具在, provider 在不在由 research 卡的运行期判; 这里按"工具在"透传。
    researchAvailable: tools.some((t) => t.name === 'dag_research'),
  };
}

/**
 * P3 S6b (D-22): 七张 lead 卡在 chat 位的形态 —— compile 过的图经 `dag_run_plan` 派出去 (fire-and-forget,
 * 回执首行 `runId:` 由 `collectRunIds` 同款规则收), 拒绝 (zod / help / 编译) 走 tool result 带完整 manual (D-3)。
 * 与 solve 侧唯一的差别是 `runChild` 的实现 (那边同步等子 run 结束并回 fan-in 摘要, 这边立返 runId):
 * chat 位是 fire-and-forget 语义 (见文件头), 卡不该在这里变成阻塞调用。
 */
export function createLeadChatTools(cwd: string, tools: readonly OmdMcpTool[]): AnyOmdTool[] {
  const runPlan = tools.find((t) => t.name === 'dag_run_plan');
  if (!runPlan) throw new Error("[conductor_chat] 装配面里找不到 'dag_run_plan' — lead 卡没有派图通道");
  const ctx = leadCtxForChat(cwd, tools);
  return createLeadTools(ctx).map((card: LeadTool): AnyOmdTool => ({
    name: card.name,
    label: card.name,
    description: card.short,
    promptSnippet: `${card.name}(…) — ${card.short}`,
    parameters: Type.Unsafe(z.toJSONSchema(card.schema, { target: 'draft-7' })),
    executionMode: 'sequential',
    async execute(_id: string, params: unknown) {
      const compiled = invokeLeadTool(card, params, ctx);
      if (!compiled.ok) return { content: [{ type: 'text', text: formatRejection(compiled) }], details: { ok: false, card: card.name } };
      const res = (await (runPlan.handler as (a: unknown, extra: unknown) => unknown)(
        { plan: JSON.stringify(compiled.plan), task: `lead ${card.name}: ${compiled.plan.name}` },
        {},
      )) as { content?: { text?: string }[]; isError?: boolean };
      const text = (res.content ?? []).map((c) => c.text ?? '').filter(Boolean).join('\n');
      return { content: [{ type: 'text', text: res.isError ? `[TOOL ERROR]\n${text}` : text }], details: { ok: !res.isError, card: card.name, plan: compiled.plan.name } };
    },
  }) as AnyOmdTool);
}

/**
 * 一轮 conductor_chat 的完整工具面 (P3 S6b / D-22): `[...hands, ...lead 卡, ...createConductorChatTools(…)]`。
 * 三段缺一不可: hands 是只读手 (D-1); lead 卡与 solve 侧同一构造点 `createLeadTools` (INV-1 包含关系);
 * `createConductorChatTools` 必须**仍在调用路径上** —— 它体内第一行是 `assertSurfaceComplete` (装配期闸),
 * 把它换掉等于那道闸一次都不再跑 (闸消失, 不是变红)。
 */
export function buildChatRoundTools(
  deps: Pick<ConductorChatDeps, 'cwd' | 'tools'>,
  hands: readonly AnyOmdTool[],
  extraMcpTools: readonly OmdMcpTool[] = [],
): AnyOmdTool[] {
  const all = [...deps.tools, ...extraMcpTools];
  return [...hands, ...createLeadChatTools(deps.cwd, all), ...createConductorChatTools(all)];
}

/**
 * Headless tool surface used by tests and non-session callers. `createConductorChatTool`
 * keeps the hands from this split at assembly time and rebuilds only its session-bound
 * conductor wrappers per turn.
 */
export function buildHeadlessChatTools(deps: Pick<ConductorChatDeps, 'cwd' | 'tools'>): AnyOmdTool[] {
  return buildChatRoundTools(deps, buildHeadlessHands(deps.cwd));
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

/**
 * §2 预算闸的**派图侧**:超限时 `omd_run`/`omd_solve` 不进内层,直接以 `[TOOL ERROR]` 回执拒。
 *
 * 与轮前那道检查不重复 —— 轮前那道拦的是「这一轮别开始」,这道拦的是**轮跑到半截跨的线**
 * (conductor 一轮可以派好几张图;账本每次现读,所以第 N 张图能看见前 N-1 张烧出来的钱)。
 * 已在飞的图不动(fire-and-forget 语义不变),这里只拦**新派**。
 * `[TOOL ERROR]` 前缀是既有惯例(chat-tools 的 invoke 同款),顺带保证 collectRunIds 不收它。
 */
function guardBudget(tools: AnyOmdTool[], budget: () => WeeklyBudgetStatus): AnyOmdTool[] {
  return tools.map((t) => {
    if (t.name !== 'omd_run' && t.name !== 'omd_solve') return t;
    const inner = t.execute.bind(t);
    return {
      ...t,
      async execute(...args: Parameters<AnyOmdTool['execute']>) {
        const s = budget();
        if (!s.over) return inner(...args);
        return {
          content: [
            {
              type: 'text',
              text: `[TOOL ERROR]\n周预算闸: ${renderBudgetLine(s)} —— 拒派新图 (已在飞的图不动)。\n把这条原样上报给 owner, 别改用别的工具绕过去。`,
            },
          ],
          details: undefined,
        };
      },
    } as AnyOmdTool;
  });
}

export function createConductorChatTool(deps: ConductorChatDeps): OmdMcpTool {
  // NodeExecutionEnv is held by agent hands: build once at assembly, not once per turn.
  const hands = buildHeadlessHands(deps.cwd);
  // Default read source: ledger dir and harness/cli.ts MCP branch share this parser.
  const budget = deps.budget ?? (() => checkWeeklyBudget({ dir: usageLedgerDir(deps.cwd) }));
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
      // §2 周预算闸(轮**前**):超限就不跑这一轮 —— 一个 token 都不烧, 会话一个字节都不写。
      // 回执是**正常回执**(isError=false), 正文只有 lane="owner" 的阀块:超限不是工具坏了,
      // 是一个只有 owner 能裁的岔口, 走与 S2 同一条 ? 阀链(调用方禁代答)。
      const preTurn = budget();
      if (preTurn.over) {
        const head = [
          `sessionId: ${sid}`,
          'runIds: (无)',
          'escalation: lane=owner(阀块在正文,owner 级禁代答)',
          `budget: ${renderBudgetLine(preTurn)} —— 已超, 本轮未执行`,
          // usage/pressure 两行**故意不出现**:这一轮没跑, 没有 usage 可言。
          // 编一对 0 上去就把「没跑」和「跑了但没烧」抹平成同一个读数(NULL ≠ 0)。
        ].join('\n');
        return { content: [{ type: 'text' as const, text: `${head}\n---\n${renderBudgetEscalation(preTurn)}` }] };
      }
      // Session-bound history tools are rebuilt per round; sessionId stays explicit and fixed.
      const historyTools = createHistoryTools({ store: deps.store, sessionId: sid });
      // P3 S6b / D-22: hands + lead 七张卡 + conductor 工具 (含装配期闸)。
      const roundTools = buildChatRoundTools(deps, hands, historyTools);

      const runIds: string[] = [];
      try {
        const r = await runChatTurn({
          store: deps.store,
          sessionId: sid,
          prompt,
          model: deps.resolveModel(),
          // advisor 逐轮现解 (config 可热改, 与座位坐标同精神); 未配 = 无 (不自动选)。
          ...((): { advisor?: string } => {
            const a = resolveSeatAdvisor('conductor');
            return a ? { advisor: a } : {};
          })(),
          cwd: deps.cwd,
          tools: guardBudget(collectRunIds(roundTools, runIds), budget),
          // S2:headless 块拼在整份 prompt 尾部 —— 冻结前缀逐字不动,cache 面不伤。
          // S-C:路由阶梯同层追加 (C-1)。
          systemPromptHook: async (p) => `${p}\n\n${HEADLESS_PROMPT_BLOCK}\n\n${ROUTING_LADDER_BLOCK}`,
          ...(deps.loopFn ? { loopFn: deps.loopFn } : {}),
        });
        const pressure =
          r.pressure.ratio === null
            ? `used=${r.pressure.usedTokens} window=未知`
            : `${Math.round(r.pressure.ratio * 100)}% (${r.pressure.usedTokens}/${r.pressure.windowTokens})`;
        const escalation = parseEscalation(r.reply);
        // C-1: 申报面进回执头。没申报 = NULL 逐字可见, 不折算成任何档 (读侧派生另算两列)。
        const route = parseRouteLine(r.reply);
        const head = [
          `sessionId: ${sid}`,
          `route: ${route ? route.level : 'NULL(未申报)'}`,
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
