/**
 * harness/writeset/write-version —— **写的那一刻,盘上还是你看见的那一版吗**(2026-09-01)。
 *
 * 与 `write-allow.ts` **并列的第二道**,判的是完全不同的一面:
 *   · `write-allow` = **路径面** —— 这个文件归不归本节点管;
 *   · 本模块       = **版本面** —— 这个文件从本节点看过它之后,有没有被别人换过。
 * 两道各判各的,判词也分开写:一条的修法是改分解表的写集列,另一条的修法是重读再写。
 * 合成一条会让人去改错的那个(同 `requireWritable` 里那两条正交闸的分工注释)。
 *
 * ## 它补的洞
 *
 * `#253` 之后写型 run 落隔离 worktree,但隔离粒度是 **per-run 不是 per-leaf**:
 * `run-worktree.ts:154` 的 `runWorktreeDir(cwd, runId)` 只以 runId 作键,一个 run 只建一棵树
 * (`assemble.ts:602` 起也只造**一个** runner,cwd 烤死在构造期),而 agent 叶的默认并发是
 * **36**(`fleet.ts:40` `AGENT_DEFAULT_FANOUT`)。所以**同一个 run 的并发兄弟共用一棵树、
 * 一个 git index**,两个 leaf 写同一个文件是天天会发生的事,不是理论风险。
 *
 * 而今天这件事**只有事后才知道**:
 *   · `touch-ledger.ts` 头一行写着「只记不拦, 第一刀」——它是台账,不判;
 *   · `engine.ts:5671` 的 `detectRuntimeWriteRace` 是**整张图跑完之后**跑的(`pump()` 已 resolve),
 *     而且自己标着「只报不拦」——那时被盖掉的内容早就没了。
 * 本模块是**写前**那一道:目标在本次调用观察之后变过 → 当场拒。
 *
 * ## 三态:「没观察过」与「观察到不存在」不是一件事
 *
 * 形状借 DeepSeek Harness 的 `FsObservation`(只借形状,不引依赖):
 *   · 观察台里**没有这个键**(`undefined`)= 从没观察过 —— 不知道;
 *   · `{kind:'absent'}` = 观察过,确认它不在盘上 —— 知道它不存在;
 *   · `{kind:'present', state}` = 观察过,记下了那一版。
 * 刻意**不造** `{kind:'unknown'}`:造出来就会有人当一个值往下传,两种缺席从此抹平
 * (仓规 NULL≠0≠不适用)。第三态由**类型之外的 `undefined`** 承担,结构上就传不错。
 *
 * ## 版本 = 复用 head-baseline 的那三位,不造第二套
 *
 * `HeadBaselineEntry` 已经定义了「一个路径此刻长什么样」= (内容 hash · mode 位 · symlink realpath),
 * 判等口径与 `changedSinceHeadBaseline` 逐位相同。**这里不另起一套**:两套版本口径漂了,
 * 会出现「救援③说没变、本闸说变了」这种谁也说不清的对打。
 * 用三位而不是只用 hash 的理由与那边同一条:**mode 与 symlink 目标是 hash 的盲区** ——
 * 兄弟把 symlink 换了个目标,内容 hash 一个字节都不动,而你的写会落到另一个文件上。
 *
 * ## 诚实边界(如实写在这,别把它读成「并发安全」)
 *
 * · 它只管**工具通道的 `write`**。leaf 的 bash 通道(`> file` / `python3 -c`)绕得过去,
 *   与 `write-allow` 那条同样的边界 —— 两条都不是全集。
 * · 它**不锁**。判与写之间仍有一个微秒级窗口(check-then-write);本闸把「事后才知道」
 *   收成「几乎写的那一刻就知道」,不是把竞争消灭。真要消灭得上文件锁,那是另一件事。
 * · `observePath` 会把 `statEntry` 的**非 ENOENT lstat 失败**(权限 / IO)读成「不在盘上」→ 放行。
 *   那一格 `head-baseline.ts:71` 自己 warn 了一行;真读不了的文件紧接着的 write 会自己失败。
 *   这是一格明写的 fail-open,不是判据。
 *
 * 证伪方式(write-version.test.ts 反向自检):把 `checkWriteVersion` 里
 * `observed === undefined` 那条分支改成恒放行 → 「没读过就覆写」用例必红;
 * 把 `sameState` 改成恒 true → 「读完之后被兄弟改了」用例必红。
 *
 * @module
 */
import { statEntry, type HeadBaselineEntry } from './head-baseline';

/** 见文件头「三态」一节。第三态 = 观察台里没这个键(`undefined`),**不在本联合里**。 */
export type FileObservation =
  | { kind: 'present'; state: HeadBaselineEntry }
  | { kind: 'absent' };

/**
 * 拒的机读码。两码分开的理由 = **修法不同**:
 * · `FS_NOT_OBSERVED` —— 你没看过就要整体覆写 → 先 `read` 再写;
 * · `FS_STALE_VERSION` —— 你看过,但那之后它变了 → 重读,并且要重新想「该写什么」。
 */
export type WriteVersionCode = 'FS_NOT_OBSERVED' | 'FS_STALE_VERSION';

export interface WriteVersionVerdict {
  allowed: boolean;
  /** 放行时为 `null`。 */
  code: WriteVersionCode | null;
  /** 判成这一格的**直接证据**,进判词 —— 只说「变了」会让执行体反复试同一个路径。 */
  evidence: string;
}

