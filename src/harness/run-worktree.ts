/**
 * **run 级 branch strategy** (2026-07-31, R2 · 承 D-Y① sandcastle + D-AB 可逆性分级 + §7.2)。
 *
 * ## 它填的是哪个洞
 *
 * D-AB 把自主度按「做错了的代价和可逆性」分了四级, 其中「范围内写」那一级的理由是
 * **git 就是 rollback**。但那句话今天在 omd 里是**假的**: agent leaf 直接写 cwd, detached worker
 * 也直接写 cwd —— `scope` 有声明面, **执行面没有对应物**。写坏了没有"这次跑的东西"这个对象,
 * 也就无从回滚。Automation Readiness 第 6 条记的 🟡 说的就是它。
 *
 * §7.2 的形状是现成的: git worktree 让每个执行体有自己的工作目录, **同时共享同一份提交历史**。
 * 本仓也已经有一处实现(pathfinder 的 prototype 票, `dispatch.ts`)—— 所以这里不造第二套机制,
 * 造的是**把它抬到 run 级**的那一层。
 *
 * ## 三态里我们只做两态, 第三态刻意不做
 *
 * sandcastle 的 branch strategy 是 `head` / `merge-to-head` / `branch`。
 *
 * | 态 | 语义 | 我们 |
 * |---|---|---|
 * | `head` | 直接写当前工作树 | ✅ 缺省(**零回归**: 不传就是今天的行为) |
 * | `branch` | 隔离 worktree + 独立分支, 产出留在那儿 | ✅ 本次做 |
 * | `merge-to-head` | 跑完自动合回主树 | ❌ **刻意不做** |
 *
 * **为什么不做 `merge-to-head`**: 自动合回主树是一次**写主干**, 按 D-AB 的可逆性分级那是
 * "需批准"那一档, 不是"范围内写"。而且它与本仓已定的一条纪律同形 —— `path_deliver` 把
 * "裁决"与"重跑"拆成两个决定, 回话给命令由 owner 扣扳机。自动合回等于替 owner 扣了扳机,
 * 而这正是隔离想避免的那件事。合不合、什么时候合, 留给 owner 一条 `git merge`。
 *
 * ## 诚实边界
 *
 * - **不在 git 仓里 → 退回 `head` 并响亮说明**, 不抛。goal 引擎跑在别人的目录里是正常用法,
 *   为了隔离而拒绝跑起来是本末倒置。
 * - **worktree 默认不自动清理**。试验的意义是可弃, 但"可弃"≠"替你弃了" —— 跑完那棵树里就是
 *   这次的全部产出, 自动删掉等于把交付物一起删了。回话里给出目录与分支, 弃用走 `dispose()`。
 * - **未提交的改动不会被带进 worktree**。`git worktree add` 出来的是**该 ref 的干净 checkout**;
 *   主树上没提交的东西在那边看不见。这是隔离的定义, 但用的人容易惊讶, 所以写在这里。
 */
import { existsSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from './logger';
import { captureRollbackAnchor, type RollbackAnchor } from './rollback-anchor';

export type BranchStrategy = 'head' | 'branch';

export interface RunWorktree {
  /** 执行体该用的工作目录(`head` 档 = 原 cwd)。 */
  cwd: string;
  /** 隔离档才有: 分支名。 */
  branch?: string;
  /** 实际生效的策略 —— **可能与请求的不同**(不在 git 仓里会退回 `head`)。 */
  strategy: BranchStrategy;
  /** 退回 `head` 的原因(生效即请求时为 undefined)。 */
  degradedReason?: string;
  /**
   * **起跑时主树上有未提交的东西**(2026-08-06)—— 隔离档才有,且**必须念进回话**。
   *
   * `git worktree add` 出来的是**该 ref 的干净 checkout**:主树上没提交的改动在那边**看不见**。
   * 头注早就写了这条边界,可它只写在头注里 —— **调用它的 owner 在回话里一个字都看不到**。
   * 于是「带着未提交的活起一次隔离跑」会**静默**地从 HEAD 开始:agent 看不见你刚写的东西,
   * 可能把它重做一遍、或者基于旧版本给出结论,而回话只说"隔离成功"。
   *
   * ⚠ **fail-open,不拒**:隔离是加固不是前置条件(同 `degradedReason` 那条)。这一位只保证
   *   下次看得见 —— 但它必须进 `describeRunWorktree`,否则和写在头注里没有区别。
   */
  uncommittedWarning?: string;
  /** 弃用这棵树(`head` 档 = 空操作)。**不自动调**,见头注。 */
  dispose: () => void;
}

export interface RunWorktreeDeps {
  /** 跑一条 git 命令; 非零退出即抛。默认 `Bun.spawnSync('git', …)`。 */
  git?: (args: string[], opts: { cwd: string }) => void;
  /** 判断某目录是不是 git 工作树。默认查 `.git` 是否存在。 */
  isGitRepo?: (cwd: string) => boolean;
  /** 查主树上有没有未提交的东西(见 `RunWorktree.uncommittedWarning`)。默认 `captureRollbackAnchor`。 */
  checkTree?: (cwd: string) => RollbackAnchor;
  /** #166: worktree 内链入主树 node_modules。默认 `ensureNodeModulesLink`(测试注入面)。 */
  ensureLink?: typeof ensureNodeModulesLink;
}

/** 默认 git: 非零退出即抛(建/删 worktree 失败必须显性, 悄悄退回 head 会让隔离静默失效)。 */
function defaultGit(args: string[], opts: { cwd: string }): void {
  const r = Bun.spawnSync(['git', ...args], { cwd: opts.cwd, stdout: 'pipe', stderr: 'pipe' });
  if (r.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} 失败 (exit ${r.exitCode}): ${new TextDecoder().decode(r.stderr).trim()}`);
  }
}

/**
 * `.git` 存在即当 git 工作树。**不用 `git rev-parse`** —— 那要起一个进程, 而这个判断在
 * 每次 goal 起跑时都要做一遍; 而且 worktree 里的 `.git` 是个文件不是目录, `existsSync` 两者都认。
 */
const defaultIsGitRepo = (cwd: string): boolean => existsSync(join(cwd, '.git'));

/** 这次 run 的隔离目录 —— 与 pathfinder 的 `proto/` 平行, 各占各的前缀。 */
export const runWorktreeDir = (cwd: string, runId: string): string => join(cwd, '.omd', 'runs', safe(runId));
/** 这次 run 的分支名。`omd/run/` 前缀让它在 `git branch` 里一眼可辨、也好批量清。 */
export const runWorktreeBranch = (runId: string): string => `omd/run/${safe(runId)}`;

const safe = (s: string): string => s.replace(/[^\w.-]/g, '_');

/**
 * #166 (2026-08-17): worktree 内链入主树 node_modules。
 *
 * `git worktree add` 出来的是干净 checkout —— 没有 node_modules。bun 的模块解析能沿父目录
 * 走到主树那份 (worktree 在主仓 `.omd/runs/` 之内), 但**显式路径读包文件的测试走不了解析**
 * (实测 run 5fd13a78: pi-event-coverage 用 `readFileSync(join(REPO_ROOT, 'node_modules/…'))`
 * → ENOENT 3 红, 冻结判据带全量环在 branch 档结构性永不可绿)。symlink 是 monorepo 惯例解:
 * 零安装成本, `worktree remove --force` 时随树删 (删的是链接不是真身)。
 * fail-open: 主树没有 node_modules / 树内已有 / 链接失败 → 各自跳过, 隔离照常成立 ——
 * 链接是加固不是前置条件, 但每格都留证据 (返回值进日志)。
 */
export function ensureNodeModulesLink(
  mainRoot: string,
  worktreeDir: string,
  link: (target: string, path: string) => void = (t, p) => symlinkSync(t, p, 'dir'),
): 'linked' | 'no-source' | 'already-present' | `link-failed: ${string}` {
  const source = join(mainRoot, 'node_modules');
  const dest = join(worktreeDir, 'node_modules');
  if (!existsSync(source)) return 'no-source';
  if (existsSync(dest)) return 'already-present';
  try {
    link(source, dest);
    return 'linked';
  } catch (e) {
    return `link-failed: ${(e as Error).message.slice(0, 200)}`;
  }
}

/**
 * 按策略给这次 run 准备工作目录。
 *
 * @param strategy 缺省 `head` —— **不传就是今天的行为**, 零回归。
 */
export function prepareRunWorktree(
  opts: { cwd: string; runId: string; strategy?: BranchStrategy },
  deps: RunWorktreeDeps = {},
): RunWorktree {
  const { cwd, runId } = opts;
  const strategy = opts.strategy ?? 'head';
  const noop = { cwd, strategy: 'head' as const, dispose: () => {} };
  if (strategy === 'head') return noop;

  const isGitRepo = deps.isGitRepo ?? defaultIsGitRepo;
  if (!isGitRepo(cwd)) {
    const why = `${cwd} 不是 git 工作树 → branch 策略退回 head (隔离不成立, 但活照跑)`;
    logger.warn({ cwd, runId }, `[omd/run-worktree] ${why}`);
    return { ...noop, degradedReason: why };
  }

  const git = deps.git ?? defaultGit;
  const dir = runWorktreeDir(cwd, runId);
  const branch = runWorktreeBranch(runId);
  // resume 复用 (2026-08-14, dag_run 接隔离档时补): 同 runId 的树已在 → 原样接着用。
  // 不复用的话 `worktree add` 会失败 → 走下面的退回 head —— 那是**静默换树**: 首跑写在
  // 隔离树里, resume 却写主树, 比不隔离更坏 (checkpoint 与半成品全在那棵树上)。
  if (existsSync(dir)) {
    logger.info({ runId, dir, branch }, '[omd/run-worktree] 隔离 worktree 已存在 → 复用 (resume)');
    // #166: 老树 (本修复前建的) 可能缺链 —— resume 路也补, 幂等 (already-present 即跳过)。
    const relink = (deps.ensureLink ?? ensureNodeModulesLink)(cwd, dir);
    if (relink !== 'already-present') logger.info({ runId, dir, relink }, '[omd/run-worktree] #166 node_modules 链入 (resume 复用路)');
    return {
      cwd: dir,
      branch,
      strategy: 'branch',
      dispose: () => {
        try {
          git(['worktree', 'remove', '--force', dir], { cwd });
        } catch (e) {
          logger.warn({ dir, err: String(e) }, '[omd/run-worktree] 弃用 worktree 失败 (fail-open)');
        }
      },
    };
  }
  try {
    git(['worktree', 'add', dir, '-b', branch], { cwd });
  } catch (e) {
    // **建不起来就退回 head 并说清楚**, 不抛: 隔离是加固不是前置条件, 为它把一次跑整个拒掉
    // 是拿可用性换一个本来就是"更好"而非"必须"的性质。⚠ 但必须响亮 —— 静默退回 head 会让
    // 调用方以为写在隔离树里, 而实际上写的是主树, 那比不隔离坏得多。
    const why = `建 worktree 失败 → 退回 head: ${(e as Error).message}`;
    logger.warn({ cwd, runId, dir, branch }, `[omd/run-worktree] ${why}`);
    return { ...noop, degradedReason: why };
  }
  // **未提交的活在隔离树里看不见** —— 头注写了这条边界, 但只写在头注里。这里把它变成
  // 回话里的一句话 (2026-08-06): 带着未提交改动起隔离跑, agent 看到的是 HEAD 那一版,
  // 而回话此前只说"隔离成功"。fail-open, 不拒。
  // #166: 干净 checkout 缺 node_modules → 显式路径读包的测试结构性红 (run 5fd13a78)。链入主树那份。
  const linked = (deps.ensureLink ?? ensureNodeModulesLink)(cwd, dir);
  if (linked.startsWith('link-failed')) logger.warn({ runId, dir, linked }, '[omd/run-worktree] #166 node_modules 链入失败 (fail-open, 树内测试可能环境性红)');
  else logger.info({ runId, dir, linked }, '[omd/run-worktree] #166 node_modules 链入');
  const anchor = (deps.checkTree ?? ((c: string) => captureRollbackAnchor({ cwd: c })))(cwd);
  const dirty = (anchor.dirtyTracked ?? 0) + (anchor.untracked ?? 0);
  const uncommittedWarning =
    anchor.kind === 'dirty-tracked' || anchor.kind === 'dirty-untracked'
      ? `⚠ 主树上有 ${dirty} 处未提交的东西, 而隔离 worktree 是 **HEAD 那一版的干净 checkout** —— ` +
        '它们在这次跑里**看不见**。agent 可能把你刚写的活重做一遍, 或基于旧版本下结论。' +
        '要让它看见: 先 `git commit` (或 `git stash` 后在隔离树里 `git stash apply`)。'
      : undefined;
  if (uncommittedWarning) logger.warn({ runId, dir, branch, dirty }, `[omd/run-worktree] ${uncommittedWarning}`);

  logger.info({ runId, dir, branch }, '[omd/run-worktree] 本次 run 落在隔离 worktree (R2 · D-Y①)');
  return {
    cwd: dir,
    branch,
    strategy: 'branch',
    ...(uncommittedWarning ? { uncommittedWarning } : {}),
    dispose: () => {
      try {
        git(['worktree', 'remove', '--force', dir], { cwd });
      } catch (e) {
        logger.warn({ dir, err: String(e) }, '[omd/run-worktree] 弃用 worktree 失败 (fail-open)');
      }
    },
  };
}

// ── #165② (2026-08-17): 冻结判据绿 → worktree 内自动收编 commit ──────────────────

/**
 * **要不要自动 commit** 的唯一判据 (#165②, 纯函数)。
 * 三条全真才放行: 隔离档 (head 档写的是主树, 自动 commit 主树是替 owner 扣扳机, 不做) ∧
 * 判据可执行 (非可执行的 oracle 恒 true, 那不是机器绿) ∧ 终态 = success 或 delivered-with-red
 * (#165①: 判据复验绿)。**判据红时不许 commit** —— 反向自检见 run-worktree.test。
 */
export function shouldAutoCommit(
  run: { acceptanceKind: string; outcome: string },
  strategy: BranchStrategy,
): boolean {
  return (
    strategy === 'branch' &&
    run.acceptanceKind === 'executable' &&
    (run.outcome === 'success' || run.outcome === 'delivered-with-red')
  );
}

export interface CommitRunArtifactsResult {
  committed: boolean;
  /** commit 成功时的短 sha。 */
  sha?: string;
  /** 人话: 干净树 / 失败原因 / 成功摘要。**永不抛** —— 收编是增益, 不许把已终态的 run 带塌。 */
  detail: string;
}

/**
 * 在隔离 worktree 内把本次 run 的改动收进一个 commit (留 run 锚, 人只审不搬)。
 *
 * **`git add -A` 而不是按声明写集挑拣**: 隔离树单跑独占, 树内一切改动就是本 run 的写集真身;
 * 按 write_set 声明面挑会静默丢产物 (声明缺席的 plan 不在少数, D-2 那条只是对账不是全集)。
 * 垃圾临时件跟着进 commit 是**可见的** (git show 即审), 丢产物是不可见的 —— 两害取可见的。
 */
export function commitRunArtifacts(
  opts: { cwd: string; runId: string; message: string },
  deps: { gitOut?: (args: string[], opts: { cwd: string }) => string } = {},
): CommitRunArtifactsResult {
  const gitOut =
    deps.gitOut ??
    ((args: string[], o: { cwd: string }): string => {
      const r = Bun.spawnSync(['git', ...args], { cwd: o.cwd, stdout: 'pipe', stderr: 'pipe' });
      if (r.exitCode !== 0) {
        throw new Error(`git ${args.join(' ')} 失败 (exit ${r.exitCode}): ${new TextDecoder().decode(r.stderr).trim()}`);
      }
      return new TextDecoder().decode(r.stdout).trim();
    });
  try {
    if (gitOut(['status', '--porcelain'], { cwd: opts.cwd }) === '') {
      return { committed: false, detail: '工作树干净, 无可收编改动 (产物可能已在既有 commit 里)' };
    }
    gitOut(['add', '-A'], { cwd: opts.cwd });
    gitOut(['commit', '-m', opts.message], { cwd: opts.cwd });
    const sha = gitOut(['rev-parse', '--short', 'HEAD'], { cwd: opts.cwd });
    return { committed: true, sha, detail: `已收编 commit ${sha} (run ${opts.runId})` };
  } catch (err) {
    // fail-open 吞异常不吞证据: run 已终态, 收编失败只能响亮说, 不能抛。
    return { committed: false, detail: `自动收编失败: ${String(err).slice(0, 300)}` };
  }
}

/**
 * 给回话用的一段人话。**隔离档必须把目录与分支念出来** —— 否则 owner 拿不到那次产出的把手,
 * "隔离"就退化成"东西不见了"。
 */
export function describeRunWorktree(w: RunWorktree): string {
  if (w.strategy === 'head') {
    return w.degradedReason ? `工作目录: 当前工作树 (${w.degradedReason})` : '工作目录: 当前工作树 (head)';
  }
  return [
    `工作目录: **隔离 worktree** ${w.cwd}`,
    `分支: ${w.branch}`,
    // 这一行**必须在合回/弃用之前**: 它说的是"这次跑看见的世界不是你以为的那个",
    // 排在操作命令后面等于让人先动手再发现前提不对。
    ...(w.uncommittedWarning ? [w.uncommittedWarning] : []),
    `合回主树由你扣扳机(引擎刻意不自动合): \`git merge ${w.branch}\``,
    `不要了: \`git worktree remove --force ${w.cwd} && git branch -D ${w.branch}\``,
  ].join('\n');
}
