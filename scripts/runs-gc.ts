#!/usr/bin/env bun
/**
 * scripts/runs-gc —— run worktree 生命周期回收(#252)。
 *
 * ## 为什么需要它
 *
 * `#253` 之后写型 run 默认落隔离 worktree,于是 `.omd/runs/` 只涨不落。
 * 2026-08-25 普查:**51 棵树 / 66 个 `omd/run/*` 分支**,而其中
 * **35 棵既没有 runs.db 账、也没有 continuity 记录** —— 那是测试造的残渣,不是 run。
 *
 * ## 判别键是「有没有账」,不是「多久没动」
 *
 * 票原本的护栏写的是「终态 < 2 天跳过」。那条护栏的用意是**给真 run 留验收窗口** ——
 * 别在人还没来得及收编交付时就把树删了。但它对测试残渣是纯浪费:
 * 那些树没有 runs.db 账、没有 continuity、没人会去验收,却因为「刚建出来」被一路豁免,
 * 于是**跑得越勤,积得越多**。今天的分布把这件事量出来了:35/51 无账,其中 29 棵是
 * 最近两小时里长出来的。
 *
 * 所以本工具分两条判据:
 * - **无账**(runs.db 无记录 ∧ 无 continuity 目录)= 测试残渣 → 不受年龄护栏,直接回收;
 * - **有账** = 真 run → 走四类处置 + 全部护栏。
 *
 * ## 四类处置(有账的真 run)
 *
 * | 类 | 判据 | 处置 |
 * |---|---|---|
 * | LIVE | status=running ∨ owner_pid 活着 | **跳过**,一个字节不动 |
 * | 太新 | updated_at < `--min-age-days`(默认 2) | **跳过**(验收窗口) |
 * | DIRTY | 工作树有未提交改动 | **先 salvage**:`git add -A` + commit 到自己分支 → tag `archive/run/<id>` → 删树 |
 * | UNMERGED | 分支有 main 没有的 commit | tag `archive/run/<id>` → 删树删支 |
 * | MERGED+CLEAN | 干净且已并入 main | 删树删支 |
 *
 * **永不静默删**:DIRTY 那一类的内容实测是真源码半成品(engine.ts / verifier.ts /
 * 整个 `src/harness/gates/` 目录),所以它**一定先落成 commit + tag** 才允许删树。
 * tag 留在本地仓里,`git show archive/run/<id>` 随时取回。
 *
 * ## 护栏
 *
 * - `--dry-run`(**默认**):只打印计划,不动任何东西。要真干必须显式 `--apply`。
 * - 幂等:已经不存在的树/分支跳过,重复跑不报错。
 * - `runs.db` 账**不动** —— 回收的是磁盘,不是历史。
 * - 刚建出来的树(`--fresh-minutes`,默认 10)一律跳过:别人可能正在写。
 *
 * 用法:
 *   bun run scripts/runs-gc.ts                 # dry-run,看计划
 *   bun run scripts/runs-gc.ts --apply         # 真干
 *   bun run scripts/runs-gc.ts --apply --min-age-days 5
 */
