/**
 * src/harness/playbook/types —— Playbook 外层(跨轮迭代)冻结类型面。
 *
 * 是什么: DAG(ConductorPlan)是 acyclic 的单次执行层;而「跑一轮 → 看判据 → 没到就再来一轮」
 * 这种工作流画布画不出来,所以外层单独建模。playbook = 步骤链(带 reset)+ loop 作用域 +
 * 收敛判据。本文件只放类型,加载/校验实现在 load.ts(见该文件的 A-1/A-2/A-3 校验闸)。
 *
 * 为什么类型与实现分文件: types.ts 是设计冻结点(SDD 契约段逐字转录),改它 = 回流改 SDD;
 * load.ts 是实现,可以在不碰契约的前提下演进内部函数切分。
 */

/** 单个步骤 —— 指向 playbook 目录下的一份编号 md 文档。 */
export interface PlaybookStep {
  /** 相对 playbook 目录的 md 路径(如 "1_ANALYZE.md")。 */
  doc: string;
  /**
   * 跑完后重置本步判据 → 允许同一 doc 在 steps 链上重复出现。
   * 缺省即"不重置",与显式 false 语义相同,故不强求调用方补 `?? false`。
   */
  reset?: boolean;
}

/** 一份 playbook —— 步骤链 + 可选 loop 作用域 + 收敛判据。 */
export interface Playbook {
  /** playbook 名,亦是叠加时用于内置/项目层同名判定的键。 */
  name: string;
  steps: PlaybookStep[];
  /**
   * 缺省 = 不循环,只跑一轮;有 loop 才谈"跨轮"。
   * maxRounds 与 iterate 原语(src/harness/primitive-registry.ts 的 iterateTemplate)同顶 —— 有界
   * 是 schema 的事,不是 prompt 的事,故上限 10(见 load.ts 的 A-1 闸)。
   * 注意 `{ maxRounds: 0 }` 与"无 loop"是两件事:前者存在且合法(A-1 校验通过),
   * 不得用 `loop?.maxRounds ?? 0` 之类的写法把两者抹平。
   */
  loop?: { maxRounds: number };
  /**
   * 收敛判据。command 必须在自带的 negativeSample 上真的失败(退出码非零),
   * 否则 load.ts 的 A-3 闸拒收 —— 判据靠退出码,不靠"模型说到了就算到"。
   */
  acceptance: {
    command: string;
    negativeSample: { path: string; content: string };
  };
}
