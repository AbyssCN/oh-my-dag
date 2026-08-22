/**
 * S5 票看板 C-7 ④⑤ 对拍测试 —— **双端同数 + 渲染零写闸** (SDD 2026-08-11 DAG 观察面与审核跟踪升级)。
 *
 * 与 ticket-board.test.ts (C-7 ①②③, 内存构造) 互补: 本文件**不造内存图直渲**, 一切读数都从
 * 真实后端往返出来 —— 一张 `PathMap` 当唯一真源 (D-12 ①), md 臂走 saveMapForStamp → readMap,
 * gh 臂走 renderOf 投影 → fakeGh → readMap, 两臂各自渲染同一张真源图, 逐行对拍。
 *
 * ## C-7 ④ 双端同数
 * - md 臂: `saveMapForStamp(map, dir)` → `readMap(dir, slug)` → `renderTicketBoard` (seed 惯例同
 *   backend.test.ts ~:523 的 saveMap 调用形)。
 * - gh 臂: 直接 import backend-gh.ts export 的 `baseStatus`/`renderOf`/`GhRender` **真实现**
 *   算期望值 (2026-08-11 判卷后从"语义复刻"改为直连 —— 复刻与实装同源转录, 实装改坏抓不到);
 *   真值永远走真实 readMap。实装漂移 → 对拍闸红。四位 closed/suggested/delivered/escalated 全部对拍, CLOSED 分支
 *   **不看** suggested/escalated 残留 label 的刻意语义有专测覆盖 (拒绝≠裁决: CLOSED+suggested
 *   直接移出图)。
 * - fakeGh/okr 同 backend.test.ts:15-24 骨架 (未导出 → 本文件最小复刻); 不新造文件型 fixture。
 *
 * ## C-7 ⑤ 渲染零写闸
 * 真相文件 (docs/plan/pathfinder/<slug>.md) 渲染前后逐字节一致。反向自检当场演示:
 * 渲染路径插一次写 → 闸必红 (证伪方式见零写闸那组的注释), 插写撤掉 → 闸绿。
 *
 * 锚符号不锚行号。
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveBackend, type GhResult, type GhRunner } from '../../harness/pathfinder/backend';
import { baseStatus, renderOf, type GhRender } from '../../harness/pathfinder/backend-gh';
import { mapMarkdownPath, saveMap as saveMapForStamp } from '../../harness/pathfinder/map-store';
import type { PathMap, Ticket, TicketStatus } from '../../harness/pathfinder/types';
import { renderTicketBoard } from './ticket-board';

// ── 时钟与验收图 (同一张真源, 两臂共用) ──────────────────────────────────────────

const DEST = 'Ship X';
const SLUG = 'ship-x';
/** T0 + 1h → waiting 时长 = fmtDur(3_600_000) = '60m' (确定性, 可重放)。 */
const T0 = '2026-01-01T00:00:00.000Z';
const NOW_MS = Date.parse('2026-01-01T01:00:00.000Z');
const STALE_AT = '2026-01-02T00:00:00.000Z';

/** C-7 的验收图: 前沿 / blocked / suggested(等) / escalated(起点未记) / ruled / delivered / stale。 */
function truthMap(): PathMap {
  return {
    destination: DEST,
    slug: SLUG,
    decisionsLog: [],
    tickets: [
      { id: '#1', type: 'research', title: 'frontier survey', blockedBy: [], status: 'open' },
      { id: '#2', type: 'task', title: 'blocked work', blockedBy: ['#9'], status: 'blocked' }, // #9 不存在 → 前置永不满足
      { id: '#3', type: 'research', title: 'machine idea', blockedBy: [], status: 'suggested', suggestedBy: 'run-1', waitingSince: T0 },
      { id: '#4', type: 'grill', title: 'owner please', blockedBy: [], status: 'escalated' }, // 起点没记
      { id: '#5', type: 'task', title: 'ruled work', blockedBy: [], status: 'ruled', ruling: 'do it' },
      { id: '#6', type: 'task', title: 'shipped slice', blockedBy: [], status: 'delivered' },
      { id: '#7', type: 'grill', title: 'overdue ask', blockedBy: [], status: 'escalated', waitingSince: T0, staleAt: STALE_AT },
    ],
  };
}

// ── gh 臂对拍**真实现** (2026-08-11 判卷器裁定后改): baseStatus/renderOf/GhRender 已从
// backend-gh.ts export —— 此前这里是"按语义复刻", 复刻与实装同源转录, 实装改坏抓不到
// (本仓「测试与实装互相背书」图鉴形态)。现在期望值与真值同出一门, 实装漂移即红。

