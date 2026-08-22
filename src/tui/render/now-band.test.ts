/**
 * L1:「当前」区渲染器 (SDD 片 5 切片 1, 2026-08-22)。
 *
 * 钉死的 INV (见 SDD §契约):
 *   - INV-NOW-1 阶梯只选一档: 同时有 awaiting ∪ suggested 与 live → 只画 ① 等你档, live 的 runId 不出现。
 *   - INV-NOW-2 封顶 3 行, width ∈ {60,80,100,120} 各档都不超宽。
 *   - INV-NOW-3 无源恒缺席: 全空 → []。
 *   - INV-NOW-4 数据只来自真源: live=[] 时跳过 ② 档, 不画「0 在跑」; ③ 欠账当前无源, 跳过。
 *   - INV-NOW-5 纯函数: 同一输入连画两次 → 逐字节相同。
 *   - INV-5    结构信息不靠颜色: paint 恒等 → 剥标签后逐字节等。
 *
 * 反向自检 (改实现 → 这条当场红):
 *   - 「四档一选」: 把 renderNowBand 里 `awaiting.length > 0 || suggested.length > 0` 退回只看
 *     `awaiting.length > 0` → 'INV-NOW-1 bug 回归 · 只有 suggested + live 同时, 走等你档' 红。
 *   - 「无源恒缺席」: 把早返回删掉 → 'INV-NOW-3 全空 → []' 红。
 *   - 「NULL ≠ 0 (坏时戳)」: 把 fmtAge 里的 `!Number.isFinite` 删掉 → 'INV-NOW-2 等你 不超宽' 那条
 *     套娃红 (因为 Infinity 字符串会撑超宽)。
 */
import { describe, expect, test } from 'bun:test';
import { visibleWidth } from '@earendil-works/pi-tui';
import type { AttentionTicket, MapFogSummary } from '../../serve/read-api';
import { HUD_SCHEMA, type HudDagSnapshot } from '../../hud/types';
import type { DagView, DagPhase } from '../../hud/load';
import { TIER_LABEL, renderNowBand, type NowPaint } from './now-band';

const NOW = 1_700_000_000_000;

/** 最小合法 awaiting 票 (字段照 `read-api.ts:340` AttentionTicket 走)。 */
const ticket = (over: Partial<AttentionTicket> = {}): AttentionTicket => ({
  slug: 'omd-agent-tui',
  destination: 'a destination',
  ticketId: 't-9',
  title: '需要裁定的事',
  type: 'task',
  ...over,
});

/** 最小合法 map 雾档汇总 (字段照 `read-api.ts:349` MapFogSummary 走)。 */
const map = (over: Partial<MapFogSummary> = {}): MapFogSummary => ({
  slug: 'omd-agent-tui',
  destination: 'a destination',
  total: 5,
  bands: { 'awaiting-owner': 1, frontier: 2, suggested: 0 },
  phantoms: 0,
  ...over,
});

/** 最小合法 snapshot (INV-HUD-3 窄字段基线)。 */
const snap = (over: Partial<HudDagSnapshot> = {}): HudDagSnapshot => ({
  schema: HUD_SCHEMA,
  runId: 'aaaaaaaa-1111-2222-3333-444444444444',
  goal: '测试目标',
  status: 'running',
  updatedAt: new Date(0).toISOString(),
  levels: null,
  planned: [{ id: 'p1', kind: 'agent' }],
  started: [],
  startedAt: {},
  settled: [],
  ...over,
});

/** 造一个 DagView。 */
const view = (over: { snap?: HudDagSnapshot; phase?: DagPhase; ageMs?: number } = {}): DagView => ({
  snap: over.snap ?? snap(),
  phase: over.phase ?? 'live',
  ageMs: over.ageMs ?? 0,
});

/** 剥掉 paint 注入的 `<tag>...</tag>`, 返回纯文本。 */
const stripTags = (s: string): string => s.replace(/<\/?[a-z]+>/g, '');

describe('INV-NOW-3 · 无源恒缺席', () => {
  test('★ 全空 → 返回 [], 不画任何带子 (一条常驻空带子 = 训练人不看它)', () => {
    expect(renderNowBand({ awaiting: [], suggested: [], live: [], maps: [] }, { width: 80, now: NOW })).toEqual([]);
  });
});

