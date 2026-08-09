/**
 * src/tui/render/path-fog —— **pathfinder 散雾图两画法**(切片⑧,owner 裁决主 C 副 B)。
 *
 * ## 2026-08-08 重画:对齐 HTML 稿的空间构图(owner 指出初版"列表 + 雾带"与稿不符)
 *
 * - 画法 C「雾退线」:凝固层(逐代地层)→ **前沿线(票钉在一条横线上,↓ 指向雾)** → 雾层
 *   (密度渐变)→ 底部散雾读数。判据:构图与 `2026-08-08-pathfinder-tui-三方案.html` 的 C 案同形。
 * - 画法 B「三角洲」:主干(goal)→ 凝固支流(实线链,左→右)→ 梢头挂前沿票(虚段)→
 *   **右侧雾场列**(密度随行渐变)。
 * - 画法 A(声呐)**不实现**(owner 裁决)。
 *
 * ## 与稿仍存的两处偏离(记录,不静默)
 *
 * 1. **重线族待量**:稿用 `━ ┄ ┃ ◉ ▼ ⛓`,字形闸判 unmeasured。候选已扩进探针
 *    (`glyphs.ts` box-heavy/box-round/mock-extra),owner 真终端跑
 *    `bun run scripts/tui-glyph-probe.ts --tty` 重生成白名单后,这里的 `─ · ↓ ●` 逐个换回。
 * 2. **雾不呼吸**:动画留待后续(挂 §4.1-4 约束)。
 *
 * 纯函数;颜色经注入的 paint 钩子(测试与 NO_COLOR 下是恒等,**选中态靠 [] 结构可见,不靠色**)。
 */
import { visibleWidth } from '@earendil-works/pi-tui';
import type { PathMap, Ticket } from '../../harness/pathfinder/types';
import { computeFrontier } from '../../harness/pathfinder/frontier';
import { BAR_DONE, BAR_TODO } from './bar';
import { fitLine } from './line';

/** 票类型字形(全在白名单):task ● · grill ◆ · research ◇ · prototype ○。 */
export const TICKET_MARK: Record<string, string> = { task: '●', grill: '◆', research: '◇', prototype: '○' };

/** 颜色钩子。省略/NO_COLOR = 恒等 —— 结构信息(选中 []、阻塞行)不许只靠颜色携带。 */
export interface FogPaint {
  accent(s: string): string;
  dim(s: string): string;
  warn(s: string): string;
  sel(s: string): string;
}
const PLAIN: FogPaint = { accent: (s) => s, dim: (s) => s, warn: (s) => s, sel: (s) => s };

export interface PathViewData {
  destination: string;
  slug: string;
  /** 凝固层:已裁决票按裁决顺序分代(id + 裁决 gist —— 稿里地层带的就是 gist)。 */
  gens: { id: string; gist: string }[][];
  frontier: { id: string; type: string; title: string; runId?: string }[];
  /** 阻塞票(id + 标题)—— 稿里它们也钉在前沿线上,只是标记不同。 */
  blockedTickets: { id: string; title: string }[];
  ruled: number;
  total: number;
  /** 推进过本图的 run(suggestedBy + suggestionsLog 的去重 runId)—— 票与 run 的关系。 */
  runs: string[];
}

const GEN_WIDTH = 5;

export function buildPathViewData(map: PathMap): PathViewData {
  const frontier = computeFrontier(map);
  const gens: { id: string; gist: string }[][] = [];
  for (let i = 0; i < map.decisionsLog.length; i += GEN_WIDTH) {
    gens.push(map.decisionsLog.slice(i, i + GEN_WIDTH).map((d) => ({ id: d.ticketId, gist: d.gist })));
  }
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
    // ⚠ 排除已在前沿的: blockedBy 非空但前置都已裁决的票是**可动的**, 同时出现在两边
    //   会读成"又能动又被挡" (fog-v2 截图抓到 g4 两边都在)。
    blockedTickets: map.tickets
      .filter(
        (t) =>
          t.status !== 'ruled' &&
          t.status !== 'delivered' &&
          t.status !== 'suggested' &&
          t.blockedBy.length > 0 &&
          !frontier.some((f) => f.id === t.id),
      )
      .map((t) => ({ id: t.id, title: t.title })),
    ruled,
    total: map.tickets.length,
    runs: [...runs],
  };
}

/** 截到 n 可见列(不加省略号 —— 线上的短标签,截断本身就是形态)。 */
const clip = (s: string, n: number): string => {
  if (visibleWidth(s) <= n) return s;
  let out = '';
  for (const ch of s) {
    if (visibleWidth(out + ch) > n) break;
    out += ch;
  }
  return out;
};

/** 静态密度纹理(░▒)。呼吸动画刻意不做,见文件头偏离 ②。`phase` 让相邻行错开。 */
const fog = (width: number, density: 0 | 1 | 2, phase = 0): string => {
  const units = ['░░░░▒░░░', '░▒▒░░░▒░', '▒▒░░▒▒▒░'] as const;
  const u = units[density];
  const s = u.repeat(Math.ceil((width + phase) / u.length) + 1);
  return s.slice(phase, phase + Math.max(0, width));
};

