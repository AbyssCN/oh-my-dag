/**
 * src/tui/render/now-band —— **「当前」区** (SDD 片 5 切片 1, 2026-08-22)。
 *
 * ## 这条带子在治什么
 *
 * `tui.ts:861-863` 那条盲比判词点的是「流式回答下方混入**与本题无关**的仪表盘内容
 * (进度条 8/23、前沿票工单表、阻塞集) **共 3 块**」 —— 判的是「3 块」+「与本题无关」,
 * 不是「不许有常驻区」。今天 `hasDialogue` (`chat-log.ts:148`) 一刀切把 pathHud /
 * ticketBoard / runBoard 三块在人开口后全收 —— 副作用是 **stale 票、等你裁的票
 * 恰恰在你干活时看不见**。
 *
 * 这条带子是对那条判词的正解, 不是推翻: 三块 → **一条**; 内容按状态选一档; 闲时
 * 只 1 行, 没东西时 0 行 (INV-NOW-3 无源恒缺席)。下一个人读到「常驻区」三个字时
 * 第一反应会是「这不是被判过吗」 —— 看清楚上面那段再下笔。
 *
 * ## 四档一选 (INV-NOW-1)
 *
 * `① 等你 → ② 在跑 → ③ 欠账 → ④ 闲`; 选中一档就只画那一档, 不叠加 (PRODUCT.md 那
 * 句定位「把**哪一件事**在等你放在最亮处」是单数, 叠加就没有「最亮处」了)。
 * 数据源 (契约 §INV-NOW-4 原话):
 *   - ① 等你 = `awaiting` ∪ `suggested`  (两栏都属于 owner 注意力, 折一档)
 *   - ② 在跑 = `phase==='live'` 的分片 (`readDagShards`)
 *   - ③ 欠账 = (无源, 见下)            (原计划「checkpoint 落后 N 轮」在 SDD 非目标里被砍)
 *   - ④ 闲   = `maps` 的雾档汇总
 *
 * ⚠ 「③ 欠账」目前无源, 等 CheckpointManager 有真读数再接 —— 不许拿更高优先级的东西去填。
 *
 * ## 封顶 3 行 (INV-NOW-2)
 *
 * 超出 → 砍**右半的提示**, 不砍读数。窄屏 (60 列) 先丢提示, 不丢数。`fitLine` 走
 * pi-tui `truncateToWidth` (CJK = 2 列), 不手写第二套 (与 `path-fog.ts` 同条)。
 *
 * ## 渲染层不读盘 (INV-NOW-5)
 *
 * 纯函数; 取数在 `tui.ts`, 复用既有 `refreshTicketBoard` / `refreshRunBoard` 那条路。
 * 同一个输入连画两次输出逐字节相同 —— `now-band-wiring.test.ts` 的那条闸钉这一点。
 *
 * ## 字形
 *
 * 全部在 `SAFE_GLYPH_WIDTHS` 白名单 (已量于 Windows Terminal + JetBrainsMono Nerd
 * Font Mono, 2026-08-08): `⚠ ▶ ○ · ? ~`。`▸` 也白名单 (片 4 选中行已用)。
 */
import { visibleWidth } from '@earendil-works/pi-tui';
import type { AttentionTicket, MapFogSummary } from '../../serve/read-api';
import type { DagView } from '../../hud/load';
import { fitLine } from './line';

/** 色道钩子。注入 = 上色; 省略 = 恒等 (NO_COLOR / 测试)。结构信息 (⚠ ▶) 不靠色。 */
export interface NowPaint {
  accent(s: string): string;
  dim(s: string): string;
  warn(s: string): string;
  ok(s: string): string;
}
const PLAIN: NowPaint = {
  accent: (s) => s,
  dim: (s) => s,
  warn: (s) => s,
  ok: (s) => s,
};

