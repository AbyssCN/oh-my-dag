/**
 * src/harness/goal/loop-ledger —— R-1 读数进账本: 编排循环父 run 的 `loop` 列 (设计 `docs/plan/2026-09-03-r1-ledger-columns.md`)。
 *
 * 两样东西:
 *  · {@link LoopLedger}: 写进 `omd_dag_runs.loop` (JSON) 的**最终**形状, 由 run-goal 收尾时组装, goal.ts 经 `recorder.updateLoop` 回填父行。
 *  · {@link LeadCardLedger}: 运行期**可变**计数器, run-goal 造一个, 经 `buildLeadFace` 交给七张卡的运行期适配层与只读 bash 闸,
 *    D-14 回灌的第二跑**沿用同一个**(两跑合并计数: 读数问的是「这趟 run」, 不是「这一跑」)。
 *
 * 三态纪律 (仓规静默坑 1): 整列 NULL = 没走循环 / 老记录; `verifier.firstVerdict: null` = 没调 (≠ fail);
 * `cards.byCard` 缺键 = 那张卡一次没派成 (调用数在 `calls`); `dispatches[].briefHasRepro: null` = 该卡没有 brief 槽。
 */

export type LeadCardName = 'work' | 'spawn' | 'map' | 'explore' | 'best_of' | 'research' | 'decompose';

export interface LoopDispatch {
  seq: number;
  card: LeadCardName;
  nodes: number;
  /** brief 里有没有粘运行输出 —— **启发式** (见 {@link briefHasRepro}), 量的不是"复现对不对"。null = 该卡没有 brief 槽。 */
  briefHasRepro: boolean | null;
  resumeOf?: string;
  /** 子 run 里 status !== 'done' 的节点数; 子 run 抛错 (没有结果) 时缺席。 */
  failed?: number;
  /** 子 run 抛错 (引擎侧事故), 原文头 200 字。 */
  error?: string;
}

/**
 * 1-A (2026-09-03) 判据先落盘冻结的台账。判据命令引用、run 开始时不存在的文件: lead 的第一个派发只准产出它们,
 * 引擎在实装派发之前记下 hash, 之后的派发走路径禁令 (agent-tools withProtectedPaths)。
 * 三态: 整格缺席 = 判据不引用未存在文件 (不适用); `frozenAtDispatch` 缺席 = 还没派成过; `hashes[f] === null` = 派发回来
 * 文件仍不存在 (没冻住, 不受保护); `tampered` 缺席 = 没核过, `[]` = 核过全同。
 */
export interface CriterionFreeze {
  files: string[];
  frozenAtDispatch?: number;
  hashes?: Record<string, string | null>;
  tampered?: string[];
}

/** 运行期计数器 (可变)。字段语义与 {@link LoopLedger.cards} 逐字相同。 */
export interface LeadCardLedger {
  calls: number;
  ok: number;
  rejectedSchema: number;
  help: number;
  rejectedCompile: number;
  childRunError: number;
  byCard: Partial<Record<LeadCardName, number>>;
  readOnlyShellBlocked: number;
  dispatches: LoopDispatch[];
  /** lead 常驻 system prompt 真跑的字符数 (含 RUN FACTS); 由 buildLeadFace 写, 回灌第二跑覆盖为同值。 */
  residentPromptChars: number | null;
  /** 1-A 冻结台账 (可变; 回灌第二跑沿用, 那时 hashes 已在 → 直接受保护)。缺席 = 不适用。 */
  criterionFreeze?: CriterionFreeze;
}

export function createLeadCardLedger(): LeadCardLedger {
  return { calls: 0, ok: 0, rejectedSchema: 0, help: 0, rejectedCompile: 0, childRunError: 0, byCard: {}, readOnlyShellBlocked: 0, dispatches: [], residentPromptChars: null };
}

/** 写进账本的最终形状。 */
export interface LoopLedger {
  path: 'orchestrating-loop';
  /** classify 那一发出的路由决策; `chainHit` 在循环开着时恒 false (D-17 恒截胡), 留着是为了对照臂同一形状。 */
  route: { kind: 'none' | 'chain' | 'shape'; chainHit: boolean };
  /** 动手前 LLM 调用数 (classify 一发 + P2b 重推 / 追问那几发)。INV-12 判词: 默认路径 = 1, 含追问 ≤ 3。null = 分类器没走 LLM (注入式 / 缺 generate)。 */
  preActionLlmCalls: number | null;
  /** lead 常驻 prompt 真跑字符数。INV-8 判词 ≤ 8000。null = 面没构造 (不该发生, 留给读侧看见)。 */
  residentPromptChars: number | null;
  verifier: {
    /** 真调 verifier 的次数 (闸红短路 / verifier-error 不计)。INV-7 判词 ≤ 1。 */
    calls: number;
    firstVerdict: 'pass' | 'fail' | null;
    target: 'implementation' | 'criterion' | null;
    reinjected: boolean;
    /** 回灌后终局; 没回灌 (含基建守卫拦住) = 'skipped'。 */
    afterReinject: 'green' | 'red' | 'no-oracle' | 'skipped';
  };
  /** lead 节点基建类败因 (D-14 守卫); 缺席 = 没发生。 */
  leadInfraFailure?: string;
  cards: Omit<LeadCardLedger, 'dispatches' | 'residentPromptChars' | 'criterionFreeze'>;
  dispatches: LoopDispatch[];
  /** 1-A 冻结台账 (收尾时 `tampered` 已核)。缺席 = 判据不引用未存在文件。 */
  criterionFreeze?: CriterionFreeze;
  /**
   * D-14 回灌第二跑开始那一刻 `dispatches` 的长度 (两跑合并计数, 这是分界线)。只在 `verifier.reinjected` 时有值;
   * 缺席 = 没回灌 / 老记录。读侧「回灌蒸发率」= 回灌后零新派发 (`dispatches.length === dispatchesBeforeReinject`)
   * 且 oracle 绿 —— 没有这条线, 读侧只能猜哪些派发是回灌后的。
   */
  dispatchesBeforeReinject?: number;
}

/**
 * brief 里有没有粘**运行输出** —— 启发式, 写死在这里, 读侧不再猜。命中任一形态即 true:
 * 退出码 (`exit 1` / `exit code` / `退出码`) · traceback / Traceback · `FAILED` / `failed,` (pytest / bun 摘要) ·
 * 断言差异 (`AssertionError` / `expected` … `got` / `Expected:` `Received:`) · 命令提示符行 (`$ ` 开头) ·
 * 「N passed / N failed」形态。**不**命中: 只写了命令名而没有它的输出。
 */
export function briefHasRepro(brief: string): boolean {
  const b = brief ?? '';
  return (
    /\bexit(?:\s+code)?\s*[:=]?\s*\d+|退出码\s*\d+/i.test(b) ||
    /traceback/i.test(b) ||
    /\bFAILED\b|\bfailed\b\s*[,(]|\d+\s+failed/.test(b) ||
    /AssertionError|\bexpected\b[\s\S]{0,80}\bgot\b|Expected:|Received:/.test(b) ||
    /(^|\n)\s*\$ \S/.test(b) ||
    /\d+\s+pass(?:ed)?\b/.test(b)
  );
}
