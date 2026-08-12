/**
 * src/harness/pathfinder/backend —— 操作级后端端口 (BackendPort, SDD S1 · D-A/D-B/D-E)。
 *
 * 决策地图有两种承载: **md** (docs/plan/pathfinder/*.md, 现状, map-store 打包) 与 **gh**
 * (GitHub Issues, 云端 AFK, backend-gh)。MCP 工具面只认这个接口 (D-A: 工具层零 `backend.kind`
 * 分支), 由 `resolveBackend(cwd)` 按解析序挑一个实现。PathMap/Ticket 类型不改 —— frontier/
 * slice-compiler/dispatch 全部照旧吃 PathMap (readMap 实时拼出等价形状)。
 *
 * 解析序 (D-E fail-loud, 绝不静默降级):
 *   env OMD_PATH_BACKEND 显式覆盖  >  .omd/pathfinder/config.json {"backend"}  >  默认 'md'
 * 配置声明 gh 但探测失败 (无 gh / 未认证 / 无 remote) → throw 带修复命令的错误 (不退回 md)。
 *
 * idiom 参考 dispatch.ts: **纯决策 + 注入副作用**。gh 后端全部 shell-out 经注入的 GhRunner
 * (默认 Bun.spawnSync('gh', ...)); 测试注入 fixture, 永不真调 gh。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { researchResultPath } from './dispatch';
import { loadMap, mutateMap, saveMap } from './map-store';
import { markWaitingHuman, sweepWaitingHuman } from './frontier';
import type { DispatchableClass, ExecutorKind, PathMap, SuggestionLogEntry, Ticket, TicketType, WaitingLogEntry } from './types';

/** 一条 owner 评论指令 (collectOwnerCommands 的输出形状)。 */
export interface OwnerCommand {
  ticketId: string;
  command: 'rule' | 'confirm-accept' | 'confirm-reject';
  /** rule 的裁决正文 (confirm 无正文 = 空串)。 */
  text: string;
}
import {
  applySuggestions,
  confirmSuggestion as confirmSuggestionPure,
  type ApplySuggestionsOpts,
  type ApplySuggestionsResult,
  type ConfirmAction,
  type SuggestionDraft,
} from './suggest';
import { createGhBackend } from './backend-gh';

// ── 端口类型 ────────────────────────────────────────────────────────────────────

/**
 * 新票的形状 (addTicket 入参): 后端据此 emit 一张票并回填稳定 id。
 * - md: id 由票类型前缀自增 (r1/g1/p1/t1); 显式 `id` 可覆盖。
 * - gh: id = 新 issue number 的 `#N` 串 (D-D, 无内部映射表)。
 * body/parentId 主要给 gh (issue 正文 / sub-issue 挂接); md 忽略 body, parentId 落 parent.children。
 */
export interface NewTicket {
  type: TicketType;
  title: string;
  blockedBy: string[];
  /** issue 正文 (gh); md 无独立 body 字段 → 忽略。 */
  body?: string;
  /** 母票 id (挂 sub-issue / children); 省略 → 挂地图本身 (gh) 或不挂 (md)。 */
  parentId?: string;
  /** task 票用: slice 编译器执行器种类 (md path_add 透传, 保留)。 */
  executorKind?: ExecutorKind;
  /** 显式 id (md; 省略 = 自动)。gh 忽略 (id 由 issue number 定)。 */
  id?: string;
  /**
   * D-3 票语义类 (切片 6): 出生即标类。**域是 `DispatchableClass`** —— 这个口开不出裁决票
   * (裁决票是人裁出来的, 不是机器 addTicket 出来的; 想开裁决票就得先有人)。
   * 省略 = 不标 (存量语义: NULL≠0, 「没标」≠「标了 task」)。gh 后端忽略 (md 落盘字段)。
   */
  ticketClass?: DispatchableClass;
  /**
   * 票身 runId 锚 (D-6③ run 天然挂票 / G-2 票→runId→回执)。字段与 S-1 建议票同一个
   * (`Ticket.suggestedBy`) —— 两者是同一件事: **这张票是哪一次机器动作生出来的**。
   * 省略 = 人手开的票 (无 run 锚)。gh 后端忽略。
   */
  suggestedBy?: string;
}

