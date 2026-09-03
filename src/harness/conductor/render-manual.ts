/**
 * src/harness/conductor/render-manual —— manual 从真源渲染(P3 契约 S1)。
 *
 * `manual` 只做拼接:取该工具对应的原语参数表(`PRIMITIVE_REGISTRY`,真源
 * `src/harness/primitive-registry.ts`)与对应图式的 when/whenNot/steps/why/example
 * (`GRAPH_SHAPES`,真源 `src/harness/shapes/index.ts`)。**不手抄第二份文本** ——
 * 改一处图式的 `when`,七张卡里引用它的那张 manual 跟着变;`conductor-tools-manual.test.ts`
 * 的快照测试就是钉这一条:改 `GRAPH_SHAPES` 里任一条 `when`,测试必红。
 *
 * `MANUAL_SOURCES` 只回答「这张卡的文档该引用哪些原语/图式」,不是 D-23 三分法的
 * 第二份表:三分法钉的是「哪个原语的**执行语义**被卡覆盖」(见 `./coverage.ts`),
 * 这里钉的是「写文档时该引用哪些真源段落」—— 两者用途不同,字面允许不同
 * (例如 decompose 的 manual 需要列出全部六个 hint 对应的原语文本,即便 D-23
 * 只承认 escalation 一个「被卡覆盖」)。
 */
import type { PrimitiveId } from '../primitive-registry';
import { PRIMITIVE_REGISTRY } from '../primitive-registry';
import { GRAPH_SHAPES, shapeById } from '../shapes';
import type { ConductorToolName } from './types';

/** 每张卡的文档该引用哪些原语参数表 / 哪些图式段落(真源指针,不是内容副本)。 */
interface ManualSource {
  primitives: readonly PrimitiveId[];
  shapes: readonly string[];
}

export const MANUAL_SOURCES: Readonly<Record<ConductorToolName, ManualSource>> = {
  // work 编译到单个 agent 节点,没有对应的编排原语或图式 —— 它是七张卡里唯一的"叶子"。
  work: { primitives: [], shapes: [] },
  spawn: { primitives: ['parallel'], shapes: ['one-decision-then-fanout', 'full-stack', 'ui-evidence'] },
  map: { primitives: ['pipeline', 'discovery'], shapes: ['runtime-work-list'] },
  explore: { primitives: ['parallel'], shapes: [] },
  best_of: { primitives: ['judge', 'tournament', 'race'], shapes: ['ui-best-of-n'] },
  // research 不复用编排原语(它走 executor:'research' 这条独立通道),只引图式。
  research: { primitives: [], shapes: ['research-lens', 'research-second-pass'] },
  decompose: {
    primitives: ['router', 'loop-until', 'iterate', 'escalation', 'saga', 'verify'],
    shapes: ['runtime-decomposition'],
  },
};

/** 每张卡的一行标题(手写;不是从真源渲染的那一段,manual 主体才是)。 */
const MANUAL_HEADLINE: Readonly<Record<ConductorToolName, string>> = {
  work: 'work — one worker, one bounded change.',
  spawn: 'spawn — N independent workers at once.',
  map: 'map — a worker per runtime item.',
  explore: 'explore — parallel read-only reconnaissance.',
  best_of: 'best_of — competing attempts, mechanical pick.',
  research: 'research — grounded web research.',
  decompose: 'decompose — runtime decomposition by the escalation seat.',
};

/** zod v4 的 ZodObject 在 `.strict()` / `.refine()` 之后仍暴露 `.shape`(实测,见 S1 勘察)。 */
interface ShapeBearing {
  shape: Record<string, { isOptional?: () => boolean }>;
}

function hasShape(v: unknown): v is ShapeBearing {
  return !!v && typeof v === 'object' && 'shape' in (v as Record<string, unknown>);
}

/** 从原语的 paramsSchema 渲染一份「参数名 + 是否可选」表(不手抄:直接读 zod shape)。 */
function renderPrimitiveParams(id: PrimitiveId): string[] {
  const tmpl = PRIMITIVE_REGISTRY[id];
  const schema: unknown = tmpl.paramsSchema;
  if (!hasShape(schema)) return [`  (${id}: 参数表不可内省)`];
  const fields = Object.entries(schema.shape).map(([key, field]) => {
    const optional = typeof field.isOptional === 'function' && field.isOptional();
    return `${key}${optional ? '?' : ''}`;
  });
  return [`  primitive '${id}' params: ${fields.join(', ')}`];
}

/** 从 GRAPH_SHAPES 渲染一个图式的 when/whenNot/steps/why/example(逐字取真源字段)。 */
function renderShapeSection(id: string): string[] {
  const shape = shapeById(id);
  if (!shape) return [`  (图式 '${id}' 未在 GRAPH_SHAPES 找到)`];
  const lines: string[] = [];
  lines.push(`  [${shape.id}] ${shape.what}`);
  lines.push(`    WHEN: ${shape.when}`);
  lines.push(`    NOT when: ${shape.whenNot}`);
  for (const step of shape.steps) lines.push(`    · ${step}`);
  lines.push(`    WHY: ${shape.why}`);
  if (shape.enforced) lines.push(`    ENFORCED: ${shape.enforced}`);
  if (shape.example) {
    lines.push(`    EXAMPLE (real green run ${shape.example.source}): ${shape.example.goalHint}`);
    for (const line of shape.example.graph) lines.push(`    ${line}`);
  }
  return lines;
}

/**
 * 渲染一张卡的完整 manual(D-3:只走 tool result,永不进 system prompt)。
 * 惰性求值由调用方保证(七张卡的 `manual` 字段是 `() => renderManual(name)` 这个 thunk)。
 */
export function renderManual(name: ConductorToolName): string {
  const src = MANUAL_SOURCES[name];
  const lines: string[] = [MANUAL_HEADLINE[name]];
  if (src.primitives.length > 0) {
    lines.push('', 'Underlying primitives (rendered from primitive-registry.ts, not a second copy):');
    for (const id of src.primitives) lines.push(...renderPrimitiveParams(id));
  }
  if (src.shapes.length > 0) {
    lines.push('', 'Related graph shapes (rendered from shapes/index.ts, not a second copy):');
    for (const id of src.shapes) lines.push(...renderShapeSection(id));
  }
  return lines.join('\n');
}

/** GRAPH_SHAPES 的全部 id(供 coverage.ts 断言「8 张图式全部被卡覆盖」)。 */
export const ALL_SHAPE_IDS: readonly string[] = GRAPH_SHAPES.map((s) => s.id);