describe('INV-NOW-1 · 阶梯只选一档', () => {
  test('同时有 awaiting、suggested、live → 只画等你档, live 的 runId 不出现, suggested 内容被吸收到计数', () => {
    const out = renderNowBand(
      {
        awaiting: [ticket({ ticketId: 't-1', title: '请你定个调' })],
        suggested: [ticket({ ticketId: 't-2', title: '建议' })],
        live: [view({ snap: snap({ runId: 'bbbbbbbb-1111-2222-3333-444444444444', goal: '在跑的活' }) })],
        maps: [map()],
      },
      { width: 100, now: NOW },
    );
    expect(out.length).toBe(1);
    const body = out.join('\n');
    // 等你档的标记 + 第一张 awaiting 票 id 都在屏上
    expect(body).toContain(TIER_MARK_FOR('awaiting'));
    expect(body).toContain('t-1');
    // suggested 折入 ① 档 — 行文里把 "其中 N 待收件" 数标出来 (新契约)
    expect(body).toContain('1 unreceived');
    // live 的 runId8 / goal 不许出现
    expect(body).not.toContain('bbbbbbbb');
    expect(body).not.toContain('在跑的活');
    // suggested[0] 的内容也不出现 (awaiting 优先, 屏上展示的是 awaiting[0])
    expect(body).not.toContain('建议');
  });

  test('awaiting 空 + suggested 空 + live 在 → 只画在跑档, 等你字形不出现', () => {
    // 注: suggested 不为空 → 走等你档 (新契约)。这条要单独验证「live 单独在」,
    // 必须 suggested 也空。
    const out = renderNowBand(
      {
        awaiting: [],
        suggested: [],
        live: [view({ snap: snap({ runId: 'bbbbbbbb-1111-2222-3333-444444444444' }) })],
        maps: [map()],
      },
      { width: 100, now: NOW },
    );
    expect(out.length).toBe(1);
    const body = out.join('\n');
    expect(body).toContain(TIER_MARK_FOR('live'));
    expect(body).toContain('bbbbbbbb');
    expect(body).not.toContain(TIER_MARK_FOR('awaiting'));
  });

  test('★ bug 回归 · 只 suggested(无 awaiting) + live 同时在 → 走等你档, 不被「在跑」埋掉', () => {
    // 反向自检: 把 renderNowBand 里 `if (input.awaiting.length > 0 || input.suggested.length > 0)`
    // 退回 `if (input.awaiting.length > 0)` (只看 awaiting, 不看 suggested) →
    // suggested 单独 + live 在时, 走到 live 那条分支 → 输出含 `▶` 与 runId →
    // expect(body).toContain(TIER_MARK_FOR('awaiting')) 红。
    // 这就是契约的硬约束: suggested 必须折入 ① 等你, 否则它会被「在跑」埋掉。
    const out = renderNowBand(
      {
        awaiting: [],
        suggested: [ticket({ ticketId: 't-sug', title: '机器建议待裁' })],
        live: [view({ snap: snap({ runId: 'cccccccc-1111-2222-3333-444444444444', goal: '后台在跑' }) })],
        maps: [map()],
      },
      { width: 100, now: NOW },
    );
    expect(out.length).toBe(1);
    const body = out.join('\n');
    // 等你档, 不是在跑
    expect(body).toContain(TIER_MARK_FOR('awaiting'));
    expect(body).not.toContain(TIER_MARK_FOR('live'));
    // suggested 那张票的 id 在屏上 (awaiting[0] ?? suggested[0] 取的是这张)
    expect(body).toContain('t-sug');
    // 「其中 1 待收件」点明这是 suggested 那类
    expect(body).toContain('1 unreceived');
    // live 的 runId8 / goal 不许出现 (被等你档盖住了)
    expect(body).not.toContain('cccccccc');
    expect(body).not.toContain('后台在跑');
    // 欠账字形 `?` 不出现 — ③ 档无源直接跳过, 不画占位
    expect(body).not.toContain(TIER_MARK_FOR('debt'));
  });

  test('awaiting 空 + live 空 + suggested 在 → 仍走等你档 (suggested 已折入 ①), 不画欠账占位', () => {
    // 老契约里这是「suggested 单独 → 走欠账档 (③)」; 新契约里 suggested 已折入 ①。
    // 反向自检: 把 renderNowBand 里 `awaiting || suggested` 退回 `awaiting` →
    // suggested 单独 + live 空 → 直接落到 ④ 闲 → 输出含 `~` →
    // expect(body).toContain(TIER_MARK_FOR('awaiting')) 红。
    const out = renderNowBand(
      {
        awaiting: [],
        suggested: [ticket({ ticketId: 't-2', title: '建议一件事' })],
        live: [],
        maps: [map()],
      },
      { width: 100, now: NOW },
    );
    expect(out.length).toBe(1);
    const body = out.join('\n');
    // 走等你档 — ⚠ + 等你 + 「其中 N 待收件」
    expect(body).toContain(TIER_MARK_FOR('awaiting'));
    expect(body).toContain(TIER_LABEL.awaiting);
    expect(body).toContain('1 unreceived');
    expect(body).toContain('t-2');
    // ③ 欠账档 (debt) 不画 — 字形与字面值都不出现
    expect(body).not.toContain(TIER_MARK_FOR('debt'));
    expect(body).not.toContain(TIER_LABEL.debt);
    // ④ 闲也不画 — 等你档已选中
    expect(body).not.toContain(TIER_MARK_FOR('maps'));
  });

  test('只有 maps → 只画闲', () => {
    const out = renderNowBand(
      { awaiting: [], suggested: [], live: [], maps: [map({ total: 3, bands: { frontier: 2 } })] },
      { width: 100, now: NOW },
    );
    expect(out.length).toBe(1);
    const body = out.join('\n');
    expect(body).toContain(TIER_MARK_FOR('maps'));
    expect(body).toContain('1 runs');
    expect(body).not.toContain(TIER_MARK_FOR('awaiting'));
  });
});