/** 操作级后端端口。read 方向拼装 PathMap, write 方向语义操作 (create/add/rule/deliver)。 */
export interface PathBackend {
  readonly kind: 'md' | 'gh';
  /** 列本 repo 的开放地图 (slug + 目的地; 计数由工具层用 readMap 现算, 两后端一致)。 */
  listMaps(cwd: string): Array<{ slug: string; destination: string }>;
  /** 实时拼一张图 (不存在 → null)。 */
  readMap(cwd: string, slug: string): PathMap | null;
  /** 建一张空图。slug = 建议键 (md 用它作文件名; gh 忽略, 用新 issue number)。 */
  createMap(cwd: string, destination: string, slug: string): PathMap;
  /** 加一张票, 回填后的 Ticket (含稳定 id)。map 不存在 / blockedBy 悬空 → throw。 */
  addTicket(cwd: string, slug: string, t: NewTicket): Ticket;
  /** S-1 (可选, gh 片 e 才实装): 机器建议入图 → suggested 态。缺 = 工具层响亮报「后端未实装」。 */
  suggest?(cwd: string, slug: string, drafts: SuggestionDraft[], opts: ApplySuggestionsOpts): ApplySuggestionsResult;
  /** S-1 (可选, 同上): 人确认 suggested 票 (accept/±title/reject), 台账 append-only。 */
  confirmSuggestion?(cwd: string, slug: string, ticketId: string, action: ConfirmAction, opts: { at: string; title?: string }): SuggestionLogEntry;
  /**
   * 评论裁决 (可选, gh 专属 — md 无评论面): 收 **repo owner 本人**在 open 票下写的指令评论
   * (`/rule <text>` · `/confirm accept|reject`), 每票取最后一条。幂等锚 = 状态翻转
   * (rule 落地后票非 open, 下轮不再收)。非 owner 的评论**永不**成为指令 (层间人解锁只认 owner)。
   */
  collectOwnerCommands?(cwd: string, slug: string): OwnerCommand[];
  /** 裁一张票 (记决策)。票不存在 → throw。 */
  rule(cwd: string, slug: string, ticketId: string, ruling: string): void;
  /** D-G1.4 (可选, gh 片 e 才实装): goal 票 solve 报 blocked → 票翻 escalated (需人)。 */
  escalate?(cwd: string, slug: string, ticketId: string): void;
  /**
   * D-5/G-5 (切片 6 接线, 可选): 扫本图超时的"等人裁"票 → 标 stale + 写 waitingLog, 落盘。
   * 判据纯核在 `frontier.sweepWaitingHuman` (只升级 `waiting` 一档), 本端口只负责读改写。
   * 缺 = 该后端**没有超时升级** (gh 今天就是这一格) —— 不是"扫过没超时", 别把两者读成一件事。
   */
  sweepWaiting?(cwd: string, slug: string, opts: { now: string; timeoutMs?: number }): WaitingLogEntry[];
  /** 把一批已裁票翻 delivered (终态)。 */
  markDelivered(cwd: string, slug: string, ticketIds: string[]): void;
  /**
   * D-6③ 派发锚 (control-plane G-2「票→runId→回执」)。**可选端口**:
   * 缺 = 该后端不记派发锚(gh 今天就是这一格)—— 那是"这条链没接", 不是"派发过但没在跑",
   * 读侧据此把该后端的票一律算作**无锚**, 而不是猜一个状态出来。
   *
   * `open`  = 派发前打锚(runId + startedAt), 只打在 `ruled` 票上(别的状态不该被派发)。
   * `settle`= 收工回填(finishedAt + outcome), 幂等:已有 finishedAt 的不覆写
   *           (一次派发只settle一次; 覆写会把第一次的真相抹掉)。
   */
  markDispatch?(
    cwd: string,
    slug: string,
    ticketIds: string[],
    anchor: { open: { runId: string; startedAt: string } } | { settle: { finishedAt: string; outcome: 'passed' | 'failed' } },
  ): void;
  /**
   * 收本图待折入的 research 结果 (S3 回流入料; 折入编排见 afk-hook.reflowResearchResults, 后端无关)。
   * - md: 未裁 research 票的落盘结果文件 (.omd/pathfinder/results/<slug>/<id>.md)。
   * - gh: 带 `research-done` label 的票, body = 该票评论里最后一条含结果形状 (`## 终稿`) 的正文;
   *   有 label 但无结果评论 → body 空串 (编排据此标警告, 不 ack, 留待下轮)。
   */
  collectResearchResults(cwd: string, slug: string): Array<{ ticketId: string; body: string }>;
  /**
   * 标记一张 research 结果"已折入"(幂等锚点, 防重复折入)。
   * - md: no-op —— 折入时 rule() 已把票翻 ruled, collectResearchResults 只收 open research 票,
   *   ruled 状态即"已折入"标记 (既有语义, 非桩)。
   * - gh: 摘 `research-done` label (下轮 collect 不再命中)。
   */
  ackResearchResult(cwd: string, slug: string, ticketId: string): void;
}

