/**
 * src/harness/node-failure —— **节点没过的成因词表** (P1, 2026-07-31)。
 *
 * ## 为什么要有这个文件
 *
 * `LeafResult.status` 只有 `done | failed | skipped`,而 `failed` 里至少混着**四种后续动作
 * 完全相反**的东西:
 *
 *   · 断言没成立(`exit ≠ expect_exit`)   → 再试一轮可能就好了
 *   · **闸拒**(`exit < 0`)               → 再试也没用,白名单不会因为重试而放行
 *   · 心跳停摆(provider 挂起)            → 该换池,不是该改 prompt
 *   · 产物闸判空(自报完成但零改动)        → 该重跑这个节点
 *
 * **每一种的检测都已经算出来了**(`exitCode` / `stalled` / 产物闸 / research 来源数),
 * 只是算完之后被压进同一个 `failed` —— 语义在那一刻丢掉,于是"这一跑被闸拒了几次"这种
 * 问题要去读日志重数一遍。这个文件是那一刻的挽回:**把已经算出来的判断抬成一等字段。**
 *
 * ## 两条纪律(2026-07-31 那一 session 为它们付了五次账)
 *
 * ① **每一格的判据必须是它自己的直接证据**,不许拿别的状态的补集凑。
 *    反例(真踩过):拿 `status !== 'done'` 当"闸已拒"的判据 —— 于是 `grep -qx "3000"`
 *    这种"只是没匹配上"的普通失败被标成了闸拒。
 * ② **「不知道」必须是独立的一格**,不许并进任何一侧。这里是 {@link NodeFailureKind}
 *    的 `unclassified`,以及 `retryable: null`。
 *
 * ## 与 Loop Engineering §4.4 五态的关系
 *
 * 参照但**不照抄**。书上的五态(SUCCESS/STALLED/BLOCKED/EXHAUSTED/ERROR)描述的是
 * **一次运行怎么结束的**,而这里描述的是**一个节点为什么没过** —— 前者是环级,后者是节点级。
 * 每格的 {@link FailureKindInfo.loopState} 记它往上归到五态的哪一格,归不上的老实写 `null`
 * (`dep-skip` 就是:书上没有"依赖没达 quorum 所以我不跑了"这一格,它是 DAG 特有的)。
 *
 * EXHAUSTED / 取消 **不在这个词表里**:那两个是**环级**结论(`budgetStopped` / `cancelled`),
 * 节点不会因为"预算用完"而失败 —— 它是压根没起跑。别把它们塞进来凑齐五格。
 *
 * ⚠ **2026-08-06 有一格例外,而例外的判据是"手里有没有上一次的结果"**:
 * `rounds-exhausted`。预算/取消这两条出口**都拿得出 `last`**(已跑完的轮次照原样返,
 * 只是 `converged=false`)—— 所以它们确实不构成节点失败。而内环轮数用尽的**resume 重入**
 * 手里**什么都没有**(`last` 为 null:这一次一轮都没跑),它只能返一条失败记录。
 * 那条记录是真实的节点级事件,不是环级结论的替身。
 */

/**
 * 节点没过的成因。**每一格都有自己的直接判据**(见 {@link FAILURE_KIND_INFO} 的 `evidence`)。
 *
 * ⚠ 加新格之前先回答两个问题:① 它的直接证据是什么(不是"排除了别的")
 * ② 拿到它的人/回路要做的事,跟现有哪一格都不一样吗 —— 一样就别加,归进去。
 */
