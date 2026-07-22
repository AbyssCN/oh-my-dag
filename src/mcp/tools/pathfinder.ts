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
import { slugifyDestination } from '../../harness/pathfinder-extension';
import {
  resolveBackend as realResolveBackend,
  type PathBackend,
} from '../../harness/pathfinder/backend';
import { makeInitDeps, runInit, type InitDeps } from '../../harness/pathfinder/init';
import {
  countDispatchedResearch,
  dispatchFrontier as realDispatchFrontier,
} from '../../harness/pathfinder/dispatch';
import { reflowResearchResults } from '../../harness/pathfinder/afk-hook';
import { computeFrontier } from '../../harness/pathfinder/frontier';
import { compileSlice, regionIsClear } from '../../harness/pathfinder/slice-compiler';
import type { PathMap, Ticket, TicketType } from '../../harness/pathfinder/types';
import type { OmdMemory } from '../../harness/memory/store';
import type { HudMirror } from '../../hud/mirror';
import { compactFog } from '../../hud/fog';

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
  /** 后端解析器 (省略 = resolveBackend(cwd, {env}): env OMD_PATH_BACKEND > 仓库配置 > md)。测试注入 gh 替身。 */
  resolveBackend?: (cwd: string) => PathBackend;
  /** omd-hud 迷雾镜像 (给则每次 renderStatus 把当前地图迷雾原子写 .omd/hud/fog.json)。省略 = 不写。 */
  hudMirror?: HudMirror;
  /**
   * 记忆接缝 (裁决增益): path_rule 成功后把「<destination>: <title> 裁决 = <ruling>」记为 omd.pattern
   * fact, 经 memory_remember 同款底层 (OmdMemory.writeFact, scanSecrets:false 用户主权), **不绕道 MCP
   * 工具面自调**。省略 = 不写 (纯导航测试无需); assemble 注入同款 OmdMemory。写入失败 warn 不 throw ——
   * 裁决已落 Issues/md, memory 是增益不是链路。
   */
  memory?: Pick<OmdMemory, 'writeFact'>;
  /** path_init 执行接缝覆盖 (测试注入 probes/gh/canary 替身; 省略 = 生产默认 gh/git/env 探测)。 */
  initOverrides?: Partial<InitDeps>;
}

/** 七工具: path_init + path_map / path_add / path_tickets / path_rule / path_deliver / path_prefetch。 */
export function createPathfinderTools(deps: PathfinderToolDeps): OmdMcpTool[] {
  return [makeInit(deps), makeMap(deps), makeAdd(deps), makeTickets(deps), makeRule(deps), makeDeliver(deps), makePrefetch(deps)];
}

// ── 共享 helpers ──────────────────────────────────────────────────────────────

const ok = (text: string) => ({ content: [{ type: 'text' as const, text }] });
const err = (text: string) => ({ content: [{ type: 'text' as const, text }], isError: true as const });

/** 后端 throw 的错误取干净正文 (不带 "Error:" 前缀), 直接当工具 isError 文案。 */
const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** 挑后端 (每次工具调用现挑; gh 会现探 repo, 无缓存层 — 与 SDD "实时拼" 一致)。 */
function backendOf(deps: PathfinderToolDeps): PathBackend {
  return (deps.resolveBackend ?? ((cwd: string) => realResolveBackend(cwd, { env: deps.env })))(deps.cwd);
}

/** slug 解析: 显式给 → 用; 省略 → 恰一张开放地图用它, 零/多张 → 报错列 slug。 */
function resolveSlug(backend: PathBackend, cwd: string, slug: string | undefined): { slug: string } | { error: string } {
  if (slug) {
    if (!backend.readMap(cwd, slug)) return { error: `找不到地图 "${slug}" — path_map 列出/新建` };
    return { slug };
  }
  const maps = backend.listMaps(cwd);
  if (maps.length === 0) return { error: '无开放地图 — path_map 带 destination 新建一张' };
  if (maps.length > 1) return { error: `多张开放地图, 需显式 slug: ${maps.map((m) => m.slug).join(', ')}` };
  return { slug: maps[0]!.slug };
}

