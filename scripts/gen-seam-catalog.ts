/**
 * Seam 目录生成器 (A1, 2026-08-17, dsh/cordis 吸收计划线 A)。
 *
 * 真源 = `src/harness/dag/types.ts` 里的 8 个 `Dag*Seam` 接口 (类型即目录)。本脚本用
 * TypeScript AST 抽出每个 seam 的字段 (名/必填/类型/JSDoc 首句), 再对 src/ 做 token 级
 * 消费方扫描, 生成 `docs/architecture/seams.md`。
 *
 * 两道闸 (与 schema-field-registry 同哲学 —— 纪律做成会红的闸, 不写散文):
 *   ① `--check`: 重新生成与盘上文件比对, 不一致 = 目录漂移 → exit 1;
 *   ② 死旋钮闸: 任一字段在 src/ (排除 types.ts 与 *.test.ts) 零消费 → exit 1 点名。
 *      消费判定是 token 级 `\b<name>\b`, 但**只扫代码**: 注释与字符串/模板字面量的正文
 *      先被 `stripNonCode` 抹成空格 (见那里的判据)。仍是上界 (泛名字段会多算, 但"至少一个
 *      真实消费方"这个闸只会因此更松不会误杀; 误杀方向 = 字段被消费却报零, token 扫描
 *      不会漏属性访问/解构/对象字面量三种形态)。
 *
 * 反向自检见 `src/harness/dag/seam-catalog.test.ts`。
 */
import ts from 'typescript';
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const TYPES_PATH = join(ROOT, 'src/harness/dag/types.ts');
const CATALOG_PATH = join(ROOT, 'docs/architecture/seams.md');

export interface SeamField {
  name: string;
  optional: boolean;
  typeText: string;
  /** JSDoc 首句 (无 JSDoc = 空串; 目录里显式印出来, 逼着补而不是藏)。 */
  doc: string;
  /** 非测试消费方文件 (仓相对路径, 按 token 命中数降序, 最多 3 个)。 */
  consumers: string[];
  consumerCount: number;
}

export interface Seam {
  name: string;
  doc: string;
  fields: SeamField[];
}

/** 从 types.ts 抽出全部 `Dag*Seam` 接口 (AST, 不用正则啃注释)。 */
export function extractSeams(source: string): Seam[] {
  const sf = ts.createSourceFile('types.ts', source, ts.ScriptTarget.Latest, true);
  const seams: Seam[] = [];
  sf.forEachChild((node) => {
    if (!ts.isInterfaceDeclaration(node)) return;
    const name = node.name.text;
    if (!/^Dag[A-Za-z]+Seam$/.test(name)) return;
    const fields: SeamField[] = [];
    for (const member of node.members) {
      if (!ts.isPropertySignature(member) || !member.name) continue;
      const fieldName = ts.isIdentifier(member.name) ? member.name.text : member.name.getText(sf);
      fields.push({
        name: fieldName,
        optional: member.questionToken != null,
        typeText: compactType(member.type ? member.type.getText(sf) : 'unknown'),
        doc: firstDocSentence(member, sf),
        consumers: [],
        consumerCount: 0,
      });
    }
    seams.push({ name, doc: firstDocSentence(node, sf), fields });
  });
  return seams;
}

function firstDocSentence(node: ts.Node, sf: ts.SourceFile): string {
  const jsDoc = (node as { jsDoc?: ts.JSDoc[] }).jsDoc;
  // 取最后一条: 接口紧邻的才是自己的 doc, 更早的块 (如文件级分组说明) 会被 TS 一并归到首个声明
  const raw = jsDoc?.[jsDoc.length - 1]?.comment;
  const text = typeof raw === 'string' ? raw : (raw?.map((c) => c.text).join('') ?? '');
  const flat = text.replace(/\s+/g, ' ').trim();
  if (!flat) return '';
  // 中文句号/分号或换段前的第一段; 目录只要一句话, 全文留在类型定义里
  const cut = flat.search(/。|\. /);
  const s = cut === -1 ? flat : flat.slice(0, cut + 1);
  void sf;
  return s.length > 120 ? `${s.slice(0, 117)}…` : s;
}

function compactType(t: string): string {
  const flat = t.replace(/\s+/g, ' ').trim();
  return flat.length > 60 ? `${flat.slice(0, 57)}…` : flat;
}

function* walkTs(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) yield* walkTs(p);
    else if (p.endsWith('.ts') && !p.endsWith('.test.ts') && !p.endsWith('.d.ts')) yield p;
  }
}

/**
 * 把注释与字符串/模板字面量的正文抹成空格 (长度与换行原样保留, 所以后面的 token 扫描
 * 与计数逻辑一个字都不用改)。散文提到某个字段名 ≠ 这个文件消费了那个接缝。
 *
 * 为什么必须过 TS 解析器, 两条更省的路都实测走不通:
 *   - 裸正则啃不动 `'http://x'` 里的 `//`、模板里的注释开头符, 反而会吃掉真代码;
 *   - 裸 `ts.createScanner` 无解析上下文, 实测在 `src/harness/dag/engine.ts` (332KB) 只吐
 *     7537 个 token 就到 EOF (模板/正则边界判错后整段被当字面量吞掉), 会把真消费方一起抹没。
 * 真解析器 511 个文件 ~0.5s, 这个量级不值得再省。
 *
 * 反向自检 (注释里的字段名不算消费方 / 真代码里的算) 见 `src/harness/dag/seam-catalog.test.ts`。
 */
