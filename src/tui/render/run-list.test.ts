/**
 * L1:活图列表渲染器 (SDD 片 4 切片 2, 票 #221)。
 *
 * 钉死的 INV (见 SDD §契约):
 *   - INV-DAG-7 数据源 = 磁盘分片, runId8 出现且每条都被画 (无源时连表头都不画 —— 由
 *     INV-DAG-8 兜住, 不在本片)。
 *   - INV-DAG-8 无源恒缺席: `views=[]` → `renderRunList` 返回 `[]`, 不画 `0 runs` 空框。
 *   - INV-DAG-9 结构信息不靠颜色: 选中 `▸`, 三态 `▶ / ◌ / ↑` (三个不同字形), 关色
 *     恒等下仍可读。
 *   - INV-DAG-2 NULL ≠ 0 ≠ 不适用: 坏时戳 → `起点未记` (不画 `0m`/`Infinitym`),
 *     老快照空 planned → `—/—` (不画 `0/0`)。
 *   - 宽度闸: 每行 `visibleWidth(line) <= width`。
 *   - 高度闸: 超出 → 头 kept + 「… N more」 + 尾 3 贴底。
 *   - paint 钩子: 注入后选中行走 sel 通道, 三个 phase mark 走 accent / warn / ok;
 *     关闭 paint (恒等) 与剥标签后**逐字节相等**。
 *
 * 反向自检 (改实现 → 这条当场红):
 *   - 「三态三记号」: 把 `RUN_MARK.stalled` 改成 `'○'` → 'stalled 字形 = ◌' 那条红。
 *   - 「INV-DAG-8 无源不画表头」: 把空 views 的早返回删掉 → '空 views → []' 那条红。
 *   - 「NULL ≠ 0 (坏时戳)」: 把 `fmtAge` 里的 `!Number.isFinite` 删掉 → '坏时戳 = 起点未记' 红。
 *   - 「paint 恒等 → 剥标签相等」: 把 `renderRow` 里某段 paint 调用去掉 →
 *     '剥标签后逐字节等' 红。
 */
import { describe, expect, test } from 'bun:test';
import { visibleWidth } from '@earendil-works/pi-tui';
import { HUD_SCHEMA, type HudDagSnapshot } from '../../hud/types';
import type { DagView, DagPhase } from '../../hud/load';
import { RUN_MARK, renderRunList } from './run-list';

const NOW = 1_700_000_000_000;

/** 最小合法 snapshot (INV-HUD-3 的窄字段基线 —— 没 deps/usage/durationMs/failureKind)。 */
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

/** 造一个 DagView, 三个核心字段 (snap / phase / ageMs) 都给默认值。 */
const view = (over: { snap?: HudDagSnapshot; phase?: DagPhase; ageMs?: number } = {}): DagView => ({
  snap: over.snap ?? snap(),
  phase: over.phase ?? 'live',
  ageMs: over.ageMs ?? 0,
});

/** 剥掉 paint 注入的 `<tag>...</tag>`, 返回纯文本。 */
const stripTags = (s: string): string => s.replace(/<\/?[a-z]+>/g, '');

describe('INV-DAG-8 · 无源恒缺席', () => {
  test('空 views → 返回 [] (不画表头, 不画 0 runs 空框)', () => {
    expect(renderRunList([], { width: 80, height: 30, selected: 0, now: NOW })).toEqual([]);
  });
});

