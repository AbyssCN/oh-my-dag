/**
 * src/tui/render/path-fog —— **pathfinder 散雾图两画法**(切片⑧,owner 裁决主 C 副 B)。
 *
- 画法 C「Map 屏」:goal → settled → frontier → blocked → engine suggestions → fog horizon → readout。
 * - 画法 B「三角洲」:主干(goal)→ 凝固支流(实线链,左→右)→ 梢头挂前沿票(虚段)→
 *   **右侧雾场列**(密度随行渐变)。
 * - 画法 A(声呐)**不实现**(owner 裁决)。
 *
 * `glyph-table.ts` 的 `GROUND_TRUTH === true`; `━ ┄ ┃ ◉ ▼ ⛓` 全在 SAFE 档,这里直接使用。
 * 纯函数;颜色经注入的 paint 钩子(测试与 NO_COLOR 下是恒等,选中态靠 `▸` 结构可见,不靠色)。
 */
import { visibleWidth } from '@earendil-works/pi-tui';
import type { PathMap, Ticket } from '../../harness/pathfinder/types';
import { computeFrontier, waitingHumanState, type WaitingHumanState } from '../../harness/pathfinder/frontier';
import { BAR_DONE, BAR_TODO } from './bar';
import { fitLine } from './line';

/** 票类型字形(全在白名单):task ● · grill ◆ · research ◇ · prototype ○。 */
export const TICKET_MARK: Record<string, string> = { task: '●', grill: '◆', research: '◇', prototype: '○' };

/** 颜色钩子。省略/NO_COLOR = 恒等 —— 结构信息(选中 `▸`、stale 文字、阻塞行)不许只靠颜色携带。 */
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
  /** 凝固层:已裁决票按裁决顺序分代(id + 裁决 gist)。 */
  gens: { id: string; gist: string }[][];
  frontier: { id: string; type: string; title: string; runId?: string; stale?: boolean }[];
  /** suggested/escalated 单列;等待起点保留 null,渲染时才按 now 算时长。 */
  suggested?: {
    id: string;
    type: string;
    title: string;
    wait: { kind: WaitingHumanState; sinceMs: number | null };
    stale?: boolean;
  }[];
  /** 阻塞票保留直接前置,行尾说明正在等谁裁。 */
  blockedTickets: { id: string; title: string; by?: string[] }[];
  ruled: number;
  total: number;
  /** 推进过本图的 run(suggestedBy + suggestionsLog 的去重 runId)。 */
  runs: string[];
}

const GEN_WIDTH = 5;

const msOf = (iso: string | undefined): number | undefined => {
  if (iso === undefined) return undefined;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? undefined : ms;
};

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
      ...(t.staleAt !== undefined ? { stale: true } : {}),
    })),
    suggested: map.tickets
      .filter((t) => t.status === 'suggested' || t.status === 'escalated')
      .map((t) => ({
        id: t.id,
        type: t.type,
        title: t.title,
        wait: { kind: waitingHumanState(t), sinceMs: msOf(t.waitingSince) ?? null },
        ...(t.staleAt !== undefined ? { stale: true } : {}),
      })),
    // ⚠ 排除已在前沿的: blockedBy 非空但前置都已裁决的票是**可动的**, 同时出现在两边
    //   会读成“又能动又被挡”。
    blockedTickets: map.tickets
      .filter(
        (t) =>
          t.status !== 'ruled' &&
          t.status !== 'delivered' &&
          t.status !== 'suggested' &&
          t.status !== 'escalated' &&
          t.blockedBy.length > 0 &&
          !frontier.some((f) => f.id === t.id),
      )
      .map((t) => ({ id: t.id, title: t.title, by: [...t.blockedBy] })),
    ruled,
    total: map.tickets.length,
    runs: [...runs],
  };
}

/** 可见列感知的右补白。 */
const padS = (text: string, cols: number): string => text + ' '.repeat(Math.max(0, cols - visibleWidth(text)));

/** 可见列感知的左补白。 */
const padSL = (text: string, cols: number): string => ' '.repeat(Math.max(0, cols - visibleWidth(text))) + text;

