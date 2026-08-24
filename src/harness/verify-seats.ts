/**
 * 座位家族校验闸 (I-14, 接 §1.10 verify-seats + CONFLICT-4 家族比较补遗)。
 *
 * ## 它填的是哪个洞
 *
 * `seats.ts` 上 `verifier` / `review` / `review-spec` 三个座位都标 `crossFamily: 'required'`,
 * `recommend` 散文里也写着「必须与 conductor / leaf / agent 异族」(INV-3:
 * **判与证共享盲点 = 这一格结构性失效, 不是"不够好"**)。
 *
 * `model/seat-conformance.ts` 的 `reconcileSeats` 已经按 `AUDITS` 表**逐座位**对账,
 * 报 `cross-family` / `preferred` 两种 drift。但它**只报不拦** (`preferred` 类), 且**只
 * 面向 `config.json` 静态对账**, 不是给引擎启动当 fail-fast 闸用的。
 *
 * 本文件 = 启动期 fail-fast 版本: 同样的家族比较, 但**判败即抛**(CLI 接住转非 0 退出码),
 * 且**只盯同族这件事**(`preferredCoord` 漂移留给 `seat-conformance`)。
 *
 * ## 与 `seat-conformance` 的边界
 *
 * | | seat-conformance | verify-seats (本文件) |
 * |---|---|---|
 * | 触发 | 配完 config 之后静态扫描 | 引擎启动 (每次) |
 * | 严度 | error / warn 两级 | 二值 ok / 抛 |
 * | 范围 | 全 SEATS + preferredCoord | 仅 tier='verify' 与它审的第一个座位 |
 * | 同源判据 | 家族比较走 `modelFamily` | **同** —— 必须保持一致 |
 *
 * ⚠ **家族判定走 `modelFamily`, 不用 `coord.split(":")[0]`** (2026-08-23 实测修过):
 * 裸前缀会把 `minimax-cn` 与 `minimax-us` 判成异族 → 漏过 INV-3。`auto-assign.ts:348` 与
 * `seat-conformance.ts:82` 都用 `modelFamily`, 本文件必须同口径。
 */
import { modelFamily } from '../model/channels';
import { SEATS } from '../model/seats';
import { AUDITS } from '../model/seat-conformance';

/** 单侧坐标: 座位 id + 实配坐标。 */
export interface SeatCoord {
  readonly seatId: string;
  readonly coord: string;
}

/** 一对 verifier / generator 的家族比较结果。 */
export interface FamilyCheck {
  readonly verifier: { readonly seatId: string; readonly coord: string; readonly family: string };
  readonly generator: { readonly seatId: string; readonly coord: string; readonly family: string };
  readonly ok: boolean;
  /** 两行可打印文本, 顺序固定 = [generator.family, verifier.family]。 */
  readonly lines: readonly [string, string];
  /** 失败原因 (ok=true 时缺省)。 */
  readonly reason?: string;
}

/** 纯函数: 单对 verifier/generator 的家族比较 (单测注入用)。 */
export function checkSeatFamily(verifier: SeatCoord, generator: SeatCoord): FamilyCheck {
  const vf = modelFamily(verifier.coord);
  const gf = modelFamily(generator.coord);
  const lines: [string, string] = [`generator.family: ${gf}`, `verifier.family: ${vf}`];
  if (vf === gf) {
    return {
      verifier: { seatId: verifier.seatId, coord: verifier.coord, family: vf },
      generator: { seatId: generator.seatId, coord: generator.coord, family: gf },
      ok: false,
      lines,
      reason: `同族 '${vf}' — 判与证共享盲点, 这一格结构性失效 (不是"不够好")`,
    };
  }
  return {
    verifier: { seatId: verifier.seatId, coord: verifier.coord, family: vf },
    generator: { seatId: generator.seatId, coord: generator.coord, family: gf },
    ok: true,
    lines,
  };
}

/**
 * 纯函数: 扫 `SEATS` 表, 对每个 tier='verify' 且 `AUDITS` 非空的座位, 与其审的**第一**
 * 个座位做家族比较。
 *
 * - 没配的座位跳过 (「没配」≠「配错了」, 与 `seat-conformance` 同源判据);
 * - `AUDITS` 没列的 `verify` 座位也跳过 (宁可漏不可误报 —— 误报的闸会被无视)。
 */
export function checkAllVerifierSeats(
  coords: Readonly<Record<string, string | undefined>>,
): readonly FamilyCheck[] {
  const out: FamilyCheck[] = [];
  for (const spec of SEATS) {
    if (spec.tier !== 'verify') continue;
    const audited = AUDITS[spec.id];
    if (!audited || audited.length === 0) continue;
    const vCoord = coords[spec.id];
    if (!vCoord) continue;
    const gId = audited[0]!;
    const gCoord = coords[gId];
    if (!gCoord) continue;
    out.push(checkSeatFamily({ seatId: spec.id, coord: vCoord }, { seatId: gId, coord: gCoord }));
  }
  return out;
}

export interface VerifySeatsResult {
  readonly ok: boolean;
  readonly checks: readonly FamilyCheck[];
}

/** 纯函数版判定 — 不读盘不打印, 便于单测注入假席位表。 */
export function verifySeats(coords: Readonly<Record<string, string | undefined>>): VerifySeatsResult {
  const checks = checkAllVerifierSeats(coords);
  return { ok: checks.every((c) => c.ok), checks };
}

/**
 * 引擎启动调用的同款断言: 与 `verifySeats` 同样的判据, 但**打印两侧家族**且**任一同族即 throw**
 * (CLI 接住 throw 转非 0 退出码)。
 *
 * @returns 同 `verifySeats` 的结果 (调用方拿到后可继续走其它闸)。
 * @throws 同族时抛 Error, message 含所有失败对的两侧家族。
 */
export function assertSeatFamiliesDiverge(
  coords: Readonly<Record<string, string | undefined>>,
): VerifySeatsResult {
  const r = verifySeats(coords);
  for (const c of r.checks) {
    for (const line of c.lines) console.log(line);
  }
  if (!r.ok) {
    const fails = r.checks.filter((c) => !c.ok);
    const msg = fails.map((c) => `[${c.verifier.seatId} vs ${c.generator.seatId}] ${c.reason}`).join('\n');
    throw new Error(`座位家族校验失败:\n${msg}`);
  }
  return r;
}
