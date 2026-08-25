/**
 * src/harness/rollback-anchor —— **这次跑坏了,回得去吗**(D1, 2026-08-06)。
 *
 * ## 它填的是哪个洞
 *
 * D-AB 把自主度按可逆性分级,「范围内写」那一级的理由是**git 就是 rollback**。
 * `run-worktree.ts` 的头注已经指出那句话在 omd 里是假的 —— 而它给的解法(隔离 worktree +
 * 独立分支)当时**默认关着,而且只挂在 `dag_goal` 一个入口上**。
 *
 * 2026-08-06 量了一次:`git worktree list` 里**一个 `omd/run/*` 都没有**,
 * `git branch --list 'omd/run/*'` **0 条** —— 隔离档当时**一次都没有被用过**。
 * (那是 S-3「机制写好了但默认关着 / 只挂在一条路上」的又一个实例,这次有读数。)
 * 于是那时的真实情况是:**几乎所有跑都落在 `head` 档,直接写当前工作树**。
 *
 * ⚠ **上面那段是 2026-08-06 的读数,#253 之后已经不成立** —— 别照它下今天的结论。
 * 2026-08-25 起 MCP 两个写型入口(`run` / `solve`)**默认落隔离 worktree**,`head` 变显式
 * opt-in(`assemble.ts` 注入 `defaultBranchStrategy`;`OMD_RUN_BRANCH_DEFAULT=0` 退回)。
 *
 * **但本模块的价值没有跟着缩水,反而换了个方向长**:
 *   · `head` 档没有消失,只是从默认变成 opt-in —— 那一档上四态判定逐字适用;
 *   · **人**始终在主树上写,而这四态量的正是主树;
 *   · 隔离档下 `prepareRunWorktree` 用它算主树脏度,生成「隔离树是 HEAD 的干净 checkout,
 *     你未提交的活在这次跑里看不见」那条告知 —— 默认翻过来之后这条**更常出现**,不是更少。
 * 所以下面这张四态表是活的,读它时把上面那段历史读数当**来历**,不是当现状。
 *
 * ## 四态,下一步互不相同(缺席 ≠ 干净 ≠ 脏 ≠ 查不了)
 *
 * | 态 | 意思 | 跑坏了怎么办 |
 * |---|---|---|
 * | `clean` | 跑之前已跟踪与未跟踪都干净 | **git 真的就是 rollback**:`git checkout -- . && git clean -fd` 完整还原 |
 * | `dirty-tracked` | 已有未提交的**已跟踪**改动 | **没有回滚对象**:这次跑的写与你的改动混在同一片 diff 里,分不开 |
 * | `dirty-untracked` | 已跟踪干净,但盘上有未跟踪文件 | 半个:`git checkout -- .` 能还原已跟踪的;`git clean -fd` **会连你原有的未跟踪文件一起删** |
 * | `not-a-repo` | 压根不在 git 仓里 | git 这条路不存在,而 `branchStrategy: 'branch'` 在这里也会退回 `head` |
 * | `unknown` | git 起不来 / 查失败 | **什么都别断言**。它不是"干净",也不是"脏" |
 *
 * ⚠ **未跟踪文件为什么算风险**:一个**跑之前就存在**的未跟踪文件(本仓那个 `f2-checklist.ts`
 * 就是),会被 `git clean -fd` 一起删掉 —— 那种"回滚"是破坏不是还原。所以它单独成一态,
 * 而不是并进 `clean`。
 *
 * ## 只报不拦
 *
 * 这里**不阻止任何一次跑**。出口是结果面 + 账本 + 读数板:让 owner 在动手之前知道
 * 「这次要是跑坏了,我有没有一条回得去的路」。要不要把「脏树不许起跑」升成闸,
 * 是单独的拨闸决定。
 *
 * **那个数今天有了**(2026-08-25 实测 `.omd/dag-runs.db` 的 `omd_dag_runs.rollback` 列;
 * 该列由 `dag-record.ts` 落,写在这条注释之后):604 行 run 里 **546 行带锚**,分布 ——
 * `dirty-tracked` 415 · `dirty-untracked` 80 · `clean` 49 · `not-a-repo` 2。
 * 即**九成的跑是从脏树起跑的**:没有回滚对象,或只有半个。
 * ⚠ 余下 58 行**是缺席不是干净**(本机制接线前的老 run)—— NULL≠0,别把它们并进任何一态。
 * 这个分布正是 #253 把默认翻成隔离档的实测依据之一。
 */
import { logger } from '../logger';

export type RollbackAnchorKind = 'clean' | 'dirty-tracked' | 'dirty-untracked' | 'not-a-repo' | 'unknown';

export interface RollbackAnchor {
  kind: RollbackAnchorKind;
  /** 起跑时的 HEAD(短 sha)。`not-a-repo` / `unknown` 时缺席。 */
  head?: string;
  /** 起跑时已有未提交改动的**已跟踪**文件数。`clean` 时为 0;查不了时缺席。 */
  dirtyTracked?: number;
  /** 起跑时盘上的**未跟踪**文件数(`git clean -fd` 会删掉它们)。 */
  untracked?: number;
  /** `unknown` / `not-a-repo` 的成因原话 —— **不吞证据**。 */
  why?: string;
}

