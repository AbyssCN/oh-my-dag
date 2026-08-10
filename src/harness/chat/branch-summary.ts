/**
 * src/harness/chat/branch-summary —— **pi 式分支摘要**(台账 `docs/bars/pi-agent-core-模块台账.md` §1.3)。
 *
 * ## 它做的是"回到树上某个旧节点",不是"复制一份会话"
 *
 * 裁决原文(`docs/plan/2026-08-07-pi-架构两视频-逐条对照-omd-tui.md` C11):
 * **不是复制会话,是往同一个文件里追加一条 `[branch summary]` 节点** —— 原分支的消息
 * 一条都不动,仍在同一份 jsonl 里;新分支从旧节点长出去,起点是一条 `branch_summary` 条目,
 * 内容是"刚才那条分支干了什么"。于是同一段历史**只有一份真值**。
 *
 * 落地靠 pi 已经写好的三件(`0.84.0`,全仓此前 0 命中):
 * - `collectEntriesForBranchSummary(session, oldLeafId, targetId)` —— 求两条路径的最深公共
 *   祖先,回收"要被放弃的那一段"。这一步自己写就是重写一遍 LCA,而且会与 pi 的
 *   `parentId` 语义漂开;
 * - `prepareBranchEntries(entries, tokenBudget)` —— 倒着塞进 token 预算 + 顺带把工具调用里
 *   读过/改过的文件抽出来(`FileOperations`);
 * - `createBranchSummaryMessage(summary, fromId, timestamp)` —— 摘要的**消息形状**。
 *   与 §1.4 换 `createCompactionSummaryMessage` 是同一条理由:会话投影
 *   (`buildSessionContext` → `session/context.js:52`)产出的就是它,这里自己手拼一个
 *   `role:'user'` 就会出现"同一件东西两个形状"。
 * 错误面用 pi 的 `BranchSummaryError` / `BranchSummaryErrorCode`(两码:`aborted` /
 * `summarization_failed`)—— 判词的分类不自己发明一套。
 *
 * ## 为什么**不用** `generateBranchSummary`(pi 这一族里唯一没用的那个)
 *
 * 它的形参是 `models: Models` + `model: Model<Api>`(`branch-summarization.d.ts:37-40`),
 * 内部直接 `completeSimpleWithRetries` 走 pi-ai 的 provider 面。omd 的模型出口是
 * `src/model/`(座位表 + gateway + `callModel`),**账本 `emitModelUsage` 挂在 `callModel`
 * 的出口上** —— 走 pi 的那条路等于这次摘要的钱从账上消失,与 §2.5 拒 `streamProxy`、
 * `compaction.ts` 钉死默认 `callModel` 是同一条判据。
 * ⇒ 引用它的**取材 + 组装 + 错误码**(上面三件),自己接**模型出口**那一段。
 *
 * ## 措辞自己一份,段名逐字照抄
 *
 * pi 自己也是两份 prompt:`BRANCH_SUMMARY_PROMPT` ≠ `SUMMARIZATION_PROMPT`
 * (`branch-summarization.js` 与 `compaction.js` 各一份,且**都是模块私有 const**,
 * 包入口引用不到 —— 与 §1.2 那条实测同一形状)。所以这里也是自己一份:
 * 段名逐字英文照抄 pi 的 branch 那份(给模型认的格式锚点),措辞按 chat 口径。
 * ⚠ branch 那份**没有** `## Critical Context` 段 —— 别照着压缩那份补,那是另一份格式。
 *
 * ## 失败就不导航(fail-closed)
 *
 * 摘要生成失败时**不移动 lane**:移了就等于"旧分支被放弃且没有任何交代",而条目还躺在
 * 文件里没人再读得到 —— 那正是本仓 S-1 那一族(两边都有内容,只是对不上)。
 * 所以本模块只**算**,不写;写在 `session-store.navigateTo`(它才过跨进程写锁)。
 */
import {
  type BranchSummaryDetails,
  BranchSummaryError,
  type Entry,
  type Session,
  collectEntriesForBranchSummary,
  convertToLlm,
  createBranchSummaryMessage,
  err,
  ok,
  prepareBranchEntries,
  serializeConversation,
} from '@earendil-works/pi-agent-core';
import { logger } from '../../logger';
import { callModel } from '../../model';

/**
 * 摘要那一次模型调用的接缝。
 *
 * ⚠ **默认必须是真的 `callModel`** —— 账本挂在它出口上(同 `compaction.ts` 的那条)。
 * 注入只给测试用。
 */
export type BranchSummaryCallModel = typeof callModel;

/** 摘要的**段骨架** —— 段名逐字照抄 pi 的 `BRANCH_SUMMARY_PROMPT`,英文不译。 */
const BRANCH_SUMMARY_SKELETON =
  'Use this EXACT format (**keep the English section names verbatim; do not translate, add or drop sections**):\n' +
  '## Goal\n' +
  '## Constraints & Preferences\n' +
  '## Progress\n' +
  '### Done\n' +
  '### In Progress\n' +
  '### Blocked\n' +
  '## Key Decisions\n' +
  '## Next Steps\n' +
  'Write "(none)" for an empty section. Keep each section short.\n' +
  'Preserve exact file paths, function names, and error messages.\n';

