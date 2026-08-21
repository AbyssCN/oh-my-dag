/**
 * scripts/tui-screens —— **四屏**渲染器 (omd TUI 视觉系统 v2, 2026-08-21)。
 *
 * ## v2 做的是减法: 10 屏 → 4 屏 (owner 2026-08-21 裁决)
 *
 * v1 给了 10 个形态, 那是**菜单不是承诺**。owner 挑完并指出真问题:
 * 「信息整合在一起而不是分这么多的形态和信息分散」。于是:
 *
 * | 砍掉的形态 | 并进哪儿 | 为什么 |
 * |---|---|---|
 * | DAG 表 (dag-hud) | **树** | status/model 是树行上的**列**, 不是另一个屏 |
 * | 泳道甘特 | **树** | 每行右侧一条微型时间条, 「谁慢」就地看得见 |
 * | 分层依赖 | **删** | 树已表达拓扑; 且它数据本就不全 (planned 事件不带 deps) |
 * | 节点详情 | **树** | 选中就地展开, 不另开屏 |
 * | 票看板 | **Map** | 徽章/STALE/等人时长全部并进散雾层级 |
 * | 活图切换器 + run 看板 | **Run** | 同一件事的两半 |
 *
 * 另一处减法: `kind` 与 `role` 合成一列 —— role 本来就是 kind 映射出来的 (dag-hud.ts:39-50),
 * 同时显示是纯重复。
 */
import { G, NODE_MARK, NODE_CH, TICKET_MARK, RUN_MARK, pad, padS, padSL, wrap, clip, rule, bar, horizon, dur, frame, lineW, keys } from './tui-frames.mjs';

// ══ 演示数据 ══════════════════════════════════════════════════════════════════════
export const RUN = {
  runId: '78f1951c', goal: '把 HudMirror 拆成每 run 一文件, 并让 TUI 从盘上读活图',
  nodes: [
    { id: 'plan', kind: 'conductor', t0: 0, t1: 2100, out: 'done', deps: [], model: 'kimi:k2' },
    { id: 'extract', kind: 'map', t0: 2100, t1: 3000, out: 'done', deps: ['plan'], model: 'kimi:k2' },
    { id: 'shard-1', kind: 'agent', t0: 3000, t1: 14200, out: 'done', deps: ['extract'], model: 'deepseek:v3', note: 'Read assemble.ts' },
    { id: 'shard-2', kind: 'agent', t0: 3000, t1: 21500, out: 'done', deps: ['extract'], model: 'deepseek:v3', note: 'Write mirror.ts' },
    { id: 'shard-3', kind: 'agent', t0: 3000, t1: 9100, out: 'failed', deps: ['extract'], model: 'deepseek:v3', fail: 'tsc: src/hud/mirror.ts:42 类型 RunId 不存在' },
    { id: 'merge', kind: 'inproc', t0: 21500, t1: 22000, out: 'done', deps: ['shard-1', 'shard-2'] },
    { id: 'verify', kind: 'primitive', t0: 22000, t1: 28400, out: 'failed', deps: ['merge'], model: 'gpt-5.6', verdict: { gate: 'verifier', v: 'fail', text: 'shard-3 的失败没被修, 合并结果不成立' } },
    { id: 'repair', kind: 'await', t0: 28400, t1: null, out: 'pending', deps: ['verify'] },
  ],
};
export const T_END = 32000;

export function statusAt(n, t) {
  if (t < n.t0) return 'pending';
  if (n.t1 == null || t < n.t1) return n.out === 'pending' ? 'pending' : 'running';
  return n.out;
}
const at = (t) => RUN.nodes.map((n) => ({ ...n, st: statusAt(n, t) }));

/** pathfinder 地图。**按散雾层级组织** —— 这是 v2 Map 屏的骨架。 */
export const MAP = {
  slug: '214', title: 'OMD TUI 观测面',
  goal: 'OMD TUI 观测面:多 run 活图 HUD · 散雾图可见性 · 截图粘贴 · 音视频进 chat block',
  runs: 2,
  gens: [
    { n: 1, tickets: [{ id: 'g1', type: 'grill', title: '判据 = 稿必须 100% 可复刻在 TUI', ruling: '过闸生成, 不手画' }] },
  ],
  frontier: [
    { id: '215', type: 'task', title: 'HudMirror 每 run 一文件 dag-<runId8>.json,修并发 run 互踩单文件', run: '78f1951c' },
    { id: '217', type: 'grill', title: '散雾图呼吸动画做不做 + 动画约束怎么定', wait: '4h' },
    { id: '220', type: 'grill', title: '音视频接受 ffmpeg + STT 端点外部依赖吗;v1 音频先行还是一起', wait: '4h', stale: true },
    { id: '216', type: 'task', title: 'DagTree 快照模式 loadSnapshot():复用 read-api 同机直读盘 + fs.watch 活 tick' },
    { id: '218', type: 'task', title: 'glyph 白名单重生成 → path-fog 换回重线族字形' },
    { id: '219', type: 'task', title: '剪贴板截图粘贴:平台探针 + Ctrl+O + .omd/attachments/ 存储' },
    { id: '221', type: 'task', title: 'Ctrl+G 全屏 run 切换器', run: '78f1951c' },
    { id: '222', type: 'task', title: 'web 端 readDagView 改 per-run mirror 读取' },
    { id: '224', type: 'task', title: 'leaf-media 扩展音视频:MEDIA_REF_RE + collectDepMedia 同一变换' },
  ],
  blocked: [{ id: '223', type: 'task', title: 'media-ingest 管线', by: '220' }],
  suggested: [{ id: '226', type: 'research', title: '机器建议:先量一次 fs.watch 在 WSL 上的延迟' }],
};
const mapTotal = () => MAP.gens.reduce((a, g) => a + g.tickets.length, 0) + MAP.frontier.length + MAP.blocked.length;
const mapRuled = () => MAP.gens.reduce((a, g) => a + g.tickets.length, 0);