/** CJK 按字列断行;西文优先整词搬到下一行,超长单词仍按列拆开。 */
const wrap = (text: string, cols: number): string[] => {
  if (cols <= 0) return [''];
  const tokens: string[] = [];
  let latin = '';
  for (const ch of text) {
    if (ch.codePointAt(0)! < 0x80 && !/\s/.test(ch)) {
      latin += ch;
      continue;
    }
    if (latin) {
      tokens.push(latin);
      latin = '';
    }
    tokens.push(/\s/.test(ch) ? ' ' : ch);
  }
  if (latin) tokens.push(latin);

  const out: string[] = [];
  let cur = '';
  const flush = (): void => {
    const row = cur.trimEnd();
    if (row) out.push(row);
    cur = '';
  };
  for (const token of tokens) {
    if (token === ' ' && cur === '') continue;
    if (visibleWidth(cur + token) <= cols) {
      cur += token;
      continue;
    }
    flush();
    if (token === ' ') continue;
    let chunk = '';
    for (const ch of token) {
      if (chunk && visibleWidth(chunk + ch) > cols) {
        out.push(chunk);
        chunk = '';
      }
      chunk += ch;
    }
    cur = chunk;
  }
  flush();
  return out.length > 0 ? out : [''];
};

/** 截到可见列并补 `…`;只用于 chrome/票行,goal 正文走 wrap。 */
const clip = (text: string, cols: number): string => {
  if (cols <= 0) return '';
  if (visibleWidth(text) <= cols) return text;
  if (cols === 1) return '…';
  let out = '';
  for (const ch of text) {
    if (visibleWidth(out + ch) > cols - 1) break;
    out += ch;
  }
  return out + '…';
};

/** `━━ label ━━━━━ right ━━` 分区线。 */
const rule = (label: string, right: string | undefined, cols: number): string => {
  const head = `━━ ${label} ━━`;
  const tail = right ? ` ${right} ━━` : '';
  const fill = '━'.repeat(Math.max(0, cols - visibleWidth(head) - visibleWidth(tail)));
  return clip(head + fill + tail, cols);
};

/** 未知边界只画地平线,不画雾纹理。 */
const horizon = (cols: number, label: string): string => {
  const text = ` ${label} `;
  const room = Math.max(0, cols - visibleWidth(text));
  const left = Math.floor(room / 2);
  return clip('┄'.repeat(left) + text + '┄'.repeat(room - left), cols);
};

/** 固定格数进度条。 */
const bar = (done: number, total: number, cells = 12): string => {
  const filled = total > 0 ? Math.round((Math.max(0, Math.min(done, total)) / total) * cells) : 0;
  return BAR_DONE.repeat(filled) + BAR_TODO.repeat(cells - filled);
};

