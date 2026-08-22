/**
 * L1:收件箱渲染器 (SDD 片 5 切片 2)。
 *
 * 钉死的 INV (见 SDD §契约):
 *   - INV-INBOX-1 底边含「裁决不等于执行」与「map_deliver」 (任何 items 都有时)。
 *   - INV-INBOX-2 底边含「ruling」与「goal」 (同上)。
 *   - INV-INBOX-3 confirm 选中展开 → 含 `c` + `收件`, 且**不含** `Enter 就地裁`
 *     (`pathfinder.ts:503` 是硬闸, 画错这一格 = 教人去撞)。
 *   - INV-INBOX-4 渲染层**不**调 MCP —— 这一片不验「输入框预填」(那是接线片的活),
 *     验的是「选中展开里出现 Enter 预填 / c 收件 / x 退回 这套字面」(二段确认的字面)。
 *   - INV-5 结构信息不靠颜色: 选中 `▸`, stale `✗ STALE`, 等你 `⚠`; 关色下可读,
 *     paint 恒等 → 剥标签逐字节等。
 *   - 纯函数 (INV-NOW-5 同款): 同一输入连画两次逐字节等。
 *   - 宽度闸: 每行 `visibleWidth(line) <= width`, 含 CJK。
 *   - 高度闸: 超出 → 头 kept + 「… N more」 + 尾 3 (footer 贴底)。
 *
 * 反向自检 (改实现 → 这条当场红):
 *   - 「INV-INBOX-1 底边」: 把 renderFooter 里 `map_deliver` 改成 `path_deliver` → 'map_deliver 在底边' 红。
 *   - 「INV-INBOX-3 confirm 不含 Enter 就地裁」: 在 confirm 的 detail 里加 `Enter 就地裁` → 'confirm 不含 Enter 就地裁' 红。
 *   - 「INV-5 stale 文字 (不靠颜色)」: 把 STALE_TXT 改成只发 ANSI warn → 'stale 显 ✗ STALE 文字' 红 (剥标签后丢字)。
 *   - 「INV-5 paint 恒等 → 剥标签等」: 把 rowLine 的 `p.sel(fitLine(...))` 改成 `fitLine(p.sel(...))` →
 *     选中行 fitLine 入口是已经加了 sel 标签的串, 标签宽度被算进去, 关色版被压窄 → 剥标签后逐字不等。
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
  title: 'rule 默认标题',
  ...over,
});
const confirmItem = (
  over: Partial<Extract<InboxItem, { kind: 'confirm' }>> = {},
): InboxItem => ({
  kind: 'confirm',
  slug: 'demo',
  ticketId: '188',
  title: 'confirm 默认标题',
  ...over,
});
const nodeItem = (over: Partial<Extract<InboxItem, { kind: 'node' }>> = {}): InboxItem => ({
  kind: 'node',
  runId: 'aaaaaaaa-1111-2222-3333-444444444444',
  nodeId: 'e1',
  title: 'node 默认标题',
  ...over,
});
const takeItem = (over: Partial<Extract<InboxItem, { kind: 'take' }>> = {}): InboxItem => ({
  kind: 'take',
  slug: 'demo',
  ticketId: '200',
  title: 'take 默认标题',
  ...over,
});

describe('INV-INBOX-1 · 底边常驻「裁决不等于执行 + map_deliver」', () => {
  test('有任意一件时, 底边含「裁决不等于执行」与「map_deliver」', () => {
    const out = renderInbox([ruleItem()], { width: 80, height: 30, selected: 0, now: NOW });
    const last = out[out.length - 1]!;
    expect(last).toContain('裁决不等于执行');
    expect(last).toContain('map_deliver');
  });
  test('空仓也念 —— 教育性 invariant, 屏开了就要看见', () => {
    const out = renderInbox([], { width: 80, height: 30, selected: 0, now: NOW });
    const last = out[out.length - 1]!;
    expect(last).toContain('裁决不等于执行');
    expect(last).toContain('map_deliver');
  });
  test('四类件都有时, 底边依然在 (invariant 与 items 解耦)', () => {
    const items: InboxItem[] = [ruleItem(), confirmItem(), nodeItem(), takeItem()];
    const out = renderInbox(items, { width: 80, height: 30, selected: 0, now: NOW });
    expect(out[out.length - 1]).toContain('裁决不等于执行');
    expect(out[out.length - 1]).toContain('map_deliver');
  });
});

describe('INV-INBOX-2 · 底边常驻「ruling + goal」', () => {
  test('底边含 ruling 与 goal 两词 (ruling 即 goal 是设计语义)', () => {
    const out = renderInbox([ruleItem()], { width: 80, height: 30, selected: 0, now: NOW });
    const last = out[out.length - 1]!;
    expect(last).toContain('ruling');
    expect(last).toContain('goal');
  });
});

describe('INV-INBOX-3 · confirm 不能含「Enter 就地裁」', () => {
  test('confirm 选中 → 展开含 c + 收件, 不含 Enter 就地裁', () => {
    const out = renderInbox([confirmItem()], { width: 80, height: 30, selected: 0, now: NOW });
    const body = out.join('\n');
    expect(body).toContain('c ');
    expect(body).toContain('收件');
    // 硬闸 —— 给 confirm 配「Enter 就地裁」 = 教人去撞 pathfinder.ts:503
    expect(body).not.toMatch(/Enter 就地裁/);
  });
  test('rule 选中 → 展开**可以**含「Enter 就地裁」 (那是它的合法动作)', () => {
    const out = renderInbox([ruleItem()], { width: 80, height: 30, selected: 0, now: NOW });
    expect(out.join('\n')).toContain('Enter 就地裁');
  });
  test('confirm 与 rule 混排, confirm 那段不含 Enter 就地裁, rule 那段含', () => {
    const items: InboxItem[] = [confirmItem({ ticketId: '188', title: '建议' }), ruleItem({ ticketId: '177', title: '要裁' })];
    // 选中 confirm: 仅 detail 区有 c 收件, 没有 Enter 就地裁。
    const outConf = renderInbox(items, { width: 100, height: 30, selected: 0, now: NOW }).join('\n');
    expect(outConf).toContain('c 收件');
    expect(outConf).not.toMatch(/Enter 就地裁/);
    // 选中 rule: detail 区有 Enter 就地裁, 不出现 c 收件 (那是 confirm 的动作)。
    const outRule = renderInbox(items, { width: 100, height: 30, selected: 1, now: NOW }).join('\n');
    expect(outRule).toContain('Enter 就地裁');
    expect(outRule).not.toContain('c 收件');
  });
  test('四态各画各的动作 —— node / take 各自独立的 hint', () => {
    const items: InboxItem[] = [nodeItem(), takeItem()];
    // 选中 node (i=0)
    const outNode = renderInbox(items, { width: 100, height: 30, selected: 0, now: NOW }).join('\n');
    expect(outNode).toContain('Enter 进图');
    // 选中 take (i=1)
    const outTake = renderInbox(items, { width: 100, height: 30, selected: 1, now: NOW }).join('\n');
    expect(outTake).toContain('Enter 收件');
  });
});

describe('INV-INBOX-4 · 渲染层不调 MCP —— Enter 预填不发送的字面', () => {
  test('底边明确说「Enter 预填不发送」', () => {
    const out = renderInbox([ruleItem()], { width: 80, height: 30, selected: 0, now: NOW });
    const last = out[out.length - 1]!;
    expect(last).toContain('预填不发送');
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

  test('★ stale 项显 ✗ STALE 文字 (剥标签后还在 —— 不是颜色信息)', () => {
    const out = renderInbox([ruleItem({ stale: true, title: '已过期' })], {
      width: 100,
      height: 30,
      selected: 0,
      now: NOW,
    });
    const plain = stripTags(out.join('\n'));
    expect(plain).toContain('✗ STALE');
    // 不靠颜色: 显式 paint 也得见字
    const tag = (n: string) => (s: string) => `<${n}>${s}</${n}>`;
    const paint = { accent: tag('a'), dim: tag('d'), warn: tag('w'), sel: tag('s') };
    const tagged = renderInbox([ruleItem({ stale: true, title: '已过期' })], {
      width: 100,
      height: 30,
      selected: 0,
      now: NOW,
      paint,
    });
    expect(stripTags(tagged.join('\n'))).toContain('✗ STALE');
  });

  test('paint 恒等 → 剥标签后逐字节等 (不靠颜色携带信息)', () => {
    const tag = (n: string) => (s: string) => `<${n}>${s}</${n}>`;
    const paint = { accent: tag('a'), dim: tag('d'), warn: tag('w'), sel: tag('s') };
    // ⚠ 这里用 200 列而不是 100: <tag> 字面也是可见列 (visibleWidth 不认它当 ANSI),
    //   100 列下头行先撞宽, tagged 版被 truncateToWidth 截出 [0m..., 与 plain 不再字字等。
    //   200 列足够装下 tagged 与 plain 两版, 这条闸就能干净地验「颜色不携带信息」。
    const items: InboxItem[] = [
      ruleItem({ title: 'rule 件' }),
      confirmItem({ title: '建议件' }),
      nodeItem({ title: '节点件' }),
      takeItem({ title: '待收件' }),
    ];
    const tagged = renderInbox(items, { width: 200, height: 30, selected: 1, now: NOW, paint });
    const plain = renderInbox(items, { width: 200, height: 30, selected: 1, now: NOW });
    expect(tagged.map(stripTags).join('\n')).toBe(plain.join('\n'));
  });

  test('paint 钩子: 选中行整行 sel; 非选中 marker 走相位色', () => {
    const tag = (n: string) => (s: string) => `<${n}>${s}</${n}>`;
    const paint = { accent: tag('a'), dim: tag('d'), warn: tag('w'), sel: tag('s') };
    const items: InboxItem[] = [
      ruleItem({ title: 'rule' }),
      confirmItem({ title: '建议' }),
      nodeItem({ title: '节点' }),
    ];
    const out = renderInbox(items, { width: 100, height: 30, selected: 1, now: NOW, paint }).join('\n');
    // 选中行 (i=1, confirm) 整行 sel 通道包外: <s>▸ ? ...</s>
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

describe('空仓', () => {
  // 反向自检: 把 `if (len === 0) { return [empty, footer] }` 退回老实装 `out[0] = renderHeader(...)` →
  // 空仓头行含「收件箱」+「0 件」 → expect(out[0]).not.toContain('0 件') 红, expect(out.join('\n')).not.toContain('0 件') 红。
  test('空 items → 那句真话 + 底边, 不画「收件箱 · 0 件」表头', () => {
    const out = renderInbox([], { width: 80, height: 30, selected: 0, now: NOW });
    const body = out.join('\n');
    // 首行是那句真话, 不是表头
    expect(out[0]).toContain('(空');
    expect(out[0]).not.toContain('收件箱');
    // 不画「0 件」(「画 0」是噪音, NULL ≠ 0: 全空走空态分支)
    expect(body).not.toContain('0 件');
    expect(body).not.toMatch(/\b0 /);
    // 底边还在 (INV-INBOX-1/2)
    expect(out[out.length - 1]).toContain('裁决不等于执行');
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

describe('宽度闸 · 行不超宽', () => {
  test('各列在 60/80/100/120 列下都不超 (含 CJK, 含主行新加 id 列)', () => {
    const items: InboxItem[] = [
      ruleItem({ title: 'a'.repeat(200) }),
      ruleItem({ title: '一个特别特别长的中文目标 — '.repeat(20), ticketId: '99' }),
      confirmItem({ title: '短' }),
    ];
    for (const w of [60, 80, 100, 120]) {
      const out = renderInbox(items, { width: w, height: 30, selected: 0, now: NOW });
      for (const line of out) expect(visibleWidth(line), `w=${w}, line=${line}`).toBeLessThanOrEqual(w);
    }
  });
  test('窄屏 (60 列) 下标题被截, 截断补 …', () => {
    const items: InboxItem[] = [
      ruleItem({ title: '一个特别特别长的中文目标'.repeat(5) }),
    ];
    const out = renderInbox(items, { width: 60, height: 30, selected: 0, now: NOW }).join('\n');
    expect(out).toContain('…');
  });
});

describe('高度闸 · 超出折叠', () => {
  test('items 多于预算 → 头 kept + 「… N more」 + 尾 3 (footer 贴底)', () => {
    const items: InboxItem[] = Array.from({ length: 20 }, (_, i) =>
      ruleItem({ ticketId: String(i), title: `r${i}` }),
    );
    const out = renderInbox(items, { width: 100, height: 8, selected: 0, now: NOW });
    expect(out.length).toBe(8);
    expect(out.join('\n')).toMatch(/… \d+ more/);
    // 末行 = footer, 含「裁决不等于执行」
    expect(out[out.length - 1]).toContain('裁决不等于执行');
  });
});

describe('头行 · 按 kind 分计', () => {
  test('2 等裁 · 1 建议 · 1 节点 · 1 待收', () => {
    const items: InboxItem[] = [
      ruleItem({ ticketId: '1', title: 'r1' }),
      ruleItem({ ticketId: '2', title: 'r2' }),
      confirmItem({ ticketId: '3', title: 'c1' }),
      nodeItem({ title: 'n1' }),
      takeItem({ ticketId: '4', title: 't1' }),
    ];
    const out = renderInbox(items, { width: 100, height: 30, selected: 0, now: NOW });
    const head = out[0]!;
    expect(head).toContain('收件箱');
    expect(head).toContain('5 件');
    expect(head).toContain('2 等裁');
    expect(head).toContain('1 建议');
    expect(head).toContain('1 节点');
    expect(head).toContain('1 待收');
  });
  test('零计数也算真值 —— 只有 rule 时, 不画 0 建议 / 0 节点', () => {
    const items: InboxItem[] = [ruleItem({ ticketId: '1', title: 'r1' })];
    const out = renderInbox(items, { width: 100, height: 30, selected: 0, now: NOW });
    const head = out[0]!;
    expect(head).toContain('1 等裁');
    expect(head).not.toContain('0 建议');
    expect(head).not.toContain('0 节点');
    expect(head).not.toContain('0 待收');
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
    const out = renderInbox([confirmItem({ ticketId: '226', title: '机器建议' })], {
      width: 100, height: 30, selected: 0, now: NOW,
    }).join('\n');
    // 主行 = marker + id + title: `▸ ? 226 机器建议…`
    expect(out).toMatch(/▸ \? 226/);
    // node 件走 runId8/nodeId 形式
    const nodeOut = renderInbox([nodeItem({ title: '节点', runId: 'dddddddd-1111-2222-3333-444444444444', nodeId: 'e1' })], {
      width: 100, height: 30, selected: 0, now: NOW,
    }).join('\n');
    expect(nodeOut).toMatch(/· dddddddd\/e1/);
  });

  test('表头分隔符前后单空格 (无双空格 ·· 串)', () => {
    // 反向自检: 把 `renderHeader` 里 `${count} ` (counts.push 带 leading space) 加回 →
    // 拼出 `收件箱 · N 件  1 等裁 · 1 建议`(分隔符左右各 1 + count leading 1 = 双空格) →
    // expect(head).not.toMatch(/·  /) 红。
    const items: InboxItem[] = [
      ruleItem({ ticketId: '1', title: 'r1' }),
      confirmItem({ ticketId: '2', title: 'c1' }),
      nodeItem({ title: 'n1' }),
    ];
    const out = renderInbox(items, { width: 100, height: 30, selected: 0, now: NOW });
    const head = out[0]!;
    // 头行包含计数 (正向)
    expect(head).toContain('1 等裁');
    expect(head).toContain('1 建议');
    expect(head).toContain('1 节点');
    // 分隔符 ` · ` 前后**各**一个空格 — 整个头行没有「· 」(双空格)串
    expect(head).not.toMatch(/·  /);
    expect(head).not.toMatch(/  ·/);
  });

  test('选中展开不重复标题 (主行已是全标题, 展开只留 id + 动作)', () => {
    // 反向自检: 把 `renderSelectedDetail` 里 title 那行加回 (3 行: id / title / hint) →
    // expect(body.match(new RegExp(title))!).toHaveLength(1) 失败, 红。
    const title = '一个不太常见的标题串 — 唯一锚点';
    const items: InboxItem[] = [ruleItem({ ticketId: '301', title })];
    const out = renderInbox(items, { width: 100, height: 30, selected: 0, now: NOW }).join('\n');
    // 标题恰好出现 1 次 (主行), 不在展开里再印
    const occurrences = out.split(title).length - 1;
    expect(occurrences).toBe(1);
    // 展开里仍含动作提示 (那行还在, 只是不重复标题)
    expect(out).toContain('Enter 就地裁');
  });

  test('空态不画「0 件」(NULL ≠ 0: 全空走空态分支, 不画表头)', () => {
    // 与上面 `空仓` 的检查互为反向: 这里钉的是「空态返回里**没有任何**带 0 的字节」。
    // 反向自检: 把 `if (len === 0) return [empty, footer]` 退回老实装
    // `out[0] = renderHeader(items)` → renderHeader 走 `total=0` 那条会写「0 件」 →
    // expect(body).not.toContain('0 件') 红。
    const out = renderInbox([], { width: 100, height: 30, selected: 0, now: NOW });
    const body = out.join('\n');
    expect(body).not.toContain('0 件');
    expect(body).not.toContain('收件箱 ·');
  });
});