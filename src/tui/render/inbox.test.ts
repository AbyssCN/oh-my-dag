/**
 * L1: inbox renderer (SDD 片 5 切片 2).
 *
 * Pinned INV (see SDD §契约):
 *   - INV-INBOX-1 footer always contains 'ruling is not execution' and 'map_deliver' (for any items).
 *   - INV-INBOX-2 footer contains 'ruling' and 'goal' (same).
 *   - INV-INBOX-3 confirm-selected detail contains `c` + `accept` and **does NOT contain** `Enter rule on-site`
 *     (pathfinder.ts:503 is a hard gate; painting it wrong here = teaching people to crash into it).
 *   - INV-INBOX-4 renderer does NOT call MCP — this file does not assert 'input box prefilled'
 *     (that is wiring's job); what it pins is: 'selected detail shows Enter prefills / c accept / x reject'.
 *   - INV-5 structure does not depend on color: selected `▸`, stale `✗ STALE`, awaiting `⚠`; readable
 *     with colors off, paint identity → strip tags yields byte-equal output.
 *   - Pure function (same as INV-NOW-5): same input drawn twice is byte-equal.
 *   - Width gate: each line `visibleWidth(line) <= width`.
 *   - Height gate: overflow → kept head + '… N more' + last 3 (footer pinned to bottom).
 *
 * Reverse self-check (change impl → this turns red immediately):
 *   - 'INV-INBOX-1 footer': change `map_deliver` to `path_deliver` in renderFooter → 'map_deliver in footer' red.
 *   - 'INV-INBOX-3 confirm has no Enter rule on-site': add `Enter rule on-site` to confirm's detail →
 *     'confirm has no Enter rule on-site' red.
 *   - 'INV-5 stale literal (not color)': change STALE_TXT to only emit ANSI warn → 'stale shows ✗ STALE literal' red.
 *   - 'INV-5 paint identity → strip tags equal': change `p.sel(fitLine(...))` to `fitLine(p.sel(...))` →
 *     selected row fitLine entry is already tagged; tag width counted, color-off version narrower → byte-unequal.
 */
import { describe, expect, test } from 'bun:test';
import { visibleWidth } from '@earendil-works/pi-tui';
import { INBOX_MARK, type InboxItem, renderInbox } from './inbox';

const NOW = 1_700_000_000_000;

/** 剥掉 paint 注入的 `<tag>...</tag>`, 返回纯文本。 */
const stripTags = (s: string): string => s.replace(/<\/?[a-z]+>/g, '');

/** 工厂: 各 kind 一行造一个, 字段都给齐 —— 测试不要被默认值躲掉。 */
const ruleItem = (over: Partial<Extract<InboxItem, { kind: 'rule' }>> = {}): InboxItem => ({
  kind: 'rule',
  slug: 'demo',
  ticketId: '177',
  title: 'rule default title',
  ...over,
});
const confirmItem = (
  over: Partial<Extract<InboxItem, { kind: 'confirm' }>> = {},
): InboxItem => ({
  kind: 'confirm',
  slug: 'demo',
  ticketId: '188',
  title: 'confirm default title',
  ...over,
});
const nodeItem = (over: Partial<Extract<InboxItem, { kind: 'node' }>> = {}): InboxItem => ({
  kind: 'node',
  runId: 'aaaaaaaa-1111-2222-3333-444444444444',
  nodeId: 'e1',
  title: 'node default title',
  ...over,
});
const takeItem = (over: Partial<Extract<InboxItem, { kind: 'take' }>> = {}): InboxItem => ({
  kind: 'take',
  slug: 'demo',
  ticketId: '200',
  title: 'take default title',
  ...over,
});

describe('INV-INBOX-1 · footer always shows "ruling is not execution + map_deliver"', () => {
  test('with any item, footer contains "ruling is not execution" and "map_deliver"', () => {
    const out = renderInbox([ruleItem()], { width: 80, height: 30, selected: 0, now: NOW });
    const last = out[out.length - 1]!;
    expect(last).toContain('ruling is not execution');
    expect(last).toContain('map_deliver');
  });
  test('empty state also says it - educational invariant: must be visible the moment the screen opens', () => {
    const out = renderInbox([], { width: 80, height: 30, selected: 0, now: NOW });
    const last = out[out.length - 1]!;
    expect(last).toContain('ruling is not execution');
    expect(last).toContain('map_deliver');
  });
  test('all four kinds present, footer still pinned (invariant decoupled from items)', () => {
    const items: InboxItem[] = [ruleItem(), confirmItem(), nodeItem(), takeItem()];
    const out = renderInbox(items, { width: 80, height: 30, selected: 0, now: NOW });
    expect(out[out.length - 1]).toContain('ruling is not execution');
    expect(out[out.length - 1]).toContain('map_deliver');
  });
});