// ── GhRunner (gh 副作用注入点; backend-gh 消费, 此处定型 + 默认实现) ──────────────

/** 一次 gh 调用的结果 (--json / graphql 结构化输出走 stdout)。 */
export interface GhResult {
  stdout: string;
  exitCode: number;
  stderr?: string;
}

/** gh 调用器: argv (无需 shell 引号) → 结果。默认 = Bun.spawnSync('gh', ...); 测试注入 fixture。 */
export type GhRunner = (args: string[]) => GhResult;

/** 默认 GhRunner: Bun.spawnSync(['gh', ...args], {cwd})。cwd 绑定, 保证 gh 认对当前 repo remote。 */
function defaultGhRunner(cwd: string): GhRunner {
  return (args: string[]): GhResult => {
    const r = Bun.spawnSync(['gh', ...args], { cwd });
    return {
      stdout: r.stdout?.toString() ?? '',
      exitCode: r.exitCode ?? -1,
      stderr: r.stderr?.toString() ?? '',
    };
  };
}

// ── md 后端 (现有 map-store 打包, 行为一字不变) ─────────────────────────────────

/** 目录扫描 (summarizeOpenMaps 的 slug+destination 子集; 计数留工具层现算, 不在端口面重复)。 */
function scanMdMaps(cwd: string): Array<{ slug: string; destination: string }> {
  const dir = join(cwd, 'docs', 'plan', 'pathfinder');
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.md'));
  } catch {
    return []; // 目录不存在 = 无图
  }
  const out: Array<{ slug: string; destination: string }> = [];
  for (const f of files.sort()) {
    const slug = f.slice(0, -3);
    const map = loadMap(cwd, slug);
    if (!map) continue;
    out.push({ slug: map.slug || slug, destination: map.destination });
  }
  return out;
}

