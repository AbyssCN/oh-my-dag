/**
 * 座位登记表 ↔ 实配 对账闸(`seat-conformance.ts`,承 issue #142/#143)。
 *
 * **真实样本**:2026-08-23 的现场配置 —— `review` 掉队两次(08-11 gpt → 08-20 deepseek
 * → 08-21 minimax),全程无人报。下面第一条用的就是**改回去之前那份逐字的配置**。
 *
 * 判别力锚(照 `pathfinder/code-sync.test.ts`:一个把所有座位都报一遍的闸量的是尺子):
 *  - 同一批配置里,**只有** review/review-spec 该红,别的一条都不许;
 *  - `preferred` 不匹配只报 warn,**不许**升成 error(换座位是 owner 的正当操作);
 *  - 家族判定必须用 `modelFamily`:`minimax-cn` 与 `minimax-us` 是**同族**。
 */
import { describe, expect, test } from 'bun:test';
import { AUDITS, formatSeatDrift, reconcileSeats } from './seat-conformance';

/** 2026-08-23 改回去**之前**那份配置(逐字,现场)。 */
const DRIFTED = {
  conductor: 'claude-code:claude-opus-5',
  escalation: 'claude-code:claude-opus-5',
  judge: 'minimax-cn:MiniMax-M3',
  reason: 'minimax-cn:MiniMax-M3',
  fusion: 'claude-code:claude-opus-5',
  graft: 'claude-code:claude-opus-5',
  verifier: 'openai-codex:gpt-5.6-sol',
  'review-spec': 'minimax-cn:MiniMax-M3',
  review: 'minimax-cn:MiniMax-M3',
  leaf: 'minimax-cn:MiniMax-M3',
  agent: 'minimax-cn:MiniMax-M3',
  continuity: 'minimax-cn:MiniMax-M3',
  reduce: 'minimax-cn:MiniMax-M3',
} as const;

/** 改回去**之后**的(现在盘上这份)。 */
const FIXED = { ...DRIFTED, review: 'openai-codex:gpt-5.6-sol', 'review-spec': 'openai-codex:gpt-5.6-sol' };

describe('cross-family — required 的座位不许与它要审的同族', () => {
  test('★ 现场样本: review / review-spec 与 leaf/agent 同属 minimax ⇒ 两条 error', () => {
    const errs = reconcileSeats(DRIFTED).filter((d) => d.severity === 'error');
    expect(errs.map((d) => d.seat).sort()).toEqual(['review', 'review-spec']);
    expect(errs[0]!.why).toContain('结构性失效');
  });

  test('★ 判别力: 同一批配置里**别的座位一条都不许红** (报所有人的闸量的是尺子)', () => {
    const errs = reconcileSeats(DRIFTED).filter((d) => d.severity === 'error');
    // fusion 是 claude, 它审的是 judge (minimax) ⇒ 异族, **不许**被报。
    // 第一版用了一个粗的「大脑集合」, 就把 fusion 与 conductor 判成同族 —— 那是误报。
    expect(errs.map((d) => d.seat)).not.toContain('fusion');
    expect(errs.map((d) => d.seat)).not.toContain('verifier');
  });

  test('★ 改回 gpt 之后 ⇒ error 清零 (证明这条不是恒红)', () => {
    expect(reconcileSeats(FIXED).filter((d) => d.severity === 'error')).toEqual([]);
  });

  test('★ 家族判定用 modelFamily: minimax-cn 与 minimax-us 是**同族**', () => {
    const cross = { ...FIXED, review: 'minimax-us:MiniMax-M3' };
    const errs = reconcileSeats(cross).filter((d) => d.severity === 'error');
    // 裸 `coord.split(':')[0]` 会把 minimax-us 与 minimax-cn 判成异族 → 漏过这一条。
    expect(errs.map((d) => d.seat)).toContain('review');
  });

  test('没配的座位不判 (「没配」≠「配错了」)', () => {
    const errs = reconcileSeats({ review: 'minimax-cn:MiniMax-M3' }).filter((d) => d.severity === 'error');
    expect(errs).toEqual([]); // leaf/agent 都没配 ⇒ 无从判同族
  });

  test('AUDITS 表外的 required 座位不判 (宁可漏, 不可误报)', () => {
    expect(AUDITS).not.toHaveProperty('graft');
    const errs = reconcileSeats({ ...FIXED, graft: 'minimax-cn:MiniMax-M3' }).filter((d) => d.severity === 'error');
    expect(errs).toEqual([]);
  });
});

describe('preferred — 只报不拦', () => {
  test('★ preferredCoord 不匹配 ⇒ warn, **永不** error', () => {
    const ds = reconcileSeats(FIXED).filter((d) => d.kind === 'preferred');
    expect(ds.length).toBeGreaterThan(0);
    expect(ds.every((d) => d.severity === 'warn')).toBe(true);
  });

  test('★ 判别力: 匹配上的座位不报 (不是恒报)', () => {
    // verifier 实配 = 它的 preferredCoord ⇒ 不该出现在 preferred 漂移里
    const seats = reconcileSeats(FIXED).filter((d) => d.kind === 'preferred').map((d) => d.seat);
    expect(seats).not.toContain('verifier');
  });

  test('判词人读且带两侧坐标', () => {
    const d = reconcileSeats(FIXED).find((x) => x.kind === 'preferred')!;
    const line = formatSeatDrift(d);
    expect(line).toContain(d.expected);
    expect(line).toContain(d.actual!);
  });
});
