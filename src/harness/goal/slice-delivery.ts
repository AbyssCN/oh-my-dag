/**
 * goal/slice-delivery —— 「verify 实装前就绿」的**分辨**(修复方向一,2026-08-28)。
 *
 * ## 病灶
 *
 * O-6 探针撞见一个 verify 已绿的切片时,判词逐字是:
 * 「RED 无法成立 —— **判据虚**(换实装前天然红的命令)**或活已干完**」。
 * 两种可能都写在判词里了,**而没有任何东西去分辨它们** —— 于是整图一律拒。
 *
 * 今天唯一的逃生门是 `run-goal.ts` 里那句
 * `const resuming = config.dag.continuity?.resume === true`(票 #242)。
 * 那是拿 resume 当「这活可能已经干过」的**代理**,而代理选窄了:
 * 活干完的原因还有人手做的、另一个窗口做的、上一跑用别的 runId 做的。
 *
 * 实账(2026-08-28):F2 的片 1–3 由人做完提交后,拿母契约点火被整图拒。
 * `resuming === false`,逃生门不适用,而活确确实实干完了。
 *
 * ## 换成 git 可查的证据
 *
 * 判据换成:**契约入库之后,本片写集里的文件被动过没有**。
 *
 * | 证据 | 判定 | 调用方该做什么 |
 * |---|---|---|
 * | 有提交动过写集,或写集有未提交改动 | `already-delivered` | 标该片已达成,实装节点降 `command` 重验 |
 * | 写集一次没被动过 | `vacuous-criterion` | 照旧拒 —— 这正是 O-6 该抓的 |
 * | 证据取不到 | `undetermined` | 照旧拒,但判词说清是「没测量」不是「测出来虚」 |
 *
 * 这条**覆盖了 resume 那一格**:resume 时前面几轮的写入要么已提交要么在工作树里,
 * 两条路都落进 `already-delivered`。所以 `resuming` 那个代理可以退役。
 *
 * ## 三格不许压成两格
 *
 * `undetermined`(非 git 仓 / git 调用失败)与 `vacuous-criterion` 的**下一步恰好相同**(都拒),
 * 但它们是两件事,压平之后事后再也分不开(仓规坑 ①:`NULL` ≠ 0 ≠ 不适用)。
 * 分开的价值在判词上:一个说「你的判据在任何代码下都绿」,另一个说「我没能去看」。
 * 前者要人改契约,后者要人去看 git 怎么了。
 *
 * ⚠ 更要紧的是**别把 `undetermined` 读成 `already-delivered`** —— 那会让非 git 仓里
 * 所有虚判据一路放行,闸整个失效。取不到证据时保守方向是拒,与今天行为一致(零回归)。
 *
 * ## 零 IO
 *
 * git 证据是**入参**,不在本模块取。取证据那一半归调用方 ——
 * 这样测试造得出「非 git 仓」「git 调用失败」这些拿真仓造不出来的格。
 *
 * @module
 */

/** git 侧的证据。**三个字段一起读**:`available` 为假时另两个没有意义。 */
export interface SliceGitEvidence {
  /**
   * 这一跑是不是 resume。**续跑本身就是「活干到一半」的证据**(#242 的原推理,成立且保留)——
   * 它不是被 git 证据取代的,是与之**并列**的另一条证据源。
   *
   * ⚠ 2026-08-28 我一度把它当代理「退役」掉,结果 #242 的回归用例当场红:
   * 那份用例跑在临时目录里,拿不到 git 证据 → undetermined → 拒 → 回落,正是 #242 修掉的病。
   * **测试是对的,我的改动不完整。** 代理选窄了要**加**证据源,不是**换**掉它。
   */
  readonly resuming: boolean;
  /**
   * 证据取到了没有。`false` = 非 git 仓 / git 调用失败 / 查不到契约的入库点。
   * ⚠ 为假时**不许读**下面两个计数 —— 那等于把「没测量」当成「测量结果是 0」。
   */
  readonly available: boolean;
  /** 契约入库之后,有几个提交动过本片写集里的文件。 */
  readonly commitsTouchingWriteSet: number;
  /** 工作树里本片写集有几个文件有未提交改动(含新建)。 */
  readonly dirtyWriteSetFiles: number;
}

/** 分辨结果。三格互斥,`why` 一律非空 —— 拒了要说得出为什么。 */
export type GreenVerifyVerdict =
  | { readonly kind: 'already-delivered'; readonly why: string }
  | { readonly kind: 'vacuous-criterion'; readonly why: string }
  | { readonly kind: 'undetermined'; readonly why: string };

