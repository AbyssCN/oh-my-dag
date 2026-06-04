/**
 * src/wright/learning/user-correction-signal — `user_correction` 信号生产者 (闸门 I 白名单第 4 个 emitter)。
 *
 * 最高价值信号 (用户显式纠正 = 最强教训), 但**无确定性触发** —— 靠 `input` 事件文本启发式。难点 = 精度:
 * "帮我看这段哪里不对" 是**任务**不是纠正。对策 = 要求**第二人称纠错** (你/you + wrongness) 或强纠正短语,
 * 排除单纯问"哪里错"。**精度优先于召回**: 漏掉些纠正 < 把任务误当纠正灌噪声。残余假阳由下游兜底
 * (tentative confidence + 需跨 session 复现才驱动行为 + 情感门 + validateFactWrite), 一次性假纠正会过期。
 *
 * bus-agnostic: onCorrection 回调, emit 在 tui 接 signalBus (镜像 grounding onGrounded / drift onSpinning)。
 * 只认 source==='interactive' (真人输入, 非程序注入)。观测-only, 返 {action:'continue'} 不拦输入。
 */
import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';
import { logger } from '../../logger';

/** excerpt 入信号前截断 (有界 runtime_events row)。 */
const MAX_EXCERPT = 500;
/** 超长输入多半是新任务/粘贴, 不是纠正 → 不判。 */
const MAX_CORRECTION_LEN = 2000;

/**
 * 保守纠正检测 (精度优先)。命中条件 = 第二人称纠错模式 或 强纠正短语。
 * 刻意**不**收单纯 "不对/错了/wrong" (无第二人称 → 多半是问"哪里错"的任务)。
 */
const CORRECTION_PATTERNS: readonly RegExp[] = [
  // 中文: 第二人称 + 纠错
  /你(.{0,8})(错|不对|不该|应该|理解反|搞反|弄反)/,
  // 中文: 强纠正短语 (隐含"你做的不对")
  /不是(这个意思|那个意思|让你|要你|说)/,
  /我(没让你|没要你|说的是|要的是|不是这个意思|不是要)/,
  /(别这样|别这么做|重来|搞反了|弄反了|方向(反|错)了|完全错|你听错|你看错|你写错|你理解错)/,
  // English: 第二人称纠错
  /\byou(?:'?re| are| got| were)?\s+(?:totally\s+)?(?:wrong|incorrect|mistaken)\b/i,
  /\byou\s+(?:should\s+have|misunderstood|got\s+it\s+wrong)\b/i,
  // English: 强纠正短语
  /\bthat'?s\s+(?:not\s+(?:right|correct|what\s+i)|wrong|incorrect)\b/i,
  /\b(?:i\s+(?:didn'?t|never)\s+(?:ask|say|want)|not\s+what\s+i\s+(?:asked|said|meant))\b/i,
  /\b(?:no,?\s+(?:that|you|it)\b|actually\s+no\b)/i,
];

/** true = 该输入像一次对 agent 的纠正 (保守, 精度优先)。 */
export function looksLikeCorrection(text: string): boolean {
  const t = text.trim();
  if (t.length === 0 || t.length > MAX_CORRECTION_LEN) return false;
  return CORRECTION_PATTERNS.some((re) => re.test(t));
}

export interface UserCorrectionSignalOpts {
  /** 检出纠正 → 发信号 (tui 接 signalBus.emit user_correction)。 */
  onCorrection: (info: { excerpt: string }) => void;
}

/** input hook: 真人交互输入 + looksLikeCorrection → onCorrection。观测-only, 失败软降级。 */
export function createUserCorrectionSignalExtension(opts: UserCorrectionSignalOpts): ExtensionFactory {
  return (pi) => {
    pi.on('input', (event) => {
      try {
        const e = event as { text?: string; source?: string };
        if (e.source === 'interactive' && typeof e.text === 'string' && looksLikeCorrection(e.text)) {
          opts.onCorrection({ excerpt: e.text.trim().slice(0, MAX_EXCERPT) });
        }
      } catch (err) {
        logger.debug({ err: String(err) }, '[wright/learning] user_correction signal skip');
      }
      return { action: 'continue' };
    });
  };
}
