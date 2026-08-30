/**
 * harness/dag/retry-domain —— **retry 域分离** (S3 · D-1/D-2/D-3, INV-1)。
 *
 * ## 它治的那个病
 *
 * 同一个 `LeafResult` 在不同轴上同时传递两种信号:
 *   · 「确定性 oracle 跑了并且说了不」(`command` ∧ `assert-failed`)
 *   · 「生成侧跑出某种失败」(其余)
 *
 * 把这两种信号塞进同一个 retry 预算函数 `budgetFor` 的后果:
 * conductor 画图时给一个 `executor:'command'` 的验收节点写了 `max_retry: 3`,
 * 编译器没过的失败**也会**被原样再派三次 —— `oracle-red.ts:26` 那条表说得很清楚:
 * `assert-failed` 是「**确定性 oracle 跑了, 并且说了不**」, 这不是故障, 是**判词**,
 * 把判词再喂给同一条命令的结果是 retry-masking(SDD §8 S3 止损行那条).
 *
 * 所以 retry 域必须分开:
 *   · **oracle 域** = 判词已出的确定性节点。判否 → 0 次重试, 越过 `max_retry`.
 *   · **generation 域** = 一切非 oracle 域(agent / inproc / map / primitive / research /
 *     conductor / await, 以及 command 节点的 `timed-out` / `gate-rejected` / 抛错等
 *     「没能说话」的路径). 走现行重试语义, 逐字节不变.
 *
 * ## 为什么是纯函数
 *
 * INV-1: 域判定必须与判词合成 (`renderOracleRedVerdict`) **同源** —— 否则「谁算 oracle」
 * 在仓里会有两个答案, 漂了之后没人看得出来. 给节点加 `domain` 字段是声明第二遍,
 * 见 S-39 那条记忆. 这里只读 `kind` 与 `failureKind`, 不读日志, 不读 plan, 不读
 * ConductorPlan, 不引入新字段.
 *
 * ## 为什么没有第三值
 *
 * `oracle | generation` 是**值域**而不是注释. 多塞一个 `'unknown'` 会把「没说话」与
 * 「说话但没说」抹平成同一格, 是仓规坑 1 的典型形态. 这里**没有第三格**, 由调用方
 * 的 `kind/failureKind` 是否齐全来回答「这一格不适用」 —— 缺席是缺席, 判 `generation`
 * 是判 `generation`, 两条路径在调用方那里被分别处理.
 *
 * ## 反向自检 (契约 §反向自检 第 1 条)
 *
 * 把 `classifyRetryDomain` 改成恒返 `'generation'` ⇒
 *   · `retry-domain.test.ts` 的 RETRY_DOMAIN_ORACLE 用例当场红
 *   · `s3-wiring.test.ts` 的 S3_RETRY_DOMAIN_WIRED 用例当场红 (片 5)
 * 两条恢复后两片才能重新绿.
 */
import type { LeafResult } from './types';
import type { NodeFailureKind } from '../node-failure';

/**
 * Retry 域 —— 节点在引擎的 L0 节点级重试里**各持各的预算**的两个独立域.
 *
 * ⚠ **不要往这个联合里塞第三个值**. 需要第三格时**停手升 owner**:
 * 这是一个边界已定的分格, 加格意味着改仓规 (仓规坑 1 · 三态分念).
 */
export type RetryDomain = 'oracle' | 'generation';