describe('INV-NOW-4 · 数据只来自真源, 取不到就跳过那一档', () => {
  test('live 空 + ①档空 → 跳过「在跑」, ③ 欠账无源跳过, 落到「闲」', () => {
    // ③ 欠账目前无源, 阶梯直接跳过 → 落到 ④ 闲。空仓的真话是「没有等你裁的票,
    // 没有活图, 但有几张存图」。
    const out = renderNowBand(
      {
        awaiting: [],
        suggested: [],
        live: [], // ← 关键, 不画「0 在跑」
        maps: [map()],
      },
      { width: 100, now: NOW },
    );
    const body = out.join('\n');
    // 落到闲档
    expect(body).toContain(TIER_MARK_FOR('maps'));
    expect(body).toContain('1 runs');
    // 关键: 不画「0 在跑」/「0 run」这种东西 (INV-NOW-4: NULL ≠ 0)
    expect(body).not.toMatch(/\b0 在跑\b/);
    expect(body).not.toMatch(/\b0 runs?\b/);
    // ③ 档不画占位 (无源就空)
    expect(body).not.toContain(TIER_MARK_FOR('debt'));
    expect(body).not.toContain(TIER_LABEL.debt);
  });
});

describe('INV-NOW-2 · 封顶 3 行, 宽度闸', () => {
  test('各档 × width ∈ {60, 80, 100, 120} 每行 visibleWidth(line) <= width', () => {
    const inputs = [
      // 等你 (awaiting + suggested 都有, 验新折叠行文 + 宽度)
      {
        awaiting: [
          ticket({ ticketId: 't-1', title: '需要裁定的事情 — '.repeat(30) }),
          ticket({ ticketId: 't-2', title: '还有一件' }),
        ],
        suggested: [ticket({ ticketId: 't-3', title: '机器建议 — '.repeat(15) })],
        live: [], maps: [],
      },
      // 在跑 (含坏时戳 / 长 goal / 多 run)
      {
        awaiting: [], suggested: [],
        live: [
          view({ snap: snap({ runId: 'aaaaaaaa-1111-2222-3333-444444444444', goal: 'a'.repeat(200) }), ageMs: Infinity }),
          view({ snap: snap({ runId: 'bbbbbbbb-1111-2222-3333-444444444444', goal: '一个特别特别长的中文目标 — '.repeat(20) }), ageMs: 4_000 }),
        ],
        maps: [],
      },
      // suggested 单独 (走等你档, 长 title 也走宽度闸)
      { awaiting: [], suggested: [ticket({ ticketId: 't-4', title: '建议: '.repeat(40) })], live: [], maps: [] },
      // 闲 (含 bands 全 0 的边角)
      {
        awaiting: [], suggested: [], live: [],
        maps: [
          map({ total: 0, bands: {}, phantoms: 0 }),
          map({ slug: 'omd-2', total: 1, bands: { 'awaiting-owner': 1 }, phantoms: 0 }),
        ],
      },
    ];
    for (let i = 0; i < inputs.length; i++) {
      for (const w of [60, 80, 100, 120]) {
        const out = renderNowBand(inputs[i]!, { width: w, now: NOW });
        // ≤ 3 行
        expect(out.length, `case=${i}, w=${w}`).toBeLessThanOrEqual(3);
        // 每行不超宽
        for (const line of out) {
          expect(visibleWidth(line), `case=${i}, w=${w}, line=${JSON.stringify(line)}`).toBeLessThanOrEqual(w);
        }
      }
    }
  });

  test('窄屏 (60) 下右半被截 (goal / title 走 ...), 左半的读数保留', () => {
    const out = renderNowBand(
      {
        awaiting: [ticket({ ticketId: 't-1', title: '一个特别特别长的中文目标 — '.repeat(10) })],
        suggested: [ticket({ ticketId: 't-2', title: '短' })],
        live: [], maps: [],
      },
      { width: 60, now: NOW },
    ).join('\n');
    // id 在屏上 (读数保留)
    expect(out).toContain('t-1');
    // 超长 title 被截: 含 ...
    expect(out).toContain('...');
    // 「其中 1 待收件」窄屏下也得在屏上 (这条是 suggested 折入 ① 的契约硬钉)
    expect(out).toContain('1 unreceived');
  });
});

