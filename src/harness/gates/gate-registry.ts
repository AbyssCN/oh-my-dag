/**
 * src/harness/gates/gate-registry.ts —— 「判生死的图级闸」登记 + 对账闸
 *
 * 表只登记稳定 id；判词原文从引擎源码里的 id 化判词串派生。这样改文案不再要求同步抬表，
 * 同一 id 的多个出口也不需要维护脆弱的出现次数。
 *
 * 多前缀多源码：每条 {@link GateEntry} 自带 {@link GateEntry.file}（默认引擎侧）
 * + 可选 {@link GateEntry.prefix}（默认 {@link VERDICT_PREFIX}）。扫描器按 entry 自己的
 * (file, prefix) 扫 —— 一份源码里同时混多前缀、或一份源码只装一种前缀都行。旧调用方
 * 传字符串等价于「把同一份源码放在所有 entry.file 下」，对仍然只走 engine.ts + VERDICT_PREFIX
 * 的既有 12 条而言字节等价。
 */

/** 引擎侧判词前缀。完整形状为 `[omd/executor-dag][<id>] <原文>`。 */
export const VERDICT_PREFIX = '[omd/executor-dag]';

export interface GateEntry {
  id: string;
  family: string;
  file: string;
  /** 该 entry 的判词前缀；缺省走引擎侧 {@link VERDICT_PREFIX}。 */
  prefix?: string;
}

/** 判生死的图级闸；一道闸可能在多个出口打印同一条 id 化判词。 */
export const GATE_REGISTRY: readonly GateEntry[] = [
  {
    id: 'artifact-empty',
    family: '产物闸',
    file: 'src/harness/dag/engine.ts',
  },
  {
    id: 'artifact-verdict',
    family: '产物闸',
    file: 'src/harness/dag/engine.ts',
  },
  {
    id: 'artifact-broken',
    family: '产物闸',
    file: 'src/harness/dag/engine.ts',
  },
  {
    id: 'heartbeat',
    family: '心跳闸',
    file: 'src/harness/dag/engine.ts',
  },
  {
    id: 'fuse-action',
    family: '空转熔断',
    file: 'src/harness/dag/engine.ts',
  },
  {
    id: 'fuse-judge',
    family: '空转熔断',
    file: 'src/harness/dag/engine.ts',
  },
  {
    id: 'fuse-spin',
    family: '空转熔断',
    file: 'src/harness/dag/engine.ts',
  },
  {
    id: 'fuse-samecause',
    family: '空转熔断',
    file: 'src/harness/dag/engine.ts',
  },
  {
    // #249 (2026-08-25): 败因类别瘫痪绊线 —— 全员越权写/空产出时不开重规划轮。
    id: 'fuse-paralysis',
    family: '空转熔断',
    file: 'src/harness/dag/engine.ts',
  },
  {
    // S2 (2026-08-25, 片 3): 节点级空转档 2 阶梯终止 —— 档 1 与档 2 均命中空转口径,
    // 越过剩余 max_retry 预算, 节点直接判 failed + spinLadderReport 进 LeafResult。
    // 与 fuse-spin 同源 (同 spin-fused 信号), 但分两条登记: 闸面是不同动作 —
    // fuse-spin = 单次 attempt 熔断; spin-rung2-ladder = 阶梯用尽终止, 节点级收尾。
    id: 'spin-rung2-ladder',
    family: '空转熔断',
    file: 'src/harness/dag/engine.ts',
  },
  {
    id: 'oracle-exit-miss',
    family: 'expect_exit',
    file: 'src/harness/dag/engine.ts',
  },
  {
    id: 'oracle-exit-scope',
    family: 'expect_exit',
    file: 'src/harness/dag/engine.ts',
  },
  {
    id: 'writescope-drop',
    family: '写域越界',
    file: 'src/harness/dag/engine.ts',
  },
  {
    id: 'false-completion',
    family: '谎报完成',
    file: 'src/harness/dag/engine.ts',
  },
  {
    // O-6 (2026-08-11 二发教训): RED 的前提是切片 verify 在实装前是红的 —— 引用既有绿测试时
    // 结构性不成立。run-goal 的 vacuous 探针: 已绿 = 判据虚 / 活已干完, 都进 v1 回落。
    // 前缀 [run-goal] 而非引擎侧 —— 因为这是 goal 层的判词, 不归 dag.ts 的 12 道闸管。
    id: 'o6-vacuous-verify',
    family: 'acceptance-oracle',
    file: 'src/harness/goal/run-goal.ts',
    prefix: '[run-goal]',
  },
];

/** 转义正则元字符 —— 仅用于把动态 prefix 内容注入字面量正则文本。 */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 按 entry 自己的 prefix 拼正则。prefix 可带方括号（如 `[omd/executor-dag]`）也可裸
 * 文本（如 `omd/executor-dag`）—— 内部统一剥掉外层方括号再 escape。
 *
 * 文本除前缀段外与旧硬编码那条逐字符等价：捕获组编号 1=引号 / 2=id / 3=原文 不变,
 * g flag 保留。id 字符类从旧 `[a-z-]+` 放宽到 `[a-z0-9-]+` —— O-6 `o6-vacuous-verify`
 * 含数字; 老 12 条只用 `[a-z-]`, 放宽后仍能命中, 无回归。
 */
function buildGateVerdictRegex(prefix: string): RegExp {
  const inner = prefix.startsWith('[') && prefix.endsWith(']') ? prefix.slice(1, -1) : prefix;
  return new RegExp(
    `(['"\`])\\[${escapeRegex(inner)}\\]\\[([a-z0-9-]+)\\]((?:\\\\.|(?!\\1)[^\\\\\\r\\n])*)\\1`,
    'g',
  );
}

