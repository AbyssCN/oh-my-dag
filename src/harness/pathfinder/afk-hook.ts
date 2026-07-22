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
 * AFK 结果契约: 见 result-format.ts (生产者 dag-research / 消费者本模块**共享同一契约模块**,
 *   distill 取 `## 终稿` 段, 可选 `## children` 段 → 子票 blockedBy = 母票, D-10)。
 */
import { existsSync, readFileSync } from 'node:fs';
import { computeFrontier } from './frontier';
import { researchResultPath } from './dispatch';
import { distill, MAX_CHILDREN_PER_TICKET, parseChildren } from './result-format';
import type { PathBackend } from './backend';
import type { PathMap, Ticket } from './types';

// distill / parseChildren 的真身在 result-format.ts (双端共享契约); 这里 re-export 兼容既有 import。
export { distill, parseChildren } from './result-format';

// ── applyAfkResult (纯) ─────────────────────────────────────────────────────────

/** 一次回流的产物 (extension 用来 notify + 重 surface 前沿)。 */
export interface AfkReflow {
  ticketId: string;
  /** 本次新增的自展开子票 (D-10)。 */
  newChildren: Ticket[];
  /** 因母票裁决刚进入前沿的票 id (frontier delta, 不含母票自身)。 */
  unblocked: string[];
  /** 被护栏丢弃的子票草案数 (超上限截断 / 超深度整段丢弃); 0 省略。 */
  droppedChildren?: number;
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

  // 自展开子票 (D-10)。深度不设限 (地图深度 = 知识结构, 成本边界在派发预算);
  // 单票截断到 MAX_CHILDREN_PER_TICKET = 契约兜底 (生产端指令本就要求 ≤4, 违约才触发)。
  const allDrafts = parseChildren(resultText);
  let drafts = allDrafts;
  let droppedChildren = 0;
  if (allDrafts.length > MAX_CHILDREN_PER_TICKET) {
    drafts = allDrafts.slice(0, MAX_CHILDREN_PER_TICKET);
    droppedChildren = allDrafts.length - drafts.length;
  }
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

  return { map: nextMap, ticketId, newChildren, unblocked, ...(droppedChildren > 0 ? { droppedChildren } : {}) };
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
  /**
   * 每 tick 开头从真相源重载地图; 返回 null → 沿用当前工作态。**生产必须注入** (loadMap(cwd, slug)):
   * 否则 watcher 抱着启动时的内存快照, 会把用户 tick 间 /rule 落盘的裁决整文件覆写回滚。
   * 纯测试可省略 (无盘, 工作态即真相)。
   */
  reloadMap?: () => PathMap | null;
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
    // 每 tick 从真相源重载 (防旧快照覆写他人落盘的裁决); 读-改-写在本 tick 内全同步, 不跨 await。
    const fresh = deps.reloadMap?.();
    if (fresh) current = fresh;
    // 只回流 status=open 的 research 票: ruled/delivered 已定, escalated 是人的裁定权 ——
    // 结果文件迟到也**不得**把人工升级覆写回 ruled。
    const pending = current.tickets.filter((t) => t.type === 'research' && t.status === 'open').map((t) => t.id);
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
          ...(applied.droppedChildren !== undefined ? { droppedChildren: applied.droppedChildren } : {}),
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

// ── reflowResearchResults (后端无关折入编排, S3) ─────────────────────────────────

/** 一张 research 结果折入的产物 (MCP/TUI 用来渲染 + 决定预算内自续)。 */
export interface ReflowOutcome {
  ticketId: string;
  /** 本次经 backend.addTicket 建的自展开子票 (D-10; 挂母票 blockedBy=母票)。 */
  newChildren: Ticket[];
  /** 超上限被截断的子票草案数 (契约兜底); 0 省略。 */
  droppedChildren?: number;
  /** 设值 = 该票未折入 (结果缺失/未就绪/后端报错), **未 ack**, 留待下轮重试; 无值 = 折入成功。 */
  warning?: string;
}

/**
 * 后端无关的 research 结果折入 (S3 · SDD §4): distill + `## children` 解析 + 状态翻转的**编排**留此处,
 * "结果从哪来 / 状态往哪写" 全经 PathBackend 端口 (md 走落盘文件+ruled 状态, gh 走 issue 评论+label)。
 *
 * 一张结果的折入序:
 *   1. collect: backend.collectResearchResults 出料 (母票 id + 结果正文)。
 *   2. distill → ruling → backend.rule 翻转母票状态 (md: →ruled+decisionsLog; gh: 评论 **ruling** + close)。
 *   3. parseChildren (截断到契约上限) → 逐条 backend.addTicket 建子票 (parentId=母票 挂血缘, blockedBy=母票)。
 *   4. backend.ackResearchResult 落幂等锚点 (md: no-op; gh: 摘 research-done label)。
 *
 * 纪律:
 *  - **逐票隔离** (单张坏结果不掀桌): 每票 try/catch, 一张抛错不影响其余。
 *  - **结果空/未就绪 / 折入抛错 → 标 warning, 不 ack** (留待下轮重试; gh 评论缺失即走此路, 绝不静默跳过)。
 *  - 子票 id 由后端自行分配 (md 类型前缀自增 / gh issue number); parentId 已挂 children 血缘, 无需外派 id。
 */
export function reflowResearchResults(backend: PathBackend, cwd: string, slug: string): ReflowOutcome[] {
  const collected = backend.collectResearchResults(cwd, slug);
  const outcomes: ReflowOutcome[] = [];
  for (const { ticketId, body } of collected) {
    try {
      // 空/未就绪结果 (gh: 有 research-done label 却无结果评论): 标警告不 ack, 不把票折成占位裁决。
      if (body.trim() === '') {
        outcomes.push({ ticketId, newChildren: [], warning: '研究结果缺失/未就绪' });
        continue;
      }
      backend.rule(cwd, slug, ticketId, distill(body));
      // 自展开子票: 截断到 MAX_CHILDREN_PER_TICKET (契约兜底; 生产端指令本就 ≤4, 违约才触发)。
      const allDrafts = parseChildren(body);
      const drafts = allDrafts.slice(0, MAX_CHILDREN_PER_TICKET);
      const droppedChildren = allDrafts.length - drafts.length;
      const newChildren = drafts.map((d) =>
        backend.addTicket(cwd, slug, { type: d.type, title: d.title, blockedBy: [ticketId], parentId: ticketId }),
      );
      backend.ackResearchResult(cwd, slug, ticketId);
      outcomes.push({ ticketId, newChildren, ...(droppedChildren > 0 ? { droppedChildren } : {}) });
    } catch (e) {
      // 折入中途抛错 (rule/addTicket/ack 任一后端调用失败): 标警告不 ack, 留待下轮 (已提交的部分副作用
      // 由后端各自幂等性兜底 —— gh addTicket 会重建但 rule 评论幂等叠加, 属可接受的重试代价)。
      outcomes.push({ ticketId, newChildren: [], warning: e instanceof Error ? e.message : String(e) });
    }
  }
  return outcomes;
}
