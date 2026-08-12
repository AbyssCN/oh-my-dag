/**
 * src/serve/board-page —— pathfinder 票的**只读看板投影** (LoopX 对照, 2026-08-05)。
 *
 * ## 为什么是票, 不是 run
 *
 * DAG run 是分钟级的, 画成卡片没有意义 —— 它已经有 mermaid 图和 HUD。**票才是天然的卡片**:
 * 跨 session 存活、有状态迁移 (suggested → open → ruled → delivered)、有明确的 owner 裁决点。
 *
 * ## 从 LoopX 的 Lark 看板适配器拿的四条纪律 (拿的是纪律, 不是它的字段表)
 *
 * ① **卡片正面只留 6 个字段**, 其余进详情 —— 首屏必须能扫。
 * ② **看板是 projection, 不是 planning engine**: 新票仍走票的生命周期 (`map_add` / `map_rule`),
 *    这里只投影。LoopX 原话: "The board is a status tracker and claim surface, not the
 *    task-planning engine."
 * ③ **前端不造第二个事实源**: 不发明隐藏队列、浏览器私有排序、CLI 读不到的控制决策。
 *    对本仓尤其要紧 —— `.omd/pathfinder/` 与 `docs/plan/pathfinder/*.md` 是真相文件,
 *    看板一旦能写就有两份真相。**所以这一页零写回**: 只有 GET, 一个 POST 都没有。
 * ④ **待 owner 决断的那一格装的是具体问题文本, 不是「等 owner」** —— LoopX 那张字段表里
 *    最值钱的一格。所以 `escalated` 列的卡片**不截断标题**: 那句话就是要 owner 回答的问题。
 *
 * ## 刻意没有的东西
 *
 * 零构建 (不进 `web/` 的 Vite 管线)、零依赖、单文件字符串。理由是这一页的全部价值是
 * "打开就能看", 而经过构建的东西在 `web/dist` 缺席时就打不开 —— 那正是最想看它的时候。
 * peer claim / lease / 卡片拖动全部不做: omd 是单 owner 单执行体, 那套解的是多 owner 协作。
 *
 * 视觉: 浅色 Swiss grid, 无暗色/HUD 风。
 */

import type { Ticket } from '../harness/pathfinder/types';

/** 列序 = 票的生命周期顺序 (与 {@link import('../harness/pathfinder/types').TicketStatus} 同词表)。 */
export const BOARD_COLUMNS = [
  { status: 'escalated', label: '待 owner 决断', hint: '`?` 上报 —— 卡片不截断, 那句话就是要你回答的问题' },
  { status: 'suggested', label: '机器建议待确认', hint: '来自 S-1 建议管线, 尚未进入前沿' },
  { status: 'open', label: '前沿可动', hint: '前置已散尽, 现在就能派' },
  { status: 'blocked', label: '前置未散', hint: '被 blockedBy 挡着 —— 挡它的票在卡片上' },
  { status: 'ruled', label: '已裁决', hint: '有 ruling, 等编译成 slice' },
  { status: 'delivered', label: '已交付', hint: '终态 (⚠ delivered ✅ ≠ 东西真在, 逐票核对真身)' },
] as const;

/**
 * 控制台 SDD D-3 的两新列 —— **派生相**, 不是 TicketStatus。
 *
 * 为什么派生:INV-1「map 盘上状态是唯一写真源」+ D-1「看板是视图」。「有没有 run 在跑它」
 * 由 `Ticket.dispatch` 锚承载 (D-6③ 地基), 列只是把锚读成一个词。把它做成两个新 status 会
 * 波及每一处 status switch / gh label 映射 / frontier 判定, 且真源里会多出两个只有看板关心的态。
 *
 * 判据(只认盘上事实, 不猜):
 *  - `in-flight`  锚在、没 finishedAt → 正在跑。
 *  - `in-review`  锚在、有 finishedAt、票**仍是 ruled** → 跑完了却没进 delivered, 等人看。
 *    ⚠ 刻意不看 `outcome`: 跑挂了 (failed) 和跑过了但 markDelivered 没执行到 (进程在两步之间死了)
 *    是同一件事 —— 「跑完待验」。只认 passed 会把后一种漏成"什么都没发生"。
 *  - 其余 → null, 该票由它自己的 status 决定落哪一列。
 */
export type DispatchPhase = 'in-flight' | 'in-review';

export function dispatchPhaseOf(t: Pick<Ticket, 'status' | 'dispatch'>): DispatchPhase | null {
  const d = t.dispatch;
  if (!d) return null; // 缺席 = 从没派发过 (不是"派发失败", 见 Ticket.dispatch 注)
  if (!d.finishedAt) return 'in-flight';
  return t.status === 'ruled' ? 'in-review' : null;
}

