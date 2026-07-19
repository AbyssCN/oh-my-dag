/**
 * src/harness/slim/prompts —— dag-slim (过度工程专审) 的 prompt 构建 (纯件, 零 IO)。
 *
 * 两遍纪律: **全局遍先行** (一个 reviewer 吃整个改动面, 猎跨文件系统级复杂度 — -50% 的赢面在这),
 * 局部遍在后 (per-file hunk 并发, 逐 hunk 小刀)。每条 prompt 注入 PONYTAIL_DISCIPLINE +
 * DESIGN_VOCAB (单一真相源 src/harness/review/design-vocab, 词汇不许漂移)。
 *
 * 护栏 (违者即误报): 文档化 DEFER/契约面/刻意 seam ≠ finding · 少行数永不少 case。
 * finding≠ground truth, 调用方终裁 (同 dag-review 纪律)。
 */
import { DESIGN_VOCAB, PONYTAIL_DISCIPLINE } from '../review/design-vocab';

export interface SlimFindingKind {
  /** finding 行前缀 (解析靠它)。 */
  kind: string;
  /** 该 kind 猎的目标 (进 prompt 的镜头说明)。 */
  hunt: string;
}

/** Pass 1 全局遍 (system-coherence, 先跑): 4 类跨文件 finding。 */
export const GLOBAL_KINDS: SlimFindingKind[] = [
  { kind: 'dedup', hunt: '同一逻辑在 N 处手写 → 指出该并成的那一个共享 util (最大赢面)' },
  { kind: 'collapse', hunt: '同一概念的平行实现 → 合并为一个' },
  { kind: 'layer', hunt: '没人需要的模块/间接层/wrapper → 对它做 deletion test: 删掉后逻辑摊回调用方, 整体复杂度几乎不变 = 该删' },
  { kind: 'couple', hunt: '局部"最小"选择造出的耦合/重复 → 给出全局协调 (globally-coherent) 的替代' },
];

/** Pass 2 局部遍 (per-file hunk, 并发): 4 类局部 finding。 */
export const LOCAL_KINDS: SlimFindingKind[] = [
  { kind: 'delete', hunt: '死代码/无人用的灵活性/投机特性 → replacement: nothing' },
  { kind: 'stdlib', hunt: '手写了 Bun/标准库自带的东西 → 点名那个函数' },
  { kind: 'native', hunt: '依赖或应用代码在做平台原生就有的事 → 点名那个平台特性' },
  { kind: 'yagni', hunt: '只有一个实现的抽象/没人设的配置/只有一个调用方的层' },
];

/** 单行 finding 格式 (全局/局部统一, 输出解析靠 kind 前缀)。 */
export const FINDING_LINE_FORMAT = '<kind>: <file:line> — cut <what>, replace with <what>';

/** 无 finding 时的哨兵输出 (解析侧据此判 "干净")。 */
export const LEAN_SENTINEL = 'LEAN';

/** 护栏块 (源自 PONYTAIL_DISCIPLINE, 展开成可执行的拒报规则)。 */
const GUARDRAILS = [
  '护栏 (违者即误报, 不许报):',
  '- 文档化的 DEFER / 契约面 / 刻意的扩展 seam = 选定的架构, **不是 finding** — 已规划 ≠ 投机。',
  '- 少行数永不少 case: 建议不得丢边界 case/类型/校验/错误路径 — 那是 bug, 不是简化。',
  '- 单个冒烟测试 / assert 自检是 ponytail 底线, 不是 bloat。',
  '- dedup/collapse 只并真正同一概念的; 把恰好长得像的两个概念并起来 = 制造耦合, 反而是病。',
].join('\n');

/** kind 菜单 + 单行格式 + 护栏 + 空输出哨兵 (全局/局部共用尾块)。 */
function outputRules(kinds: SlimFindingKind[]): string {
  return [
    `只报以下 ${kinds.length} 类 finding, 每条**恰好一行**, 格式: \`${FINDING_LINE_FORMAT}\`:`,
    ...kinds.map((k) => `- \`${k.kind}:\` ${k.hunt}`),
    '',
    GUARDRAILS,
    '',
    `输出**只有 finding 行**, 无标题/解释/总结。无 finding → 只输出 ${LEAN_SENTINEL}。`,
  ].join('\n');
}

/**
 * Pass 1 全局遍 prompt (diff 由调用方置于前部 → 与其它 prompt 共享前缀命中 provider cache)。
 * 一个 reviewer (更强模型槽) 看全部改动面 + 它触及的既有结构。
 */
export function buildGlobalPrompt(opts: { scope: string }): string {
  return [
    PONYTAIL_DISCIPLINE,
    DESIGN_VOCAB,
    [
      '你是**全局**过度工程审查员 (system-coherence pass, 两遍中的第一遍 — 真赢面在这)。',
      '看整个改动面 + 它触及的既有结构, 只猎**跨文件的系统级**复杂度: 同逻辑多处手写、',
      '平行实现、无人需要的层、局部"最小"造出的全局耦合。逐 hunk 的小刀不归你 (局部遍管)。',
      '正确性/安全 bug 也不归你 (那是 dag-review 的事) — 这里只删不修。',
    ].join('\n'),
    `审查范围:\n${opts.scope}`,
    outputRules(GLOBAL_KINDS),
  ].join('\n\n');
}

/**
 * Pass 2 局部遍单文件 leaf 的 goal 文本。**diff hunk 不进 goal** — 它走 plan 节点的
 * args.diff (executor-dag 对 goal 有"写文件意图"启发式扫描, 原始 diff 内容可能误触;
 * args 只渲染进 leaf prompt 不被扫描, 是干净的载荷 seam)。
 */
export function buildLocalPrompt(file: string): string {
  return [
    PONYTAIL_DISCIPLINE,
    DESIGN_VOCAB,
    [
      `你是**局部**过度工程审查员 (per-hunk pass)。只审文件 ${file} 的这一个 diff hunk`,
      '(原文在下方 Args 的 diff 字段, JSON 转义, \\n=换行)。只删不修 —',
      '正确性/安全 bug 不归你 (那是 dag-review 的事)。',
    ].join('\n'),
    outputRules(LOCAL_KINDS),
  ].join('\n\n');
}

/** 局部遍 synth 节点 goal: 汇总去重各文件 leaf 的 finding 行, 只出单行清单。 */
export const SYNTH_GOAL = [
  '汇总前驱各文件局部遍审查的 finding 行: 去重 (同 file:line 同 kind 折叠成一条),',
  `保留原单行格式 \`${FINDING_LINE_FORMAT}\`, 只输出 finding 行本身, 无标题/解释/总结。`,
  `前驱输出为 ${LEAN_SENTINEL} 或空的忽略之; 全部为 ${LEAN_SENTINEL} → 只输出 ${LEAN_SENTINEL}。`,
].join('\n');