describe('INV-INBOX-2 · footer always shows "ruling + goal"', () => {
  test('footer contains ruling and goal (ruling = goal is the design semantic)', () => {
    const out = renderInbox([ruleItem()], { width: 80, height: 30, selected: 0, now: NOW });
    const last = out[out.length - 1]!;
    expect(last).toContain('ruling');
    expect(last).toContain('goal');
  });
});

describe('INV-INBOX-3 · confirm must not contain "Enter rule on-site"', () => {
  test('confirm selected → detail contains c + accept, NOT Enter rule on-site', () => {
    const out = renderInbox([confirmItem()], { width: 80, height: 30, selected: 0, now: NOW });
    const body = out.join('\n');
    expect(body).toContain('c ');
    expect(body).toContain('accept');
    // hard gate — giving confirm "Enter rule on-site" = teaching people to crash into pathfinder.ts:503
    expect(body).not.toMatch(/Enter rule on-site/);
  });
  test('rule selected → detail MAY contain "Enter rule on-site" (its legal action)', () => {
    const out = renderInbox([ruleItem()], { width: 80, height: 30, selected: 0, now: NOW });
    expect(out.join('\n')).toContain('Enter rule on-site');
  });
  test('confirm + rule mixed: confirm section has no Enter rule on-site, rule section has it', () => {
    const items: InboxItem[] = [confirmItem({ ticketId: '188', title: 'suggest' }), ruleItem({ ticketId: '177', title: 'rule' })];
    // select confirm: detail has c accept, no Enter rule on-site.
    const outConf = renderInbox(items, { width: 100, height: 30, selected: 0, now: NOW }).join('\n');
    expect(outConf).toContain('c accept');
    expect(outConf).not.toMatch(/Enter rule on-site/);
    // select rule: detail has Enter rule on-site, no c accept (that's confirm's action).
    const outRule = renderInbox(items, { width: 100, height: 30, selected: 1, now: NOW }).join('\n');
    expect(outRule).toContain('Enter rule on-site');
    expect(outRule).not.toContain('c accept');
  });
  test('each of the four kinds has its own hint — node / take get distinct literals', () => {
    const items: InboxItem[] = [nodeItem(), takeItem()];
    // select node (i=0)
    const outNode = renderInbox(items, { width: 100, height: 30, selected: 0, now: NOW }).join('\n');
    expect(outNode).toContain('Enter into graph');
    // select take (i=1)
    const outTake = renderInbox(items, { width: 100, height: 30, selected: 1, now: NOW }).join('\n');
    expect(outTake).toContain('Enter accept');
  });
});

describe('INV-INBOX-4 · renderer does not call MCP — "Enter prefills" literal', () => {
  test('footer explicitly says "Enter prefills"', () => {
    const out = renderInbox([ruleItem()], { width: 80, height: 30, selected: 0, now: NOW });
    const last = out[out.length - 1]!;
    expect(last).toContain('Enter prefills');
  });
});

