/**
 * pathfinder-extension —— pathfinder 模式 (渐进散雾式规划) 的 ExtensionFactory (组件 8, D-1)。
 *
 * D-1: **shift+tab 改绑 pathfinder** (原只读 plan mode 移除, 见 plan/mode.ts + plan-extension.ts)。
 * 进模式: 扫 docs/plan/pathfinder/*.md (map-store), 有开放地图 → resume + surface 前沿; 无 → 提示命名目的地。
 * D-5: 开放 src, **无硬只读闸** (pathfinder 是工作台非上锁座舱); deliberate/build 边界迁到 slice→/execute。
 *
 * 命令面:
 *   - shift+tab / /pathfinder → toggle 模式
 *   - /path [目的地|slug]      → 无参列本 repo 开放地图; 有参开/建地图并 surface 前沿
 *   - /tickets                 → 列当前地图前沿票 (computeFrontier)
 *   - /rule <ticketId> <裁决>  → 裁一张前沿票 → 落 md+db → 前沿重算
 *   - /deliver                 → owner 显式执行已散尽区域 (代码闸: 散尽只报信, 不自动执行)
 *
 * ★ P3 注入点 `onRegionClear(regionIds)`: 区域散尽时回调 (override 默认报信+/deliver 闸)。
 *
 * idiom 参考 verify-gate-extension (工厂闭包持状态 + i18n m())。map-store/frontier/slice-compiler 只读 import。
 */
import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { m } from './i18n';
import { executeSlice as realExecuteSlice, resolveConductorDefault as realResolveConductorDefault, type ExecuteSliceOpts } from './execute-extension';
import type { AgentLeafRunner, CommandLeafRunner } from './leaf-runners';
import { countDispatchedResearch, dispatchFrontier as realDispatchFrontier } from './pathfinder/dispatch';
import { reflowResearchResults as realReflowResearchResults } from './pathfinder/afk-hook';
import { resolveBackend } from './pathfinder/backend';
import { computeFrontier } from './pathfinder/frontier';
import { loadMap, mutateMap, saveMap } from './pathfinder/map-store';
import { compileSlice as realCompileSlice, regionIsClear } from './pathfinder/slice-compiler';
import type { PathMap } from './pathfinder/types';
import { createPathfinderModeState, type PathfinderModeState } from './plan/mode';

// 地图 IO 的真身迁到 map-store (单写口 mutateMap 所在); re-export 兼容既有 import (omd-path CLI / 测试)。
export { loadMap, mutateMap, saveMap } from './pathfinder/map-store';

// ── 纯/薄-IO helpers (CLI omd-path 复用) ──────────────────────────────────────

/** 目的地 → 稳定 slug (markdown 文件名 + db 主键)。与 plan crystallize 同风格, 小写化。 */
export function slugifyDestination(destination: string): string {
  return (
    destination
      .trim()
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40)
      .toLowerCase() || 'map'
  );
}

/** 一张开放地图的摘要 (CLI/status 用)。 */
export interface OpenMapSummary {
  slug: string;
  destination: string;
  /** 未裁决 (非 ruled/escalated) 的票数。 */
  openCount: number;
  /** 当前前沿 (可动) 票数 (computeFrontier)。 */
  frontierCount: number;
}

/** 扫 docs/plan/pathfinder/*.md, 每图算 open/frontier 计数。目录不存在 → []。按 slug 排序。 */
export function summarizeOpenMaps(cwd: string): OpenMapSummary[] {
  const dir = join(cwd, 'docs', 'plan', 'pathfinder');
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.md'));
  } catch {
    return [];
  }
  const out: OpenMapSummary[] = [];
  for (const f of files.sort()) {
    const slug = f.slice(0, -3);
    const map = loadMap(cwd, slug);
    if (!map) continue;
    out.push({
      slug: map.slug || slug,
      destination: map.destination,
      openCount: map.tickets.filter((t) => t.status !== 'ruled' && t.status !== 'escalated').length,
      frontierCount: computeFrontier(map).length,
    });
  }
  return out;
}

