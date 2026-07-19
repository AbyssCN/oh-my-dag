/**
 * src/harness/pathfinder/afk-hook —— AFK 研究结果回流 (组件 4, D-6 / D-10)。
 *
 * research 票的 detached 子进程 (见 dispatch.ts) 跑完把综合结果写 `.omd/pathfinder/results/<slug>/<ticketId>.md`。
 * afk-hook 干两件事:
 *  1. applyAfkResult (**纯**): 母票 → ruled (distilled 结果作 ruling), 补 decisionsLog, 解析 `## children`
 *     段 → 加子票 (D-10 自展开), 重算 frontier delta (哪些票刚解锁)。零 IO / 零 LLM。
 *  2. watchAfkResults (轮询/watcher): 给地图未决 research 票的 resultPath, deps.readIfReady 探到结果落地
 *     → applyAfkResult → deps.saveMap 持久 → deps.onReflow 通知 (extension 用来重新 surface 前沿)。
 *     可注入间隔/once-mode 供测试; **单张坏结果不掀桌** (逐票 try/catch 隔离)。
 *
 * AFK 结果契约 (dag-research --out 的 md): 正文 = 综合 (distill 取首段); 可选 `## children` 段 →
 *   每行 `- [type] 子问题` (type 缺省 research), 子票 blockedBy = 母票 (D-10)。
 */
import { existsSync, readFileSync } from 'node:fs';
import { computeFrontier } from './frontier';
import { researchResultPath } from './dispatch';
import type { PathMap, Ticket, TicketType } from './types';

// ── distill / children 解析 (纯) ───────────────────────────────────────────────

const CHILDREN_HEADING = /^##\s+children\s*$/i;
const VALID_TYPES: ReadonlySet<string> = new Set(['research', 'grill', 'prototype', 'task']);

/**
 * 从结果正文蒸馏一句 ruling: 取 `## children` 段之前的**首个非空段落** (到空行止), 折成单行, 截 ~280 字。
 * 空结果 → 占位串 (票仍 ruled, 但标注结果为空)。
 */
export function distill(resultText: string): string {
  const beforeChildren = resultText.split(/\n##\s+children\s*$/im)[0] ?? resultText;
  const paras = beforeChildren
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0 && !p.startsWith('#')); // 跳过 markdown 标题行
  const first = paras[0] ?? '';
  const oneLine = first.replace(/\s+/g, ' ').trim();
  if (oneLine === '') return '(AFK 研究结果为空)';
  return oneLine.length > 280 ? oneLine.slice(0, 277) + '…' : oneLine;
}

/** 解析出的一条子票草案 (id 由 applyAfkResult 分配)。 */
interface ChildDraft {
  type: TicketType;
  title: string;
}

/**
 * 解析 `## children` 段 (D-10 自展开): 段内每行 `- [type] 标题` 或 `- 标题` (type 缺省 research)。
 * 遇下一个 `## ` 标题即止。非法 type 回退 research。无该段 → []。
 */
