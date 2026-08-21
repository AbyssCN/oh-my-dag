/**
 * L1:pathfinder 散雾两画法(切片⑧,主 C 副 B)。
 *
 * **本文件 = 画法 B + 画法 C 幸存的不变量** —— Map 屏 v2(画法 C 完整段头序列、关色恒等、
 *   NULL≠0、自取时钟、空段不画、宽度闸等 8+1 条新闸)在 `path-fog-map.test.ts`。
 *   这边只保留:头行的 `· N runs` / `· no runs`、键位行贴底、高度封顶 `… N more`、
 *   选中行 `▸` 结构可见、票行带全标题 + 来源 run 截断前缀、雾地平线 + `█` 进度条等
 *   「v2 渲染下仍然成立的」不变量。
 *
 * **切片 2 · SDD §3.2 + 乙案 chrome 英文翻**:画法 C 段头 / 读数 / 键位 / 等待标签的 chrome
 *   字面按 2026-08-22 裁定逐字改英文 —— `已散` → `settled`、`前沿` → `frontier`、
 *   `受阻`/`机器建议` 段头保留但字面随 乙案,雾地平线 `雾 · N 张未裁` → `fog · N unruled`、
 *   键位 `↑↓ 选票 · Enter 就地裁 · g 先问 · d 交给引擎 · Ctrl+P 退出` →
 *   `↑↓ vote · Enter on-site · g ask first · d hand to engine · Ctrl+P quit`。
 *   每条断言**真正管的事**保留(段头出现 / 顺序 / 选中前缀 / 票标题 / run 前缀 /
 *   雾地平线格式 / 高度封顶 / 雾行数 ≤1 / 关色恒等 / 宽度不超 / no runs 真话),
 *   只把字面从中文翻到英文。
 *
 * 反向自检:
 * - 「票与 run 的关系」那条 —— 把 buildPathViewData 里 suggestedBy 的收集去掉,
 *   runs 计数与票行的 `← run` 注记两条断言当场红。
 * - 「宽度不超」拿 CJK 长标题喂 —— fitLine 被绕开时 visibleWidth 断言红。
 * - 「选中行带 ▸ + 全标题 + 8 字 run 前缀」:把 mapTicketLine 的 `▸ ` 改成 `'  '`
 *   或把 `t.runId.slice(0,8)` 改成 `slice(0,4)`,本条当场红。
 */
import { visibleWidth } from '@earendil-works/pi-tui';
import { describe, expect, test } from 'bun:test';
import type { PathMap, Ticket } from '../../harness/pathfinder/types';
import { buildPathViewData, renderDelta, renderFogLine } from './path-fog';

const ticket = (over: Partial<Ticket> & { id: string }): Ticket => ({
  type: 'task',
  title: `${over.id} 的待决问题`,
  blockedBy: [],
  status: 'open',
  ...over,
});

const map = (): PathMap => ({
  destination: 'omd-agent-tui',
  slug: 'omd-agent-tui',
  tickets: [
    ticket({ id: 'd01', status: 'ruled' }),
    ticket({ id: 'd05', status: 'ruled' }),
    ticket({ id: 't9', type: 'task', title: '审批层四档', suggestedBy: 'run-78f1951c' }),
    ticket({ id: 'g4', type: 'grill', title: 'ledger 判据' }),
    ticket({ id: 'b1', title: '会话树 fork', blockedBy: ['g4'], status: 'blocked' }),
  ],
  decisionsLog: [
    { ticketId: 'd01', gist: 'stdio' },
    { ticketId: 'd05', gist: 'memory' },
  ],
  suggestionsLog: [{ ticketId: 't9', outcome: 'accepted', at: '2026-08-08T00:00:00Z', runId: 'run-78f1951c' }],
});

describe('buildPathViewData', () => {
  test('凝固代按 decisionsLog 顺序 (id+gist); 前沿/阻塞/散雾计数对', () => {
    const d = buildPathViewData(map());
    expect(d.gens).toEqual([[{ id: 'd01', gist: 'stdio' }, { id: 'd05', gist: 'memory' }]]);
    expect(d.frontier.map((t) => t.id)).toEqual(['t9', 'g4']);
    // v2 数据面: blockedTickets 自带 by[] —— 票行尾的「← 等 <id> 裁」靠它, 不发明第二套。
    expect(d.blockedTickets).toEqual([{ id: 'b1', title: '会话树 fork', by: ['g4'] }]);
    expect(d.ruled).toBe(2);
    expect(d.total).toBe(5);
  });

  test('★ 票与 run 的关系: suggestedBy + suggestionsLog 去重后进 runs; 票行带来源 run', () => {
    const d = buildPathViewData(map());
    expect(d.runs).toEqual(['run-78f1951c']); // 两处同一个 run → 去重成一条
    expect(d.frontier.find((t) => t.id === 't9')?.runId).toBe('run-78f1951c');
    expect(d.frontier.find((t) => t.id === 'g4')?.runId).toBeUndefined();
  });
});