describe('INV-5 · 结构信息不靠颜色', () => {
  test('★ 四态四字形 (rule/confirm/node/take), 全在 SAFE_GLYPH_WIDTHS 白名单', () => {
    // 钉死的字面: 等你 = ⚠, 建议 = ?, 节点 = ·, 待收 = ↑
    expect(INBOX_MARK.rule).toBe('⚠');
    expect(INBOX_MARK.confirm).toBe('?');
    expect(INBOX_MARK.node).toBe('·');
    expect(INBOX_MARK.take).toBe('↑');
    // 屏上真的画出了这四个
    const items: InboxItem[] = [ruleItem(), confirmItem(), nodeItem(), takeItem()];
    const out = renderInbox(items, { width: 100, height: 30, selected: 0, now: NOW }).join('\n');
    expect(out).toContain('⚠');
    expect(out).toContain('?');
    expect(out).toContain('·');
    expect(out).toContain('↑');
  });

  test('选中行带 ▸ (关色下从这一位直接读出谁被选)', () => {
    const items: InboxItem[] = [ruleItem({ title: 'a' }), ruleItem({ ticketId: '178', title: 'b' })];
    const out = renderInbox(items, { width: 100, height: 30, selected: 0, now: NOW }).join('\n');
    expect(out).toMatch(/▸ ⚠/);
  });

  test('★ stale item shows ✗ STALE literal (survives strip tags - not a color signal)', () => {
    const out = renderInbox([ruleItem({ stale: true, title: 'expired' })], {
      width: 100,
      height: 30,
      selected: 0,
      now: NOW,
    });
    const plain = stripTags(out.join('\n'));
    expect(plain).toContain('✗ STALE');
    // 不靠颜色: explicit paint must also show the literal
    const tag = (n: string) => (s: string) => `<${n}>${s}</${n}>`;
    const paint = { accent: tag('a'), dim: tag('d'), warn: tag('w'), sel: tag('s') };
    const tagged = renderInbox([ruleItem({ stale: true, title: 'expired' })], {
      width: 100,
      height: 30,
      selected: 0,
      now: NOW,
      paint,
    });
    expect(stripTags(tagged.join('\n'))).toContain('✗ STALE');
  });

  test('paint identity → byte-equal after stripping tags (no color carries info)', () => {
    const tag = (n: string) => (s: string) => `<${n}>${s}</${n}>`;
    const paint = { accent: tag('a'), dim: tag('d'), warn: tag('w'), sel: tag('s') };
    // ⚠ uses 200 cols not 100: <tag> literal is also visible cols (visibleWidth does not parse it as ANSI),
    //   at 100 cols the header overflows, tagged version gets truncateToWidth-cut to [0m...,
    //   no longer byte-equal to plain. 200 cols fits both, this gate cleanly tests "no color carries info".
    const items: InboxItem[] = [
      ruleItem({ title: 'rule item' }),
      confirmItem({ title: 'suggest item' }),
      nodeItem({ title: 'node item' }),
      takeItem({ title: 'take item' }),
    ];
    const tagged = renderInbox(items, { width: 200, height: 30, selected: 1, now: NOW, paint });
    const plain = renderInbox(items, { width: 200, height: 30, selected: 1, now: NOW });
    expect(tagged.map(stripTags).join('\n')).toBe(plain.join('\n'));
  });

  test('paint hook: selected row is full-sel; non-selected marker takes phase color', () => {
    const tag = (n: string) => (s: string) => `<${n}>${s}</${n}>`;
    const paint = { accent: tag('a'), dim: tag('d'), warn: tag('w'), sel: tag('s') };
    const items: InboxItem[] = [
      ruleItem({ title: 'rule' }),
      confirmItem({ title: 'suggest' }),
      nodeItem({ title: 'node' }),
    ];
    const out = renderInbox(items, { width: 100, height: 30, selected: 1, now: NOW, paint }).join('\n');
    // 选中行 (i=1, confirm) 整行 sel 通道包外: <s>▸ ? ...
    expect(out).toMatch(/<s>▸ \? /);
    // 非选中的 rule (i=0) marker 走 warn
    expect(out).toMatch(/<w>  ⚠ /);
    // 非选中的 node (i=2) marker 走 dim
    expect(out).toMatch(/<d>  · /);
  });
});

describe('纯函数 · 同输入 → 同输出 (INV-NOW-5 同款)', () => {
  test('连画两次, 逐字节等', () => {
    const items: InboxItem[] = [ruleItem({ title: 'a' }), confirmItem({ title: 'b' })];
    const a = renderInbox(items, { width: 80, height: 30, selected: 0, now: NOW });
    const b = renderInbox(items, { width: 80, height: 30, selected: 0, now: NOW });
    expect(a).toEqual(b);
  });
});

