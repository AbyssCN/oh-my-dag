/**
 * plan/plan-extension —— 把 plan mode 接进 pi 终端 TUI 的 ExtensionFactory (P1 脊柱)。
 *
 * 一处闭包持有单个 PlanModeState, 所有 handler 共享:
 *   - registerShortcut('shift+tab')  → 切 mode。**前提**: pi 0.77 把 shift+tab(=app.thinking.cycle)
 *     列入 RESERVED_KEYBINDINGS_FOR_EXTENSION_CONFLICTS → getShortcuts 会静默 skip 撞保留键的扩展
 *     shortcut。故 tui boot 前调 ensurePlanToggleKeyFree() 把 thinking-cycle 从 shift+tab 让路
 *     (keybindings-setup.ts), 释放该键; 之后 handleInput 最先查扩展 shortcut (custom-editor.js:26) 早返 shadow。
 *   - registerCommand('plan')        → 显式 toggle (可发现性, shift+tab 同效)
 *   - registerCommand('model')       → 模型座舱: 列 pi provider/model + setModel 切换
 *   - registerCommand('note')        → 记决策进 ledger (台账真实写路径)
 *   - on('tool_call')                → plan mode 下写工具/写命令 fail-closed block (readonly-gate)
 *   - on('before_agent_start')       → plan mode 下注审议 overlay + ledger (每轮重审)
 *
 * plan mode 是**交互-TUI 专属** (键盘/UI), daemon(PiRuntime) 无键盘 → 接在 tui.ts 而非 controller。
 */
import { getModel } from '@earendil-works/pi-ai';
import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';
import { resolveRoleModel } from '../../model/role-models';
import type { ThinkingLevel } from '../../runtime/types';
import { logger } from '../../logger';
import { parseModelRef } from '../fleet';
import { PlanLedger } from './ledger';
import { createPlanModeState, type PlanModeState } from './mode';
import { GRILL_OVERLAY, PLAN_MODE_OVERLAY } from './overlay';
import { isBashMutation, isWriteTool, isDocWritePath, writeTargetPath } from './readonly-gate';
import { extractUrls, stripUrls } from './url-detect';
import { createDefaultWebRetriever, type WebRetriever } from './web-retriever';
import { createDistiller, type DistillFn } from './distill';
import { contextStageNote, contextStage, COMPACT_PRESERVE_INSTRUCTIONS } from './context-monitor';
import { bestOfNPlan, councilDeepPlan } from './best-of-n';
import { createSessionStore, type SessionStore } from './session-store';
import { join } from 'node:path';

/** plan mode 默认模型 (the owner 锁): deepseek-v4-pro, thinking 拉满。独立于执行模型。 */
export const PLAN_DEFAULT_MODEL = 'deepseek:deepseek-v4-pro';
export const PLAN_DEFAULT_THINKING: ThinkingLevel = 'xhigh';

export interface PlanExtensionOpts {
  /** plan mode 默认模型 'provider:modelId'。默认 deepseek:deepseek-v4-pro。 */
  planModel?: string;
  /** plan mode 默认 thinking。默认 'xhigh' (拉满)。 */
  planThinking?: ThinkingLevel;
  /** 切换键。默认 'shift+tab' (抢占 thinking-cycle)。 */
  toggleKey?: string;
  /** 注入测试用 state (默认新建空台账)。 */
  state?: PlanModeState;
  /** Web 检索器 (D 子系统知识摄取)。省略 = 默认 crawl 实现 (经 pi.exec)。测试注入桩。 */
  retriever?: WebRetriever;
  /** 蒸馏器 (摄取的 ref 原文先分析后截取再注入)。省略 = 默认 deepseek 蒸馏。测试注入桩。 */
  distill?: DistillFn;
  /** best-of-N (G): 省略 = 默认 bestOfNPlan (deepseek-v4-pro N 视角 + judge)。测试注入桩。 */
  bestOfN?: typeof bestOfNPlan;
  /** 深度 council (researchFanout at scale)。省略 = 默认 councilDeepPlan。测试注入桩。 */
  councilDeep?: typeof councilDeepPlan;
  /** session 结晶库 (F crystallize 跨-session 持久层)。省略 = 默认 .omd/session-crystals.db。测试注入 :memory:。 */
  sessionStore?: SessionStore;
  /** carve-out 路径解析基准 (gate 判 docs/plan|.omd 写放行)。省略 = process.cwd()。测试注入临时 cwd。 */
  cwd?: string;
}