/** 开/建一张地图: slug 已存在 → resume (created=false); 否则建空图并落盘 (created=true)。 */
export function createOrResumeMap(cwd: string, destination: string): { map: PathMap; created: boolean } {
  const slug = slugifyDestination(destination);
  const existing = loadMap(cwd, slug);
  if (existing) return { map: existing, created: false };
  const map: PathMap = { destination, slug, tickets: [], decisionsLog: [] };
  saveMap(map, cwd);
  return { map, created: true };
}

// ── extension ────────────────────────────────────────────────────────────────

export interface PathfinderExtensionOpts {
  /** repo 根 (地图扫描/落盘基准)。省略 = process.cwd()。测试注入临时 cwd。 */
  cwd?: string;
  /** 注入测试用 state (默认新建 normal 态)。 */
  state?: PathfinderModeState;
  /** 切换键。默认 'shift+tab' (D-1 改绑; 需 tui boot 前 ensurePlanToggleKeyFree 让路)。 */
  toggleKey?: string;
  /**
   * ★ P3 注入点 (override): 一个区域散尽 (ruled task 票 + 前置全裁) 时调用, 参数 = 该区域的票 id。
   * 省略 → 默认**只报信** (干跑编译 + 提示 /deliver); 真执行由 owner 显式 /deliver 触发 (deliverRegion)。
   * 测试注入以断言触发时机 / 绕过真执行。
   */
  onRegionClear?: (regionIds: string[]) => void | Promise<void>;
  /** slice 执行的 inproc leaf 模型 (executeSlice 必填); 省略 → 区域散尽时降级为"可编译"提示, 不执行。 */
  leafModel?: string;
  /** slice 执行的 agent leaf 模型 (改文件的叶子)。省略 = leafModel。 */
  agentLeafModel?: string;
  /**
   * agent-kind leaf 执行器 (带工具**真改文件**)。省略 → executor-dag 把 agent 节点降级为无工具
   * inproc (不会改文件) / 产文件节点直接失败 —— 交付会是空转, 生产接线 (tui) 必须传。
   */
  agentRunner?: AgentLeafRunner;
  /** command-kind leaf 执行器 (确定性 CLI, DAG 内自验节点)。省略 → command 节点失败。 */
  commandRunner?: CommandLeafRunner;
  /** runtime-finalize 开关 (默认 OFF; 见 execute-extension.finalizePlan)。 */
  finalize?: boolean;
  /** dag-record 留痕器 (tui 已建的 recorder); 省略 = 不留痕。 */
  recorder?: ExecuteSliceOpts['recorder'];
  /**
   * 自动预取: 进模式 / /tickets 时自动 dispatchFrontier (research→AFK 后台) + 起 reflow 触发器。
   * 默认 **false** (真 spawn 会惊吓, D-5): 用户须显式 `/path --prefetch` / `/tickets --prefetch` 触发。
   */
  autoPrefetch?: boolean;
}

/** 注入式依赖 (默认 = 真实实现; 测试传替身, 永不真编译/真执行/真 spawn)。 */
export interface PathfinderExtensionDeps {
  compileSlice?: typeof realCompileSlice;
  executeSlice?: typeof realExecuteSlice;
  dispatchFrontier?: typeof realDispatchFrontier;
  /** research 结果折入 (后端无关编排; TUI 固定 md 后端注入, 与 MCP 同引擎)。省略 = 真实实现。 */
  reflowResearchResults?: typeof realReflowResearchResults;
  resolveConductorDefault?: typeof realResolveConductorDefault;
  /** 注入式定时器 (reflow 触发器; 默认 globalThis.setInterval, unref 若可用)。 */
  setInterval?: (fn: () => void, ms: number) => unknown;
  /** 注入式清定时器 (默认 globalThis.clearInterval)。 */
  clearInterval?: (handle: unknown) => void;
}

/** reflow 触发器轮询周期 ms (与旧 watchAfkResults 默认一致)。 */
const REFLOW_TICK_MS = 4000;