describe('INV-5 · 结构信息不靠颜色', () => {
  test('paint 恒等 → 剥标签后逐字节等 (各档标记 + 标签肉眼可读)', () => {
    const tag = (n: string) => (s: string) => `<${n}>${s}</${n}>`;
    const paint: NowPaint = { accent: tag('a'), dim: tag('d'), warn: tag('w'), ok: tag('ok') };
    const cases = [
      // 等你 (awaiting)
      { awaiting: [ticket({ ticketId: 't-1', title: '裁定' })], suggested: [], live: [], maps: [] },
      // 在跑
      { awaiting: [], suggested: [], live: [view()], maps: [] },
      // 等你 (suggested 单独 → 折入 ①)
      { awaiting: [], suggested: [ticket()], live: [], maps: [] },
      // 闲
      { awaiting: [], suggested: [], live: [], maps: [map()] },
    ];
    for (const input of cases) {
      const tagged = renderNowBand(input, { width: 100, now: NOW, paint });
      const plain = renderNowBand(input, { width: 100, now: NOW });
      expect(tagged.map(stripTags).join('\n'), JSON.stringify(input)).toBe(plain.join('\n'));
    }
  });

  test('实际可绘的各档前缀字形 + 文字标签都在屏上 (剥标签后逐字节存在)', () => {
    // ③ 欠账档当前无源 — 没输入能触发它, 不在画字面这一层测。
    // 字面值 (`TIER_LABEL.debt` / `TIER_MARK.debt`) 仍挂在导出表里, 是为
    // 4 档一选的契约与未来 CheckpointManager 接真读数时直接复用, 由类型层保证。
    const cases: Array<{ tier: 'awaiting' | 'live' | 'maps'; input: Parameters<typeof renderNowBand>[0] }> = [
      { tier: 'awaiting', input: { awaiting: [ticket()], suggested: [], live: [], maps: [] } },
      { tier: 'live', input: { awaiting: [], suggested: [], live: [view()], maps: [] } },
      { tier: 'maps', input: { awaiting: [], suggested: [], live: [], maps: [map()] } },
    ];
    for (const { tier, input } of cases) {
      const out = renderNowBand(input, { width: 100, now: NOW }).join('\n');
      expect(out, tier).toContain(TIER_MARK_FOR(tier));
      expect(out, tier).toContain(TIER_LABEL[tier]);
    }
  });
});

describe('INV-NOW-5 · 纯函数, 同一输入两次输出逐字节相同', () => {
  test('连画两次 → []、行数、行内容都一致', () => {
    const input = { awaiting: [ticket()], suggested: [ticket()], live: [view()], maps: [map()] };
    const a = renderNowBand(input, { width: 80, now: NOW });
    const b = renderNowBand(input, { width: 80, now: NOW });
    expect(b).toEqual(a);
    // 还要逐字节 (上面已经靠 toEqual 满足, 多一道断言钉死 future drift)。
    expect(b.join('\n')).toBe(a.join('\n'));
  });

  test('不读盘 —— 不接受 cwd / fs 字段 (签名稳定性)', () => {
    // 类型层已由 NowBandInput 锁住 (无 cwd 字段), 这里是文档化的回环测试。
    const input: Parameters<typeof renderNowBand>[0] = { awaiting: [], suggested: [], live: [], maps: [] };
    expect(input).not.toHaveProperty('cwd');
    expect(input).not.toHaveProperty('fs');
  });
});

