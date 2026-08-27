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
 * 预算裁决纯函数 —— 给 (域, 显式 `max_retry`, 上一次是否抛错), 回答这一轮允许的重试次数.
 *
 * ## 两条规则 (D-2 / D-3, INV-2, INV-3)
 *
 * 1. **oracle 域判否 = 阶梯终止, 越过 `max_retry`**.
 *    确定性 oracle 已经判了「不」, 再派同一条命令的结果是 retry-masking.
 *    无论声明的 `max_retry` 是几, 0 次重试, 不再衰减 —— 已有 spin 阶梯终止
 *    (engine.ts:4572 上方那一段) 是同形出口, 这里照它写.
 *
 * 2. **generation 域 = 现行语义, 逐字节不变**.
 *    `timed-out` / `gate-rejected` / `missing-capability` / `infra-error` / agent stall 等
 *    都是「没说话」或「非确定性失败」, 走:
 *      · 显式 `max_retry` 压过一切 (含写 0)
 *      · 上一次抛错 (thrown !== undefined) → 给 1 次
 *      · 其余一律 0
 *    这条语义就是 engine.ts:4473-4474 的 `budgetFor` 的**逐字节抄写**,
 *    S3 的 IMPL 期把那个 `budgetFor` 的 body 换成对本函数的调用 —— 这里
 *    把语义冻结在一处, 便于测试直接攻击函数边界.
 *
 * @param domain  RetryDomain (classifyRetryDomain 的产物)
 * @param maxRetry 节点声明的 max_retry (undefined = 未声明; 显式数值压过一切)
 * @param thrown 上一次是否抛错 (true = runNodeOnce 抛了; false = 走完了, status='failed')
 * @returns 这一轮允许的额外尝试次数 (0 表示不再重试, 跳出 L0 内环)
 */
export function retryBudgetFor(
  domain: RetryDomain,
  maxRetry: number | undefined,
  thrown: boolean,
): number {
  if (domain === 'oracle') return 0; // INV-2 · 越过 max_retry
  if (maxRetry !== undefined) return maxRetry; // 显式声明压过一切
  return thrown ? 1 : 0; // 与 engine.ts:4473-4474 逐字节相同
}