export type NodeFailureKind =
  /** command leaf 退出码 ≥0 但 ≠ `expect_exit`:断言没成立。 */
  | 'assert-failed'
  /**
   * **命令超时,没跑出判词**(2026-08-07,X-4)。直接证据:退出码 `124` 且 ≠ `expect_exit`
   * —— 那是 omd 自己在 `command-leaf.ts` 的 `Promise.race` 里设的超时哨
   * (也是 GNU `timeout(1)` 的标准码,所以命令自带 `timeout` 时同样落这里,处置相同)。
   *
   * ## 为什么必须与 `assert-failed` 分开
   *
   * 两者的**读法正相反**。`assert-failed` 说「被测的东西给出了错答案」→ 去看代码。
   * 这一格说「**没有答案**」→ 代码可能一个字都没问题,缺的是时间。
   * 把后者读成前者,一次环境抖动就被记成一次真回归;而闸一旦拿"真回归"当理由拦,
   * 它就再也解不开 —— **混同的代价是死锁,不是误报**。
   *
   * ⚠ **别把这一格扩成"环境问题都归它"**。它只认**退出码本身排他地表示没跑成**的那个码。
   * 「DB 没起 / 端口占用 / 网络抖」照样从测试框架里出 `exit 1`,与断言失败**在退出码上
   * 不可分** —— 那部分只能靠写图的人显式分开(拆一个探活 command 节点当依赖),
   * 引擎替不了。**宁可窄而准,不靠输出正则去猜。**
   *
   * ⚠ 命令找不到 / 不可执行(`127` / `126`)**不在这一格**:它们的下一步与
   * `missing-capability` 逐字相同(别重试,补上缺的东西再跑),按本文件的规则 ② 归了进去。
   */
  | 'timed-out'
  /** command leaf 退出码 <0:command-leaf 的闸拒(白名单/元字符/git 写/危险命令)。 */
  | 'gate-rejected'
  /** agent leaf 心跳闸判 provider 挂起(`AgentLeafResult.stalled`)。 */
  | 'stall'
  /**
   * agent leaf 空转熔断(2026-08-14):drift fuse 判累计空转过硬阈值 → 循环硬停。
   * 与 `stall` 分开:stall 是 provider 没反应(换池有用),这格是模型在**有反应地原地打转**
   * (换池没用,重试大概率原地再烧一遍)—— 两者的下一步正好相反。
   * 阈值依据 2026-08-13 夜 + 2026-08-03 live 读数,见 drift-detector 的 fuse 注。
   */
  | 'spin-fused'
  /** 产物闸:写文件节点 `filesTouched` 空,或声称的产物不在盘上(empty-done)。 */
  | 'empty-artifact'
  /**
   * **写后即验没过**:产物在盘上,但**语法解析不通过**(2026-08-16,issue #145 提议 1)。
   *
   * 过①「跟现有哪一格都不一样吗」:与 `empty-artifact` 的**证据**相反 —— 那一格是"什么都没写",
   * 这一格是"写了,写坏了"。过②「下一步一样吗」:也不一样,而这才是分格的理由 ——
   * `empty-artifact` 的处置是「重跑这个节点」,这一格的处置是**「点名的文件整段重写」**。
   * plana run B/C 的读数直接支持这条区分:在坏掉的文本上继续打补丁是 58 个语法错的来源,
   * 而「读全文 → 重写全文」那一刀 18 → 0。
   */
  | 'broken-artifact'
  /** research leaf 零来源:没有任何真 URL 抓取痕迹(假 grounded)。 */
  | 'no-sources'
  /** 配置面缺件:没有 agentRunner/commandRunner/researchRunner,或 attach_media 无可用媒体。 */
  | 'missing-capability'
  /** 基础设施异常:节点抛错 / 子图展开失败 / map lister 失败 / primitive 编译失败。 */
  | 'infra-error'
  /** 依赖未达 `requires` quorum → 级联跳过(D-7v2)。恒伴随 `status: 'skipped'`。 */
  | 'dep-skip'
  /**
   * conductor 节点的子图**一个都没成**(`ok === 0`)。节点自己没毛病,坏的是它画出来的那些步。
   *
   * 这一格是**读数板自己点出来的**(2026-07-31 live:`execute` 与 `contract` 两个 conductor
   * 节点落进 `unclassified`)—— 那正是 `unclassified` 该起的作用:它不是垃圾桶,是一个指着
   * "这里还有条没交代的失败路径"的指针。
   */
  | 'subgraph-failed'
  /**
   * **内环轮数已用尽,而这次重入一轮都没跑**(2026-08-06)。
   *
   * 直接证据:`journal.completedRounds + 1 > node.max_rounds` 且 `last === null`(零执行)。
   *
   * ## 为什么它必须与 `infra-error` 分开
   *
   * 盘上实测:10 条 `infra-error` 里 **9 条是这一格**,而且是**同一个 run 的同一个节点**
   * 在 8 小时里被重入 9 次、每次 **0–1ms** 死在同一行。而 `infra-error` 的判词写着
   * 「重试 / 换池」—— 对这一格**重试一万次都是同样的 0ms 死**,两者的下一步正好相反。
   * 更坏的是 `run-outcome` 让 `infra-error` **优先念**(止损以最强那条为准),
   * 于是整跑的结论被报成"引擎出事",而真相是"这个节点在本 run 里已经没有轮次可用了"。
   *
   * ⚠ **它只在 resume 路径上出现**:journal 只有 `continuity.resume` 时才加载。
   */
  | 'rounds-exhausted'
  /**
   * **「不知道」的那一格**:节点没过,但没有任何生产点标注成因。
   *
   * 它**不是**兜底垃圾桶,是一个可以被数出来的缺陷指标 —— 读数板上它非零,意思是
   * "引擎里还有一条失败路径没交代自己是怎么回事",那正是该去补标注的地方。
   * ⚠ 与"字段整个缺席"不是一回事:缺席 = 早于 2026-07-31 的记录(**没记**);
   * `unclassified` = 记了,但归不了类。合成一个会把老数据读成新缺陷。
   */
  | 'unclassified';