/**
 * 已取好的结构 (INV-NOW-5: 渲染层不读盘)。
 *
 * ⚠ 三个字段都直接复用真源类型 —— `AttentionTicket` / `MapFogSummary` 来自
 * `read-api.ts`, `DagView` 来自 `hud/load.ts`。**不造平行结构** (本仓 D-2: 两处
 * 声明同一件事必漂)。
 */
export interface NowBandInput {
  /** 等你裁的票 (`band==='awaiting-owner'`), 取自 `readAttention(cwd).awaiting`。 */
  awaiting: readonly AttentionTicket[];
  /** 机器建议待 accept/reject (`band==='suggested'`), 取自 `readAttention(cwd).suggested`。 */
  suggested: readonly AttentionTicket[];
  /** 在跑的分片, 取自 `readDagShards(cwd, now).filter(phase==='live')`。 */
  live: readonly DagView[];
  /** 雾档汇总, 取自 `readAttention(cwd).maps`。 */
  maps: readonly MapFogSummary[];
}

/**
 * 四档标签的字面值。导出供单测断言 (反查 ↔ 数据契约)。
 *
 * `debt` 是「③ 欠账」那一档的位子 —— 当前无源, 但 4 档一选的契约 (INV-NOW-1)
 * 与「四档各自的字面值」那张表 (单测用) 都不许少一格。等 CheckpointManager 接上
 * 真读数时, 这张表就是字形锚点。
 *
 * 选了 ASCII 标点 + 已有白名单字形, 没引入新字形 (INV-5)。中文档上那一句
 * 「把哪一件事在等你放在最亮处」是这个梯队的语义, 不是要把文案全改成 CJK —
 * 「当前」区的字面值在这里看得出就行。
 */
export const TIER_LABEL = {
  awaiting: 'needs you',
  live: 'running',
  debt: 'owed',
  maps: 'idle',
} as const;

/** 四档各自的前缀字形 (白名单里)。结构信息走前缀 + 文字, 不靠颜色 (INV-5)。 */
const TIER_MARK: Record<keyof typeof TIER_LABEL, string> = {
  awaiting: '⚠',  // U+26A0, width 1, SAFE
  live: '▶',      // U+25B6, width 1, SAFE (复用 run-list 的 RUN_MARK.live)
  debt: '?',      // ASCII; ③ 档目前无渲染器, 字形先占位 (TASK 守则: 不许删键)
  maps: '~',      // ASCII
};

/** 「在跑」一行最多容纳的进度摘要字符数 (含 runId8 + 分隔)。窄屏再缩。 */
const W_RUNID = 9;       // `XXXXXXXX `
const W_PROG = 5;        // `XX/XX `
const W_AGE = 9;         // `12m30s  `
const W_LIVE_FIXED = W_RUNID + W_PROG + W_AGE;

/** 可见列感知的右补白 —— 复用 `run-list.ts` 的写法 (CJK 列宽 = 2)。 */
const padS = (text: string, cols: number): string =>
  text + ' '.repeat(Math.max(0, cols - visibleWidth(text)));

/** 时长。`Infinity` (坏时戳) → null —— 调方画 `起点未记`, 不画 `0m` / `Infinitym`。 */
const fmtAge = (ms: number): string | null => {
  if (!Number.isFinite(ms) || ms < 0) return null;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return s > 0 ? `${m}m${s}s` : `${m}m`;
};

/** 节点进度: 同 `run-list.ts` 的 `progressOf` 公式。空 → null (`—/—`)。 */
function liveProgress(v: DagView): { done: number; total: number } | null {
  const snap = v.snap;
  const total = snap.planned.length + snap.started.length;
  if (total === 0) return null;
  return { done: snap.settled.length, total };
}

/* ──────────────────────────────────────────────────────────────────────────
 * 四档各自的行构造
 * ────────────────────────────────────────────────────────────────────────── */

