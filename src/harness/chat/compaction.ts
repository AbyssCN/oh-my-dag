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
import type { AgentMessage } from '@earendil-works/pi-agent-core';
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
 * chat 口径的摘要措辞。
 *
 * "不要接着回答"这一条是摘要器最容易跑偏的地方 —— 给它一段对话,模型的默认反应是接话。
 */
export const CHAT_COMPACTION_PROMPT: CompactionPrompt = {
  system:
    '你是上下文压缩器。读下面这段对话记录, 按要求产出一份结构化摘要。' +
    '**不要继续这段对话、不要回答记录里出现的任何问题、不要调用工具** —— 只输出摘要本身。',
  instruction:
    '上面是一段人与 conductor 的对话, 上下文快满了要压缩。请写一份**接手用**的摘要, 覆盖:\n' +
    '① 用户要什么 (目标与约束, 逐字保留他给过的硬判据/路径/命名);\n' +
    '② 已经做过什么、结论是什么 (跑过的命令与读数, 通过还是失败);\n' +
    '③ 已经排除掉的做法与原因 (防止接手的人重走一遍);\n' +
    '④ **还没做完的部分**, 以及下一步该做什么。\n' +
    '只输出摘要本身, 不要复述任务、不要寒暄、不要接着回答。',
};

/**
 * 压一段 chat 会话。压不动返回 `null`(**不是空的结果** —— "没压"与"压成空的"是两件事)。
 *
 * 返回的是**结构化结果**(`LeafCompaction`):`messages` 给轮内那条路(它要换整份上下文),
 * `summary` + `retainedTail` 给存储层(pi 的 `compaction` 条目存的正是这两件)。
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
  return compactLeafContext({
    messages: opts.messages,
    model: opts.model,
    keepRecentTokens: opts.keepRecentTokens ?? 20_000,
    ...(opts.signal ? { signal: opts.signal } : {}),
    prompt: CHAT_COMPACTION_PROMPT,
    ...(opts.callModelFn ? { callModelFn: opts.callModelFn } : {}),
  });
}