describe('细节 · 多条等你 / 在跑 / 闲档', () => {
  test('等你 ≥2 (纯 awaiting) → 头里出现计数 (N 票), 第一张的 id 在屏上', () => {
    const out = renderNowBand(
      {
        awaiting: [
          ticket({ ticketId: 't-1', title: '第一件' }),
          ticket({ ticketId: 't-2', title: '第二件' }),
        ],
        suggested: [], live: [], maps: [],
      },
      { width: 100, now: NOW },
    ).join('\n');
    expect(out).toMatch(/needs you:2 tickets/);
    expect(out).toContain('t-1');
  });

  test('等你 = awaiting+suggested 混合 → 头里标 N 票 (其中 M 待收件), 第一张 awaiting id 在屏上', () => {
    const out = renderNowBand(
      {
        awaiting: [ticket({ ticketId: 't-1', title: '第一件' })],
        suggested: [ticket({ ticketId: 't-2', title: '建议' })],
        live: [], maps: [],
      },
      { width: 100, now: NOW },
    ).join('\n');
    expect(out).toContain('2 tickets');
    expect(out).toContain('1 unreceived');
    expect(out).toContain('t-1');
    // 屏上展示的是 awaiting[0] (优先级最高), suggested[0] 不展开
    expect(out).not.toContain('建议');
  });

  test('在跑 ≥2 → 头里出现计数 (N), 第一条的 runId8 在屏上', () => {
    const out = renderNowBand(
      {
        awaiting: [], suggested: [],
        live: [
          view({ snap: snap({ runId: 'aaaaaaaa-1111-2222-3333-444444444444' }) }),
          view({ snap: snap({ runId: 'bbbbbbbb-1111-2222-3333-444444444444' }) }),
        ],
        maps: [],
      },
      { width: 100, now: NOW },
    ).join('\n');
    expect(out).toMatch(/running:2/);
    expect(out).toContain('aaaaaaaa');
  });

  test('坏时戳 (ageMs = Infinity) → 在跑那行含「start not recorded」, 不画 Infinity / 0m', () => {
    const out = renderNowBand(
      {
        awaiting: [], suggested: [],
        live: [view({ ageMs: Infinity })],
        maps: [],
      },
      { width: 100, now: NOW },
    ).join('\n');
    expect(out).toContain('start not recorded');
    expect(out).not.toContain('Infinity');
    expect(out).not.toMatch(/\b0m\b/);
  });

  test('老快照空 planned → 在跑那行进度列画「—/—」, 不画 0/0', () => {
    const out = renderNowBand(
      {
        awaiting: [], suggested: [],
        live: [view({ snap: snap({ planned: [], started: [] }) })],
        maps: [],
      },
      { width: 100, now: NOW },
    ).join('\n');
    expect(out).toContain('—/—');
    expect(out).not.toMatch(/\b0\/0\b/);
  });

  test('闲档 · bands 全空 → 仍画计数与 phantoms (NULL ≠ 0: 全 0 是真值)', () => {
    const out = renderNowBand(
      { awaiting: [], suggested: [], live: [], maps: [map({ total: 1, bands: {}, phantoms: 0 })] },
      { width: 100, now: NOW },
    ).join('\n');
    expect(out).toContain('1 runs');
    expect(out).toContain('phantoms:0');
  });

  test('闲档 · 多张图 → 第一张的 bands 列出来, 其余折叠到 +N', () => {
    const out = renderNowBand(
      {
        awaiting: [], suggested: [], live: [],
        maps: [
          map({ total: 5, bands: { frontier: 2 } }),
          map({ slug: 'omd-2', total: 3, bands: { 'awaiting-owner': 1 } }),
          map({ slug: 'omd-3', total: 1, bands: {} }),
        ],
      },
      { width: 100, now: NOW },
    ).join('\n');
    expect(out).toContain('3 runs');
    expect(out).toContain('frontier:2');
    expect(out).toContain('+2');
  });
});

/* 测试内部用: 取四档的字形, 不用从 now-band 导出 (那样就反向绑死了)。
 * 与 run-list.test 钉 RUN_MARK 同一种纪律。 */
function TIER_MARK_FOR(tier: keyof typeof TIER_LABEL): string {
  switch (tier) {
    case 'awaiting': return '⚠';
    case 'live': return '▶';
    case 'debt': return '?';
    case 'maps': return '~';
  }
}