/** md 后端: loadMap/mutateMap/saveMap 的操作级适配。行为与既有 TUI/CLI 路径完全一致 (regressions 为证)。 */
function createMdBackend(): PathBackend {
  return {
    kind: 'md',
    listMaps: (cwd) => scanMdMaps(cwd),
    readMap: (cwd, slug) => loadMap(cwd, slug),
    createMap: (cwd, destination, slug) => {
      const map: PathMap = { destination, slug, tickets: [], decisionsLog: [] };
      saveMap(map, cwd);
      return map;
    },
    addTicket: (cwd, slug, nt) => {
      const mutated = mutateMap(cwd, slug, (map): Ticket => {
        const ids = new Set(map.tickets.map((t) => t.id));
        for (const dep of nt.blockedBy) {
          if (!ids.has(dep)) throw new Error(`blockedBy 引用不存在的票 "${dep}"`);
        }
        let tid = nt.id ?? '';
        if (!tid) {
          const prefix = nt.type[0]!; // r/g/p/t
          let n = 1;
          while (ids.has(`${prefix}${n}`)) n++;
          tid = `${prefix}${n}`;
        } else if (ids.has(tid)) {
          throw new Error(`票 id "${tid}" 已存在`);
        }
        const t: Ticket = {
          id: tid,
          type: nt.type,
          title: nt.title,
          blockedBy: nt.blockedBy,
          status: 'open',
          ...(nt.executorKind ? { executorKind: nt.executorKind } : {}),
          ...(nt.suggestedBy ? { suggestedBy: nt.suggestedBy } : {}),
          // 判别键**不在** `Ticket` 上 (types.ts 讲了为什么), 落盘/读回由 map-store 的 StoredTicket 管。
          ...(nt.ticketClass ? ({ ticketClass: nt.ticketClass } as { ticketClass: DispatchableClass }) : {}),
        };
        map.tickets.push(t);
        // parentId → 落母票 children (D-J: 展开语义留本地, 两后端一致)。
        if (nt.parentId) {
          const parent = map.tickets.find((p) => p.id === nt.parentId);
          if (parent) parent.children = [...(parent.children ?? []), tid];
        }
        return t;
      });
      if (!mutated) throw new Error(`找不到地图 "${slug}"`);
      return mutated.result;
    },
    suggest: (cwd, slug, drafts, opts) => {
      const mutated = mutateMap(cwd, slug, (map) => applySuggestions(map, drafts, opts));
      if (!mutated) throw new Error(`找不到地图 "${slug}"`);
      return mutated.result;
    },
    confirmSuggestion: (cwd, slug, ticketId, action, opts) => {
      const mutated = mutateMap(cwd, slug, (map) => confirmSuggestionPure(map, ticketId, action, opts));
      if (!mutated) throw new Error(`找不到地图 "${slug}"`);
      return mutated.result;
    },
    escalate: (cwd, slug, ticketId) => {
      const mutated = mutateMap(cwd, slug, (map): boolean => {
        const tk = map.tickets.find((t) => t.id === ticketId);
        if (!tk) return false;
        // D-5 三戳之一 (切片 6 接线): escalated 是"等人裁"两态之一 —— 进态就打进入戳,
        // 否则 waitingHumanState 只能答 `waiting-unknown-since`, 超时永远升级不了 (G-5 的 NULL≠0)。
        // 时钟在这里取 (端口是 IO 层; 纯核 frontier.markWaitingHuman 仍不自取时钟, 可重放)。
        markWaitingHuman(tk, new Date().toISOString());
        tk.status = 'escalated';
        return true;
      });
      if (!mutated || !mutated.result) throw new Error(`escalate: 找不到票 "${ticketId}" (图 "${slug}")`);
    },
    rule: (cwd, slug, ticketId, ruling) => {
      const mutated = mutateMap(cwd, slug, (map): boolean => {
        const tk = map.tickets.find((t) => t.id === ticketId);
        if (!tk) return false;
        tk.status = 'ruled';
        tk.ruling = ruling;
        // D-5 三戳之二: 判词落盘的时刻。它与 waitingSince 的**先后**是「裁了没记」的唯一判据
        // (票可被裁过又重新升人 —— 看 ruling 文本有无必误判, 见 types.ts 那段注)。
        tk.ruledAt = new Date().toISOString();
        if (!map.decisionsLog.some((d) => d.ticketId === ticketId)) {
          map.decisionsLog.push({ ticketId, gist: ruling.slice(0, 80) });
        }
        return true;
      });
      if (!mutated) throw new Error(`找不到地图 "${slug}"`);
      if (!mutated.result) throw new Error(`地图里没有票 "${ticketId}"`);
    },
    // D-5/G-5: 纯核算 (sweepWaitingHuman 就地改 map), 这里只负责经 mutateMap 落盘。
    // 图不存在 → [] (读路径上顺手扫的东西不该因为图没了而炸掉整个 path_tickets)。
    //
    // ⚠ **零 stale 零写** (2026-08-11 事故修): 它挂在 path_tickets **读路径**上, 无条件
    // mutateMap 会让"看一眼图"就 parse→render 重写真相文件 —— 手写的 parser 外字段
    // (`- delivered:` commit 锚) 被静默丢弃, 实测在 omd-mcp-server.md 上真丢过 6 行。
    // 所以先纯读判定, 真有票要标 stale 才落盘; 常态路径对文件零字节触碰。
    sweepWaiting: (cwd, slug, opts) => {
      const probe = loadMap(cwd, slug);
      if (!probe) return [];
      if (sweepWaitingHuman(probe, opts).length === 0) return [];
      const mutated = mutateMap(cwd, slug, (map) => sweepWaitingHuman(map, opts));
      return mutated ? mutated.result : [];
    },
    markDelivered: (cwd, slug, ticketIds) => {
      const set = new Set(ticketIds);
      mutateMap(cwd, slug, (map) => {
        for (const t of map.tickets) {
          if (set.has(t.id) && t.status === 'ruled') t.status = 'delivered';
        }
      });
    },
    markDispatch: (cwd, slug, ticketIds, anchor) => {
      const set = new Set(ticketIds);
      mutateMap(cwd, slug, (map) => {
        for (const t of map.tickets) {
          if (!set.has(t.id)) continue;
          if ('open' in anchor) {
            // 只给 `ruled` 票打锚:别的状态本就不该被派发, 给它们打锚等于把一个假事实写进真源。
            if (t.status !== 'ruled') continue;
            t.dispatch = { runId: anchor.open.runId, startedAt: anchor.open.startedAt };
          } else {
            // 幂等 + 不覆写:没锚的不凭空造(那会造出"跑完了但没人派过"的记录);
            // 已 settle 的不覆写(第一次的真相是这次派发的真相)。
            if (!t.dispatch || t.dispatch.finishedAt) continue;
            t.dispatch = { ...t.dispatch, finishedAt: anchor.settle.finishedAt, outcome: anchor.settle.outcome };
          }
        }
      });
    },
    // 收未裁 research 票的落盘结果 (afk-hook 轮询的同一批文件, 现经端口出料): 只收 open research 票
    // (ruled/escalated/delivered 已定, 迟到结果不覆写)。文件不存在 → 跳过 (未就绪, 下轮再收)。
    collectResearchResults: (cwd, slug) => {
      const map = loadMap(cwd, slug);
      if (!map) return [];
      const out: Array<{ ticketId: string; body: string }> = [];
      for (const t of map.tickets) {
        if (t.type !== 'research' || t.status !== 'open') continue;
        const p = researchResultPath(cwd, slug, t.id);
        if (!existsSync(p)) continue;
        out.push({ ticketId: t.id, body: readFileSync(p, 'utf8') });
      }
      return out;
    },
    // md 无独立"已折入"标记: 折入编排先 rule() 把票翻 ruled, 而 collectResearchResults 只收 open 票 →
    // 已折入的票天然不再被收。故 ack 为幂等 no-op (既有语义, 非桩)。
    ackResearchResult: () => {},
  };
}