const STYLE = `
:root{--ink:#1a1a1a;--dim:#6b6b6b;--line:#e2e2e2;--bg:#fafafa;--card:#fff;--accent:#1f4fd8}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);
  font:14px/1.55 ui-sans-serif,system-ui,"Helvetica Neue",Arial,"Noto Sans SC",sans-serif}
header{padding:20px 24px 14px;border-bottom:1px solid var(--line);background:var(--card);
  display:flex;align-items:baseline;gap:16px;flex-wrap:wrap}
h1{margin:0;font-size:17px;font-weight:600;letter-spacing:-.01em}
.sub{color:var(--dim);font-size:12px}
select{font:inherit;padding:4px 8px;border:1px solid var(--line);border-radius:3px;background:var(--card)}
.ro{margin-left:auto;font-size:11px;color:var(--dim);border:1px solid var(--line);
  padding:3px 8px;border-radius:3px;letter-spacing:.02em}
main{display:grid;grid-template-columns:repeat(6,minmax(210px,1fr));gap:1px;
  background:var(--line);border-top:1px solid var(--line);min-height:calc(100vh - 64px)}
section{background:var(--bg);padding:12px 12px 40px;min-width:0}
h2{margin:0 0 2px;font-size:12px;font-weight:600;letter-spacing:.02em;
  display:flex;justify-content:space-between;align-items:baseline;gap:8px}
h2 .n{color:var(--dim);font-weight:400;font-variant-numeric:tabular-nums}
.hint{margin:0 0 10px;font-size:11px;color:var(--dim);line-height:1.4;min-height:2.6em}
article{background:var(--card);border:1px solid var(--line);border-radius:3px;
  padding:9px 10px;margin-bottom:8px}
.t{font-weight:500;margin-bottom:6px;word-break:break-word}
.clip{display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
dl{margin:0;display:grid;grid-template-columns:auto 1fr;gap:2px 8px;font-size:11.5px}
dt{color:var(--dim)}
dd{margin:0;word-break:break-word;font-variant-numeric:tabular-nums}
code{font:11px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--bg);
  padding:1px 4px;border-radius:2px}
.empty{color:var(--dim);font-size:11.5px;padding:6px 0}
.err{margin:24px;padding:12px 14px;border:1px solid #e6c9c9;background:#fdf6f6;border-radius:3px}
`;

/**
 * 客户端脚本。**只有 GET** —— 三处 fetch 全是读, 没有任何写路径 (纪律③, 由
 * `daemon.test.ts` 的「零写回」闸钉住)。
 */
const SCRIPT = `
const COLS = ${JSON.stringify(BOARD_COLUMNS)};
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

/** 卡片六字段 (纪律①)。第 6 格随票型变 —— 每张票只有其中一个非空, 印空格没有意义。 */
function card(t, full) {
  const rows = [];
  rows.push(['型', esc(t.type)]);
  if (t.blockedBy && t.blockedBy.length) rows.push(['挡它的', t.blockedBy.map((x) => '<code>' + esc(x) + '</code>').join(' ')]);
  if (t.ruling) rows.push(['裁决', esc(t.ruling.length > 140 ? t.ruling.slice(0, 140) + '…' : t.ruling)]);
  if (t.dNumber) rows.push(['溯源', '<code>' + esc(t.dNumber) + '</code>']);
  if (t.suggestedBy) rows.push(['谁提的', '<code>' + esc(t.suggestedBy) + '</code>']);
  rows.push(['id', '<code>' + esc(t.id) + '</code>']);
  return '<article><div class="t' + (full ? '' : ' clip') + '">' + esc(t.title) + '</div><dl>' +
    rows.map(([k, v]) => '<dt>' + k + '</dt><dd>' + v + '</dd>').join('') + '</dl></article>';
}

function render(map) {
  document.getElementById('dest').textContent = map.destination;
  document.getElementById('board').innerHTML = COLS.map((c) => {
    const ts = map.tickets.filter((t) => t.status === c.status);
    // 纪律④: 待 owner 决断那一列不截断标题。
    const full = c.status === 'escalated';
    return '<section><h2>' + c.label + '<span class="n">' + ts.length + '</span></h2>' +
      '<p class="hint">' + c.hint + '</p>' +
      (ts.length ? ts.map((t) => card(t, full)).join('') : '<div class="empty">—</div>') + '</section>';
  }).join('');
}

async function load(slug) {
  const r = await fetch('/api/maps/' + encodeURIComponent(slug));
  if (!r.ok) throw new Error('读地图失败: ' + r.status);
  render(await r.json());
}

(async () => {
  try {
    const maps = await (await fetch('/api/maps')).json();
    if (!maps.length) {
      document.body.insertAdjacentHTML('beforeend', '<div class="err">这个仓里还没有 pathfinder 地图 —— 先 <code>/omd-path</code> 开一张。</div>');
      return;
    }
    const sel = document.getElementById('slug');
    sel.innerHTML = maps.map((m) => '<option value="' + esc(m.slug) + '">' + esc(m.destination || m.slug) + '</option>').join('');
    sel.onchange = () => load(sel.value);
    await load(maps[0].slug);
  } catch (e) {
    document.body.insertAdjacentHTML('beforeend', '<div class="err">' + esc(e.message) + '</div>');
  }
})();
`;

/** 整页 HTML (自包含: 无外链、无构建产物依赖)。 */
export function boardHtml(): string {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>omd · 决策地图看板</title>
<style>${STYLE}</style></head>
<body>
<header>
  <h1>决策地图</h1>
  <select id="slug"></select>
  <span class="sub" id="dest"></span>
  <span class="ro">只读投影 · 真相在 docs/plan/pathfinder/*.md</span>
</header>
<main id="board"></main>
<script>${SCRIPT}</script>
</body></html>`;
}
