/**
 * 座位家族校验闸 (verify-seats) 单测。
 *
 * 覆盖 INV-23 / I-14:
 *  - ① 被验产物与 verifier/judge 异族 → ok=true, 返回/打印两侧家族。
 *  - ② 同族 → ok=false (CLI 层把 throw 转非 0 退出码, 此处只断言返回值/throw)。
 *  - ③ 家族解析纯本地, 通过注入 coords 表完成, 不依赖网络/真实模型可用性。
 *  - ④ 启动期同款入口 (assertSeatFamiliesDiverge) 至少覆盖一次, 含 console.log 打印路径。
 *
 * CLI / spawn 层由 test/acceptance-s1.test.ts 覆盖, 此处只调导出纯函数。
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import {
  assertSeatFamiliesDiverge,
  checkSeatFamily,
  verifySeats,
  type SeatCoord,
} from './verify-seats';

// 异族坐标对: provider 不同 → modelFamily 不会归一。
//   verifier  = anthropic 族 (claude)
//   generator = kimi      族 (k2)
const VERIFIER_CLAUDE: SeatCoord = { seatId: 'verifier', coord: 'anthropic:claude-3.5-sonnet' };
const GENERATOR_KIMI: SeatCoord = { seatId: 'conductor', coord: 'kimi:k2' };

// 同族坐标对: 同 provider 不同 coord。-cn 后缀被 modelFamily 剥掉 (verify-seats.ts:26
// 注释强调的 2026-08-23 修过的坑: 裸前缀会误把 minimax-cn / minimax-us 判成异族),
// 两边都归一为 anthropic 族, 必须判同族 → ok=false。
const VERIFIER_CLAUDE_CN: SeatCoord = { seatId: 'verifier', coord: 'anthropic-cn:claude-3.5' };
const GENERATOR_CLAUDE: SeatCoord = { seatId: 'conductor', coord: 'anthropic:claude-opus-4' };

describe('checkSeatFamily (单对 verifier / generator 家族比较, INV-23)', () => {
  test('① 异族 → ok=true 且返回两侧家族名, lines 顺序固定为 [generator, verifier]', () => {
    const r = checkSeatFamily(VERIFIER_CLAUDE, GENERATOR_KIMI);
    expect(r.ok).toBe(true);
    expect(r.verifier.family).toBe('anthropic');
    expect(r.generator.family).toBe('kimi');
    expect(r.verifier.coord).toBe(VERIFIER_CLAUDE.coord);
    expect(r.generator.coord).toBe(GENERATOR_KIMI.coord);
    expect(r.lines).toEqual([
      'generator.family: kimi',
      'verifier.family: anthropic',
    ]);
    // ok=true 时 reason 缺省 (verify-seats.ts:48)
    expect(r.reason).toBeUndefined();
  });

  test('② 同族 → ok=false, reason 必须含「同族」与撞上的家族名', () => {
    const r = checkSeatFamily(VERIFIER_CLAUDE_CN, GENERATOR_CLAUDE);
    expect(r.ok).toBe(false);
    // 反向自检 modelFamily 剥 -cn 后缀: 同源判据, 两侧都归 anthropic。
    expect(r.verifier.family).toBe('anthropic');
    expect(r.generator.family).toBe('anthropic');
    expect(r.reason).toBeDefined();
    expect(r.reason).toContain('同族');
    expect(r.reason).toContain('anthropic');
    expect(r.lines).toEqual([
      'generator.family: anthropic',
      'verifier.family: anthropic',
    ]);
  });
});

describe('verifySeats (③ 注入 coords, 零网络零真实模型依赖)', () => {
  test('仅 verifier 与 conductor 同族 → ok=false, 单条失败检查', () => {
    // AUDITS.verifier = ['conductor', 'judge', 'leaf', 'reduce'] (seat-conformance.ts:53)
    // checkAllVerifierSeats 只取 audited[0] 作被审座位 (verify-seats.ts:90)。
    // 这里故意把 verifier 与 conductor 都归到 anthropic 族, 必败。
    const coords: Record<string, string> = {
      verifier: 'anthropic-cn:claude-3.5',
      conductor: 'anthropic:claude-opus-4',
      // review / review-spec 没配 → 跳过 (verify-seats.ts:88 跳过未配)
    };
    const r = verifySeats(coords);
    expect(r.ok).toBe(false);
    expect(r.checks.length).toBe(1);
    const failed = r.checks[0]!;
    expect(failed.ok).toBe(false);
    expect(failed.verifier.seatId).toBe('verifier');
    expect(failed.generator.seatId).toBe('conductor');
    expect(failed.verifier.family).toBe('anthropic');
    expect(failed.generator.family).toBe('anthropic');
  });

  test('verifier 与 conductor 异族 → ok=true, 单条通过检查', () => {
    const coords: Record<string, string> = {
      verifier: 'anthropic:claude-3.5-sonnet',
      conductor: 'kimi:k2',
    };
    const r = verifySeats(coords);
    expect(r.ok).toBe(true);
    expect(r.checks.length).toBe(1);
    expect(r.checks[0]!.ok).toBe(true);
    expect(r.checks[0]!.verifier.family).toBe('anthropic');
    expect(r.checks[0]!.generator.family).toBe('kimi');
  });

  test('AUDITS[0] 未配 → 跳过, 不参与家族比较 (与 seat-conformance 同源判据)', () => {
    // verifier 已配, 但被审的 conductor 没配 → 跳过 (verify-seats.ts:92),
    // 返回空 checks 列表, ok=true (空数组 every = true)。
    const coords: Record<string, string> = {
      verifier: 'anthropic:claude-3.5-sonnet',
      // conductor 缺席 → 该对跳过
    };
    const r = verifySeats(coords);
    expect(r.ok).toBe(true);
    expect(r.checks.length).toBe(0);
  });

  test('所有三个 tier=verify 座位都配且都异族 → ok=true, 3 条检查全过', () => {
    // tier=verify 的座位 (seats.ts:346/372/377): verifier / review-spec / review
    // AUDITS.verifier[0]='conductor'; AUDITS.review[0]='leaf'; AUDITS['review-spec'][0]='leaf'
    // 故意把被审座位都安排到与 verify 座位不同族。
    const coords: Record<string, string> = {
      verifier: 'anthropic:claude-3.5',
      conductor: 'kimi:k2',
      'review-spec': 'minimax:m3',
      review: 'zhipu:glm-5',
      leaf: 'gpt:gpt-4o',
      agent: 'qwen:qwen-max',
    };
    const r = verifySeats(coords);
    expect(r.ok).toBe(true);
    expect(r.checks.length).toBe(3);
    expect(r.checks.every((c) => c.ok)).toBe(true);
  });
});

describe('assertSeatFamiliesDiverge (④ 启动期同款入口: console.log 打印 + throw)', () => {
  let logSpy: ReturnType<typeof spyOn>;
  beforeEach(() => {
    logSpy = spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
  });

  test('异族 → 返回 ok=true 且 console.log 逐行打印两侧家族', () => {
    const coords: Record<string, string> = {
      verifier: 'anthropic:claude-3.5-sonnet',
      conductor: 'kimi:k2',
    };
    const r = assertSeatFamiliesDiverge(coords);
    expect(r.ok).toBe(true);
    // 每条 FamilyCheck 打印 lines[0] + lines[1] (verify-seats.ts:121)
    const printed = logSpy.mock.calls
      .map((c: unknown[]) => String(c[0]))
      .join('\n');
    expect(printed).toContain('generator.family: kimi');
    expect(printed).toContain('verifier.family: anthropic');
  });

  test('同族 → throw Error, message 含两侧座位 id + 撞上的家族名 (CLI 据此转非 0 退出码)', () => {
    const coords: Record<string, string> = {
      verifier: 'anthropic-cn:claude-3.5',
      conductor: 'anthropic:claude-opus-4',
    };
    expect(() => assertSeatFamiliesDiverge(coords)).toThrow(/座位家族校验失败/);
    let caught: Error | undefined;
    try {
      assertSeatFamiliesDiverge(coords);
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).toBeDefined();
    // 错误 message 含两侧座位 id 与家族名 (verify-seats.ts:125)
    expect(caught!.message).toContain('verifier');
    expect(caught!.message).toContain('conductor');
    expect(caught!.message).toContain('anthropic');
  });
});