/** 一行 `git status --porcelain` → 它算哪一类。 */
function classifyStatusLine(line: string): 'tracked' | 'untracked' | null {
  if (!line.trim()) return null;
  // porcelain v1: 前两位是 XY 状态码。`??` = 未跟踪, `!!` = 被忽略(不算 —— 它本来就不进 git)。
  const xy = line.slice(0, 2);
  if (xy === '!!') return null;
  return xy === '??' ? 'untracked' : 'tracked';
}

/**
 * `git status --porcelain` 的输出 + HEAD → 四态判定(**纯函数**,不碰 IO)。
 *
 * 抽成纯函数是为了让四态各自有用例钉着 —— 这一段的全部价值就在于四态不许被压平,
 * 而压平最容易发生在"顺手 `?? 'clean'`"上。
 */
export function classifyRollbackAnchor(input: { head: string; statusOutput: string }): RollbackAnchor {
  let dirtyTracked = 0;
  let untracked = 0;
  for (const line of input.statusOutput.split('\n')) {
    const k = classifyStatusLine(line);
    if (k === 'tracked') dirtyTracked++;
    else if (k === 'untracked') untracked++;
  }
  // 顺序**要紧**: 已跟踪的脏比未跟踪的更糟(它让 diff 混在一起), 所以它赢。
  const kind: RollbackAnchorKind =
    dirtyTracked > 0 ? 'dirty-tracked' : untracked > 0 ? 'dirty-untracked' : 'clean';
  return { kind, head: input.head, dirtyTracked, untracked };
}

/**
 * 给 owner 看的一段人话 —— **每一态都要给得出"跑坏了敲哪条命令"**。
 *
 * 判词写在这里而不是散在调用点: 四态的下一步互不相同, 而"下一步"正是这一位存在的理由
 * (读数板 S-20 那条教训: 一个数取某值时读的人要能反推出唯一一个下一步)。
 */
export function describeRollback(a: RollbackAnchor): string {
  switch (a.kind) {
    case 'clean':
      return `回滚: **有**。起跑时工作树干净 (HEAD ${a.head}) → 跑坏了 \`git checkout -- . && git clean -fd\` 完整还原。`;
    case 'dirty-tracked':
      return (
        `回滚: **没有**。起跑时已有 ${a.dirtyTracked} 个已跟踪文件带未提交改动 (HEAD ${a.head}) —— ` +
        '这次跑的写会和你的改动混在同一片 diff 里, git 分不开。' +
        '想要回滚对象: 先 `git commit` 或 `git stash`, 或者用 `branchStrategy: "branch"` 起隔离树。'
      );
    case 'dirty-untracked':
      return (
        `回滚: **半个**。已跟踪的干净 (HEAD ${a.head}), 但盘上有 ${a.untracked} 个未跟踪文件 —— ` +
        '`git checkout -- .` 能还原已跟踪的那部分; ' +
        '⚠ **别直接 `git clean -fd`**, 它会把你原有的未跟踪文件一起删掉 (那是破坏不是还原)。'
      );
    case 'not-a-repo':
      return `回滚: **没有**。这里不是 git 工作树 (${a.why ?? '未说明'}) —— \`branchStrategy: "branch"\` 在这里也会退回 head。`;
    case 'unknown':
      return `回滚: **不知道**。查起跑时的 git 状态没成功 (${a.why ?? '未说明'}) —— 这既不是"干净"也不是"脏", 别据它下判断。`;
  }
}

export interface RollbackAnchorDeps {
  /** 跑一条 git 命令取 stdout;非零退出即抛。默认 `Bun.spawnSync`。 */
  git?: (args: string[], opts: { cwd: string }) => string;
}

function defaultGit(args: string[], opts: { cwd: string }): string {
  const r = Bun.spawnSync(['git', ...args], { cwd: opts.cwd, stdout: 'pipe', stderr: 'pipe' });
  if (r.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} 失败 (exit ${r.exitCode}): ${new TextDecoder().decode(r.stderr).trim()}`);
  }
  return new TextDecoder().decode(r.stdout);
}

/**
 * 起跑时照一张 git 状态的快照。**fail-open**:查不了就是 `unknown`,不阻断任何一次跑。
 *
 * ⚠ 这条 `catch` **不吞证据**(本仓 CLAUDE.md 第 2 条):原文进 `why`,并留一行 warn。
 *   把它吞成 `clean` 是这段代码唯一致命的写法 —— 那会让 owner 以为有回滚对象。
 */
export function captureRollbackAnchor(opts: { cwd: string }, deps: RollbackAnchorDeps = {}): RollbackAnchor {
  const git = deps.git ?? defaultGit;
  let head: string;
  try {
    head = git(['rev-parse', '--short', 'HEAD'], { cwd: opts.cwd }).trim();
  } catch (e) {
    // 不在 git 仓里与 git 起不来是**两回事**: 前者是事实(这里就是没有 git), 后者是观测失败。
    const why = (e as Error).message;
    const notRepo = /not a git repository|不是 git 仓库/i.test(why);
    logger.warn({ cwd: opts.cwd, why }, `[omd/rollback-anchor] 取 HEAD 失败 → ${notRepo ? 'not-a-repo' : 'unknown'}`);
    return { kind: notRepo ? 'not-a-repo' : 'unknown', why };
  }
  try {
    const statusOutput = git(['status', '--porcelain'], { cwd: opts.cwd });
    return classifyRollbackAnchor({ head, statusOutput });
  } catch (e) {
    const why = (e as Error).message;
    logger.warn({ cwd: opts.cwd, why }, '[omd/rollback-anchor] 取 status 失败 → unknown (**不当成干净**)');
    return { kind: 'unknown', head, why };
  }
}
