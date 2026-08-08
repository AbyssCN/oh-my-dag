/**
 * src/tui/render/path-fog —— **pathfinder 散雾图两画法**(切片⑧,owner 裁决主 C 副 B)。
 *
 * - 画法 C「雾退线」:凝固层(按裁决顺序)→ 前沿线(票钉在线上)→ 雾层。全屏主视图。
 * - 画法 B「三角洲」:主干 → 已凝固支流 → 梢头挂前沿票 → 右侧雾场。Tab 第二画法。
 * - 画法 A(声呐)**不实现**(owner 裁决)。
 *
 * ## 与三方案稿的两处显式偏离(记录,不静默)
 *
 * 1. **字形降级**:稿里的重线 `━ ┄ ┃` 与 `◌ ⛓ ▔` 全是未量字形(字形闸判 unmeasured,
 *    换机器就可能超宽)—— 一律换轻线族 `─ │ ├ └` 与已量的 `● ◆ ◇ ○`。
 *    与 powerline 箭头不搬同一条理由:好看程度不值得拿没量过的字形赌布局。
 * 2. **雾不呼吸**:稿里雾每 tick 在 `░▒` 间抖动。那要一个 setInterval 动画面,
 *    判据(列得出/切得动/关系看得见)不需要它 —— 后续要做时挂在 §4.1 第 4 条的约束下。
 *
 * 纯函数,零 IO(pi-tui 只借 visibleWidth 这把尺子);数据由 buildPathViewData 从 PathMap 拍平。
 */
import { visibleWidth } from '@earendil-works/pi-tui';
import type { PathMap, Ticket } from '../../harness/pathfinder/types';
import { computeFrontier } from '../../harness/pathfinder/frontier';
import { BAR_DONE, BAR_TODO } from './bar';
import { fitLine } from './line';

/** 票类型字形(全在白名单):task ● · grill ◆ · research ◇ · prototype ○。 */
export const TICKET_MARK: Record<string, string> = { task: '●', grill: '◆', research: '◇', prototype: '○' };

export interface PathViewData {
  destination: string;
  slug: string;
  /** 凝固层:已裁决票按裁决顺序分行(每行一"代"—— 顺序来自 decisionsLog,不是时间戳)。 */
  gens: string[][];
  frontier: { id: string; type: string; title: string; runId?: string }[];
  blocked: number;
  ruled: number;
  total: number;
  /** 推进过本图的 run(suggestedBy + suggestionsLog 的去重 runId)—— 票与 run 的关系。 */
  runs: string[];
}

const GEN_WIDTH = 5;

export function buildPathViewData(map: PathMap): PathViewData {
  const frontier = computeFrontier(map);
  const ruledIds = map.decisionsLog.map((d) => d.ticketId);
  const gens: string[][] = [];
  for (let i = 0; i < ruledIds.length; i += GEN_WIDTH) gens.push(ruledIds.slice(i, i + GEN_WIDTH));
  const runs = new Set<string>();
  for (const t of map.tickets) if (t.suggestedBy) runs.add(t.suggestedBy);
  for (const e of map.suggestionsLog ?? []) if (e.runId) runs.add(e.runId);
  const ruled = map.tickets.filter((t) => t.status === 'ruled' || t.status === 'delivered').length;
  return {
    destination: map.destination,
    slug: map.slug,
    gens,
    frontier: frontier.map((t: Ticket) => ({
      id: t.id,
      type: t.type,
      title: t.title,
      ...(t.suggestedBy ? { runId: t.suggestedBy } : {}),
    })),
    blocked: map.tickets.filter((t) => t.status !== 'ruled' && t.status !== 'delivered' && t.blockedBy.length > 0 && t.status !== 'suggested').length,
    ruled,
    total: map.tickets.length,
    runs: [...runs],
  };
}

const fog = (width: number, dense: boolean): string => {
  // 静态交替纹理 (░▒) —— 呼吸动画刻意不做, 见文件头偏离记录 ②。
  const unit = dense ? '▒▒░░' : '░░░▒';
  return unit.repeat(Math.ceil(width / 4)).slice(0, Math.max(0, width));
};

/** 头两行: 第一行是短读数 (slug + 画法 + 散雾 + run 关系), 第二行才是长 destination ——
 * destination 放第一行的话长标题会把 run 段截出屏 (PF-3 实测红过一次)。 */
const header = (d: PathViewData, painter: string, width: number): string[] => {
  const pct = d.total > 0 ? Math.round((d.ruled / d.total) * 100) : 0;
  const runsSeg = d.runs.length > 0 ? ` · 本图被 ${d.runs.length} 个 run 推进过` : ' · 还没有 run 推进过本图';
  return [
    fitLine(`地图 ${d.slug} · ${painter} · 散雾 ${pct}% (${d.ruled}/${d.total})${runsSeg}`, width),
    fitLine(`目的地: ${d.destination}`, width),
  ];
};