import { Database } from 'bun:sqlite';
import { execFileSync } from 'node:child_process';
import { existsSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export type GcCategory = 'live' | 'too-fresh' | 'too-young' | 'debris' | 'dirty' | 'unmerged' | 'merged-clean';

export interface GcPlanItem {
  runId: string;
  category: GcCategory;
  /** 该做什么(dry-run 打印这一行)。 */
  action: string;
  dirtyFiles: number;
  aheadCommits: number;
  hasLedgerEntry: boolean;
}

/** git 调用:失败返空串,**不抛** —— 单棵树坏掉不该让整轮回收停下。 */
function git(args: string[], cwd?: string): string {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

export interface SurveyDeps {
  /** run 账查询:返 undefined = 无账。测试注入。 */
  lookupRun: (runId: string) => { status?: string; ownerPid?: number; updatedAt?: number } | undefined;
  /** continuity 目录在不在。 */
  hasContinuity: (runId: string) => boolean;
  /** 该 pid 还活着吗。 */
  pidAlive: (pid: number) => boolean;
  /** 工作树的未提交文件数。 */
  dirtyCount: (dir: string) => number;
  /** 分支相对 main 领先几个 commit。 */
  aheadCount: (dir: string) => number;
  /** 分支是否已并入 main。 */
  isMerged: (runId: string) => boolean;
  /** 目录创建时刻 (ms)。 */
  createdAt: (dir: string) => number;
  now: () => number;
}

export interface GcOptions {
  minAgeDays?: number;
  freshMinutes?: number;
}

/**
 * 纯分类:给一棵树定性 + 说清该做什么。零 IO(全经 deps),所以测试能把五类逐条摆出来。
 *
 * ⚠ 判序不能换:LIVE → 太新 → 无账残渣 → 太年轻 → DIRTY → UNMERGED → 干净。
 * 「无账残渣」必须排在「太年轻」**之前** —— 反过来就是今天这个局面
 * (35 棵残渣全被年龄护栏豁免,越跑越多)。而它必须排在 LIVE / 太新**之后**:
 * 一个刚起跑还没来得及记账的 run,长得就像残渣。
 */
export function classify(runId: string, dir: string, deps: SurveyDeps, opts: GcOptions = {}): GcPlanItem {
  try {
    const minAgeMs = (opts.minAgeDays ?? 2) * 86_400_000;
    const freshMs = (opts.freshMinutes ?? 10) * 60_000;
    const rec = deps.lookupRun(runId);
    const cont = deps.hasContinuity(runId);
    const dirtyFiles = deps.dirtyCount(dir);
    const aheadCommits = deps.aheadCount(dir);
    const hasLedgerEntry = rec !== undefined || cont;
    const base = { runId, dirtyFiles, aheadCommits, hasLedgerEntry };

    if (rec?.status === 'running' || (rec?.ownerPid !== undefined && deps.pidAlive(rec.ownerPid))) {
      return { ...base, category: 'live', action: '跳过 — run 在飞(status=running 或属主活着)' };
    }
    if (deps.now() - deps.createdAt(dir) < freshMs) {
      return { ...base, category: 'too-fresh', action: `跳过 — 树建出来不到 ${opts.freshMinutes ?? 10} 分钟,可能有人正在写` };
    }
    if (!hasLedgerEntry) {
      return { ...base, category: 'debris', action: '删树删支 — 无 runs.db 账且无 continuity = 测试残渣,不是 run' };
    }
    if (rec?.updatedAt !== undefined && deps.now() - rec.updatedAt < minAgeMs) {
      return { ...base, category: 'too-young', action: `跳过 — 终态不足 ${opts.minAgeDays ?? 2} 天,验收窗口内` };
    }
    if (dirtyFiles > 0) {
      return { ...base, category: 'dirty', action: `先 salvage(${dirtyFiles} 个未提交文件 → commit + tag archive/run/${runId})再删树` };
    }
    if (aheadCommits > 0 && !deps.isMerged(runId)) {
      return { ...base, category: 'unmerged', action: `tag archive/run/${runId}(领先 main ${aheadCommits} 个 commit)后删树删支` };
    }
    return { ...base, category: 'merged-clean', action: '删树删支 — 干净且已并入 main' };
  } catch (e) {
    return { runId, category: 'debris', dirtyFiles: 0, aheadCommits: 0, hasLedgerEntry: false, action: 'unknown: ' + (e as Error).message };
  }
}

/** 真源 deps(打真 git / 真 sqlite / 真 fs)。 */
export function realDeps(root: string): SurveyDeps {
  const dbPath = join(root, '.omd', 'runs.db');
  const db = existsSync(dbPath) ? new Database(dbPath, { readonly: true }) : null;
  const mergedSet = new Set(
    git(['branch', '--list', 'omd/run/*', '--merged', 'main', '--format=%(refname:short)'], root).split('\n').filter(Boolean),
  );
  return {
    lookupRun: (runId) => {
      if (!db) return undefined;
      const r = db.query('SELECT status, owner_pid, updated_at FROM omd_runs WHERE run_id = ?').get(runId) as
        | { status?: string; owner_pid?: number; updated_at?: string }
        | null;
      if (!r) return undefined;
      return {
        status: r.status,
        ...(r.owner_pid ? { ownerPid: r.owner_pid } : {}),
        ...(r.updated_at ? { updatedAt: new Date(r.updated_at).getTime() } : {}),
      };
    },
    hasContinuity: (runId) => existsSync(join(root, '.omd', 'continuity', runId)),
    pidAlive: (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false; // ESRCH = 进程没了; EPERM 也当没了 (不是我们的进程, 不该动它的树)
      }
    },
    dirtyCount: (dir) => git(['-C', dir, 'status', '--porcelain']).split('\n').filter(Boolean).length,
    aheadCount: (dir) => Number(git(['-C', dir, 'rev-list', '--count', 'main..HEAD'])) || 0,
    isMerged: (runId) => mergedSet.has(`omd/run/${runId}`),
    createdAt: (dir) => statSync(dir).mtimeMs,
    now: () => Date.now(),
  };
}

/** 扫 `.omd/runs/` 出全部计划项。 */
export function survey(root: string, deps: SurveyDeps, opts: GcOptions = {}): GcPlanItem[] {
  const runsDir = join(root, '.omd', 'runs');
  if (!existsSync(runsDir)) return [];
  return readdirSync(runsDir)
    .filter((n) => existsSync(join(runsDir, n, '.git')))
    .map((runId) => classify(runId, join(runsDir, runId), deps, opts));
}

/** 执行一条计划。**salvage 先于删除**,任何一步失败就停在这一棵上,不往下删。 */
export function apply(root: string, item: GcPlanItem): { ok: boolean; note: string } {
  const dir = join(root, '.omd', 'runs', item.runId);
  const branch = `omd/run/${item.runId}`;
  const tag = `archive/run/${item.runId}`;
  if (item.category === 'live' || item.category === 'too-fresh' || item.category === 'too-young') {
    return { ok: true, note: '跳过' };
  }
  if (item.category === 'dirty') {
    git(['-C', dir, 'add', '-A']);
    const msg = `gc-salvage: run ${item.runId} 的未提交残留 (${item.dirtyFiles} 个文件)\n\n由 scripts/runs-gc.ts 落账。这棵树的 run 已是终态而活没提交完,\n删树前先把内容存成 commit + tag ${tag} —— 永不静默删。`;
    git(['-C', dir, 'commit', '-m', msg]);
    if (Number(git(['-C', dir, 'rev-list', '--count', 'main..HEAD'])) === 0) {
      return { ok: false, note: 'salvage 后仍无领先 commit —— 提交没成,停手不删' };
    }
  }
  if (item.category === 'dirty' || item.category === 'unmerged') {
    // ⚠ **不许 `tag -f`**。归档 tag 是这棵树被删之后唯一的取回口, 覆盖它 = 静默销毁前一份归档,
    //   而且事后无从证明有没有覆盖过 (tag 没有 reflog)。同名已存在时:
    //   指向同一个 commit → 幂等, 放行; 指向别的 commit → **停手不删**, 升 owner。
    //   (本工具第一版写的就是 `tag -f`, 首次真跑后才发现这是个能静默吃掉归档的口子。)
    const want = git(['-C', root, 'rev-parse', branch]);
    const existing = git(['-C', root, 'rev-parse', '--verify', `refs/tags/${tag}`]);
    if (existing !== '' && existing !== want) {
      return { ok: false, note: `归档 tag ${tag} 已存在且指向别的 commit (${existing.slice(0, 8)} ≠ ${want.slice(0, 8)}) —— 停手不删, 请人裁` };
    }
    if (existing === '') {
      git(['-C', root, 'tag', tag, branch]);
      if (git(['-C', root, 'rev-parse', '--verify', `refs/tags/${tag}`]) === '') {
        return { ok: false, note: 'tag 没打上 —— 停手不删' };
      }
    }
  }
  git(['-C', root, 'worktree', 'remove', dir, '--force']);
  git(['-C', root, 'branch', '-D', branch]);
  return { ok: true, note: item.category === 'dirty' || item.category === 'unmerged' ? `已存 ${tag}` : '已删' };
}

if (import.meta.main) {
  const argv = Bun.argv.slice(2);
  const flag = (n: string): string | undefined => {
    const i = argv.indexOf(`--${n}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const root = flag('cwd') ?? process.cwd();
  const doApply = argv.includes('--apply');
  const opts: GcOptions = {
    ...(flag('min-age-days') ? { minAgeDays: Number(flag('min-age-days')) } : {}),
    ...(flag('fresh-minutes') ? { freshMinutes: Number(flag('fresh-minutes')) } : {}),
  };
  const plan = survey(root, realDeps(root), opts);
  const byCat = new Map<GcCategory, GcPlanItem[]>();
  for (const p of plan) byCat.set(p.category, [...(byCat.get(p.category) ?? []), p]);

  console.log(`runs-gc ${doApply ? '(APPLY — 真干)' : '(dry-run — 不动任何东西, 加 --apply 才真干)'}  root=${root}`);
  console.log(`共 ${plan.length} 棵\n`);
  const order: GcCategory[] = ['live', 'too-fresh', 'too-young', 'debris', 'dirty', 'unmerged', 'merged-clean'];
  for (const cat of order) {
    const items = byCat.get(cat) ?? [];
    if (items.length === 0) continue;
    console.log(`── ${cat}: ${items.length} 棵 — ${items[0]!.action.replace(/archive\/run\/[0-9a-f-]+/, 'archive/run/<id>')}`);
    for (const it of items) console.log(`     ${it.runId.slice(0, 8)}  dirty=${it.dirtyFiles} ahead=${it.aheadCommits} 有账=${it.hasLedgerEntry}`);
  }
  if (!doApply) {
    console.log('\n(dry-run 结束。要真干: 加 --apply)');
    process.exit(0);
  }
  console.log('\n── 执行 ──');
  let done = 0;
  let failed = 0;
  for (const it of plan) {
    const r = apply(root, it);
    if (it.category === 'live' || it.category === 'too-fresh' || it.category === 'too-young') continue;
    console.log(`  ${it.runId.slice(0, 8)} [${it.category}] ${r.ok ? '✓' : '✗'} ${r.note}`);
    if (r.ok) done++;
    else failed++;
  }
  console.log(`\n回收 ${done} 棵${failed ? `, ${failed} 棵停手(见上)` : ''}。runs.db 账未动。`);
}