describe('画法 C 雾退线', () => {
  /**
   * v2 Map 屏的空间构图:头行 → goal → 已散段头 + ✓ 行 → 前沿段头 + 票行(选中 `▸`)→
   *   受阻段头 + 阻塞行 → 雾地平线 → 读数条 → 键位行。每段都在;垂直关系不能丢。
   */
  test('空间构图: 段头序列 + 选中行 `▸` 前缀 + 票行带全标题 + 来源 run 截断前缀 + 雾地平线含 `fog ·`', () => {
    const out = renderFogLine(buildPathViewData(map()), { width: 100, height: 30, selected: 0 });
    const body = out.join('\n');
    expect(out[0]).toContain('fog line');          // 头行 `[fog line]` 标识仍是 C 画法
    expect(out[0]).toContain('· 1 runs');          // runs 字段没退化(NULL ≠ 0 段)
    // 2026-08-22 乙案:段头用英文;invariant = 段头出现且带 gen-N。
    expect(body).toContain('settled · gen-1');
    expect(body).toMatch(/d01\s+stdio/);           // id + gist 进 ✓ 行
    expect(body).toMatch(/d05\s+memory/);          // id + gist 进 ✓ 行
    // 选中行 `▸` 前缀——结构可见,不靠颜色(灰字也读得出谁被选)。
    expect(body).toMatch(/▸ ● t9/);
    // 阻塞票行:不再带 `x` 前缀;靠 em-dash `─` 标记「被挡」, id 还在, 尾标「← 等 g4 裁」。
    expect(body).toMatch(/─\s+b1/);
    // 票行带完整标题 + 来源 run(截断到 8 字 → `run-78f1`),原文 `78f1951c` 不在屏上但前缀可见。
    // SDD §3.2: 前沿行含全标题 + `run 78f1951c` —— pin 到选中行而不是任意位置(收紧旧 `/← run run/`)。
    const selLine = out.find((l) => l.includes('▸ ● t9')) ?? '';
    expect(selLine, '选中行 含全标题').toContain('审批层四档');
    expect(selLine, '选中行 含 8 字 run 前缀').toMatch(/← run run-78f1/);
    expect(body).toContain('blocked 1');           // 读数条里 `· blocked 1 ·`
    // 雾退化成一行的地平线, N = total - ruled = 5 - 2 = 3。
    expect(body).toMatch(/fog · \d+ unruled/);
    // 读数条仍带 `█` 进度条 + 三段计数。
    expect(body).toMatch(/fog 40% [█░]+ · open 2 · blocked 1 · run x1/);
  });

  test('颜色钩子: 给了 paint 时选中行走 sel 通道 (NO_COLOR/测试下恒等仍可读)', () => {
    const tag = (n: string) => (s: string) => `<${n}>${s}</${n}>`;
    const out = renderFogLine(buildPathViewData(map()), {
      width: 100, height: 30, selected: 0,
      paint: { accent: tag('a'), dim: tag('d'), warn: tag('w'), sel: tag('s') },
    }).join('\n');
    // 选中前缀 `▸`, sel 通道包外。不靠颜色:剥掉标签后仍能从 `▸` 看出谁被选。
    expect(out).toContain('<s>▸ ● t9');
    // 2026-08-21: 阻塞票从汇总行 (`blocked N: ids`) 挪进票清单一票一行, warn 通道不变。
    // v2: 行首不再是 `x`, 改成 `─ `(受阻标记), id + 尾标「← 等 g4 裁」。
    expect(out).toContain('<w>  ─ b1');
  });

  test('前沿空时说清为什么(灰常量即真值)', () => {
    const m = map();
    for (const t of m.tickets) t.status = 'ruled';
    const out = renderFogLine(buildPathViewData(m), { width: 80, height: 30, selected: 0 }).join('\n');
    // v2 不画「frontier」段(无源恒缺席, INV-MAP-8);灰字「真话」下移到雾地平线 —— 全裁时 N=0。
    expect(out).toContain('fog · 0 unruled');
  });

  /**
   * ★ 2026-08-21 回归闸的 v2 翻译:**雾不许占屏**(INV-MAP-3)。
   *
   * 缺陷实况 (owner 截图): 60 行终端 + 3 张票 → 内容 8 行, 雾 50 行, 整屏马赛克。
   * 旧测试全瞎, 因为它们只跑 height 30/40 且从不量雾占几行。
   * v2 把雾退成一条地平线(`▒`/`░` 纹理出现在带子上的情况几乎没了)——
   * 因此这条闸从「≤5 行」收紧到「≤1 行」(读数条那 12 格进度条恰是 12 个 `░`,
   * 不到一行的阈值 30, 不算雾行)。
   * **证伪方式**: 把 v2 的 `horizon()`(只画线,不画纹理)换回 `fogBand()`(画 ░/▒
   * 纹理带), 60 行屏 + 6 票 = 5 行雾带, 每行 ≥30 ░/▒ 块, 本条立刻红(量到 5)。
   */
  test('★ 高屏少票: 雾不占屏 — 含 ░/▒ 的行 ≤ 1 (INV-MAP-3, 不许简单删掉)', () => {
    const out = renderFogLine(buildPathViewData(map()), { width: 100, height: 60, selected: 0 });
    const fogRows = out.filter((l) => (l.match(/[░▒]/g)?.length ?? 0) >= 30);
    expect(fogRows.length, `雾行数 (整屏马赛克回归)`).toBeLessThanOrEqual(1);
    // 空出来的行给票 —— 两张前沿票的全标题都在, 不再只有选中那张可见。
    const body = out.join('\n');
    expect(body).toContain('审批层四档');
    expect(body).toContain('ledger 判据');
  });

  /**
   * v2: clampMapHeight 走「头 kept + fold + 尾 3」模式 —— 不在窗口内「贴 selected」。
   * 「selected 必须在窗口内」是 tui.ts 那侧的事(滚动到 selected),不是渲染侧的责任。
   * 这边只钉死:票清单真折叠,折叠行说了剪多少, 头/尾 chrome 没掉。
   */
  test('票多于预算 → 票清单中段折叠, 末三行 (地平线 + 读数 + 键位) 贴底', () => {
    const m = map();
    for (let i = 0; i < 20; i++) m.tickets.push(ticket({ id: `x${i}`, title: `第 ${i} 张` }));
    const out = renderFogLine(buildPathViewData(m), { width: 100, height: 20, selected: 15 });
    const body = out.join('\n');
    expect(body).toMatch(/… \d+ more/);     // 折叠行说清剪了多少
    // 2026-08-22 打磨: 键位行原文从 `↑↓ vote` 改成 `up/down picks a ticket`
    // (`vote` 是把「选票」误译成了投票)。这条闸管的事没变: **末三行(键位)贴底**。
    expect(body).toContain('up/down picks a ticket');
  });

  test('没有 run 推进过 → 说真话, 不画 0 个', () => {
    const m = map();
    for (const t of m.tickets) t.suggestedBy = undefined;
    m.suggestionsLog = [];
    const out = renderFogLine(buildPathViewData(m), { width: 100, height: 30, selected: 0 });
    expect(out[0]).toContain('· no runs');
  });
});

