/**
 * harness/dag/oracle-red —— **闸红短路**(#145 提议 5 Phase A,2026-08-17)。
 *
 * ## 它治的那个病
 *
 * `engine.ts` 的 verifier 在 `executePlan` 返回之后**无条件**跑,它不看图里那道确定性 oracle
 * 节点红没红。于是实际编排是:
 *
 * ```
 * 写者 → gate 节点 (tsc --noEmit && bun test) 红 → 节点 failed → executePlan 返回
 *      → verifier(强模型, 吃整个 results 表)照跑 → 必然 pass:false
 *      → reason 回灌 conductor 重画
 * ```
 *
 * issue #145 提议 5 那句话不是比喻,就是这条 if:
 *
 * > 现在的编排是 leaf 写完直接进强模型审 —— **强模型花钱去发现"编译不过"这种编译器一秒能说的事。**
 *
 * 这一格**不需要模型**:确定性 oracle 已经说了不,判词是可确定性合成的。
 * 省下的是一发强模型座(verifier 现在坐 `openai-codex:gpt-5.6-sol`,prompt 里带整个
 * `results` 表),而且合成出来的判词**比模型的转述更准** —— 编译器原文 vs 模型复述。
 *
 * ## 判据窄是设计,不是保守
 *
 * 只认 `kind === 'command'` ∧ `failureKind === 'assert-failed'`。
 * 这一格的语义是「**确定性 oracle 跑了,并且说了不**」。其余的红一律**不短路**,
 * 因为它们说的是别的事(同 `node-failure.ts` 那张表逐格的 nextAction):
 *
 * | 没进来的 | 为什么 |
 * |---|---|
 * | `timed-out` | **没跑完 ≠ 跑出了错答案**。它这一次根本没被测到,不许当成 oracle 的判词 |
 * | `gate-rejected` | 退出码 <0 = command-leaf 闸拒,**命令压根没执行** |
 * | `missing-capability` | 退出码 127/126,命令找不到 —— 也是没执行 |
 * | `dep-skip` | 零执行零花费,它自己没有毛病 |
 * | `oracle-inconclusive` | 冻结判据命令是 bare 整仓 pytest 且退出码 2/4/5 —— 命令没给出判词, 不是代码被判否 (P2b-runtime, 2026-09-02) |
 * | 任何非 `command` 的红 | agent/inproc 的红是执行体的事,不是 oracle 的判词 |
 *
 * **「oracle 说了不」与「oracle 没能说话」是两件事**,而只有前者的判词可以不问模型就写出来。
 * 把后者也算进来,就是拿一次基础设施故障冒充质量信号 —— 与 `verifierDown` 那条
 * 「判卷官坏了还替它开修复轮」同一个错。
 *
 * ⚠ `expect_exit` 已经在 `assert-failed` 的判据里折算过了(证据原文:「退出码 ≥0 且 **≠ expect_exit**」),
 * 所以 TDD 的红步(`expect_exit:1` 且真的退 1)是 **done**,不会走到这里。
 *
 * ## 刻意**不**做的那一件:合成 blame 围栏
 *
 * `parseBlameVerdict` 会从判词里读 ```blame 围栏做节点级点名(D-1/D-2),点名成功则毒集
 * = 失效闭包而不是整轮。合成判词天然可以带一个格式完美的围栏 —— **但点名谁是错的**:
 *
 * - 点名闸节点自己 → 闭包 = 闸 + 下游,**写者在上游、不进闭包** → 重画只重跑闸 → 照样红 → D-6 熔断;
 * - 点名闸的上游写者 → 方向对了,但「**哪些**写者」正是归因问题(Phase B1),今天答不上来。
 *
 * 假装答得上来就是把一段猜测升格成毒集,而毒集决定哪些已绿工作要重烧。
 * 所以这里**一个围栏都不带**,让 `parseBlameVerdict` 照旧 fail-open 到整轮 ——
 * 与今天逐字节相同。本模块的行为增量因此**恰好只有一件**:那一发强模型不打。
 * (单一变量:要量的正是这一发省了多少,别在同一次改动里再动毒集。)
 */
import { failureExcerpt } from '../failure-trace';
import type { LeafResult } from './types';

/** 一个「跑了并且说了不」的确定性 oracle 节点。 */
export interface RedOracle {
  id: string;
  /**
   * 失败输出的头+尾摘要 —— 判词要带编译器原话,不许写成"闸没过"。
   *
   * ⚠ 命令原文**刻意不在这里**:`LeafResult` 上没有这一位,而为了它多传一个 plan 参数
   * 是白花的 —— `escTask` 本来就带 `planOutline(exec.plan)`,conductor 按节点 id 查得到命令。
   * 另外 `failureExcerpt` 保头的理由原文就是「头一段说的是**在跑什么**(命令回显)」。
   */
  excerpt: string;
}

/**
 * 图里所有**跑了且判否**的确定性 oracle 节点。空数组 = 没有这样的节点
 * (可能一个 command 节点都没有,也可能全绿)—— 两者对本模块是同一件事:**照常问模型**。
 */
export function findRedOracles(results: Readonly<Record<string, LeafResult>>): RedOracle[] {
  const out: RedOracle[] = [];
  for (const r of Object.values(results)) {
    if (r.kind !== 'command') continue;
    if (r.failureKind !== 'assert-failed') continue;
    out.push({ id: r.id, excerpt: failureExcerpt(r.output ?? '') });
  }
  return out;
}

/**
 * 合成判词。**逐条点名节点 + 带编译器原话** —— 这份判词有两个下游读者,
 * 它必须同时对得起两边:
 *   ① `escTask` 里的 `[上一轮校验未通过]` 段 → conductor 重画的材料;
 *   ② D-6 同因熔断的 `blameKey`(判词归一化后逐字比对)—— 连续两轮同一条编译错
 *      就该停,而那要求判词**随错误内容变化**,不能是一句固定的"闸没过"。
 */
export function renderOracleRedVerdict(reds: readonly RedOracle[]): string {
  const body = reds
    .map((r) => `- 节点 ${r.id}:\n${r.excerpt}`)
    .join('\n');
  return (
    `[oracle-red] 图内确定性验收节点未过(${reds.length} 个)—— **未请强模型判卷**:` +
    `编译器/测试已经给出判词,再花一发强模型只是让它把同一件事复述一遍。\n${body}\n` +
    '先让上面这些命令转绿。它们绿之前,任何语义/契约层面的评价都不作数。'
  );
}