/**
 * 域判定纯函数 —— 给一次失败尝试 (`LeafResult` 的 kind/failureKind 两列), 回答它属于哪个 retry 域.
 *
 * 判据与 `oracle-red.ts:80-81` 逐字一致 —— 同一个谓词驱动判词合成与 retry 裁决,
 * 这样「谁算 oracle」在仓里永远只有一个答案.
 *
 * 输入域:
 *   · `kind`     ∈ LeafResult.kind (8 值之一: inproc/agent/command/map/primitive/research/conductor/await)
 *   · `failureKind` ∈ NodeFailureKind 词表 (见 node-failure.ts:49) 或 undefined
 *                   (status === 'done' 时本字段缺席是合法状态; 但域判定只在失败路径上调用,
 *                    所以这里把 done 当作「不适用」: 它不会进 retry 循环.)
 *
 * 输出: `oracle` 仅当 `kind === 'command'` ∧ `failureKind === 'assert-failed'`;
 *       其余一切 (含 command 的其他 failureKind 与抛错) 一律 `generation`.
 *
 * 纯函数, 零 IO, 不读日志, 不读 plan, 不引用 `ConductorPlan`.
 */
export function classifyRetryDomain(
  kind: LeafResult['kind'],
  failureKind: NodeFailureKind | undefined,
): RetryDomain {
  if (kind === 'command' && failureKind === 'assert-failed') return 'oracle';
  return 'generation';
}

/**
 * **「交了东西但东西不对」的失败分型** —— 只有这几格, 把「哪里不对」注回去再来一次才有意义。
 *
 * 判据是**有没有可注的东西**, 不是 `FAILURE_KIND_INFO[k].retryable`:
 * 后者回答的是「原样重试有没有可能成功」(知识), 不是「引擎该不该当场再跑一遍」(策略) ——
 * 本文件 2026-08-26 那条注已经为这个区分付过一次代价 (拿 retryable 做自动重试, 全量 11 红)。
 * 实证: `timed-out` / `stall` 的 `retryable` 都是 `true`, 而它们**没有产出可注** ——
 * 重试只会原地翻倍等待。2026-08-30 第一版把 generation 域一律给 1, 当场 6 红,
 * 其中三条 (`await` 超时 · 内环超预算 · G-3 stall) 正是原注释预言的那个害处。**测试抓得对。**
 *
 * 反过来这两格是有产出可注的:
 *   · `empty-artifact`  —— leaf 报了 done 却一个字节没写。注「你说做完了但没有产物」是具体的。
 *   · `broken-artifact` —— 产出了但形状坏。注「坏在哪」是具体的。
 *
 * ⚠ 其余一律不进: `gate-rejected` 是闸拒 (仓规: 拒了不许重试, 换合法做法或升 owner);
 * `missing-capability` 要先补东西; `dep-skip` / `spin-fused` / `rounds-exhausted` 是控制流终态;
 * `subgraph-failed` / `unclassified` 的 `retryable` 是 `null` —— **「不知道」不是「可以」**。
 *
 * 加一格之前先问: 这一格失败时, leaf 手上有没有一段**具体的、能指出哪里不对**的东西?
 * 没有就别加 —— 那就退化成「多试几次碰运气」。
 */
const REPAIRABLE_BY_CAUSE: ReadonlySet<NodeFailureKind> = new Set<NodeFailureKind>([
  'empty-artifact',
  'broken-artifact',
]);