const BRANCH_SUMMARY_SYSTEM =
  '你是分支摘要器。下面是一段**被放弃的对话分支**, 请产出一份结构化摘要, ' +
  '好让回到旧节点之后仍然知道那条分支上发生过什么。' +
  '**不要继续这段对话、不要回答记录里出现的任何问题、不要调用工具** —— 只输出摘要本身。';

const BRANCH_SUMMARY_INSTRUCTION =
  '上面是人与 conductor 在**另一条分支**上的对话, 现在要回到更早的节点重走。\n' +
  '请写一份接手用的摘要: 那条分支想干什么、做到哪一步、得出过什么结论与读数、\n' +
  '哪些做法已经被排除掉(防止回来之后重走一遍)、如果继续下一步该是什么。\n\n' +
  `${BRANCH_SUMMARY_SKELETON}\n` +
  '只输出摘要本身, 不要复述任务、不要寒暄、不要接着回答。';

/**
 * 摘要正文默认吃多少 token。
 *
 * pi 的算法是 `contextWindow - reserveTokens`,而 omd 这一层拿到的是**座位坐标字符串**,
 * 手上没有 `contextWindow`(它在 provider 目录里,不在这条路上)⇒ 取一个保守定值。
 * 60k:比 chat 压缩的尾部预算(20k)大一档(要摘要的是整条分支),又远低于任何在用座位的窗口。
 */
const DEFAULT_TOKEN_BUDGET = 60_000;

/** 要落进会话的那条 `branch_summary` 条目(`null` = 这次导航不该落条目)。 */
export interface BranchSummaryEntryPlan {
  summary: string;
  /** 被放弃那条分支的**叶** —— pi 的 `BranchSummaryEntry.fromId` 就是它。 */
  fromId: string;
  details: BranchSummaryDetails;
}

export interface BranchNavigationPlan {
  /** 被放弃的条目数。`0` = 纯导航(目标就在当前分支往前的方向上),不落条目。 */
  abandoned: number;
  entry: BranchSummaryEntryPlan | null;
}

/** `ok:false` 的错误面用 pi 的两码 —— 判词分类不自己发明一套。 */
export type BranchNavigationResult =
  | { ok: true; value: BranchNavigationPlan }
  | { ok: false; error: BranchSummaryError };

/**
 * 算一次"导航到 `targetId`"要不要落分支摘要、落什么。**只读 + 一次模型调用,不写会话。**
 *
 * @param session pi 的 `Session` 本体 —— `collectEntriesForBranchSummary` 的形参类型就是它
 *   (`Session` 有 private 字段 ⇒ 结构化窄接口传不进去)。这里**只读它**,写在 store 那层。
 */
