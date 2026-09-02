/**
 * src/harness/lead/tools/map —— `map` 卡:待处理集合在规划期未知,运行时展开一个 worker/项。
 * 契约 S1 change note:「list_from / per_item / key_by? / stages? / until? / max_items?(默认 64);
 * compile → executor:'map' + lister 子步」。
 *
 * `until:'no-new'`(discovery:重复直到一轮无新发现)需要**迭代重列**,而 `executor:'map'`
 * 今天是一次性 lister → 展开,没有「重跑 lister、去重累积」的引擎支持(那是 `primitive-registry`
 * 的 `discovery` 原语在做的事,而 discovery 按 D-23 是 `explore` 的卡覆盖,不是 map 的)。
 * 与其把这个字段悄悄当空气(那正是仓规在猎杀的「明示却不生效」的死旋钮),compile 在
 * `until:'no-new'` 时诚实拒绝并给出替代路径,而不是假装支持。
 */
import { z } from 'zod';
import type { ConductorPlan } from '../../conductor-plan';
import { renderManual } from '../render-manual';
import type { CompileResult, LeadCtx, LeadTool } from '../types';

const MapSchema = z
  .object({
    list_from: z.string().min(1),
    per_item: z.string().min(1),
    key_by: z.string().optional(),
    stages: z.array(z.object({ goal: z.string().min(1) }).strict()).optional(),
    until: z.enum(['all', 'no-new']).optional(),
    max_items: z.number().int().positive().max(64).optional(),
  })
  .strict();

type MapParams = z.infer<typeof MapSchema>;

const DEFAULT_MAX_ITEMS = 64;
const ITEM_VAR = 'item';
const LISTER_ARRAY_KEY = 'items';

const SHORT =
  'One worker per item of a list that only exists at runtime. list_from is a read-only command that prints ' +
  'the items. per_item is the goal template with {item}. Optional stages run each item through ordered steps.';

export const mapTool: LeadTool<MapParams> = {
  name: 'map',
  short: SHORT,
  schema: MapSchema,
  manual: () => renderManual('map'),
  compile(params: MapParams, ctx: LeadCtx): CompileResult {
    if (params.until === 'no-new') {
      return {
        ok: false,
        error:
          "until:'no-new' 需要迭代重列到一轮无新发现(discovery),executor:'map' 是一次性 lister,今天没有这条控制流。" +
          "改法:让 list_from 一次性穷举(把发现循环放进那条命令自己的逻辑里),或省略 until 只跑一轮。",
        manual: renderManual('map'),
      };
    }
    // per_item 用 {item} 写模板(manual 措辞);map-expand 的插值语法是 `${itemVar}`,这里做一次转写。
    const itemGoal = params.per_item.replace(/\{item\}/g, `\${${ITEM_VAR}}`);
    const stageLines = (params.stages ?? []).map((s, i) => `Stage ${i + 1}: ${s.goal}`);
    const template: ConductorPlan['nodes'][string] = {
      executor: 'agent',
      goal: stageLines.length > 0 ? [itemGoal, ...stageLines].join('\n\n') : itemGoal,
      ...(ctx.acceptance ? { self_check: { command: ctx.acceptance.command, expect_exit: ctx.acceptance.expect_exit } } : {}),
    };
    const node: ConductorPlan['nodes'][string] = {
      executor: 'map',
      goal: `Runtime work list: ${params.list_from}`,
      map: {
        lister: { executor: 'command', command: params.list_from },
        over: LISTER_ARRAY_KEY,
        itemVar: ITEM_VAR,
        ...(params.key_by ? { keyBy: params.key_by } : {}),
        template: template as unknown as Record<string, unknown>,
        maxItems: params.max_items ?? DEFAULT_MAX_ITEMS,
      },
    };
    return { ok: true, plan: { name: 'lead-map', nodes: { map: node } } };
  },
};