const fmtDur = (ms: number): string => {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m${Math.round((ms % 60000) / 1000)}s`;
};

/** 静态密度纹理(░▒)。画法 B 与 fogBand 仍共用。`phase` 让相邻行错开。 */
const fog = (width: number, density: 0 | 1 | 2, phase = 0): string => {
  const units = ['░░░░▒░░░', '░▒▒░░░▒░', '▒▒░░▒▒▒░'] as const;
  const u = units[density];
  const s = u.repeat(Math.ceil((width + phase) / u.length) + 1);
  return s.slice(phase, phase + Math.max(0, width));
};

const clampHeight = (out: string[], height: number): string[] =>
  out.length > height ? [...out.slice(0, Math.max(1, height - 1)), `… ${out.length - height + 1} more lines`] : out;

/** 雾带封顶只供旧画法 B 的雾场与保留画法使用。 */
const FOG_BAND_MAX = 5;

/** 雾带: 第一行最密, `? ? ?` 居中, 往下逐行变薄。 */
const fogBand = (n: number, width: number, p: FogPaint): string[] => {
  const fw = Math.max(0, width - 8);
  const rows = [p.dim(fitLine(`fog    ${fog(fw, 2)}`, width))];
  if (n >= 2) {
    const q = '? ? ?';
    const pad = Math.max(0, Math.floor((fw - q.length) / 2));
    rows.push(p.dim(fitLine(`       ${fog(pad, 1, 3)} ${q} ${fog(pad, 1, 5)}`, width)));
  }
  for (let i = 2; i < n; i++) {
    rows.push(p.dim(fitLine(`       ${fog(fw, i < n - 1 ? 1 : 0, i * 2)}`, width)));
  }
  return rows;
};

/** 画法 B 的旧头部;Map 屏有自己的单行头 + 可换行 goal 段。 */
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

/** 画法 B 的底部读数条。 */
const summaryLine = (d: PathViewData, width: number, p: FogPaint): string => {
  const pct = d.total > 0 ? Math.round((d.ruled / d.total) * 100) : 0;
  const filled = Math.round((pct / 100) * 12);
  const bar = BAR_DONE.repeat(filled) + BAR_TODO.repeat(12 - filled);
  return p.accent(
    fitLine(`fog ${pct}% ${bar} · open ${d.frontier.length} · blocked ${d.blockedTickets.length} · run x${d.runs.length}`, width),
  );
};

/** 画法 B 选中票详情。 */
const selectedDetail = (d: PathViewData, selected: number, width: number, p: FogPaint): string | null => {
  const t = d.frontier[selected];
  if (!t) return null;
  const run = t.runId ? `  <- run ${t.runId.slice(0, 8)}` : '';
  return p.sel(fitLine(`> ${TICKET_MARK[t.type] ?? '●'} ${t.id} ${t.type}  ${t.title}${run}`, width));
};

const waitLabel = (wait: NonNullable<PathViewData['suggested']>[number]['wait'], now: number): string => {
  switch (wait.kind) {
    case 'waiting':
      return wait.sinceMs === null ? 'waiting · start unknown' : `waiting ${fmtDur(now - wait.sinceMs)}`;
    case 'waiting-unknown-since':
      return 'waiting · start unknown';
    case 'ruled-unrecorded':
      return 'waiting · ruled, time unknown';
    case 'not-waiting':
      return '';
  }
};

const mapTicketLine = (
  t: { id: string; type: string; title: string; runId?: string; stale?: boolean },
  selected: boolean,
  width: number,
): string => {
  const sel = selected ? '▸ ' : '  ';
  const mark = t.stale ? '✗ STALE' : (TICKET_MARK[t.type] ?? '●');
  const suffix = t.runId ? `  ← run ${t.runId.slice(0, 8)}` : '';
  return clip(`${sel}${mark} ${padS(t.id, 6)} ${padS(t.type, 10)} ${t.title}${suffix}`, width);
};

const clampMapHeight = (out: string[], height: number, width: number, p: FogPaint): string[] => {
  if (out.length <= height) return out;
  if (height <= 3) return clampHeight(out, height);
  const tail = out.slice(-3);
  const kept = Math.max(0, height - tail.length - 1);
  return [...out.slice(0, kept), p.dim(clip(`… ${out.length - height + 1} more lines`, width)), ...tail];
};

/**
 * 画法 C · Map 屏 v2。选择域只有 frontier;等待时长使用注入的 now,数据构建不读时钟。
 */
// 2026-08-22 裁定:Map v2 段头、读数与键位行属于 chrome,按 owner 2026-08-09 裁决及 src/tui/render/glyphs.test.ts「chrome 文案一律纯英文」改用英文;票标题等数据不受限。
export function renderFogLine(
  d: PathViewData,
  o: { width: number; height: number; selected: number; paint?: FogPaint; now?: number },
): string[] {
  const p = o.paint ?? PLAIN;
  const width = o.width;
  const now = o.now ?? Date.now();
  const pct = d.total > 0 ? Math.round((d.ruled / d.total) * 100) : 0;
  const runsSeg = d.runs.length > 0 ? `${d.runs.length} runs` : 'no runs';
  const suggested = d.suggested ?? [];
  const out: string[] = [
    p.accent(clip(`map ${d.slug} · fog line · fog ${pct}% (${d.ruled}/${d.total}) · ${runsSeg}`, width)),
  ];

  const goal = wrap(d.destination, Math.max(1, width - 9));
  out.push(p.accent(clip(` goal   ${goal[0] ?? ''}`, width)));
  for (const row of goal.slice(1)) out.push(p.accent(clip(`${padSL('', 9)}${row}`, width)));

  for (let i = 0; i < d.gens.length; i++) {
    const gen = d.gens[i] as { id: string; gist: string }[];
    if (gen.length === 0) continue;
    out.push(p.accent(rule(`settled · gen-${i + 1}`, `${gen.length} tickets`, width)));
    // 画法 C 四段 id / type / 标题三列起始列一致: 已散段 type 不可知 (decisionsLog 不含 type), 用空白列占位, 起止列与前沿/建议段对齐。
    for (const t of gen) out.push(p.dim(clip(`  ✓ ${padS(t.id, 6)} ${padS('', 10)} ${t.gist}`, width)));
  }

  if (d.frontier.length > 0) {
    out.push(p.accent(rule('frontier · movable', `${d.frontier.length} tickets`, width)));
    d.frontier.forEach((t, i) => {
      const line = mapTicketLine(t, i === o.selected, width);
      out.push((i === o.selected ? p.sel : p.dim)(line));
    });
  }

  if (d.blockedTickets.length > 0) {
    out.push(p.accent(rule('blocked', `${d.blockedTickets.length} tickets`, width)));
    for (const t of d.blockedTickets) {
      const blocker = t.by?.[0];
      const suffix = blocker ? `  ← waiting for ${blocker} ruling` : '';
      // 画法 C 四段 id / type / 标题三列起始列一致: 受阻段 type 不可知 (blockedTickets 不含 type), 用空白列占位。
      out.push(p.warn(clip(`  ─ ${padS(t.id, 6)} ${padS('', 10)} ${t.title}${suffix}`, width)));
    }
  }

  if (suggested.length > 0) {
    out.push(p.accent(rule('engine suggestion · unreceived', `${suggested.length} tickets`, width)));
    for (const t of suggested) {
      const mark = t.stale ? '✗ STALE' : '○';
      // 「等你多久」是这一格唯一承重的信息 —— 优先保住等待读数, 标题不够宽就截标题;
      // 宽度不够时依次: 缩 type 列宽 (10 → 0) → 缩前导缩进 (2 → 0) → 让 titleCols 跌到 0;
      // type 内容 ≥ desired typeCols 时整体丢 type 块(占位也保留不下, 不强塞) → 让 title 多吃预算;
      // 不变式: 行 visibleWidth ≤ width (suffix 必保; 宽屏下退回到 type=10/indent=2 默认布局)。
      const waitStr = waitLabel(t.wait, now);
      const suffix = waitStr ? `  ${waitStr}` : '';
      const markW = visibleWidth(mark);
      const suffixW = visibleWidth(suffix);
      const typeContentW = visibleWidth(t.type);
      const budgetLeft = width - suffixW;
      const indentMax = 2;
      const idCols = 6;
      const typeColsMax = 10;
      let indent = indentMax;
      // 预算 = budgetLeft - indent - markW - 1 - idCols - 1(type 左侧 sep) - 1(type 右侧 sep) - titleCols
      // 先把 titleCols 设为 0, 反算 typeCols 上限:
      let typeCols = Math.max(0, Math.min(typeColsMax, budgetLeft - indent - markW - 1 - idCols - 1 - 1));
      // 如果 type 内容 + 两侧 sep > 当前 typeCols + 2 → 整块丢 type (不可能容纳 type 列)
      if (typeContentW + 2 > typeCols) {
        typeCols = 0;
      }
      // 若仍然不够, 缩 indent 到 0
      if (indent + markW + 1 + idCols + (typeCols > 0 ? typeCols + 2 : 1) > budgetLeft) {
        indent = 0;
        typeCols = Math.max(0, Math.min(typeColsMax, budgetLeft - indent - markW - 1 - idCols - 1 - 1));
        if (typeContentW + 2 > typeCols) typeCols = 0;
      }
      const titleCols = Math.max(
        0,
        budgetLeft - indent - markW - 1 - idCols - (typeCols > 0 ? typeCols + 2 : 1),
      );
      const typeChunk = typeCols > 0 ? ` ${padS(t.type, typeCols)} ` : ' ';
      const line = `${' '.repeat(indent)}${mark} ${padS(t.id, idCols)}${typeChunk}${clip(t.title, titleCols)}${suffix}`;
      out.push((t.stale ? p.warn : p.dim)(line));
    }
  }

  out.push(p.dim(horizon(width, `fog · ${d.total - d.ruled} unruled`)));
  out.push(p.accent(clip(
    `fog ${pct}% ${bar(d.ruled, d.total)} · open ${d.frontier.length} · blocked ${d.blockedTickets.length} · run x${d.runs.length}`,
    width,
  )));
  out.push(p.dim(clip('up/down picks a ticket · Enter on-site · g ask first · d hand to engine · Ctrl+P quit', width)));
  return clampMapHeight(out, o.height, width, p);
}

/**
 * 画法 B · 三角洲:主干(goal)→ 凝固支流(实线链,左→右)→ 梢头挂票(虚段)→ 右侧雾场列。
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
  // 底部雾场封顶 (同画法 C 的理由, 见 FOG_BAND_MAX): 原先撑满剩余高度 = 整屏马赛克。
  const fill = Math.max(0, Math.min(FOG_BAND_MAX - 1, o.height - out.length - 3));
  for (let i = 0; i < fill; i++) out.push(p.dim(fitLine(`     ${fog(Math.max(0, w - 6), i < fill / 2 ? 1 : 0, i * 3)}`, w)));
  out.push(p.dim(fitLine(`fog  ${fog(Math.max(0, w - 6), 0, 4)}`, w)));
  out.push(summaryLine(d, w, p));
  out.push(keysLine(w, p));
  return clampHeight(out, o.height);
}
