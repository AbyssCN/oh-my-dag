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
import { CORE_SEATS } from './seat-picker';
import { TUNABLE_CONFIG_ROLES } from '../harness/init/headless-config';

/** 面板里一项。`action` 为空 = **只读的现状行**,选中它什么都不做(而且它说得出为什么)。 */
export interface SettingItem {
  key: string;
  label: string;
  /** 当前值。查不到时写"未解析"之类的**真话**,不留空。 */
  value: string;
  detail?: string;
  /** 能改的项才有;只读行没有。 */
  action?: 'seat' | 'session' | 'extensions' | 'ui-sidebar' | 'ui-painter' | 'login';
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
  // ── 切片⑥ (v5 第五节): 可改项。**省略 = 那一组不进表**(答不上现状的项不列)。──
  /** 界面组: 左栏开关 + 全屏默认画法(运行时值; 写盘走 tui.ui)。 */
  ui?: { sidebar: boolean; painterName: string };
  /**
   * 沙箱组(2026-08-13,替掉审批组):bwrap 围栏的**探测读数**。
   *
   * ⚠ **只读行,没有 action** —— 开关在 `.omd/config.json` 的 `tui.sandbox`,
   * 面板里改不了它是刻意的:这一行要回答的是「现在到底有没有围栏」,
   * 而那是一次探测的结果,不是一个偏好。
   */
  sandbox?: { ok: boolean; reason?: string };
  /** provider 组: 已配/未配(**只显示配没配, 不显示 key**)。 */
  providers?: { id: string; hasKey: boolean }[];
  /**
   * advisor 组 (2026-08-10, owner 点名可配): seat → 当前 advisor 坐标。
   * 键**缺席 = 无 advisor**(与"配了"分得开, NULL≠0); 整组省略 = 不进表(同上面的约定)。
   */
  advisors?: Record<string, string | undefined>;
}