// ══ 1. DAG 屏 ═════════════════════════════════════════════════════════════════════
// 合并 dag-tree + dag-hud + dag-gantt + 节点详情。一棵树, 每行是一条完整记录:
//   [选中] 树枝 状态 id  kind  model  时长  微型时间条
// 选中的节点**就地展开**判词 / 上游 / 下一步 —— 失败诊断不再是另一个屏。
export function dagScreen(t, o) {
  const ns = at(t);
  const sel = ns[((o.sel % ns.length) + ns.length) % ns.length];
  const kids = (id) => ns.filter((n) => n.deps[0] === id); // DAG 有 fan-in, 每个节点只画一次
  const body = [];

  // 列宽随屏宽退让: 窄屏先丢时间条, 再丢 model。
  const W = o.w - 4;
  const showBar = W >= 84;
  const showModel = W >= 70;
  const barW = showBar ? Math.min(22, Math.floor(W * 0.2)) : 0;
  const idW = 11, kindW = 11, modelW = showModel ? 13 : 0, durW = 7;

  const emit = (n, depth, last) => {
    const st = n.st;
    const isSel = n.id === sel.id;
    const branch = depth === 0 ? '' : '  '.repeat(depth - 1) + (last ? G.lbl + G.lh : G.llj + G.lh);
    const l = [[isSel ? ' ' + G.sel + ' ' : '   ', 's'], [branch, 'd'], [NODE_MARK[st], NODE_CH[st]], [' ', '']];
    const nameCell = clip(n.id, idW - 1);
    l.push([nameCell, isSel ? 's' : '']);
    // 树枝把名字推右了, 所以列对齐用「补到目标列」而不是 padEnd。
    const colStart = 4 + (o.w >= 100 ? 26 : 22);
    l.push([' '.repeat(Math.max(1, colStart - lineW(l))), '']);
    l.push([padS(clip(n.kind, kindW - 1), kindW), n.kind === 'await' ? 'w' : 'd']);
    if (showModel) l.push([padS(n.model ?? '—', modelW), 'd']);
    // NULL ≠ 0 ≠ 不适用: **还没跑的节点没有时长**, 画 —。
    // ⚠ 第一版这里漏了 pending 分支, 于是 t=0 的屏上印着 `shard-1 11.2s` —— 把「未来会花多久」
    //   当成了「已经花了多久」, 而引擎那一刻根本没有这个数。这正是纪律②要拦的那种错。
    const d = st === 'pending' ? null : dur(st === 'running' ? t - n.t0 : n.t1 == null ? null : n.t1 - n.t0);
    l.push([padSL(d ?? '—', durW - 1) + ' ', 'd']);
    if (showBar && st !== 'pending') {
      const a = Math.round((n.t0 / T_END) * barW);
      const end = st === 'running' ? t : n.t1;
      const w = Math.max(1, Math.round(((end - n.t0) / T_END) * barW));
      l.push([G.dot.repeat(a), 'd'], [G.full.repeat(w), NODE_CH[st] === 'dim' ? 'd' : NODE_CH[st]],
        [G.dot.repeat(Math.max(0, barW - a - w)), 'd']);
    }
    if (n.deps.length > 1) l.push([`  ${G.x} +${n.deps.slice(1).join(',')}`, 'w']);
    body.push(l);

    // ── 选中就地展开: 判词 / 上游失败 / 下一步。这是原「节点详情」屏的全部内容。
    if (isSel) {
      const ind = '      ';
      if (n.verdict && st !== 'pending' && st !== 'running') {
        for (const w of wrap(`${n.verdict.gate} 判 ${n.verdict.v}:${n.verdict.text}`, W - 8))
          body.push([[ind, ''], [(n.verdict.v === 'fail' ? G.fail : G.ok) + ' ' + w, n.verdict.v === 'fail' ? 'fail' : 'ok']]);
        body.push([[ind + '  判词的 pass/fail 指的是被审对象, 不是闸本身', 'd']]);
      }
      if (n.fail && st === 'failed') for (const w of wrap(n.fail, W - 8)) body.push([[ind, ''], [G.fail + ' ' + w, 'fail']]);
      const upFail = n.deps.map((d) => ns.find((x) => x.id === d)).filter((x) => x && x.st === 'failed');
      for (const u of upFail) body.push([[ind + '上游 ', 'd'], [G.fail + ' ' + u.id, 'fail'], ['  ' + clip(u.fail ?? '', W - 22), 'd']]);
      if (st === 'failed' || n.kind === 'await') {
        body.push([[ind, ''], ['r', 'a'], [' 重跑并续图    ', 'd'], ['i', 'a'], [' 介入: 手改后标绿    ', 'd'], ['s', 'a'], [' 停图, 记进台账', 'd']]);
      }
    }
    const ks = kids(n.id);
    ks.forEach((k, i) => emit(k, depth + 1, i === ks.length - 1));
  };
  ns.filter((n) => n.deps.length === 0).forEach((n) => emit(n, 0, true));

  // 表头 (对齐树行的列)。
  const colStart = 4 + (o.w >= 100 ? 26 : 22);
  const head = [[' '.repeat(colStart), '']];
  head.push([padS('kind', kindW), 'd']);
  if (showModel) head.push([padS('model', modelW), 'd']);
  head.push([padSL('用时', durW - 1) + ' ', 'd']);
  if (showBar) head.push([`0s${G.lh.repeat(Math.max(0, barW - 5))}${(T_END / 1000) | 0}s`, 'd']);
  body.unshift(head);

  const done = ns.filter((n) => n.st === 'done').length;
  const fail = ns.filter((n) => n.st === 'failed').length;
  const right = [...bar(done, ns.length), ...(fail ? [[`  ${G.fail}${fail}`, 'fail']] : []), [`  ${dur(t)}`, 'd']];
  return [...frame([['run ' + RUN.runId, 'b']], right, body, o.w, o.h - 1,
    [[clip(RUN.goal, o.w - 8), 'd']]),
    keys(`${G.up}${G.down} 选节点 · Enter 展开输出 · r/i/s 处理失败 · Ctrl+G 退出`)];
}

