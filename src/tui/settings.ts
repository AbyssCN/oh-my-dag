/**
 * src/tui/settings —— **设置面板**(2026-08-07,owner 指出"设置完全没有")。
 *
 * ## 只列**真的有数**的东西
 *
 * 一个设置面板最容易变成一堆"看起来能调、点了没反应"的行 —— 那正是本仓断链说明卡
 * 禁止的东西。所以这里每一项都必须能回答两句话:**现在是什么值**、**改了会怎样**。
 * 答不上来的项**不进这张表**。
 *
 * 于是它同时是一张**诚实的现状表**:扩展被拒了就写被拒和缺什么;字形没在真终端量过
 * 就写"未量";座位解析不出来就写"未解析"。
 */
import { GROUND_TRUTH, NEEDS_TTY_GLYPHS, SAFE_GLYPH_WIDTHS, UNSAFE_GLYPHS } from './render/glyph-table';
import type { ContextPressure } from '../harness/chat/usage';
import { humanTokens } from './render/pressure';

/** 面板里一项。`action` 为空 = **只读的现状行**,选中它什么都不做(而且它说得出为什么)。 */
export interface SettingItem {
  key: string;
  label: string;
  /** 当前值。查不到时写"未解析"之类的**真话**,不留空。 */
  value: string;
  detail?: string;
  /** 能改的项才有;只读行没有。 */
  action?: 'seat' | 'session' | 'extensions';
}

export interface SettingsInput {
  seats: Record<string, string>;
  seatsError: string | null;
  sessionId: string;
  sessionCount: number | null;
  pressure: ContextPressure | null;
  color: boolean;
  truecolor: boolean;
  extensions: { name: string; ok: boolean; sandboxed?: boolean; missing?: string[] }[];
}

export function buildSettings(i: SettingsInput): SettingItem[] {
  const items: SettingItem[] = [];

  // ── 座位 ────────────────────────────────────────────────────────────────────
  for (const role of ['conductor', 'leaf', 'verifier']) {
    items.push({
      key: `seat:${role}`,
      label: `座位 ${role}`,
      value: i.seats[role] ?? (i.seatsError ? '(解析不到)' : '(未配)'),
      ...(i.seatsError && !i.seats[role] ? { detail: i.seatsError } : {}),
      action: 'seat',
    });
  }

  // ── 会话 ────────────────────────────────────────────────────────────────────
  items.push({
    key: 'session',
    label: '当前会话',
    value: i.sessionId,
    // `null` = 还没问过后端(与"一条都没有"分得开)。
    ...(i.sessionCount === null ? { detail: '已存会话数: 未读' } : { detail: `已存会话数: ${i.sessionCount}` }),
    action: 'session',
  });

  // ── 上下文压力(只读) ───────────────────────────────────────────────────────
  items.push(
    i.pressure && i.pressure.usedTokens > 0
      ? {
          key: 'ctx',
          label: '上下文',
          value:
            i.pressure.ratio === null
              ? `${humanTokens(i.pressure.usedTokens)}(窗口未知)`
              : `${humanTokens(i.pressure.usedTokens)}/${humanTokens(i.pressure.windowTokens)} ${Math.round(i.pressure.ratio * 100)}%`,
          detail: `system ${humanTokens(i.pressure.systemTokens)} · harness ${humanTokens(i.pressure.harnessTokens)} · 历史 ${humanTokens(i.pressure.historyTokens)}`,
        }
      : // 还没跑过一轮 —— 说真话, 不画一行 0。
        { key: 'ctx', label: '上下文', value: '(还没跑过一轮)' },
  );

  // ── 主题与字形(只读) ───────────────────────────────────────────────────────
  items.push({
    key: 'theme',
    label: '配色',
    value: !i.color ? '关(NO_COLOR)' : i.truecolor ? 'Catppuccin Mocha(24 位)' : '16 色回退',
    detail: i.color && !i.truecolor ? '终端没报 COLORTERM=truecolor → 回退,不照发 24 位码' : undefined,
  });
  items.push({
    key: 'glyphs',
    label: '字形白名单',
    value: `${SAFE_GLYPH_WIDTHS.size} 可用 / ${NEEDS_TTY_GLYPHS.size} 待量 / ${UNSAFE_GLYPHS.size} 不用`,
    detail: GROUND_TRUTH
      ? '已在真终端量过'
      : '⚠ **未在真终端量过** —— 跑 `bun run scripts/tui-glyph-probe.ts --tty` 解锁 box drawing',
  });

  // ── 扩展 ────────────────────────────────────────────────────────────────────
  if (i.extensions.length === 0) {
    items.push({
      key: 'ext',
      label: '扩展',
      value: '(没配)',
      detail: '清单在 .omd/extensions.json',
      action: 'extensions',
    });
  } else {
    const ok = i.extensions.filter((e) => e.ok);
    const bad = i.extensions.filter((e) => !e.ok);
    items.push({
      key: 'ext',
      label: '扩展',
      value: `${ok.length} 已装 / ${bad.length} 被拒`,
      // 被拒的**说出缺什么** —— 这就是加载期硬失败的价值,藏在日志里就白做了。
      detail: bad.length > 0 ? `被拒: ${bad.map((e) => `${e.name}(缺 ${(e.missing ?? []).join('、') || '未知'})`).join(' · ')}` : undefined,
      action: 'extensions',
    });
  }

  return items.filter((x) => x.detail !== undefined || true);
}

/** 渲染成给对话记录看的文本(选择器之外还留一份可回看的痕)。 */
export function formatSettings(items: readonly SettingItem[]): string {
  const rows = items.map((s) => `  ${s.label}: ${s.value}${s.detail ? `\n      ${s.detail}` : ''}`);
  return `设置(可改的项在选择器里挑):\n${rows.join('\n')}`;
}

export function parseSettingsCommand(text: string): boolean {
  const t = text.trim();
  return t === '/settings' || t === '/set' || t === '/config';
}
