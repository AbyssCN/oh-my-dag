#!/usr/bin/env bun
/**
 * scripts/staged-collision-check —— 「暂存区里有没有别人正在写的文件」(T-4,2026-08-28)。
 *
 * ## 它治的病
 *
 * 同树多窗口作业时 `git add -u` / `-A` 会把**另一个窗口在途的改动**一起暂存。
 * 2026-08-27/28 发生两次:`88186276` 扫走 conductor S3 片 3 的全部产物,
 * `944f51db` 扫走 F2 片 4 的实装 101 行。第二次更糟 —— `-u` 只暂存**已跟踪文件的修改**,
 * 于是实装(已跟踪)进了 HEAD 而证明它的新测试(未跟踪)留在盘上,造出
 * 「实装在库里、断言不在」的中间态。后果不只是 message 不准:commit 历史从此有两条
 * 内容与描述不符,以后谁按 message 找改动都会找错地方。
 *
 * 原票写的是「这条做不成闸(git 层面拦不住),属于纪律」。**那句话是错的** ——
 * git 层面确实拦不住,但这仓本来就有一本**碰撞台账**(`harness/writeset/touch-ledger`,
 * 每次 Write/Edit 经 PostToolUse hook 记 `abs_path × session × op`)。
 * 判据不该是「我碰没碰过这个文件」(我用 heredoc 改的文件根本不进台账,假阳性会淹掉它),
 * 而是**「这个文件最近被几个 session 写过」** —— 那正是「扫走在途改动」的精确形状。
 *
 * ## 三种空,不许压平(仓规坑 ①)
 *
 * · 台账**打不开** → 闸缺席(fail-open),留一行证据;
 * · 台账开着但 `rows === 0` → **这本库这段时间一条都没记**,该去查接线,
 *   **不许读成「零碰撞」**(这条分辨由 `stats()` 的文件头钉过);
 * · 台账活着且交集为空 → 真的没撞。
 *
 * ## 用法
 *
 *     bun run scripts/staged-collision-check.ts     # 暂存之后、commit 之前跑
 *
 * 命中 → 退出码 1 并逐条列出。
 *
 * ⚠ **命中 ≠ 你错了**:它按**文件**判,不按 hunk 判。同一个文件里你的改动与别人的改动
 * 并存是常态 —— 它要的是**你去看一眼那个 diff**,不是替你拆。首次真用就是这么走的:
 * 报了 `engine.ts`,去看,169 行插入里只有 37 行是我的,其余是隔壁窗口在途的活,
 * 于是按 hunk 拆开只暂存自己那 6 个。没有这一声,那 132 行就跟着我的 commit 进库了。
 *
 * ⚠ **它还没接进任何 hook**:接不接进 commit 流程会改变 owner 的提交手感,
 * 那是 owner 的决定,不是这个脚本自己该做的。
 *
 * @module
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Database } from 'bun:sqlite';
import { stats } from '../src/harness/writeset/touch-ledger';

/**
 * 默认时间窗。**这个数是本检查成不成立的全部** —— 2026-08-28 第一次 dogfood 当场证明:
 * 不带窗地问「这个文件被几个 session 写过」,`engine.ts` 答 **20**、`run-goal.ts` 答 12,
 * 因为台账按 TTL 累积、热文件历史上人人都写过。那样的判据在真树上恒真 = 一条恒报警的闸,
 * 而恒报警的闸会被人关掉,和没有闸是一回事。
 *
 * T-4 要抓的是**此刻在途**:另一个窗口正开着、正在写同一个文件。所以判据必须是
 * 「**最近这段时间内**有别的 session 写过」。2 小时 = 一个窗口连续作业的量级。
 */
const DEFAULT_WINDOW_MIN = 120;

/**
 * 时间窗内「被 ≥2 个 session 写过」的路径。
 *
 * ⚠ 与 `touch-ledger.findings()` **刻意不共用**:那个函数按全表聚合,回答的是
 * 「这个文件历史上有没有过多人写」——那是另一个问题,拿它当在途判据就是上面那条实账。
 */