describe('empty state', () => {
  // reverse self-check: revert `if (len === 0) { return [empty, footer] }` back to plain `out[0] = renderHeader(...)` →
  // empty-state header contains "inbox" + "0 items" → expect(out[0]).not.toContain('0 items') red, expect(out.join('\n')).not.toContain('0 items') red.
  test('empty items → the truth line + footer, no "inbox · 0 items" header', () => {
    const out = renderInbox([], { width: 80, height: 30, selected: 0, now: NOW });
    const body = out.join('\n');
    // 首行是那句真话, 不是表头
    expect(out[0]).toContain('(empty');
    expect(out[0]).not.toContain('inbox');
    // 不画「0 items」(「画 0」是噪音, NULL ≠ 0: 全空走空态分支)
    expect(body).not.toContain('0 items');
    expect(body).not.toMatch(/\b0 /);
    // 底边还在 (INV-INBOX-1/2)
    expect(out[out.length - 1]).toContain('ruling is not execution');
  });
});

describe('选中索引 mod', () => {
  test('selected 越界 / 负数 → mod 归位', () => {
    const items: InboxItem[] = [ruleItem({ ticketId: '1', title: 'a' }), ruleItem({ ticketId: '2', title: 'b' })];
    const outNeg = renderInbox(items, { width: 100, height: 30, selected: -1, now: NOW }).join('\n');
    expect(outNeg).toMatch(/▸ ⚠ .*b/);
    const outBig = renderInbox(items, { width: 100, height: 30, selected: 5, now: NOW }).join('\n');
    expect(outBig).toMatch(/▸ ⚠ .*b/);
  });
});

describe('width gate · lines do not overflow', () => {
  test('all widths 60/80/100/120 do not overflow (incl. long titles)', () => {
    const items: InboxItem[] = [
      ruleItem({ title: 'a'.repeat(200) }),
      ruleItem({ title: 'a very very very very long English goal that goes on and on - '.repeat(20), ticketId: '99' }),
      confirmItem({ title: 'short' }),
    ];
    for (const w of [60, 80, 100, 120]) {
      const out = renderInbox(items, { width: w, height: 30, selected: 0, now: NOW });
      for (const line of out) expect(visibleWidth(line), `w=${w}, line=${line}`).toBeLessThanOrEqual(w);
    }
  });
  test('narrow screen (60 cols): titles get clipped with …', () => {
    const items: InboxItem[] = [
      ruleItem({ title: 'a very very very very very long English goal'.repeat(5) }),
    ];
    const out = renderInbox(items, { width: 60, height: 30, selected: 0, now: NOW }).join('\n');
    expect(out).toContain('…');
  });
});

describe('height gate · overflow collapse', () => {
  test('items over budget → kept head + "… N more" + last 3 (footer pinned to bottom)', () => {
    const items: InboxItem[] = Array.from({ length: 20 }, (_, i) =>
      ruleItem({ ticketId: String(i), title: `r${i}` }),
    );
    const out = renderInbox(items, { width: 100, height: 8, selected: 0, now: NOW });
    expect(out.length).toBe(8);
    expect(out.join('\n')).toMatch(/… \d+ more/);
    // 末行 = footer, 含「ruling is not execution」
    expect(out[out.length - 1]).toContain('ruling is not execution');
  });
});

describe('header · per-kind counts', () => {
  test('2 awaiting rule · 1 suggested · 1 nodes · 1 unreceived', () => {
    const items: InboxItem[] = [
      ruleItem({ ticketId: '1', title: 'r1' }),
      ruleItem({ ticketId: '2', title: 'r2' }),
      confirmItem({ ticketId: '3', title: 'c1' }),
      nodeItem({ title: 'n1' }),
      takeItem({ ticketId: '4', title: 't1' }),
    ];
    const out = renderInbox(items, { width: 100, height: 30, selected: 0, now: NOW });
    const head = out[0]!;
    expect(head).toContain('inbox');
    expect(head).toContain('5 items');
    expect(head).toContain('2 awaiting rule');
    expect(head).toContain('1 suggested');
    expect(head).toContain('1 nodes');
    expect(head).toContain('1 unreceived');
  });
  test('zero counts still count as truth — only rule present: no 0 suggested / 0 nodes', () => {
    const items: InboxItem[] = [ruleItem({ ticketId: '1', title: 'r1' })];
    const out = renderInbox(items, { width: 100, height: 30, selected: 0, now: NOW });
    const head = out[0]!;
    expect(head).toContain('1 awaiting rule');
    expect(head).not.toContain('0 suggested');
    expect(head).not.toContain('0 nodes');
    expect(head).not.toContain('0 unreceived');
  });
});

