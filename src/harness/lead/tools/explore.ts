/**
 * src/harness/lead/tools/explore —— `explore` 卡:N 个只读并行侦察 worker。
 * 契约 S1 change note:「questions[1..8] + persona?;compile → N 个空写集只读 agent 兄弟」。
 *
 * review-fix (P1③,2026-09-02): `write_set: []` 在引擎侧不等于"什么都不许写"——
 * `resolveNodeWriteAllow([], undefined, root)` 算出空数组后, engine.ts:4572 用
 * `writeAllow.length ? { writeAllow } : {}` 判要不要把这道闸下发给 leaf,空数组的 `.length`
 * 也是 falsy,于是这道闸干脆**不下发**,等价于"没声明写集"(闸缺席放行) —— 正是
 * `writeset/write-allow.ts` 头注点名的「空数组 = 什么都不许写, 与 undefined(闸缺席)是两件事」
 * 那半坏掉的坑(NULL≠0≠不适用)。改这一折需要动 engine.ts 的全局判据(影响所有节点, 不止
 * lead 的卡), 越出本切片 `src/harness/lead/**` 的边界, 也需要它自己的一套回归闸。
 * S1 范围内的正确修法: 别指望空数组这个「巧合的 falsy」帮我们守闸, 声明一个仓内合法但没有
 * 任何真实叶子会去碰的哨兵路径 —— 这样 `writeAllow.length > 0`, 闸照常下发, 而声明表里除了
 * 哨兵自己没有第二条路径, 任何真实写入目标都判不中, 效果与"空数组=全拒"完全一致。
 */
import { z } from 'zod';
import type { ConductorPlan } from '../../conductor-plan';
import { renderManual } from '../render-manual';
import type { CompileResult, LeadTool } from '../types';

const ExploreSchema = z
  .object({
    questions: z.array(z.string().min(1)).min(1).max(8),
    persona: z.string().optional(),
    /** review-fix (P2⑤,2026-09-02):见 tools/work.ts 同名字段注释。 */
    help: z.boolean().optional(),
  })
  .strict();

type ExploreParams = z.infer<typeof ExploreSchema>;

/**
 * 只读哨兵路径 —— 声明成写集里唯一的一条, 使 `writeAllow.length > 0`(engine.ts:4572 的写域闸
 * 才会真下发), 而这条路径不存在也不会被任何真实 leaf 当作写入目标, 效果等价于"空数组=全拒"。
 * 见文件头 review-fix (P1③) 注释。
 */
const READONLY_SENTINEL = '.omd/lead-explore-readonly-sentinel';

const SHORT =
  'N read-only workers that each answer one question about the repo and return facts with paths. No writes. ' +
  'Use before briefing when you need facts from many places at once. Pass help:true for the full manual.';

export const exploreTool: LeadTool<ExploreParams> = {
  name: 'explore',
  short: SHORT,
  schema: ExploreSchema,
  manual: () => renderManual('explore'),
  compile(params: ExploreParams): CompileResult {
    const nodes: ConductorPlan['nodes'] = {};
    params.questions.forEach((question, i) => {
      const id = `explore-${i + 1}`;
      nodes[id] = {
        executor: 'agent',
        goal: params.persona ? `As ${params.persona}: ${question}` : question,
        // 只读侦察(compile-time 承诺,不是运行时推断):声明哨兵路径而非空数组 —— 见文件头
        // review-fix (P1③),空数组会被 engine.ts:4572 的 `.length` 判据折叠成"闸缺席"而失效。
        write_set: [READONLY_SENTINEL],
      };
    });
    return { ok: true, plan: { name: 'lead-explore', nodes } };
  },
};