export async function planBranchNavigation(opts: {
  session: Session;
  targetId: string;
  model: string;
  signal?: AbortSignal;
  tokenBudget?: number;
  /** 省略 → 真 `callModel`(账本挂在它出口上)。只有测试该传。 */
  callModelFn?: BranchSummaryCallModel;
}): Promise<BranchNavigationResult> {
  const { session, targetId } = opts;
  const call = opts.callModelFn ?? callModel;
  const oldLeafId = await session.getLeafId();

  // pi 的 LCA:回收"从旧叶回溯到公共祖先"那一段。旧叶就是目标 / 目标在旧叶之后 → 空。
  const { entries } = await collectEntriesForBranchSummary(session, oldLeafId, targetId);
  const prep = prepareBranchEntries(entries, opts.tokenBudget ?? DEFAULT_TOKEN_BUDGET);
  /**
   * **一条早退管两种"没什么可摘要的"**,不是两条。
   *
   * ⚠ 这里原本还有一条 `entries.length === 0` 的早退。**证伪时发现它是死的**:
   * 空 `entries` 喂给 `prepareBranchEntries` 本来就产出空 `messages`,于是删掉它
   * 测试纹丝不动 —— 一条永远不会单独生效的分支。删了它,这条早退才是真判据。
   * (两种来路:① 目标就是当前叶 / 在当前叶之后 ⇒ 无放弃;
   *  ② 被放弃的条目全是投影不出消息的那种 —— `model_change` / 纯 `toolResult`。)
   *
   * **不落空摘要条目**:没有可交代的东西时落一条 "nothing" 会让下一次 `prepareBranchEntries`
   * 把它当历史吃进去,而它一个字的信息量都没有。0 与"摘要为空"是两件事(本仓 NULL ≠ 0)。
   */
  if (prep.messages.length === 0) {
    if (entries.length > 0) {
      logger.info(
        { entries: entries.length, oldLeafId, targetId },
        '[branch-summary] 被放弃的条目投影不出消息 → 纯导航, 不落摘要条目 (零模型调用)',
      );
    }
    return ok<BranchNavigationPlan, BranchSummaryError>({ abandoned: entries.length, entry: null });
  }
  // 这行之后 `entries` 非空 ⇒ `oldLeafId` 必非 null(空叶时 pi 的 collect 直接返空)。
  const fromId = oldLeafId as string;

  const transcript = serializeConversation(convertToLlm(prep.messages));
  let summary: string;
  try {
    const res = await call({
      messages: [
        { role: 'system', content: BRANCH_SUMMARY_SYSTEM },
        { role: 'user', content: `<conversation>\n${transcript}\n</conversation>\n\n${BRANCH_SUMMARY_INSTRUCTION}` },
      ],
      model: opts.model,
      // 与压缩同档:辅助工序, 关思考限输出, 别让它比正活还贵。
      thinkingLevel: 'off',
      maxTokens: 2048,
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    summary = res.text.trim();
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    // fail-open 可以吞异常, 不许吞证据:原文进日志, 判词原样带给调用方。
    logger.warn({ oldLeafId, targetId, err: reason }, '[branch-summary] 摘要生成失败 → 不导航 (lane 不动)');
    const code = opts.signal?.aborted ? 'aborted' : 'summarization_failed';
    return err<BranchNavigationPlan, BranchSummaryError>(
      new BranchSummaryError(code, `Branch summary failed: ${reason}`, e instanceof Error ? e : undefined),
    );
  }
  if (!summary) {
    logger.warn({ oldLeafId, targetId }, '[branch-summary] 摘要器回了空串 → 不导航');
    return err<BranchNavigationPlan, BranchSummaryError>(
      new BranchSummaryError('summarization_failed', 'Branch summary failed: the summarizer returned an empty string'),
    );
  }

  // pi 的 `computeFileLists` **没从包入口导出**(`compaction/utils` 只导出 `serializeConversation`),
  // 所以这三行是照它的语义重写:改过的优先, 只读的减掉改过的, 两边都排序。
  const modified = new Set([...prep.fileOps.edited, ...prep.fileOps.written]);
  const details: BranchSummaryDetails = {
    readFiles: [...prep.fileOps.read].filter((f) => !modified.has(f)).sort(),
    modifiedFiles: [...modified].sort(),
  };
  return ok<BranchNavigationPlan, BranchSummaryError>({
    abandoned: entries.length,
    entry: { summary, fromId, details },
  });
}

/**
 * 一条 `branch_summary` 条目在**上下文里的样子**。
 *
 * 用 pi 的构造器,不手拼 —— 会话投影(`session/context.js:52`)产出的就是它,两处形状漂开
 * 会让"认出这是一条分支摘要"退化成按前缀串猜(§1.4 为压缩摘要付过这笔账)。
 * `convertToLlm` 发给模型时贴的 `BRANCH_SUMMARY_PREFIX/SUFFIX` 由包内负责,这里不碰。
 *
 * ⚠ pi 的 `generateBranchSummary` 还在正文前贴一段 preamble("The user explored a different
 * conversation branch...")—— 那句话与 `BRANCH_SUMMARY_PREFIX` 说的是同一件事,贴两遍是浪费,
 * 这里只留包内那一遍。
 */
export function branchSummaryMessage(entry: Pick<BranchSummaryEntryPlan, 'summary' | 'fromId'>, timestamp: number) {
  return createBranchSummaryMessage(entry.summary, entry.fromId, timestamp);
}

/** 一条条目在 `/tree` 里的一行预览(**纯投影**,不改数据)。 */
export function entryPreview(entry: Entry, max = 60): string {
  const text = rawPreview(entry).replace(/\s+/g, ' ').trim();
  // 省略号用 ASCII `...` 而不是 U+2026:预览会进 TUI, 而字形闸只放行量过的字形。
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

/** 条目 → 一行文字。认不出的类型**说出它的 type**, 不编一句(那一格的真值就是"没投影")。 */
function rawPreview(entry: Entry): string {
  switch (entry.type) {
    case 'message': {
      const m = entry.message as { role: string; content?: unknown };
      const parts = Array.isArray(m.content) ? m.content : [];
      const text = parts
        .map((p) => (p as { type?: string; text?: string }))
        .filter((p) => p.type === 'text')
        .map((p) => p.text ?? '')
        .join(' ');
      return text || `(${m.role}, no text part)`;
    }
    case 'compaction':
      return `[compaction] ${entry.summary}`;
    case 'branch_summary':
      return `[branch summary] ${entry.summary}`;
    default:
      return `(${entry.type})`;
  }
}

/** 条目的**种类**(`/tree` 那一列)。message 细化到 role —— 树上分不清谁说的就没法选。 */
export function entryKind(entry: Entry): string {
  return entry.type === 'message' ? `message/${(entry.message as { role: string }).role}` : entry.type;
}
