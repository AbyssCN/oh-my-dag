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
 *
 * ★ P3 注入点 `onRegionClear(regionIds)`: 区域散尽时触发 dispatch+execute (P3 填)。P2 仅 log。
 *
 * idiom 参考 verify-gate-extension (工厂闭包持状态 + i18n m())。map-store/frontier/slice-compiler 只读 import。
 */
import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { m } from './i18n';
import { executeSlice as realExecuteSlice, resolveConductorDefault as realResolveConductorDefault, type ExecuteSliceOpts } from './execute-extension';
import { dispatchFrontier as realDispatchFrontier } from './pathfinder/dispatch';
import { watchAfkResults as realWatchAfkResults, type AfkReflow, type WatchHandle } from './pathfinder/afk-hook';
import { computeFrontier } from './pathfinder/frontier';
import {
  defaultDbPath,
  mapMarkdownPath,
  parseMapMarkdown,
  renderMapMarkdown,
  saveMapDb,
} from './pathfinder/map-store';
import { compileSlice as realCompileSlice, regionIsClear } from './pathfinder/slice-compiler';
import type { PathMap } from './pathfinder/types';
import { createPathfinderModeState, type PathfinderModeState } from './plan/mode';

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

/** 读一张地图 (docs/plan/pathfinder/<slug>.md → parseMapMarkdown); 文件不存在 → null。 */
export function loadMap(cwd: string, slug: string): PathMap | null {
  const p = mapMarkdownPath(slug, cwd);
  if (!existsSync(p)) return null;
  return parseMapMarkdown(readFileSync(p, 'utf8'));
}

/** 落一张地图: markdown 真相 (docs/plan/pathfinder/) + db 索引 (.omd/pathfinder.db)。 */
export function saveMap(map: PathMap, cwd: string): void {
  const mdPath = mapMarkdownPath(map.slug, cwd);
  mkdirSync(dirname(mdPath), { recursive: true });
  writeFileSync(mdPath, renderMapMarkdown(map), 'utf8');
  saveMapDb(map, defaultDbPath(cwd));
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
   * 省略 → 用**默认实**装 (compileSlice → executeSlice → 报告 + 标记 delivered, 见 runRegionClear)。
   * 测试注入以断言触发时机 / 绕过真执行。
   */
  onRegionClear?: (regionIds: string[]) => void | Promise<void>;
  /** slice 执行的 inproc leaf 模型 (executeSlice 必填); 省略 → 区域散尽时降级为"可编译"提示, 不执行。 */
  leafModel?: string;
  /** slice 执行的 agent leaf 模型 (改文件的叶子)。省略 = leafModel。 */
  agentLeafModel?: string;
  /** runtime-finalize 开关 (默认 OFF; 见 execute-extension.finalizePlan)。 */
  finalize?: boolean;
  /** dag-record 留痕器 (tui 已建的 recorder); 省略 = 不留痕。 */
  recorder?: ExecuteSliceOpts['recorder'];
  /**
   * 自动预取: 进模式 / /tickets 时自动 dispatchFrontier (research→AFK 后台) + watchAfkResults。
   * 默认 **false** (真 spawn 会惊吓, D-5): 用户须显式 `/path --prefetch` / `/tickets --prefetch` 触发。
   */
  autoPrefetch?: boolean;
}

/** 注入式依赖 (默认 = 真实实现; 测试传替身, 永不真编译/真执行/真 spawn)。 */
export interface PathfinderExtensionDeps {
  compileSlice?: typeof realCompileSlice;
  executeSlice?: typeof realExecuteSlice;
  dispatchFrontier?: typeof realDispatchFrontier;
  watchAfkResults?: typeof realWatchAfkResults;
  resolveConductorDefault?: typeof realResolveConductorDefault;
}