const DELIVERED_LABEL = 'path:delivered';
const SUGGESTED_LABEL = 'path:suggested';
const ESCALATED_LABEL = 'path:escalated';

/** GhRender → 实际 label 数组 (type label 恒在, 与 createGhBackend 的建票一致)。 */
function labelsOf(r: GhRender, type: string): string[] {
  return [`path:${type}`, ...(r.suggested ? [SUGGESTED_LABEL] : []), ...(r.delivered ? [DELIVERED_LABEL] : []), ...(r.escalated ? [ESCALATED_LABEL] : [])];
}

// ── backend.test.ts 的 fake 骨架最小复刻 (未导出; backend.test.ts:15-24 同形) ─────

const okr = (stdout: string): GhResult => ({ stdout, exitCode: 0, stderr: '' });

/** 探测永远成功的 gh runner (owner/repo = acme/repo); 其余调用交给 handler。 */
function fakeGh(handler: (args: string[]) => GhResult): GhRunner {
  return (args) => {
    if (args[0] === 'repo' && args[1] === 'view') return okr(JSON.stringify({ nameWithOwner: 'acme/repo' }));
    return handler(args);
  };
}

// ── 两臂的读取助手 ──────────────────────────────────────────────────────────────

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'pf-ticket-board-'));
}

function mdBackend(dir: string) {
  return resolveBackend(dir, { env: { OMD_PATH_BACKEND: 'md' } });
}

/** 盘上票 → 它该长成的 gh sub-issue (renderOf 投影 + D-5 三戳的 gh 载体: Waiting-since 正文锚 / stale-at 评论锚)。 */
function subOf(t: Ticket): Record<string, unknown> {
  const r = renderOf(t.status);
  const body = [
    ...(t.blockedBy.length > 0 ? [`Blocked-by: ${t.blockedBy.join(', ')}`] : []),
    ...(t.waitingSince !== undefined ? [`Waiting-since: ${t.waitingSince}`] : []),
  ].join('\n\n');
  return {
    number: Number(t.id.slice(1)),
    title: `[${t.type}] ${t.title}`,
    body,
    state: r.closed ? 'CLOSED' : 'OPEN',
    labels: { nodes: labelsOf(r, t.type).map((name) => ({ name })) },
    comments: { nodes: t.staleAt !== undefined ? [{ body: `**stale-at**: ${t.staleAt}`, createdAt: t.staleAt }] : [] },
    subIssues: { nodes: [] },
  };
}

function ghGraphqlResponse(subs: Record<string, unknown>[]): string {
  return JSON.stringify({
    data: { repository: { issue: { number: 5, title: `🧭 [map] ${DEST}`, body: '', state: 'OPEN', subIssues: { nodes: subs } } } },
  });
}

/** gh 臂: 一张真源图 → 投影成 issue 渲染 → fakeGh 喂真实 readMap → 看板行。 */
function ghReadBoard(dir: string, truth: PathMap): string[] {
  const gh = fakeGh((args) => (args.includes('graphql') ? okr(ghGraphqlResponse(truth.tickets.map(subOf))) : okr('[]')));
  const map = resolveBackend(dir, { env: { OMD_PATH_BACKEND: 'gh' }, gh }).readMap(dir, '5')!;
  return renderTicketBoard(map, NOW_MS);
}