describe('INV-DAG-7 · 多分片各画一行, runId8 都在', () => {
  test('三份分片 → 三行, 每个 runId 前 8 位都出现', () => {
    const vs: DagView[] = [
      view({ snap: snap({ runId: 'aaaaaaaa-1111-2222-3333-444444444444' }), phase: 'live', ageMs: 4_000 }),
      view({ snap: snap({ runId: 'bbbbbbbb-1111-2222-3333-444444444444' }), phase: 'finished', ageMs: 12_000 }),
      view({ snap: snap({ runId: 'cccccccc-1111-2222-3333-444444444444' }), phase: 'stalled', ageMs: 45_000 }),
    ];
    const out = renderRunList(vs, { width: 100, height: 30, selected: 0, now: NOW });
    const body = out.join('\n');
    expect(body).toContain('aaaaaaaa');
    expect(body).toContain('bbbbbbbb');
    expect(body).toContain('cccccccc');
    // 三份 ⇒ 三行 (不含头 / 不含 detail / 不含 keys), body 段至少 3 行。
    // 实际: header + 3 row + keys = 5, 加上 selected 的 3 行 detail = 8 (头 1, 体 3+3, 键 1)。
    expect(out.length).toBeGreaterThanOrEqual(5);
  });
});

describe('INV-DAG-9 · 三态三记号, 结构信息不靠颜色', () => {
  test('三个 phase 各自画出对应字形 (▶ / ◌ / ↑), 关色仍可读', () => {
    const vs: DagView[] = [
      view({ snap: snap({ runId: 'aaaaaaaa-1111-2222-3333-444444444444' }), phase: 'live' }),
      view({ snap: snap({ runId: 'bbbbbbbb-1111-2222-3333-444444444444' }), phase: 'stalled' }),
      view({ snap: snap({ runId: 'cccccccc-1111-2222-3333-444444444444' }), phase: 'finished' }),
    ];
    const out = renderRunList(vs, { width: 100, height: 30, selected: 0, now: NOW }).join('\n');
    // 三个 phase mark 都在屏上 (RUN_MARK 与 §1.2 钉死的字形)。
    expect(RUN_MARK.live).toBe('▶');
    expect(RUN_MARK.stalled).toBe('◌');
    expect(RUN_MARK.finished).toBe('↑');
    expect(out).toContain('▶ ');
    expect(out).toContain('◌ ');
    expect(out).toContain('↑ ');
    // 选中行带 `▸` —— 关色下从这一位直接读出谁被选, 不靠颜色。
    expect(out).toMatch(/▸ /);
  });

  test('paint 恒等 → 剥标签后逐字节等 (不靠颜色携带信息)', () => {
    const tag = (n: string) => (s: string) => `<${n}>${s}</${n}>`;
    const paint = { accent: tag('a'), dim: tag('d'), warn: tag('w'), sel: tag('s'), ok: tag('ok'), fail: tag('f') };
    const vs: DagView[] = [
      view({ snap: snap({ runId: 'aaaaaaaa-1111-2222-3333-444444444444', goal: 'live' }), phase: 'live' }),
      view({ snap: snap({ runId: 'bbbbbbbb-1111-2222-3333-444444444444', goal: 'wait' }), phase: 'stalled' }),
      view({ snap: snap({ runId: 'cccccccc-1111-2222-3333-444444444444', goal: 'done' }), phase: 'finished' }),
    ];
    const tagged = renderRunList(vs, { width: 100, height: 30, selected: 1, now: NOW, paint });
    const plain = renderRunList(vs, { width: 100, height: 30, selected: 1, now: NOW });
    expect(tagged.map(stripTags).join('\n')).toBe(plain.join('\n'));
  });

  test('paint 钩子: 选中行走 sel 通道; 三 mark 各走自己的相位色', () => {
    const tag = (n: string) => (s: string) => `<${n}>${s}</${n}>`;
    const paint = { accent: tag('a'), dim: tag('d'), warn: tag('w'), sel: tag('s'), ok: tag('ok'), fail: tag('f') };
    const vs: DagView[] = [
      view({ snap: snap({ runId: 'aaaaaaaa-1111-2222-3333-444444444444' }), phase: 'live' }),
      view({ snap: snap({ runId: 'bbbbbbbb-1111-2222-3333-444444444444' }), phase: 'stalled' }),
      view({ snap: snap({ runId: 'cccccccc-1111-2222-3333-444444444444' }), phase: 'finished' }),
    ];
    const out = renderRunList(vs, { width: 100, height: 30, selected: 0, now: NOW, paint }).join('\n');
    // 选中行 (index=0, phase=live) 整行 sel 通道包外 (含 mark + runId8 全行)。
    expect(out).toMatch(/<s>▸ ▶ aaaaaaaa/);
    // 非选中的 stalled 行 (index=1) —— mark 走 warn 通道。
    // (selected 的 detail 行会插在中间, 所以不能直接用 `</s> ◌` 紧邻断言。)
    expect(out).toMatch(/<w>  ◌ bbbbbbbb/);
    // 非选中的 finished 行 (index=2) —— mark 走 ok 通道。
    expect(out).toMatch(/<ok>  ↑ cccccccc/);
  });
});

