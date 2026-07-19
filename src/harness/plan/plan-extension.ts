/**
 * plan/plan-extension —— plan 技能 (审议/知识摄取/best-of-N) 的 ExtensionFactory。
 *
 * ## D-12 解绑: 技能不再背模式税。
 * 原本这些命令 (/grill /council /sdd /crystallize /note /ref /search /crystals) 被 plan mode 门控
 * (`status === 'plan'` 才放行), shift+tab 进只读座舱。**D-1 移除 plan mode** 后:
 *   - shift+tab 改绑 pathfinder (见 pathfinder-extension), **不再由本扩展注册**。
 *   - 技能全部**解绑为普通 slash 命令**: 普通聊天里直接可用, 无模式门, 无写闸 (D-5 开放 src)。
 *   - /sdd 仍产出 sdd-template 骨架 (P4/其他工作依赖), 落 docs/plan/。
 *
 * 一处闭包持有单个 PlanModeState (仅为 ledger 台账 + /execute 交接协议保留), 技能共享它累积审议:
 *   - /note /ref /search /crystals /council → 写 ledger / pushPending
 *   - before_agent_start → drain pending (摄取的 ref / 搜索 / council 结果注入下一轮) + grill overlay
 */
import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';
import { logger } from '../../logger';
import { PlanLedger } from './ledger';
import { createPlanModeState, type PlanModeState } from './mode';
import { GRILL_OVERLAY } from './overlay';
import { extractUrls, stripUrls } from './url-detect';
import { createDefaultWebRetriever, type WebRetriever } from './web-retriever';
import { createDistiller, type DistillFn } from './distill';
import { contextStage, COMPACT_PRESERVE_INSTRUCTIONS } from './context-monitor';
import { bestOfNPlan, councilDeepPlan } from './best-of-n';
import { createSessionStore, type SessionStore } from './session-store';
import { renderSddDoc } from './sdd-template';
import type { ThinkingLevel } from '../../runtime/types';
import { join } from 'node:path';

/** 保留导出 (index barrel + 历史契约): 曾是 plan mode 默认模型/thinking; 解绑后仅作常量占位。 */
export const PLAN_DEFAULT_MODEL = 'deepseek:deepseek-v4-pro';
export const PLAN_DEFAULT_THINKING: ThinkingLevel = 'xhigh';

export interface PlanExtensionOpts {
  /** 注入测试用 state (默认新建空台账)。 */
  state?: PlanModeState;
  /** Web 检索器 (知识摄取)。省略 = 默认 crawl 实现 (经 pi.exec)。测试注入桩。 */
  retriever?: WebRetriever;
  /** 蒸馏器 (摄取的 ref 原文先分析后截取再注入)。省略 = 默认 deepseek 蒸馏。测试注入桩。 */
  distill?: DistillFn;
  /** best-of-N: 省略 = 默认 bestOfNPlan (deepseek-v4-pro N 视角 + judge)。测试注入桩。 */
  bestOfN?: typeof bestOfNPlan;
  /** 深度 council。省略 = 默认 councilDeepPlan。测试注入桩。 */
  councilDeep?: typeof councilDeepPlan;
  /** session 结晶库 (crystallize 跨-session 持久层)。省略 = 默认 .omd/session-crystals.db。测试注入 :memory:。 */
  sessionStore?: SessionStore;
}