// ══ 2. Map 屏 ═════════════════════════════════════════════════════════════════════
// 合并 path-fog + ticket-board。owner 对 v1 方案 B 的三条意见, 逐条兑现:
//   ① 看不到 goal          → goal 顶格独占一段, 换行不截断
//   ② 看不到扩散层级        → **按层级分段**: 已散 gen-N → 前沿可动 → 受阻 → 建议 → 雾
//   ③ 看不到节点票 / 要票看板 → 每行带 ticket-board 的全部信息 (徽章 · STALE · 等人时长 · 来源 run)
// 双栏改回单栏满宽: 栏宽是拿来给标题的, 不是拿来切两半的。
export function mapScreen(t, o) {
  const W = o.w - 4;
  const rows = [...MAP.frontier, ...MAP.blocked, ...MAP.suggested];
  const sel = ((o.sel % rows.length) + rows.length) % rows.length;
  const selId = rows[sel].id;
  const body = [];

  body.push([]);
  const g0 = wrap(MAP.goal, W - 9);
  body.push([[' goal   ', 'a'], [g0[0], '']]);
  for (const w of g0.slice(1)) body.push([['         ' + w, '']]);
  body.push([]);

  const idW = 6, typeW = 10;
  /** 一票一行: [选中] 记号 id 类型 标题 …… 右侧状态注。 */
  const row = (tk, mark, markCh, right, rightCh) => {
    const isSel = tk.id === selId;
    const l = [[isSel ? ' ' + G.sel + ' ' : '   ', 's']];
    l.push([mark + ' ', markCh], [padS(tk.id, idW), isSel ? 's' : ''], [padS(tk.type, typeW), tk.type === 'grill' ? 'w' : 'd']);
    // STALE 靠右与「等你」并列 —— 放左前缀会把整行列位推歪 (第一版实测); 而且等太久与 stale
    // 本就是同一件事的两半, 挨着读更顺。**仍是文字不是颜色** (结构信息不靠色)。
    const tail = tk.stale ? `${G.fail} STALE  ${right ?? ''}` : right;
    const tailCh = tk.stale ? 'fail' : rightCh;
    const room = W - lineW(l) - (tail ? vwSafe(tail) + 2 : 0);
    l.push([clip(tk.title, Math.max(10, room)), isSel ? '' : tk.by ? 'd' : '']);
    if (tail) l.push([' '.repeat(Math.max(1, W - lineW(l) - vwSafe(tail))), ''], [tail, tailCh]);
    body.push(l);
    // 选中就地展开: 已裁的给 ruling, 未裁的给下一步。
    if (isSel) {
      if (tk.ruling) for (const w of wrap('裁决:' + tk.ruling, W - 10)) body.push([['       ' + w, 'ok']]);
      else if (tk.sug) body.push([['       ', ''], ['机器建议票 — 先 c 收件 / x 退回, 确认后才可裁', 'w']]);
      else body.push([['       ', ''], ['Enter', 'a'], [' 就地裁    ', 'd'], ['g', 'a'], [' 先问清楚    ', 'd'], ['d', 'a'], [' 交给引擎跑', 'd']]);
    }
  };
  const vwSafe = (s) => lineW([[s, '']]);

  for (const gen of MAP.gens) {
    body.push(rule(`已散 · gen-${gen.n}`, `${gen.tickets.length} 张`, W));
    for (const tk of gen.tickets) row(tk, G.ok, 'ok', null, null);
    body.push([]);
  }
  body.push(rule('前沿 · 可动', `${MAP.frontier.length} 张`, W));
  for (const tk of MAP.frontier) row(tk, TICKET_MARK[tk.type], tk.wait ? 'w' : 'a', tk.wait ? `${G.warn} 等你 ${tk.wait}` : tk.run ? `${G.left} run ${tk.run.slice(0, 4)}` : null, tk.wait ? 'w' : 'd');
  body.push([]);
  if (MAP.blocked.length) {
    body.push(rule('受阻', `${MAP.blocked.length} 张`, W));
    for (const tk of MAP.blocked) row(tk, G.lh, 'd', `${G.left} 等 ${tk.by} 裁`, 'w');
    body.push([]);
  }
  if (MAP.suggested.length) {
    body.push(rule('机器建议 · 未收件', `${MAP.suggested.length} 张`, W));
    for (const tk of MAP.suggested) row({ ...tk, sug: true }, '○', 'd', `${G.warn} 待收件`, 'w');
  }

  const pct = Math.round((mapRuled() / mapTotal()) * 100);
  return [...frame([[`map ${MAP.slug} `, 'd'], [G.dot + ' ', 'd'], [MAP.title, 'b']],
    [['散雾 ', 'd'], [`${pct}%`, 'a'], [' ', ''], ...bar(mapRuled(), mapTotal(), 10), [` · ${MAP.runs} runs`, 'd']],
    body, o.w, o.h - 2, horizon(W, `雾 · ${mapTotal() - mapRuled()} 张未裁`)),
    keys(`${G.up}${G.down} 选票 · Enter 就地裁 · g 先问 · d 交给引擎 · Ctrl+P 退出`)];
}