const clampHeight = (out: string[], height: number): string[] =>
  out.length > height ? [...out.slice(0, Math.max(1, height - 1)), `… ${out.length - height + 1} more lines`] : out;

/** 头两行:短读数在前(长 destination 会把 run 段截出屏,PF-3 红过一次)。 */
const header = (d: PathViewData, painter: string, width: number, p: FogPaint): string[] => {
  const pct = d.total > 0 ? Math.round((d.ruled / d.total) * 100) : 0;
  const runsSeg = d.runs.length > 0 ? ` · ${d.runs.length} runs` : ' · no runs';
  return [
    p.accent(fitLine(`map ${d.slug} · ${painter} · fog ${pct}% (${d.ruled}/${d.total})${runsSeg}`, width)),
    p.dim(fitLine(`destination: ${d.destination}`, width)),
  ];
};

const keysLine = (width: number, p: FogPaint): string =>
  p.dim(fitLine('up/down picks a ticket · Enter acts · Tab switches view · Ctrl+P exits', width));

/** 底部读数条(稿的最后一行):`散雾 62% ████░░ · open 4 · blocked 1 · 本图被 3 个 run 推进过`。 */
const summaryLine = (d: PathViewData, width: number, p: FogPaint): string => {
  const pct = d.total > 0 ? Math.round((d.ruled / d.total) * 100) : 0;
  const filled = Math.round((pct / 100) * 12);
  const bar = BAR_DONE.repeat(filled) + BAR_TODO.repeat(12 - filled);
  return p.accent(
    fitLine(`fog ${pct}% ${bar} · open ${d.frontier.length} · blocked ${d.blockedTickets.length} · run x${d.runs.length}`, width),
  );
};

/** 选中票的详情行(线上是短标签,全文在这):`> ◆ g4 grill 全标题 <- run 78f1951c`。 */
const selectedDetail = (d: PathViewData, selected: number, width: number, p: FogPaint): string | null => {
  const t = d.frontier[selected];
  if (!t) return null;
  const run = t.runId ? `  <- run ${t.runId.slice(0, 8)}` : '';
  return p.sel(fitLine(`> ${TICKET_MARK[t.type] ?? '●'} ${t.id} ${t.type}  ${t.title}${run}`, width));
};

/**
 * 画法 C · 雾退线:凝固地层 → 票钉在前沿线上(↓ 指雾)→ 雾层渐变 → 底部读数。
 */
export function renderFogLine(
  d: PathViewData,
  o: { width: number; height: number; selected: number; paint?: FogPaint },
): string[] {
  const p = o.paint ?? PLAIN;
  const w = o.width;
  const out: string[] = [...header(d, 'fog line', w, p)];

  // ── 凝固层: 逐代地层 (id + gist)。
  out.push(p.dim(fitLine(`settled ${'─'.repeat(Math.max(0, w - 8))}`, w)));
  if (d.gens.length === 0) out.push(p.dim('  (nothing ruled yet)'));
  for (let i = 0; i < d.gens.length; i++) {
    const row = (d.gens[i] as { id: string; gist: string }[]).map((e) => `${e.id} ${clip(e.gist, 10)}`).join(' · ');
    out.push(p.dim(fitLine(` gen-${i + 1}  ${row}`, w)));
  }

  // ── 前沿线: 票钉在一条横线上。选中的用 [] 包 (结构可见, 不靠颜色)。阻塞票也钉着, 前缀 x。
  const marks: number[] = []; // 每张 open 票的 id 起始列 → ↓ 指针行
  let line = 'frontier ';
  let overflow = 0;
  const pin = (body: string, isSel: boolean, track: boolean): void => {
    const seg = isSel ? `═[${body}]` : `──${body}`;
    if (visibleWidth(line) + visibleWidth(seg) + 4 > w) {
      overflow += 1;
      return;
    }
    if (track) marks.push(visibleWidth(line) + 2); // `──` 或 `═[` 都是 2 列, id 从第 3 列起
    line += seg;
  };
  d.frontier.forEach((t, i) => pin(`${t.id}${TICKET_MARK[t.type] ?? '●'}${clip(t.title, 8)}`, i === o.selected, true));
  for (const b of d.blockedTickets.slice(0, 2)) pin(`x${b.id} ${clip(b.title, 6)}`, false, false);
  if (overflow > 0) line += `──(+${overflow})`;
  line += '──';
  if (d.frontier.length === 0 && d.blockedTickets.length === 0) {
    out.push(p.dim(fitLine('frontier ──── frontier 0 (everything ruled) ────', w)));
  } else {
    out.push(p.accent(fitLine(line, w)));
    // ↓ 指针行: 每张 open 票往雾里指一根。
    if (marks.length > 0) {
      let ptr = '';
      for (const col of marks) {
        if (col <= visibleWidth(ptr)) continue;
        ptr += ' '.repeat(col - visibleWidth(ptr)) + '↓';
      }
      out.push(p.dim(fitLine(ptr, w)));
    }
  }
  const detail = selectedDetail(d, o.selected, w, p);
  if (detail) out.push(detail);
  if (d.blockedTickets.length > 0) {
    out.push(p.warn(fitLine(`  blocked ${d.blockedTickets.length}: ${d.blockedTickets.map((b) => b.id).join(' · ')}`, w)));
  }

  // ── 雾层: 密度渐变并**撑满剩余高度**(稿里雾是大面积的, 三行雾读不出"体量")。
  out.push(p.dim(fitLine(`fog    ${fog(Math.max(0, w - 8), 2)}`, w)));
  const q = '? ? ?';
  const pad = Math.max(0, Math.floor((w - 8 - q.length) / 2));
  out.push(p.dim(fitLine(`       ${fog(pad, 1, 3)} ${q} ${fog(pad, 1, 5)}`, w)));
  const fill = o.height - out.length - 3; // 3 = 最后一行雾 + 读数条 + 键位行
  for (let i = 0; i < fill; i++) out.push(p.dim(fitLine(`       ${fog(Math.max(0, w - 8), i < fill / 2 ? 1 : 0, i * 2)}`, w)));
  out.push(p.dim(fitLine(`       ${fog(Math.max(0, w - 8), 0, 1)}`, w)));

  out.push(summaryLine(d, w, p));
  out.push(keysLine(w, p));
  return clampHeight(out, o.height);
}