export function createPlanExtension(opts: PlanExtensionOpts = {}): ExtensionFactory {
  const state = opts.state ?? createPlanModeState(new PlanLedger());

  return (pi) => {
    type Ctx = Parameters<Parameters<typeof pi.registerCommand>[1]['handler']>[1];

    // 知识摄取: Web 检索器 (默认 crawl 经 pi.exec) + 蒸馏器 (原文先分析后截取再注入)。opts 可注专用工具/测试桩。
    const retriever: WebRetriever =
      opts.retriever ?? createDefaultWebRetriever((cmd, args, o) => pi.exec(cmd, args, o));
    const distill: DistillFn = opts.distill ?? createDistiller();
    const bestOfN = opts.bestOfN ?? bestOfNPlan;
    const councilDeep = opts.councilDeep ?? councilDeepPlan;
    let sessionStoreInst: SessionStore | undefined = opts.sessionStore;
    const getSessionStore = (): SessionStore => (sessionStoreInst ??= createSessionStore());

    /**
     * 抓一个 url → **蒸馏** (deepseek 读原文+关注点 → 抽相关关键点) → 摄进 ledger
     * (摘要+relevance 持久 + 蒸馏 extract pending 一次性注入)。返回是否成功。
     */
    const ingestUrl = async (url: string, focus: string, ctx: Ctx): Promise<boolean> => {
      if (state.ledger.hasRef(url)) {
        ctx.ui.notify(`↺ 已摄取过 ${url}`, 'info');
        return true;
      }
      try {
        const r = await retriever.fetch(url);
        if (!r.ok) {
          ctx.ui.notify(`✗ 摄取失败 ${url}: ${r.error ?? '未知'}`, 'error');
          logger.warn({ url, err: r.error }, '[omd/plan] 摄取失败');
          return false;
        }
        const d = await distill(r.markdown, focus || state.ledger.goal, r.url);
        state.ledger.addRef({ url: r.url, title: r.title, relevance: d.relevance }, d.extract);
        ctx.ui.notify(`📥 已摄取「${r.title ?? r.url}」— ${d.relevance}`, 'info');
        return true;
      } catch (err) {
        logger.warn({ url, err: (err as Error).message }, '[omd/plan] 摄取异常');
        return false;
      }
    };

    // /note: 记一条决策进台账 (plan ledger 真实写路径; /sdd /crystallize 消费)。
    pi.registerCommand('note', {
      description: '记一条规划决策进 plan 台账 (供 /sdd /crystallize 收割)',
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

    // /ref <url...>: 显式摄取链接。github/论文/知乎等 → markdown 蒸馏折进 ledger, 下轮注入。
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
          const results = await Promise.all(urls.map((u) => ingestUrl(u, focus, ctx)));
          const ok = results.filter(Boolean).length;
          ctx.ui.notify(`/ref 完成: ${ok}/${urls.length} 摄取 (蒸馏后下轮注入)`, ok === urls.length ? 'info' : 'warning');
        } finally {
          ctx.ui.setStatus('ref', undefined);
        }
      },
    });

    // /search <query>: 元搜索, 结果折进下轮 context。
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

    // /grill: 切 grill-with-docs 子模式 (对抗式逼问 → Contracts+D-ADR delta)。解绑后普通聊天可用。
    pi.registerCommand('grill', {
      description: 'Toggle grill-with-docs 子模式 (对抗式逼问 → Contracts+D-ADR delta)',
      handler: async (_args: string, ctx: Ctx) => {
        state.grilling = !state.grilling;
        ctx.ui.setStatus('grill', state.grilling ? '🔬 GRILL' : undefined);
        ctx.ui.notify(state.grilling ? '🔬 进入 GRILL (对抗式逼问锁契约)' : '退出 GRILL', 'info');
      },
    });

    // 每轮注入: (grill overlay 若开) + drain pending (摄取的 ref / 搜索 / council 结果, 仅注一次)。
    // pi 每轮传 fresh baseSystemPrompt, 无需 includes 防重复。
    pi.on('before_agent_start', (event) => {
      const parts: string[] = [];
      if (state.grilling) parts.push(GRILL_OVERLAY);
      const pending = state.ledger.drainPending();
      if (pending.length > 0) parts.push(`<fetched-refs 本轮新摄取>\n${pending.join('\n\n')}\n</fetched-refs>`);
      if (parts.length === 0) return {};
      return { systemPrompt: `${event.systemPrompt}\n\n${parts.join('\n\n')}` };
    });

    // /crystallize [标题]: 收割当前审议态 → .omd/sessions/ 文档 + session 结晶库 (跨 session 可召回)。
    // ≥70% context 时 harvest-then-compact (保 context)。
    pi.registerCommand('crystallize', {
      description: '收割当前审议态 → .omd/sessions/ 文档 + session 结晶库 (跨 session 可召回); 满则顺带 compact',
      handler: async (args: string, ctx: Ctx) => {
        const title = args.trim() || state.ledger.goal || 'omd 审议';
        const slug = title.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'session';
        const date = new Date().toISOString().slice(0, 10);
        const sessionId = pi.getSessionName?.() ?? 'unnamed';
        const rel = join('.omd', 'sessions', `${date}-${slug}.md`);
        try {
          await Bun.write(join(ctx.cwd, rel), state.ledger.crystallize(title, date));
          getSessionStore().record({
            sessionId,
            title,
            goal: state.ledger.goal,
            decisions: [...state.ledger.decisions],
            refs: state.ledger.refs.map((r) => ({ url: r.url, title: r.title, relevance: r.relevance })),
          });
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
    // 追加 canonical-plan 增强段 (接缝/先红/oracle/文件边界/review gate/D-number, 见 sdd-template)。
    // ★ P4/其他工作依赖此 sdd-template 产出, 解绑后仍保留。
    pi.registerCommand('sdd', {
      description: '当前审议台账 → 结构化 SDD+TDD 骨架落 docs/plan/ (canonical plan; 跨 session 可召回)',
      handler: async (args: string, ctx: Ctx) => {
        const title = args.trim() || state.ledger.goal || 'omd SDD';
        const slug = title.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'sdd';
        const date = new Date().toISOString().slice(0, 10);
        const sessionId = pi.getSessionName?.() ?? 'unnamed';
        const rel = join('docs', 'plan', `${date}-${slug}.md`);
        try {
          await Bun.write(join(ctx.cwd, rel), renderSddDoc(state.ledger.crystallize(title, date)));
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

    // /council [deep]: 一组视角"开会"审议择优 — 当前方案 context → N 视角推理 leaf 出方案 →
    // 多视角 judge → cherry-pick 合成注下轮。轻量 = best-of-N; `/council deep` = researchFanout at scale。
    pi.registerCommand('council', {
      description: 'council 多视角择优: N 视角出方案 → 多视角 judge → cherry-pick 合成 (底层 best-of-N)。`/council deep` 走深度档',
      handler: async (args: string, ctx: Ctx) => {
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
