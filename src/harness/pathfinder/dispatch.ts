/**
 * src/harness/pathfinder/dispatch —— 票分派 (组件 3, D-6 / D-9 / D-13)。
 *
 * 前沿票按 type 分派 (D-9): research=AFK 后台车队 / grill=HITL 审议 (纪律约定不动手, 无代码闸) / prototype=沙盒 spike /
 * task=待编译。**纯决策 + 注入副作用**: dispatchTicket 算出该干什么 (DispatchResult), 真正的 spawn/git
 * 藏在 deps 后面 (默认 = Bun.spawn detached / Bun.spawnSync git) —— 测试注入替身, 永不起真进程/真 worktree。
 *
 * AFK 的本质 (SDD 关键): omd runtime 是单 agent loop, **无内建后台 agent 机制**。所以 "AFK 研究" =
 * **每张 research 票一个 detached 子进程** (scripts/dag-research.ts), stdout/stderr 落 log, unref 后
 * 母进程不等它。结果落 `.omd/pathfinder/results/<slug>/<ticketId>.md`, 由 afk-hook 轮询回流 (见 afk-hook.ts)。
 *
 * ★ AFK 子进程结果契约 (dag-research 写 --out 的那份 md, afk-hook 解析):
 *   ┌─ 正文 = 研究综合 (首段/首句作 distilled ruling, 见 afk-hook.distill)。
 *   └─ 可选 `## children` 段 (D-10 票自展开): 每行 `- [type] 子问题标题`, type 缺省 research。
 *      afk-hook 解析该段 → 新增子票 (blockedBy = 母票), 前沿重算。
 *
 * 溯源: D-6 (research→AFK 后台) · D-9 (type 驱动分派) · D-10 (self-expansion children) · D-13 (prototype worktree 隔离)。
 */