/**
 * 一个 **verify 已绿** 的切片:是活已干完,还是判据本来就虚?
 *
 * ⚠ 调用方只在 verify 确实已绿时问这个问题。verify 红的切片没有这一问 —— 它照常进图重跑。
 *
 * ⚠ **只有 `already-delivered` 允许跳过该片**,另两格一律照旧拒。
 */
export function explainGreenVerify(ev: SliceGitEvidence): GreenVerifyVerdict {
  if (ev.resuming) {
    // #242: 续跑时切片 verify 当前绿 = 活已干完 (含「owner 人工修绿 verify 后 resume」这条
    // 合法路径)。这一格先判, 因为它不依赖 git —— 非 git 仓里 resume 照样该走逃生门。
    return { kind: 'already-delivered', why: '续跑 (resume) 且该片 verify 当前已绿 — 活干到一半接着跑 (#242)。' };
  }
  if (!ev.available) {
    return {
      kind: 'undetermined',
      why:
        '取不到 git 证据 (非 git 仓 / git 调用失败 / 查不到契约入库点) — ' +
        '分辨不了「判据虚」与「活已干完」, 保守按拒处理。这不是「测出来是虚的」, 是「没能去看」。',
    };
  }
  const touched = ev.commitsTouchingWriteSet + ev.dirtyWriteSetFiles;
  if (touched > 0) {
    return {
      kind: 'already-delivered',
      why:
        `契约入库后本片写集被动过 (${ev.commitsTouchingWriteSet} 个提交 + ` +
        `${ev.dirtyWriteSetFiles} 个未提交改动) — 活已干完, 该片标已达成, 实装节点降 command 重验。`,
    };
  }
  return {
    kind: 'vacuous-criterion',
    why:
      '契约入库后本片写集一次没被动过, 而 verify 已经绿 — 这条判据在任何代码下都绿, ' +
      '换一条实装前天然红的命令 (如对产物 grep)。',
  };
}

// ── 取证据那一半(注入式,模块本身仍不直接碰 fs / child_process)────────────────

/** 注入的命令执行面。生产端传真 git;测试端传替身,造得出「非 git 仓」这类格。 */
export type ExecGit = (args: readonly string[]) => { stdout: string; exitCode: number };

/**
 * 取一片的 git 证据。**两跳,失败即 `available:false`**,不编残值。
 *
 * 1. 契约的入库点 —— `log --diff-filter=A --format=%H -- <契约>` 的**最后一行**(最早那次新增);
 * 2. 该点之后有几个提交动过写集 + 工作树里写集有几个文件脏。
 *
 * ⚠ **诚实边界,两条**:
 * · **契约还没提交**时第 1 跳查不到入库点 → `available:false`(owner 2026-08-28 裁,T-3)。
 *   原实装在这一格降级成「只看脏文件数」,而那正是同树多窗口下的假放行入口:另一个窗口
 *   在同名文件上的在途改动会被读成「本片已交付」,而 `already-delivered` 是**唯一放行**
 *   的那一格。没有入库点就没有确定的起点,「谁干的」这一问机械答不了 —— 老实说不知道。
 *   配套是点火层那道前置闸(`mcp/tools/goal.ts` 的 `contractCommittedGate`):契约先提交
 *   再点火,于是这一格在生产上根本不该出现;这里保留它是纵深,不是主路。
 * · 写集为空 → `available:false`。空写集没有可查的证据面,而空写集本身该由别的闸拒。
 */
export function collectSliceGitEvidence(
  contractPath: string,
  writeSet: readonly string[],
  exec: ExecGit,
  resuming = false,
): SliceGitEvidence {
  const none: SliceGitEvidence = { resuming, available: false, commitsTouchingWriteSet: 0, dirtyWriteSetFiles: 0 };
  if (writeSet.length === 0) return none;

  const birth = exec(['log', '--diff-filter=A', '--format=%H', '--', contractPath]);
  if (birth.exitCode !== 0) return none;
  const lines = birth.stdout.split('\n').map((x) => x.trim()).filter(Boolean);
  const birthSha = lines.at(-1);
  // T-3 (owner 2026-08-28 裁): 查不到入库点 = 契约还没提交 = **没有确定的起点**。
  // 此时唯一还能问的是「写集脏不脏」, 而脏不脏答不了「是谁弄脏的」—— 同树另一个窗口的
  // 在途改动同样会让它脏。拿它放行等于把别人的活记在本片头上。老实判「没能去看」。
  if (!birthSha) return none;

  const since = exec(['log', '--format=%H', `${birthSha}..HEAD`, '--', ...writeSet]);
  if (since.exitCode !== 0) return none;
  const commits = since.stdout.split('\n').filter((x) => x.trim().length > 0).length;

  const dirty = exec(['status', '--porcelain', '--', ...writeSet]);
  if (dirty.exitCode !== 0) return none;
  const dirtyCount = dirty.stdout.split('\n').filter((x) => x.trim().length > 0).length;

  return { resuming, available: true, commitsTouchingWriteSet: commits, dirtyWriteSetFiles: dirtyCount };
}