/** decisionsLog 里的 slice-已交付标记 (跨 session 去重, 防区域重复执行)。ticketId 用非法票 id 前缀避免撞真票。 */
const DELIVERED_MARKER = '#slice-delivered';

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
  const watchAfkResultsFn = deps.watchAfkResults ?? realWatchAfkResults;
  const resolveConductorDefaultFn = deps.resolveConductorDefault ?? realResolveConductorDefault;

  return (pi) => {
    /** 已交付的区域签名 (本 session 内存去重, 叠加 decisionsLog 标记跨 session)。 */
    const deliveredSignatures = new Set<string>();
    /** 当前活跃的 AFK watcher (单个; prefetch 换图时先 stop 旧的)。 */
    let watchHandle: WatchHandle | null = null;
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

    /**
     * ★ P3 默认区域散尽实装 (D-11): compileSlice (零 LLM) → executeSlice (跳 conductor 重分解) →
     * 报告 (ctx.ui.notify + runtime brief) + 标记 delivered 持久 (去重防重复执行)。缺 leafModel /
     * 缺 key → 降级为清晰提示, 绝不崩 (D-5)。
     */
    const runRegionClear = async (ctx: Ctx, map: PathMap, regionIds: string[]): Promise<void> => {
      const signature = [...regionIds].sort().join(',');
      // 去重: 内存签名 ∨ decisionsLog 标记 (跨 session) 命中 → 已交付, 不重跑。
      if (deliveredSignatures.has(signature)) return;
      if (map.decisionsLog.some((d) => d.ticketId === DELIVERED_MARKER && d.gist === signature)) {
        deliveredSignatures.add(signature);
        return;
      }
      if (!opts.leafModel) {
        ctx.ui.notify(
          m({
            en: `◈ region ready to compile (${regionIds.length} task tickets) but no leafModel configured — set OMD_ITER_LEAF_MODEL to auto-execute.`,
            zh: `◈ 区域已散尽可编译 (${regionIds.length} 张 task 票), 但未配 leafModel — 设 OMD_ITER_LEAF_MODEL 以自动执行。`,
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
          conductorModel: resolveConductorDefaultFn(),
          cwd,
          recorder: opts.recorder,
          finalize: opts.finalize,
        });
        const nodeCount = Object.keys(plan.nodes ?? {}).length;
        const pass = result?.verification?.pass;
        const verifyTail = pass === undefined ? '' : m({ en: ` · verify ${pass ? 'pass' : 'FAIL'}`, zh: ` · 校验 ${pass ? '通过' : '未过'}` });
        const brief = m({
          en: `◈ slice "${plan.name}" executed (${nodeCount} nodes)${verifyTail} — region [${regionIds.join(', ')}] delivered.`,
          zh: `◈ slice "${plan.name}" 已执行 (${nodeCount} 节点)${verifyTail} — 区域 [${regionIds.join(', ')}] 已交付。`,
        });
        ctx.ui.notify(brief, pass === false ? 'warning' : 'info');
        if (typeof sendUserMessage === 'function') sendUserMessage.call(pi, `<pathfinder-slice-delivered>\n${brief}\n</pathfinder-slice-delivered>`);
        // 标记 delivered: 重载真相 (避免覆盖并发写) → 追标记 → 持久。
        deliveredSignatures.add(signature);
        const fresh = loadMap(cwd, map.slug);
        if (fresh && !fresh.decisionsLog.some((d) => d.ticketId === DELIVERED_MARKER && d.gist === signature)) {
          fresh.decisionsLog.push({ ticketId: DELIVERED_MARKER, gist: signature });
          saveMap(fresh, cwd);
        }
      } catch (e) {
        ctx.ui.notify(m({ en: 'slice execute failed: ', zh: 'slice 执行失败: ' }) + String(e), 'error');
      } finally {
        ctx.ui.setStatus('pathfinder', undefined);
      }
    };

    /** 区域散尽检测 → onRegionClear override ∨ 默认 runRegionClear。全部 ruled task 票构成 clear 区域即触发。 */
    const maybeSignalClearRegion = async (ctx: Ctx, map: PathMap): Promise<void> => {
      const ruledTasks = map.tickets.filter((t) => t.type === 'task' && t.status === 'ruled').map((t) => t.id);
      if (ruledTasks.length === 0) return;
      if (!regionIsClear(map, ruledTasks).clear) return;
      if (opts.onRegionClear) {
        await opts.onRegionClear(ruledTasks);
        return;
      }
      await runRegionClear(ctx, map, ruledTasks);
    };

    /**
     * 预取 (D-6, gated): dispatchFrontier 把 research 前沿票甩进 AFK 后台车队 + 起 watchAfkResults 轮询回流。
     * 换图时先停旧 watcher。grill/prototype 只报不自动跑 (惊吓副作用)。
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
      // 起/换 watcher: 结果落地即回流通知 + 重 surface 前沿。
      watchHandle?.stop();
      watchHandle = watchAfkResultsFn(
        map,
        { cwd, mode: 'interval' },
        {
          saveMap: (mm) => saveMap(mm, cwd),
          onReflow: (r: AfkReflow) => {
            const childTail = r.newChildren.length > 0 ? m({ en: ` (+${r.newChildren.length} child tickets)`, zh: ` (+${r.newChildren.length} 子票)` }) : '';
            ctx.ui.notify(
              m({
                en: `◈ AFK result in: ${r.ticketId} ruled${childTail}${r.unblocked.length ? ` · unblocked ${r.unblocked.join(', ')}` : ''}`,
                zh: `◈ AFK 结果回流: ${r.ticketId} 已裁${childTail}${r.unblocked.length ? ` · 解锁 ${r.unblocked.join(', ')}` : ''}`,
              }),
              'info',
            );
            surfaceFrontier(ctx, slug);
          },
        },
      );
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
      // 退出即停 AFK watcher (子进程 unref 后自跑; watcher 只是回流通道)。
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
        const map = loadMap(cwd, state.activeSlug);
        if (!map) {
          ctx.ui.notify(m({ en: `map "${state.activeSlug}" not found`, zh: `找不到地图 "${state.activeSlug}"` }), 'warning');
          return;
        }
        const tk = map.tickets.find((t) => t.id === ticketId);
        if (!tk) {
          ctx.ui.notify(m({ en: `No ticket "${ticketId}" in this map`, zh: `地图里没有票 "${ticketId}"` }), 'warning');
          return;
        }
        tk.status = 'ruled';
        tk.ruling = ruling;
        if (!map.decisionsLog.some((d) => d.ticketId === ticketId)) {
          map.decisionsLog.push({ ticketId, gist: ruling.slice(0, 80) });
        }
        saveMap(map, cwd);
        ctx.ui.notify(m({ en: `✓ Ruled ${ticketId}: ${ruling.slice(0, 60)}`, zh: `✓ 已裁 ${ticketId}: ${ruling.slice(0, 60)}` }), 'info');
        surfaceFrontier(ctx, state.activeSlug);
        await maybeSignalClearRegion(ctx, map);
      },
    });
  };
}