export function parseChildren(resultText: string): ChildDraft[] {
  const lines = resultText.split('\n');
  const out: ChildDraft[] = [];
  let inSection = false;
  for (const line of lines) {
    if (CHILDREN_HEADING.test(line)) {
      inSection = true;
      continue;
    }
    if (!inSection) continue;
    if (/^##\s+/.test(line)) break; // 下一段标题 → children 段结束
    const m = line.match(/^\s*[-*]\s+(?:\[([a-zA-Z]+)\]\s*)?(.+?)\s*$/);
    if (!m) continue;
    const rawType = (m[1] ?? 'research').toLowerCase();
    const type = (VALID_TYPES.has(rawType) ? rawType : 'research') as TicketType;
    const title = m[2]!.trim();
    if (title) out.push({ type, title });
  }
  return out;
}

// ── applyAfkResult (纯) ─────────────────────────────────────────────────────────

/** 一次回流的产物 (extension 用来 notify + 重 surface 前沿)。 */
export interface AfkReflow {
  ticketId: string;
  /** 本次新增的自展开子票 (D-10)。 */
  newChildren: Ticket[];
  /** 因母票裁决刚进入前沿的票 id (frontier delta, 不含母票自身)。 */
  unblocked: string[];
}

/** applyAfkResult 返回: 更新后的地图 + 本次变化 (新子票 + 刚解锁)。 */
export interface ApplyResult extends AfkReflow {
  map: PathMap;
}

/** 浅克隆一张票 (blockedBy/children 数组也拷, 保持 applyAfkResult 纯)。 */
function cloneTicket(t: Ticket): Ticket {
  return {
    ...t,
    blockedBy: [...t.blockedBy],
    ...(t.children !== undefined ? { children: [...t.children] } : {}),
  };
}

/**
 * 回流一张 research 票的结果 (**纯**, 不改入参 map):
 *  - 母票 status→ruled, ruling = distill(resultText); 补 decisionsLog (若无同 id 条目)。
 *  - 解析 `## children` → 新增子票 (id = `<parentId>-c<N>`, blockedBy = [母票], status 由 frontier 派生);
 *    母票 children 字段登记子票 id (★ children **不** block 母票, 见 types.ts)。
 *  - unblocked = 裁决 (+加子票) 后新进前沿、且原本不在前沿的票 id (不含母票)。
 * 母票不存在 → 原样返回 (isolate: watch 不因单张坏 id 崩)。
 */
export function applyAfkResult(map: PathMap, ticketId: string, resultText: string): ApplyResult {
  const beforeFrontier = new Set(computeFrontier(map).map((t) => t.id));

  const tickets = map.tickets.map(cloneTicket);
  const parent = tickets.find((t) => t.id === ticketId);
  if (!parent) {
    // 未知母票: 不改动, 空回流 (调用方 isolate)。
    return { map, ticketId, newChildren: [], unblocked: [] };
  }

  parent.status = 'ruled';
  parent.ruling = distill(resultText);

  // 自展开子票 (D-10)。
  const drafts = parseChildren(resultText);
  const existingIds = new Set(tickets.map((t) => t.id));
  const newChildren: Ticket[] = [];
  drafts.forEach((d, i) => {
    let id = `${ticketId}-c${i + 1}`;
    // 极端: id 撞车 → 追加后缀 (稳定优先, 但绝不覆盖已有票)。
    let n = i + 1;
    while (existingIds.has(id)) id = `${ticketId}-c${++n}`;
    existingIds.add(id);
    const child: Ticket = { id, type: d.type, title: d.title, blockedBy: [ticketId], status: 'open' };
    newChildren.push(child);
  });
  if (newChildren.length > 0) {
    parent.children = [...(parent.children ?? []), ...newChildren.map((c) => c.id)];
    tickets.push(...newChildren);
  }

  const decisionsLog = [...map.decisionsLog];
  if (!decisionsLog.some((d) => d.ticketId === ticketId)) {
    decisionsLog.push({ ticketId, gist: parent.ruling.slice(0, 80) });
  }

  const nextMap: PathMap = { ...map, tickets, decisionsLog };

  const afterFrontier = computeFrontier(nextMap);
  const unblocked = afterFrontier
    .map((t) => t.id)
    .filter((id) => id !== ticketId && !beforeFrontier.has(id));

  return { map: nextMap, ticketId, newChildren, unblocked };
}

// ── watchAfkResults (轮询/watcher, 注入 IO) ─────────────────────────────────────

export interface WatchOpts {
  /** repo 根 (resultPath 基准)。 */
  cwd: string;
  /** 'once' = 立即扫一遍即停 (测试/手动); 'interval' = 定时轮询 (默认 'once')。 */
  mode?: 'once' | 'interval';
  /** interval 模式轮询周期 ms (默认 4000)。 */
  intervalMs?: number;
}

export interface WatchDeps {
  /** 探一个 resultPath 是否就绪并读取; 未就绪 → null。默认 = fs.existsSync + readFileSync。 */
  readIfReady?: (path: string) => string | null;
  /** 持久回流后的地图 (md 真相 + db 索引)。默认 = no-op (调用方须注入真实 saveMap)。 */
  saveMap?: (map: PathMap, cwd: string) => void;
  /** 一次回流的通知回调 (extension 用来 notify + 重 surface 前沿)。 */
  onReflow?: (reflow: AfkReflow) => void;
  /** 注入式定时器 (interval 模式; 默认 = globalThis.setInterval, unref 若可用)。 */
  setInterval?: (fn: () => void, ms: number) => unknown;
  /** 注入式清定时器 (默认 = globalThis.clearInterval)。 */
  clearInterval?: (handle: unknown) => void;
}

/** watchAfkResults 的句柄: tick() 手动扫一遍 (返回本轮回流); stop() 停轮询。 */
export interface WatchHandle {
  tick: () => AfkReflow[];
  stop: () => void;
}

function defaultReadIfReady(path: string): string | null {
  try {
    if (!existsSync(path)) return null;
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/**
 * 轮询 AFK 研究结果并回流 (D-6):
 *  - 每 tick: 对地图内每张**未裁 research 票**, readIfReady(resultPath) 探是否落地 →
 *    applyAfkResult → saveMap 持久 → onReflow 通知。工作态地图随回流累积更新 (子票/裁决可见于下轮)。
 *  - **单张坏结果不掀桌**: 每票 try/catch 隔离 (读抛错 / 解析异常 都不影响其余票)。
 *  - once 模式: 立即 tick 一遍, stop 无副作用。interval 模式: setInterval(tick, intervalMs), stop 清除。
 *
 * @returns WatchHandle — 可手动 tick()/stop()。
 */
export function watchAfkResults(map: PathMap, opts: WatchOpts, deps: WatchDeps = {}): WatchHandle {
  const readIfReady = deps.readIfReady ?? defaultReadIfReady;
  const saveMap = deps.saveMap ?? (() => {});
  const setIntervalFn = deps.setInterval ?? ((fn, ms) => globalThis.setInterval(fn, ms));
  const clearIntervalFn = deps.clearInterval ?? ((h) => globalThis.clearInterval(h as ReturnType<typeof setInterval>));

  // 工作态地图 (随回流累积更新)。
  let current = map;
  let timer: unknown = null;

  const tick = (): AfkReflow[] => {
    const reflows: AfkReflow[] = [];
    // 快照未裁 research 票 id (本轮内 current 会变 → 先取 id 列表)。
    const pending = current.tickets.filter((t) => t.type === 'research' && t.status !== 'ruled').map((t) => t.id);
    for (const ticketId of pending) {
      try {
        const path = researchResultPath(opts.cwd, current.slug, ticketId);
        const text = readIfReady(path);
        if (text === null) continue; // 未就绪, 下轮再探
        const applied = applyAfkResult(current, ticketId, text);
        current = applied.map;
        saveMap(current, opts.cwd);
        const reflow: AfkReflow = {
          ticketId: applied.ticketId,
          newChildren: applied.newChildren,
          unblocked: applied.unblocked,
        };
        reflows.push(reflow);
        deps.onReflow?.(reflow);
      } catch {
        // 单张坏结果隔离: 不掀桌, 继续处理其余票 (SDD "never throws on a single bad result")。
      }
    }
    return reflows;
  };

  const stop = (): void => {
    if (timer !== null) {
      clearIntervalFn(timer);
      timer = null;
    }
  };

  if ((opts.mode ?? 'once') === 'once') {
    tick();
  } else {
    timer = setIntervalFn(tick, opts.intervalMs ?? 4000);
    // unref 若定时器支持 (Node/Bun timer 有 .unref) → 不阻塞进程退出。
    if (timer && typeof (timer as { unref?: () => void }).unref === 'function') {
      (timer as { unref: () => void }).unref();
    }
  }

  return { tick, stop };
}