export interface FailureKindInfo {
  /**
   * 往 Loop Engineering §4.4 五态归到哪一格。`null` = 书上没有对应格(别硬凑)。
   * `'UNKNOWN'` 是 `unclassified` 专用 —— 它连"归不上"都算不上,是"还没人判过"。
   */
  loopState: 'STALLED' | 'BLOCKED' | 'ERROR' | 'UNKNOWN' | null;
  /** **判成这一格的直接证据**。读的时候当契约看:证据变了,这一格的含义就变了。 */
  evidence: string;
  /** 拿到这一格的人/回路该做什么。两格的这一句一样 → 它们大概该合并。 */
  nextAction: string;
  /**
   * 原样重试有没有用。**`null` = 不知道**(唯一取 null 的是 `unclassified`)——
   * 这一位刻意是三态而不是布尔:把"不知道"记成 false 会让 heal 回路白白放弃一个本可重试的节点。
   */
  retryable: boolean | null;
}

/**
 * 词表的**唯一定义处**。读数板、heal 回路、人,都从这里读语义,不各自在自己那边重写一份
 * (重写两份必然漂,而漂了之后没人知道哪份对)。
 */
export const FAILURE_KIND_INFO: Record<NodeFailureKind, FailureKindInfo> = {
  'assert-failed': {
    loopState: 'STALLED',
    evidence: 'command leaf 退出码 ≥0 且 ≠ expect_exit',
    nextAction: '再试一轮可能就好 —— 断言本身可能对,只是这次没成立',
    retryable: true,
  },
  'timed-out': {
    // STALLED 而非 ERROR: 引擎本身没出事, 是这一步没走完 (同 assert-failed 的环级归属)。
    loopState: 'STALLED',
    evidence: 'command leaf 退出码 124 (超时哨) 且 ≠ expect_exit',
    nextAction:
      '**先别读成回归** —— 没跑完不等于跑出了错答案。看超时上限与这条命令的真实耗时, ' +
      '重试或调高上限;⚠ **不要**去改被测代码,它这一次根本没被测到',
    retryable: true,
  },
  'gate-rejected': {
    loopState: 'BLOCKED',
    evidence: 'command leaf 退出码 <0(command-leaf 闸拒,命令未执行)',
    nextAction: '**别重试** —— 白名单不会因为重试而放行;换一条合法命令,或升 owner 改白名单',
    retryable: false,
  },
  stall: {
    loopState: 'ERROR',
    evidence: 'agent leaf 心跳闸提前中止(AgentLeafResult.stalled)',
    nextAction: '换池 / 重试 —— 是 provider 侧的事,不是 prompt 的事',
    retryable: true,
  },
  'spin-fused': {
    loopState: 'STALLED',
    evidence: 'agent leaf 空转熔断(drift fuse: 累计 spin 回合或同签名深度过硬阈值,软注入没拉回来)',
    nextAction:
      '**别原样重试** —— 同 prompt 同上下文大概率原地再空转一遍。看 stuckSigs 卡在什么上:' +
      '任务书缺信息就补信息,工具被闸拦就先解闸,再不行拆小这一步',
    retryable: false,
  },
  'empty-artifact': {
    loopState: 'STALLED',
    evidence: '产物闸: filesTouched 空,或声称的产物不在盘上',
    nextAction: '重跑这个节点(它自报完成但盘上没有对应改动)',
    retryable: true,
  },
  'broken-artifact': {
    loopState: 'STALLED',
    evidence: '写后即验: 节点写完之后, 它写过的文件语法解析不通过(部分写入: 新旧内容并存 / 括号错位)',
    nextAction:
      '把判词点名的文件**整段重写**(读全文 → 重写全文), **别在坏掉的文本上继续打补丁** —— ' +
      '补丁式修复正是这类损坏的来源。文件坏了不是"内容不够好", 下游一切判断在修好之前都不作数',
    retryable: true,
  },
  'no-sources': {
    loopState: 'STALLED',
    evidence: 'research leaf 返回的 sources 为空',
    nextAction: '重跑 / 换检索式 —— 零来源的报告是模型记忆,不是检索结果',
    retryable: true,
  },
  'missing-capability': {
    loopState: 'BLOCKED',
    // 2026-08-07 (X-4) 加了第二条证据路径: 退出码 127/126。同一格盖两条路径是允许的
    // (`infra-error` 早有先例), 判据是**下一步一样** —— 两者都是"补上缺的东西再跑, 重试无用"。
    evidence:
      '配置面缺件(无 agentRunner/commandRunner/researchRunner,或 attach_media 无可用媒体);' +
      '或 command leaf 退出码 127/126(命令找不到 / 不可执行 —— 它压根没被执行)',
    nextAction: '**别重试** —— 缺的是能力不是运气;补配置/装依赖/修 PATH/补上游产物再跑',
    retryable: false,
  },
  'infra-error': {
    loopState: 'ERROR',
    evidence: '节点抛错 / 子图展开失败 / map lister 失败 / primitive 编译失败',
    nextAction: '重试 / 换池;连续同因则是引擎缺陷,该看栈',
    retryable: true,
  },
  'dep-skip': {
    loopState: null,
    evidence: "status='skipped': 依赖失败未达 requires quorum(D-7v2)",
    nextAction: '看上游 —— 这个节点自己没有毛病,零执行零花费',
    retryable: false,
  },
  'subgraph-failed': {
    loopState: null,
    evidence: 'conductor 子图 0 个子节点成功',
    nextAction: '去看**子节点**的成因 —— 它们各自已经归好类了; 这个节点的下一步等于它们的下一步',
    // 聚合体的可重试性是它各部分的函数, 单看这一格答不了 —— 所以是 null 而不是拍一个 true/false。
    retryable: null,
  },
  'rounds-exhausted': {
    loopState: 'BLOCKED',
    evidence: '内环 journal 的 completedRounds 已达 max_rounds, 本次重入零执行 (last === null)',
    nextAction:
      '**别原样重试** —— 重试恒 0ms 同样死。两条出口二选一: ① 调高该节点的 `max_rounds` ' +
      '(schema 上界 4) ② 删掉这一跑该节点的内环 journal `<runDir>/_loop-<nodeId>.json` 让轮次归零。' +
      '⚠ 先想清楚要哪一个: ① 是"再给它几轮", ② 是"忘掉之前几轮的毒集与上轮原因重头来"。',
    retryable: false,
  },
  unclassified: {
    loopState: 'UNKNOWN',
    evidence: '节点没过,但生产点没有标注成因',
    nextAction: '**去补标注** —— 这个数非零说明引擎里还有一条没交代自己的失败路径',
    retryable: null,
  },
};

