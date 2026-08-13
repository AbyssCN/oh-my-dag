/**
 * scripts/probes/readonly-face —— 探针用的**只读工具面**(2026-08-13)。
 *
 * ## 为什么要有这个文件
 *
 * `large-repo-e2e-probe` 与 `long-session-compaction-probe` 跑在**真仓**上
 * (含 `~/repos/talous-v2`),它们靠一句「审批闸 setAsk → 一律 deny」保证结构上改不了目标仓。
 * 2026-08-13 审批闸随 TUI yolo 化一起删掉之后,那句保证会**静默消失** ——
 * 探针照跑、读数照出,只是模型从此可以真写。那正是本仓最怕的一族。
 *
 * 于是把那条保证搬到这里,并保持**同一个形状**:工具仍然出现在工具面上
 * (模型看得见、会去调),被拒是**调用时抛错**。改成"不挂这几个工具"会换掉模型看到的
 * 世界,而那些探针有历史读数 —— 换了工具面,基线就不在同一条件上了(本仓 §对照基线)。
 */
import type { AnyOmdTool } from '../../src/harness/agent-tools';

/** 会改盘的工具名。`omd_run` / `omd_solve` 会派整张图出去真改文件,同列。 */
export const MUTATING_TOOLS: readonly string[] = ['write', 'edit', 'bash', 'omd_run', 'omd_solve'];

export interface ReadonlyFace {
  tools: AnyOmdTool[];
  /** 被拒了几次 —— 探针报告里那一行读数。 */
  denied: () => number;
}

/**
 * 把会改盘的工具包成"调用即拒"。**抛错**而不是返回空结果 ——
 * 后者会让模型以为写成功了,于是后面所有判断都建在一个假事实上。
 */
export function readonlyFace(tools: AnyOmdTool[]): ReadonlyFace {
  let n = 0;
  return {
    denied: () => n,
    tools: tools.map((t) =>
      MUTATING_TOOLS.includes(t.name)
        ? {
            ...t,
            async execute() {
              n += 1;
              throw new Error(`[probe] 只读探针拒绝 ${t.name} —— 这一格量的是读与答, 不许改目标仓`);
            },
          }
        : t,
    ),
  };
}