// ══ 3. 收件箱 ═════════════════════════════════════════════════════════════════════
// 唯一回答「现在轮到我做什么」的屏。map 票的等人态 + run 的 await 节点 + 待收产物, 汇一处。
//
// **裁决流程** (读自 src/mcp/tools/pathfinder.ts:474-529, 不是设想):
//   · `map_rule(ticketId, ruling, disposition)` —— disposition: execute(默认, 裁后进区域) / close(裁决即终结)
//   · **裁决 ≠ 执行**: 「区域散尽只报信, 执行必须显式 path_deliver (owner 扣扳机)」→ 就地直裁是安全的
//   · ⚠ ruling 文本**会成为 task 票的 slice node goal** (:480) —— 你打的字就是执行体照着干的那句
//   · suggested 票**按不进裁决** (:503 硬闸), 必须先 map_confirm accept/reject
// 于是屏上给两条路, 且把上面两条注意事项**常驻印在底边**, 不靠人记。
export function inboxScreen(t, o) {
  const W = o.w - 4;
  const items = [
    { id: '217', src: 'map 214', kind: 'grill', txt: '散雾图呼吸动画做不做 + 动画约束怎么定', wait: '4h', mode: 'rule' },
    { id: '220', src: 'map 214', kind: 'grill', txt: '音视频接受 ffmpeg + STT 端点外部依赖吗;v1 音频先行还是一起', wait: '4h', stale: true, mode: 'rule' },
    { id: 'repair', src: 'run 78f1951c', kind: 'await', txt: 'verifier 判 fail — 修复轮等你定:重跑 / 介入 / 停图', wait: '3m', mode: 'node' },
    { id: 'slice.json', src: 'run r2', kind: 'await', txt: '产物等收, 逼近超时', wait: '24m', mode: 'take' },
    { id: '226', src: 'map 214', kind: 'research', txt: '机器建议:先量一次 fs.watch 在 WSL 上的延迟', wait: '1h', mode: 'confirm' },
  ];
  const sel = ((o.sel % items.length) + items.length) % items.length;
  const body = [];
  body.push([]);
  items.forEach((it, i) => {
    const isSel = i === sel;
    const l = [[isSel ? ' ' + G.sel + ' ' : '   ', 's']];
    l.push([G.warn + ' ', 'w'], [padS(it.id, 11), isSel ? 's' : 'w'], [padS(it.kind, 10), 'd'],
      [padS(`等你 ${it.wait}`, 11), 'w'], [padS(it.src, 15), 'd']);
    if (it.stale) l.push([`${G.fail} STALE`, 'fail']); // 靠右, 不推歪左列
    body.push(l);
    for (const w of wrap(it.txt, W - 7)) body.push([['     ' + w, isSel ? '' : 'd']]);
    if (isSel) {
      body.push([]);
      if (it.mode === 'rule') {
        body.push([['     ', ''], ['Enter', 'a'], [' 就地裁 ', ''], ['(直接落 map_rule, 不烧模型)', 'd']]);
        body.push([['     ', ''], ['g', 'a'], ['     先问清楚 ', ''], ['(开 grill 对话, 掰扯完再裁)', 'd']]);
        body.push([['     ', ''], ['x', 'a'], ['     裁完即终结 ', ''], ['(disposition=close, 不进区域)', 'd']]);
      } else if (it.mode === 'node') {
        body.push([['     ', ''], ['r', 'a'], [' 重跑    ', 'd'], ['i', 'a'], [' 介入    ', 'd'], ['s', 'a'], [' 停图', 'd']]);
      } else if (it.mode === 'take') {
        body.push([['     ', ''], ['Enter', 'a'], [' 收件并回流进图', 'd']]);
      } else {
        body.push([['     ', ''], ['c', 'a'], [' 收件 ', ''], ['/', 'd'], [' ', ''], ['x', 'a'], [' 退回    ', ''],
          ['机器建议票不许直接裁 (INV-S1-1)', 'w']]);
      }
    }
    body.push([]);
  });
  const foot = [[`${G.warn} 裁决不等于执行: 裁完不会自己跑, 要 `, 'd'], ['map_deliver', 'w'], [' 才动;task 票的 ruling 会成为执行体的 goal', 'd']];
  return [...frame([['等你裁的', 'b']], [[`${items.length} 件`, 'w'], [`   最久 ${items[3].wait}`, 'd']], body, o.w, o.h - 1,
    [[clip(lineTextOf(foot), W), 'w']]), keys(`${G.up}${G.down} 选 · Enter/g/x 裁决 · r/i/s 处理节点 · Esc 退出`)];
}
const lineTextOf = (l) => l.map((s) => s[0]).join('');