/**
 * omd 自己的超时哨(`command-leaf.ts` 的 `Promise.race`);也是 GNU `timeout(1)` 的标准码。
 *
 * ⚠ **不许往 X-4 这条路上加"看着像环境问题"的码**。加之前要能回答:
 * 「这个码本身是否**排他地**表示没跑成?」`1` / `2` 答不了(测试框架用它们报断言失败),
 * 所以它们永远不进来 —— 那正是这条判据窄而准的代价与价值。
 */
export const TIMEOUT_EXIT = 124;

/**
 * **命令根本没被执行**的 POSIX 退出码:`127` 找不到,`126` 找到了但不可执行。
 * 归 `missing-capability` 而不是自成一格 —— 下一步与它逐字相同(别重试,补上缺的东西再跑)。
 */
export const NOT_EXECUTED_EXITS: ReadonlySet<number> = new Set([126, 127]);

/**
 * command leaf 退出码 → 成因。**三格各有自己的直接证据,没有一格是别人的补集**
 * (这条纪律见文件头 ①,曾为它付过账)。
 *
 * ⚠ 调用前提:调用方已判定 `!ok`(即 `exitCode !== expect_exit`)。所以一个把
 * `expect_exit` 显式写成 124/127 的节点**到不了这里** —— 它命中期望就是 done,
 * 这一格不会去抢它。
 */
