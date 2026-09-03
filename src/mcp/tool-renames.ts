/**
 * src/mcp/tool-renames —— 三层改名的**唯一真源**(owner 裁决 2026-08-04, slow-loop-hitl t7)。
 *
 * 三层各说出自己的承诺: `map_*`(慢回路决策图, 人在场)⊃ `solve`(目标收敛, 含修复轮)⊃
 * `run`(任务直进编排循环, 无验收)。旧名 `path_*` / `dag_goal` / `dag_run` 是**deprecated alias**,
 * 行为与新名完全相同, 留一版后拆(拆时删本表条目即可, alias 自动消失)。
 *
 * ## 为什么在装配层改而不动源码字面量
 * 源码/测试/内部调用里旧名 ~300 处、docs ~1400 处 —— 一次全改的 diff 没人能审。
 * 装配层一张表改注册面, 内部零涟漪; 源码级迁移等 alias 拆除那一版一起做。
 *
 * ## 闸的改名感知(不然两条闸开始说谎)
 * `tools-documented.test.ts` 的文档闸与 README 徽章闸都从**源码字面量**数注册面 ——
 * 装配层改名后, 真实注册面 = 字面量经本表映射 + alias。两条闸 import 本表做同一变换,
 * 真源只有一处, 闸与装配不可能漂移。
 *
 * ⚠ `path_map` → `map_open`(不是机械的 `map_map`): 它的语义就是"开一张图/列开放图"。
 * ⚠ 账本 `entry` 词表(`dag_run`/`dag_goal`/`path_deliver` 字符串)**本表不管** —— 那是
 *   读数历史的键, 迁移要带合并读, 另一片做(见 slow-loop-hitl t7 票)。
 */
import type { OmdMcpTool } from './server';

/** 旧名 → 新名。装配层与两条闸共用; 拆 alias = 删条目。 */
export const TOOL_RENAMES: Readonly<Record<string, string>> = {
  path_init: 'map_init',
  path_map: 'map_open',
  path_add: 'map_add',
  path_tickets: 'map_tickets',
  path_rule: 'map_rule',
  path_deliver: 'map_deliver',
  path_prefetch: 'map_prefetch',
  dag_goal: 'solve',
  dag_run: 'run',
};

/**
 * 注册面变换: 表内工具改挂新名, 并以旧名追加一个 deprecated alias(同 schema 同 handler,
 * description 打头标记)。表外工具原样通过。幂等不适用 —— 只在装配出口调用一次。
 */
export function applyToolRenames(tools: OmdMcpTool[]): OmdMcpTool[] {
  const out: OmdMcpTool[] = [];
  for (const t of tools) {
    const next = TOOL_RENAMES[t.name];
    if (!next) {
      out.push(t);
      continue;
    }
    out.push({ ...t, name: next });
    // alias 描述**不带原文**: D-11 一行税, 9 个 alias 若各拖全文描述等于把注册面读两遍。
    out.push({ ...t, name: t.name, description: `[deprecated → ${next}] same tool, renamed 2026-08-04.` });
  }
  return out;
}
