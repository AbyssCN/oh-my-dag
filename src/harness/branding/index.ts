/**
 * identity barrel —— omd 视觉身份 (palette + banner + 默认 theme)。
 */
export { OMD, fg, bold, dim, hexToRgb, RESET, type OmdColor } from './palette';
export { renderBanner, createBannerExtension, type BannerInfo } from './banner';
export {
  ensureOmdTheme,
  OMD_THEME,
  OMD_THEME_NAME,
  type EnsureOmdThemeOpts,
  type EnsureOmdThemeResult,
  type EnsureOmdThemeReason,
} from './theme-setup';