/**
 * 从源码里的 id 化字符串字面量派生 id → 判词原文；重复 id 直接归入同一 Map 项。
 *
 * 支持两形：
 *  - `string`：等价于把所有 entry.file 都指同一份源码（既有 12 条行为字节等价）。
 *  - `Record<file, source>`：按 entry.file 取源码；文件缺失 = 该 entry 不扫。
 * 同一 (file, prefix) 组合只 matchAll 一次 —— 重复 entry 共用一次扫描结果。
 * 跨 entry 的重复 id = 后写覆盖前写（GATE_REGISTRY 顺序保证既有 12 条先于 O-6）。
 */
export function scanGateVerdicts(
  input: string | Readonly<Record<string, string>>,
): Map<string, string> {
  const verdicts = new Map<string, string>();
  const legacySource = typeof input === 'string' ? input : null;
  const sources = typeof input === 'string' ? null : input;

  const seen = new Set<string>();
  for (const entry of GATE_REGISTRY) {
    const prefix = entry.prefix ?? VERDICT_PREFIX;
    const key = `${entry.file}\0${prefix}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const regex = buildGateVerdictRegex(prefix);
    const source = legacySource !== null ? legacySource : (sources?.[entry.file] ?? '');
    for (const match of source.matchAll(regex)) {
      verdicts.set(match[2]!, match[3]!.trim());
    }
  }
  return verdicts;
}

/**
 * **覆盖欠账**（片 5c，2026-08-23）—— 还没有「它真的开火过」用例的闸。
 *
 * 判据是 {@link gateCoverage}：一道闸算被覆盖，当且仅当**某个测试文件里出现
 * `[<prefix>][<id>]` 这个整串**。它只可能来自捕获到的判词，所以这是
 * **运行时**证据，不是「测试里提过这个词」——`expect_exit` 这种词在 35 个测试文件里
 * 出现过，co-occurrence 证明不了任何事（实测，2026-08-23）。
 *
 * ⚠ **这些闸不是没测过**：它们在**行为面**都有用例（断言 `failureKind` / 节点状态）。
 * 缺的是「**这个测试覆盖的是哪道闸**」这条链**不可机读** —— 于是一道闸被改到走不到时，
 * 没有任何东西会红。
 *
 * ⚠ **值 = 为什么还没覆盖**（照 `reachability.test.ts` 的 `DYNAMIC_ENTRIES` 规矩：
 * 写不出这句话 = 它不该待在名单里）。**名单只许缩不许涨** —— 由
 * `gate-registry.test.ts` 的绊线钉住。
 */
export const COVERAGE_DEBT: Readonly<Record<string, string>> = {
  'artifact-broken': '写后即验只在 leaf 写出语法不合法的文件时触发；现有用例走的是 oracle-red 路径，没捕判词。',
  heartbeat: '心跳闸要一个真停摆的 leaf；现有 17 个文件断言的是 watchdog 字段与节点状态，不是判词。',
  'fuse-action': '动作级熔断要在环里重复同一动作到阈值；`repeated-action.test.ts` 测的是纯件判据，不起引擎。',
  'fuse-judge': '闸级熔断要连撞 judge 失败到阈值；现有用例在 conductor 环层，没捕引擎判词。',
  'fuse-spin': '空转熔断要 leaf 在工具循环里空转到阈值；现有用例断言 `spinFused` 字段。',
  'fuse-samecause': 'D-6 同因熔断要连撞同一根因两轮；现有用例断言的是重规划结果，不是判词。',
  'oracle-exit-miss': 'command 节点未命中 expect_exit —— 35 个文件提到 expect_exit，但没有一个捕判词。',
  'oracle-exit-scope': '这一条是 fail-open 提示（非 command 节点忽略 expect_exit），今天连行为面用例都没有。',
  'writescope-drop': '写域外剔除只在 leaf 报写域外绝对路径时触发；`artifact-scope.test.ts` 断言的是 `outOfScope` 字段。',
  'false-completion': 'D-4 谎报完成闸要「声称完成 ∧ 校验命令实败」同时成立；9 个文件提到它，没有一个捕判词。',
};

/**
 * 覆盖对账：哪些登记的闸**有**「真开火过」的用例，哪些没有。
 *
 * @param testSources 测试文件全文（调用方读盘；本函数**纯**，于是判别力可注入验）。
 */
export function gateCoverage(testSources: readonly string[]): {
  covered: string[];
  uncovered: string[];
} {
  const covered: string[] = [];
  const uncovered: string[] = [];
  for (const entry of GATE_REGISTRY) {
    const marker = `${entry.prefix ?? VERDICT_PREFIX}[${entry.id}]`;
    (testSources.some((src) => src.includes(marker)) ? covered : uncovered).push(entry.id);
  }
  return { covered, uncovered };
}

/** 对账登记 id 与源码 id；不读盘，也不把重复出现次数当成漂移。
 *
 * 入参形态同 {@link scanGateVerdicts}：字符串（既有 12 条走单源，行为字节等价）
 * 或 `Record<file, source>`（按 entry.file 分源）。
 */
export function reconcileGateIds(
  input: string | Readonly<Record<string, string>>,
): {
  missing: string[];
  unregistered: string[];
  empty: string[];
} {
  const verdicts = scanGateVerdicts(input);
  const registered = new Set(GATE_REGISTRY.map((entry) => entry.id));

  return {
    missing: GATE_REGISTRY.filter((entry) => !verdicts.has(entry.id)).map((entry) => entry.id),
    unregistered: [...verdicts.keys()].filter((id) => !registered.has(id)),
    empty: [...verdicts].filter(([, verdict]) => verdict.length === 0).map(([id]) => id),
  };
}