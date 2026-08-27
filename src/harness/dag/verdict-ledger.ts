/**
 * harness/dag/verdict-ledger —— run 级 verifier 判词的 **append-only 幂等账本** (片 2)。
 *
 * ## 它治的那个病
 *
 * 今天 `engine.ts:5562` 与 `engine.ts:5885` 两个写点之间是**无条件覆写**:
 * 第 1 轮 verifier 给一条实质判词 → 开一轮升级重规划 → 第 2 轮 verifier 调不通 →
 * `engine.ts:5559` 的 `[verifier-error]` 顶替了第 1 轮判词。
 * `verification.reason` 失去了「第 1 轮这条**判过**了什么」的证据 —— 判词轴与引擎故障轴
 * 被压成一列, 而两列的下一步完全相反(前者改产出, 后者修引擎换池)。
 *
 * 节点级内环已有同形守卫(`continuity/types.ts:330` 的 `RoundVerdict` + `verdicts[]`),
 * 现在给 run 级补同款。本模块只管**记账**, 不管**判卷** —— 改判卷器会把两件事混进同一个 diff。
 *
 * ## 三件事各出一个具名纯函数
 *
 *   · `append` —— append-only, **同键幂等**, 异内容同键**拒**(返回具名错误, 不抛);
 *   · `terminal` —— 终值只从 `substantive` 记录里取, 用 discriminator 把
 *     「未判卷」从「pass:false 实质判词」结构层分开(仓规坑 ①: NULL ≠ 0 ≠ 不适用);
 *   · `infraObserved` —— infra 记录另出独立标志位, **永不当终值**。
 *
 * 三者**零 IO**:不打日志、不读环境、不抛异常(拒绝返具名错误)。
 * 测试直接攻击函数边界, 不 grep 日志(仓规:写在日志文案里的判据, 改一次文案就静默失效)。
 *
 * ## 键的定义
 *
 * `(round, kind)` 是去重键。**`at` 不在键里** —— 它是元数据, 改 `at` 不算改判词。
 * **内容等价**只看 `pass` 与 `reason`, 同样 `at` 不参与。
 *
 * ## 类型上的护栏
 *
 * `VerdictKind` 值域**冻结**为 `substantive | infra`, 不开第三值。运行期再加一道:
 * 非此二值的 `kind` 一律 `invalid-kind` 拒, 防止 `as VerdictEntry['kind']` 把 any 流进来。
 */
export type VerdictKind = 'substantive' | 'infra';

export interface VerdictEntry {
  /** 第几轮(与引擎 `attempts` 同一套编号)。 */
  round: number;
  /**
   * 这条记录的**轴**:
   *   · `substantive` —— 实质判词(verifier 真投了票 / 确定性 oracle 合成);
   *   · `infra` —— 引擎故障(verifier 调不通等), **不进终值**, 单独进 `infraObserved()`。
   */
  kind: VerdictKind;
  /** 实质判词里的真投票结果。infra 一律记 `false`(语义上不是投票, 只是占位)。 */
  pass: boolean;
  /** 判词原文 / 故障原文 —— 调用方各自读自己那一列。 */
  reason: string;
  /** 元数据, ISO 时间戳。键与内容等价都**不看它**, 改它不算改判词。 */
  at: string;
}

export interface VerdictLedger {
  readonly entries: readonly VerdictEntry[];
}

/** 成功追加或幂等空操作。 */
export type AppendOk = { ok: true; ledger: VerdictLedger; appended: boolean };
/** 拒绝 —— 账本逐字节不变, 调用方拿到的还是 `ledger`。 */
export type AppendRefused =
  | { ok: false; reason: 'same-key-different-content'; ledger: VerdictLedger }
  | { ok: false; reason: 'invalid-kind'; ledger: VerdictLedger };
export type AppendResult = AppendOk | AppendRefused;

/**
 * 终值。Discriminator 钉死两种形态:
 *   · `'judged'` —— 至少有一条 `substantive` 记录, **终值取最后一条**;
 *   · `'unjudged'` —— 一条 `substantive` 都没有, **不许压成 `pass:false` 的实质判词**
 *     (仓规坑 ①: NULL 不等于 0)。
 *
 * 故障轴另出, 见 `infraObserved()`。
 */
export type VerdictTerminal =
  | { kind: 'judged'; pass: boolean; reason: string }
  | { kind: 'unjudged' };

/** 空账本 —— `entries` 已冻结, 不可 mutate。 */
export function emptyLedger(): VerdictLedger {
  return { entries: Object.freeze([]) };
}

/**
 * append-only 追加。
 *
 * 拒的两种情形(都返具名错误, **不抛**):
 *   · `invalid-kind` —— `entry.kind` 不是 `substantive` / `infra` 之一;
 *   · `same-key-different-content` —— 同 `(round, kind)`, 但 `pass` 或 `reason` 与既有不同。
 *
 * 幂等情形:同 `(round, kind)`, `pass` 与 `reason` 逐字节相同 → 返回 `{ok:true, appended:false}`,
 * 账本逐字节不变。`at` 字段不参与内容等价。
 */
export function append(ledger: VerdictLedger, entry: VerdictEntry): AppendResult {
  if (entry.kind !== 'substantive' && entry.kind !== 'infra') {
    return { ok: false, reason: 'invalid-kind', ledger };
  }
  const existing = ledger.entries.find((e) => e.round === entry.round && e.kind === entry.kind);
  if (existing) {
    if (existing.pass === entry.pass && existing.reason === entry.reason) {
      return { ok: true, ledger, appended: false };
    }
    return { ok: false, reason: 'same-key-different-content', ledger };
  }
  const next = Object.freeze([...ledger.entries, entry]);
  return { ok: true, ledger: { entries: next }, appended: true };
}

/**
 * 终值选取 —— 只从 `substantive` 里取最后一条, **不看 `infra`**。
 *
 * 反例: `terminal({entries: [infra]})` 必返 `'unjudged'`(即便那条 infra 写的是
 * `pass:false, reason: '[verifier-error]'`)—— 把 infra 当成 pass:false 的实质判词,
 * 就是把一次引擎故障读成一次判决(仓规坑 ①)。
 */
export function terminal(ledger: VerdictLedger): VerdictTerminal {
  const substantive = ledger.entries.filter((e) => e.kind === 'substantive');
  if (substantive.length === 0) {
    return { kind: 'unjudged' };
  }
  const last = substantive[substantive.length - 1]!;
  return { kind: 'judged', pass: last.pass, reason: last.reason };
}

/**
 * 引擎故障标志 —— 账本里出现过**任何** `infra` 记录就 true。
 *
 * 与 `terminal()` 完全独立: `terminal` 只看 `substantive`, `infraObserved` 只看 `infra`。
 * 两列在结构层分开, 调用方按需各取(详见 SDD S3 INV-5 / INV-6)。
 */
export function infraObserved(ledger: VerdictLedger): boolean {
  return ledger.entries.some((e) => e.kind === 'infra');
}