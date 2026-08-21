/**
 * src/tui/render/path-fog-map.test.ts —— Map 屏 v2 (画法 C) 那一组闸。
 *
 * **分工**:
 *  - 本文件: Map 屏 v2 (画法 C, 段头 + 票行 + 雾带 + 读数 + 键位) 的**那一组**闸。
 *    8+1 条全在这 —— 段头顺序、空段、goal 不截断、宽度、雾封顶、NULL≠0、关色恒等、
 *    1/11 票、★不自取时钟。
 *  - src/tui/render/path-fog.test.ts: 画法 B (三角洲) 闸 + 画法 C 幸存的**不变量**
 *    (头行读数 / 高度封顶 / paint 钩子 / 高屏少票雾封顶 / selected 详情行 / 「没 run 推进过」),
 *    它对 path-fog.ts 的早期形态负责。
 *
 * **字面串来源**: 上游《Map 屏 v2 布局契约》与 2026-08-22 乙案裁定。本文件**不发明**措辞,
 * 段头、等待标签、读数条与键位行逐字钉住英文 chrome。
 */
import { visibleWidth } from '@earendil-works/pi-tui';
import { describe, expect, test } from 'bun:test';
import type { PathMap, Ticket } from '../../harness/pathfinder/types';
import { buildPathViewData, renderFogLine } from './path-fog';

const ticket = (over: Partial<Ticket> & { id: string }): Ticket => ({
  type: 'task',
  title: `${over.id} 的待决问题`,
  blockedBy: [],
  status: 'open',
  ...over,
});

/** 满员: 4 段都有票 (gen / frontier / blocked / suggested) + 1 run 推进过。 */
const fullMap = (): PathMap => ({
  destination: 'omd-agent-tui',
  slug: 'omd-agent-tui',
  tickets: [
    ticket({ id: 'd01', status: 'ruled' }),
    ticket({ id: 'd02', status: 'ruled' }),
    ticket({ id: 't1', type: 'task', title: '前沿票 1' }),
    ticket({ id: 't2', type: 'grill', title: 'grill 票 2' }),
    ticket({ id: 'b1', title: '阻塞票 1', blockedBy: ['d99'], status: 'blocked' }),
    ticket({ id: 's1', title: '建议票 1', status: 'suggested' }),
  ],
  decisionsLog: [
    { ticketId: 'd01', gist: 'stdio' },
    { ticketId: 'd02', gist: 'memory' },
  ],
  // 让 runs 非空, 避免头行被 `no runs` 截走 (本测试聚焦段头, 不关心 runs)。
  suggestionsLog: [{ ticketId: 't1', outcome: 'accepted', at: '2026-08-08T00:00:00Z', runId: 'run-78f1' }],
});

