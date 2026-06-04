/**
 * identity barrel —— Xihe 视觉身份 (palette + banner + 默认 theme)。
 */
export { XIHE, fg, bold, dim, hexToRgb, RESET, type XiheColor } from './palette';
export { renderXiheBanner, createBannerExtension, type BannerInfo } from './banner';
export {
  ensureXiheTheme,
  XIHE_THEME,
  XIHE_THEME_NAME,
  type EnsureXiheThemeOpts,
  type EnsureXiheThemeResult,
  type EnsureXiheThemeReason,
} from './theme-setup';