/**
 * 片 5 收尾 · 四条 (SDD §2.2 钉死, 反向自检写在每条注释里)。
 *
 * 每条都是「改实现 → 这条当场红」型的反向闸: 把承重那一跳退回弱实现就红。
 * 测试不要为了变绿而放宽 —— 闸红说明实装错了。
 */
describe('★ 片 5 收尾 · 四条', () => {
  test('主行带 id (在对话里可直接引用 ticketId)', () => {
    // 反向自检: 把 `renderRow` 里 `${staleStr}${idStr} ` 段删去 → 主行只剩 title →
    // expect(body).toMatch(/▸ \? 226/) 红 (无 id)。
    const out = renderInbox([confirmItem({ ticketId: '226', title: 'machine suggestion' })], {
      width: 100, height: 30, selected: 0, now: NOW,
    }).join('\n');
    // 主行 = marker + id + title: `▸ ? 226 machine suggestion…`
    expect(out).toMatch(/▸ \? 226/);
    // node 件走 runId8/nodeId 形式
    const nodeOut = renderInbox([nodeItem({ title: 'node', runId: 'dddddddd-1111-2222-3333-444444444444', nodeId: 'e1' })], {
      width: 100, height: 30, selected: 0, now: NOW,
    }).join('\n');
    expect(nodeOut).toMatch(/· dddddddd\/e1/);
  });

  test('header separator is single-space-padded (no double-space "··" sequence)', () => {
    // 反向自检: 把 `renderHeader` 里 `${count} ` (counts.push 带 leading space) 加回 →
    // 拼出 `inbox · N items  1 awaiting rule · 1 suggested`(分隔符左右各 1 + count leading 1 = 双空格) →
    // expect(head).not.toMatch(/·  /) 红。
    const items: InboxItem[] = [
      ruleItem({ ticketId: '1', title: 'r1' }),
      confirmItem({ ticketId: '2', title: 'c1' }),
      nodeItem({ title: 'n1' }),
    ];
    const out = renderInbox(items, { width: 100, height: 30, selected: 0, now: NOW });
    const head = out[0]!;
    // 头行包含计数 (正向)
    expect(head).toContain('1 awaiting rule');
    expect(head).toContain('1 suggested');
    expect(head).toContain('1 nodes');
    // 分隔符 ` · ` 前后**各**一个空格 — 整个头行没有「· 」(双空格)串
    expect(head).not.toMatch(/·  /);
    expect(head).not.toMatch(/  ·/);
  });

  test('selected detail does not repeat the title (main row already has full title; detail keeps id + action)', () => {
    // 反向自检: 把 `renderSelectedDetail` 里 title 那行加回 (3 行: id / title / hint) →
    // expect(body.match(new RegExp(title))!).toHaveLength(1) 失败, 红。
    const title = 'a rare title string - unique anchor';
    const items: InboxItem[] = [ruleItem({ ticketId: '301', title })];
    const out = renderInbox(items, { width: 100, height: 30, selected: 0, now: NOW }).join('\n');
    // 标题恰好出现 1 次 (主行), 不在展开里再印
    const occurrences = out.split(title).length - 1;
    expect(occurrences).toBe(1);
    // 展开里仍含动作提示 (那行还在, 只是不重复标题)
    expect(out).toContain('Enter rule on-site');
  });

  test('空态不画「0 items」(NULL ≠ 0: 全空走空态分支, 不画表头)', () => {
    // 与上面 `空仓` 的检查互为反向: 这里钉的是「空态返回里**没有任何**带 0 的字节」。
    // 反向自检: 把 `if (len === 0) return [empty, footer]` 退回老实装
    // `out[0] = renderHeader(items)` → renderHeader 走 `total=0` 那条会写「0 items」 →
    // expect(body).not.toContain('0 items') 红。
    const out = renderInbox([], { width: 100, height: 30, selected: 0, now: NOW });
    const body = out.join('\n');
    expect(body).not.toContain('0 items');
    expect(body).not.toContain('inbox ·');
  });
});