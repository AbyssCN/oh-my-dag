/**
 * src/mcp/tools/pathfinder — pathfinder 决策地图的 MCP 工具面 (TUI-less 入口)。
 *
 * 背景: pathfinder 的命令面 (/path /tickets /rule /deliver) 原生长在 TUI 扩展上; MCP 客户端
 * (Claude 经 `omd mcp`) 不跑 TUI → 此处把同一套纯逻辑 (map-store/frontier/slice-compiler/
 * dispatch/afk-hook) 拆成六个无状态工具。**状态全在磁盘** (docs/plan/pathfinder/*.md 真相 +
 * .omd/pathfinder/*): MCP server 无常驻 watcher, 改为**每次 path_tickets/path_rule 先做一次
 * once-tick 回流** (landed AFK 结果折进地图) + 预算内 D-10 自续 —— pull 模型替代 TUI 的 4s 轮询。
 *
 * 权力闸与 TUI 同款: 区域散尽只报信, 执行必须显式 path_deliver (owner 扣扳机);
 * research 派发幂等 (结果已在/在途 pid 活着不重 spawn)。
 */
import { z } from 'zod';
import type { OmdMcpTool } from '../server';
import {
  executeSlice as realExecuteSlice,
  type ExecuteSliceOpts,
} from '../../harness/execute-extension';
import type { AgentLeafRunner, CommandLeafRunner } from '../../harness/leaf-runners';
import {
  createOrResumeMap,
  summarizeOpenMaps,
} from '../../harness/pathfinder-extension';
import {
  countDispatchedResearch,
  dispatchFrontier as realDispatchFrontier,
} from '../../harness/pathfinder/dispatch';
import { watchAfkResults as realWatchAfkResults } from '../../harness/pathfinder/afk-hook';
import { computeFrontier } from '../../harness/pathfinder/frontier';
import { loadMap, mutateMap, saveMap } from '../../harness/pathfinder/map-store';
import { compileSlice, regionIsClear } from '../../harness/pathfinder/slice-compiler';
import type { PathMap, Ticket, TicketType } from '../../harness/pathfinder/types';

export interface PathfinderToolDeps {
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** slice 执行模型 (assemble 的 env 角色矩阵解析结果)。leafModel 空 → path_deliver 给引导 isError。 */
  models: { conductorModel: string; leafModel: string; agentLeafModel?: string };
  agentRunner: AgentLeafRunner;
  commandRunner: CommandLeafRunner;
  /** 注入接缝 (测试传替身, 永不真执行/真 spawn)。 */
  executeSlice?: typeof realExecuteSlice;
  dispatchFrontier?: typeof realDispatchFrontier;
  watchAfkResults?: typeof realWatchAfkResults;
}

/** 六工具: path_map / path_add / path_tickets / path_rule / path_deliver / path_prefetch。 */
export function createPathfinderTools(deps: PathfinderToolDeps): OmdMcpTool[] {
  return [makeMap(deps), makeAdd(deps), makeTickets(deps), makeRule(deps), makeDeliver(deps), makePrefetch(deps)];
}

// ── 共享 helpers ──────────────────────────────────────────────────────────────

const ok = (text: string) => ({ content: [{ type: 'text' as const, text }] });
const err = (text: string) => ({ content: [{ type: 'text' as const, text }], isError: true as const });

/** slug 解析: 显式给 → 用; 省略 → 恰一张开放地图用它, 零/多张 → 报错列 slug。 */
function resolveSlug(cwd: string, slug: string | undefined): { slug: string } | { error: string } {
  if (slug) {
    if (!loadMap(cwd, slug)) return { error: `找不到地图 "${slug}" — path_map 列出/新建` };
    return { slug };
  }
  const maps = summarizeOpenMaps(cwd);
  if (maps.length === 0) return { error: '无开放地图 — path_map 带 destination 新建一张' };
  if (maps.length > 1) return { error: `多张开放地图, 需显式 slug: ${maps.map((m) => m.slug).join(', ')}` };
  return { slug: maps[0]!.slug };
}

function ticketLine(t: Ticket): string {
  return `• [${t.type}] ${t.id}: ${t.title}${t.status !== 'open' ? ` (${t.status})` : ''}`;
}