// ── resolveBackend (解析序 + fail-loud) ─────────────────────────────────────────

/** 从 .omd/pathfinder/config.json 读后端选择 (缺文件 / 坏 json / 无字段 → null)。 */
function configuredBackend(cwd: string): 'md' | 'gh' | null {
  const p = join(cwd, '.omd', 'pathfinder', 'config.json');
  if (!existsSync(p)) return null;
  try {
    const j = JSON.parse(readFileSync(p, 'utf8')) as { backend?: unknown };
    return j.backend === 'gh' || j.backend === 'md' ? j.backend : null;
  } catch {
    return null; // 坏 json 不阻断: 当没配 → 走默认 (config 是可选覆盖, 非真相闸)。
  }
}

/**
 * 从 config 读原生依赖能力开关 (D-C.2 门: init 金丝雀探测写入 capabilities.nativeDependencies)。
 * 缺文件 / 坏 json / 无字段 → false 保守 (env 强制 gh 而无 config 时也走 legacy body 尾行, 不猜)。
 */
function configuredNativeDeps(cwd: string): boolean {
  const p = join(cwd, '.omd', 'pathfinder', 'config.json');
  if (!existsSync(p)) return false;
  try {
    const j = JSON.parse(readFileSync(p, 'utf8')) as { capabilities?: { nativeDependencies?: unknown } };
    return j.capabilities?.nativeDependencies === true;
  } catch {
    return false;
  }
}

/** resolveBackend 的注入接缝 (测试传替身)。省略 = 生产默认 (process.env + Bun.spawnSync gh)。 */
export interface ResolveBackendDeps {
  /** 环境变量源 (读 OMD_PATH_BACKEND)。默认 process.env。 */
  env?: NodeJS.ProcessEnv;
  /** gh 调用器 (选中 gh 时用)。默认 = 绑定 cwd 的 Bun.spawnSync('gh', ...)。 */
  gh?: GhRunner;
}

/**
 * 挑后端: env 显式覆盖 > 仓库配置 > 默认 md。选中 gh → 构造时探测 (fail-loud, D-E: 探不到不退回 md)。
 * env 显式给了非法值 (非 gh|md) 也 fail-loud (拼错的意图不该被静默当默认吞掉)。
 */
export function resolveBackend(cwd: string, deps: ResolveBackendDeps = {}): PathBackend {
  const env = deps.env ?? process.env;
  const explicit = env.OMD_PATH_BACKEND;
  if (explicit !== undefined && explicit !== 'gh' && explicit !== 'md') {
    throw new Error(`OMD_PATH_BACKEND 只能是 gh|md, 得到 "${explicit}" — 改对或删掉该环境变量。`);
  }
  const choice: 'md' | 'gh' = explicit ?? configuredBackend(cwd) ?? 'md';
  if (choice === 'md') return createMdBackend();
  const gh = deps.gh ?? defaultGhRunner(cwd);
  // blockedBy 真相源 (D-C.2) 由 config.capabilities.nativeDependencies 定, 缺省 false (legacy body 尾行)。
  return createGhBackend(gh, configuredNativeDeps(cwd)); // 构造即探测, 失败 throw 带修复命令
}