/** ① 等你: 一行。`⚠ 等你 · N 票(其中 M 待收件) · <id> <title…>`。
 * 等你 = `awaiting` ∪ `suggested` (契约 §INV-NOW-4 原话: 两栏都属于 owner 注意力)。
 * 两类折到一档, 行文里把「待收件」(`suggested` 那部分) 的数单独点出来,
 * 让读者一眼分得清「等你裁的」与「机器建议待 accept/reject」。
 *
 * - `awaiting` 优先: 第一张 (屏上那行展示的) 总是 `awaiting[0]`, 它空才用 `suggested[0]`。
 *   理由: 等你裁的更紧迫, 把它压在建议票后面反而把这条带子的核心给埋了。
 * - 无 `suggested` 时不画括号 (无信息就不造噪音, 与闲档不画 0 同条)。*/
function renderAwaiting(
  awaiting: readonly AttentionTicket[],
  suggested: readonly AttentionTicket[],
  width: number,
  p: NowPaint,
): string {
  const mark = p.warn(TIER_MARK.awaiting);
  const label = p.warn(TIER_LABEL.awaiting);
  const nAwait = awaiting.length;
  const nSug = suggested.length;
  const n = nAwait + nSug;
  // awaitng 优先 (awaiting[0] ?? suggested[0]!); 调用方已保证 n>0。
  const first = (awaiting[0] ?? suggested[0])!;
  // 行文: `⚠ 等你 · N 票(其中 M 待收件) · <id> <title…>`
  // 无 suggested 时退回到旧的多行计数格式 `⚠ 等你:N 票 · …`, 跟单件无后缀的旧格式区分开。
  const head =
    nSug > 0
      ? `${mark} ${label} · ${n} tickets (${nSug} unreceived) · `
      : n > 1
        ? `${mark} ${label}:${n} tickets · `
        : `${mark} ${label} · `;
  // id 与 title 之间用空格分隔 (id 单字 word, title 可能很长 → title 走截断)。
  const tail = `${first.ticketId} ${first.title}`;
  return fitLine(`${head}${tail}`, width, '...');
}

/** ② 在跑: 一行。`▶ 在跑 · <runId8> <prog> <age> <goal…>`。多 run 时加计数。 */
function renderLive(views: readonly DagView[], width: number, p: NowPaint): string {
  const mark = p.accent(TIER_MARK.live);
  const label = p.accent(TIER_LABEL.live);
  const first = views[0]!;
  const runId = padS(first.snap.runId.slice(0, 8), W_RUNID - 1) + ' ';
  const prog = liveProgress(first);
  const progStr = prog ? `${prog.done}/${prog.total}` : '—/—';
  const progPad = padS(progStr, W_PROG - 1) + ' ';
  const ageStr = fmtAge(first.ageMs) ?? 'start not recorded';
  const agePad = padS(ageStr, W_AGE - 1) + ' ';
  const goalCols = Math.max(0, width - W_LIVE_FIXED);
  const goal = clip(first.snap.goal, goalCols);
  const head = views.length > 1 ? `${mark} ${label}:${views.length} · ` : `${mark} ${label} · `;
  // head 长度算进列预算: 窄屏时优先丢 head 后面的 runId 之前那点信息已经在 head 里,
  // goal 列在窄屏会被裁掉。
  const line = `${head}${runId}${progPad}${agePad}${goal}`;
  return fitLine(line, width, '...');
}

/** ③ 欠账: 无源, 等 CheckpointManager 有真读数再接 (见文件头 ⚠)。
 * 阶梯这一格**故意落空**: 不许拿更高优先级的东西去填, 阶梯落空是诚实的。
 * 字面值/字形 (TIER_LABEL.debt / TIER_MARK.debt) 仍然挂着, 是为 4 档一选的
 * 契约 (INV-NOW-1) 与「四档字面值」那张表 (单测) 都不许少一格。*/