/** 列图 + 现算 open/frontier 计数 (两后端一致: listMaps 只给 slug/destination, 计数用 readMap+computeFrontier)。 */
function listMapsWithCounts(backend: PathBackend, cwd: string): Array<{ slug: string; destination: string; openCount: number; frontierCount: number }> {
  return backend.listMaps(cwd).map(({ slug, destination }) => {
    const map = backend.readMap(cwd, slug);
    const openCount = map ? map.tickets.filter((t) => t.status !== 'ruled' && t.status !== 'escalated').length : 0;
    const frontierCount = map ? computeFrontier(map).length : 0;
    return { slug, destination, openCount, frontierCount };
  });
}

function ticketLine(t: Ticket): string {
  return `• [${t.type}] ${t.id}: ${t.title}${t.status !== 'open' ? ` (${t.status})` : ''}`;
}

/** 战争迷雾条: █=delivered/ruled ▒=open frontier ░=blocked, 条宽 10。 */
export function fogBar(map: PathMap): string {
  const total = map.tickets.length;
  if (total === 0) return '          0/0 散雾';
  let ruled = 0, open = 0, blocked = 0;
  for (const t of map.tickets) {
    if (t.status === 'delivered' || t.status === 'ruled') ruled++;
    else if (t.status === 'blocked') blocked++;
    else open++;
  }
  const W = 10;
  const rb = Math.round((ruled / total) * W);
  const ob = Math.round((open / total) * W);
  const bb = W - rb - ob;
  const bar = '█'.repeat(Math.max(0, rb)) + '▒'.repeat(Math.max(0, ob)) + '░'.repeat(Math.max(0, bb));
  const ruledIds = map.tickets.filter((t) => t.status === 'delivered' || t.status === 'ruled').map((t) => t.id);
  const openIds = map.tickets.filter((t) => t.status !== 'delivered' && t.status !== 'ruled' && t.status !== 'blocked').map((t) => t.id);
  const blockedIds = map.tickets.filter((t) => t.status === 'blocked').map((t) => t.id);
  const lines = [
    `<${map.destination}>  ${bar}  ${ruled}/${total} 散雾`,
    `█ ${ruledIds.join(' ') || '—'}`,
    `▒ ${openIds.join(' ') || '—'}`,
    `░ ${blockedIds.join(' ') || '—'}`,
  ];
  return lines.join('\n');
}

/** 地图快照文本: 目的地 + 状态计数 + 前沿逐行 + 区域散尽提示 (path_deliver 报信)。
 *  副作用: 给 hudMirror 则把当前迷雾原子写 fog.json (omd-hud 数据源; fail-open 内建)。 */