/** 地图快照文本: 目的地 + 状态计数 + 前沿逐行 + 区域散尽提示 (path_deliver 报信)。 */
function renderStatus(map: PathMap): string {
  const fr = computeFrontier(map);
  const counts = new Map<string, number>();
  for (const t of map.tickets) counts.set(t.status, (counts.get(t.status) ?? 0) + 1);
  const countStr = [...counts.entries()].map(([s, n]) => `${s}=${n}`).join(' ') || 'empty';
  const lines = [
    `◈ ${map.destination} (slug=${map.slug}) — ${map.tickets.length} tickets [${countStr}]`,
    fr.length === 0 ? '前沿空 (全裁决/受阻/已交付)。' : `前沿 (${fr.length}):`,
    ...fr.map((t) => `  ${ticketLine(t)}`),
  ];
  const region = readyRegion(map);
  if (region) {
    try {
      compileSlice(map, region);
      lines.push(`★ 区域散尽 (${region.length} 张 ruled task 票, 编译通过) — path_deliver 执行交付。`);
    } catch (e) {
      lines.push(`★ 区域散尽但 slice 编译失败: ${String(e)}`);
    }
  }
  return lines.join('\n');
}

/** 可交付区域 = 全部 ruled task 票 (delivered 终态不复入 → 不重复执行); 未散尽 → null。 */
function readyRegion(map: PathMap): string[] | null {
  const ruled = map.tickets.filter((t) => t.type === 'task' && t.status === 'ruled').map((t) => t.id);
  if (ruled.length === 0) return null;
  return regionIsClear(map, ruled).clear ? ruled : null;
}

/**
 * once-tick 回流 + 预算内 D-10 自续 (MCP 无常驻 watcher 的 pull 等价):
 * landed 结果折进地图 → 新孵 research 子票在预算内自动续派。返回回流摘要行 (无事 → [])。
 */
function reflowOnce(deps: PathfinderToolDeps, slug: string): string[] {
  const { cwd } = deps;
  const watch = deps.watchAfkResults ?? realWatchAfkResults;
  const dispatch = deps.dispatchFrontier ?? realDispatchFrontier;
  const map = loadMap(cwd, slug);
  if (!map) return [];
  const lines: string[] = [];
  let hadResearchChildren = false;
  watch(
    map,
    { cwd, mode: 'once' },
    {
      reloadMap: () => loadMap(cwd, slug),
      saveMap: (m) => saveMap(m, cwd),
      onReflow: (r) => {
        const childTail = r.newChildren.length ? ` (+${r.newChildren.length} 子票)` : '';
        const dropTail = r.droppedChildren ? ` (超上限丢弃 ${r.droppedChildren})` : '';
        lines.push(`↩ AFK 回流: ${r.ticketId} 已裁${childTail}${dropTail}`);
        if (r.newChildren.some((c) => c.type === 'research')) hadResearchChildren = true;
      },
    },
  );
  if (hadResearchChildren) {
    const budget = Number(deps.env.OMD_PATH_RESEARCH_BUDGET ?? 12);
    const used = countDispatchedResearch(cwd, slug);
    if (used >= budget) {
      lines.push(`⏸ 研究预算已用尽 (${used}/${budget}) — 自续暂停; 调 OMD_PATH_RESEARCH_BUDGET 或 path_prefetch 显式追加。`);
    } else {
      const fresh = loadMap(cwd, slug);
      if (fresh) {
        const fd = dispatch(fresh, { cwd, slug }, {});
        if (fd.dispatched.length > 0) lines.push(`⚡ 自续: ${fd.dispatched.length} 张 research 子票入 AFK 后台 (预算 ${used + fd.dispatched.length}/${budget})。`);
      }
    }
  }
  return lines;
}

// ── path_map ─────────────────────────────────────────────────────────────────

function makeMap(deps: PathfinderToolDeps): OmdMcpTool {
  return {
    name: 'path_map',
    description: 'Pathfinder map: no arg lists open maps; with destination/slug creates or resumes one and shows its frontier.',
    inputSchema: {
      destination: z.string().optional().describe('Destination text or existing slug; omit to list open maps'),
    },
    handler: async ({ destination }) => {
      const { cwd } = deps;
      if (!destination) {
        const maps = summarizeOpenMaps(cwd);
        if (maps.length === 0) return ok('无开放地图。path_map 带 destination 新建一张。');
        return ok(maps.map((m) => `• ${m.slug}: ${m.destination} (${m.openCount} open, ${m.frontierCount} frontier)`).join('\n'));
      }
      const d = destination as string;
      // slug 直开优先 (与 TUI /path 同语义)。
      const bySlug = loadMap(cwd, d);
      const map = bySlug ?? createOrResumeMap(cwd, d).map;
      return ok(renderStatus(map));
    },
  };
}

