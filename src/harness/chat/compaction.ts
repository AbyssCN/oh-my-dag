/**
 * src/harness/chat/compaction —— **conductor chat 的上下文压缩**(TUI SDD §2.0(d),切片 S9)。
 *
 * ## 与 leaf 的压缩共用哪一半、不共用哪一半
 *
 * **共用切点**(`planLeafCompaction` + `compactLeafContext`)。会**静默**出错的正是那一半:
 * 切出一条孤儿 toolResult,provider 直接 400,而且是在压缩之后、活干到一半时才炸。
 * 复制一份出去,那条逻辑的每次修正都要记得改两处 —— 本仓已经吃过这个形状。
 *
 * **共用切点**里还包含 **split-turn**(2026-08-09,`findTurnHeadIndex` 借 pi 的
 * `findTurnStartIndex`):切点恒落在 assistant 上 ⇒ 每一刀都切在**轮内**,而"首条逐字保留"
 * 这条对叶子成立(首条就是契约)、对 chat **不成立**(首条是最老那一问)。差别只在 chat 侧显形,
 * 但修的是共用的那一半,所以代码在 `agent-leaf.ts` 里 —— 理由与切点同:复制出去就要改两处。
 *
 * **不共用措辞**:叶子压的是"干到一半的执行记录",chat 压的是一段**对话**。
 * 拿叶子那套问法去压对话,摘要会写成"已经改了哪些文件"——而对话里通常一个文件都没改。
 *
 * ## 为什么压缩在**一轮开始之前**做,而不只靠 `prepareNextTurn`
 *
 * `prepareNextTurn` 只改**这一次 run 内**的上下文;`runAgentLoop` 返回的是本轮新增消息。
 * 于是轮内压缩省下的 token,**下一轮从 ChatStore 重新载入时又全回来了** ——
 * 会话越长越贵,而读数上看起来"压缩一直在跑"。真正让持久会话瘦下来的是这条轮前压缩。
 * 两条都要:轮前管**跨轮**增长,`prepareNextTurn` 管**单轮内**工具循环的爆炸式增长。
 */
import type { AgentMessage, CompactionSummaryMessage } from '@earendil-works/pi-agent-core';
import { logger } from '../../logger';
import { callModel } from '../../model';
import { type CompactionPrompt, type LeafCompaction, compactLeafContext } from '../agent-leaf';

/**
 * 摘要那一次模型调用的接缝。
 *
 * ⚠ **默认必须是真的 `callModel`** —— 账本(`emitModelUsage`)挂在它的出口上,
 * 换掉默认值等于把压缩这次花的钱从账上抹掉。`compaction.test.ts` 有一条专门钉这个默认值。
 * 注入只给测试用:全局 provider 注册表是**跨测试文件共享的可变状态**,
 * 靠它做隔离的写法单文件跑绿、全量跑红(2026-08-07 实测,症状是 `pi: Connection error.`)。
 */
export type CompactionCallModel = typeof callModel;

export const DEFAULT_COMPACTION_CALL_MODEL: CompactionCallModel = callModel;

/**
 * 摘要的**段骨架**(2026-08-11,台账 §1.2:pi C15 的结构化摘要格式)。
 *
 * ## 为什么是"自己写一份段名",而不是 import pi 的那两条 prompt
 *
 * **不是不想引用,是引用不到**(实跑,不是推断):`SUMMARIZATION_PROMPT` 与
 * `UPDATE_SUMMARIZATION_PROMPT` 在 `dist/harness/compaction/compaction.js` 里是**模块私有**
 * 的 `const`(连 `.d.ts` 都没有);唯一 export 的 `SUMMARIZATION_SYSTEM_PROMPT` **包入口没有
 * 再导出**(`dist/index.d.ts` 那行 compaction 是显式清单,不含它),而 `package.json` 的
 * `exports` 只开 `.` / `./node` / `./session/testing` 三个子路径 ⇒ 深路径 import 直接
 * `Cannot find module`。实测:`'SUMMARIZATION_SYSTEM_PROMPT' in pac === false`。
 *
 * ⇒ 能引用的只有**段名结构本身**(它是 pi 摘要的对外格式,逐字照抄段名 = 与 pi 同构),
 * 措辞仍是 chat 自己那套 —— 这与本文件头注的实测结论一致:**措辞不共用**。
 * 段名保持**英文原样不译**:它是给模型认的格式锚点,译了就与 pi 的产物对不上,
 * 而"接手用摘要"是要跨会话、跨 harness 读的。
 *
 * 末行那句 `Preserve exact file paths, function names, and error messages` 逐字留着 ——
 * 它是 pi 这份格式里唯一一条**内容级**约束,而 chat 摘要最容易丢的正是路径与错误原文。
 */