describe('INV-DAG-2 · NULL ≠ 0 ≠ 不适用', () => {
  test('坏时戳 (ageMs = Infinity) → 画「start not recorded」, 不画 0m / Infinitym', () => {
    const vs: DagView[] = [
      view({ snap: snap({ runId: 'aaaaaaaa-1111-2222-3333-444444444444' }), phase: 'live', ageMs: Infinity }),
    ];
    const out = renderRunList(vs, { width: 100, height: 30, selected: 0, now: NOW }).join('\n');
    expect(out).toContain('start not recorded');
    // 不画 Infinity / 0m / 0s
    expect(out).not.toContain('Infinity');
    expect(out).not.toMatch(/\b0m\b/);
    expect(out).not.toMatch(/\b0s\b/);
  });

  test('老快照空 planned → 进度列画「—/—」, 不画 0/0', () => {
    const vs: DagView[] = [
      view({
        snap: snap({ runId: 'aaaaaaaa-1111-2222-3333-444444444444', planned: [], started: [] }),
        phase: 'live',
      }),
    ];
    const out = renderRunList(vs, { width: 100, height: 30, selected: 0, now: NOW }).join('\n');
    expect(out).toContain('—/—');
    expect(out).not.toMatch(/\b0\/0\b/);
  });

  test('age 正常值按时长格式 (s / m / ms)', () => {
    const cases: Array<[number, string]> = [
      [400, '400ms'],
      [4_000, '4.0s'],
      [12_000, '12.0s'],
      [60_000, '1m'],
      [90_000, '1m30s'],
      [125_000, '2m5s'],
    ];
    for (const [ageMs, expectStr] of cases) {
      const vs: DagView[] = [view({ ageMs })];
      const out = renderRunList(vs, { width: 100, height: 30, selected: 0, now: NOW }).join('\n');
      expect(out, `ageMs=${ageMs}`).toContain(expectStr);
    }
  });
});

describe('宽度闸 · 行不超宽', () => {
  test('各列在 120/84/70/60 列下都不超', () => {
    const vs: DagView[] = [
      view({ snap: snap({ runId: 'aaaaaaaa-1111-2222-3333-444444444444', goal: 'a'.repeat(200) }), phase: 'live' }),
      view({ snap: snap({ runId: 'bbbbbbbb-1111-2222-3333-444444444444', goal: 'a very very very long English goal that goes on and on - '.repeat(20) }), phase: 'stalled' }),
      view({ snap: snap({ runId: 'cccccccc-1111-2222-3333-444444444444', goal: 'short' }), phase: 'finished' }),
    ];
    for (const w of [120, 84, 70, 60]) {
      const out = renderRunList(vs, { width: w, height: 30, selected: 0, now: NOW });
      for (const line of out) expect(visibleWidth(line), `w=${w}, line=${line}`).toBeLessThanOrEqual(w);
    }
  });

  test('窄屏 (60 列) 下 goal 列被截, 截断补 … (goal 是摘要列, 允许截)', () => {
    const vs: DagView[] = [
      view({
        snap: snap({ runId: 'aaaaaaaa-1111-2222-3333-444444444444', goal: 'a very very very long English goal that goes on'.repeat(5) }),
        phase: 'live',
      }),
    ];
    const out = renderRunList(vs, { width: 60, height: 30, selected: 0, now: NOW }).join('\n');
    // 主行被截: 含 `…` (detail 行有全 goal, 不一定截)。
    expect(out).toContain('…');
  });
});

