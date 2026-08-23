/**
 * **座位登记表 ↔ 实际配置 对账闸**(2026-08-23,承 issue #142/#143)。
 *
 * ## 它填的是哪个洞
 *
 * `seats.ts` 上的 `preferredCoord` 与 `crossFamily` 今天是**散文** —— 它自己的注记写着:
 * 「⚠ 诚实注记: 目前**没有闸消费 `crossFamily`**(INV-3 的代码检查只看 verifier 一个座,
 * 且只查 auto-assign 的死层)。这一格是**声明的意图**, 不是被强制的约束」(`seats.ts:239`)。
 *
 * **代价已实测**: `review` 座位规格写着 `crossFamily: 'required'` 且给了 `preferredCoord`
 * (坐标见 `seats.ts` —— **这里刻意不复述字面坐标**: `seat-coordinate-gate` 连注释一起扫,
 * 而它扫得宽是对的方向, 不该为一句散文去侵蚀它的白名单), 而它**掉队过两次** ——
 * 08-11 在首选坐标上,08-20 变成 deepseek,08-21 的一次 deepseek→minimax 批量搬迁里
 * 又跟着大流扫成 minimax。**同一场搬迁里 `verifier` 被正确地单独挑出来给了 gpt,
 * `review` 没有** —— 两者同 `tier: verify`、同 `crossFamily: required`。
 * 掉队全程无人报,直到 owner 2026-08-23 偶然问起。
 *
 * ## 判据分两级,严重度不同
 *
 * - **`cross-family` = error**: `crossFamily: 'required'` 的座位与**它要审的那些座位**同族。
 *   「判与证共享盲点」——同族自审时这一格**结构性失效**,不是「不够好」。
 * - **`preferred` = warn**: 配了 `preferredCoord` 却用了别的坐标。
 *   **只报不拦** —— 换座位是 owner 的正当操作(渠道挂了、成本、实验),
 *   拦下来等于替 owner 扣扳机。它要治的是**漂了没人看见**,不是「不许改」。
 *
 * ## 「它审谁」逐座位转写,不用一个粗集合
 *
 * 第一版用了一个统一的「大脑座位集合」,**当场咬出一条误报**:`fusion` 被判与 `conductor`
 * 同族。而 `fusion` 的规格自己写着它审的是 **judge 的产出**(「把 K 维度 judge 的评判收敛成
 * 5-tuple」),owner 2026-08-15 选 claude 的理由原文是「上游 gen/reduce/synth 现在全在
 * minimax、**judge 在 deepseek**,放 claude 天然异于两者」—— **conductor 不在被审对象里**。
 * ⇒ 粗集合会误报,而**误报的闸会被无视**。
 *
 * 所以 {@link AUDITS} 逐座位写「它审谁的产出」,每条**都从该座位自己的散文里转写**
 * (转写不是发明;出处逐条注在表里)。
 */
import { modelFamily } from './channels';
import { SEATS } from './seats';

/**
 * **它审谁的产出** —— 只给 `crossFamily: 'required'` 的座位。每条的出处:
 *
 * - `verifier`  ← `auto-assign.ts:265` 的 INV-3 原文:「verifier 跨家族 (≠ conductor/judge/leaf/reduce 主力)」
 * - `review`    ← `seats.ts` 的 recommend 原文:「强模型 + **与被审代码的作者异族**」⇒ 写码的是 leaf/agent
 * - `review-spec` ← 同上(同 tier、同 recommend 形状)
 * - `fusion`    ← `seats.ts` 的 what 原文:「把 **K 维度 judge** 的评判收敛成 5-tuple」
 *
 * ⚠ 表里没有的 `required` 座位 ⇒ **不判**(不是判它过)。宁可漏, 不可误报 ——
 * 误报的闸会被无视, 而漏报只是回到没有闸的状态, 不产生新盲点
 * (同 `claimed-actions.ts` 的 VERIFICATION_COMMAND「刻意很窄」那条纪律)。
 */
export const AUDITS: Readonly<Record<string, readonly string[]>> = {
  verifier: ['conductor', 'judge', 'leaf', 'reduce'],
  review: ['leaf', 'agent'],
  'review-spec': ['leaf', 'agent'],
  fusion: ['judge'],
};

export type SeatDriftKind = 'cross-family' | 'preferred';

export interface SeatDrift {
  seat: string;
  kind: SeatDriftKind;
  severity: 'error' | 'warn';
  /** 当前配的坐标(未配 → undefined)。 */
  actual?: string;
  /** `preferred` 类:规格要的坐标;`cross-family` 类:撞上的那个家族。 */
  expected: string;
  why: string;
}

/**
 * 对账(**纯函数**,不读盘 —— 于是判别力可注入验)。
 *
 * @param configured 座位 → 坐标(调用方从 `config.json` 读;缺席的座位跳过,
 *                   **「没配」与「配错了」是两件事**,没配不报)。
 */
export function reconcileSeats(configured: Readonly<Record<string, string | undefined>>): SeatDrift[] {
  const drifts: SeatDrift[] = [];
  const famOf = (seat: string): string | undefined => {
    const c = configured[seat];
    return c ? modelFamily(c) : undefined;
  };

  for (const spec of SEATS) {
    const actual = configured[spec.id];
    if (!actual) continue; // 没配 ≠ 配错了

    const audited = AUDITS[spec.id];
    if (spec.crossFamily === 'required' && audited) {
      const fam = modelFamily(actual);
      const collides = audited.filter((s) => s !== spec.id && famOf(s) === fam);
      if (collides.length > 0) {
        drifts.push({
          seat: spec.id,
          kind: 'cross-family',
          severity: 'error',
          actual,
          expected: fam,
          why:
            `\`crossFamily: 'required'\` 却与它要审的 ${collides.map((s) => `\`${s}\``).join('/')} ` +
            `同属 '${fam}' 家族 —— 判与证共享盲点, 这一格**结构性失效**(不是"不够好")。`,
        });
      }
    }

    if (spec.preferredCoord && spec.preferredCoord !== actual) {
      drifts.push({
        seat: spec.id,
        kind: 'preferred',
        severity: 'warn',
        actual,
        expected: spec.preferredCoord,
        why: `规格首选 \`${spec.preferredCoord}\`, 实配 \`${actual}\` —— **只报不拦**(换座位是 owner 的正当操作), 它治的是漂了没人看见。`,
      });
    }
  }
  return drifts;
}

/** 人读判词(脚本与测试共用一份, 别两处各拼一次)。 */
export function formatSeatDrift(d: SeatDrift): string {
  const tag = d.severity === 'error' ? '⛔' : '▲';
  return `${tag} [${d.seat}] ${d.why}`;
}