describe('Map 屏 v2 (画法 C) 那一组', () => {
  /**
   * 1 层级分段: 一张同时含 gen / frontier / blocked / suggested 的图, 四个段头
   *   (settled · gen-1 / frontier · movable / blocked / engine suggestion · unreceived) 各出现一次, 且顺序就是这个顺序。
   *
   * **证伪方式**:
   *  - 把段头顺序换成 frontier → settled → blocked → suggestion, idx 比较乱, 本条红。
   *  - 段头 label 改字面 (`settled · gen-1` 改 `settled`), indexOf 返回 -1, 本条红。
   *  - 任一段头漏画, indexOf 返回 -1, 本条红。
   *  - 某段头画两遍, `indexOf(..., last+1)` 返回 ≥0, 本条红。
   */
  test('1 层级分段: 4 段头各出现一次 + 顺序正确 (用 indexOf 比大小)', () => {
    const out = renderFogLine(buildPathViewData(fullMap()), { width: 100, height: 30, selected: 0 });
    const body = out.join('\n');
    const idxGen = body.indexOf('settled · gen-1');
    const idxFrontier = body.indexOf('frontier · movable');
    const idxBlocked = body.indexOf('━━ blocked ━━');
    const idxSuggested = body.indexOf('engine suggestion · unreceived');
    expect(idxGen).toBeGreaterThan(-1);
    expect(idxFrontier).toBeGreaterThan(-1);
    expect(idxBlocked).toBeGreaterThan(-1);
    expect(idxSuggested).toBeGreaterThan(-1);
    // 各只出现一次 (不是各查 toContain)
    expect(body.indexOf('settled · gen-1', idxGen + 1)).toBe(-1);
    expect(body.indexOf('frontier · movable', idxFrontier + 1)).toBe(-1);
    expect(body.indexOf('━━ blocked ━━', idxBlocked + 1)).toBe(-1);
    expect(body.indexOf('engine suggestion · unreceived', idxSuggested + 1)).toBe(-1);
    // 顺序 = 已散 → 前沿 → 受阻 → 建议
    expect(idxGen).toBeLessThan(idxFrontier);
    expect(idxFrontier).toBeLessThan(idxBlocked);
    expect(idxBlocked).toBeLessThan(idxSuggested);
  });

  /**
   * 2 空段不画: 清空 blocked 与 suggested, 输出不含对应段头。
   *
   * **证伪方式**: 把空段跳过逻辑去掉 (空 `blockedTickets` / 空 `suggested` 也画段头), 本条红。
   */
  test('2 空段不画: 无 blocked / suggested 时不画段头', () => {
    const m = fullMap();
    m.tickets = m.tickets.filter((t) => t.id !== 'b1' && t.id !== 's1');
    m.suggestionsLog = [];
    const out = renderFogLine(buildPathViewData(m), { width: 100, height: 30, selected: 0 });
    const body = out.join('\n');
    expect(body).not.toContain('━━ blocked ━━');
    expect(body).not.toContain('engine suggestion · unreceived');
  });

  /**
   * 3 goal 不截断: destination 是 200 字 CJK 串, width=80 画一次, 输出含它末尾 10 个字。
   *
   * **证伪方式**: goal 段从 wrap 退回 clip / String.slice 截到固定列宽, 末尾 10 字被砍,
   *   本条红。**正确做法**是按列断 CJK + 续行 9 空格缩进, wrap 不截断。
   */
  test('3 goal 不截断: 200 字 CJK destination 在 w=80 输出含末尾 10 字', () => {
    const m: PathMap = {
      destination: '好'.repeat(200),
      slug: 'omd-agent-tui',
      tickets: [ticket({ id: 'd01', status: 'ruled' })],
      decisionsLog: [{ ticketId: 'd01', gist: 'ok' }],
    };
    const out = renderFogLine(buildPathViewData(m), { width: 80, height: 30, selected: 0 });
    expect(out.join('\n')).toContain('好'.repeat(10));
  });

  /**
   * 4 宽度闸: width ∈ {40,80,120} × 长 CJK 标题, 逐行 visibleWidth(line) <= width。
   *
   * **证伪方式**: wrap / fitLine 内部用 `String.length` 而不是 `visibleWidth`,
   *   全角字折半计 → CJK 行 visibleWidth 实际 ≈ 2× length, 整行超宽, 本条红。
   *   正确做法是全走 pi-tui `visibleWidth` (path-fog.ts:27 已 import)。
   */
  test('4 宽度闸: width ∈ {40,80,120} × 长 CJK 标题, 逐行 visibleWidth ≤ width', () => {
    const m = fullMap();
    m.tickets = [
      ticket({ id: 'd01', status: 'ruled' }),
      ticket({ id: 't1', title: '一个特别特别长的中文标题'.repeat(6) }),
    ];
    m.suggestionsLog = [];
    const d = buildPathViewData(m);
    for (const w of [40, 80, 120]) {
      const out = renderFogLine(d, { width: w, height: 40, selected: 0 });
      for (const [i, line] of out.entries()) {
        expect(visibleWidth(line), `w=${w} line=${i}: ${line.slice(0, 30)}`).toBeLessThanOrEqual(w);
      }
    }
  });

  /**
   * 5 雾不占屏: 任意图 × height ∈ {20,40,60}, 含 ░ 或 ▒ 的行 ≤ 1。
   *
   * **证伪方式**: 把 v2 契约里的「雾地平线 (horizon, 不画纹理)」换回 fogBand (画 ░/▒
   *   纹理带), 60 行屏 + 6 票 = 5 行雾带, 每行 ≥30 ░/▒ 块, 本条立刻红 (量到 5)。
   *   (注: 读数条里有 12 格 `░` 进度条 = 12 块, 不到 30, 不算雾行 —— 沿用既有口径 ≥30 块/行。)
   */
  test('5 雾不占屏: height ∈ {20,40,60}, 含 ░/▒ 的行 ≤ 1', () => {
    const d = buildPathViewData(fullMap());
    for (const h of [20, 40, 60]) {
      const out = renderFogLine(d, { width: 100, height: h, selected: 0 });
      const fogRows = out.filter((l) => (l.match(/[░▒]/g)?.length ?? 0) >= 30);
      expect(fogRows.length, `h=${h} 雾行数`).toBeLessThanOrEqual(1);
    }
  });

  /**
   * 6 NULL ≠ 0: 4 子断言。
   *   (a) status='suggested' 且没 waitingSince → 该行含 `start unknown`。
   *   (b) 整个输出不含子串 `waiting 0`。
   *   (c) status='open' 前沿票那一行不含 `waiting` (open 不在四态任一档)。
   *   (d) runs 空时头行写 `no runs`, 不写 `0 runs`。
   *
   * **证伪方式**:
   *  - (a) `waitingHumanState` 把 `'waiting-unknown-since'` 当 `'waiting'` 处理, 渲染层用
   *    `sinceMs ?? 0` 编 `waiting 0s` → (a) 红 (b) 红。
   *  - (c) 给 frontier 票也拼 `waiting …` 后缀, (c) 红。
   *  - (d) 把 `runs.length > 0 ? '· N runs' : ' · no runs'` 写成 `· 0 runs`, (d) 红。
   */
  test('6 NULL ≠ 0: start unknown + 不画 `waiting 0` + 前沿票不含 `waiting` + runs 空写 `no runs`', () => {
    const m: PathMap = {
      destination: 'omd-agent-tui',
      slug: 'omd-agent-tui',
      tickets: [
        ticket({ id: 't1', title: 'open 票 1', status: 'open' }),
        ticket({ id: 's1', title: '建议票无 waitingSince', status: 'suggested' }),
      ],
      decisionsLog: [],
      // 无 suggestionsLog → runs 为空 → 头行写 `no runs`
    };
    const out = renderFogLine(buildPathViewData(m), { width: 100, height: 30, selected: 0 });
    const body = out.join('\n');

    // (a) 建议票那一行含 `start unknown`
    const s1Line = out.find((l) => l.includes('s1')) ?? '';
    expect(s1Line, '建议票行').toContain('start unknown');

    // (b) 整个输出不含 `waiting 0`
    expect(body).not.toContain('waiting 0');

    // (c) 前沿票那一行不含 `waiting`
    const t1Line = out.find((l) => l.includes('t1')) ?? '';
    expect(t1Line, '前沿票行').not.toContain('waiting');

    // (d) runs 空时头行写 `no runs`, 不写 `0 runs`
    expect(out[0] ?? '').toContain('no runs');
    expect(out[0] ?? '').not.toContain('0 runs');
  });

  /**
   * 7 关色恒等: 给一组带标签的画笔画一次, 剥掉标签后逐字节等于不给 paint 的那次输出。
   *
   * **证伪方式**: paint 钩子里**多走一步** (字形替换 / trim / 补白 / 改大小写), 剥完标签就
   *   byte-不等 → 本条红。正确做法是 paint 是**纯装饰**, 只在字符串外套标签, 不动内容。
   */
  test('7 关色恒等: 剥 paint 标签后逐字节 = 不给 paint', () => {
    const d = buildPathViewData(fullMap());
    const tag = (n: string) => (s: string) => `<${n}>${s}</${n}>`;
    const painted = renderFogLine(d, {
      width: 100, height: 30, selected: 0,
      paint: { accent: tag('a'), dim: tag('d'), warn: tag('w'), sel: tag('s') },
    }).join('\n');
    const plain = renderFogLine(d, { width: 100, height: 30, selected: 0 }).join('\n');
    const stripped = painted.replace(/<\/?[adws]>/g, '');
    expect(stripped).toBe(plain);
  });

  /**
   * 8 一票的图与十一票的图都读得出: tickets.length===1 与 ===11 各画一次,
   *   两次都含 goal、段头、每张票的 id。
   *
   * **证伪方式**: 票行输出去掉 (renderFogLine 直接吞掉 frontier / blocked / suggested),
   *   票 id 在输出里查不到, 本条红。goal 段缺失 / 段头缺失同理。
   */
  test('8 一票与十一票都读得出: goal + 段头 + 每张票的 id 都在输出里', () => {
    // ── 1 票: 只 1 张 ruled, 已散段 + goal 在 ──────────────────────────────
    const oneTicket: PathMap = {
      destination: 'omd-agent-tui 单票图',
      slug: 'omd-agent-tui',
      tickets: [ticket({ id: 'd01', status: 'ruled' })],
      decisionsLog: [{ ticketId: 'd01', gist: 'stdio' }],
    };
    const body1 = renderFogLine(buildPathViewData(oneTicket), { width: 100, height: 30, selected: 0 }).join('\n');
    expect(body1, '1 票: goal destination 在').toContain('omd-agent-tui 单票图');
    expect(body1, '1 票: settled 段头在').toContain('settled · gen-1');
    expect(body1, '1 票: 票 id 在').toContain('d01');

    // ── 11 票: 5 ruled + 3 open + 2 blocked + 1 suggested, 4 段齐 ────────
    const eleven: PathMap = {
      destination: 'omd-agent-tui 十一票图',
      slug: 'omd-agent-tui',
      tickets: [
        ticket({ id: 'd01', status: 'ruled' }),
        ticket({ id: 'd02', status: 'ruled' }),
        ticket({ id: 'd03', status: 'ruled' }),
        ticket({ id: 'd04', status: 'ruled' }),
        ticket({ id: 'd05', status: 'ruled' }),
        ticket({ id: 't1', type: 'task', title: 'open 1' }),
        ticket({ id: 't2', type: 'task', title: 'open 2' }),
        ticket({ id: 't3', type: 'task', title: 'open 3' }),
        ticket({ id: 'b1', title: '阻塞 1', blockedBy: ['d99'], status: 'blocked' }),
        ticket({ id: 'b2', title: '阻塞 2', blockedBy: ['d99'], status: 'blocked' }),
        ticket({ id: 's1', title: '建议 1', status: 'suggested' }),
      ],
      decisionsLog: [
        { ticketId: 'd01', gist: 'a' },
        { ticketId: 'd02', gist: 'b' },
        { ticketId: 'd03', gist: 'c' },
        { ticketId: 'd04', gist: 'd' },
        { ticketId: 'd05', gist: 'e' },
      ],
    };
    const body11 = renderFogLine(buildPathViewData(eleven), { width: 120, height: 40, selected: 0 }).join('\n');
    expect(body11, '11 票: goal 在').toContain('omd-agent-tui 十一票图');
    expect(body11, '11 票: settled 段头').toContain('settled · gen-1');
    expect(body11, '11 票: frontier 段头').toContain('frontier · movable');
    expect(body11, '11 票: blocked 段头').toContain('━━ blocked ━━');
    expect(body11, '11 票: suggestion 段头').toContain('engine suggestion · unreceived');
    for (const id of ['d01', 'd05', 't1', 't3', 'b1', 'b2', 's1']) {
      expect(body11, `11 票: 票 ${id} 应在输出里`).toContain(id);
    }
  });

  /**
   * 9 ★ 自取时钟: 同一张图 + 同一个固定 now 画两次, 两次输出逐字节相同。
   *    (buildPathViewData 同理 —— 不读 Date.now。)
   *
   * **证伪方式**: 渲染层在等待标签 / 读数条 / 头行里塞 `Date.now()` /
   *   `new Date().toISOString()`, 两次调用差几毫秒 → byte-不等, 本条立刻红。
   *   实装前传 `now` 给 v2 签名需要 cast (v2 尚未落地的字段); 测试用例**故意**用
   *   `now: 1_700_000_000_000` 锁住时间。
   */
  test('9 ★ 自取时钟: 同图 + 固定 now 画两次 ===, buildPathViewData 也不读时钟', () => {
    const d = buildPathViewData(fullMap());
    const opts = { width: 100, height: 30, selected: 0, now: 1_700_000_000_000 } as unknown as Parameters<typeof renderFogLine>[1];
    const a = renderFogLine(d, opts);
    const b = renderFogLine(d, opts);
    expect(b).toEqual(a);
    // buildPathViewData 同理 (不读 Date.now) —— 两次结果 JSON 化逐字节等
    const d1 = buildPathViewData(fullMap());
    const d2 = buildPathViewData(fullMap());
    expect(JSON.stringify(d2)).toBe(JSON.stringify(d1));
  });
});