export function stripNonCode(text: string): string {
  const sf = ts.createSourceFile('scan.ts', text, ts.ScriptTarget.Latest, true);
  const chars = text.split('');
  // 换行留着, 免得把跨行注释压成一行影响后续任何按行的读法; 抹成空格而非删除 = 偏移不变
  const blank = (from: number, to: number) => {
    for (let i = from; i < to; i++) if (chars[i] !== '\n') chars[i] = ' ';
  };
  const visit = (node: ts.Node): void => {
    const kids = node.getChildren(sf);
    // 注释是 trivia, 只挂在叶子 token 的 pos 前; 走到叶子才取, 免得同一段注释重复取 (抹两遍无害但白跑)
    if (kids.length === 0) for (const c of ts.getLeadingCommentRanges(text, node.pos) ?? []) blank(c.pos, c.end);
    if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      blank(node.getStart(sf), node.end);
    }
    for (const k of kids) visit(k);
  };
  visit(sf);
  return chars.join('');
}

/** 对 src/ 做一遍消费方扫描, 就地填充每个字段的 consumers。 */
export function scanConsumers(seams: Seam[], srcDir = join(ROOT, 'src')): void {
  const names = seams.flatMap((s) => s.fields.map((f) => f.name));
  const regexps = new Map(names.map((n) => [n, new RegExp(`\\b${n.replace(/^_/, '_?')}\\b`, 'g')]));
  const hits = new Map<string, Map<string, number>>(names.map((n) => [n, new Map()]));
  for (const file of walkTs(srcDir)) {
    if (file === TYPES_PATH) continue;
    const text = stripNonCode(readFileSync(file, 'utf8'));
    const rel = relative(ROOT, file);
    for (const [name, re] of regexps) {
      const count = text.match(re)?.length ?? 0;
      if (count > 0) hits.get(name)!.set(rel, count);
    }
  }
  for (const seam of seams) {
    for (const field of seam.fields) {
      const perFile = [...hits.get(field.name)!.entries()].sort((a, b) => b[1] - a[1]);
      field.consumerCount = perFile.length;
      field.consumers = perFile.slice(0, 3).map(([f]) => f);
    }
  }
}

/** 零消费字段 (死旋钮闸的判定输入)。 */
export function deadFields(seams: Seam[]): string[] {
  return seams.flatMap((s) => s.fields.filter((f) => f.consumerCount === 0).map((f) => `${s.name}.${f.name}`));
}

export function renderCatalog(seams: Seam[]): string {
  const lines: string[] = [];
  lines.push('# 引擎 Seam 目录 —— ExecutorDagConfig 的能力接缝');
  lines.push('');
  lines.push('<!-- 生成文件, 勿手改。真源 = src/harness/dag/types.ts 的 Dag*Seam 接口。');
  lines.push('     重新生成: bun scripts/gen-seam-catalog.ts ; 校验: bun scripts/gen-seam-catalog.ts --check -->');
  lines.push('');
  lines.push('每个 seam = 一组可替换能力。字段全文文档在类型定义里 (点进去看), 本目录回答三件事:');
  lines.push('**有哪些接缝 · 每个字段谁在消费 · 换实现该去哪换**。消费方是 token 级扫描的上界');
  lines.push('(只扫代码 —— 注释与字符串字面量里提到字段名不算消费), 列出命中最多的前 3 个文件。');
  lines.push('');
  const totalFields = seams.reduce((n, s) => n + s.fields.length, 0);
  lines.push(`> ${seams.length} 个 seam · ${totalFields} 个字段 · 扫描范围 src/**/*.ts (排除测试)`);
  lines.push('');
  for (const seam of seams) {
    lines.push(`## ${seam.name}`);
    lines.push('');
    if (seam.doc) lines.push(seam.doc, '');
    lines.push('| 字段 | 必填 | 类型 | 一句话 | 消费方 (前3) |');
    lines.push('|---|---|---|---|---|');
    for (const f of seam.fields) {
      const req = f.optional ? '' : '**是**';
      const consumers = f.consumers.map((c) => `\`${c}\``).join('<br>') || '—';
      lines.push(`| \`${f.name}\` | ${req} | \`${esc(f.typeText)}\` | ${esc(f.doc)} | ${consumers} (${f.consumerCount} 文件) |`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

function esc(s: string): string {
  return s.replaceAll('|', '\\|');
}

export function buildCatalog(): { markdown: string; dead: string[] } {
  const seams = extractSeams(readFileSync(TYPES_PATH, 'utf8'));
  scanConsumers(seams);
  return { markdown: renderCatalog(seams), dead: deadFields(seams) };
}

if (import.meta.main) {
  const check = process.argv.includes('--check');
  const { markdown, dead } = buildCatalog();
  if (dead.length > 0) {
    console.error(`seam-catalog: 死旋钮 —— 以下字段在 src/ (非测试) 零消费, 要么接上消费方要么删字段:`);
    for (const d of dead) console.error(`  - ${d}`);
    process.exit(1);
  }
  if (check) {
    let onDisk = '';
    try {
      onDisk = readFileSync(CATALOG_PATH, 'utf8');
    } catch {
      console.error(`seam-catalog --check: ${CATALOG_PATH} 不存在, 先跑一次生成`);
      process.exit(1);
    }
    if (onDisk !== markdown) {
      console.error('seam-catalog --check: docs/architecture/seams.md 与类型真源不一致 (漂移)。');
      console.error('重新生成: bun scripts/gen-seam-catalog.ts');
      process.exit(1);
    }
    console.log('seam-catalog --check: OK');
  } else {
    writeFileSync(CATALOG_PATH, markdown);
    console.log(`seam-catalog: 写入 ${relative(ROOT, CATALOG_PATH)}`);
  }
}
