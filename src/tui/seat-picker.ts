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
 * ## 只有三个座位能在这里改
 *
 * `TUNABLE_CONFIG_ROLES` = conductor / leaf / verifier —— 那是 `.omd/config.json` 认的键。
 * 别的座位由 auto-assign 按渠道经济学分派。**说清楚哪些能改**比列一堆改不动的更有用,
 * 所以列表里只有这三个,而不是把 30 多个座位铺出来让人挑一个改不了的。
 */
import { TUNABLE_CONFIG_ROLES } from '../harness/init/headless-config';
import { seatSpec } from '../model/seats';

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
  if (parts.length === 1) return { kind: 'usage', reason: `Missing coordinate. Usage: /seat <${TUNABLE_CONFIG_ROLES.join('|')}> <provider:model>` };
  return { kind: 'set', role: parts[0] as string, coord: parts[1] as string };
}

/**
 * 当前三个可调座位的视图。
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
  // advisor 行**只在配了时画**(缺席 ≠ none 抹平): 没配的座位不该多一行 "advisor: -" 噪声。
  const lines = rows.map(
    (r) =>
      `  ${r.role}: ${r.coord}\n      does: ${first(r.what)}\n      pick: ${first(r.recommend)}${r.advisor ? `\n      advisor: ${r.advisor}` : ''}`,
  );
  // ★ 抬头挪到**最后一行**:全屏视口只留得住尾部,放在抬头的话"改的是哪个文件"
  //   会是第一个被顶掉的 —— 而那正是这条命令唯一有副作用的地方。
  // ⚠ advisor 的语法**不另起一行**: /seat 回执上方的可绘区只有几行 (面板随后占屏),
  //   多一行就把最后一个 `does:` 挤出视口 (S12-2 实测红过)。语法在 /help 与设置面板里可发现。
  return `${lines.join('\n')}\nUsage: /seat <role> <provider:model> - tunable seats write .omd/config.json and take effect immediately`;
}