// ══ 4. Run 屏 ═════════════════════════════════════════════════════════════════════
// 合并 run-board + 活图切换器 (票 #221)。三态一张表: 活 / 已产出 / 等收。
// ⚠ 修字形闸违规: run-board.ts:40 的 `⏳`(U+23F3) 在 UNSAFE_GLYPHS 里 → 换 `◌`(safe)。
export function runScreen(t, o) {
  const W = o.w - 4;
  const runs = [
    { k: 'live', id: '78f1951c', goal: 'HudMirror 拆成每 run 一文件', n: '5/8', age: '28s', ws: 'src/hud/mirror.ts +2' },
    { k: 'live', id: '3ac91e02', goal: 'slice-coverage 补测试', n: '9/11', age: '4m', ws: 'src/harness/goal/*.test.ts' },
    { k: 'published', id: 'b71d4f88', goal: 'sdd-direct 的 write-set 越界', n: '9/9', age: '12m', ws: 'plan.md' },
    { k: 'awaiting', id: 'r2', goal: 'slice.json 待收', n: '—', age: '24m', ws: '逼近超时' },
    { k: 'awaiting', id: 'r3', goal: 'notes.md 待收', n: '—', age: null, ws: '起点未记' },
  ];
  const sel = ((o.sel % runs.length) + runs.length) % runs.length;
  const body = [];
  body.push([]);
  runs.forEach((r, i) => {
    const isSel = i === sel;
    const ch = r.k === 'live' ? 'a' : r.k === 'published' ? 'ok' : 'w';
    const l = [[isSel ? ' ' + G.sel + ' ' : '   ', 's'], [RUN_MARK[r.k] + ' ', ch],
      [padS(r.id, 11), isSel ? 's' : ''], [padSL(r.n, 5) + '  ', 'd'],
      // NULL ≠ 0: 没起点就写「起点未记」, 不写 0m
      [padS(r.age ?? '起点未记', 9), r.age ? 'd' : 'w']];
    l.push([clip(r.goal, Math.max(10, W - lineW(l))), isSel ? '' : 'd']);
    body.push(l);
    if (isSel) {
      body.push([['       写集 ', 'd'], [r.ws, r.k === 'awaiting' ? 'w' : 'd']]);
      body.push([['       ', ''], ['Enter', 'a'], [' 进这张图    ', 'd'], ['c', 'a'], [' 取消    ', 'd'], ['l', 'a'], [' 看日志', 'd']]);
    }
    body.push([]);
  });
  const live = runs.filter((r) => r.k === 'live').length;
  const wait = runs.filter((r) => r.k === 'awaiting').length;
  return [...frame([['活图', 'b']], [[`${live} 活`, 'a'], [` · 1 产出 · `, 'd'], [`${wait} 等`, 'w']], body, o.w, o.h - 1,
    [['数据源 = 公告板 liveRuns + .omd/hud/dag-*.json (票 #215 落地后才有多 run)', 'd']]),
    keys(`${G.up}${G.down} 选 run · Enter 进图 · [ ] 翻页 · Ctrl+G 退出`)];
}