import { existsSync, mkdirSync, openSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { computeFrontier } from './frontier';
import type { PathMap, Ticket } from './types';

// ── 路径 helper ────────────────────────────────────────────────────────────────

/** research 结果落盘路径 (AFK 子进程 --out 目标 + afk-hook 轮询源): <cwd>/.omd/pathfinder/results/<slug>/<ticketId>.md。 */
export function researchResultPath(cwd: string, slug: string, ticketId: string): string {
  return join(cwd, '.omd', 'pathfinder', 'results', slug, `${ticketId}.md`);
}

/** research 子进程的 stdout/stderr log 路径 (与结果同目录, .log 后缀)。 */
export function researchLogPath(cwd: string, slug: string, ticketId: string): string {
  return join(cwd, '.omd', 'pathfinder', 'results', slug, `${ticketId}.log`);
}

/** 在途标记路径 (内容 = 子进程 pid): 防重复派发同一票 (双进程竞写同一 resultPath + 双倍烧钱)。 */
export function researchDispatchedPath(cwd: string, slug: string, ticketId: string): string {
  return join(cwd, '.omd', 'pathfinder', 'results', slug, `${ticketId}.dispatched`);
}

/**
 * dag-research 脚本按**本包安装位置**解析 (dispatch.ts 在 src/harness/pathfinder/ → 包根/scripts/):
 * 相对 ctx.cwd 拼 'scripts/dag-research.ts' 在别的 repo 里必然 Script not found, 且错误只进 .log,
 * 票会静默卡死在 open。scripts/ 随包发布 (package.json "files")。
 */
export function researchScriptPath(): string {
  return join(import.meta.dir, '..', '..', '..', 'scripts', 'dag-research.ts');
}

/**
 * 本图已派发过的 research 数 (按 .dispatched 标记计数, **跨 session 持久**) — D-10 自续的预算基准。
 * 结果落地不清标记 (故这是"累计派发数"而非"在途数"), 正合预算语义: 花过的钱都算。
 */
export function countDispatchedResearch(cwd: string, slug: string): number {
  try {
    return readdirSync(join(cwd, '.omd', 'pathfinder', 'results', slug)).filter((f) => f.endsWith('.dispatched')).length;
  } catch {
    return 0; // 目录不存在 = 没派发过
  }
}

/** prototype 隔离 worktree 目录 (D-13): <cwd>/.omd/pathfinder/proto/<ticketId>。 */
export function prototypeDir(cwd: string, ticketId: string): string {
  return join(cwd, '.omd', 'pathfinder', 'proto', ticketId);
}

/** prototype 隔离分支名 (D-13): proto/<ticketId>。 */
export function prototypeBranch(ticketId: string): string {
  return `proto/${ticketId}`;
}

// ── 类型 ──────────────────────────────────────────────────────────────────────

/** 一张票分派的当前上下文 (repo 根 + 地图 slug — 定 result/worktree 落点)。 */
export interface DispatchCtx {
  cwd: string;
  slug: string;
}

/**
 * 分派结果 (纯决策的产物; afk/worktree 变体的副作用已在 dispatchTicket 内经 deps 落地):
 *  - afk       research 已起 detached 子进程, 结果将落 resultPath (afk-hook 轮询)。
 *  - hitl      grill 交互票, prompt 交给用户在会话里跑 (无 spawn)。
 *  - worktree  prototype 已建隔离 worktree (dir/branch), 试验码不污主树 (弃用即 disposePrototype)。
 *  - compile   task 票, 无可运行 —— 等区域散尽由 slice-compiler 编译 (见 pathfinder-extension.onRegionClear)。
 */
export type DispatchResult =
  | { kind: 'afk'; ticketId: string; resultPath: string; pid?: number }
  | { kind: 'hitl'; ticketId: string; prompt: string }
  | { kind: 'worktree'; ticketId: string; dir: string; branch: string }
  | { kind: 'compile'; ticketId: string };

/** 注入式副作用 (默认 = 生产实现; 测试传替身, 永不起真进程/真 worktree)。 */
export interface DispatchDeps {
  /**
   * 起一个 detached 子进程 (research AFK)。默认 = Bun.spawn detached + stdout/stderr→logPath + unref。
   * 返回 pid (可选; 拿不到返回 undefined)。cmd = argv 数组 (无需 shell 引号)。
   */
  spawnDetached?: (cmd: string[], opts: { cwd: string; logPath: string }) => number | undefined;
  /** 跑一条 git 命令 (prototype worktree add/remove)。默认 = Bun.spawnSync('git', args)。 */
  git?: (args: string[], opts: { cwd: string }) => void;
  /** 探一个 pid 是否存活 (在途去重用)。默认 = process.kill(pid, 0)。 */
  isAlive?: (pid: number) => boolean;
}

// ── 默认生产实现 (纯壳, 测试永不触及) ──────────────────────────────────────────

/** 默认 spawnDetached: Bun.spawn detached, stdout/stderr → log 文件, unref (母进程不等)。 */
function defaultSpawnDetached(cmd: string[], opts: { cwd: string; logPath: string }): number | undefined {
  mkdirSync(dirname(opts.logPath), { recursive: true });
  const fd = openSync(opts.logPath, 'a');
  const proc = Bun.spawn(cmd, {
    cwd: opts.cwd,
    stdin: 'ignore',
    stdout: fd as unknown as number,
    stderr: fd as unknown as number,
  });
  proc.unref();
  return proc.pid;
}

/** 默认 git: Bun.spawnSync('git', args, {cwd}); 非零退出即抛 (worktree 建/删失败要显性)。 */
function defaultGit(args: string[], opts: { cwd: string }): void {
  const r = Bun.spawnSync(['git', ...args], { cwd: opts.cwd });
  if (r.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} 失败 (exit=${r.exitCode}): ${r.stderr?.toString() ?? ''}`);
  }
}

/** 默认 isAlive: kill(pid, 0) 不发信号只探存在; 抛 ESRCH/EPERM → 视作死。 */
function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ── dispatchTicket (纯决策 + 注入副作用) ────────────────────────────────────────

/**
 * 按 type 分派一张票 (D-9)。纯决策 + 经 deps 落副作用 (research spawn / prototype worktree):
 *  - research (D-6): 起 detached `bun run scripts/dag-research.ts "<title>" --out <resultPath>` → {afk}。
 *  - grill: HITL, 出 `/grill this: <title>` prompt, 无 spawn → {hitl}。
 *  - prototype (D-13): `git worktree add <dir> -b <branch>` 隔离 → {worktree}。
 *  - task: 无可运行, 等区域散尽编译 → {compile}。
 */
export function dispatchTicket(ticket: Ticket, ctx: DispatchCtx, deps: DispatchDeps = {}): DispatchResult {
  switch (ticket.type) {
    case 'research': {
      const spawn = deps.spawnDetached ?? defaultSpawnDetached;
      const isAlive = deps.isAlive ?? defaultIsAlive;
      const resultPath = researchResultPath(ctx.cwd, ctx.slug, ticket.id);
      const logPath = researchLogPath(ctx.cwd, ctx.slug, ticket.id);
      // 去重①: 结果已落地 → 不再 spawn (watcher 下一 tick 回流)。
      if (existsSync(resultPath)) return { kind: 'afk', ticketId: ticket.id, resultPath };
      // 去重②: 在途标记 + 进程仍活 → 不再 spawn (防双进程竞写同一 resultPath + 双倍烧钱)。
      // 进程已死而无结果 (崩/被杀) → 视作 stale, 重派并覆写标记。
      const dispatchedPath = researchDispatchedPath(ctx.cwd, ctx.slug, ticket.id);
      if (existsSync(dispatchedPath)) {
        const prevPid = Number(readFileSync(dispatchedPath, 'utf8').trim());
        if (Number.isFinite(prevPid) && prevPid > 0 && isAlive(prevPid)) {
          return { kind: 'afk', ticketId: ticket.id, resultPath, pid: prevPid };
        }
      }
      // --children: 终稿按共享契约附 `## children` 段 (D-10 自展开; 护栏在消费端 afk-hook)。
      const cmd = ['bun', 'run', researchScriptPath(), ticket.title, '--out', resultPath, '--children'];
      const pid = spawn(cmd, { cwd: ctx.cwd, logPath });
      if (pid !== undefined) {
        try {
          mkdirSync(dirname(dispatchedPath), { recursive: true });
          writeFileSync(dispatchedPath, String(pid), 'utf8');
        } catch {
          // 标记是去重优化, 写不了 (只读 fs / 测试假 cwd) 不阻断派发本身。
        }
      }
      return { kind: 'afk', ticketId: ticket.id, resultPath, ...(pid !== undefined ? { pid } : {}) };
    }
    case 'grill':
      // HITL: 用户在会话里交互跑 (只读审议), 分派器只出 prompt, 不 spawn。
      return { kind: 'hitl', ticketId: ticket.id, prompt: `/grill this: ${ticket.title}` };
    case 'prototype': {
      const git = deps.git ?? defaultGit;
      const dir = prototypeDir(ctx.cwd, ticket.id);
      const branch = prototypeBranch(ticket.id);
      git(['worktree', 'add', dir, '-b', branch], { cwd: ctx.cwd });
      return { kind: 'worktree', ticketId: ticket.id, dir, branch };
    }
    case 'task':
    default:
      // 无可运行: 等区域散尽 → slice-compiler 编译 (D-11)。
      return { kind: 'compile', ticketId: ticket.id };
  }
}

