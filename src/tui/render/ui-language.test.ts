/**
 * TUI 上屏文案只能用英文。
 *
 * 白名单只声明「这些 CJK 是数据而非文案」；末尾反测逐个证明白名单文件确实被扫描器命中，
 * 防止路径或字面量扫描退化后主闸永远绿。
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

const TUI_ROOT = join(import.meta.dir, '..');
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Bopomofo}\u3000-\u303f\uff01-\uff60]/u;

const DATA_ONLY_CJK: ReadonlyArray<{ file: string; reason: string }> = [
  {
    file: 'render/glyphs.ts',
    reason: 'CJK 字符是字形白名单与宽度探针的样本字符（被测对象），不是给人读的上屏文案',
  },
  {
    file: 'render/glyph-table.ts',
    reason: 'CJK 转义是字形白名单与宽度探针生成的量宽数据，不是给人读的上屏文案',
  },
];

interface Hit {
  file: string;
  line: number;
  snippet: string;
}

function tsFiles(dir: string, base = ''): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const rel = base ? `${base}/${name}` : name;
    if (statSync(full).isDirectory()) out.push(...tsFiles(full, rel));
    else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) out.push(rel);
  }
  return out;
}

interface Span {
  start: number;
  end: number;
}

/**
 * 字符串、模板原文和正则里的斜杠都不是注释起点。先让 TS 解析器标出这些区间，
 * 再剥注释；用空格替换而不删除，保证第二次解析得到的源码行号仍对应原文件。
 */
function stripComments(source: string, file: string): string {
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const protectedSpans: Span[] = [];

  function visit(node: ts.Node): void {
    if (ts.isStringLiteralLike(node) || ts.isTemplateLiteralToken(node) || ts.isRegularExpressionLiteral(node)) {
      protectedSpans.push({ start: node.getStart(parsed), end: node.getEnd() });
    }
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  protectedSpans.sort((a, b) => a.start - b.start);

  let out = '';
  let spanIndex = 0;
  for (let i = 0; i < source.length; ) {
    while (protectedSpans[spanIndex] && protectedSpans[spanIndex]!.end <= i) spanIndex++;
    const protectedSpan = protectedSpans[spanIndex];
    if (protectedSpan?.start === i) {
      out += source.slice(i, protectedSpan.end);
      i = protectedSpan.end;
      continue;
    }

    const lineComment = source.startsWith('//', i);
    const blockComment = source.startsWith('/*', i);
    if (!lineComment && !blockComment) {
      out += source[i];
      i++;
      continue;
    }

    const end = lineComment
      ? (source.indexOf('\n', i + 2) < 0 ? source.length : source.indexOf('\n', i + 2))
      : (source.indexOf('*/', i + 2) < 0 ? source.length : source.indexOf('*/', i + 2) + 2);
    for (; i < end; i++) out += source[i] === '\n' || source[i] === '\r' ? source[i] : ' ';
  }
  return out;
}

function sourceLine(source: string, position: number): string {
  const start = source.lastIndexOf('\n', Math.max(0, position - 1)) + 1;
  const nextNewline = source.indexOf('\n', position);
  return source.slice(start, nextNewline < 0 ? source.length : nextNewline).trim();
}

function cjkHits(file: string): Hit[] {
  const source = readFileSync(join(TUI_ROOT, file), 'utf8');
  const code = stripComments(source, file);
  const parsed = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const hits = new Map<string, Hit>();

  function record(position: number): void {
    const hit = {
      file,
      line: parsed.getLineAndCharacterOfPosition(position).line + 1,
      snippet: sourceLine(source, position),
    };
    hits.set(`${hit.line}:${hit.snippet}`, hit);
  }

  function visit(node: ts.Node): void {
    if (ts.isStringLiteralLike(node) || ts.isTemplateLiteralToken(node)) {
      const value = node.text;
      if (CJK.test(value)) {
        const start = node.getStart(parsed);
        const raw = source.slice(start, node.getEnd());
        const rawLines = raw.split('\n');
        let offset = 0;
        let foundLiteralLine = false;

        for (const rawLine of rawLines) {
          if (CJK.test(rawLine)) {
            record(start + offset);
            foundLiteralLine = true;
          }
          offset += rawLine.length + 1;
        }

        // 生成的 glyph-table 用 Unicode 转义保存 CJK；node.text 是解码后的被测字符。
        if (!foundLiteralLine) record(start);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  return [...hits.values()];
}

describe('TUI UI language', () => {
  it('字符串字面量里的上屏文案只能用英文', () => {
    const allowed = new Set(DATA_ONLY_CJK.map(({ file }) => file));
    const hits = tsFiles(TUI_ROOT)
      .filter((file) => !allowed.has(file))
      .flatMap(cjkHits);
    const report = hits.map(({ file, line, snippet }) => `${file}:${line}: ${snippet}`).join('\n');

    expect(hits, report || 'no CJK string literals').toEqual([]);
  });

  /** 反测：白名单是确有样本的数据声明，不是让任意文件逃过扫描的豁免表。 */
  it('反测：扫描器在每个白名单文件上确实命中 CJK', () => {
    for (const { file, reason } of DATA_ONLY_CJK) {
      expect(cjkHits(file).length, `${file}: ${reason}`).toBeGreaterThan(0);
    }
    expect(tsFiles(TUI_ROOT).length).toBeGreaterThan(30);
  });
});
