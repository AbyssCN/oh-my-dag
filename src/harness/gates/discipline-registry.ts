/**
 * src/harness/gates/discipline-registry.ts ——
 * **`.claude/CLAUDE.md` 的纪律 ↔ 闸** 对账表(2026-08-23,owner 要求把「哪些纪律没闸」变成可机读)。
 *
 * ## 为什么要这张表
 *
 * 本仓的判据是「**能做成会红的闸就别写在散文里**」。但直到今天,「**哪些纪律还只是散文**」
 * 这件事本身只存在于人脑里 —— 我手工对了一次账,对完就没了,下次还得再对一遍。
 * 那正是 `GATE_REGISTRY` / `COVERAGE_DEBT` 已经解决过的形状:**登记 + 逐条写明欠账理由 +
 * 绊线只许缩**。这张表把同一套办法用到纪律层。
 *
 * ## 两类,各自的判据
 *
 * - `gate` —— 指向一个**真实存在的文件**。文件没了 = 这张表在撒谎,当场红。
 * - `prose` —— **必须写明为什么还没有闸**(照 `COVERAGE_DEBT` / `DYNAMIC_ENTRIES` 的规矩:
 *   写不出这句话,它就不该待在名单里)。名单**只许缩不许涨**。
 *
 * ⚠ 这张表**不是 CLAUDE.md 的副本**,只登记「可以拿闸衡量」的那些条。像「做法 100% 自由」
 * 这种是设计声明不是可执行纪律,不进表 —— 硬塞进来只会让表变成第二份 CLAUDE.md,而两份必漂。
 *
 * ⚠ **它自己不检查纪律有没有被遵守**,只检查「这条纪律有没有一个机械物在管它」。
 * 前者是各道闸自己的事,后者此前无人管。
 */

/** 一条纪律的强制方式。 */
export type Enforcement =
  | { kind: 'gate'; ref: string }
  | { kind: 'prose'; why: string };

export interface Discipline {
  id: string;
  /** 出处:`.claude/CLAUDE.md` 的哪一节(或全局 `~/.claude/CLAUDE.md`)。 */
  source: string;
  /** 一句话规则。 */
  rule: string;
  enforcement: Enforcement;
}