export const SCREENS = [
  { id: 'dag', name: 'DAG', tag: '合并', file: 'dag-tree + dag-hud + dag-gantt + 节点详情', fn: dagScreen, nav: 8 },
  { id: 'map', name: 'Map', tag: '合并', file: 'path-fog + ticket-board', fn: mapScreen, nav: 11 },
  { id: 'inbox', name: '收件箱', tag: 'NEW', file: '(不存在) — 唯一答「现在轮到我做什么」', fn: inboxScreen, nav: 5 },
  { id: 'run', name: '活图', tag: '合并', file: 'run-board + 切换器(票 #221)', fn: runScreen, nav: 5 },
  { id: 'shell', name: '全景 +「当前」区', tag: 'NEW', file: '(不存在) — 默认看得见的那个面', fn: shellScreen, nav: 1 },
  { id: 'palette', name: 'Ctrl+K 去哪', tag: 'NEW', file: '(改造 tui.ts:1583 那个选择器)', fn: paletteScreen, nav: 6 },
];

// ══ 5. TUI 全景 + 「当前」区 ═══════════════════════════════════════════════════════
// 前四屏全是**模态全屏** —— 你得先想起来去按某个键。可 PRODUCT.md 那条定位说的是
// 「把哪一件事在等你放在最亮处」, 藏在键后面就不算最亮处, 那叫藏在你的记性里。
// 这一屏画的是**默认看得见的那个面**: 转录 + 「当前」区 + 输入框 + 底栏。
//
// ## 「当前」区: 一个区域, 不是三个面板堆叠
//
// 今天是 pathHud + ticketBoard + runBoard **三块**摞着, 且 `hasDialogue` 一刀切
// (`chat-log.ts:148`): 人一开口全部消失。于是闲着时满屏仪表盘, 真跑起来反而什么都没有。
//
// ⚠ 盲比那条裁决 (`tui.ts:861-863`, 台账 `docs/bars/gauntlet-p3-账本.md:56`) 原话是:
//   「流式回答下方混入**与本题无关**的仪表盘内容(进度条 8/23、前沿票工单表、阻塞集)
//     **共 3 块**, 稀释了答案主体」
//   判的是「3 块」+「与本题无关」, **不是**「不许有常驻区」。一条按状态选内容、闲时只剩一行的带子
//   正是对这条判词的正解 —— 这里不是推翻它。
//
// 内容由**一条优先级阶梯**选, 而这条阶梯就是那句定位的机械化:
const NOW_LADDER = ['等你', '在跑', '欠账', '闲'];
function nowBand(t, W) {
  /** 左半 + 右半; 右半装不下就丢掉 (窄屏先丢提示, 不丢读数)。 */
  const line = (left, right, rch) => {
    const w = lineW(left);
    const rw = lineW([[right, '']]);
    return w + rw + 3 <= W ? [...pad(left, W - rw - 1), [right, rch]] : left;
  };
  // ① 等你 —— 有东西卡在人手里。永远压过其它。
  if (t >= 28400) return { lv: 0, lines: [
    line([[' ', ''], [G.warn + ' 等你 2 件', 'w'], ['   217 ', 's'], ['散雾图呼吸动画做不做', ''], [' · 等 4h', 'w']],
      'Ctrl+I 收件箱', 'a'),
  ] };
  // ② 在跑 —— 哪个节点 / 烧了多少 / **哪个闸在守**。
  if (t >= 2100) {
    const ns = at(t);
    const done = ns.filter((n) => n.st === 'done').length;
    const cur = ns.find((n) => n.st === 'running');
    const tok = Math.round((t / 1000) * 0.9);
    return { lv: 1, lines: [
      line([[' ', ''], [RUN_MARK.live + ' run 78f1951c', 'a'], [`   ${done}/${ns.length}`, ''],
        ['   ' + (cur ? NODE_MARK.running + ' ' + cur.id : '—'), cur ? 'a' : 'd'],
        [`   ${dur(t)}`, 'd'], [`   ${tok}k tok`, 'd']], 'Ctrl+G 活图', 'a'),
      // 闸带: 这是第一次让「可靠性来自模型之外」在界面上看得见。
      // ⚠ 今天只有 3/7 个闸发 verdict 事件 (judge · gate 谎报完成 · verifier);
      //   心跳/空转/产物/oracle 只以 settle{failed,failReason} 露面, 而 `failureKind`
      //   **不在 DagNodeEvent 字段里** (types.ts:489-500) —— 要画满这一行, 得先让它进事件。
      line([[' ', ''], ['闸 ', 'd'], ['verifier ' + NODE_MARK.running + '守', 'a'], ['  写集 ' + G.ok + '3', 'd'],
        ['  产物 ' + G.ok, 'd'], ['  心跳 ' + G.ok, 'd'], ['  空转 ' + G.ok, 'd']], '已拦 1', 'w'),
    ] };
  }
  // ③ 欠账 —— checkpoint 落后 / stale 票 / 产物逼近超时。
  if (t >= 900) return { lv: 2, lines: [
    line([[' ', ''], [G.warn + ' 欠账', 'w'], ['   checkpoint 落后 18 轮', 'd'], ['   1 张票 ', 'd'], [G.fail + ' STALE', 'fail']],
      'Ctrl+K 去哪', 'a'),
  ] };
  // ④ 闲 —— 才轮到今天那种 map 摘要。**大多数时候它只有一行。**
  return { lv: 3, lines: [
    line([[' ', ''], ['map 214', 'd'], ['   散雾 ', 'd'], ['9%', 'a'], [' ', ''], ...bar(1, 11, 10), ['   9 张可动', 'd']],
      'Ctrl+P 地图', 'a'),
  ] };
}

