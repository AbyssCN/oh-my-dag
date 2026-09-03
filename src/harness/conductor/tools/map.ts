/**
 * src/harness/conductor/tools/map —— `map` 卡:待处理集合在规划期未知,运行时展开一个 worker/项。
 * 契约 S1 change note:「list_from / per_item / key_by? / stages? / until? / max_items?(默认 64);
 * compile → executor:'map' + lister 子步」。
 *
 * `until:'no-new'`(discovery:重复直到一轮无新发现)需要**迭代重列**,而 `executor:'map'`
 * 今天是一次性 lister → 展开,没有「重跑 lister、去重累积」的引擎支持(那是 `primitive-registry`
 * 的 `discovery` 原语在做的事,而 discovery 按 D-23 是 `explore` 的卡覆盖,不是 map 的)。
 * 与其把这个字段悄悄当空气(那正是仓规在猎杀的「明示却不生效」的死旋钮),compile 在
 * `until:'no-new'` 时诚实拒绝并给出替代路径,而不是假装支持。
 *
 * review-fix (P1①,2026-09-02): `lister.executor:'command'` 分支(engine.ts:3677-3683)
 * 原样把命令 stdout 剥 code fence 后找 `{`…`}` 当 JSON 解析(engine.ts:3735-3737),对纯文本
 * 「一行一项」的输出永远解不出对象 → 每次 map 调用都在 lister 那步以 infra-error 死给零子节点
 * (INV-U7)。真正支持这种「模型自己不确定输出是不是 JSON」的分支是 `executor:'agent'`
 * (engine.ts:3684-3688):它会在 prompt 里追加"只回一个 JSON 对象, 必含数组键"这句话,把
 * 「跑命令 + 包成 JSON」两件事都交给一个带 bash 工具的 leaf 做,不要求 `list_from` 自己吐 JSON。
 * 这里改用 `executor:'agent'`,manual/SHORT 措辞跟着改「读文本行」而不是「读 JSON」。
 */
import { z } from 'zod';
import type { ConductorPlan } from '../../conductor-plan';
import { renderManual } from '../render-manual';
import type { CompileResult, ConductorCtx, ConductorTool } from '../types';

const MapSchema = z
  .object({
    list_from: z.string().min(1),
    per_item: z.string().min(1),
    key_by: z.string().optional(),
    stages: z.array(z.object({ goal: z.string().min(1) }).strict()).optional(),
    until: z.enum(['all', 'no-new']).optional(),
    max_items: z.number().int().positive().max(64).optional(),
    /** review-fix (P2⑤,2026-09-02):见 tools/work.ts 同名字段注释。 */
    help: z.boolean().optional(),
  })
  .strict();

type MapParams = z.infer<typeof MapSchema>;

const DEFAULT_MAX_ITEMS = 64;
const ITEM_VAR = 'item';
const LISTER_ARRAY_KEY = 'items';

const SHORT =
  'One worker per item of a runtime list. list_from is a read-only command; an agent step runs it and reports one item per line. per_item is the goal template with {item}. Optional stages run each item through ordered steps.';

export const mapTool: ConductorTool<MapParams> = {
  name: 'map',
  short: SHORT,
  schema: MapSchema,
  manual: () => renderManual('map'),
  compile(params: MapParams, ctx: ConductorCtx): CompileResult {
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
    // review-fix (P2⑥,2026-09-02): run 级验收命令不接每个元素的 self_check —— N 个并行子节点里
    // 任一个先跑到底就会拿全 run 的验收命令(如整仓 `bun test`)给自己判分,而这时其它兄弟可能还在
    // 半改状态,判到的红不是它自己的错。run 级判据只在 work/best_of 这种「结果即整条 run 的产物」
    // 时才是那个节点该背的分,N-way 扇出的每个元素不该背。
    const template: ConductorPlan['nodes'][string] = {
      executor: 'agent',
      goal: stageLines.length > 0 ? [itemGoal, ...stageLines].join('\n\n') : itemGoal,
    };
    const node: ConductorPlan['nodes'][string] = {
      executor: 'map',
      goal: `Runtime work list: ${params.list_from}`,
      map: {
        lister: {
          executor: 'agent',
          goal:
            `Run this read-only command: \`${params.list_from}\`. ` +
            `Report its output as a JSON object with array key "${LISTER_ARRAY_KEY}" — one string per non-blank output line, in order.`,
          output_schema: { [LISTER_ARRAY_KEY]: 'string[]' },
        },
        over: LISTER_ARRAY_KEY,
        itemVar: ITEM_VAR,
        ...(params.key_by ? { keyBy: params.key_by } : {}),
        template: template as unknown as Record<string, unknown>,
        maxItems: params.max_items ?? DEFAULT_MAX_ITEMS,
      },
    };
    return { ok: true, plan: { name: 'conductor-map', nodes: { map: node } } };
  },
};