// ── path_add ─────────────────────────────────────────────────────────────────

const TICKET_TYPES = ['research', 'grill', 'prototype', 'task'] as const;

function makeAdd(deps: PathfinderToolDeps): OmdMcpTool {
  return {
    name: 'path_add',
    description: 'Add a ticket to a pathfinder map. Types: research (AFK auto) / grill (discuss) / prototype (spike) / task (build).',
    inputSchema: {
      title: z.string().describe('The open question / work item, one line'),
      type: z.enum(TICKET_TYPES).default('task').describe('Ticket type (default task)'),
      slug: z.string().optional().describe('Map slug (omit = the single open map)'),
      id: z.string().optional().describe('Stable ticket id (omit = auto t1/r1/…)'),
      blockedBy: z.array(z.string()).default([]).describe('Prerequisite ticket ids'),
      executorKind: z.enum(['command', 'inproc', 'agent', 'map', 'primitive']).optional().describe('task only: slice executor kind (default inproc)'),
    },
    handler: async ({ title, type, slug, id, blockedBy, executorKind }) => {
      // 防御缺省 (schema default 只在 SDK 层生效; 直调 handler 也要稳)。
      const ttype = ((type as string | undefined) ?? 'task') as TicketType;
      const deps_ = (blockedBy as string[] | undefined) ?? [];
      const r = resolveSlug(deps.cwd, slug as string | undefined);
      if ('error' in r) return err(r.error);
      let mutated: { map: PathMap; result: string } | null = null;
      try {
        mutated = mutateMap(deps.cwd, r.slug, (map) => {
          const ids = new Set(map.tickets.map((t) => t.id));
          for (const dep of deps_) {
            if (!ids.has(dep)) throw new Error(`blockedBy 引用不存在的票 "${dep}"`);
          }
          let tid = (id as string | undefined) ?? '';
          if (!tid) {
            const prefix = ttype[0]!; // r/g/p/t
            let n = 1;
            while (ids.has(`${prefix}${n}`)) n++;
            tid = `${prefix}${n}`;
          } else if (ids.has(tid)) {
            throw new Error(`票 id "${tid}" 已存在`);
          }
          const t: Ticket = {
            id: tid,
            type: ttype,
            title: title as string,
            blockedBy: deps_,
            status: 'open',
            ...(executorKind ? { executorKind: executorKind as Ticket['executorKind'] } : {}),
          };
          map.tickets.push(t);
          return tid;
        });
      } catch (e) {
        return err(String(e));
      }
      if (!mutated) return err(`找不到地图 "${r.slug}"`);
      return ok(`✓ 已加票 ${mutated.result}\n${renderStatus(mutated.map)}`);
    },
  };
}

// ── path_tickets ─────────────────────────────────────────────────────────────

function makeTickets(deps: PathfinderToolDeps): OmdMcpTool {
  return {
    name: 'path_tickets',
    description: 'Show a pathfinder map frontier; first folds in landed AFK results (pull reflow + budgeted self-expansion).',
    inputSchema: {
      slug: z.string().optional().describe('Map slug (omit = the single open map)'),
    },
    handler: async ({ slug }) => {
      const r = resolveSlug(deps.cwd, slug as string | undefined);
      if ('error' in r) return err(r.error);
      const reflow = reflowOnce(deps, r.slug);
      const map = loadMap(deps.cwd, r.slug)!;
      return ok([...reflow, renderStatus(map)].join('\n'));
    },
  };
}

// ── path_rule ────────────────────────────────────────────────────────────────

function makeRule(deps: PathfinderToolDeps): OmdMcpTool {
  return {
    name: 'path_rule',
    description: 'Rule a frontier ticket (record the decision). Region-clear is only reported; execution stays behind path_deliver.',
    inputSchema: {
      ticketId: z.string().describe('Frontier ticket id to rule'),
      ruling: z.string().describe('The decision text (becomes the slice node goal for task tickets)'),
      slug: z.string().optional().describe('Map slug (omit = the single open map)'),
    },
    handler: async ({ ticketId, ruling, slug }) => {
      const r = resolveSlug(deps.cwd, slug as string | undefined);
      if ('error' in r) return err(r.error);
      const reflow = reflowOnce(deps, r.slug); // 先折回流, 避免在过期视图上裁
      const mutated = mutateMap(deps.cwd, r.slug, (map) => {
        const tk = map.tickets.find((t) => t.id === ticketId);
        if (!tk) return false;
        tk.status = 'ruled';
        tk.ruling = ruling as string;
        if (!map.decisionsLog.some((d) => d.ticketId === ticketId)) {
          map.decisionsLog.push({ ticketId: ticketId as string, gist: (ruling as string).slice(0, 80) });
        }
        return true;
      });
      if (!mutated) return err(`找不到地图 "${r.slug}"`);
      if (!mutated.result) return err(`地图里没有票 "${ticketId}"`);
      return ok([...reflow, `✓ 已裁 ${ticketId}: ${(ruling as string).slice(0, 60)}`, renderStatus(mutated.map)].join('\n'));
    },
  };
}

