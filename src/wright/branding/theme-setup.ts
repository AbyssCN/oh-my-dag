/**
 * identity/theme-setup —— 默认 Xihe theme 注入 pi (镜像 keybindings-setup 模式)。
 *
 * pi theme = JSON in getCustomThemesDir() (= getAgentDir()/themes/), 由 settings.json
 * 的 `theme` 字段选中。无扩展运行时 setTheme API → boot 前 (main() 之前) 落盘:
 *   ① 写 themes/xihe.json (总覆盖 — 这是 OUR theme, 跟 palette 真理源保持一致)
 *   ② settings.json `theme` 未设 → 设 'xihe' (非破坏性: 用户显式选过别的主题则不动)
 * 写在 main() 前 → 本次 boot 的 SettingsManager/ResourceLoader 即读到。
 *
 * 配色见 [[palette]] (Xihe 朱砂金太阳)。结构照 pi dark.json schema 重着色: 暖 void 底,
 * cinnabar 签名 accent, gold 标题/边框强调, jade 成功/次边框, rice 正文。
 */
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { XIHE } from './palette';

export const XIHE_THEME_NAME = 'xihe';

/** Xihe theme JSON (pi theme-schema)。暖色日出版 dark theme。 */
export const XIHE_THEME = {
  name: XIHE_THEME_NAME,
  vars: {
    cinnabar: XIHE.cinnabar,
    cinnabarBright: XIHE.cinnabarBright,
    gold: XIHE.gold,
    goldBright: XIHE.goldBright,
    jade: XIHE.jade,
    jadeDark: XIHE.jadeDark,
    rice: XIHE.rice,
    riceMuted: XIHE.riceMuted,
    riceDim: XIHE.riceDim,
    border: XIHE.border,
    selectedBg: '#2e2118',
    userMsgBg: '#241c14',
    toolPendingBg: '#26201a',
    toolSuccessBg: '#1f2a1f',
    toolErrorBg: '#33201a',
    customMsgBg: '#2a1f16',
  },
  colors: {
    accent: 'cinnabar',
    border: 'border',
    borderAccent: 'gold',
    borderMuted: '#3a2e22',
    success: 'jade',
    error: 'cinnabar',
    warning: 'gold',
    muted: 'riceMuted',
    dim: 'riceDim',
    text: 'rice',
    thinkingText: 'riceMuted',

    selectedBg: 'selectedBg',
    userMessageBg: 'userMsgBg',
    userMessageText: 'rice',
    customMessageBg: 'customMsgBg',
    customMessageText: 'rice',
    customMessageLabel: 'gold',
    toolPendingBg: 'toolPendingBg',
    toolSuccessBg: 'toolSuccessBg',
    toolErrorBg: 'toolErrorBg',
    toolTitle: 'rice',
    toolOutput: 'riceMuted',

    mdHeading: 'goldBright',
    mdLink: 'jade',
    mdLinkUrl: 'riceDim',
    mdCode: 'cinnabarBright',
    mdCodeBlock: 'jade',
    mdCodeBlockBorder: 'border',
    mdQuote: 'riceMuted',
    mdQuoteBorder: 'jadeDark',
    mdHr: 'border',
    mdListBullet: 'cinnabar',

    toolDiffAdded: 'jade',
    toolDiffRemoved: 'cinnabar',
    toolDiffContext: 'riceMuted',

    syntaxComment: 'riceDim',
    syntaxKeyword: 'cinnabarBright',
    syntaxFunction: 'goldBright',
    syntaxVariable: 'rice',
    syntaxString: 'jade',
    syntaxNumber: 'gold',
    syntaxType: 'jadeDark',
    syntaxOperator: 'riceMuted',
    syntaxPunctuation: 'riceMuted',

    thinkingOff: '#4a3a2c',
    thinkingMinimal: '#6e5d48',
    thinkingLow: 'jadeDark',
    thinkingMedium: 'jade',
    thinkingHigh: 'gold',
    thinkingXhigh: 'cinnabarBright',

    bashMode: 'jade',
  },
  export: {
    pageBg: XIHE.void,
    cardBg: XIHE.voidCard,
    infoBg: '#2a2018',
  },
} as const;

export interface EnsureXiheThemeOpts {
  /** pi agent dir。省略 = getAgentDir() (尊重 PI_CODING_AGENT_DIR)。测试注入临时目录。 */
  agentDir?: string;
  /** themes 目录。省略 = <agentDir>/themes (= pi getCustomThemesDir())。 */
  themesDir?: string;
}

export type EnsureXiheThemeReason =
  | 'applied' // 写了 theme 文件 + 设为默认
  | 'theme-only' // 写了 theme 文件, 但用户已显式选别的主题 → 不抢默认
  | 'noop' // theme 文件已最新 + 默认已是 xihe
  | 'write-error';

export interface EnsureXiheThemeResult {
  themePath: string;
  settingsPath: string;
  reason: EnsureXiheThemeReason;
  /** 是否设/保持 xihe 为默认主题。 */
  isDefault: boolean;
}

/**
 * 确保 Xihe theme 可用并 (在用户没显式选别的主题时) 设为默认。幂等 + 非破坏性。
 */
export function ensureXiheTheme(opts: EnsureXiheThemeOpts = {}): EnsureXiheThemeResult {
  const agentDir = opts.agentDir ?? getAgentDir();
  const themesDir = opts.themesDir ?? join(agentDir, 'themes');
  const themePath = join(themesDir, `${XIHE_THEME_NAME}.json`);
  const settingsPath = join(agentDir, 'settings.json');
  const themeJson = `${JSON.stringify(XIHE_THEME, null, 2)}\n`;

  // ① theme 文件: 仅在内容有变时写 (幂等 — 避免每 boot 触碰 mtime)。
  let themeChanged = true;
  if (existsSync(themePath)) {
    try {
      themeChanged = readFileSync(themePath, 'utf8') !== themeJson;
    } catch {
      themeChanged = true;
    }
  }
  try {
    if (themeChanged) {
      mkdirSync(themesDir, { recursive: true });
      writeFileSync(themePath, themeJson, 'utf8');
    }
  } catch {
    return { themePath, settingsPath, reason: 'write-error', isDefault: false };
  }

  // ② settings.json `theme`: 未设 → 设 xihe; 已是 xihe → 保持; 用户选了别的 → 不抢。
  let settings: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    try {
      const parsed = JSON.parse(readFileSync(settingsPath, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        settings = parsed as Record<string, unknown>;
      }
    } catch {
      // 坏 settings.json → 不覆盖用户文件; 只保证 theme 文件可用 (用户可手动选)。
      return { themePath, settingsPath, reason: themeChanged ? 'theme-only' : 'noop', isDefault: false };
    }
  }

  const currentTheme = settings.theme;
  if (currentTheme !== undefined && currentTheme !== XIHE_THEME_NAME) {
    // 用户显式选了别的主题 → 尊重, 只保证 xihe theme 文件在 (可 /theme 切回)。
    return { themePath, settingsPath, reason: themeChanged ? 'theme-only' : 'noop', isDefault: false };
  }

  if (currentTheme === XIHE_THEME_NAME && !themeChanged) {
    return { themePath, settingsPath, reason: 'noop', isDefault: true };
  }

  settings.theme = XIHE_THEME_NAME;
  try {
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  } catch {
    return { themePath, settingsPath, reason: 'write-error', isDefault: false };
  }
  return { themePath, settingsPath, reason: 'applied', isDefault: true };
}