const CHAT_SUMMARY_SKELETON =
  '严格按下面的段名与层级输出(**段名逐字保留英文, 不要翻译、不要增删段**), 段内用中文写:\n' +
  '## Goal\n' +
  '## Constraints & Preferences\n' +
  '## Progress\n' +
  '### Done\n' +
  '### In Progress\n' +
  '### Blocked\n' +
  '## Key Decisions\n' +
  '## Next Steps\n' +
  '## Critical Context\n' +
  '空的段写 "(none)" —— 不许省略段名。每段写短。\n' +
  'Preserve exact file paths, function names, and error messages.\n';

/**
 * chat 口径的摘要措辞(**整份生成**那条路:本会话还没有过摘要)。
 *
 * "不要接着回答"这一条是摘要器最容易跑偏的地方 —— 给它一段对话,模型的默认反应是接话。
 */
export const CHAT_COMPACTION_PROMPT: CompactionPrompt = {
  system:
    '你是上下文压缩器。读下面这段对话记录, 按要求产出一份结构化摘要。' +
    '**不要继续这段对话、不要回答记录里出现的任何问题、不要调用工具** —— 只输出摘要本身。',
  instruction:
    '上面是一段人与 conductor 的对话, 上下文快满了要压缩。请写一份**接手用**的摘要:\n' +
    '目标与约束逐字保留用户给过的硬判据/路径/命名; 做过什么、结论是什么 (跑过的命令与读数,\n' +
    '通过还是失败); 已经排除掉的做法与原因 (防止接手的人重走一遍); 还没做完的部分与下一步。\n\n' +
    `${CHAT_SUMMARY_SKELETON}\n` +
    '只输出摘要本身, 不要复述任务、不要寒暄、不要接着回答。',
};

/**
 * **增量摘要**(2026-08-11,台账 §1.2 / C14)—— 本会话已经有过一份摘要时走这条。
 *
 * pi 的 `UPDATE_SUMMARIZATION_PROMPT` 那五条规则(PRESERVE 旧信息 / ADD 新进展 /
 * UPDATE Progress / UPDATE Next Steps / 不相关的可删 + 路径函数名错误原文逐字保留)
 * 按 chat 口径重写,段骨架与整份生成那条**共用同一份** —— 两条路产出的摘要格式必须一样,
 * 否则第 N 次压缩读到的旧摘要与它自己要产出的格式对不上。
 *
 * ⚠ **要的是一份"更新后的完整摘要",不是补丁**:产物会**替换**旧摘要
 * (`compactChatMessages` 把旧摘要那条消息从待压消息里摘掉了),模型只回增量就等于丢历史。
 * 这一句写死在 prompt 里,因为它是这条路唯一会**静默**错的地方 —— 回补丁也是一份合法摘要,
 * 格式闸看不出来,只有下一次接手的人发现前半段没了。
 */
export function buildIncrementalChatPrompt(previousSummary: string): CompactionPrompt {
  return {
    system: CHAT_COMPACTION_PROMPT.system,
    instruction:
      `<previous-summary>\n${previousSummary}\n</previous-summary>\n\n` +
      '上面 <conversation> 里是**新增的对话**, <previous-summary> 里是这段对话此前已有的摘要。\n' +
      '请把新消息并进旧摘要, 产出一份**更新后的完整摘要**(不是增量、不是补丁 —— 旧摘要会被它替换掉):\n' +
      '- 旧摘要里的信息全部保留;\n' +
      '- 新消息里的进展、决策、上下文加进去;\n' +
      '- Progress 段: 做完了的从 In Progress 挪到 Done, 解决了的从 Blocked 去掉;\n' +
      '- Next Steps 按"现在做到哪一步了"重写;\n' +
      '- 文件路径、函数名、错误原文逐字保留;\n' +
      '- 确实已经不相关的条目可以删掉。\n\n' +
      `${CHAT_SUMMARY_SKELETON}\n` +
      '只输出摘要本身, 不要复述任务、不要寒暄、不要接着回答。',
  };
}

