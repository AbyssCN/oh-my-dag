/**
 * src/harness/goal/criterion-anchor —— 冻结判据的**时效锚**(S-44)。**零 LLM, 确定性**。
 *
 * ## 它守的那个形状
 *
 * 判据是对的、命令是真跑的、退出码是真读的、`0 fail` 是真的 —— **坏的是它的时效**。
 *
 * 实账 (2026-08-20/21, run 83d9dfb6):
 *   21:29:52  `accept` 跑冻结判据 → `5927 pass / 0 fail`, 真绿
 *   21:34–21:55  引擎**还有 26 分钟写权**, 第二批节点继续改盘
 *   21:55:59  自动收编 → 回执写「冻结判据 ✅」
 *   人工在收编那棵树上复跑同一条判据 → `exit 1 / 4 fail`, `tsc exit 2`
 *
 * 没有任何一条断言问过「**判完之后盘动过没有**」。于是「过去那棵树的读数」为「新树」盖了章。
 *
 * ## 为什么这一条特别要紧
 *
 * `freezeGreen` 不只是一个记录位 —— 它在外层**拦着 verifier 的否决**
 * (`engine.ts` 的 C 无效否决闸: 拿到过机器绿的那一轮, 不可证伪的否决不许触发重规划)。
 * 锚一旦过期, 那道闸就在**用 T1 的绿保护 T2 的树**, 把该重规划的一轮挡掉。
 *
 * ## 锚取什么
 *
 * `HEAD` + `git status --porcelain` 的哈希。两者都要:
 * · 只取 HEAD → 未提交的改动看不见, 而 S-44 现场恰恰是工作树被改;
 * · 只取 porcelain → 一次 commit 会让脏文件消失, 读起来像"没动过"。
 *
 * ## fail-open, 但不吞证据 (仓规坑②)
 *
 * 取不到锚 (不是 git 仓 / git 不可用) → 返回 `null`, 判定退化成 `unknown`,
 * **不改变任何停机决定**。`unknown` ≠ `same` —— 三态不许压平, 否则"没量过"会伪装成"量过且没变"。
 *
 * ## 反向自检
 *
 * `criterion-anchor.test.ts`: 同锚→same · HEAD 变→changed · 脏面变→changed ·
 * 任一侧缺席→unknown。每条都配一个**该绿时不红**的同形样本。
 */
import { logger } from '../../logger';

/** 一次工作树快照。两个字段都是内容哈希, 不含路径与文件名 —— 锚不该泄漏树里有什么。 */
export interface TreeAnchor {
  /** `git rev-parse HEAD` 原样 (40 hex); detached/空仓时是 git 给什么记什么。 */
  head: string;
  /** `git status --porcelain` 全文的 sha256 前 16 hex。空树 = 空字符串的哈希, 不是空串。 */
  dirty: string;
}

/**
 * 三态。`unknown` 是**第一等公民** —— 它说的是"这一格没量到", 与"量了且一样"是两件事。
 * 压平成布尔会让取不到锚的那些跑静默地享受"没变"的待遇, 而那正是 S-44 的形状本身。
 */
export type AnchorVerdict = 'same' | 'changed' | 'unknown';

/** 判两次快照是不是同一棵树。纯函数, 零 IO —— 判据本身可以脱离 git 测。 */
export function compareTreeAnchor(before: TreeAnchor | null, after: TreeAnchor | null): AnchorVerdict {
  if (!before || !after) return 'unknown';
  return before.head === after.head && before.dirty === after.dirty ? 'same' : 'changed';
}

/** 注入面: 跑一条命令拿 stdout。`null` = 跑不起来 (不是 git 仓 / git 不在)。 */
export type AnchorRunner = (args: { cmd: string; args: string[]; cwd: string }) => string | null;

/** 生产用的 runner —— 同步 spawn, 不继承 stdio, 失败一律 `null` (调用方按 unknown 处理)。 */
export function defaultAnchorRunner({ cmd, args, cwd }: { cmd: string; args: string[]; cwd: string }): string | null {
  try {
    // 动态 require: 这个模块的判据部分 (compareTreeAnchor) 必须能在没有 node:child_process
    // 的环境里被 import 测试。
    const { spawnSync } = require('node:child_process') as typeof import('node:child_process');
    const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', windowsHide: true });
    // 非零退出 / spawn 失败是**正常路径**(不是 git 仓、git 不在): 不记日志, 否则每一跑刷一行噪声。
    // 抛异常才是意外 —— 那一格在下面的 catch 里留原文 (仓规坑②: fail-open 不许吞证据)。
    if (r.error || r.status !== 0) return null;
    return r.stdout ?? '';
  } catch (e) {
    logger.warn({ cmd, args, cwd, err: String(e) }, '[omd/criterion-anchor] 取工作树锚时抛异常 → 判据时效降级为 unknown');
    return null;
  }
}

function sha16(s: string): string {
  const { createHash } = require('node:crypto') as typeof import('node:crypto');
  return createHash('sha256').update(s).digest('hex').slice(0, 16);
}

/**
 * 取一次工作树快照。任何一步取不到 → `null` (调用方判 `unknown`, 不判 `changed`)。
 *
 * ⚠ **不要**把取不到锚当成"变了" —— 那会让非 git 目录下的每一跑都被判过期, 一道恒红的闸
 * 和一道恒绿的闸一样没用, 而且它会逼人把闸关掉。
 */
export function captureTreeAnchor(root: string, run: AnchorRunner = defaultAnchorRunner): TreeAnchor | null {
  const head = run({ cmd: 'git', args: ['rev-parse', 'HEAD'], cwd: root });
  if (head === null) return null;
  const porcelain = run({ cmd: 'git', args: ['status', '--porcelain'], cwd: root });
  if (porcelain === null) return null;
  return { head: head.trim(), dirty: sha16(porcelain) };
}

/** 判词渲染成一句人话 —— 进 journal / observation 用, 让「过期」在读者眼里不是一个枚举值。 */
export function describeAnchorVerdict(v: AnchorVerdict): string {
  switch (v) {
    case 'same':
      return '判据跑完之后工作树没动过 —— 这条绿说的就是这棵树';
    case 'changed':
      return '判据跑完之后工作树**又被改过** —— 这条绿说的是另一棵树 (S-44)';
    case 'unknown':
      return '取不到工作树锚 (非 git 仓或 git 不可用) —— 时效**未经核对**, 不等于没变';
  }
}
