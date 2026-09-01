/**
 * harness/invariants —— **运行期**不变量登记表。
 *
 * 为什么存在: 本仓 `src/` 里 `INV-` 出现 3000+ 次, **一次都不是代码** —— 一条不变量写在
 * 注释里, 违反它的那一刻没有任何东西会红。本模块只做一件事: 让那一小撮**必须在生产
 * 运行期成立、而今天只有注释在守**的, 从散文变成会抛的闸, 并且抛出来的话里带得上归属。
 *
 * ⚠ **这不是第二套测试。** 收不收一条, 判据只有一个:
 *   - 静态 / 结构性的性质 (「executor-dag 不 import 执行实现」「这个函数零 IO」) —— 一个
 *     单测就钉得死, 那是**测试**的地盘, 不许搬进来, 搬进来就是同一条守两遍;
 *   - 只有在真跑起来、手里拿着**运行时才存在的那个值**时才判得了的性质 —— 这里。
 *   判别问句: 「这条能不能在不跑生产代码的前提下钉死?」能 → 写测试, 别登记。
 *
 * ## 三样
 *
 * **① 注册 (归属可追溯)** —— `registerInvariant` 在**登记方自己的模块顶层**调用;
 *   `module` 写包内路径 (`plan/map-expand` 这种), 违约消息按它报, 不从调用栈里猜。
 *   同一 `module::id` 注册两次 = 加载期即抛: 这份表要当「运行期到底守着哪几条」的真源,
 *   重名会让表说谎, 而表说谎比没有表更坏。
 *
 * **② 求值 (时机不在本模块定)** —— 本模块**不排期、不定时、不挂钩子**。由持有值的那一段
 *   在「值刚构造完、还没离开构造点」的位置显式 `assert`。理由: 那是唯一一个既拿得到完整
 *   值、又还来得及不让坏值扩散的位置。晚一格 (值已写进图 / 写进账) 就只剩事后取证,
 *   而事后取证正是这 3000 条注释今天的处境。
 *
 * **③ 响应 (只有 fail-closed 一档)** —— 违反即抛 {@link InvariantViolationError}。
 *   对应本仓分层的 **① 边界: 任务内机械强制, fail-closed**。当前登记项全部位于构造点出口,
 *   抛出去的语义是「这一次构造失败」, 由调用方**既有**的失败路径接住 (map 展开抛 →
 *   `engine.ts` 的 `runNode(...).catch(failedFromThrow)` → 该节点 failed, 败因原样留在
 *   causeNote 里), 不会炸掉整个 run。
 *   ⚠ **故意没有 fail-open (④ 告知) 那一档**: 今天一条登记项都不需要它。等真有一条落在
 *   收尾路径上 (抛会毁掉本来救得回的产出) 再加 —— 现在造出来就是没人要的灵活性。
 *
 * ## 零性能回归 —— 怎么保证的
 * `assert` 的固定开销 = 一次函数调用 + 一次 `check` 调用。**热路径上不查表**:
 * `registerInvariant` 返回句柄, 调用方直接持有 spec, 没有 Map 查找、没有字符串拼接、
 * 没有 try/catch 包裹; 消息拼接只发生在**已经违约**的那一次 (那一次要抛, 不在乎)。
 * 真实开销全在各登记项自己的 `check` 里 —— 每条登记项的注释必须自己交代量级, 并说明
 * 它相对同一格里已有的开销是不是噪声。
 */

/** 一条运行期不变量的登记项。 */
export interface InvariantSpec<T> {
  /** 编号, 与源码注释里那条 `INV-*` **逐字一致** —— 对得上才追得回它的来历与 SDD。 */
  readonly id: string;
  /** 登记方归属, 包内路径形 (如 `plan/map-expand`)。违约消息按这个报。 */
  readonly module: string;
  /** 违反了会**静默**成什么样 —— 一句话, 直接进违约消息 (读消息的人不必回来读源码)。 */
  readonly why: string;
  /**
   * 成立返 `null`; 违反返**一行证据**。
   * ⚠ 证据必须含足以定位的具体值 (哪个 id / 哪两条撞了 / 实际数是多少), 只说「违反了」
   * 等于把「fail-open 不许吞证据」那条坑换个地方再踩一遍。
   */
  readonly check: (subject: T) => string | null;
}

/** 违约。消息形如 `[invariant] plan/map-expand · INV-U2 违反: <证据> —— <why>`。 */
export class InvariantViolationError extends Error {
  constructor(
    readonly spec: InvariantSpec<unknown>,
    readonly evidence: string,
  ) {
    super(`[invariant] ${spec.module} · ${spec.id} 违反: ${evidence} —— ${spec.why}`);
    this.name = 'InvariantViolationError';
  }
}

/** 注册后拿到的句柄 —— 调用方直接持有, 求值时零查表。 */
export interface Invariant<T> {
  readonly spec: InvariantSpec<T>;
  /** 违反即抛 (fail-closed)。成立时除一次 `check` 调用外零开销。 */
  assert(subject: T): void;
}

const registered = new Map<string, InvariantSpec<unknown>>();

/**
 * 登记一条运行期不变量。**在登记方模块顶层调用**, 返回句柄供该模块自己 `assert`。
 *
 * @throws 同一 `module::id` 重复登记 (加载期响亮失败, 见模块注释 ①)。
 */
export function registerInvariant<T>(spec: InvariantSpec<T>): Invariant<T> {
  const key = `${spec.module}::${spec.id}`;
  const prev = registered.get(key);
  if (prev !== undefined)
    throw new Error(
      `[invariant] ${key} 重复登记 —— 登记表是「运行期守着哪几条」的真源, 重名会让它说谎。` +
        `已在册的那条: ${prev.why}`,
    );
  registered.set(key, spec as InvariantSpec<unknown>);
  return {
    spec,
    assert(subject: T): void {
      const evidence = spec.check(subject);
      if (evidence !== null) throw new InvariantViolationError(spec as InvariantSpec<unknown>, evidence);
    },
  };
}

/**
 * 在册清单快照 (按 `module::id` 升序)。存在的理由: 「运行期到底守着哪几条」必须是**可枚举**的,
 * 否则这份表和那 3000 条注释没有区别 —— 都得靠人去 grep 才知道有什么。
 */
export function listInvariants(): InvariantSpec<unknown>[] {
  return [...registered.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, spec]) => spec);
}