// ── path_deliver ─────────────────────────────────────────────────────────────

function makeDeliver(deps: PathfinderToolDeps): OmdMcpTool {
  return {
    name: 'path_deliver',
    description: 'Execute the clear region: compile ruled task tickets to a slice, run the DAG, mark delivered on full success.',
    inputSchema: {
      slug: z.string().optional().describe('Map slug (omit = the single open map)'),
    },
    handler: async ({ slug }) => {
      const { cwd, models } = deps;
      const exec = deps.executeSlice ?? realExecuteSlice;
      const r = resolveSlug(cwd, slug as string | undefined);
      if ('error' in r) return err(r.error);
      const map = loadMap(cwd, r.slug)!;
      const region = readyRegion(map);
      if (!region) return err('无可交付区域: 没有已散尽的 ruled task 票 (先 path_rule 把前沿裁完)。');
      if (!models.leafModel) return err('未配 leaf 模型 — 设 OMD_ITER_LEAF_MODEL (或 OMD_RUNTIME_PROVIDER/MODEL) 后再 path_deliver。');
      let plan;
      try {
        plan = compileSlice(map, region);
      } catch (e) {
        return err(`slice 编译失败: ${String(e)}`);
      }
      try {
        const opts: ExecuteSliceOpts = {
          leafModel: models.leafModel,
          ...(models.agentLeafModel ? { agentLeafModel: models.agentLeafModel } : {}),
          ...(models.conductorModel ? { conductorModel: models.conductorModel } : {}),
          agentRunner: deps.agentRunner,
          commandRunner: deps.commandRunner,
          cwd,
        };
        const result = await exec(plan, opts);
        const nodeStates = Object.values(result?.results ?? {});
        const failed = nodeStates.filter((n) => (n as { status?: string }).status !== 'done').length;
        const pass = result?.verification?.pass;
        if (failed > 0 || pass === false) {
          return err(`slice "${plan.name}" 执行有 ${failed}/${nodeStates.length} 节点未完成${pass === false ? ' · 校验未过' : ''} — 区域未标记交付, 修复后可再 path_deliver。`);
        }
        mutateMap(cwd, r.slug, (fresh) => {
          for (const t of fresh.tickets) {
            if (region.includes(t.id) && t.status === 'ruled') t.status = 'delivered';
          }
        });
        return ok(`◈ slice "${plan.name}" 已执行 (${Object.keys(plan.nodes ?? {}).length} 节点) — 区域 [${region.join(', ')}] 已交付。\n${renderStatus(loadMap(cwd, r.slug)!)}`);
      } catch (e) {
        return err(`slice 执行失败: ${String(e)}`);
      }
    },
  };
}

// ── path_prefetch ────────────────────────────────────────────────────────────

function makePrefetch(deps: PathfinderToolDeps): OmdMcpTool {
  return {
    name: 'path_prefetch',
    description: 'Dispatch frontier research tickets to detached AFK background (owner-explicit); results fold in via path_tickets.',
    inputSchema: {
      slug: z.string().optional().describe('Map slug (omit = the single open map)'),
    },
    handler: async ({ slug }) => {
      const dispatch = deps.dispatchFrontier ?? realDispatchFrontier;
      const r = resolveSlug(deps.cwd, slug as string | undefined);
      if ('error' in r) return err(r.error);
      const map = loadMap(deps.cwd, r.slug)!;
      const fd = dispatch(map, { cwd: deps.cwd, slug: r.slug }, {});
      const lines = [
        fd.dispatched.length > 0
          ? `⚡ ${fd.dispatched.length} 张 research 票已入 AFK 后台 (detached; path_tickets 拉回流)。`
          : '前沿无 research 票可派。',
      ];
      if (fd.reported.length > 0) {
        lines.push(`人工票 (${fd.reported.length}): ${fd.reported.map((t) => `[${t.type}] ${t.id}`).join(', ')}`);
      }
      return ok(lines.join('\n'));
    },
  };
}