export function createPathfinderExtension(
  opts: PathfinderExtensionOpts = {},
  deps: PathfinderExtensionDeps = {},
): ExtensionFactory {
  const cwd = opts.cwd ?? process.cwd();
  const state = opts.state ?? createPathfinderModeState();
  const toggleKey = opts.toggleKey ?? 'shift+tab';
  const compileSliceFn = deps.compileSlice ?? realCompileSlice;
  const executeSliceFn = deps.executeSlice ?? realExecuteSlice;
  const dispatchFrontierFn = deps.dispatchFrontier ?? realDispatchFrontier;
  const reflowResearchResultsFn = deps.reflowResearchResults ?? realReflowResearchResults;
  const resolveConductorDefaultFn = deps.resolveConductorDefault ?? realResolveConductorDefault;
  const setIntervalFn = deps.setInterval ?? ((fn: () => void, ms: number) => globalThis.setInterval(fn, ms));
  const clearIntervalFn = deps.clearInterval ?? ((h: unknown) => globalThis.clearInterval(h as ReturnType<typeof setInterval>));

  return (pi) => {
    /** 当前活跃的 AFK watcher (单个; prefetch 换图时先 stop 旧的)。 */
    let watchHandle: { stop: () => void } | null = null;
    /** 自续预算耗尽只提醒一次 (本 session)。 */
    let budgetNotified = false;
    /** 可选的 runtime 回注 (execute brief); 测试 fake pi 无此方法 → 静默跳过。 */
    const sendUserMessage = (pi as { sendUserMessage?: (s: string) => void }).sendUserMessage;
    type Ctx = Parameters<Parameters<typeof pi.registerShortcut>[1]['handler']>[0];

    /** 载图算前沿 → setStatus + notify (前沿票逐行)。 */
    const surfaceFrontier = (ctx: Ctx, slug: string): void => {
      const map = loadMap(cwd, slug);
      if (!map) {
        ctx.ui.notify(m({ en: `pathfinder: map "${slug}" not found`, zh: `pathfinder: 找不到地图 "${slug}"` }), 'warning');
        return;
      }
      const fr = computeFrontier(map);
      ctx.ui.setStatus('pathfinder', `◈ ${map.destination.slice(0, 24)} · ${fr.length} frontier`);
      if (fr.length === 0) {
        ctx.ui.notify(
          m({
            en: `◈ ${map.destination}: frontier empty (all ruled/blocked). /tickets to inspect.`,
            zh: `◈ ${map.destination}: 前沿空 (全裁决/受阻)。/tickets 查看。`,
          }),
          'info',
        );
        return;
      }
      const lines = fr.map((t) => `  • [${t.type}] ${t.id}: ${t.title}`).join('\n');
      ctx.ui.notify(
        m({
          en: `◈ ${map.destination} — frontier (${fr.length}):\n${lines}`,
          zh: `◈ ${map.destination} — 前沿 (${fr.length}):\n${lines}`,
        }),
        'info',
      );
    };

    /** 当前可交付区域 = 全部 ruled task 票 (delivered 是终态, 不再入区域 → 天然不重复执行)。 */
    const readyRegion = (map: PathMap): string[] | null => {
      const ruledTasks = map.tickets.filter((t) => t.type === 'task' && t.status === 'ruled').map((t) => t.id);
      if (ruledTasks.length === 0) return null;
      return regionIsClear(map, ruledTasks).clear ? ruledTasks : null;
    };

    /**
     * ★ P3 区域交付实装 (D-11), **owner 显式触发** (/deliver): compileSlice (零 LLM) → executeSlice
     * (跳 conductor 重分解, 带 agentRunner 真改文件) → 全节点 done 才把区域票翻 delivered (mutateMap
     * 持久)。失败不标记 → /deliver 可重试。缺 leafModel / 缺 key → 清晰提示, 绝不崩 (D-5)。
     */
    const deliverRegion = async (ctx: Ctx): Promise<void> => {
      if (!state.activeSlug) {
        ctx.ui.notify(m({ en: 'No active map. Open one with /path <destination>', zh: '无激活地图。/path <目的地> 打开一张' }), 'warning');
        return;
      }
      const slug = state.activeSlug;
      const map = loadMap(cwd, slug);
      if (!map) {
        ctx.ui.notify(m({ en: `map "${slug}" not found`, zh: `找不到地图 "${slug}"` }), 'warning');
        return;
      }
      const regionIds = readyRegion(map);
      if (!regionIds) {
        ctx.ui.notify(
          m({
            en: '◈ nothing to deliver: no clear region of ruled task tickets (rule the frontier first).',
            zh: '◈ 无可交付区域: 没有已散尽的 ruled task 票 (先把前沿裁完)。',
          }),
          'info',
        );
        return;
      }
      if (!opts.leafModel) {
        ctx.ui.notify(
          m({
            en: `◈ region ready (${regionIds.length} task tickets) but no leafModel configured — set OMD_ITER_LEAF_MODEL to enable /deliver.`,
            zh: `◈ 区域已散尽 (${regionIds.length} 张 task 票), 但未配 leafModel — 设 OMD_ITER_LEAF_MODEL 后 /deliver 才能执行。`,
          }),
          'warning',
        );
        return;
      }
      let plan;
      try {
        plan = compileSliceFn(map, regionIds);
      } catch (e) {
        ctx.ui.notify(m({ en: 'slice compile failed: ', zh: 'slice 编译失败: ' }) + String(e), 'error');
        return;
      }
      ctx.ui.setStatus('pathfinder', m({ en: 'compiling+executing slice…', zh: '编译+执行 slice…' }));
      try {
        const result = await executeSliceFn(plan, {
          leafModel: opts.leafModel,
          agentLeafModel: opts.agentLeafModel,
          agentRunner: opts.agentRunner,
          commandRunner: opts.commandRunner,
          conductorModel: resolveConductorDefaultFn(),
          cwd,
          recorder: opts.recorder,
          finalize: opts.finalize,
        });
        const nodeCount = Object.keys(plan.nodes ?? {}).length;
        const nodeStates = Object.values(result?.results ?? {});
        const failedCount = nodeStates.filter((r) => (r as { status?: string }).status !== 'done').length;
        const pass = result?.verification?.pass;
        const succeeded = failedCount === 0 && pass !== false;
        const verifyTail = pass === undefined ? '' : m({ en: ` · verify ${pass ? 'pass' : 'FAIL'}`, zh: ` · 校验 ${pass ? '通过' : '未过'}` });
        if (!succeeded) {
          // 不标记 delivered: 票保持 ruled, /deliver 可重试 (或 owner 改裁决后重来)。
          ctx.ui.notify(
            m({
              en: `◈ slice "${plan.name}" ran with ${failedCount}/${nodeCount} node(s) not done${verifyTail} — region NOT marked delivered; fix & /deliver again.`,
              zh: `◈ slice "${plan.name}" 执行有 ${failedCount}/${nodeCount} 节点未完成${verifyTail} — 区域未标记交付; 修复后可再 /deliver。`,
            }),
            'warning',
          );
          return;
        }
        // 全节点 done → 区域票翻 delivered (单写口 mutateMap, 不覆盖 tick 间他人落盘的改动)。
        mutateMap(cwd, slug, (fresh) => {
          for (const t of fresh.tickets) {
            if (regionIds.includes(t.id) && t.status === 'ruled') t.status = 'delivered';
          }
        });
        const brief = m({
          en: `◈ slice "${plan.name}" executed (${nodeCount} nodes)${verifyTail} — region [${regionIds.join(', ')}] delivered.`,
          zh: `◈ slice "${plan.name}" 已执行 (${nodeCount} 节点)${verifyTail} — 区域 [${regionIds.join(', ')}] 已交付。`,
        });
        ctx.ui.notify(brief, 'info');
        if (typeof sendUserMessage === 'function') sendUserMessage.call(pi, `<pathfinder-slice-delivered>\n${brief}\n</pathfinder-slice-delivered>`);
      } catch (e) {
        ctx.ui.notify(m({ en: 'slice execute failed: ', zh: 'slice 执行失败: ' }) + String(e), 'error');
      } finally {
        ctx.ui.setStatus('pathfinder', undefined);
      }
    };

    /**
     * 区域散尽检测 (每次 /rule 后调): 只**报信**不执行 —— deliberate/build 边界是代码闸:
     * 执行必须走 owner 显式 /deliver (readonly-gate 退役时承诺的 owner 签字, 落在这里)。
     * opts.onRegionClear override (测试/程控) 保持原语义: 命中即调, 不走默认报信。
     */
    const maybeSignalClearRegion = async (ctx: Ctx, map: PathMap): Promise<void> => {
      const regionIds = readyRegion(map);
      if (!regionIds) return;
      if (opts.onRegionClear) {
        await opts.onRegionClear(regionIds);
        return;
      }
      // 先干跑编译 (零 LLM) 把结构错误在裁决时就暴露, 而不是拖到 /deliver。
      try {
        compileSliceFn(map, regionIds);
      } catch (e) {
        ctx.ui.notify(m({ en: 'region clear but slice compile failed: ', zh: '区域散尽但 slice 编译失败: ' }) + String(e), 'error');
        return;
      }
      ctx.ui.notify(
        m({
          en: `◈ region clear (${regionIds.length} task tickets, compiles clean) — run /deliver to execute the slice.`,
          zh: `◈ 区域散尽 (${regionIds.length} 张 task 票, 编译通过) — owner 确认后 /deliver 执行 slice。`,
        }),
        'info',
      );
    };

    /**
     * D-10 自续: 回流孵出 research 子票时**在预算内**自动续派 (AFK detached, 不占 owner 带宽)。
     * 预算 = OMD_PATH_RESEARCH_BUDGET (默认 12), 按 .dispatched 标记计数 (跨 session 持久);
     * 耗尽 → 停自续 + 提醒一次 (owner 调预算或手动 --prefetch 追加 = 显式加钱, 不受此限)。
     * 派发本身幂等 (结果已在/在途进程活着都不重 spawn), 所以整前沿重派是安全的。
     */
    const autoRedispatch = (ctx: Ctx, slug: string): void => {
      const budget = Number(process.env.OMD_PATH_RESEARCH_BUDGET ?? 12);
      const used = countDispatchedResearch(cwd, slug);
      if (used >= budget) {
        if (!budgetNotified) {
          budgetNotified = true;
          ctx.ui.notify(
            m({
              en: `◈ research budget exhausted (${used}/${budget}) — auto-expansion paused. Raise OMD_PATH_RESEARCH_BUDGET or run /path --prefetch to top up explicitly.`,
              zh: `◈ 研究预算已用尽 (${used}/${budget}) — 自续暂停。调大 OMD_PATH_RESEARCH_BUDGET 或手动 /path --prefetch 显式追加。`,
            }),
            'warning',
          );
        }
        return;
      }
      const map = loadMap(cwd, slug);
      if (!map) return;
      const fd = dispatchFrontierFn(map, { cwd, slug }, {});
      if (fd.dispatched.length > 0) {
        ctx.ui.notify(
          m({
            en: `◈ self-expansion: ${fd.dispatched.length} child research ticket(s) auto-dispatched (budget ${used + fd.dispatched.length}/${budget}).`,
            zh: `◈ 自续: ${fd.dispatched.length} 张 research 子票已自动入 AFK 后台 (预算 ${used + fd.dispatched.length}/${budget})。`,
          }),
          'info',
        );
      }
    };

    /**
     * reflow 定时触发器 (薄壳; 双折入路径收敛 —— TUI 与 MCP 同走 reflowResearchResults):
     * 每 tick 经 reflowResearchResults(md 后端固定) 折入 landed 结果 → 母票 ruled + 后端自派子票血缘,
     * 映射回旧 onReflow 语义 (通知 + 重 surface 前沿 + research 子票预算内自续)。
     * 空结果/未就绪 (outcome.warning) 不折入、不占位, 留待下轮; 折入的状态读写全经 backend (mutateMap
     * 单写口), 天然不抱旧快照覆写 tick 间 /rule 落盘的裁决。换图/退出前 stop() 清定时器。
     */
    const startReflowTimer = (ctx: Ctx, slug: string): { stop: () => void } => {
      const backend = resolveBackend(cwd, { env: { OMD_PATH_BACKEND: 'md' } }); // TUI 场景固定 md
      const tick = (): void => {
        const outcomes = reflowResearchResultsFn(backend, cwd, slug);
        let folded = false;
        for (const o of outcomes) {
          if (o.warning !== undefined) continue; // 结果缺失/未就绪: 不折入不占位, 下轮重试
          folded = true;
          const childTail = o.newChildren.length > 0 ? m({ en: ` (+${o.newChildren.length} child tickets)`, zh: ` (+${o.newChildren.length} 子票)` }) : '';
          const dropTail = o.droppedChildren ? m({ en: ` (${o.droppedChildren} over-cap children dropped)`, zh: ` (超上限丢弃 ${o.droppedChildren} 子票草案)` }) : '';
          ctx.ui.notify(
            m({
              en: `◈ AFK result in: ${o.ticketId} ruled${childTail}${dropTail}`,
              zh: `◈ AFK 结果回流: ${o.ticketId} 已裁${childTail}${dropTail}`,
            }),
            'info',
          );
          // D-10 自续: 新孵 research 子票 → 预算内自动续派 (自己跑, 不等 owner)。
          if (o.newChildren.some((c) => c.type === 'research')) autoRedispatch(ctx, slug);
        }
        if (folded) surfaceFrontier(ctx, slug); // 有折入才重算前沿
      };
      const timer = setIntervalFn(tick, REFLOW_TICK_MS);
      // unref 若定时器支持 → 不阻塞进程退出 (旧 watchAfkResults 同款)。
      if (timer && typeof (timer as { unref?: () => void }).unref === 'function') {
        (timer as { unref: () => void }).unref();
      }
      return { stop: () => clearIntervalFn(timer) };
    };

    /**
     * 预取 (D-6, gated): dispatchFrontier 把 research 前沿票甩进 AFK 后台车队 + 起 reflow 定时触发器。
     * 换图时先停旧触发器。grill/prototype 只报不自动跑 (惊吓副作用)。
     */
    const prefetch = (ctx: Ctx, slug: string): void => {
      const map = loadMap(cwd, slug);
      if (!map) return;
      const fd = dispatchFrontierFn(map, { cwd, slug }, {});
      if (fd.dispatched.length > 0) {
        ctx.ui.notify(
          m({
            en: `◈ prefetch: ${fd.dispatched.length} research ticket(s) dispatched to AFK background (burning while you work).`,
            zh: `◈ 预取: ${fd.dispatched.length} 张 research 票已甩进 AFK 后台 (你审议时它在跑)。`,
          }),
          'info',
        );
      } else {
        ctx.ui.notify(m({ en: '◈ prefetch: no research tickets on the frontier.', zh: '◈ 预取: 前沿无 research 票。' }), 'info');
      }
      // 起/换 reflow 触发器: 结果落地即经 reflowResearchResults 折入 + 重 surface 前沿。
      watchHandle?.stop();
      watchHandle = startReflowTimer(ctx, slug);
    };

    const enterPathfinder = (ctx: Ctx): void => {
      state.status = 'pathfinder';
      ctx.ui.setStatus('pathfinder', '◈ PATHFINDER');
      const maps = summarizeOpenMaps(cwd);
      if (maps.length === 0) {
        ctx.ui.notify(
          m({
            en: '◈ PATHFINDER — no open map. Name a destination to start: /path <destination>',
            zh: '◈ 进入 PATHFINDER — 无开放地图。命名一个目的地开局: /path <目的地>',
          }),
          'info',
        );
        return;
      }
      // resume: 上次激活的 (仍存在) → 否则唯一一张 → 否则列出让用户 /path <slug> 选。
      const active =
        state.activeSlug && maps.some((mm) => mm.slug === state.activeSlug)
          ? state.activeSlug
          : maps.length === 1
            ? maps[0]!.slug
            : null;
      if (!active) {
        const list = maps.map((mm) => `  • ${mm.slug}: ${mm.destination} (${mm.openCount} open)`).join('\n');
        ctx.ui.notify(
          m({
            en: `◈ PATHFINDER — ${maps.length} open maps. Resume one: /path <slug>\n${list}`,
            zh: `◈ 进入 PATHFINDER — ${maps.length} 张开放地图。/path <slug> 续上:\n${list}`,
          }),
          'info',
        );
        return;
      }
      state.activeSlug = active;
      surfaceFrontier(ctx, active);
      // 自动预取 (gated, 默认 OFF): 进模式即把 research 前沿甩进 AFK 后台 (D-6)。
      if (opts.autoPrefetch) prefetch(ctx, active);
    };

    const exitPathfinder = (ctx: Ctx): void => {
      state.status = 'normal';
      ctx.ui.setStatus('pathfinder', undefined);
      // 退出即停 reflow 触发器 (子进程 unref 后自跑; 触发器只是回流通道)。
      watchHandle?.stop();
      watchHandle = null;
      ctx.ui.notify(m({ en: '▶ Exited PATHFINDER', zh: '▶ 退出 PATHFINDER' }), 'info');
    };

    const toggle = (ctx: Ctx): void => {
      if (state.status === 'normal') enterPathfinder(ctx);
      else exitPathfinder(ctx);
    };

    // shift+tab 切 pathfinder 模式 (D-1; 需 tui boot 前 ensurePlanToggleKeyFree 让出该键)。
    pi.registerShortcut(toggleKey as Parameters<typeof pi.registerShortcut>[0], {
      description: 'Toggle pathfinder mode (渐进散雾式规划)',
      handler: toggle,
    });

    // /pathfinder: 显式 toggle (可发现性 + fallback)。
    pi.registerCommand('pathfinder', {
      description: m({ en: 'Toggle pathfinder mode (shift+tab)', zh: 'Toggle pathfinder 模式 (shift+tab 同效)' }),
      handler: async (_args: string, ctx: Ctx) => toggle(ctx),
    });

    // /path [目的地|slug]: 无参列开放地图; 有参开/建地图并 surface 前沿。
    pi.registerCommand('path', {
      description: m({
        en: '/path — list open maps; /path <destination|slug> — open/create a map',
        zh: '/path 列开放地图; /path <目的地|slug> 开/建地图',
      }),
      handler: async (args: string, ctx: Ctx) => {
        // --prefetch: gated 手动触发 AFK 后台车队 (D-6) — 剥掉标志后取真正的目的地/slug。
        const wantPrefetch = /(^|\s)--prefetch(\s|$)/.test(args);
        const a = args.replace(/(^|\s)--prefetch(\s|$)/g, ' ').trim();
        if (!a) {
          // /path --prefetch (无目的地): 对当前活跃图预取。
          if (wantPrefetch && state.activeSlug) {
            prefetch(ctx, state.activeSlug);
            return;
          }
          const maps = summarizeOpenMaps(cwd);
          if (maps.length === 0) {
            ctx.ui.notify(
              m({ en: 'No open maps. Create one: /path <destination>', zh: '无开放地图。/path <目的地> 新建一张' }),
              'info',
            );
            return;
          }
          const list = maps
            .map((mm) => `  • ${mm.slug}: ${mm.destination} (${mm.openCount} open, ${mm.frontierCount} frontier)`)
            .join('\n');
          ctx.ui.notify(m({ en: `Open maps (${maps.length}):\n${list}`, zh: `开放地图 (${maps.length}):\n${list}` }), 'info');
          return;
        }
        // 已存在 (按 slug 原文或 slug 化后) → 打开; 否则按目的地新建。
        const maps = summarizeOpenMaps(cwd);
        const existing = maps.find((mm) => mm.slug === a || mm.slug === slugifyDestination(a));
        if (existing) {
          state.status = 'pathfinder';
          state.activeSlug = existing.slug;
          ctx.ui.notify(m({ en: `◈ Opened map "${existing.slug}"`, zh: `◈ 已打开地图 "${existing.slug}"` }), 'info');
          surfaceFrontier(ctx, existing.slug);
          if (wantPrefetch || opts.autoPrefetch) prefetch(ctx, existing.slug);
          return;
        }
        const { map, created } = createOrResumeMap(cwd, a);
        state.status = 'pathfinder';
        state.activeSlug = map.slug;
        ctx.ui.notify(
          created
            ? m({ en: `◈ Created map "${map.slug}" → ${map.destination}`, zh: `◈ 已新建地图 "${map.slug}" → ${map.destination}` })
            : m({ en: `◈ Resumed map "${map.slug}"`, zh: `◈ 已续上地图 "${map.slug}"` }),
          'info',
        );
        surfaceFrontier(ctx, map.slug);
        if (wantPrefetch || opts.autoPrefetch) prefetch(ctx, map.slug);
      },
    });

    // /tickets [--prefetch]: 列当前地图前沿票; --prefetch → 顺手把 research 前沿甩进 AFK 后台。
    pi.registerCommand('tickets', {
      description: m({ en: 'List the active pathfinder map frontier ([--prefetch] to dispatch AFK research)', zh: '列当前 pathfinder 地图的前沿票 ([--prefetch] 同时甩 AFK research)' }),
      handler: async (args: string, ctx: Ctx) => {
        if (!state.activeSlug) {
          ctx.ui.notify(m({ en: 'No active map. Open one with /path <destination>', zh: '无激活地图。/path <目的地> 打开一张' }), 'warning');
          return;
        }
        surfaceFrontier(ctx, state.activeSlug);
        if (/(^|\s)--prefetch(\s|$)/.test(args) || opts.autoPrefetch) prefetch(ctx, state.activeSlug);
      },
    });

    // /rule <ticketId> <裁决>: 裁一张票 → status=ruled + ruling + decisionsLog → 落 md+db → 前沿重算。
    pi.registerCommand('rule', {
      description: m({ en: '/rule <ticketId> <ruling> — rule a frontier ticket', zh: '/rule <票id> <裁决> — 裁一张前沿票' }),
      handler: async (args: string, ctx: Ctx) => {
        if (!state.activeSlug) {
          ctx.ui.notify(m({ en: 'No active map. Open one with /path <destination>', zh: '无激活地图。/path <目的地> 打开一张' }), 'warning');
          return;
        }
        const trimmed = args.trim();
        const sp = trimmed.indexOf(' ');
        const ticketId = sp === -1 ? trimmed : trimmed.slice(0, sp);
        const ruling = sp === -1 ? '' : trimmed.slice(sp + 1).trim();
        if (!ticketId || !ruling) {
          ctx.ui.notify(m({ en: 'Usage: /rule <ticketId> <ruling>', zh: '用法: /rule <票id> <裁决>' }), 'warning');
          return;
        }
        // 单写口 mutateMap: fresh load → 改 → save, 不与 watcher/其他命令互覆。
        const mutated = mutateMap(cwd, state.activeSlug, (map) => {
          const tk = map.tickets.find((t) => t.id === ticketId);
          if (!tk) return false;
          tk.status = 'ruled';
          tk.ruling = ruling;
          if (!map.decisionsLog.some((d) => d.ticketId === ticketId)) {
            map.decisionsLog.push({ ticketId, gist: ruling.slice(0, 80) });
          }
          return true;
        });
        if (!mutated) {
          ctx.ui.notify(m({ en: `map "${state.activeSlug}" not found`, zh: `找不到地图 "${state.activeSlug}"` }), 'warning');
          return;
        }
        if (!mutated.result) {
          ctx.ui.notify(m({ en: `No ticket "${ticketId}" in this map`, zh: `地图里没有票 "${ticketId}"` }), 'warning');
          return;
        }
        ctx.ui.notify(m({ en: `✓ Ruled ${ticketId}: ${ruling.slice(0, 60)}`, zh: `✓ 已裁 ${ticketId}: ${ruling.slice(0, 60)}` }), 'info');
        surfaceFrontier(ctx, state.activeSlug);
        await maybeSignalClearRegion(ctx, mutated.map);
      },
    });

    // /deliver: owner 显式触发区域执行 (deliberate/build 的代码闸 — 区域散尽只报信, 执行必须过这里)。
    pi.registerCommand('deliver', {
      description: m({
        en: '/deliver — execute the clear region (compile slice → run DAG → mark tickets delivered)',
        zh: '/deliver — 执行已散尽区域 (编译 slice → 跑 DAG → 票翻 delivered)',
      }),
      handler: async (_args: string, ctx: Ctx) => deliverRegion(ctx),
    });
  };
}