/**
 * 生产用的 git 执行面 —— 同步 spawn,失败一律当「取不到」。
 * 形状照 `criterion-anchor.ts` 的 `defaultAnchorRunner`(同族先例:那条对**树**做时效锚,
 * 这条对**契约与写集**做交付判定)。动态 require 是为了让本模块的判据部分能在没有
 * `node:child_process` 的环境里被 import 测试。
 */
export function defaultGitExec(cwd: string): ExecGit {
  return (args) => {
    try {
      const { spawnSync } = require('node:child_process') as typeof import('node:child_process');
      const r = spawnSync('git', [...args], { cwd, encoding: 'utf8', windowsHide: true });
      if (r.error) return { stdout: '', exitCode: 128 };
      return { stdout: r.stdout ?? '', exitCode: r.status ?? 128 };
    } catch {
      // 非零退出 / spawn 失败是**正常路径** (不是 git 仓 / git 不在), 不刷日志;
      // 判定那一侧会把它读成 undetermined 并在判词里说清「没能去看」。
      return { stdout: '', exitCode: 128 };
    }
  };
}

// ── O-6 的那个决定(具名纯函数,接线方只负责喂证据与执行结论)──────────────────

/** 一片在 O-6 探针眼里的样子。 */
export interface SliceProbe {
  readonly id: number;
  readonly verify: string;
  readonly writeSet: readonly string[];
  /** 实装前先跑一枪 verify 的结果。false = 天然红, 这一片没有可争的。 */
  readonly verifyGreen: boolean;
}

/** O-6 的结论:要么整图放行(带上可跳过的片),要么点名一片拒。 */
export type O6Decision =
  | { readonly kind: 'proceed'; readonly achieved: ReadonlySet<number>; readonly notes: readonly string[] }
  | { readonly kind: 'reject'; readonly sliceId: number; readonly message: string };

/**
 * 逐片判 O-6:**verify 已绿**的片是活已干完还是判据虚。
 *
 * 今天这个决定由 `run-goal.ts` 里一句 `if (resuming)` 做 —— 本函数取代它,判据换成
 * git 可查的证据(见 {@link explainGreenVerify})。**第一片判拒就整体拒**,与今天的
 * fail-fast 语义逐字相同(INV-D3-4:sddPath 不落 v1)。
 *
 * `notes` 收「哪几片被判已交付、为什么」—— 放行也要留痕,否则「跳过了 3 片」这件事
 * 只活在没人读的分支里(仓规:fail-open 可以吞异常,不许吞证据)。
 */
export function decideO6(
  slices: readonly SliceProbe[],
  evidenceOf: (s: SliceProbe) => SliceGitEvidence,
): O6Decision {
  const achieved = new Set<number>();
  const notes: string[] = [];
  for (const s of slices) {
    if (!s.verifyGreen) continue; // 天然红 = O-6 前提成立, 照常进图
    const v = explainGreenVerify(evidenceOf(s));
    if (v.kind === 'already-delivered') {
      achieved.add(s.id);
      notes.push(`切片 ${s.id}: ${v.why}`);
      continue;
    }
    return {
      kind: 'reject',
      sliceId: s.id,
      message:
        // ⚠ 判词标记 `[run-goal][o6-vacuous-verify]` **刻意不在这里拼** —— 有条源码扫描绊线
        // (`gates/o6-vacuous-verify.gate.test.ts`) 钉着那个字面量必须出现在 run-goal.ts 里。
        // 由抛出方前置, 本函数只给「哪一片、为什么」。
        `切片 ${s.id} 的 verify 实装前已绿 (\`${s.verify}\` → 0): RED 无法成立 —— ${v.why}`,
    };
  }
  return { kind: 'proceed', achieved, notes };
}