/** 版本三位的可读形。`null` 原样打出来(「量过了且不适用」),不省成空。 */
function fmt(s: HeadBaselineEntry): string {
  return `hash=${s.hash ?? 'NULL'} mode=${s.mode ?? 'NULL'} link=${s.link ?? 'NULL'}`;
}

/**
 * 三位一起判等,与 `changedSinceHeadBaseline` 逐位同口径(hash ∨ mode ∨ link 任一不同 = 变了)。
 * 别退化成只比 hash —— 那会漏掉 chmod 与 symlink 改目标,而那两样正是 hash 的盲区。
 */
function sameState(a: HeadBaselineEntry, b: HeadBaselineEntry): boolean {
  return a.hash === b.hash && a.mode === b.mode && a.link === b.link;
}

/**
 * 量一次「此刻盘上是什么」。存在判据 = **`mode !== null`**(lstat 成功才有 mode);
 * 目录也算 present(lstat 成功,hash 为 null)—— 往目录上 write 本来就该失败,不是本闸的活。
 *
 * ⚠ 观察侧与判侧**必须用同一把尺子**:两边都走这个函数。各算各的 hash 会造出
 * 「同一份文件量出两个版本」的假失配,而那种假 major 的代价是有人把整条闸关掉。
 */
export function observePath(root: string, path: string): FileObservation {
  const state = statEntry(root, path);
  return state.mode === null ? { kind: 'absent' } : { kind: 'present', state };
}

/**
 * 版本守卫的判据面。**纯函数**:观察态与实际态都由调用方量好递进来,本函数不碰盘
 * (与 `checkWriteAllowed` 同一形状 —— 判据可单测,取值在调用方)。
 *
 * @param observed 本次调用**观察到的**版本;`undefined` = 从没观察过(第三态)。
 * @param actual   **写的那一刻**盘上的实际版本。
 */
export function checkWriteVersion(args: {
  observed: FileObservation | undefined;
  actual: FileObservation;
}): WriteVersionVerdict {
  const { observed, actual } = args;
  if (observed === undefined) {
    // 从没观察过。盘上没有 → 新建,没有任何人的东西可盖,放行(这是绝大多数正当写)。
    // 盘上有 → 要整体覆写一份自己一眼都没看过的东西,那正是并发盲盖的形状。
    return actual.kind === 'absent'
      ? { allowed: true, code: null, evidence: '没观察过 + 盘上不存在 = 新建' }
      : { allowed: false, code: 'FS_NOT_OBSERVED', evidence: `本次调用一次都没读过它, 而它已经在盘上 (${fmt(actual.state)})` };
  }
  if (observed.kind === 'absent') {
    // 「我看的时候它不存在」→ 现在有了 = 别人在这中间建的。这是版本变了,不是没观察过 ——
    // 归 STALE 而不是 NOT_OBSERVED,因为修法是「重读再写」而不是「先去读一下」。
    return actual.kind === 'absent'
      ? { allowed: true, code: null, evidence: '观察到不存在 + 此刻仍不存在 = 新建' }
      : { allowed: false, code: 'FS_STALE_VERSION', evidence: `观察时不存在, 此刻盘上有了 (${fmt(actual.state)}) —— 有人在这中间建了它` };
  }
  if (actual.kind === 'absent') {
    return { allowed: false, code: 'FS_STALE_VERSION', evidence: `观察时存在 (${fmt(observed.state)}), 此刻盘上没了 —— 有人在这中间删了它` };
  }
  return sameState(observed.state, actual.state)
    ? { allowed: true, code: null, evidence: '与观察时逐位一致' }
    : {
        allowed: false,
        code: 'FS_STALE_VERSION',
        evidence: `观察时 [${fmt(observed.state)}], 此刻 [${fmt(actual.state)}]`,
      };
}

/**
 * 拒的判词。三条硬要求,少一条这道闸就会被绕过或被关掉:
 * ① 说清**变的是什么**(evidence 原样带上)—— 只说「失配」执行体只会原样再试一次;
 * ② 明说 **别重试** —— 照 `node-failure.ts:178` 的既有纪律,重试不会让版本变回去;
 * ③ 给出**下一步**:重读再写,或者升 owner(写集分配撞了是契约的问题,不该在这里绕开)。
 */
export function describeVersionDenied(target: string, verdict: WriteVersionVerdict, tool: string): string {
  if (verdict.code === 'FS_NOT_OBSERVED') {
    return (
      `BLOCKED 写前未观察: ${tool} 的目标 ${target} 已经在盘上, 而本次调用一次都没读过它 ` +
      `(证据: ${verdict.evidence})。整体覆写一份没读过的文件 = 把并发兄弟或上一轮的内容盲盖掉。` +
      `**别原样重试** —— 重试盖掉的是同一份内容; 先 read(${target}) 看清现状, 再决定要写什么。`
    );
  }
  return (
    `BLOCKED 写版本失配: ${tool} 的目标 ${target} 在你观察之后被改过 (证据: ${verdict.evidence})。` +
    '本次写会把那份改动整片盖掉 —— 同一棵 worktree 里还有并发兄弟在跑。' +
    `**别原样重试** —— 版本不会因为重试而变回去; 要么 read(${target}) 重读再写, ` +
    '要么这个文件本来就不该由本节点写 (那说明分解表的写集撞了, 是契约的问题, 升 owner)。'
  );
}