export function buildSettings(i: SettingsInput): SettingItem[] {
  const items: SettingItem[] = [];

  // ── 座位 ────────────────────────────────────────────────────────────────────
  // ★ 两种形态 (2026-08-10 座位真源切片: 全座位可调, 座位组铺全量):
  //
  //   * **座位面板** (`/seat`, 输入只有座位相关组): 列**全量**可调座位 —— 它是
  //     "改哪个座位"的入口, 藏座位就是藏能力。**不带描述区**: 每行挂 seatsError
  //     长描述会把面板顶到 ~26 行, 30 行终端里对话区只剩 2 行, `/seat` 回执
  //     (3 核心座 + 用法) 被挤出视口 —— S12-1/S12-2 PTY 实跑钉的。错误原因
  //     在回执的通知里 (handleSeat 的 seatUnresolved), 信息没丢。
  //   * **主表** (`/settings`, 输入带 ui/approval/providers 组): 只列 3 核心座
  //     (CORE_SEATS) + 一行「N more seats — open /seat」。全量 16 座铺进来, 窗口按
  //     行数走 (tui.ts maxVisible = items.length) 会顶穿 30 行终端: 座位组 16 行 +
  //     advisor/session/ctx/theme/glyphs/ui/approval/providers/ext ≈ 30 行, 再加面板
  //     边框必溢出 (SET-1 同族事故)。/settings 是概览, 改座位有专门入口 (/seat 面板)。
  //     描述区 (seatsError) 只在这里给 —— 它同时是 settings.test.ts 钉的「答得出现状」。
  //
  // ⚠ 两种形态靠 `ui === undefined && sessionCount === null` 区分: /seat 面板的
  //   输入永远只有座位相关组 (无 ui、sessionCount 恒 null); /settings 主表永远带
  //   ui 组 (tui.ts 的 openSeatPanel / settingsOnce 两个调用点)。只此两个调用点 ——
  //   加第三个调用点前先想清楚它要哪种形态。
  const seatPanelShape = i.ui === undefined && i.sessionCount === null;
  const seatGroup = seatPanelShape ? TUNABLE_CONFIG_ROLES : CORE_SEATS;
  for (const role of seatGroup) {
    items.push({
      key: `seat:${role}`,
      label: `seat ${role}`,
      value: i.seats[role] ?? (i.seatsError ? '(unresolved)' : '(not set)'),
      ...(!seatPanelShape && i.seatsError && !i.seats[role] ? { detail: i.seatsError } : {}),
      action: 'seat',
    });
  }
  if (!seatPanelShape) {
    // 只读行 (无 action): 不占座位子层, 指向 /seat 面板 —— 全量在那里。
    items.push({
      key: 'seat:more',
      label: 'more seats',
      value: `${TUNABLE_CONFIG_ROLES.length - CORE_SEATS.length} more seats`,
      detail: 'open /seat to view and change all seats',
    });
  }

  // ── 会话 ────────────────────────────────────────────────────────────────────
  items.push({
    key: 'session',
    label: 'current session',
    value: i.sessionId,
    // `null` = 还没问过后端(与"一条都没有"分得开)。
    ...(i.sessionCount === null ? { detail: 'stored sessions: unread' } : { detail: `stored sessions: ${i.sessionCount}` }),
    action: 'session',
  });

  // ── 上下文压力(只读) ───────────────────────────────────────────────────────
  items.push(
    i.pressure && i.pressure.usedTokens > 0
      ? {
          key: 'ctx',
          label: 'context',
          value:
            i.pressure.ratio === null
              ? `${humanTokens(i.pressure.usedTokens)} (window unknown)`
              : `${humanTokens(i.pressure.usedTokens)}/${humanTokens(i.pressure.windowTokens)} ${Math.round(i.pressure.ratio * 100)}%`,
          detail: `system ${humanTokens(i.pressure.systemTokens)} · harness ${humanTokens(i.pressure.harnessTokens)} · history ${humanTokens(i.pressure.historyTokens)} · ${i.pressure.source === 'usage' ? 'real usage' : 'estimated'}`,
        }
      : // 还没跑过一轮 —— 说真话, 不画一行 0。
        { key: 'ctx', label: 'context', value: '(no turn run yet)' },
  );

  // ── 主题与字形(只读) ───────────────────────────────────────────────────────
  items.push({
    key: 'theme',
    label: 'colors',
    value: !i.color ? 'off (NO_COLOR)' : i.truecolor ? 'Catppuccin Mocha (24-bit)' : '16-color fallback',
    detail: i.color && !i.truecolor ? 'terminal did not report COLORTERM=truecolor -> fall back instead of emitting 24-bit codes' : undefined,
  });
  items.push({
    key: 'glyphs',
    label: 'glyph whitelist',
    value: `${SAFE_GLYPH_WIDTHS.size} usable / ${NEEDS_TTY_GLYPHS.size} unmeasured / ${UNSAFE_GLYPHS.size} rejected`,
    detail: GROUND_TRUTH
      ? 'measured on a real terminal'
      : '⚠ **not measured on a real terminal** - run `bun run scripts/tui-glyph-probe.ts --tty` to unlock box drawing',
  });

  // ── 界面(切片⑥, 写 tui.ui)────────────────────────────────────────────────
  if (i.ui) {
    items.push({
      key: 'ui-sidebar',
      label: 'DAG sidebar default',
      value: i.ui.sidebar ? 'on' : 'off',
      detail: 'written to tui.ui.sidebar in .omd/config.json; effective in this process',
      action: 'ui-sidebar',
    });
    items.push({
      key: 'ui-painter',
      label: 'fullscreen default view',
      value: i.ui.painterName,
      detail: 'written to tui.ui.painter; effective in this process',
      action: 'ui-painter',
    });
  }

  // ── 沙箱(2026-08-13, 只读行: 答「现在有没有围栏」)────────────────────────────
  if (i.sandbox) {
    items.push({
      key: 'sandbox',
      label: 'shell sandbox',
      value: i.sandbox.ok ? 'bwrap on' : `off - ${i.sandbox.reason ?? 'unknown'}`,
      // ⚠ 这里**不写 markdown**:选择器的 description 是纯文本, `**x**` 会原样带着星号上屏
      //   (2026-08-08 帧库实测抓到的)。要强调就用词序,不用星号。
      detail:
        'bwrap confines every shell command: the working root and /tmp are writable, everything else is read-only. ' +
        'Irreversible commands (recursive force-delete, DROP TABLE, git push --force) are refused whether or not the sandbox is up. ' +
        'Configure it in .omd/config.json under tui.sandbox (enabled / writable / allow / deny).',
    });
  }

  // ── provider(切片⑥, 只显示配没配, 不显示 key)───────────────────────────────
  if (i.providers) {
    const got = i.providers.filter((p) => p.hasKey);
    const missing = i.providers.filter((p) => !p.hasKey);
    items.push({
      key: 'providers',
      label: 'provider credentials',
      value: i.providers.length === 0 ? '(none found)' : `${got.length} configured / ${missing.length} missing`,
      detail: `${got.map((p) => p.id).join(', ') || 'none'}${missing.length > 0 ? ` · missing: ${missing.map((p) => p.id).join(', ')}` : ''} - select this row to open /login`,
      action: 'login',
    });
  }

  // ── 扩展 ────────────────────────────────────────────────────────────────────
  if (i.extensions.length === 0) {
    items.push({
      key: 'ext',
      label: 'extensions',
      value: '(not configured)',
      detail: 'manifest lives in .omd/extensions.json',
      action: 'extensions',
    });
  } else {
    const ok = i.extensions.filter((e) => e.ok);
    const bad = i.extensions.filter((e) => !e.ok);
    items.push({
      key: 'ext',
      label: 'extensions',
      value: `${ok.length} loaded / ${bad.length} rejected`,
      // 被拒的**说出缺什么** —— 这就是加载期硬失败的价值,藏在日志里就白做了。
      detail: bad.length > 0 ? `rejected: ${bad.map((e) => `${e.name}(缺 ${(e.missing ?? []).join('、') || 'unknown'})`).join(' · ')}` : undefined,
      action: 'extensions',
    });
  }

  // ── advisor(座位属性, NOTES 2026-08-10 裁决;消费点 conductor chat / leaf 装配)──────
  // ⚠ 排在**面板尾部**而不是座位组后面: 首屏可见窗有限, 排前面会把 glyph 行挤出首绘
  //   (SET-1 实测红过)。/seat 面板按 action==='seat' 过滤, 顺序仍是 座位→advisor, 不受影响。
  if (i.advisors) {
    for (const seat of Object.keys(i.advisors)) {
      items.push({
        // `seat:advisor.<seat>`: 面板的座位子层按 `seat:` 前缀提取 role → 同一个模型选单,
        // 不为 advisor 再造一条子层。applySetting 按 `advisor.` 再分流到 persistSeatAdvisor。
        key: `seat:advisor.${seat}`,
        label: `advisor ${seat}`,
        value: i.advisors[seat] ?? '(none)',
        detail: 'escalation advisor for this seat; claude-code seats only accept claude-code:* (official pairing) - written to advisors in .omd/config.json',
        action: 'seat',
      });
    }
  }

  return items.filter((x) => x.detail !== undefined || true);
}

/** 渲染成给对话记录看的文本(选择器之外还留一份可回看的痕)。 */
export function formatSettings(items: readonly SettingItem[]): string {
  const rows = items.map((s) => `  ${s.label}: ${s.value}${s.detail ? `\n      ${s.detail}` : ''}`);
  return `Settings (editable rows are pickable in the selector):\n${rows.join('\n')}`;
}

export function parseSettingsCommand(text: string): boolean {
  const t = text.trim();
  return t === '/settings' || t === '/set' || t === '/config';
}