export function shellScreen(t, o) {
  const W = o.w;
  const out = [];
  const band = nowBand(t, W);

  // ── 首屏提示: owner 要「介绍更多 tui 操作」。分组给, 末行指向 `?` 的完整键位表。
  out.push([['  engine   ', 'd'], ['embedded://opencode-go:kimi-k3', '']]);
  out.push([['  session  ', 'd'], ['s-1787309805', 's'], ['   了解 outputstyle 和 omd-plain 输出格式', 'd']]);
  out.push([]);
  out.push([['  > ', 'd'], ['Enter', 'a'], [' 发一轮 · ', 'd'], ['/', 'a'], [' 命令 · ', 'd'], ['!cmd', 'a'], [' 跑 shell · ', 'd'], ['?', 'a'], [' 全部键位', 'd']]);
  out.push([['  > ', 'd'], ['Ctrl+K', 'a'], [' 去哪(会话/活图/地图/收件箱) · ', 'd'], ['Ctrl+P', 'a'], [' 地图 · ', 'd'], ['Ctrl+G', 'a'], [' 活图', 'd']]);
  out.push([['  > ', 'd'], ['Esc', 'a'], [' 打断 · ', 'd'], ['Esc Esc', 'a'], [' 回退 · ', 'd'], ['Ctrl+O', 'a'], [' 折思维链 · ', 'd'], ['Shift+PgUp', 'a'], [' 翻历史', 'd']]);
  out.push([]);

  // ── 转录: **发生过的事**进这里, 一行、不可变、带时间。状态不进。
  const say = (who, txt, ch) => {
    const ws = wrap(txt, W - 7);
    out.push([['  ' + padS(who, 5), 'd'], [ws[0], ch]]);
    for (const w of ws.slice(1)) out.push([['       ' + w, ch]]);
  };
  say('你', '把 HudMirror 拆成每 run 一文件, 并让 TUI 从盘上读活图', '');
  say('omd', '读了 assemble.ts 与 dag-exec.ts。镜像有写者, 缺的是分片, 我先拆 HudMirror。', '');
  if (t >= 3000) out.push([['       ', ''], [G.dot + ' checkpoint 已写 · 12 节点 · 22:14', 'd']]);
  if (t >= 9100) out.push([['       ', ''], [G.fail + ' shard-3 挂了: tsc 类型 RunId 不存在 · 22:15', 'fail']]);
  if (t >= 28400) out.push([['       ', ''], [G.fail + ' verifier 判 fail: shard-3 的失败没被修 · 22:19', 'fail']]);
  if (t >= 28400) out.push([['       ', ''], [G.dot + ' run 78f1951c 停在修复轮 · 4m12s · 26k tok · 22:19', 'd']]);

  // 转录与「当前」区之间留白 —— 让带子贴着输入框, 不贴着回答。
  // 预留 = 分隔线 1 + 带子 N + 输入框 3 + 底栏 1。少算一格窄屏会把底栏切掉 (实测)。
  while (out.length < o.h - band.lines.length - 5) out.push([]);
  out.push([[G.lh.repeat(W), 'd']]);
  for (const l of band.lines) out.push(l);
  out.push([[G.ltl + G.lh.repeat(W - 2) + G.ltr, 'd']]);
  out.push([...pad([[G.lv + ' ', 'd'], ['说点什么, 或按 / 看命令 · Ctrl+C 两下退出', 'd']], W - 1), [G.lv, 'd']]);
  out.push([[G.lbl + G.lh.repeat(W - 2) + G.lbr, 'd']]);
  out.push([['oh-my-dag main+86', 'd'], ['  kimi-k3', 'd'], ['  ctx ', 'd'], ['34%', 'a'],
    ['  $0.31', 'd'], ['  ' + G.up + '1.2M ' + G.down + '9.6k', 'd'], ['  cache94%', 'd']]);
  return out.slice(0, o.h);
}