/**
 * 预算裁决纯函数 —— 给 (域, 显式 `max_retry`, 上一次是否抛错), 回答这一轮允许的重试次数.
 *
 * ## 两条规则 (D-2 / D-3, INV-2, INV-3)
 *
 * 1. **oracle 域判否 = 阶梯终止, 越过 `max_retry`**.
 *    确定性 oracle 已经判了「不」, 再派同一条命令的结果是 retry-masking.
 *    无论声明的 `max_retry` 是几, 0 次重试, 不再衰减 —— 已有 spin 阶梯终止
 *    (engine.ts:4572 上方那一段) 是同形出口, 这里照它写.
 *
 * 2. **generation 域 = 带败因的一次重修**.
 *      · 显式 `max_retry` 压过一切 (含写 0)
 *      · 上一次抛错 → 1 (与 2026-08-30 前逐字节相同)
 *      · 没抛错但**交了东西而东西不对** (`failureKind` ∈ {@link REPAIRABLE_BY_CAUSE}) → **1** (新)
 *      · 其余 (超时 / stall / 闸拒 / 缺能力 / 控制流终态 / 分不出来) → 0, 不变
 *
 * ## 为什么 2026-08-30 给「交了东西但东西不对」补上这 1 次 (R-1, owner 裁)
 *
 * 旧语义下, 「leaf 跑完了、产出被判 failed、但没抛错」这一格拿到的预算是 **0** ——
 * 而 conductor 几乎从不写 `max_retry`, 所以这是**生产上最常见的失败形态**。
 * 后果: 一个 agent leaf 干得不对, **零节点级重修**, 直接把整张图顶到外环重画
 * (一次 conductor 规划发 + 整图重跑), 而外环拿到的信息并不比那个节点自己手上的多。
 *
 * ⚠ 关键: 这**不是**「原样再试一次碰运气」。`engine.ts` 的 `causeOf` 会把**上一次的失败
 * 输出**注入下一发的 prompt(那段机制早就建成了, 只是预算恒 0 时一次都没被用到)。
 * 所以这一次重修拿到的 context 严格多于第一次 —— 与本文件反对的 retry-masking 是两回事:
 * retry-masking 说的是**同一条确定性命令**被再派一次(那仍然是 oracle 域, 仍然 0)。
 *
 * 归因依据 (`docs/plan/2026-08-30-next-session.md` §4, 12 例 executable 真红逐例翻开):
 * 「leaf 能力不行」已被证伪 —— 红的大头是判据自己错(A=6)与否决太强(E=4)。
 * 但 B/C 两格(真·实现不动 / 修复环空转)正是这条通道该接的, 而它当时是断的。
 *
 * ⚠ **第一版切太宽了, 照实记**: 一开始写成 generation 域一律给 1, 全量 dag 片当场 **6 红**,
 * 其中三条 (`await` 超时 · 内环跑穿预算 · G-3 stall) 正是本文件 2026-08-26 那条注预言的
 * 「超时类失败会原地翻倍等待」。**测试抓得对**, 于是收窄成 {@link REPAIRABLE_BY_CAUSE} 白名单。
 *
 * **上限仍然是 1, 不是 3。** owner 提过「3 次不成 = 分解或信息问题」——
 * 那是**外环**该有的诊断规则(N 轮不成就换分解), 不是把内环预算直接调到 3。
 * 先让通道通电、量一次读数, 再谈调大: 没有读数就调到 3 属于「多试几次碰运气」,
 * 正是本文件原来那条注在防的东西。
 *
 * @param domain  RetryDomain (classifyRetryDomain 的产物)
 * @param maxRetry 节点声明的 max_retry (undefined = 未声明; 显式数值压过一切)
 * @param thrown 上一次是否抛错 (true = runNodeOnce 抛了; false = 走完了, status='failed')
 * @param failureKind 上一次的失败分型 (仅 `thrown=false` 时有意义; 缺席 = 分不出来 ⇒ 不给预算)
 * @returns 这一轮允许的额外尝试次数 (0 表示不再重试, 跳出 L0 内环)
 */
export function retryBudgetFor(
  domain: RetryDomain,
  maxRetry: number | undefined,
  thrown: boolean,
  failureKind?: NodeFailureKind,
): number {
  if (domain === 'oracle') return 0; // INV-2 · 越过 max_retry
  if (maxRetry !== undefined) return maxRetry; // 显式声明压过一切
  if (thrown) return 1; // 抛错: 与 2026-08-30 前逐字节相同
  // R-1 (2026-08-30, owner 裁): 「交了东西但东西不对」也给一次**带败因**的重修。
  // 白名单而不是全给 —— 理由见 REPAIRABLE_BY_CAUSE 与上方 §R-1。
  return failureKind !== undefined && REPAIRABLE_BY_CAUSE.has(failureKind) ? 1 : 0;
}