function renderStatus(map: PathMap, hudMirror?: HudMirror): string {
  hudMirror?.writeFog(compactFog(map));
  const fr = computeFrontier(map);
  const counts = new Map<string, number>();
  for (const t of map.tickets) counts.set(t.status, (counts.get(t.status) ?? 0) + 1);
  const countStr = [...counts.entries()].map(([s, n]) => `${s}=${n}`).join(' ') || 'empty';
  const lines = [
    `◈ ${map.destination} (slug=${map.slug}) — ${map.tickets.length} tickets [${countStr}]`,
    fogBar(map),
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
 * landed 结果经**后端无关**折入 (reflowResearchResults: md 落盘文件 / gh issue 评论) → 新孵 research
 * 子票在预算内自动续派。返回回流摘要行 (无事 → [])。折入的状态读写全经 backend, 此处只做编排 + 记账。
 */
function reflowOnce(deps: PathfinderToolDeps, backend: PathBackend, slug: string): string[] {
  const { cwd } = deps;
  const dispatch = deps.dispatchFrontier ?? realDispatchFrontier;
  const outcomes = reflowResearchResults(backend, cwd, slug);
  const lines: string[] = [];
  let hadResearchChildren = false;
  for (const o of outcomes) {
    if (o.warning !== undefined) {
      // 结果缺失/折入失败: 票据可见, 未 ack, 下轮重试 (不静默跳过)。
      lines.push(`⚠ AFK 回流: ${o.ticketId} 结果未折入 (${o.warning}) — 未确认, 下轮重试。`);
      continue;
    }
    const childTail = o.newChildren.length ? ` (+${o.newChildren.length} 子票)` : '';
    const dropTail = o.droppedChildren ? ` (超上限丢弃 ${o.droppedChildren})` : '';
    lines.push(`↩ AFK 回流: ${o.ticketId} 已裁${childTail}${dropTail}`);
    if (o.newChildren.some((c) => c.type === 'research')) hadResearchChildren = true;
  }
  if (hadResearchChildren) {
    const budget = Number(deps.env.OMD_PATH_RESEARCH_BUDGET ?? 12);
    const used = countDispatchedResearch(cwd, slug);
    if (used >= budget) {
      lines.push(`⏸ 研究预算已用尽 (${used}/${budget}) — 自续暂停; 调 OMD_PATH_RESEARCH_BUDGET 或 path_prefetch 显式追加。`);
    } else {
      const fresh = backend.readMap(cwd, slug);
      if (fresh) {
        // 派发路径判据接后端 kind: gh 子票走云端 label 触发, md 走本地 detached 子进程。
        const fd = dispatch(fresh, { cwd, slug, backend: backend.kind }, {});
        if (fd.dispatched.length > 0) lines.push(`⚡ 自续: ${fd.dispatched.length} 张 research 子票入 AFK 后台 (预算 ${used + fd.dispatched.length}/${budget})。`);
      }
    }
  }
  return lines;
}

/**
 * 裁决写 memory (增益, 非链路): path_rule 成功后把「<destination>: <title> 裁决 = <ruling>」记为
 * omd.pattern fact (situation = 问题<destination>: <title>, approach = 裁决 ruling)。走注入的
 * OmdMemory.writeFact —— memory_remember 同款底层 + 同款 scanSecrets:false (用户主权, 裁决文本不过密钥闸)。
 * 写失败/被拒 warn 不 throw: 裁决已落 Issues/md, memory 只是消费端 (memory_recall / /start) 的检索增益。
 * 无 memory 接缝 → null (不写)。返回一行警告供工具输出, 成功则静默 (不污染裁决回报)。
 */
async function rememberRuling(
  deps: PathfinderToolDeps,
  map: PathMap,
  ticketId: string,
  ruling: string,
): Promise<string | null> {
  const memory = deps.memory;
  if (!memory) return null;
  const title = map.tickets.find((t) => t.id === ticketId)?.title ?? ticketId;
  const anchor = `path_rule:${map.slug}:${ticketId}`;
  const fact = {
    namespace: 'omd.pattern',
    situation: `${map.destination}: ${title}`,
    approach: ruling,
    outcome: 'worked' as const, // 裁决 = owner 拍板采纳的走法 (决定态即 "采用")。
    source_event_id: anchor,
    confidence: { level: 'agent_tentative' as const, source_event_ids: [anchor], created_at: new Date() },
  };
  try {
    const result = await memory.writeFact(fact, { scanSecrets: false });
    if (result.status === 'rejected') {
      return `⚠ 裁决未写入 memory (${result.reason}) — 裁决已落地, memory 是增益。`;
    }
    return null;
  } catch (e) {
    return `⚠ 裁决写 memory 失败 (${errMsg(e)}) — 裁决已落地, memory 是增益。`;
  }
}

// ── path_init ────────────────────────────────────────────────────────────────
//
// 独立工具 (非 path_map 增动作): init = 环境探测 + 后端选定 + 云端接线 (labels/secrets/canary/config)
// 的重副作用一次性编排, 与 path_map 的"列图/建图/看前沿"轻导航正交。折进 path_map 会给它塞
// action 判别符 + backend/cloudAfk 参, 污染每轮都调的导航工具 schema (D-11 description 税);
// 拆独立工具两者 schema 各自干净, MCP 客户端各自可发现。init 是**唯一**合法挑后端的地方 (探测决定),
// 不违 D-A (map/add/rule/deliver 仍零 backend.kind 分支)。

function makeInit(deps: PathfinderToolDeps): OmdMcpTool {
  return {
    name: 'path_init',
    description: 'Init pathfinder backend: no args → probe report + recommendation; with backend/cloudAfk → execute setup.',
    inputSchema: {
      destination: z.string().optional().describe('Map destination text (required when executing; omit in report mode)'),
      backend: z.enum(['gh', 'md']).optional().describe('Backend choice; omit → return probe report + recommended answers'),
      cloudAfk: z.boolean().optional().describe('gh only: enable cloud AFK research (public repo → decision history is publicly readable)'),
    },
    handler: async ({ destination, backend, cloudAfk }) => {
      const initDeps = makeInitDeps(deps.cwd, deps.env, deps.initOverrides);
      const outcome = runInit(
        {
          ...(destination !== undefined ? { destination: destination as string } : {}),
          ...(backend !== undefined ? { backend: backend as 'gh' | 'md' } : {}),
          ...(cloudAfk !== undefined ? { cloudAfk: cloudAfk as boolean } : {}),
        },
        initDeps,
      );
      return outcome.isError ? err(outcome.text) : ok(outcome.text);
    },
  };
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
      const backend = backendOf(deps);
      if (!destination) {
        const maps = listMapsWithCounts(backend, cwd);
        if (maps.length === 0) return ok('无开放地图。path_map 带 destination 新建一张。');
        return ok(maps.map((m) => `• ${m.slug}: ${m.destination} (${m.openCount} open, ${m.frontierCount} frontier)`).join('\n'));
      }
      const d = destination as string;
      // 命中 (slug 原文 / slug 化后 / 目的地相等) → resume; 否则新建 (与 TUI /path 同语义)。
      const maps = backend.listMaps(cwd);
      const hit = maps.find((m) => m.slug === d || m.destination === d || m.slug === slugifyDestination(d));
      try {
        const map = hit ? backend.readMap(cwd, hit.slug)! : backend.createMap(cwd, d, slugifyDestination(d));
        return ok(renderStatus(map, deps.hudMirror));
      } catch (e) {
        return err(errMsg(e));
      }
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
      const bb = (blockedBy as string[] | undefined) ?? [];
      const { cwd } = deps;
      const backend = backendOf(deps);
      const r = resolveSlug(backend, cwd, slug as string | undefined);
      if ('error' in r) return err(r.error);
      let created: Ticket;
      try {
        created = backend.addTicket(cwd, r.slug, {
          type: ttype,
          title: title as string,
          blockedBy: bb,
          ...(id ? { id: id as string } : {}),
          ...(executorKind ? { executorKind: executorKind as Ticket['executorKind'] } : {}),
        });
      } catch (e) {
        return err(errMsg(e));
      }
      const map = backend.readMap(cwd, r.slug);
      return ok(`✓ 已加票 ${created.id}${map ? `\n${renderStatus(map, deps.hudMirror)}` : ''}`);
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
      const backend = backendOf(deps);
      const r = resolveSlug(backend, deps.cwd, slug as string | undefined);
      if ('error' in r) return err(r.error);
      const reflow = reflowOnce(deps, backend, r.slug);
      const map = backend.readMap(deps.cwd, r.slug)!;
      return ok([...reflow, renderStatus(map, deps.hudMirror)].join('\n'));
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
      const backend = backendOf(deps);
      const r = resolveSlug(backend, deps.cwd, slug as string | undefined);
      if ('error' in r) return err(r.error);
      const reflow = reflowOnce(deps, backend, r.slug); // 先折回流, 避免在过期视图上裁
      try {
        backend.rule(deps.cwd, r.slug, ticketId as string, ruling as string);
      } catch (e) {
        return err(errMsg(e));
      }
      const map = backend.readMap(deps.cwd, r.slug)!;
      const memNote = await rememberRuling(deps, map, ticketId as string, ruling as string);
      return ok(
        [
          ...reflow,
          `✓ 已裁 ${ticketId}: ${(ruling as string).slice(0, 60)}`,
          ...(memNote ? [memNote] : []),
          renderStatus(map, deps.hudMirror),
        ].join('\n'),
      );
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
      const backend = backendOf(deps);
      const r = resolveSlug(backend, cwd, slug as string | undefined);
      if ('error' in r) return err(r.error);
      const map = backend.readMap(cwd, r.slug)!;
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
        backend.markDelivered(cwd, r.slug, region);
        return ok(`◈ slice "${plan.name}" 已执行 (${Object.keys(plan.nodes ?? {}).length} 节点) — 区域 [${region.join(', ')}] 已交付。\n${renderStatus(backend.readMap(cwd, r.slug)!, deps.hudMirror)}`);
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
      const backend = backendOf(deps);
      const r = resolveSlug(backend, deps.cwd, slug as string | undefined);
      if ('error' in r) return err(r.error);
      const map = backend.readMap(deps.cwd, r.slug)!;
      // 派发路径判据接后端 kind: gh 后端 research → 云端 label 触发 (dispatch.ts dispatchResearchGh)。
      const fd = dispatch(map, { cwd: deps.cwd, slug: r.slug, backend: backend.kind }, {});
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
