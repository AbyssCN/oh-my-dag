/**
 * src/harness/caveman —— 输出压缩规则的**分级 + 路由**(省 output token)。
 *
 * 两个消费面:
 *  - 交互式 omd (TUI): 走 pi-caveman 扩展 (/caveman 命令 + 全局 config), 默认 full (human 可读)。
 *  - executor-dag leaf: 走这里 —— **按 node 意图 per-leaf 注入规则**(全局扩展做不到 per-leaf 路由)。
 *
 * 路由铁律:
 *  - 干活/检索/分析 leaf (output = 叙述) → **full** (2026-07-21 Nick: 从 ultra 降到 full)。
 *    沿革: 2026-06-02 定 ultra ("压到底, 实测零正确性成本"); 07-21 复盘 —— ultra 相对 full 的边际节省是
 *    小尾巴 (去冠词/填充/对冲 full 已拿走大头), 而 ultra 多做的电报体/缩写正是弱模型削 substance 的风险位,
 *    且无 per-node full 出口 → 风险打到每个 analysis leaf。省 token 大头已由 fan-in 定向摘要接管
 *    (扇出≥2 胖输出), per-leaf 松到 full。**ultra 留作 opt-in** (config.cavemanLevel:'ultra', 已知纯叙述且省 token 吃紧时)。
 *  - 创意/文案/best-of-n leaf (output **就是**交付物) → **off** (别压坏创意)。
 * 判据 = node.creative (conductor 标; 缺省 false → 压)。
 *
 * 规则 clean-room 自 mattpocock/caveman SKILL.md + pi-caveman 分级 (off/lite/full/ultra)。
 */
export type CavemanLevel = 'off' | 'lite' | 'full' | 'ultra';

const RULES: Record<CavemanLevel, string> = {
  off: '',
  lite: 'Be concise and professional: no filler, no pleasantries, no preamble. Result first.',
  full:
    'Respond terse like a smart caveman. Drop articles (a/an/the), filler (just/really/basically), ' +
    'pleasantries, hedging. Fragments OK. Arrows for causality (X -> Y). One word when one word enough. ' +
    'Technical terms, code blocks, and error strings stay EXACT. No preamble, no restating inputs.',
  ultra:
    'MAXIMUM compression. Telegraphic — absolute minimum words. Drop everything non-essential: articles, ' +
    'filler, pleasantries, hedging, conjunctions. Fragments. Arrows for causality. Abbreviate (DB/auth/cfg/fn/impl). ' +
    'Technical terms, code, error strings stay EXACT. Output the deliverable CONTENT itself (compressed but COMPLETE) — ' +
    'never collapse a design/description/analysis into a fake execution confirmation, never fabricate data/results/inputs ' +
    'you were not given. A ≤1-line confirmation is ONLY for when a tool/file action was actually performed.',
};

/** 取某 level 的压缩指令文本(off → 空串, 不注入)。 */
export function cavemanRule(level: CavemanLevel): string {
  return RULES[level] ?? '';
}

/**
 * leaf 的 caveman 级路由: 创意节点 → off(护交付物); 否则 → 配置的干活级(默认 full; ultra 为 opt-in)。
 * conductor 经 node.creative 表达"此节点输出即创意交付物"。
 */
export function leafCavemanLevel(creative: boolean | undefined, workLevel: CavemanLevel = 'full'): CavemanLevel {
  return creative ? 'off' : workLevel;
}