export const DISCIPLINE_REGISTRY: readonly Discipline[] = [
  {
    id: 'write-root-allow',
    source: '§引擎理念 ①边界',
    rule: '可写根 / 命令白名单在工具调用那一刻拒,fail-closed',
    enforcement: { kind: 'gate', ref: 'src/harness/writeset/write-allow.test.ts' },
  },
  {
    id: 'gate-reject-no-retry',
    source: '§引擎理念 ①边界',
    rule: '闸拒了不许重试 —— 白名单不会因为重试而放行',
    enforcement: { kind: 'gate', ref: 'src/harness/node-failure.ts' },
  },
  {
    id: 'acceptance-self-proof',
    source: '§引擎理念 ③验收 1',
    rule: '判据自证:错样本摆进临时世界跑一遍,不失败即判据是虚的',
    enforcement: { kind: 'gate', ref: 'src/harness/goal/acceptance-gate.ts' },
  },
  {
    id: 'language-consistency-gate',
    source: 'C-1 / D-2 (执行契约 验收派生前探仓 + 语言一致闸)',
    rule: '分类期语言一致闸: 命令首词属语言包且该包 marker 全缺席 → 拒因带所需 marker 名 + 实检出 marker, 纠错环逐字引回',
    enforcement: { kind: 'gate', ref: 'src/harness/command-leaf.ts' },
  },
  {
    id: 'acceptance-root-aware',
    source: 'C-2 / D-3 (执行契约 验收派生前探仓 + 语言一致闸)',
    rule: 'acceptance 闸 root-aware: 给 root 则 per-root 白名单 + 语言一致闸; 缺 root 则与今天字节兼容',
    enforcement: { kind: 'gate', ref: 'src/harness/goal/acceptance-gate.ts' },
  },
  {
    id: 'classify-prompt-probe',
    source: 'C-3 / D-4 (执行契约 验收派生前探仓 + 语言一致闸)',
    rule: '分类 prompt 反映仓语言证据: per-root 白名单 + 示例条件化, 无 probe 退 base',
    enforcement: { kind: 'gate', ref: 'src/harness/goal/classify-probe.test.ts' },
  },
  {
    id: 'write-set-reconcile',
    source: '§引擎理念 ③验收 1',
    rule: '写集对账 —— 越界的写当场拒',
    enforcement: { kind: 'gate', ref: 'src/harness/writeset/write-set.ts' },
  },
  {
    id: 'verifier-cross-family',
    source: '§引擎理念 ③验收 2',
    rule: 'verifier 必须换家族 —— 同族自审会复用同一盲点',
    enforcement: { kind: 'gate', ref: 'src/model/seat-conformance.ts' },
  },
  {
    id: 'gate-verdict-id',
    source: '§引擎理念 ③验收 1',
    rule: '判生死的图级闸判词 id 化,并逐条对账覆盖(未覆盖必须登记欠账)',
    enforcement: { kind: 'gate', ref: 'src/harness/gates/gate-registry.test.ts' },
  },
  {
    id: 'solve-run-parity',
    source: '§solve vs run 能力分野',
    rule: '两层的 inputSchema 能力表与实装对账,不一致 exit 1',
    enforcement: { kind: 'gate', ref: 'src/mcp/capability-matrix.test.ts' },
  },
  {
    id: 'docs-dead-link',
    source: '§真源在哪',
    rule: '文档里的死路径 / 死锚常驻扫描',
    enforcement: { kind: 'gate', ref: 'scripts/docs-drift-check.test.ts' },
  },
  {
    id: 'seat-registry-parity',
    source: '§真源在哪 · 座位登记表',
    rule: '座位登记表 ↔ 实配对账(crossFamily / preferredCoord 不再是散文)',
    enforcement: { kind: 'gate', ref: 'src/model/seat-conformance.test.ts' },
  },
  {
    id: 'runner-timeout-is-fixture-bug',
    source: '§静默坑(2026-08-23 新增形态)',
    rule: 'runner 报 `this test timed out` = 夹具的界漏了一处,禁止记成 flaky 重跑',
    enforcement: { kind: 'gate', ref: 'scripts/test-run-triage.test.ts' },
  },
  {
    id: 'fail-open-keeps-evidence',
    source: '§静默坑 2',
    rule: 'fail-open 可以吞异常,不许吞证据 —— 每个 catch 至少留一行',
    enforcement: { kind: 'gate', ref: 'scripts/catch-evidence-scan.test.ts' },
  },
  {
    id: 'spec-numeric-claims',
    source: '§下断言之前的两问 P-2(2026-08-23 新增形态)',
    rule: '派工规格里的数量声明必须有一条命令能当场跑出它',
    enforcement: { kind: 'gate', ref: 'src/harness/goal/numeric-claims.test.ts' },
  },

  // ── 以下仍是散文。**每条都要写明为什么** —— 写不出就不该待在名单里。 ──────────────
  {
    id: 'experiment-four-elements',
    source: '§引擎好不好只能靠读数说话',
    rule: '实验四要素:单一变量 · 预先声明成败信号 · 同条件对照基线 · 两侧都写',
    enforcement: {
      kind: 'prose',
      why:
        '触发面是「这次算不算一个实验」, 而那是意图不是语法 —— 机械上分不出「提交信息里提到读数」' +
        '与「这是一次实验」。硬扫会把今天每一条带读数的提交都判红, 误报的闸会被无视。' +
        '⚠ 它**不会随模型变强而冗余**: 单一变量与同条件基线是信息论限制(一次动两个变量, ' +
        '再强的模型也没法从一个读数里分开功劳), 预先声明判据约束的是「动作与看见数据的先后」, ' +
        '模型越强越会把事后读数讲圆 ⇒ 只会更必要。所以它该留着, 只是暂时留在散文里。' +
        '可做的下一步: 只对**声明自己是实验**的产物(如 `docs/plan/*实验*` / 带 `A/B 两臂` 段的提交)扫四要素。',
    },
  },
  {
    id: 'new-gate-must-be-falsified',
    source: '§加一条纪律之前先问',
    rule: '新加的闸必须当场证伪一次,并把证伪方式写进注释 —— 一条永远绿的闸不是闸',
    enforcement: {
      kind: 'prose',
      why:
        '本表的 `gate` 条目已经全部带证伪记录(措辞**三种**并存: 「反向自检」·「判别力锚」·「反闸」), 但**新增的**闸' +
        '走不到这张表就不受约束, 而「有没有真跑过那一跳」在文本上看不出来 —— 注释可以照抄。' +
        '⇒ 可机械的只有下限(文件里有没有那段记录), 已由 discipline-registry.test.ts 的 ★③ 钉住;' +
        '「真跑过」这一半做不成闸。',
    },
  },
  {
    id: 'null-not-zero',
    source: '§静默坑 1',
    rule: '`NULL` ≠ 0 ≠ 不适用 —— 别编一个 unknown 把三件事抹平',
    enforcement: {
      kind: 'prose',
      why:
        '正确形态是类型层(`number | null` 而不是 `number`), 而类型已经能表达它 —— ' +
        '缺的是「该用 null 的地方用了 0」这种**语义**判断, 类型系统看不出来。' +
        '可做的下一步: 扫「聚合函数里 `?? 0`」这一类具体形态, 而不是扫这条纪律本身。',
    },
  },
  {
    id: 'new-probe-split-readout',
    source: '§加尺子必然让数难看',
    rule: '新增探针 / 语料段之后,读数按「老 N 段 + 新增段」分开写',
    enforcement: {
      kind: 'prose',
      why: '触发面同 experiment-four-elements(要先知道「这次加了尺子」), 且产物是散文段落, 机械上没有可断言的形状。',
    },
  },
  {
    id: 'review-round-cap',
    source: '全局 §派遣 · 审核纪律',
    rule: '轮数硬上限:Plan 1 / Phase 1 per phase / Release 2',
    enforcement: {
      kind: 'prose',
      why: '约束的是**我**发起几轮审查, 不在引擎参数面上(`maxRounds` 是内环轮数, 是另一件事)。没有承载它的机械物。',
    },
  },
  {
    id: 'p1-p2-two-questions',
    source: '§下断言之前的两问',
    rule: '出口前问:这句是看到的还是推的 · 盘上有没有一条记录能证伪它',
    enforcement: {
      kind: 'prose',
      why:
        '文档自己写明「P-2 自查不到 —— 我没真去查不留痕迹: 日志看不出、diff 看不出、测试测不到」。' +
        '通用形态做不成闸, 只能把**具体形态**一个个搬出来做成闸 —— 今天搬了两个' +
        '(runner-timeout-is-fixture-bug · spec-numeric-claims), 都在上面的 gate 段里。',
    },
  },
];

/** 还是散文的那些(绊线量它)。 */
export const proseDisciplines = (): Discipline[] =>
  DISCIPLINE_REGISTRY.filter((d) => d.enforcement.kind === 'prose');

/** 已经有闸的那些。 */
export const gatedDisciplines = (): Discipline[] =>
  DISCIPLINE_REGISTRY.filter((d) => d.enforcement.kind === 'gate');
