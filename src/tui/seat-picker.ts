/**
 * src/tui/seat-picker —— **座位选择器**(TUI SDD 切片 S12)。
 *
 * ## 列的是**座位**,不是裸模型名(goal §4 点名)
 *
 * 裸模型列表("kimi-k3 / deepseek-v4-flash / gpt-5.6-sol …")对选择这件事没有帮助:
 * 它不说这个位子**干什么**、**多久调一次**、**为什么推荐那一档**。而这三件恰恰是本仓
 * 座位登记表(`src/model/seats.ts`)已经写好的东西 —— 那里是唯一真源,这里只是它的视图。
 *
 * ⚠ 所以这个文件**一个座位事实都不自己写**。写了就成了第二份登记表,而两份必漂。
 *
 * ## 列的是**全部可调座位**
 *
 * `TUNABLE_CONFIG_ROLES` 是 `.omd/config.json` 认的键 —— 2026-08-10 起**全部座位都可调**,
 * 所以这里列全量, 每一行都能改。`CORE_SEATS` (conductor/leaf/verifier) 只是**首屏取舍**
 * (回执与 `/settings` 主表只画这三座, 见 formatSeatRows 与 settings.ts), 不是"只有这些能改"。
 */
import { TUNABLE_CONFIG_ROLES } from '../harness/init/headless-config';
import { type OmdSeat, seatSpec } from '../model/seats';

/**
 * ★ **首屏核心三座** —— `/seat` 回执与 `/settings` 主表只画这三座 (可绘区/30 行终端取舍,
 * 见 formatSeatRows 与 settings.ts 的注释)。**不是**「只有这三个能改」: 全部座位都能改,
 * 完整清单在 `/seat` 面板。三座 = 拆解/执行/终审三类代表 (风险与频率各不相同)。
 */
export const CORE_SEATS: readonly OmdSeat[] = ['conductor', 'leaf', 'verifier'];

export interface SeatRow {
  role: string;
  /** 当前生效的坐标(`provider:model`)。 */
  coord: string;
  /** 座位登记表里的一句话职责。登记表里没有这个 id → `null`,不编。 */
  what: string | null;
  /** 登记表的推荐档与理由。 */
  recommend: string | null;
  /** 座位的 advisor 坐标。**缺席 = 没配**(不画一行假 none)。 */
  advisor?: string;
}

/** `/seat` 的解析结果。四态:列表 / 设置 / advisor / 不是这条命令。 */
export type SeatCommand =
  | { kind: 'list' }
  | { kind: 'set'; role: string; coord: string }
  /** `coord: null` = 清掉(删键, 回到"没配")。 */
  | { kind: 'advise'; seat: string; coord: string | null }
  | { kind: 'usage'; reason: string }
  | null;

/**
 * 解析一行输入。**只认 `/seat` 开头** —— 这不是一个 slash 命令注册表
 * (那个方案 SDD L117 已裁决撤回),就是一个前缀判断。
 */
export function parseSeatCommand(text: string): SeatCommand {
  const t = text.trim();
  if (t !== '/seat' && !t.startsWith('/seat ')) return null;
  const parts = t.split(/\s+/).slice(1);
  if (parts.length === 0) return { kind: 'list' };
  // advisor 是座位**属性**不是第 N 个座位 (NOTES 2026-08-10) —— 单独一个子形。
  if (parts[0] === 'advisor') {
    const seat = parts[1];
    const coord = parts[2];
    if (!seat || !coord) return { kind: 'usage', reason: 'Usage: /seat advisor <seat> <provider:model|none>' };
    return { kind: 'advise', seat, coord: coord === 'none' ? null : coord };
  }
  if (parts.length === 1) return { kind: 'usage', reason: 'Missing coordinate. Usage: /seat <role> <provider:model> (roles listed by /seat)' };
  return { kind: 'set', role: parts[0] as string, coord: parts[1] as string };
}

/**
 * 当前全部可调座位的视图 (TUNABLE_CONFIG_ROLES 全量, 不裁)。
 *
 * @param current 角色 → 当前坐标(调用方从 `resolveEngineModels` 取,这里不自己解析 env)
 * @param advisors 角色 → advisor 坐标(调用方从 `resolveSeatAdvisor` 取)。缺席 = 没配。
 */
export function seatRows(current: Record<string, string>, advisors: Record<string, string | undefined> = {}): SeatRow[] {
  return TUNABLE_CONFIG_ROLES.map((role) => {
    const spec = seatSpec(role);
    const advisor = advisors[role];
    return {
      role,
      coord: current[role] ?? '(unresolved)',
      what: spec?.what ?? null,
      recommend: spec?.recommend ?? null,
      ...(advisor ? { advisor } : {}),
    };
  });
}

/**
 * 渲染成给 chat 记录看的几行文本。
 *
 * 登记表里查不到的字段画 `-` 而不是编一句 —— 那一格的真值就是"登记表没写"。
 */
export function formatSeatRows(rows: SeatRow[]): string {
  /** 建议那一栏是登记表原文, 动辄两三行; 列表里只留第一句。要全文的人去 `/settings` 看。 */
  const first = (s: string | null | undefined) => (s ? (s.split(/[。;]/)[0] as string).trim() : '-');
  // ★ 回执**只留 3 核心座 + 一行「N more」**(2026-08-10 座位真源切片):
  //   /seat 回执上方的可绘区只有几行 (面板随后占屏, S12-2 实测红过) —— 全量 16 座铺进来
  //   会把头部挤出视口。**超过核心座数才裁**: 短列表 (装得下) 原样渲染, 不画多余提示。
  const tooMany = rows.length > CORE_SEATS.length;
  const core = tooMany ? rows.filter((r) => CORE_SEATS.includes(r.role as OmdSeat)) : rows;
  // advisor 行**只在配了时画**(缺席 ≠ none 抹平): 没配的座位不该多一行 "advisor: -" 噪声。
  const lines = core.map(
    (r) =>
      `  ${r.role}: ${r.coord}\n      does: ${first(r.what)}\n      pick: ${first(r.recommend)}${r.advisor ? `\n      advisor: ${r.advisor}` : ''}`,
  );
  // ★ 抬头挪到**最后一行**:全屏视口只留得住尾部,放在抬头的话"改的是哪个文件"
  //   会是第一个被顶掉的 —— 而那正是这条命令唯一有副作用的地方。
  // ⚠ advisor 的语法**不另起一行**: 多一行就把最后一个 `does:` 挤出视口。
  //   语法在 /help 与设置面板里可发现。
  const more =
    tooMany ? `\n其余座位见 /seat 面板 — 面板里可改全部 ${TUNABLE_CONFIG_ROLES.length} 座` : '';
  return `${lines.join('\n')}${more}\nUsage: /seat <role> <provider:model> - tunable seats write .omd/config.json and take effect immediately`;
}
