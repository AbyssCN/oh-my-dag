/**
 * harness/report/trailer —— leaf 末条消息的**机器尾块** `omd-report`(P3 S3, 2026-09-02)。
 *
 * 散文归 verifier 与人读;引擎只读这一个 fenced block 里的事实。三态严格分开(D-12):
 *   · `missing`    = 没有 fence —— leaf 没报。**不单独判红**(INV-5),引擎合成一份并标 `self_report:'missing'`;
 *   · `unparsable` = 有 fence 但解析/校验不过 —— 按缺席处理, 原文留在 `raw` 供人核;
 *   · `parsed`     = 真值。
 *
 * 解析面刻意窄: YAML 子集 —— `key: scalar` / `key: [a, b]` / `key: |` 块标量。不引 yaml 库:
 * 尾块是我们自己定的形状, 七个键, 宽解析器只会把排版错读成别的意思。
 *
 * 证伪方式(trailer.test.ts): 把 `missing` 分支改成抛错 → 「无 fence → missing」即红;
 * 把 zod 校验拿掉 → 「解析失败 → unparsable 且 raw 原文在」即红。
 */
import { z } from 'zod';

export const TRAILER_FENCE = 'omd-report';

export const TrailerSchema = z
  .object({
    changed: z.array(z.string()),
    acceptance_ran: z.boolean(),
    acceptance_exit: z.number().int().nullable(),
    acceptance_tail: z.string().optional(),
    not_verified: z.array(z.string()),
    stuck: z.boolean(),
    next: z.string(),
  })
  .strict();
export type Trailer = z.output<typeof TrailerSchema>;

export type TrailerRead =
  | { kind: 'missing' }
  | { kind: 'unparsable'; raw: string; why: string }
  | { kind: 'parsed'; raw: string; trailer: Trailer };

/** 从末条消息里抽 fence 原文;多个取最后一个(leaf 可能改口, 末尾那份是它的最终陈述)。 */
export function extractTrailerRaw(text: string): string | null {
  const re = new RegExp('```' + TRAILER_FENCE + '[ \\t]*\\n([\\s\\S]*?)\\n```', 'g');
  let last: string | null = null;
  for (const m of text.matchAll(re)) last = m[1] ?? '';
  return last;
}

/** 解析一个标量: `true/false` → 布尔;`null` → null;整数 → 数字;引号串去引号;其余原样。 */
function scalar(v: string): unknown {
  const s = v.trim();
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'null' || s === '~') return null;
  if (/^-?\d+$/.test(s)) return Number(s);
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) return s.slice(1, -1);
  return s;
}

/** `[a, b, "c d"]` → 数组;空 `[]` → []。不支持嵌套(尾块里没有嵌套)。 */
function inlineList(v: string): unknown[] | null {
  const s = v.trim();
  if (!s.startsWith('[') || !s.endsWith(']')) return null;
  const inner = s.slice(1, -1).trim();
  if (!inner) return [];
  return inner.split(',').map((x) => scalar(x)).filter((x) => x !== '');
}

/**
 * YAML 子集 → 普通对象。行内 `# 注释` 只在标量值之后剥(引号内的 `#` 保留)。
 * 块标量 `key: |` 收后续更深缩进的行, 直到缩进回到列首。
 */
export function parseTrailerYaml(raw: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const m = /^([A-Za-z_][A-Za-z0-9_]*):(.*)$/.exec(line);
    if (!m) throw new Error(`第 ${i + 1} 行不是 \`key: value\`: ${line.slice(0, 80)}`);
    const key = m[1]!;
    let rest = m[2]!;
    // 剥行内注释(不在引号内)
    const hash = rest.search(/\s#/);
    if (hash >= 0 && !/^\s*["']/.test(rest)) rest = rest.slice(0, hash);
    const v = rest.trim();
    if (v === '|') {
      const block: string[] = [];
      while (i + 1 < lines.length && (/^\s+/.test(lines[i + 1]!) || lines[i + 1]!.trim() === '')) {
        i++;
        block.push(lines[i]!.replace(/^ {1,2}/, ''));
      }
      out[key] = block.join('\n').replace(/\n+$/, '');
      continue;
    }
    const list = inlineList(v);
    if (list) {
      out[key] = list;
      continue;
    }
    if (v === '') {
      // `key:` 后面紧跟 `  - item` 列表
      const items: unknown[] = [];
      while (i + 1 < lines.length && /^\s*-\s/.test(lines[i + 1]!)) {
        i++;
        items.push(scalar(lines[i]!.replace(/^\s*-\s*/, '')));
      }
      out[key] = items;
      continue;
    }
    out[key] = scalar(v);
  }
  return out;
}

/**
 * 把尾块从散文里摘掉 —— 给**散文正则**检出器(`plan/claimed-actions.ts`)喂的那份。
 * 尾块里 `acceptance_exit: 0` 这类机器字段会被散文规则当成「声称通过」误报;尾块自有差集闸审, 不该再被正则读一遍。
 */
export function stripTrailer(text: string): string {
  const re = new RegExp('```' + TRAILER_FENCE + '[ \\t]*\\n[\\s\\S]*?\\n```', 'g');
  return (text ?? '').replace(re, '').replace(/\n{3,}/g, '\n\n');
}

/** 三态读取。永不抛: 解析/校验失败落 `unparsable` 并带原文与原因。 */
export function readTrailer(text: string): TrailerRead {
  const raw = extractTrailerRaw(text ?? '');
  if (raw === null) return { kind: 'missing' };
  try {
    const obj = parseTrailerYaml(raw);
    const parsed = TrailerSchema.safeParse(obj);
    if (!parsed.success) return { kind: 'unparsable', raw, why: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
    return { kind: 'parsed', raw, trailer: parsed.data };
  } catch (err) {
    return { kind: 'unparsable', raw, why: (err as Error).message };
  }
}

/** 引擎合成的尾块(缺席时用): 事实全部来自记录, 不猜。 */
export function synthesizeTrailer(record: { changed?: readonly string[]; acceptance?: { ran: boolean; exit: number | null } | null }): Trailer {
  return {
    changed: [...(record.changed ?? [])],
    acceptance_ran: record.acceptance?.ran ?? false,
    acceptance_exit: record.acceptance?.exit ?? null,
    not_verified: [],
    stuck: false,
    next: '',
  };
}
