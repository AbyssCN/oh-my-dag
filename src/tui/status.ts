/**
 * src/tui/status —— `/status` 的纯渲染面。
 *
 * 只读零副作用:四段读数全部由调用方(tui.ts handleStatus)用既有读径
 * (config 座位 / 当前 session / lastPressure / 账本)组装后传入,
 * 本文件只做格式化。拿不到的数据调用方传 `null`,这里写真话,不编数。
 *
 * 账本"今日用量":ledger 只有滚动窗口(`window()`),**没有日级汇总读 API** ——
 * 调用方拿不到就传 `null`,这里写 `(no daily readout available)`。
 * 不为这条给 ledger 加聚合(超范围)。
 */
import type { ContextPressure } from '../harness/chat/usage';
import { humanTokens } from './render/pressure';

export interface StatusInput {
  /** conductor 座位坐标;未配置 = null。 */
  seat: string | null;
  /** 当前会话 id。 */
  sessionId: string;
  /** 最近一次轮的上下文压力;没跑过轮 = null。 */
  pressure: ContextPressure | null;
  /** 账本今日用量(调用方格式化好的串);无日级读数 = null。 */
  usageToday: string | null;
}

/**
 * 一屏当前状态,四行,每行读不到就写真话。
 * ctx 行形状照 /settings 面板 (settings.ts) 的 context 行;
 * ratio === null 时**不画百分比** (statusbar 同纪律:窗口未知 ≠ 0%,不拿编的分母算)。
 */
export function formatStatus(o: StatusInput): string {
  return [
    o.seat ? `conductor: ${o.seat}` : 'conductor: (no seat configured)',
    `session: ${o.sessionId}`,
    formatContext(o.pressure),
    o.usageToday ? `usage today: ${o.usageToday}` : 'usage today: (no daily readout available)',
  ].join('\n');
}

function formatContext(p: ContextPressure | null): string {
  if (!p || p.usedTokens <= 0) return 'context: no turn yet';
  // 估算值标注出来:「准不准」是渲染面必须如实转述的一部分,不是内部细节。
  const tag = p.source === 'estimate' ? ' (est.)' : '';
  if (p.ratio === null) return `context: ${humanTokens(p.usedTokens)} (window unknown)${tag}`;
  return `context: ${humanTokens(p.usedTokens)}/${humanTokens(p.windowTokens)} ${Math.round(p.ratio * 100)}%${tag}`;
}