// ══ 6. Ctrl+K 去哪 + 会话选择器 ═══════════════════════════════════════════════════
// owner: 「所有设计选择 session 的时候都没有弹出选择器」。实况更细:
//   · `/session` **有**选择器 (`tui.ts:1583-1590`), 但主标签是裸 id、标题被降到第二列,
//     且**没传 `search: true` 也没传 `maxVisible`** —— 而 `/models`(`tui.ts:1287`) 两个都传了。
//     ⇒ 一行参数的事, 今天就能好用一大截。
//   · **启动时没有 resume 入口**: `defaultTuiSessionId`(`sessions.ts:101`) 让每个 TUI 进程
//     直接开新会话, 从不问要不要接上次那个。
// ⚠ 硬约束: pi-tui 的 `SelectList` **一个 item 只画一行**(description 被压成单行放右列)。
//   所以下面这版是**现成件撑得住**的一行式。Claude Code 那种两行卡片要动组件
//   (给 `selectComponent` 传它已支持但没用上的 `SelectListLayoutOptions`, `dialog.ts:104-109`)。
// ⚠ `main` 分支那一段**画不出来** —— 会话侧一个 git 字段都没记。`2.9MB` 能画(path 现成, stat 一下)。
export function paletteScreen(t, o) {
  const W = o.w;
  const rows = [
    { k: '会话', id: 's-1787309805', meta: '2h 前 · 81KB', txt: '了解 outputstyle 和 omd-plain 输出格式' },
    { k: '会话', id: 's-1787223401', meta: '1d 前 · 3.1MB', txt: '审查 omd 的交付和修复 continuity 缺陷' },
    { k: '会话', id: 's-1787140022', meta: '2d 前 · 454KB', txt: '调查为什么任务状态仍为 open' },
    { k: '活图', id: '78f1951c', meta: '跑中 5/8', txt: 'HudMirror 拆成每 run 一文件' },
    { k: '地图', id: '214', meta: '9 可动 · 2 等你', txt: 'OMD TUI 观测面' },
    { k: '收件箱', id: '—', meta: '2 件等你', txt: '最久 4h' },
  ];
  const sel = ((o.sel % rows.length) + rows.length) % rows.length;
  const out = [];
  for (const w of wrap('读了 assemble.ts 与 dag-exec.ts。镜像有写者, 缺的是分片。', W - 7))
    out.push([['  omd  ', 'd'], [w, '']]);
  while (out.length < o.h - rows.length - 8) out.push([]);

  // 对话框是**输入框正上方的行内卡片**, 不是全屏覆盖 (`dialog.ts:297-308` / `tui.ts:877-878`)。
  const title = ' 去哪 ';
  const head = [[G.ltl + G.lh, 'd'], [title, 'a']];
  out.push([...head, [G.lh.repeat(Math.max(0, W - 1 - lineW(head))) + G.ltr, 'd']]);
  out.push([...pad([[G.lv + ' ', 'd'], ['> ', 'a'], ['ses', ''], [G.full, 'a']], W - 1), [G.lv, 'd']]);
  rows.forEach((r, i) => {
    const isSel = i === sel;
    const l = [[G.lv + ' ', 'd'], [isSel ? G.sel + ' ' : '  ', 's'], [padS(r.k, 8), isSel ? 's' : 'd'],
      [padS(r.id, 15), isSel ? 's' : ''], [padS(r.meta, 17), 'd']];
    l.push([clip(r.txt, Math.max(8, W - lineW(l) - 2)), isSel ? '' : 'd']);
    out.push([...pad(l, W - 1), [G.lv, 'd']]);
  });
  out.push([[G.lbl + G.lh.repeat(W - 2) + G.lbr, 'd']]);
  out.push([[G.ltl + G.lh.repeat(W - 2) + G.ltr, 'd']]);
  out.push([...pad([[G.lv + ' ', 'd'], ['说点什么, 或按 / 看命令', 'd']], W - 1), [G.lv, 'd']]);
  out.push([[G.lbl + G.lh.repeat(W - 2) + G.lbr, 'd']]);
  out.push([['打字即搜 · ', 'd'], [G.up + G.down, 'a'], [' 选 · ', 'd'], ['Enter', 'a'], [' 去 · ', 'd'],
    ['Ctrl+R', 'a'], [' 改名', 'd'], ['   (改名需给 store 加写路, 今天没有)', 'w']]);
  return out.slice(0, o.h);
}
