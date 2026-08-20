/**
 * src/serve/zod-typebox.ts —— MCP 工具 zod inputSchema → chat 位 typebox parameters 的转换。
 *
 * 为什么存在: chat 位的 AnyOmdTool 要吃 typebox schema (pi AgentTool 面), 而 MCP 工具
 * 注册面吃 zod (ZodRawShapeCompat)。此前 chat-tools.ts 手写 typebox 镜像 zod —— 30 个工具
 * 手写 30 份, 与 zod 源两份必漂 (正是「本体 ⊇ MCP」闸要防的那一类静默漂移)。这里按 zod v4
 * 的 _def / _zod.bag 结构做一次转换, 单一真源仍是 MCP 工具的 inputSchema。
 *
 * 只覆盖 MCP 工具实际用到的 zod 构造: string / number(int·min·max·positive) / boolean /
 * optional / default / enum / record / array / object + describe。不覆盖的构造回落 Type.Unknown()
 * (fail-open: 不因为一个没见过的构造就拒绝装配整个工具面 —— 那是拿转换器当闸, 本末倒置)。
 */
import type { ZodRawShapeCompat } from '@modelcontextprotocol/sdk/server/zod-compat.js';
import { Type, type TSchema } from 'typebox';

/** zod v4 内部形状 —— 只读我们用到的字段, 其余 any 放开 (introspect, 不是 contract)。 */
interface ZodLike {
  _def?: {
    type?: string;
    innerType?: ZodLike;
    entries?: Record<string, string>;
    element?: ZodLike;
    keyType?: ZodLike;
    valueType?: ZodLike;
    shape?: Record<string, ZodLike>;
  };
  _zod?: { bag?: { format?: string; minimum?: number; maximum?: number; exclusiveMinimum?: number } };
  description?: string;
  minLength?: number;
  maxLength?: number;
}

function desc(t: ZodLike): string | undefined {
  return typeof t.description === 'string' && t.description.length > 0 ? t.description : undefined;
}

function zodTypeToTypebox(t: ZodLike, descOverride?: string): TSchema {
  const defType = t._def?.type;
  const description = descOverride ?? desc(t);
  const descOpt = description !== undefined ? { description } : {};

  switch (defType) {
    case 'string': {
      const opts: Record<string, unknown> = { ...descOpt };
      if (t.minLength != null) opts.minLength = t.minLength;
      if (t.maxLength != null) opts.maxLength = t.maxLength;
      return Type.String(opts);
    }
    case 'number': {
      const bag = t._zod?.bag ?? {};
      const isInt = bag.format === 'safeint';
      const opts: Record<string, unknown> = { ...descOpt };
      if (bag.minimum !== undefined) opts.minimum = bag.minimum;
      if (bag.maximum !== undefined) opts.maximum = bag.maximum;
      if (bag.exclusiveMinimum !== undefined) opts.exclusiveMinimum = bag.exclusiveMinimum;
      return isInt ? Type.Integer(opts) : Type.Number(opts);
    }
    case 'boolean':
      return Type.Boolean(descOpt);
    case 'optional':
      return Type.Optional(zodTypeToTypebox(t._def!.innerType!, description));
    case 'default':
      // zod `.default(v)` → typebox Optional (默认值由 MCP handler 侧防御式补, 见 path_add 头注)。
      return Type.Optional(zodTypeToTypebox(t._def!.innerType!, description));
    case 'enum': {
      const entries = t._def!.entries ?? {};
      const vals = Object.values(entries) as string[];
      if (vals.length === 0) return Type.Unknown();
      // Type.Enum 不收 description; 用 Union<Literal> 保留 describe (长枚举解释很值钱)。
      const literals = vals.map((v) => Type.Literal(v) as unknown as TSchema);
      return Type.Union(literals as unknown as [TSchema, TSchema, ...TSchema[]], descOpt);
    }
    case 'record':
      return Type.Record(Type.String(), Type.Unknown());
    case 'array':
      return Type.Array(zodTypeToTypebox(t._def!.element!));
    case 'object': {
      const shape = t._def!.shape ?? {};
      const fields: Record<string, TSchema> = {};
      for (const [k, v] of Object.entries(shape)) fields[k] = zodTypeToTypebox(v as ZodLike);
      return Type.Object(fields);
    }
    default:
      return Type.Unknown();
  }
}

/** ZodRawShapeCompat (Record<string, ZodType>) → Record<string, typebox TSchema>。 */
export function zodShapeToFields(shape: ZodRawShapeCompat): Record<string, TSchema> {
  const fields: Record<string, TSchema> = {};
  for (const [k, v] of Object.entries(shape)) {
    fields[k] = zodTypeToTypebox(v as unknown as ZodLike);
  }
  return fields;
}

/** 便捷包装: 整个 shape → Type.Object。 */
export function zodShapeToTypebox(shape: ZodRawShapeCompat): TSchema {
  return Type.Object(zodShapeToFields(shape));
}