/** 解析 'provider:modelId' → pi-ai Model (cast 同 agent-leaf, 绕泛型严格约束)。 */
function resolvePiModel(ref: string): unknown {
  const { provider, modelId } = parseModelRef(ref);
  return getModel(provider as Parameters<typeof getModel>[0], modelId as never);
}

export function createPlanExtension(opts: PlanExtensionOpts = {}): ExtensionFactory {
  // plan 模型纳入统一 config 中心: opts 注入 > resolveRoleModel('plan') (file/env/默认 PLAN_DEFAULT_MODEL)。
  const planModelStr = opts.planModel ?? resolveRoleModel('plan');
  const planModelRef = parseModelRef(planModelStr);
  const planThinking = opts.planThinking ?? PLAN_DEFAULT_THINKING;
  const toggleKey = opts.toggleKey ?? 'shift+tab';
  const state = opts.state ?? createPlanModeState(new PlanLedger());
  const gateCwd = opts.cwd ?? process.cwd();

  return (pi) => {
    type Ctx = Parameters<Parameters<typeof pi.registerShortcut>[1]['handler']>[0];

    // D 子系统: Web 检索器 (默认 crawl 经 pi.exec) + 蒸馏器 (原文先分析后截取再注入)。opts 可注专用工具/测试桩。
    const retriever: WebRetriever =
      opts.retriever ?? createDefaultWebRetriever((cmd, args, o) => pi.exec(cmd, args, o));
    const distill: DistillFn = opts.distill ?? createDistiller();
    const bestOfN = opts.bestOfN ?? bestOfNPlan;
    const councilDeep = opts.councilDeep ?? councilDeepPlan;
    let sessionStoreInst: SessionStore | undefined = opts.sessionStore;
    const getSessionStore = (): SessionStore => (sessionStoreInst ??= createSessionStore());

    /**
     * 抓一个 url → **蒸馏** (deepseek 读原文+关注点 → 抽相关关键点, 非原文直灌) → 摄进 ledger
     * (摘要+relevance 持久 + 蒸馏 extract pending 一次性注入)。返回是否成功。ctx 省略 = 静默 (input 自动摄取路径)。
     * focus = 当前规划关注点 (input 文本去 url / ref 命令上下文 / ledger.goal), 决定抽什么。
     * 全 try/catch: retriever/distill 各自内部已 fail-safe, 这层兜任何残余异常 → 不崩 input/命令流。
     */
    const ingestUrl = async (url: string, focus: string, ctx?: Ctx): Promise<boolean> => {
      if (state.ledger.hasRef(url)) {
        ctx?.ui.notify(`↺ 已摄取过 ${url}`, 'info');
        return true;
      }
      try {
        const r = await retriever.fetch(url);
        if (!r.ok) {
          ctx?.ui.notify(`✗ 摄取失败 ${url}: ${r.error ?? '未知'}`, 'error');
          logger.warn({ url, err: r.error }, '[omd/plan] 摄取失败');
          return false;
        }
        const d = await distill(r.markdown, focus || state.ledger.goal, r.url);
        state.ledger.addRef({ url: r.url, title: r.title, relevance: d.relevance }, d.extract);
        ctx?.ui.notify(`📥 已摄取「${r.title ?? r.url}」— ${d.relevance}`, 'info');
        return true;
      } catch (err) {
        logger.warn({ url, err: (err as Error).message }, '[omd/plan] 摄取异常');
        return false;
      }
    };

    const enterPlan = async (ctx: Ctx): Promise<void> => {
      state.savedModel = ctx.model ?? null;
      state.savedThinking = pi.getThinkingLevel() as ThinkingLevel;
      let switched = false;
      try {
        switched = await pi.setModel(
          resolvePiModel(planModelStr) as Parameters<typeof pi.setModel>[0],
        );
        pi.setThinkingLevel(planThinking);
      } catch (err) {
        logger.warn({ err: (err as Error).message }, '[omd/plan] 进入时切模型失败');
      }
      state.status = 'plan';
      ctx.ui.setStatus('plan', `◇ PLAN · ${planModelRef.modelId} · ${planThinking}`);
      ctx.ui.notify(
        `◇ 进入 PLAN MODE (只读审议) — ${planModelRef.provider}:${planModelRef.modelId} thinking=${planThinking}` +
          (switched ? '' : ' [⚠ 模型未切换: 缺 API key, 沿用当前模型]'),
        'info',
      );
    };

    const exitPlan = (ctx: Ctx): void => {
      state.status = 'normal';
      if (state.savedModel) {
        void pi.setModel(state.savedModel as Parameters<typeof pi.setModel>[0]);
      }
      if (state.savedThinking) pi.setThinkingLevel(state.savedThinking);
      state.savedModel = null;
      state.savedThinking = null;
      ctx.ui.setStatus('plan', undefined);
      ctx.ui.notify('▶ 退出 PLAN MODE — 恢复执行模型, 写工具解禁', 'info');
    };

    // 重入 guard (G2 P1-1): enterPlan 是 async (await pi.setModel), status 在 await 后才翻 →
    // 快速双击 shift+tab 会在 status 翻转前重入 enterPlan, 覆盖 savedModel → 退出还原错模型。
    // transitioning 闸: 一次切换在途时忽略后续 toggle。
    let transitioning = false;
    const toggle = async (ctx: Ctx): Promise<void> => {
      if (transitioning) return;
      transitioning = true;
      try {
        if (state.status === 'normal') await enterPlan(ctx);
        else exitPlan(ctx);
      } finally {
        transitioning = false;
      }
    };

    // shift+tab 切 mode (抢占内置 thinking-cycle; 需 tui boot 前 ensurePlanToggleKeyFree() 让路, 见 header)。
    pi.registerShortcut(toggleKey as Parameters<typeof pi.registerShortcut>[0], {
      description: 'Toggle omd plan mode (只读审议座舱)',
      handler: toggle,
    });

    // /plan 显式 toggle (可发现性 + fallback)。registerCommand 名不带前导斜杠 (pi slice(1) 后匹配)。
    pi.registerCommand('plan', {
      description: 'Toggle plan mode (只读审议座舱)。shift+tab 同效',
      handler: async (_args: string, ctx: Ctx) => {
        await toggle(ctx);
      },
    });

    // 注: /model 模型座舱命令已移除 —— pi 0.77 有内置 /model (扩展同名命令被 reserved 冲突 skip,
    // 见 [[keybindings-setup]] 同类坑)。切模型走 pi 原生 /model; 选默认模型走 init wizard / .env。

    // /note: 记一条决策进台账 (plan ledger 真实写路径)。
    pi.registerCommand('note', {
      description: '记一条规划决策进 plan 台账 (每轮重注入)',
      handler: async (args: string, ctx: Ctx) => {
        const t = args.trim();
        if (!t) {
          ctx.ui.notify('用法: /note <决策>', 'warning');
          return;
        }
        state.ledger.note(t);
        ctx.ui.notify(`📋 已记决策 (${state.ledger.decisions.length})`, 'info');
      },
    });

    // /ref <url...>: 显式摄取链接 (D 子系统)。github/论文/知乎等 → markdown 折进 ledger。
    pi.registerCommand('ref', {
      description: '摄取参考链接进 plan 台账。用法: /ref <url> [更多 url]',
      handler: async (args: string, ctx: Ctx) => {
        const urls = extractUrls(args);
        if (urls.length === 0) {
          ctx.ui.notify('用法: /ref <url> [更多 url]', 'warning');
          return;
        }
        const focus = stripUrls(args); // url 旁的框定语作蒸馏 focus
        ctx.ui.setStatus('ref', `摄取 ${urls.length} 链接 (抓取+蒸馏)…`);
        try {
          // 并行抓取+蒸馏 (G2 P1-1: 不串行阻塞)。pending 留给 before_agent_start 下轮 drain。
          const results = await Promise.all(urls.map((u) => ingestUrl(u, focus, ctx)));
          const ok = results.filter(Boolean).length;
          ctx.ui.notify(`/ref 完成: ${ok}/${urls.length} 摄取 (蒸馏后下轮注入)`, ok === urls.length ? 'info' : 'warning');
        } finally {
          ctx.ui.setStatus('ref', undefined);
        }
      },
    });

    // /search <query>: 元搜索 (D 子系统), 结果折进下轮 context。
    pi.registerCommand('search', {
      description: '元搜索 (metasearch) 更多来源, 结果注入下轮 context。用法: /search <query>',
      handler: async (args: string, ctx: Ctx) => {
        const q = args.trim();
        if (!q) {
          ctx.ui.notify('用法: /search <query>', 'warning');
          return;
        }
        ctx.ui.setStatus('search', `搜索 ${q.slice(0, 30)}…`);
        try {
          const r = await pi.exec('metasearch', [q], { timeout: 30_000 });
          const out = (r.stdout || '').trim();
          if (r.code !== 0 || !out) {
            ctx.ui.notify(`搜索无结果 (${(r.stderr || `exit ${r.code}`).slice(0, 80)})`, 'warning');
            return;
          }
          const clipped = out.length > 4000 ? `${out.slice(0, 4000)}\n…(截断)` : out;
          state.ledger.pushPending(`<search query="${q.replace(/"/g, "'")}">\n${clipped}\n</search>`);
          ctx.ui.notify(`🔎 元搜索完成, 结果注入下轮 context`, 'info');
        } finally {
          ctx.ui.setStatus('search', undefined);
        }
      },
    });

    // /grill: 切 grill-with-docs 子模式 (C 子系统)。complexity-gated offer 后用户确认入口。
    pi.registerCommand('grill', {
      description: 'Toggle grill-with-docs 子模式 (对抗式逼问 → Contracts+D-ADR delta)',
      handler: async (_args: string, ctx: Ctx) => {
        if (state.status !== 'plan') {
          ctx.ui.notify('grill 仅在 plan mode 内 (先 shift+tab 进 plan)', 'warning');
          return;
        }
        state.grilling = !state.grilling;
        ctx.ui.setStatus('grill', state.grilling ? '🔬 GRILL' : undefined);
        ctx.ui.notify(state.grilling ? '🔬 进入 GRILL (对抗式逼问锁契约)' : '退出 GRILL', 'info');
      },
    });

    // 自动摄取: plan mode 下用户输入含 URL → 自动抓取+蒸馏, **transform 直接注进本轮消息**。
    // 设计 (G2 P1-1/P1-2): ① 并行摄取不串行阻塞 ② transform 注入绕开 before_agent_start drain 时序
    // (pi await input handler 后才 build prompt, 源码 agent-session.js:719/724 — 故 transform 必入本轮 context, 不丢)。
    pi.on('input', async (event) => {
      if (state.status !== 'plan' || event.source !== 'interactive') return { action: 'continue' };
      const urls = extractUrls(event.text).filter((u) => !state.ledger.hasRef(u));
      if (urls.length === 0) return { action: 'continue' };
      const focus = stripUrls(event.text); // 用户在链接旁的框定语作蒸馏 focus
      await Promise.all(urls.map((u) => ingestUrl(u, focus))); // 静默 (无 ctx), ingestUrl 内 fail-safe
      const drained = state.ledger.drainPending(); // 取本次摄取的蒸馏 extract, 直接注本轮消息
      if (drained.length === 0) return { action: 'continue' };
      return {
        action: 'transform',
        text: `${event.text}\n\n<fetched-refs 自动摄取>\n${drained.join('\n\n')}\n</fetched-refs>`,
      };
    });

    // 只读闸 + carve-out: plan mode 下写工具拦, **但放行文档区** (docs/plan/ 与 .omd/ — 审议产物);
    // 实装代码 (src/**) 仍 fail-closed block。bash 写无 carve-out (文档写走 write 工具)。
    pi.on('tool_call', (event) => {
      if (state.status !== 'plan') return {};
      if (isWriteTool(event.toolName)) {
        const target = writeTargetPath(event.input);
        if (isDocWritePath(target, { cwd: gateCwd })) return {}; // carve-out: 文档区放行
        return {
          block: true,
          reason: `PLAN MODE 只读: 工具 ${event.toolName} 被拦。仅 docs/plan/ 与 .omd/ 文档区可写 (审议产物); 实装代码先把方案讨论到对齐, shift+tab 退出 plan mode 再落地。`,
        };
      }
      if (event.toolName === 'bash') {
        const cmd = (event.input as { command?: string } | undefined)?.command ?? '';
        if (cmd && isBashMutation(cmd)) {
          return {
            block: true,
            reason: `PLAN MODE 只读: bash 写操作被拦 (${cmd.slice(0, 60)})。plan mode 只允许只读探查 (grep/ls/cat/git log 等)。`,
          };
        }
      }
      return {};
    });

    // 审议 overlay + 台账 + (grill) + context 阶段提示 + 一次性 ref 正文注入 (仅 plan mode, 每轮)。
    // 注: pi 每轮传 _baseSystemPrompt (静态 base, 永不含上轮注入, 源码确证 agent-session.js:795) →
    // 无需 includes 防重复; 每轮 fresh append, ledger/pending 取最新。ctx (event handler 第二参) 读 context%。
    pi.on('before_agent_start', (event, ctx) => {
      if (state.status !== 'plan') return {};
      state.ledger.bumpTurn();
      const parts = [PLAN_MODE_OVERLAY, state.ledger.render()];
      if (state.grilling) parts.push(GRILL_OVERLAY);
      // F: context 阶段提示 (代码读 pi getContextUsage().percent, <70% 推继续保 context / ≥ 推 crystallize)。
      const pct = ctx?.getContextUsage?.()?.percent ?? null;
      const stageNote = contextStageNote(pct);
      if (stageNote) {
        parts.push(stageNote);
        ctx?.ui?.setStatus?.('ctx', `ctx ${Math.round(pct as number)}%`);
      }
      const pending = state.ledger.drainPending(); // 抓到的 ref 正文 / 搜索结果, 仅注一次
      if (pending.length > 0) parts.push(`<fetched-refs 本轮新摄取>\n${pending.join('\n\n')}\n</fetched-refs>`);
      return { systemPrompt: `${event.systemPrompt}\n\n${parts.join('\n\n')}` };
    });

    // /crystallize [标题]: session-scoped 收割 (F)。落 ① session-keyed 文档 ② session-crystal SQLite 行
    // (跨 session 可召回 + 喂 /handoff)。写文档/库非写码 → 不受只读闸限。≥70% 时 harvest-then-compact (保 context)。
    pi.registerCommand('crystallize', {
      description: '收割当前审议态 → .omd/sessions/ 文档 + session 结晶库 (跨 session 可召回); 满则顺带 compact',
      handler: async (args: string, ctx: Ctx) => {
        if (state.status !== 'plan') {
          ctx.ui.notify('crystallize 仅在 plan mode 内', 'warning');
          return;
        }
        const title = args.trim() || state.ledger.goal || 'omd 审议';
        const slug = title.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'session';
        const date = new Date().toISOString().slice(0, 10);
        const sessionId = pi.getSessionName?.() ?? 'unnamed';
        const rel = join('.omd', 'sessions', `${date}-${slug}.md`);
        try {
          // ① session-keyed 文档 (非写死 docs/plan; session 不一定全是 plan)。
          await Bun.write(join(ctx.cwd, rel), state.ledger.crystallize(title, date));
          // ② session-crystal 行 (跨 session 检索 + handoff 原料)。
          getSessionStore().record({
            sessionId,
            title,
            goal: state.ledger.goal,
            decisions: [...state.ledger.decisions],
            refs: state.ledger.refs.map((r) => ({ url: r.url, title: r.title, relevance: r.relevance })),
          });
          // ③ ≥70% 时 harvest-then-compact: 价值已收割 + ledger 重注决策兜底 → compact 安全 (handoff 对齐指令)。
          const pct = ctx.getContextUsage?.()?.percent ?? null;
          if (contextStage(pct) === 'crystallize') {
            ctx.compact?.({ customInstructions: COMPACT_PRESERVE_INSTRUCTIONS });
            ctx.ui.notify(`📄 已结晶 → ${rel} + 结晶库; context ${Math.round(pct as number)}% → 已 compact (决策保留)`, 'info');
          } else {
            ctx.ui.notify(`📄 已结晶 → ${rel} + 结晶库 (跨 session 可召回; context 保留未 compact)`, 'info');
          }
        } catch (e) {
          ctx.ui.notify(`crystallize 失败: ${String(e)}`, 'error');
        }
      },
    });

    // /sdd [标题]: 把当前审议台账落成结构化 **SDD+TDD 骨架** → docs/plan/ (canonical plan)。
    // 与 /crystallize 同一骨架 (ledger.crystallize), 区别是落点: crystallize→.omd/sessions 纪要,
    // sdd→docs/plan canonical plan。写 docs/plan/ 经 carve-out 放行 (非写码)。也记结晶库供 /crystals 召回。
    pi.registerCommand('sdd', {
      description: '当前审议台账 → 结构化 SDD+TDD 骨架落 docs/plan/ (canonical plan; 跨 session 可召回)',
      handler: async (args: string, ctx: Ctx) => {
        if (state.status !== 'plan') {
          ctx.ui.notify('sdd 仅在 plan mode 内', 'warning');
          return;
        }
        const title = args.trim() || state.ledger.goal || 'omd SDD';
        const slug = title.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'sdd';
        const date = new Date().toISOString().slice(0, 10);
        const sessionId = pi.getSessionName?.() ?? 'unnamed';
        const rel = join('docs', 'plan', `${date}-${slug}.md`);
        try {
          await Bun.write(join(ctx.cwd, rel), state.ledger.crystallize(title, date));
          getSessionStore().record({
            sessionId,
            title,
            goal: state.ledger.goal,
            decisions: [...state.ledger.decisions],
            refs: state.ledger.refs.map((r) => ({ url: r.url, title: r.title, relevance: r.relevance })),
          });
          ctx.ui.notify(`📐 SDD+TDD 骨架 → ${rel} (canonical plan; 跨 session 可召回)`, 'info');
        } catch (e) {
          ctx.ui.notify(`sdd 失败: ${String(e)}`, 'error');
        }
      },
    });

    // /crystals [query]: 跨 session 召回过往 crystallize 结晶 (上次结论) → 注入下轮 context。
    pi.registerCommand('crystals', {
      description: '召回过往 session 的审议结晶 (跨 session 续上次结论)。用法: /crystals [query]',
      handler: async (args: string, ctx: Ctx) => {
        if (state.status !== 'plan') {
          ctx.ui.notify('crystals 仅在 plan mode 内', 'warning');
          return;
        }
        const q = args.trim();
        const hits = q ? getSessionStore().search(q, 5) : getSessionStore().list(5);
        if (hits.length === 0) {
          ctx.ui.notify('无过往结晶', 'info');
          return;
        }
        const block = hits
          .map(
            (h) =>
              `【${h.title}】(${new Date(h.createdAt).toISOString().slice(0, 10)})\n目标: ${h.goal}\n决策: ${h.decisions.join('; ') || '(无)'}`,
          )
          .join('\n\n');
        state.ledger.pushPending(`<past-crystals 跨session召回>\n${block}\n</past-crystals>`);
        ctx.ui.notify(`🔮 召回 ${hits.length} 条结晶, 注入下轮 context`, 'info');
      },
    });

    // /council [deep] (G): 一组视角"开会"审议择优 — 当前方案 context → N 视角推理 leaf 出方案 →
    // 多视角 judge → cherry-pick 合成注下轮。轻量 = best-of-N (bestOfNPlan);
    // `/council deep` = researchFanout at scale (L×V + reduce + framing + K-judge panel + graft)。
    pi.registerCommand('council', {
      description: 'council 多视角择优: N 视角出方案 → 多视角 judge → cherry-pick 合成 (底层 best-of-N)。`/council deep` 走深度档 (researchFanout at scale)',
      handler: async (args: string, ctx: Ctx) => {
        if (state.status !== 'plan') {
          ctx.ui.notify('council 仅在 plan mode 内', 'warning');
          return;
        }
        const planContext = `目标: ${state.ledger.goal || '(见下方台账/讨论)'}\n\n${state.ledger.render()}`;
        // 深度档: /council deep — researchFanout at scale。
        if (/^(deep|research|深度)$/i.test(args.trim())) {
          ctx.ui.setStatus('council', '深度 council (L×V → reduce → framing → judge panel → graft)…');
          try {
            const r = await councilDeep(planContext, {
              onStage: (s, d) => ctx.ui.setStatus('council', `深度 council: ${s} ${d}`.slice(0, 60)),
            });
            state.ledger.pushPending(`<council-deep leaves="${r.leafCount}">\n${r.final}\n</council-deep>`);
            ctx.ui.notify(
              `🏛️ 深度 council: ${r.leafCount} leaf, 合成方案注入下轮 context ($${r.costStats.totalUsd.toFixed(3)})`,
              'info',
            );
          } catch (e) {
            ctx.ui.notify(`深度 council 失败: ${String(e)}`, 'error');
          } finally {
            ctx.ui.setStatus('council', undefined);
          }
          return;
        }
        ctx.ui.setStatus('council', 'N 视角生成+评判 (deepseek-pro)…');
        try {
          const r = await bestOfN(planContext);
          if (!r.verdict) {
            ctx.ui.notify('best-of-N: 全部候选失败', 'error');
            return;
          }
          state.ledger.pushPending(
            `<best-of-n winner="${r.verdict.winner}" candidates="${r.candidates.length}">\n${r.verdict.synthesis}\n</best-of-n>`,
          );
          ctx.ui.notify(
            `🏆 best-of-${r.candidates.length}: winner=${r.verdict.winner}, 合成方案注入下轮 context。${r.verdict.rationale.slice(0, 80)}`,
            'info',
          );
        } catch (e) {
          ctx.ui.notify(`best-of-N 失败: ${String(e)}`, 'error');
        } finally {
          ctx.ui.setStatus('council', undefined);
        }
      },
    });
  };
}
