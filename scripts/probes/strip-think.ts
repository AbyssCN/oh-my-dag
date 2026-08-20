/**
 * `<think>…</think>` 内联推理段的剥离 —— **纯函数, 零副作用**。
 *
 * ## 为什么单独一个文件(而不是留在 m3-inproc-strip-think.ts 里)
 *
 * 2026-08-14 实测踩到: `fanoutqa-2arm.ts` 只想 import 一个 15 行的纯函数, 而它所在的脚本
 * **顶层就在跑 A/B**(没有 `import.meta.main` 保护)—— 于是一次 import 直接点火 1200 次模型调用,
 * 跑到 100 次才被发现。**能被 import 的东西不许在顶层有副作用**, 这条比"少一个文件"值钱。
 *
 * ## 为什么要剥
 *
 * MiniMax M3 经 minimax-cn 通道把推理**内联在 `text` 字段**里(deepseek / claude / gpt 走单独字段),
 * 而 omd 全仓对 `<think>` 零处理。下游拿到的是"草稿纸 + 交付物"粘在一起的一整块:
 * 严格 `JSON.parse` 当场炸; 宽松抽取(`jsonCandidates`)则会抠到 think 里**被模型自己推翻的草稿**
 * —— 后者不报错, 更危险。
 */

export interface StripThinkResult {
  /** 剥掉闭合 think 段后的正文(未闭合时 = 原文)。 */
  body: string;
  /** 原文里出现过 `<think>`。 */
  hadThink: boolean;
  /** `<think>` 开了没闭 —— 回复在思考中途被 maxTokens 砍断, 正文根本没生成。 */
  unclosed: boolean;
}

/**
 * 剥掉内联推理段。**只剥闭合的**: `<think>` 开了没闭 = 被截断, 那时正文还没生成 ——
 * 把开头那段当草稿剥掉会剩空串, 于是「被截断」伪装成「回了个空的」, 两种失效再也分不开
 * (仓规 §NULL ≠ 0 ≠ 不适用)。所以未闭合时原样返回并标 `unclosed`, 由调用方决定怎么记。
 */
export function stripThink(text: string): StripThinkResult {
  const open = text.indexOf('<think>');
  if (open < 0) return { body: text, hadThink: false, unclosed: false };
  const close = text.indexOf('</think>', open);
  if (close < 0) return { body: text, hadThink: true, unclosed: true };
  const body = (text.slice(0, open) + text.slice(close + '</think>'.length)).trim();
  return { body, hadThink: true, unclosed: false };
}