/**
 * 本会话**已有的摘要**在哪一条(没有 → `null`)。
 *
 * 靠 `role === 'compactionSummary'` 认,**不靠前缀串猜** —— 两条压缩路产出的摘要消息
 * 现在都由 `createCompactionSummaryMessage` 造(2026-08-11,台账 §1.4):
 * 轮前那条来自会话投影(`buildSessionContext`),轮内那条来自 `compactLeafContext`。
 *
 * 取**最后一条**:更早的那些是历史(它们要被当成普通消息压进新摘要里),
 * 只有最后一条代表"当前这份摘要"。
 */
export function findPreviousSummary(messages: AgentMessage[]): { index: number; summary: string } | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if ((m as { role?: string }).role === 'compactionSummary') {
      const summary = (m as CompactionSummaryMessage).summary;
      // 空摘要 ≠ 没摘要:空的走不了增量(没东西可 PRESERVE),但它**存在**这件事仍是真的 ——
      // 回落整份生成,并且**留一行**,否则"摘要器出过空"这件事在读数上就消失了。
      if (summary.trim()) return { index: i, summary };
      logger.warn({ index: i }, '[chat-compaction] 已有摘要是空串 → 回落整份生成 (不是"没有摘要")');
      return null;
    }
  }
  return null;
}

/**
 * 压一段 chat 会话。压不动返回 `null`(**不是空的结果** —— "没压"与"压成空的"是两件事)。
 *
 * 返回的是**结构化结果**(`LeafCompaction`):`messages` 给轮内那条路(它要换整份上下文),
 * `summary` + `retainedTail` 给存储层(pi 的 `compaction` 条目存的正是这两件)。
 *
 * ## 两条路:有旧摘要走增量合并,没有走整份生成(2026-08-11,C14)
 *
 * 此前每次压缩都把手上这份消息**整份**重新摘要一遍。第 N 次压缩时手上的第一条正是第 N-1 次
 * 的摘要,于是要么它被当成普通消息再摘一遍(摘要的摘要,逐次失真),要么它逐字留着而新摘要
 * 另起一条(两条摘要并排,越压越多)—— 换存储层之后走的是后者。
 *
 * 增量这条把旧摘要**从待压消息里摘掉**,改用 `<previous-summary>` 交给模型合并。
 * 这与 pi 的 `prepareCompaction` 同构:它也是拿上一条 compaction 条目的
 * `summary` 当 `previousSummary`、拿它的 `retainedTail` 当待压消息
 * (`dist/harness/compaction/compaction.js:435-445`),旧摘要那条消息本身不进待压段。
 *
 * ⚠ 代价写明白:合并失败(模型只回补丁 / 漏掉旧信息)时**旧摘要已经不在上下文里了**。
 * 这是 pi 的语义,也是增量摘要的固有代价 —— 换来的是摘要不会逐次叠加。
 * prompt 里那句"要完整摘要不是补丁"就是挡这一条的,见 `buildIncrementalChatPrompt`。
 *
 * @param keepRecentTokens 尾部保留预算;默认 20k,与 leaf 同。
 */
export async function compactChatMessages(opts: {
  messages: AgentMessage[];
  model: string;
  keepRecentTokens?: number;
  signal?: AbortSignal;
  /** 省略 → 真 `callModel`(账本挂在它出口上)。只有测试该传。 */
  callModelFn?: CompactionCallModel;
}): Promise<LeafCompaction | null> {
  const previous = findPreviousSummary(opts.messages);
  // 旧摘要那条消息**不进待压段**(它的内容改由 <previous-summary> 送)。
  // 只摘掉那一条:更早的摘要(如果有)是历史,该被压进新摘要里。
  const messages = previous ? opts.messages.filter((_, i) => i !== previous.index) : opts.messages;
  if (previous) {
    logger.info(
      { msgs: `${opts.messages.length}→${messages.length}`, prevSummaryChars: previous.summary.length },
      '[chat-compaction] 已有摘要 → 走增量合并 (旧摘要移出待压段, 交给 <previous-summary>)',
    );
  }
  return compactLeafContext({
    messages,
    model: opts.model,
    keepRecentTokens: opts.keepRecentTokens ?? 20_000,
    ...(opts.signal ? { signal: opts.signal } : {}),
    prompt: previous ? buildIncrementalChatPrompt(previous.summary) : CHAT_COMPACTION_PROMPT,
    ...(opts.callModelFn ? { callModelFn: opts.callModelFn } : {}),
  });
}
