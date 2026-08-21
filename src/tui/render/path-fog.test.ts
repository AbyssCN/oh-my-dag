/**
 * L1:pathfinder 散雾两画法(切片⑧,主 C 副 B)。
 *
 * 反向自检:
 * - 「票与 run 的关系」那条 —— 把 buildPathViewData 里 suggestedBy 的收集去掉,
 *   runs 计数与票行的 `<- run` 注记两条断言当场红。
 * - 「宽度不超」拿 CJK 长标题喂 —— fitLine 被绕开时 visibleWidth 断言红。
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
    expect(d.blockedTickets).toEqual([{ id: 'b1', title: '会话树 fork' }]);
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
  test('★ 空间构图: 地层带 gist + 票钉在线上 (选中 [] 包) + 指针行 + 详情行 + 雾层渐变 + 底部读数', () => {
    const out = renderFogLine(buildPathViewData(map()), { width: 100, height: 30, selected: 0 });
    const body = out.join('\n');
    expect(out[0]).toContain('fog line');
    expect(out[0]).toContain('· 1 runs');
    expect(body).toContain('gen-1  d01 stdio · d05 memory'); // 地层 = id + gist (稿的形)
    // 票钉在一条横线上, 选中的 [] 包 (结构可见, 不靠颜色); 阻塞票 x 前缀也钉着
    expect(body).toMatch(/frontier ═\[t9●[^\]]*\]──g4◆[^─]*─/);
    expect(body).toContain('xb1');
    expect(body).toContain('↓'); // 指针行: 票往雾里指
    expect(body).toContain('> ● t9 task  审批层四档  <- run run-78f1'); // 选中详情行带全文与 run
    expect(body).toContain('blocked 1');
    expect(body).toContain('? ? ?');
    expect(body).toMatch(/fog 40% [█░]+ · open 2 · blocked 1 · run x1/); // 底部读数条
  });

  test('颜色钩子: 给了 paint 时选中行走 sel 通道 (NO_COLOR/测试下恒等仍可读)', () => {
    const tag = (n: string) => (s: string) => `<${n}>${s}</${n}>`;
    const out = renderFogLine(buildPathViewData(map()), {
      width: 100, height: 30, selected: 0,
      paint: { accent: tag('a'), dim: tag('d'), warn: tag('w'), sel: tag('s') },
    }).join('\n');
    expect(out).toContain('<s>> ● t9');
    // 2026-08-21: 阻塞票从汇总行 (`blocked N: ids`) 挪进票清单一票一行, warn 通道不变。
    expect(out).toContain('<w>  x b1 blocked');
  });

  test('前沿空时说清为什么(灰常量即真值)', () => {
    const m = map();
    for (const t of m.tickets) t.status = 'ruled';
    const out = renderFogLine(buildPathViewData(m), { width: 80, height: 30, selected: 0 }).join('\n');
    expect(out).toContain('frontier 0 (everything ruled)');
  });

  /**
   * ★ 2026-08-21 回归闸: 高屏 + 少票时雾不许占屏。
   *
   * 缺陷实况 (owner 截图): 60 行终端 + 3 张票 → 内容 8 行, 雾 50 行, 整屏马赛克。
   * 旧测试全瞎, 因为它们只跑 height 30/40 且从不量雾占几行。
   * **证伪方式**: 把 renderFogLine 里的 `Math.min(FOG_BAND_MAX, ...)` 去掉 (退回"撑满剩余高度"),
   * 本条立刻红 —— 量到 ~47 行雾。
   */
  test('★ 高屏少票: 雾带封顶 ≤5 行, 票全标题上屏 (不缩到 8 字)', () => {
    const out = renderFogLine(buildPathViewData(map()), { width: 100, height: 60, selected: 0 });
    // ≥30 个块字符才算雾行 —— 底部读数条的 12 格进度条 (BAR_TODO = '░') 否则会混进来。
    const fogRows = out.filter((l) => (l.match(/[░▒]/g)?.length ?? 0) >= 30);
    expect(fogRows.length, `雾行数 (整屏马赛克回归)`).toBeLessThanOrEqual(5);
    // 空出来的行给票 —— 两张前沿票的全标题都在, 不再只有选中那张可见。
    const body = out.join('\n');
    expect(body).toContain('审批层四档');
    expect(body).toContain('ledger 判据');
  });

  test('票多于预算 → 窗口贴着 selected 走, 尾行折叠', () => {
    const m = map();
    for (let i = 0; i < 20; i++) m.tickets.push(ticket({ id: `x${i}`, title: `第 ${i} 张` }));
    const out = renderFogLine(buildPathViewData(m), { width: 100, height: 20, selected: 15 });
    const body = out.join('\n');
    expect(body).toContain('more');
    expect(body).toMatch(/>.*x13/); // selected 必须在窗口内
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
    expect(out[11]).toContain('Ctrl+P exits'); // 键位行仍贴屏底
  });
});