export function classifyCommandExit(exitCode: number | null): NodeFailureKind {
  // `null` = 死于信号 (没有主动退出码, H5-1) ⇒ 跑了但没跑完、没有判词 —— 与 124 同一格。
  // 刻意不先编一个数再去分类: 那正是「三字段互不推断」要禁的那一步。
  if (exitCode === null) return 'timed-out';
  if (exitCode < 0) return 'gate-rejected'; // command-leaf 闸拒: 命令未执行
  if (exitCode === TIMEOUT_EXIT) return 'timed-out'; // 跑了但没跑完: 没有判词
  if (NOT_EXECUTED_EXITS.has(exitCode)) return 'missing-capability'; // 压根没执行: 缺可执行文件
  return 'assert-failed'; // 跑了, 判词是"不对"
}

/** 词表全序(读数板按它出分布;确定性顺序,免得每次跑出来的表行序不一样)。 */
export const FAILURE_KIND_ORDER = Object.keys(FAILURE_KIND_INFO) as NodeFailureKind[];

/**
 * **归一化闸**:任何 `status !== 'done'` 的结果都必须带 `failureKind`,没带的显式补
 * `unclassified`。
 *
 * 为什么是显式补而不是让字段缺席:缺席在下游读起来跟"这条记录早于本次改动"一模一样,
 * 而那两件事的结论相反(前者是**引擎缺陷**,后者是**老数据**)。补一个可数的词,
 * 才能让读数板把它们分开念 —— 同 `writeCounts` 缺席 vs `[0,0]` 的那条纪律。
 *
 * 纯函数、不改入参:settle 与测试共用同一份判断,不各写一遍。
 */
/**
 * **给下游读者的失败告示**(A5 sensor 措辞普查, 2026-07-31)。
 *
 * 治的是一条实证过的静默失真: fan-in 场景下 (`requires: 'any'`, 一个前驱没过另一个过了),
 * 没过的那个**照样**被注入下游 leaf 的 `Predecessor outputs`, 而且**不带任何标记**。
 * 探针抓到的两种形态都坏, 后一种更坏:
 *
 *   ① 前驱输出为空 → 下游看到一个空标题, 与"产出为空但有效"**不可分**;
 *   ② 前驱是 empty-artifact → 注入的是 `[产物校验失败: …] 原输出: 我把文件写好了, 内容是三条建议`
 *      —— 下游拿到的是那个节点**自报完成的假话**, 摆在 "Predecessor outputs" 底下。
 *
 * 而 leaf prompt 的末尾恰好写着 "do NOT fabricate data, results, or inputs you were not given"
 * —— 读者无从知道**这段正是它没真拿到的那个输入**。措辞对不对之外还得问的那句
 * "它的读者拿它做得了什么", 在这里的答案此前是: **什么也做不了, 而且更可能照着假话往下写。**
 *
 * 所以告示给的是**三条可执行的指令**(别引用 / 别转述 / 缺什么就如实写), 不是一句状态播报。
 * 成因一并给出: 对下游的动作没影响 (都是"不能用"), 但它进产出里那句"缺了什么"时有用。
 */
export function upstreamFailureNotice(id: string, kind: NodeFailureKind | undefined, status: string): string {
  const why = kind ? `${kind} — ${FAILURE_KIND_INFO[kind]?.evidence ?? ''}` : status;
  return (
    `[⚠ 前驱 ${id} 未通过 (${why})。下面这段是引擎的判词或它没完成的半成品, **不是可用的材料** —— ` +
    '不要引用它、不要转述它、更不要把它自报的完成当真。你的产出若依赖这个前驱, ' +
    '就在产出里如实写明缺了哪一块, 不要替它补。]'
  );
}

export function withFailureKind<T extends { status: string; failureKind?: NodeFailureKind }>(
  r: T,
): T & { failureKind?: NodeFailureKind } {
  if (r.status === 'done' || r.failureKind) return r;
  return { ...r, failureKind: 'unclassified' as const };
}