/** ④ 闲: 一行。`~ 闲 · N 张图 · <bands 概要>`。无 bands 时只留计数。 */
function renderMaps(items: readonly MapFogSummary[], width: number, p: NowPaint): string {
  const mark = p.dim(TIER_MARK.maps);
  const label = p.dim(TIER_LABEL.maps);
  // bands 各档计数; 没记录就是 0 —— 但**全 0 也是真值** (一张没票的图也合法存在),
  // 0 不省略, 与 `run-list.ts` 头行计数同条纪律 (INV-DAG-2 NULL ≠ 0)。
  const total = items.length;
  const phantoms = items.reduce((n, m) => n + m.phantoms, 0);
  // 摘要: 第一张图的 bands 列出来, 其余折叠到 `+N`。窄屏先丢 bands 详情。
  const first = items[0]!;
  const bands = Object.entries(first.bands)
    .map(([b, n]) => `${b}:${n}`)
    .join(', ');
  const tail = bands
    ? ` · ${bands}${total > 1 ? `, +${total - 1}` : ''} · phantoms:${phantoms}`
    : ` · phantoms:${phantoms}`;
  const head = `${mark} ${label} · ${total} runs`;
  return fitLine(`${head}${tail}`, width, '...');
}

/** 截断补 `…`;只用于 goal 摘要列。CJK 列宽 = 2, 走 visibleWidth。 */
const clip = (text: string, cols: number): string => {
  if (cols <= 0) return '';
  if (visibleWidth(text) <= cols) return text;
  if (cols === 1) return '...';
  let out = '';
  for (const ch of text) {
    if (visibleWidth(out + ch) > cols - 1) break;
    out += ch;
  }
  return out + '...';
};

/* ──────────────────────────────────────────────────────────────────────────
 * 公开入口
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * 画一条「当前」带子。**最多 3 行**, 大多数时候只 1 行, 无源时 0 行 (INV-NOW-3)。
 *
 * 四档一选 (INV-NOW-1): 等你 → 在跑 → 欠账 → 闲。
 *
 * @param input  已取好的结构 (INV-NOW-5: 渲染层不读盘)
 * @param o.width  屏宽 (可见列, CJK = 2)
 * @param o.now    当前 ms (注入, 防 `Date.now()` 跑单测时漂移; 本渲染器当前未用,
 *                留位为后续 age 派生用)
 * @param o.paint  色道钩子;省略 = 恒等 (NO_COLOR 与测试)
 */
export function renderNowBand(
  input: NowBandInput,
  o: { width: number; now: number; paint?: NowPaint },
): string[] {
  const p = o.paint ?? PLAIN;
  const w = o.width;
  void o.now; // 当前规格下未消费 (输入结构已含 ageMs), 留位防 "现在改一个读 now
              // 的实现就被悄悄换成 Date.now()" 这类 drift。详见 src/hud/load.ts 的
              // `gradeSnapshot` 同样的注入理由。
  // INV-NOW-3: 无源恒缺席。
  if (
    input.awaiting.length === 0 &&
    input.suggested.length === 0 &&
    input.live.length === 0 &&
    input.maps.length === 0
  ) {
    return [];
  }
  // INV-NOW-1 + INV-NOW-4: 阶梯只选一档, 选中就只画那一档; 上一档空才往下走。
  // ① 等你 = `awaiting` ∪ `suggested` (INV-NOW-4 原话) —— 折一档: 任意一边非空都走这一档,
  // 否则建议票会被「在跑」埋掉 (这条带子的存在理由)。
  if (input.awaiting.length > 0 || input.suggested.length > 0) {
    return [renderAwaiting(input.awaiting, input.suggested, w, p)];
  }
  // ② 在跑
  if (input.live.length > 0) return [renderLive(input.live, w, p)];
  // ③ 欠账 = (无源, 见文件头 ⚠) —— 阶梯这一格故意落空。
  // ④ 闲
  // 闲档在没有任何 owner 注意力 / 活图时画 —— 但 `readAttention(cwd).maps` 可能含
  // 没票的空图, 这里以 maps.length > 0 为准 (一张图都没有 = 全空, 早返回时已兜)。
  if (input.maps.length > 0) return [renderMaps(input.maps, w, p)];
  return []; // 理论到不了 (前面早返回已覆盖), 留个空挡防 future drift。
}