/** 弃用一张 prototype 票的隔离 worktree (D-13: 试验的意义是可弃)。git worktree remove --force。 */
export function disposePrototype(ticketId: string, cwd: string, deps: DispatchDeps = {}): void {
  const git = deps.git ?? defaultGit;
  git(['worktree', 'remove', '--force', prototypeDir(cwd, ticketId)], { cwd });
}

// ── dispatchFrontier (前沿批量分派) ────────────────────────────────────────────

/** 前沿分派结果: research 已 spawn 的 afk 列表 + 其余 (grill/prototype/task) 仅上报给 UI (不自动起副作用)。 */
export interface FrontierDispatch {
  /** research 票已起后台 (每张一个 detached 子进程)。 */
  dispatched: DispatchResult[];
  /** 其余前沿票 (grill/prototype/task) —— 仅报给 UI, **不**自动 spawn/建 worktree (避免惊吓副作用, D-5)。 */
  reported: Ticket[];
}

/**
 * 批量分派前沿 (computeFrontier): **只**自动 spawn research 票 (AFK 后台车队, D-6)。
 * grill 需人交互、prototype 会建 git 分支 —— 都是"会惊吓的副作用", 故仅 reported 给 UI 由人显式触发。
 */
export function dispatchFrontier(map: PathMap, ctx: DispatchCtx, deps: DispatchDeps = {}): FrontierDispatch {
  const frontier = computeFrontier(map);
  const dispatched: DispatchResult[] = [];
  const reported: Ticket[] = [];
  for (const t of frontier) {
    if (t.type === 'research') dispatched.push(dispatchTicket(t, ctx, deps));
    else reported.push(t);
  }
  return { dispatched, reported };
}