export function recentWriteCollisions(
  db: Database,
  sinceTs: number,
): Array<{ absPath: string; writeSessions: number; lastTs: number }> {
  return db
    .query(
      `SELECT abs_path AS absPath,
              count(DISTINCT session) AS writeSessions,
              max(ts) AS lastTs
       FROM touches
       WHERE op = 'write' AND ts >= ?
       GROUP BY abs_path
       HAVING count(DISTINCT session) >= 2`,
    )
    .all(sinceTs) as Array<{ absPath: string; writeSessions: number; lastTs: number }>;
}

export interface Collision {
  /** repo 相对路径(暂存区那一侧的写法)。 */
  readonly path: string;
  /** 写过它的 session 数(≥2 才是碰撞)。 */
  readonly writeSessions: number;
  /** 最近一次触碰(ms epoch)。 */
  readonly lastTs: number;
}

/**
 * 暂存集 ∩ 台账里「被 ≥2 个 session 写过」的路径。**纯函数**(两侧都是入参)。
 *
 * 台账存的是绝对路径,暂存区给的是相对路径 —— 归一到绝对再比,
 * 别拿 `endsWith` 之类凑合(`a/x.ts` 会撞上 `b/a/x.ts`)。
 */
export function collide(
  stagedRel: readonly string[],
  ledger: readonly { absPath: string; writeSessions: number; lastTs: number }[],
  repoRoot: string,
): Collision[] {
  const byAbs = new Map(ledger.filter((f) => f.writeSessions >= 2).map((f) => [resolve(f.absPath), f]));
  const out: Collision[] = [];
  for (const rel of stagedRel) {
    const hit = byAbs.get(resolve(repoRoot, rel));
    if (hit) out.push({ path: rel, writeSessions: hit.writeSessions, lastTs: hit.lastTs });
  }
  return out;
}

/** `git diff --cached --name-only`。空 = 暂存区是空的(不是「查不到」)。 */
export function stagedFiles(repoRoot: string): string[] {
  const out = execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: repoRoot, encoding: 'utf8' });
  return out.split('\n').map((s) => s.trim()).filter(Boolean);
}

if (import.meta.main) {
  const repoRoot = process.cwd();
  const dbPath = join(repoRoot, '.omd', 'touch.db');
  if (!existsSync(dbPath)) {
    // fail-open 可以吞异常, 不许吞证据。
    console.error(`[staged-collision] 台账不在 (${dbPath}) → 闸缺席, 不拦。`);
    process.exit(0);
  }
  const db = new Database(dbPath, { readonly: true });
  const s = stats(db);
  if (s.rows === 0) {
    // ⚠ 这不是「零碰撞」。空库与「库没接上」在结果上长得一模一样, 分辨靠的就是这个数。
    console.error('[staged-collision] 台账里一条活行都没有 → 这本库这段时间没在记, 该查接线, 别读成「没撞」。');
    process.exit(0);
  }
  const staged = stagedFiles(repoRoot);
  if (staged.length === 0) {
    console.log('暂存区是空的 —— 没有要查的。');
    process.exit(0);
  }
  const argWin = /^--within-minutes=(\d+)$/.exec(process.argv[2] ?? '');
  const windowMin = argWin ? Number(argWin[1]) : DEFAULT_WINDOW_MIN;
  const sinceTs = Date.now() - windowMin * 60_000;
  const hits = collide(staged, recentWriteCollisions(db, sinceTs), repoRoot);
  if (hits.length === 0) {
    console.log(`暂存 ${staged.length} 个文件, 台账 ${s.rows} 行, 窗口 ${windowMin} 分钟 —— 没有别的 session 在写。`);
    process.exit(0);
  }
  console.error(`⚠ 暂存区里有 ${hits.length} 个文件在**最近 ${windowMin} 分钟内被多个 session 写过** —— 很可能扫到了别人在途的活:\n`);
  for (const h of hits) {
    console.error(`  ${h.path}  (窗口内 ${h.writeSessions} 个 session 写过, 最近 ${new Date(h.lastTs).toISOString()})`);
  }
  console.error(`\n改法: \`git restore --staged <那些文件>\`, 然后 \`git add <你自己的具体文件>\` —— 别用 -u / -A。`);
  process.exit(1);
}