/**
 * 画法 B · 三角洲:主干(goal)→ 凝固支流(实线链)→ 梢头挂票(虚段)→ 右侧雾场列。
 */
export function renderDelta(
  d: PathViewData,
  o: { width: number; height: number; selected: number; paint?: FogPaint },
): string[] {
  const p = o.paint ?? PLAIN;
  const w = o.width;
  const out: string[] = [...header(d, 'delta', w, p)];
  const fogW = Math.min(18, Math.max(8, Math.floor(w / 6)));
  const bodyW = w - fogW - 1;
  /** 一行 = 左侧结构 + 右侧雾场列(密度随行衰减 —— 稿里的"离前沿越远雾越薄")。 */
  const row = (left: string, density: 0 | 1 | 2, phase: number, tint: (s: string) => string): string => {
    const body = fitLine(left, bodyW);
    const pad = ' '.repeat(Math.max(0, bodyW - visibleWidth(body) + 1));
    // fitLine/truncateToWidth 是 ANSI 感知的 —— 拼完再过一遍, 色码不占列。
    return fitLine(tint(body) + pad + p.dim(fog(fogW, density, phase)), w);
  };

  out.push(row(`● ${d.slug} (goal)`, 0, 0, p.accent));
  // 凝固支流: 每代一条实线链, 接在主干下。
  if (d.gens.length === 0) out.push(row('│  (no settled tributary yet)', 0, 2, p.dim));
  for (let i = 0; i < d.gens.length; i++) {
    const last = i === d.gens.length - 1 && d.frontier.length === 0;
    const chain = (d.gens[i] as { id: string; gist: string }[]).map((e) => `${e.id} ${clip(e.gist, 8)}`).join(' ── ');
    out.push(row(`${last ? '└──' : '├──'} ${chain}`, 0, i, p.dim));
  }
  // 梢头: 前沿票挂虚段 (·· 待量的 ┄), 雾密度朝梢头加深; 选中 [] 包。
  d.frontier.forEach((t, i) => {
    const last = i === d.frontier.length - 1;
    const body = `${t.id}${TICKET_MARK[t.type] ?? '●'} ${clip(t.title, Math.max(8, bodyW - 16))}`;
    const stem = `${last ? '└' : '├'}···· ${i === o.selected ? `[${body}]` : body}`;
    out.push(row(stem, i % 2 === 0 ? 2 : 1, i * 2, i === o.selected ? p.sel : p.accent));
  });
  for (const b of d.blockedTickets.slice(0, 3)) {
    out.push(row(`│···· x${b.id} ${clip(b.title, 12)} (blocked)`, 1, 7, p.warn));
  }
  const detail = selectedDetail(d, o.selected, w, p);
  if (detail) out.push(detail);
  // 雾场撑满剩余高度 (与画法 C 同一条理由: 雾的体量感)。
  const fill = o.height - out.length - 3;
  for (let i = 0; i < fill; i++) out.push(p.dim(fitLine(`     ${fog(Math.max(0, w - 6), i < fill / 2 ? 1 : 0, i * 3)}`, w)));
  out.push(p.dim(fitLine(`fog  ${fog(Math.max(0, w - 6), 0, 4)}`, w)));
  out.push(summaryLine(d, w, p));
  out.push(keysLine(w, p));
  return clampHeight(out, o.height);
}
