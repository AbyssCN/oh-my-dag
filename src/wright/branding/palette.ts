/**
 * identity/palette —— Xihe 羲和 视觉真理源 (终端 ANSI + theme JSON 共用)。
 *
 * 美学 (rebrand 2026-06-04, 朱砂金太阳): 羲和 = 上古驭日之神。暖 void 底,
 * 朱砂红 (cinnabar) 为签名强调色, 金 (gold) 为强调/标题, 玉 (jade) 为次强调/成功,
 * 米 (rice) 为正文。对照旧 Xihe 冷色暮光 (deep-void/teal/silver), Xihe 是暖色日出。
 *
 * 纯常量 + 纯函数 (无副作用), 可单测 + 被 banner (ANSI) 与 theme-setup (hex JSON) 复用。
 */

/** Xihe 调色板 (hex)。banner 经 truecolor ANSI 用, theme JSON 直接用 hex。 */
export const XIHE = {
  /** 暖 void 底色 (近黑偏暖, 区别 Xihe 冷 #0b0b0a)。 */
  void: '#15100d',
  voidLifted: '#1d1611',
  voidCard: '#221a13',
  /** 朱砂红 —— Xihe 签名强调色。 */
  cinnabar: '#d6452c',
  cinnabarBright: '#ec6a44',
  cinnabarDim: '#9c3422',
  /** 金 —— 强调 / 标题 / 日出顶光。 */
  gold: '#e0a93b',
  goldBright: '#f5d6a0',
  goldMuted: '#b88a35',
  /** 玉 —— 次强调 / 成功 / 边框。 */
  jade: '#84b08a',
  jadeDark: '#5a8466',
  /** 米 —— 正文文本三档。 */
  rice: '#ece1cb',
  riceMuted: '#b8a98c',
  riceDim: '#8a7c66',
  /** 描边 (暖褐)。 */
  border: '#4a3a2c',
} as const;

export type XiheColor = keyof typeof XIHE;

/** hex (#rrggbb) → {r,g,b}。非法 → 全 0 (静默, banner 不该崩)。 */
export function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m?.[1]) return { r: 0, g: 0, b: 0 };
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
}

const ESC = '\x1b[';
export const RESET = `${ESC}0m`;

/** 给一段文本上 truecolor 前景色 (hex 或 XIHE key)。reset 收尾防染色泄漏。 */
export function fg(color: string, text: string): string {
  const hex = (XIHE as Record<string, string>)[color] ?? color;
  const { r, g, b } = hexToRgb(hex);
  return `${ESC}38;2;${r};${g};${b}m${text}${RESET}`;
}

/** 加粗 (常配 fg 用: bold(fg('gold', x)))。 */
export function bold(text: string): string {
  return `${ESC}1m${text}${RESET}`;
}

/** 暗淡 (faint)。 */
export function dim(text: string): string {
  return `${ESC}2m${text}${RESET}`;
}
