/**
 * L1:「当前」区渲染器 (SDD 片 5 切片 1, 2026-08-22)。
 *
 * 钉死的 INV (见 SDD §契约):
 *   - INV-NOW-1 阶梯只选一档: 同时有 awaiting 与 live → 只画 awaiting, live 的 runId 不出现。
 *   - INV-NOW-2 封顶 3 行, width ∈ {60,80,120} 各档都不超宽。
 *   - INV-NOW-3 无源恒缺席: 全空 → []。
 *   - INV-NOW-4 数据只来自真源: live=[] 时跳过 ② 档, 不画「0 在跑」。
 *   - INV-NOW-5 纯函数: 同一输入连画两次 → 逐字节相同。
 *   - INV-5    结构信息不靠颜色: paint 恒等 → 剥标签后逐字节等。
 *
 * 反向自检 (改实现 → 这条当场红):
 *   - 「四档一选」: 把 renderNowBand 里 awaiting 那条早返回删掉 → 'INV-NOW-1 awaiting 优先' 红。
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
  test('同时有 awaiting 与 live → 只画等你, live 的 runId 不出现', () => {
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
    // 等你那一档的标记 + 第一张票 id 都在屏上
    expect(body).toContain(TIER_MARK_FOR('awaiting'));
    expect(body).toContain('t-1');
    // live 的 runId8 / goal 不许出现
    expect(body).not.toContain('bbbbbbbb');
    expect(body).not.toContain('在跑的活');
    // suggested 的内容也不许出现 (阶梯还在更高一档)
    expect(body).not.toContain('建议');
  });

  test('awaiting 空 + live 在 → 只画在跑, 等你的字形不出现', () => {
    const out = renderNowBand(
      {
        awaiting: [],
        suggested: [ticket()],
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
    expect(body).not.toContain(TIER_MARK_FOR('suggested'));
  });

  test('awaiting 空 + live 空 + suggested 在 → 只画欠账', () => {
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
    expect(body).toContain(TIER_MARK_FOR('suggested'));
    expect(body).toContain('t-2');
    expect(body).not.toContain(TIER_MARK_FOR('awaiting'));
    expect(body).not.toContain(TIER_MARK_FOR('live'));
  });

  test('只有 maps → 只画闲', () => {
    const out = renderNowBand(
      { awaiting: [], suggested: [], live: [], maps: [map({ total: 3, bands: { frontier: 2 } })] },
      { width: 100, now: NOW },
    );
    expect(out.length).toBe(1);
    const body = out.join('\n');
    expect(body).toContain(TIER_MARK_FOR('maps'));
    expect(body).toContain('1 张图');
    expect(body).not.toContain(TIER_MARK_FOR('awaiting'));
  });
});

describe('INV-NOW-4 · 数据只来自真源, 取不到就跳过那一档', () => {
  test('live 空 → 跳过「在跑」, 落到下一档 (suggested)', () => {
    const out = renderNowBand(
      {
        awaiting: [],
        suggested: [ticket()],
        live: [], // ← 关键, 不画「0 在跑」
        maps: [map()],
      },
      { width: 100, now: NOW },
    );
    const body = out.join('\n');
    expect(body).toContain(TIER_MARK_FOR('suggested'));
    // 关键: 不画「0 在跑」/「0 run」这种东西
    expect(body).not.toMatch(/\b0 在跑\b/);
    expect(body).not.toMatch(/\b0 runs?\b/);
  });
});

describe('INV-NOW-2 · 封顶 3 行, 宽度闸', () => {
  test('各档 × width ∈ {60, 80, 120} 每行 visibleWidth(line) <= width', () => {
    const inputs = [
      // 等你
      {
        awaiting: [
          ticket({ ticketId: 't-1', title: '需要裁定的事情 — '.repeat(30) }),
          ticket({ ticketId: 't-2', title: '还有一件' }),
        ],
        suggested: [], live: [], maps: [],
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
      // 欠账
      { awaiting: [], suggested: [ticket({ ticketId: 't-3', title: '建议: '.repeat(40) })], live: [], maps: [] },
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
      for (const w of [60, 80, 120]) {
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
        suggested: [], live: [], maps: [],
      },
      { width: 60, now: NOW },
    ).join('\n');
    // id 在屏上 (读数保留)
    expect(out).toContain('t-1');
    // 超长 title 被截: 含 ...
    expect(out).toContain('...');
  });
});

describe('INV-5 · 结构信息不靠颜色', () => {
  test('paint 恒等 → 剥标签后逐字节等 (四档各自标记 + 标签肉眼可读)', () => {
    const tag = (n: string) => (s: string) => `<${n}>${s}</${n}>`;
    const paint: NowPaint = { accent: tag('a'), dim: tag('d'), warn: tag('w'), ok: tag('ok') };
    const cases = [
      // 等你
      { awaiting: [ticket({ ticketId: 't-1', title: '裁定' })], suggested: [], live: [], maps: [] },
      // 在跑
      { awaiting: [], suggested: [], live: [view()], maps: [] },
      // 欠账
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

  test('四档各自的前缀字形 + 文字标签都在屏上 (剥标签后逐字节存在)', () => {
    const cases: Array<{ tier: keyof typeof TIER_LABEL; input: Parameters<typeof renderNowBand>[0] }> = [
      { tier: 'awaiting', input: { awaiting: [ticket()], suggested: [], live: [], maps: [] } },
      { tier: 'live', input: { awaiting: [], suggested: [], live: [view()], maps: [] } },
      { tier: 'suggested', input: { awaiting: [], suggested: [ticket()], live: [], maps: [] } },
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
    const input = { awaiting: [ticket()], suggested: [], live: [view()], maps: [map()] };
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
  test('等你 ≥2 → 头里出现计数 (N 票), 第一张的 id 在屏上', () => {
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
    expect(out).toMatch(/等你:2 票/);
    expect(out).toContain('t-1');
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
    expect(out).toMatch(/在跑:2/);
    expect(out).toContain('aaaaaaaa');
  });

  test('坏时戳 (ageMs = Infinity) → 在跑那行含「起点未记」, 不画 Infinity / 0m', () => {
    const out = renderNowBand(
      {
        awaiting: [], suggested: [],
        live: [view({ ageMs: Infinity })],
        maps: [],
      },
      { width: 100, now: NOW },
    ).join('\n');
    expect(out).toContain('起点未记');
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
    expect(out).toContain('1 张图');
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
    expect(out).toContain('3 张图');
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
    case 'suggested': return '?';
    case 'maps': return '~';
  }
}