describe('画法 B 三角洲', () => {
  test('★ 河系构图: 主干 + 实线支流 (带 gist) + 虚段梢头 + 每行右侧雾场列', () => {
    const out = renderDelta(buildPathViewData(map()), { width: 100, height: 30, selected: 1 });
    const body = out.join('\n');
    expect(out[0]).toContain('delta');
    expect(body).toContain('● omd-agent-tui (goal)');
    expect(body).toContain('├── d01 stdio ── d05 memory'); // 支流链带 gist
    expect(body).toMatch(/├···· t9●/); // 梢头虚段
    expect(body).toMatch(/└···· \[g4◆[^\]]*\]/); // 选中梢头 [] 包
    expect(body).toMatch(/x?b1.*blocked/); // 阻塞梢头
    // 每一行右侧都有雾场列 (░ 或 ▒ 结尾附近)
    const tipRow = out.find((l) => l.includes('t9●'));
    expect(tipRow && /[░▒]/.test(tipRow)).toBe(true);
  });
});

describe('宽度闸(CJK 标题不超宽)', () => {
  test('两画法每行都不超, 窄屏也不超', () => {
    const m = map();
    (m.tickets[3] as Ticket).title = '一个特别特别长的中文标题'.repeat(6);
    const d = buildPathViewData(m);
    for (const w of [40, 80, 120]) {
      for (const line of renderFogLine(d, { width: w, height: 40, selected: 0 })) {
        expect(visibleWidth(line), `fog w=${w}`).toBeLessThanOrEqual(w);
      }
      for (const line of renderDelta(d, { width: w, height: 40, selected: 0 })) {
        expect(visibleWidth(line), `delta w=${w}`).toBeLessThanOrEqual(w);
      }
    }
  });

  test('高度封顶, 剪掉的说清剪了多少', () => {
    const m = map();
    for (let i = 0; i < 40; i++) m.tickets.push(ticket({ id: `x${i}` }));
    const out = renderFogLine(buildPathViewData(m), { width: 80, height: 12, selected: 0 });
    expect(out.length).toBe(12);
    // 2026-08-21: 折叠标记从**最后一行**(clampHeight 兜底)挪到**票清单内**——
    // 清单自己按预算裁, 于是整屏本来就装得下, clampHeight 不再触发。
    // 不变的是这条闸真正管的事: 剪掉了就得说剪了多少。
    expect(out.join('\n')).toMatch(/… \d+ more/);
    // ⚠ 锚点不许锚在**行尾** —— 80 列下这一行本来就被截(`…` 结尾), `Ctrl+P quit` 不在。
    // 这条闸管的是「键位行仍贴屏底」, 所以锚**行首**那段, 它在任何宽度下都活着。
    expect(out[11]).toContain('up/down picks a ticket');
  });
});