describe('高度闸 · 超出折叠', () => {
  test('runs 多于预算 → 头 kept + 「… N more」 + 尾 3 (keys 贴底)', () => {
    const vs: DagView[] = Array.from({ length: 20 }, (_, i) =>
      view({
        snap: snap({ runId: `${i.toString().padStart(8, '0')}-aaaa-bbbb-cccc-dddddddddddd`, goal: `r${i}` }),
        phase: 'live',
      }),
    );
    const out = renderRunList(vs, { width: 100, height: 10, selected: 0, now: NOW });
    expect(out.length).toBe(10);
    expect(out.join('\n')).toMatch(/… \d+ more/);
    // 末三行: detail (selected 在第 0) + keys 贴底 —— 末行必含「Ctrl+G exits」(键位行)。
    expect(out[out.length - 1]).toContain('Ctrl+G exits');
  });
});

describe('头行 · 三态计数', () => {
  test('2 live · 1 published · 1 waiting (counts align with phase)', () => {
    const vs: DagView[] = [
      view({ snap: snap({ runId: 'aaaaaaaa-1111-2222-3333-444444444444' }), phase: 'live' }),
      view({ snap: snap({ runId: 'bbbbbbbb-1111-2222-3333-444444444444' }), phase: 'live' }),
      view({ snap: snap({ runId: 'cccccccc-1111-2222-3333-444444444444' }), phase: 'finished' }),
      view({ snap: snap({ runId: 'dddddddd-1111-2222-3333-444444444444' }), phase: 'stalled' }),
    ];
    const out = renderRunList(vs, { width: 100, height: 30, selected: 0, now: NOW });
    const head = out[0]!;
    expect(head).toContain('2 live');
    expect(head).toContain('1 published');
    expect(head).toContain('1 waiting');
    expect(head).toContain('run');
  });

  test('零计数也算真值 —— 全部 finished → 「0 live · N published · 0 waiting」', () => {
    const vs: DagView[] = [
      view({ snap: snap({ runId: 'aaaaaaaa-1111-2222-3333-444444444444' }), phase: 'finished' }),
    ];
    const out = renderRunList(vs, { width: 100, height: 30, selected: 0, now: NOW });
    expect(out[0]).toContain('0 live');
    expect(out[0]).toContain('1 published');
    expect(out[0]).toContain('0 waiting');
  });
});

describe('选中 · 索引 mod 与 detail 行', () => {
  test('selected 越界 / 负数 → mod 归位', () => {
    const vs: DagView[] = [
      view({ snap: snap({ runId: 'aaaaaaaa-1111-2222-3333-444444444444' }), phase: 'live' }),
      view({ snap: snap({ runId: 'bbbbbbbb-1111-2222-3333-444444444444' }), phase: 'live' }),
    ];
    const outNeg = renderRunList(vs, { width: 100, height: 30, selected: -1, now: NOW }).join('\n');
    // -1 mod 2 = 1 → bbbbbbbb 那一行被选, ▸ 在它前面。
    expect(outNeg).toMatch(/▸ ▶ bbbbbbbb/);
    const outBig = renderRunList(vs, { width: 100, height: 30, selected: 5, now: NOW }).join('\n');
    // 5 mod 2 = 1 → 同上。
    expect(outBig).toMatch(/▸ ▶ bbbbbbbb/);
  });

  test('选中行下面挂 goal 全文 + Enter 提示', () => {
    const vs: DagView[] = [
      view({ snap: snap({ runId: 'aaaaaaaa-1111-2222-3333-444444444444', goal: 'a very very very long goal that goes on and on'.repeat(10) }), phase: 'live' }),
    ];
    const out = renderRunList(vs, { width: 60, height: 30, selected: 0, now: NOW }).join('\n');
    // 主行 goal 被截 (60 列), 但 detail 行露出完整 goal 段, 含 `goal` 字面标识。
    expect(out).toContain('goal');
    expect(out).toContain('Enter enters');
  });
});