/** 看板行 → 按票 id 建索引 (行内第一个 `#N` 就是票 id, 含 ✗ STALE 前缀的行也成立)。 */
function rowsById(rows: string[]): Map<string, string> {
  return new Map(rows.slice(1).map((r) => [r.match(/#\d+/)?.[0]!, r]));
}

describe('C-7 ④ md 臂: saveMapForStamp → readMap 往返', () => {
  test('验收图全类往返后可分辨, waiting 时长/起点未记/stale 读数照画', () => {
    const dir = tmp();
    try {
      saveMapForStamp(truthMap(), dir);
      const map = mdBackend(dir).readMap(dir, SLUG)!;
      expect(map.tickets).toHaveLength(7);
      const rows = renderTicketBoard(map, NOW_MS);
      const byId = rowsById(rows);
      // 证伪: saveMap 的 renderTicket 漏写 `- waitingSince:` 行 → #3/#7 读成起点未记, 下行红。
      expect(byId.get('#1')!).toMatch(/^· #1 \[research\] frontier survey · frontier$/);
      expect(byId.get('#2')!).toMatch(/^─ #2 \[task\] blocked work · blocked$/);
      expect(byId.get('#3')!).toMatch(/^○ #3 \[research\] machine idea · suggested · waiting 60m$/);
      // C-7 ②: waiting-unknown-since 画「start not recorded」, 不画 0 (NULL≠0; 证伪: 编 0 时长 → /0/ 命中, 红)。
      expect(byId.get('#4')!).toMatch(/^○ #4 \[grill\] owner please · escalated · waiting · start not recorded$/);
      expect(byId.get('#4')!).not.toMatch(/0/);
      expect(byId.get('#5')!).toMatch(/^✓ #5 \[task\] ruled work · ruled$/);
      expect(byId.get('#6')!).toMatch(/^✓ #6 \[task\] shipped slice · delivered$/);
      // C-7 ③: stale 票显眼标记 (字形 + 文字前缀), 不只换颜色; 等待时长照算。
      expect(byId.get('#7')!).toMatch(/^✗ STALE #7 \[grill\] overdue ask · escalated · waiting 60m$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('C-7 ④ gh 臂: renderOf 四位 ↔ baseStatus 对拍 (真实 readMap)', () => {
  test('复刻层恒等: baseStatus ∘ renderOf = id (suggested/escalated/ruled/delivered/open)', () => {
    for (const s of ['open', 'suggested', 'escalated', 'ruled', 'delivered'] as TicketStatus[]) {
      const r = renderOf(s);
      expect(baseStatus(r.closed ? 'CLOSED' : 'OPEN', labelsOf(r, 'task'))).toBe(s);
    }
    // blocked 的 gh 渲染与 open 同形 (前置未满足是算出来的, gh 侧不存) → 恒等只到 open 为止。
    expect(renderOf('blocked')).toEqual(renderOf('open'));
  });

  test('真源图经 renderOf 投影 → 真实 readMap 读回同一批状态 (双端同数的 gh 半臂)', () => {
    const truth = truthMap();
    const dir = tmp();
    try {
      const gh = fakeGh((args) => (args.includes('graphql') ? okr(ghGraphqlResponse(truth.tickets.map(subOf))) : okr('[]')));
      const map = resolveBackend(dir, { env: { OMD_PATH_BACKEND: 'gh' }, gh }).readMap(dir, '5')!;
      expect(map.tickets).toHaveLength(7);
      for (const t of map.tickets) {
        const src = truth.tickets.find((x) => x.id === t.id)!;
        const expected =
          // blocked 由 readMapImpl 二遍的 deriveStatus 现算 (backend-gh.ts:444); 其余 = 复刻对拍。
          src.status === 'blocked' ? 'blocked' : baseStatus(subOf(src).state as string, (subOf(src).labels as { nodes: { name: string }[] }).nodes.map((l) => l.name));
        expect(t.status, `gh 臂 ${t.id} 状态对拍`).toBe(expected);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('CLOSED 分支不看 suggested/escalated 残留 label (刻意语义, 用例覆盖)', () => {
    const dir = tmp();
    const sub = (n: number, title: string, state: 'CLOSED' | 'OPEN', extra: string[]): Record<string, unknown> => ({
      number: n,
      title: `[research] ${title}`,
      body: '',
      state,
      labels: { nodes: [{ name: 'path:research' }, ...extra.map((name) => ({ name }))] },
      comments: { nodes: [] },
      subIssues: { nodes: [] },
    });
    const subs = [
      sub(10, 'ruled long ago', 'CLOSED', [ESCALATED_LABEL]), // 残留 escalated → 已裁 ruled
      sub(11, 'rejected idea', 'CLOSED', [SUGGESTED_LABEL]), // 已拒建议 → 移出图 (拒绝≠裁决)
      sub(12, 'delivered old', 'CLOSED', [DELIVERED_LABEL, ESCALATED_LABEL]), // delivered 优先, escalated 残留不看
      sub(13, 'fresh open', 'OPEN', [DELIVERED_LABEL]), // delivered 只在 CLOSED 作数
      sub(14, 'pending owner', 'OPEN', [ESCALATED_LABEL]),
      sub(15, 'pending human', 'OPEN', [SUGGESTED_LABEL]),
      sub(16, 'rejected but labeled delivered', 'CLOSED', [DELIVERED_LABEL, SUGGESTED_LABEL]), // 已拒建议的判别优先于 delivered
    ];
    try {
      const gh = fakeGh((args) => (args.includes('graphql') ? okr(ghGraphqlResponse(subs)) : okr('[]')));
      const map = resolveBackend(dir, { env: { OMD_PATH_BACKEND: 'gh' }, gh }).readMap(dir, '5')!;
      const byId = new Map(map.tickets.map((t) => [t.id, t]));
      // 对拍: 每条期望 = 复刻 baseStatus 的判定; 真实 readMap 必须一致。
      // 证伪: CLOSED 分支若先看 escalated label → #10 读成 escalated, 红。
      expect(byId.get('#10')!.status).toBe(baseStatus('CLOSED', [ESCALATED_LABEL]));
      // 证伪: 若不认"拒绝不是删除无痕" → #11 混进图 (读成 ruled 裁决票), 红。
      expect(byId.has('#11')).toBe(false);
      expect(byId.get('#12')!.status).toBe(baseStatus('CLOSED', [DELIVERED_LABEL, ESCALATED_LABEL]));
      expect(byId.get('#13')!.status).toBe(baseStatus('OPEN', [DELIVERED_LABEL]));
      expect(byId.get('#14')!.status).toBe(baseStatus('OPEN', [ESCALATED_LABEL]));
      expect(byId.get('#15')!.status).toBe(baseStatus('OPEN', [SUGGESTED_LABEL]));
      // CLOSED+suggested 是**已拒建议** (backend-gh.ts:409): 无论还带什么 label 都移出图, 不当票。
      // 证伪: 把已拒判别降级成"只有纯 suggested label 才拒" → #16 混进图, 红。
      expect(byId.has('#16')).toBe(false);
      // 看板面上同样可分辨 (delivered 优先 / ruled 残标不回声)。
      const rows = rowsById(renderTicketBoard(map, NOW_MS));
      expect(rows.get('#10')!).toContain('ruled');
      expect(rows.get('#12')!).toContain('delivered');
      expect(rows.has('#11')).toBe(false);
      expect(rows.has('#16')).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('C-7 ④ 双端同数: 同一张真源图, 两臂渲染逐行一致', () => {
  test('md 臂与 gh 臂的看板行 (除头行 slug 位) 完全相同', () => {
    const truth = truthMap();
    const dir = tmp();
    try {
      saveMapForStamp(truth, dir);
      const mdRows = renderTicketBoard(mdBackend(dir).readMap(dir, SLUG)!, NOW_MS);
      const ghRows = ghReadBoard(dir, truth);
      // 头行仅 slug 位不同 (md=ship-x, gh=map issue number 5) —— 双端同数比的是票, 不比 slug。
      expect(mdRows[0]!).toMatch(/^ticket board · Ship X \(ship-x\) · 7 tickets$/);
      expect(ghRows[0]!).toMatch(/^ticket board · Ship X \(5\) · 7 tickets$/);
      // 证伪: 任一臂的读数漂移 (状态/等待时长/起点未记/stale) → 对应行不等, 红。
      expect(mdRows.slice(1).sort()).toEqual(ghRows.slice(1).sort());
      expect(mdRows.length).toBe(ghRows.length);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('C-7 ⑤ 渲染零写闸 (真相文件逐字节一致)', () => {
  test('渲染前后 md 真相文件逐字节一致 (readMap → renderTicketBoard 零落盘)', () => {
    const dir = tmp();
    try {
      saveMapForStamp(truthMap(), dir);
      const truthPath = mapMarkdownPath(SLUG, dir);
      const before = readFileSync(truthPath, 'utf8');
      const map = mdBackend(dir).readMap(dir, SLUG)!;
      const rows = renderTicketBoard(map, NOW_MS);
      expect(rows.length).toBeGreaterThan(0);
      const after = readFileSync(truthPath, 'utf8');
      // 证伪: 在 renderTicketBoard 里插一次 saveMap/writeFileSync → before !== after, 此闸红
      // (当场演示见下一条: 插写后字节必变)。
      expect(after).toBe(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('反向自检: 渲染路径插一次写 → 此闸必红 (证伪当场演示, 撤写后复原绿)', () => {
    const dir = tmp();
    try {
      saveMapForStamp(truthMap(), dir);
      const truthPath = mapMarkdownPath(SLUG, dir);
      const before = readFileSync(truthPath, 'utf8');

      // 事故形状 (commit 1890115 先例): 渲染时把算出来的状态写回真相文件。
      const map = mdBackend(dir).readMap(dir, SLUG)!;
      const rows = renderTicketBoard(map, NOW_MS);
      const renderWithWrite = (m: PathMap): string[] => {
        const out = renderTicketBoard(m, NOW_MS);
        saveMapForStamp({ ...m, tickets: m.tickets.map((t) => ({ ...t, status: t.status === 'escalated' ? 'ruled' : t.status })) }, dir);
        return out;
      };
      renderWithWrite(map);
      const afterWrite = readFileSync(truthPath, 'utf8');
      // 门闸判定 (before === after) 在此刻必红 —— 证明闸真抓得住"渲染里带写", 不是恒绿空转。
      expect(rows.length).toBeGreaterThan(0);
      expect(afterWrite).not.toBe(before);

      // 撤掉插写 (真渲染路径无写) → 真相文件复原, 闸绿。
      saveMapForStamp(truthMap(), dir);
      expect(readFileSync(truthPath, 'utf8')).toBe(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
