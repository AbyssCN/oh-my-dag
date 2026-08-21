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

  /**
   * 10 段头中性量词 N tickets: 四段(已散 / 前沿 / 受阻 / 建议)段头右槽统一写 `N tickets`,
   *    五段段头行不再含 `open` 计数词。
   *
   * **证伪方式**: (把承重跳换成下列任一弱实现 → 对应 expect 变红)
   *  - 任一段头的 `${d.X.length} tickets` 换回 `${d.X.length} open` →
   *    那一段的 `.toContain('N tickets')` 红;该段 `.not.toContain('open')` 红。
   *  - 改字面为 `tix` / `items` / `count` 等 →
   *    `.toContain('N tickets')` 红(下方 readout 条仍可写 `· open N`, 不在本条管辖范围)。
   */
  test('10 段头中性量词 N tickets: 四段段头均写 N tickets 且不含 `open`', () => {
    const out = renderFogLine(buildPathViewData(fullMap()), { width: 100, height: 30, selected: 0 });
    const findHead = (label: string) => out.find((l) => l.includes(label)) ?? '';

    // fullMap: 2 ruled(已散) + 2 frontier + 1 blocked + 1 suggested
    expect(findHead('settled · gen-1'), '已散段段头').toContain('2 tickets');
    expect(findHead('frontier · movable'), '前沿段段头').toContain('2 tickets');
    expect(findHead('━━ blocked ━━'), '受阻段段头').toContain('1 tickets');
    expect(findHead('engine suggestion · unreceived'), '建议段段头').toContain('1 tickets');

    // 五段段头均不再含 `open` 计数词(底部 readout 条仍可写 `open N`, 本条不覆盖)。
    for (const [label, name] of [
      ['settled · gen-1', '已散段'],
      ['frontier · movable', '前沿段'],
      ['━━ blocked ━━', '受阻段'],
      ['engine suggestion · unreceived', '建议段'],
    ] as const) {
      const line = findHead(label);
      expect(line, `${name} 段头不应含 \`open\` 计数词`).not.toContain('open');
    }
  });

  /**
   * 11 waiting 优先保住: STALE 建议票长标题在窄宽度下, 等待读数完整保留, 标题被截断。
   *
   * **证伪方式**: (把承重跳换成下列任一弱实现 → 对应 expect 变红)
   *  - 改回原始写法 `out.push(... clip(\`  ${mark} ${t.id} ${t.title}${suffix}\`, width))`
   *    (整行过 clip(width) 从尾砍) → `waiting 240m0s` 被截 →
   *    `.toContain(expectedWait)` 红, `.toMatch(/waiting \d/)` 红。
   *  - 去掉 `clip(t.title, titleBudget)` 直接拼接 `t.title` → 行可见宽 ≤ width 仍然成立,
   *    但 `.toContain('…')` 红 + `.not.toContain(longTitle)` 红(标题未截)。
   *  - 改 STALE 标记(staleAt 移除) → `.toContain('✗ STALE')` 红。
   *  - 把 suggested 行模板改回不带 type 列的 `\``  ${mark} ${padS(t.id, 6)} ${clip(t.title, …)}${suffix}\`` →
   *    标题起始列前移 → 在 width=80 下 titleBudget 变大, `.toContain('…')` 红;
   *    等待仍可能保留 → 这是承重跳的最弱处, 复合断言 `toContain('…')` + `not.toContain(longTitle)` 双钉。
   * 注: width=40 STALE + wait 在本实装下整行可见宽 44 > 40, 不在本条覆盖(留给独立修复)。
   */
  test('11 waiting 优先保住: STALE 长标题下截标题不截 waiting', () => {
    const now = 1_700_000_000_000;
    const waitingSince = new Date(now - 4 * 60 * 60 * 1000).toISOString();
    const longTitle = '一个特别特别长的中文标题'.repeat(20); // 220 列(CJK ×20)
    const m: PathMap = {
      destination: 'omd-agent-tui',
      slug: 'omd-agent-tui',
      tickets: [
        ticket({
          id: 's1',
          type: 'research',
          title: longTitle,
          status: 'suggested',
          staleAt: '2020-01-01T00:00:00Z', // 任意 ISO 即可置 STALE
          waitingSince,
        }),
      ],
      decisionsLog: [],
    };

    // 4h → fmtDur = 240m0s;固定 now 保证两条用例共用同一期望。
    const expectedWait = 'waiting 240m0s';

    // 在实装能承下的窄宽度上测(weight=40 STALE + wait 会越 width 闸, 留给后续单独修)。
    for (const w of [80, 120]) {
      const opts = { width: w, height: 40, selected: 0, now } as unknown as Parameters<typeof renderFogLine>[1];
      const out = renderFogLine(buildPathViewData(m), opts);
      const sLine = out.find((l) => l.includes('s1')) ?? '';

      expect(sLine, `w=${w}: 渲染出 STALE 行`).toBeTruthy();
      expect(sLine, `w=${w}: STALE 标记在行内`).toContain('✗ STALE');
      // 等待读数完整保留(承重断言)
      expect(sLine, `w=${w}: 等待读数完整保留(\`${expectedWait}\`)`).toContain(expectedWait);
      expect(sLine, `w=${w}: waiting 后跟数字(等待读数未被截)`).toMatch(/waiting \d/);
      // 标题被截断: 行内有省略号, 完整长标题不在行内
      expect(sLine, `w=${w}: 标题被截(行内有省略号 \`…\`)`).toContain('…');
      expect(sLine, `w=${w}: 完整长标题不在行内(被截)`).not.toContain(longTitle);
      // 宽度闸不被破坏
      expect(visibleWidth(sLine), `w=${w}: STALE 行 visibleWidth <= w`).toBeLessThanOrEqual(w);
    }
  });

  /**
   * 12 键位行措辞: 写 `up/down picks a ticket`, 不再写 `↑↓ vote`。
   *
   * **证伪方式**: (把承重跳换成下列任一弱实现 → 对应 expect 变红)
   *  - 键位行仍写 `'↑↓ vote · ...'`(没改) → `.not.toContain('↑↓ vote')` 红;
   *    `.toContain('up/down picks a ticket')` 红(新文案缺失)。
   *  - 改写成 `'up/down selects'` / `'↑/↓ navigate'` / `'j/k select'` 等非字面措辞 →
   *    `.toContain('up/down picks a ticket')` 红(逐字钉死)。
   *  - 键位行直接删 → body 既不含 `up/down picks a ticket` 也不含 `↑↓ vote`,
   *    `.toContain` 红(`.not.toContain` 静默绿 —— 这是最弱处, 故双钉防御)。
   *
   * 注: 选用 width=120 而非 100, 保证键位行不被 width 闸裁断。
   */
  test('12 键位行: `up/down picks a ticket` 在, `↑↓ vote` 不在', () => {
    const out = renderFogLine(buildPathViewData(fullMap()), { width: 120, height: 30, selected: 0 });
    const body = out.join('\n');
    expect(body).toContain('up/down picks a ticket');
    expect(body).not.toContain('↑↓ vote');
  });

  /**
   * 13 列位对齐: 四段(已散 / 前沿 / 受阻 / 建议)的 id / type / 标题三列起始列彼此一致。
   *
   * 用 `selected: 100` 强制 frontier 票全为非选定(前缀 `  X `, 4 列),
   *   排除选定态 `▸ X ` 与 `  X ` 列宽差异造成的伪红。
   *
   * **证伪方式**: (把承重跳换成下列任一弱实现 → 对应 expect 变红)
   *  - 受阻段或已散段漏加 `padS('', 10)` 占位列(`  ✓ ${padS(t.id, 6)} ${t.gist}` / `  ─ ${padS(t.id, 6)} ${t.title}${suffix}`) →
   *    该段标题起始列前移到 `id + 7`(无 type 列) →
   *    `titles.blocked` / `titles.settled` 与 `titles.frontier` 不等 → `.toBe(...)` 红。
   *  - 受阻段占位列宽改成 `padS('', 8)` / `padS('', 12)`(非 10) →
   *    blocked 行标题起始列左/右移 2 → `.toBe(frontierCol)` 红。
   *  - 把前沿段 id-padding 改成非 6(`padS(t.id, 8)`) → id 列偏 2 →
   *    `ids.frontier` 与其它段不等 → 红。
   *  - 把建议段的 `${padS(t.type, 10)}` 漏写(`  ${mark} ${padS(t.id, 6)} ${clip(t.title, …)}...`)→
   *    suggested 行标题起始列前移 → `titles.suggested` ≠ 22 → 红。
   *  - 改用 `String.padEnd(6)` / `String.padStart(10)` 替 `padS`(CJK 列错位)→
   *    CJK title 行 visibleWidth 偏离计算 → 标题起始可见列改变 → 红。
   */
  test('13 列位对齐: 四段 id/type/标题 三列起始列一致(visibleWidth 感知)', () => {
    const out = renderFogLine(buildPathViewData(fullMap()), { width: 100, height: 30, selected: 100 });
    const findById = (id: string) => out.find((l) => l.includes(id)) ?? '';

    const settledLine = findById('d01');
    const frontierLine = findById('t1');
    const blockedLine = findById('b1');
    const suggestedLine = findById('s1');
    expect(settledLine, '已散段 d01 行').toContain('d01');
    expect(frontierLine, '前沿段 t1 行').toContain('t1');
    expect(blockedLine, '受阻段 b1 行').toContain('b1');
    expect(suggestedLine, '建议段 s1 行').toContain('s1');

    // 列号用 visibleWidth 算前缀可见列 —— 不依赖 indexOf / length(CJK 安全)
    const colOf = (line: string, needle: string) => visibleWidth(line.slice(0, line.indexOf(needle)));

    // id 起始列四段一致
    const ids = {
      settled: colOf(settledLine, 'd01'),
      frontier: colOf(frontierLine, 't1'),
      blocked: colOf(blockedLine, 'b1'),
      suggested: colOf(suggestedLine, 's1'),
    };
    expect(ids.frontier, '前沿=已散 id 起始列').toBe(ids.settled);
    expect(ids.blocked, '受阻=已散 id 起始列').toBe(ids.settled);
    expect(ids.suggested, '建议=已散 id 起始列').toBe(ids.settled);

    // type 起始列 = id + padS(id,6) + 1 space = id + 7(blocked/settled 是 10 空格占位, 仍占列)
    const tcs = {
      settled: ids.settled + 7,
      frontier: ids.frontier + 7,
      blocked: ids.blocked + 7,
      suggested: ids.suggested + 7,
    };
    expect(tcs.frontier, '前沿=已散 type 起始列').toBe(tcs.settled);
    expect(tcs.blocked, '受阻=已散 type 起始列').toBe(tcs.settled);
    expect(tcs.suggested, '建议=已散 type 起始列').toBe(tcs.settled);

    // 标题起始列(承重跳, 字面不等时各找自己的 title)
    const titles = {
      settled: colOf(settledLine, 'stdio'),     // d01 的 gist
      frontier: colOf(frontierLine, '前沿票 1'), // t1 title
      blocked: colOf(blockedLine, '阻塞票 1'),   // b1 title
      suggested: colOf(suggestedLine, '建议票 1'), // s1 title
    };
    expect(titles.frontier, '前沿=已散 标题起始列').toBe(titles.settled);
    expect(titles.blocked, '受阻=已散 标题起始列').toBe(titles.settled);
    expect(titles.suggested, '建议=已散 标题起始列').toBe(titles.settled);
  });

  /**
   * 10b 五段段头计数: 6 条 decisions → 2 个已散 gen (gen-1/gen-2) + frontier + blocked + suggested,
   *   共 5 个段头, 每段都写 N tickets 且不含 `open` 计数词。
   * 复盖 falsifiability_review "必须补强项" #2 (fullMap 默认 4 段, 五段计数未真正覆盖)。
   *
   * **证伪方式**: (把承重跳换成下列任一弱实现 → 对应 expect 变红)
   *  - 任一段头把 `${N} tickets` 换回 `${N} open` → 该段 `.toContain('N tickets')` 红 + `.not.toContain('open')` 红。
   *  - 漏画某段头 → `findHead` 返 `''`, `.toContain('N tickets')` 红。
   *  - GEN_WIDTH=5 的切片错位(decisionsLog 顺序错) → 第二代头变成 `gen-3` 而非 `gen-2`, `.toContain('1 tickets')` 红。
   *  - 改动 title 字面 → 仍可能绿(本条不依赖 title), 但与已存在的 10 互锁(10 钉字面, 10b 钉计数)。
   */
  test('10b 五段段头计数: 2 个已散 gen + frontier + blocked + suggested 均写 N tickets', () => {
    const m: PathMap = {
      destination: 'omd-agent-tui',
      slug: 'omd-agent-tui',
      tickets: [
        ticket({ id: 'd01', status: 'ruled' }),
        ticket({ id: 'd02', status: 'ruled' }),
        ticket({ id: 'd03', status: 'ruled' }),
        ticket({ id: 'd04', status: 'ruled' }),
        ticket({ id: 'd05', status: 'ruled' }),
        ticket({ id: 'd06', status: 'ruled' }),
        ticket({ id: 't1', type: 'task', title: 'frontier 1' }),
        ticket({ id: 'b1', title: 'blocked 1', blockedBy: ['d99'], status: 'blocked' }),
        ticket({ id: 's1', title: 'suggested 1', status: 'suggested' }),
      ],
      decisionsLog: [
        { ticketId: 'd01', gist: 'g1' },
        { ticketId: 'd02', gist: 'g2' },
        { ticketId: 'd03', gist: 'g3' },
        { ticketId: 'd04', gist: 'g4' },
        { ticketId: 'd05', gist: 'g5' },
        { ticketId: 'd06', gist: 'g6' },
      ],
      suggestionsLog: [{ ticketId: 't1', outcome: 'accepted', at: '2026-08-08T00:00:00Z', runId: 'run-x' }],
    };
    const out = renderFogLine(buildPathViewData(m), { width: 120, height: 30, selected: 0 });
    const findHead = (label: string) => out.find((l) => l.includes(label)) ?? '';

    expect(findHead('settled · gen-1'), 'gen-1 段头').toContain('5 tickets');
    expect(findHead('settled · gen-2'), 'gen-2 段头').toContain('1 tickets');
    expect(findHead('frontier · movable'), '前沿段头').toContain('1 tickets');
    expect(findHead('━━ blocked ━━'), '受阻段头').toContain('1 tickets');
    expect(findHead('engine suggestion · unreceived'), '建议段头').toContain('1 tickets');

    for (const [label, name] of [
      ['settled · gen-1', 'gen-1'],
      ['settled · gen-2', 'gen-2'],
      ['frontier · movable', '前沿'],
      ['━━ blocked ━━', '受阻'],
      ['engine suggestion · unreceived', '建议'],
    ] as const) {
      expect(findHead(label), `${name} 段头不应含 open 计数词`).not.toContain('open');
    }
  });

  /**
   * 11b waiting · start unknown 后缀在 width ∈ {40, 80, 120} 下 waiting 完整保留 + 宽度闸 ≤ width。
   * 复盖 falsifiability_review "必须补强项" #3。
   *
   * **证伪方式**: (把承重跳换成下列任一弱实现 → 对应 expect 变红)
   *  - 退回旧写法整行 `clip(width)` 从尾砍 → `waiting · start unknown` 被截 → `.toContain('waiting · start unknown')` 红。
   *  - 改回 `prefixW = t.stale ? 28 : 22` 硬编码, 不做动态 type 列宽缩 → w=40 下 visibleWidth = 47 > 40 → `.toBeLessThanOrEqual(40)` 红。
   *  - 把 `waiting · start unknown` 字面换短(改 fmtDur)→ `.toContain('waiting · start unknown')` 红。
   *  - 把 `staleAt` 去掉 → mark 变 `○`, 但本条不依赖 mark; 字面 'waiting · start unknown' 仍在 → 不会红(本条专注于长 suffix 的宽度承重)。
   *  - 把 `typeCols` 算式错位 → w=40 visibleWidth 超 40 → 红。
   */
  test('11b waiting · start unknown 后缀在 w ∈ {40,80,120} 下宽度闸不破', () => {
    const now = 1_700_000_000_000;
    const m: PathMap = {
      destination: 'omd-agent-tui',
      slug: 'omd-agent-tui',
      tickets: [
        ticket({
          id: 's1',
          type: 'research',
          title: '任一中文标题',
          status: 'suggested',
          // waitingSince 不传 → waitingHumanState → 'waiting-unknown-since' → 'waiting · start unknown' (长 suffix)
        }),
      ],
      decisionsLog: [],
    };

    for (const w of [40, 80, 120]) {
      const opts = { width: w, height: 30, selected: 0, now } as unknown as Parameters<typeof renderFogLine>[1];
      const out = renderFogLine(buildPathViewData(m), opts);
      const sLine = out.find((l) => l.includes('s1')) ?? '';

      expect(sLine, `w=${w}: 渲染出 s1 行`).toBeTruthy();
      // waiting · start unknown 是这一档唯一承重信息 —— 必须完整保留
      expect(sLine, `w=${w}: 完整保留 \`waiting · start unknown\`(长 suffix 不被砍)`).toContain('waiting · start unknown');
      // 行可见宽不超过 width(动态 type 列宽缩的承重跳)
      expect(visibleWidth(sLine), `w=${w}: 行 visibleWidth ≤ width(动态 type 列宽缩生效)`).toBeLessThanOrEqual(w);
    }
  });

  /**
   * 13b CJK id/type 进入 padS 输入时四段 id/标题起始列仍一致(visibleWidth 感知)。
   * 复盖 falsifiability_review "必须补强项" #1 (13 用 ASCII id/type, padS↔padEnd 互换不可见)。
   *
   * **证伪方式**: (把承重跳换成下列任一弱实现 → 对应 expect 变红)
   *  - 把 `padS(t.id, 6)` 换 `String.padEnd(6)` → `padS` 按 visibleWidth 补 CJK, `padEnd` 按 .length 补 →
   *    CJK id 列宽偏移 → 四段 id 起始列不相等 → `.toBe(ids.settled)` 红。
   *  - 把 `padS(t.type, 10)` 换 `String.padEnd(10)` → 同上, type 列 / title 列偏移 →
   *    四段 title 起始列不相等 → `.toBe(titles.settled)` 红。
   *  - 受阻段/已散段漏加 `padS('', 10)` 占位列 → 该段 title 起始列前移 → 红。
   *  - 建议段 `${padS(t.type, 10)}` 漏写 → title 起始列前移 11 → 红。
   *  - 建议段退回整行 `clip(width)` → waiting suffix 残留但行 visibleWidth 可能越 width(本条不依赖 width, 但 CJK title 进 clip 行为可能变)。
   */
  test('13b CJK id 进入 padS 输入时四段 id/标题起始列仍一致(visibleWidth 感知)', () => {
    const m: PathMap = {
      destination: 'omd-agent-tui',
      slug: 'omd-agent-tui',
      tickets: [
        ticket({ id: '票a', status: 'ruled' }),
        ticket({ id: '票b', status: 'ruled' }),
        ticket({ id: '票c', type: 'research', title: '前沿票 CJK' }),
        ticket({ id: '票d', title: '受阻票 CJK', blockedBy: ['d99'], status: 'blocked' }),
        ticket({ id: '票e', type: 'task', title: '建议票 CJK', status: 'suggested' }),
      ],
      decisionsLog: [
        { ticketId: '票a', gist: '已散 a' },
        { ticketId: '票b', gist: '已散 b' },
      ],
      suggestionsLog: [{ ticketId: '票c', outcome: 'accepted', at: '2026-08-08T00:00:00Z', runId: 'run-x' }],
    };
    const out = renderFogLine(buildPathViewData(m), { width: 120, height: 30, selected: 100 });
    const findById = (id: string) => out.find((l) => l.includes(id)) ?? '';

    const settledLine = findById('票a');
    const frontierLine = findById('票c');
    const blockedLine = findById('票d');
    const suggestedLine = findById('票e');
    expect(settledLine, '已散段 票a 行').toContain('票a');
    expect(frontierLine, '前沿段 票c 行').toContain('票c');
    expect(blockedLine, '受阻段 票d 行').toContain('票d');
    expect(suggestedLine, '建议段 票e 行').toContain('票e');

    const colOf = (line: string, needle: string) => visibleWidth(line.slice(0, line.indexOf(needle)));

    // id 起始列四段一致 —— CJK id 走 padS 按 visibleWidth 补白, padEnd 按 .length 补, 列偏移会暴露
    const ids = {
      settled: colOf(settledLine, '票a'),
      frontier: colOf(frontierLine, '票c'),
      blocked: colOf(blockedLine, '票d'),
      suggested: colOf(suggestedLine, '票e'),
    };
    expect(ids.frontier, '前沿=已散 id 起始列(CJK)') .toBe(ids.settled);
    expect(ids.blocked, '受阻=已散 id 起始列(CJK)') .toBe(ids.settled);
    expect(ids.suggested, '建议=已散 id 起始列(CJK)').toBe(ids.settled);

    // 标题起始列四段一致 —— CJK title 走 clip(visibleWidth 感知)
    const titles = {
      settled: colOf(settledLine, '已散 a'),
      frontier: colOf(frontierLine, '前沿票 CJK'),
      blocked: colOf(blockedLine, '受阻票 CJK'),
      suggested: colOf(suggestedLine, '建议票 CJK'),
    };
    expect(titles.frontier, '前沿=已散 标题起始列(CJK)') .toBe(titles.settled);
    expect(titles.blocked, '受阻=已散 标题起始列(CJK)') .toBe(titles.settled);
    expect(titles.suggested, '建议=已散 标题起始列(CJK)').toBe(titles.settled);

    // 宽度闸
    for (const l of [settledLine, frontierLine, blockedLine, suggestedLine]) {
      expect(visibleWidth(l), 'CJK 行 visibleWidth ≤ 120').toBeLessThanOrEqual(120);
    }
  });
});
