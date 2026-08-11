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
import type { PathMap, Ticket, WaitingLogEntry } from './types';

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
  /**
   * D-5/G-5 (O-1 终裁, 2026-08-11): 每 tick 顺带扫一遍"等人裁超时"。注入的是**后端的**
   * `sweepWaiting` 闭包 (`(now) => backend.sweepWaiting!(cwd, slug, { now })`) —— watcher 本身
   * 不认后端, 也不认超时判据 (判据全在纯核 `frontier.sweepWaitingHuman`)。
   *
   * 为什么挂在这: 超时提醒此前只挂 `path_tickets` 读路径 (pull) —— 人不来看图, 票就永远催不到人;
   * 而 owner 要的是"我不在 TUI 面前也能被触达"。gh 后端的 `sweepWaiting` 会在超时时于对应 issue
   * 落评论 (GitHub 通知推手机), 所以只要有任何进程在跑这个轮询, 那条线就活。
   *
   * 省略 = 本 watcher **不扫**超时 (NULL≠0: 「没扫」≠「扫了没超时」)。
   */
  sweepWaiting?: (now: string) => WaitingLogEntry[];
  /** 本 tick 新标 stale 的票 (空数组不叫 —— 没超时不是事件)。 */
  onStale?: (entries: WaitingLogEntry[]) => void;
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
    // 等人超时扫一遍, 放在回流**之后**: 回流可能刚把某张票裁掉, 先扫会对着过期状态催人。
    if (deps.sweepWaiting) {
      try {
        const fired = deps.sweepWaiting(new Date().toISOString());
        if (fired.length > 0) deps.onStale?.(fired);
      } catch (err) {
        // 同款隔离 (gh 抖一下不该让结果回流停摆), 但**不吞证据** (本仓坑 2)。
        console.error(`[afk-hook] sweepWaiting 失败 slug=${current.slug}: ${String(err)}`);
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

// ── goal 票回流 (D-G1.3/G1.4, c2 波 2026-08-04) ──────────────────────────────

import { renameSync, rmSync as rmSyncGoal } from 'node:fs';
import { goalAttemptsPath, goalDispatchedPath, goalResumePath, readGoalAttempts } from './dispatch';

/** goal 票一次折入的结局 (与 ReflowOutcome 分开: 语义是交付不是蒸馏)。 */
export interface GoalReflowOutcome {
  ticketId: string;
  /** 三态映射结果: delivered / escalated / resumable; warning = 后端缺操作等异常。 */
  disposition: 'delivered' | 'escalated' | 'resumable';
  outcome: string;
  runId: string;
  /** D-G1.5 (c3): 本次折入产出的建议票摘要 (applySuggestions 的 summary; 无发现物/后端缺 suggest = undefined)。 */
  suggested?: string;
  warning?: string;
}

/**
 * D-G1.5 发现物词表 (第一版规则式, 从 summarizeGoal 的结构化行拿):
 *   ① `阻塞 (需外部输入): X`      → [阻塞] X       (grill: 要人讨论)
 *   ② `预算停: X`                → [预算停] X     (task: 加预算或拆小)
 *   ③ stage 行 `  [<outcome>[/status]] <stage> — <summary>` 且 outcome≠success
 *                                → [未收敛·<stage>] <summary> (task)
 * 提取质量由接受率读数说话 (S-1 片 d), 差再上蒸馏档 (spec 未决第 1 条)。
 */
export function extractGoalDiscoveries(body: string): Array<{ type: 'grill' | 'task'; title: string }> {
  const drafts: Array<{ type: 'grill' | 'task'; title: string }> = [];
  for (const line of body.split('\n')) {
    const blocked = line.match(/^阻塞 \(需外部输入\): (.+)$/);
    if (blocked) {
      drafts.push({ type: 'grill', title: `[阻塞] ${blocked[1]!.trim()}` });
      continue;
    }
    const budget = line.match(/^预算停: (.+)$/);
    if (budget) {
      drafts.push({ type: 'task', title: `[预算停] ${budget[1]!.trim()}` });
      continue;
    }
    const stage = line.match(/^\s+\[([a-z-]+)(?:\/[a-z-]+)?\] (\S+) — (.+)$/);
    if (stage && stage[1] !== 'success') {
      drafts.push({ type: 'task', title: `[未收敛·${stage[2]}] ${stage[3]!.trim()}` });
    }
  }
  return drafts;
}

/**
 * 结果文件头解析: `outcome: <kind>` + `runId: <id>` + 可选 `acceptance: <kind>`
 * (dag_goal resultOut 写的形状)。acceptance 头是 2026-08-10 加的 (闸 B 信号线) ——
 * 老结果文件没有它, 解析出 undefined = 闸 B 不触发 (只剩闸 A 的次数上限兜底)。
 */
function parseGoalResult(text: string): { outcome: string; runId: string; acceptance?: string } | null {
  const m = text.match(/^outcome: (\S+)\nrunId: (\S+)\n(?:acceptance: (\S+)\n)?/);
  return m ? { outcome: m[1]!, runId: m[2]!, ...(m[3] ? { acceptance: m[3] } : {}) } : null;
}

/**
 * goal 档票的回流三态映射 (D-G1.4):
 *   success → markDelivered;blocked → escalated (需人);其余 (not-converged/error/预算停) →
 *   票留 ruled + 写续跑锚 (`.goal-resume` = runId, 再 deliver 时 resume 续跑)。
 * 处理过的结果文件改名归档 (`.md.done` / `.md.escalated` / `.attempt.md`) —— 再次回流不重复处理。
 * research 票不经此路 (它们的结果由 reflowResearchResults 以蒸馏语义折入)。
 */
export function reflowGoalResults(
  backend: PathBackend,
  cwd: string,
  slug: string,
  opts: { at?: string; maxAttempts?: number } = {},
): GoalReflowOutcome[] {
  const map = backend.readMap(cwd, slug);
  if (!map) return [];
  const at = opts.at ?? new Date().toISOString();
  // D-G1.5: 失败面结果 (blocked/resumable) 提取发现物草稿 → suggested 态 (人确认才成真票)。
  // 去重/上限/溯源全部由 applySuggestions 管 (S-1 管线), 这里只做词表提取。
  const suggestFrom = (body: string, runId: string): string | undefined => {
    if (!backend.suggest) return undefined;
    const drafts = extractGoalDiscoveries(body).map((d) => ({ ...d, suggestedBy: runId }));
    if (drafts.length === 0) return undefined;
    return backend.suggest(cwd, slug, drafts, { at }).summary;
  };
  const outcomes: GoalReflowOutcome[] = [];
  for (const t of map.tickets) {
    if (t.status !== 'ruled') continue;
    const isGoal = t.executorKind === 'goal' || (t.type === 'prototype' && t.executorKind === undefined);
    if (!isGoal) continue;
    const resultFile = researchResultPath(cwd, slug, t.id);
    if (!existsSync(resultFile)) continue;
    const text = readFileSync(resultFile, 'utf8');
    const head = parseGoalResult(text);
    if (!head) {
      outcomes.push({ ticketId: t.id, disposition: 'resumable', outcome: '(无头)', runId: '(unknown)', warning: '结果文件缺 outcome 头 — 未处理, 待人查' });
      continue; // 不动文件: 人查完修头或删文件
    }
    const marker = goalDispatchedPath(cwd, slug, t.id);
    const anchor = goalResumePath(cwd, slug, t.id);
    const attemptsFile = goalAttemptsPath(cwd, slug, t.id);
    // 升人共用路径 (blocked / 闸 A / 闸 B): 自动通道到此为止, 三个标记全清 —— 半清会留下
    // "escalated 却还挂着续跑锚"的矛盾态, 下次 deliver 又把它复活。
    const escalateTicket = (why?: string): boolean => {
      if (!backend.escalate) {
        outcomes.push({ ticketId: t.id, disposition: 'escalated', outcome: head.outcome, runId: head.runId, warning: `后端 ${backend.kind} 未实装 escalate — 票留 ruled, 待人处理${why ? ` (${why})` : ''}` });
        return false; // 文件不动: 下轮仍可见 (响亮重复好过静默丢失); 标记也不动 → deliver 幂等命中, 不再烧钱
      }
      backend.escalate(cwd, slug, t.id);
      const sug = suggestFrom(text, head.runId);
      renameSync(resultFile, `${resultFile}.escalated`);
      rmSyncGoal(marker, { force: true });
      rmSyncGoal(anchor, { force: true });
      rmSyncGoal(attemptsFile, { force: true });
      outcomes.push({ ticketId: t.id, disposition: 'escalated', outcome: head.outcome, runId: head.runId, ...(why ? { warning: why } : {}), ...(sug ? { suggested: sug } : {}) });
      return true;
    };
    if (head.outcome === 'success') {
      backend.markDelivered(cwd, slug, [t.id]);
      renameSync(resultFile, `${resultFile}.done`);
      rmSyncGoal(marker, { force: true });
      rmSyncGoal(anchor, { force: true });
      rmSyncGoal(attemptsFile, { force: true });
      outcomes.push({ ticketId: t.id, disposition: 'delivered', outcome: head.outcome, runId: head.runId });
    } else if (head.outcome === 'blocked') {
      escalateTicket();
    } else {
      // not-converged / error / budget-stop: 默认票留 ruled + 续跑锚落盘 (deliver 可再派) ——
      // 但先过两道闸 (2026-08-10 事故: 心跳无人续派 3.5 天烧掉一周 76% token, 单次闸拦不住跨次重派):
      // 闸 B — 探索型验收没有机器判据, "再给几轮可能就成"对它不成立 (judge 意见环可以永远说不),
      //        自动续跑期望收益为零 → 直接升人。
      // 闸 A — 续派总次数到上限 (默认 3, OMD_TICKET_GOAL_MAX_ATTEMPTS 可调) → 升人。
      //        attempt.md 里那句"连续两次落这格再去看"此前只是散文 —— 这里把它做成闸 (§8.4 讲道理拦不住)。
      const cap = opts.maxAttempts ?? Number(process.env.OMD_TICKET_GOAL_MAX_ATTEMPTS ?? 3);
      const attempts = readGoalAttempts(cwd, slug, t.id);
      if (head.acceptance === 'exploratory') {
        escalateTicket('探索型验收 (无机器判据) 不进自动续跑 — 升人裁决');
        continue;
      }
      if (attempts >= cap) {
        escalateTicket(`续派 ${attempts} 次未收敛, 达上限 ${cap} — 升人裁决 (OMD_TICKET_GOAL_MAX_ATTEMPTS 可调)`);
        continue;
      }
      const sugR = suggestFrom(text, head.runId);
      writeFileSyncGoal(anchor, head.runId);
      rmSyncGoal(marker, { force: true });
      renameSync(resultFile, resultFile.replace(/\.md$/, '.attempt.md'));
      outcomes.push({ ticketId: t.id, disposition: 'resumable', outcome: head.outcome, runId: head.runId, ...(sugR ? { suggested: sugR } : {}) });
    }
  }
  return outcomes;
}

import { writeFileSync as writeFileSyncGoal } from 'node:fs';

// ── 评论裁决折入 (第五程 2026-08-04: 手机纯评论管引擎的那半边) ─────────────────

/** 一条评论指令的折入结局。 */
export interface OwnerCommandOutcome {
  ticketId: string;
  command: string;
  applied: boolean;
  note: string;
}

/**
 * owner 评论指令折入: `/rule <text>` → backend.rule (裁决=评论原文逐字, **层间人解锁经评论成立**);
 * `/confirm accept|reject` → backend.confirmSuggestion (gh 未实装 suggested 前 warn 不动)。
 * 收集与 owner 过滤在 backend.collectOwnerCommands (gh 专属); md 后端无评论面 → 天然空。
 */
export function reflowOwnerCommands(backend: PathBackend, cwd: string, slug: string, opts: { at?: string } = {}): OwnerCommandOutcome[] {
  if (!backend.collectOwnerCommands) return [];
  const at = opts.at ?? new Date().toISOString();
  const outcomes: OwnerCommandOutcome[] = [];
  for (const cmd of backend.collectOwnerCommands(cwd, slug)) {
    try {
      if (cmd.command === 'rule') {
        if (!cmd.text) {
          outcomes.push({ ticketId: cmd.ticketId, command: cmd.command, applied: false, note: '/rule 空正文 — 忽略' });
          continue;
        }
        backend.rule(cwd, slug, cmd.ticketId, cmd.text);
        outcomes.push({ ticketId: cmd.ticketId, command: cmd.command, applied: true, note: `裁决 = 评论原文 (${cmd.text.slice(0, 60)})` });
      } else {
        if (!backend.confirmSuggestion) {
          outcomes.push({ ticketId: cmd.ticketId, command: cmd.command, applied: false, note: `后端 ${backend.kind} 未实装 confirmSuggestion (S-1 片e) — 指令搁置` });
          continue;
        }
        const action = cmd.command === 'confirm-accept' ? 'accept' : 'reject';
        const entry = backend.confirmSuggestion(cwd, slug, cmd.ticketId, action, { at });
        outcomes.push({ ticketId: cmd.ticketId, command: cmd.command, applied: true, note: `确认 → ${entry.outcome}` });
      }
    } catch (e) {
      outcomes.push({ ticketId: cmd.ticketId, command: cmd.command, applied: false, note: `折入失败: ${e instanceof Error ? e.message : String(e)}` });
    }
  }
  return outcomes;
}