const keysLine = (width: number): string =>
  fitLine('上下键选票 · Enter 动作 · Tab 换画法 · Ctrl+P 退出', width);

/** 选中票那一行:`> ◆ g4 grill 标题 (<- run 78f1951c)`。 */
const ticketLine = (t: PathViewData['frontier'][number], selected: boolean, width: number): string => {
  const mark = TICKET_MARK[t.type] ?? '●';
  const run = t.runId ? `  <- run ${t.runId.slice(0, 8)}` : '';
  return fitLine(`${selected ? '>' : ' '} ${mark} ${t.id} ${t.type}  ${t.title}${run}`, width);
};

/** 画法 C · 雾退线:凝固层 → 前沿线 → 雾层。 */
export function renderFogLine(d: PathViewData, o: { width: number; height: number; selected: number }): string[] {
  const out: string[] = [...header(d, '雾退线', o.width)];
  out.push(fitLine(`凝固层 ${'─'.repeat(Math.max(0, o.width - 8))}`, o.width));
  if (d.gens.length === 0) out.push('  (还没有裁决)');
  for (let i = 0; i < d.gens.length; i++) {
    out.push(fitLine(`  gen-${i + 1}  ${(d.gens[i] as string[]).join(' · ')}`, o.width));
  }
  out.push(fitLine(`前沿线 ${'─'.repeat(Math.max(0, o.width - 8))}`, o.width));
  if (d.frontier.length === 0) {
    const why = d.blocked > 0 ? `全部 ${d.blocked} 张被前置票挡着` : '全部已裁决';
    out.push(`  前沿 0 (${why})`);
  }
  for (let i = 0; i < d.frontier.length; i++) {
    out.push(ticketLine(d.frontier[i] as PathViewData['frontier'][number], i === o.selected, o.width));
  }
  if (d.blocked > 0) out.push(fitLine(`  阻塞集 ${d.blocked} 张`, o.width));
  out.push(fitLine(`雾层   ${fog(Math.max(0, o.width - 8), true)}`, o.width));
  const q = '? ? ?';
  const pad = Math.max(0, Math.floor((o.width - 8 - q.length) / 2));
  out.push(fitLine(`       ${fog(pad, false)} ${q} ${fog(pad, false)}`, o.width));
  out.push(keysLine(o.width));
  if (out.length > o.height) return [...out.slice(0, Math.max(1, o.height - 1)), `… 还有 ${out.length - o.height + 1} 行`];
  return out;
}

/** 画法 B · 三角洲:主干 → 凝固支流 → 梢头挂票 → 右侧雾场。 */
export function renderDelta(d: PathViewData, o: { width: number; height: number; selected: number }): string[] {
  const out: string[] = [...header(d, '三角洲', o.width)];
  const pct = d.total > 0 ? d.ruled / d.total : 0;
  const bar = `[${BAR_DONE.repeat(Math.round(pct * 10))}${BAR_TODO.repeat(10 - Math.round(pct * 10))}]`;
  out.push(fitLine(`◆ ${d.slug} (goal) ${bar}`, o.width));
  // 凝固支流: 每代一条实线支流。
  for (let i = 0; i < d.gens.length; i++) {
    const branch = i === d.gens.length - 1 ? '└─' : '├─';
    out.push(fitLine(`${branch}${'─'.repeat(2)} ${(d.gens[i] as string[]).join(' ── ')}`, o.width));
  }
  if (d.gens.length === 0) out.push('  (还没有凝固的支流)');
  // 梢头: 前沿票挂在虚段上, 右侧雾场密度渐变 (虚线 ┄ 未量 → 用 · 代)。
  for (let i = 0; i < d.frontier.length; i++) {
    const t = d.frontier[i] as PathViewData['frontier'][number];
    const mark = TICKET_MARK[t.type] ?? '●';
    const stem = `  · · ${mark} ${t.id} ${t.title}`;
    const line = `${i === o.selected ? '>' : ' '}${stem}`;
    // 宽度只有一把尺子 (AGENTS §2): CJK 标题用 .length 会把雾场挤出屏。
    const fogW = Math.max(0, o.width - visibleWidth(line) - 14);
    out.push(fitLine(`${line}  ${fog(Math.min(fogW, 16), i % 2 === 0)}`, o.width));
  }
  if (d.frontier.length === 0) out.push('  (没有梢头 —— 前沿为空)');
  out.push(fitLine(`雾场 ${fog(Math.max(0, o.width - 6), false)}`, o.width));
  out.push(keysLine(o.width));
  if (out.length > o.height) return [...out.slice(0, Math.max(1, o.height - 1)), `… 还有 ${out.length - o.height + 1} 行`];
  return out;
}
