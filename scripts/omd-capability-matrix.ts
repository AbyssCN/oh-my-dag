/**
 * Capability matrix generator (2026-08-18, owner 拍板 docs/plan/2026-08-18-...).
 *
 * 真源 = src/mcp/tool-renames.ts + src/mcp/tools/pathfinder.ts + src/mcp/tools/goal.ts +
 * src/mcp/tools/dag-tools.ts (TS AST, 照抄 scripts/gen-seam-catalog.ts 的机制 —— createSourceFile
 * 走 + forEachChild 递归, 不用正则啃注释)。本脚本抽出 TOOL_RENAMES 映射与三层承诺 doc 注释、
 * 各工具 name 与 inputSchema 顶层键, 按上游冻结接口规格渲染出能力矩阵段落; 默认把渲染结果
 * 写回 .claude/CLAUDE.md 两条 marker 之间, --check 用 compareSegment 与盘上段落比对。
 *
 * CLI: bun scripts/omd-capability-matrix.ts         (无参 / --write = 替换对账段)
 *      bun scripts/omd-capability-matrix.ts --check  (与盘上比对, 不一致 exit 1)
 *
 * 冻结契约: docs/plan/2026-08-18-capability-matrix-冻结接口规格.md
 * 反向自检:
 *   ① 写后 readSegment + compareSegment 自检 → 不 ok 当场 exit 1 (capability-matrix §6);
 *   ② 绊线 3/8/19 硬编码, 与真源冲突 → throw (生成器 + 测试双层拒改, 不许就地改数);
 *   ③ test 假源 = 四个 SourceFiles 文本, 不读盘 (seam-catalog.test.ts 假源先例);
 *   ④ 起/止 marker 各恰好一次, 0/重复即红;
 *   ⑤ 任何漂移必出首个差异行号 + 盘上原文 + 重新生成原文 (compareSegment 出口唯一)。
 */
import ts from 'typescript';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

// ── 路径与冻结常量 ─────────────────────────────────────────────────────────────

const ROOT = join(import.meta.dir, '..');
const TOOL_RENAMES_PATH = join(ROOT, 'src/mcp/tool-renames.ts');
const PATHFINDER_PATH = join(ROOT, 'src/mcp/tools/pathfinder.ts');
const GOAL_PATH = join(ROOT, 'src/mcp/tools/goal.ts');
const DAG_TOOLS_PATH = join(ROOT, 'src/mcp/tools/dag-tools.ts');
const DOC_PATH = join(ROOT, '.claude/CLAUDE.md');

export const START_MARKER =
  '<!-- @@capability-matrix:start —— 本段由 scripts/omd-capability-matrix.ts 从代码真源生成; 手改必被 src/mcp/capability-matrix.test.ts 判红; 再生成: bun scripts/omd-capability-matrix.ts -->';
export const END_MARKER = '<!-- @@capability-matrix:end -->';

// ── 类型 (§2 签名冻结) ────────────────────────────────────────────────────────

export interface SourceFiles {
  toolRenames: string;
  pathfinder: string;
  goal: string;
  dagTools: string;
}

export interface MatrixTool {
  layer: 'map' | 'solve' | 'run';
  sourceName: string;
  publicName: string;
  params: string[];
}

export interface MatrixRow {
  param: string;
  solve: boolean;
  run: boolean;
}

export interface Matrix {
  promise: string;
  tools: MatrixTool[];
  rows: MatrixRow[];
}

export type CompareResult =
  | { ok: true; line: null }
  | { ok: false; line: number; onDiskLine: string; renderedLine: string };

export type ReadSegmentResult =
  | { ok: true; segment: string; startLine: number; endLine: number }
  | { ok: false; error: string };

// ── 内部: 抽 tool def (AST, 不用正则) ─────────────────────────────────────────

interface RawTool {
  sourceName: string;
  fileLayer: 'map' | 'solve' | 'run';
  fileOrder: number;
  inputSchemaKeys: string[];
}

function stringOrIdentText(node: ts.Node): string | undefined {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isIdentifier(node)) {
    return node.text;
  }
  return undefined;
}

function propertyNameText(name: ts.PropertyName): string {
  if (
    ts.isIdentifier(name) ||
    ts.isStringLiteral(name) ||
    ts.isNumericLiteral(name) ||
    ts.isPrivateIdentifier(name)
  ) {
    return name.text;
  }
  return name.getText();
}

function extractRawTools(source: string, fileLayer: 'map' | 'solve' | 'run'): RawTool[] {
  const sf = ts.createSourceFile('x.ts', source, ts.ScriptTarget.Latest, true);
  const tools: RawTool[] = [];
  let fileOrder = 0;
  const visit = (node: ts.Node): void => {
    if (ts.isObjectLiteralExpression(node)) {
      let name: string | undefined;
      let inputSchema: ts.ObjectLiteralExpression | undefined;
      for (const prop of node.properties) {
        if (!ts.isPropertyAssignment(prop)) continue;
        const key = propertyNameText(prop.name);
        if (key === 'name') {
          const v = stringOrIdentText(prop.initializer);
          if (v) name = v;
        } else if (key === 'inputSchema' && ts.isObjectLiteralExpression(prop.initializer)) {
          inputSchema = prop.initializer;
        }
      }
      if (name && inputSchema) {
        const keys = inputSchema.properties
          .filter(ts.isPropertyAssignment)
          .map((p) => propertyNameText(p.name))
          .filter((k) => k.length > 0);
        keys.sort(); // ASCII = 码点; 全仓参数名 ASCII, 默认 sort 即码点升序
        tools.push({ sourceName: name, fileLayer, fileOrder: fileOrder++, inputSchemaKeys: keys });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return tools;
}

// ── 内部: 抽 TOOL_RENAMES + 三层承诺 doc 注释 ─────────────────────────────────

interface ExtractedRenames {
  renames: Record<string, string>;
  promise: string;
}

function extractRenames(source: string): ExtractedRenames {
  const sf = ts.createSourceFile('x.ts', source, ts.ScriptTarget.Latest, true);
  let exportPos = -1;
  const renames: Record<string, string> = {};
  sf.forEachChild((node) => {
    if (
      ts.isVariableStatement(node) &&
      node.declarationList.declarations.some((d) => ts.isIdentifier(d.name) && d.name.text === 'TOOL_RENAMES')
    ) {
      exportPos = node.getEnd();
      const decl = node.declarationList.declarations[0]!;
      if (decl.initializer && ts.isObjectLiteralExpression(decl.initializer)) {
        for (const prop of decl.initializer.properties) {
          if (!ts.isPropertyAssignment(prop)) continue;
          const k = propertyNameText(prop.name);
          const v = stringOrIdentText(prop.initializer);
          if (k && v) renames[k] = v;
        }
      }
    }
  });
  if (exportPos < 0) throw new Error('extractRenames: TOOL_RENAMES 未找到');

  // file-level JSDoc = 含 ## 的 /** ... */, 必在 exportPos 前
  const before = source.slice(0, exportPos);
  const blockRe = /\/\*\*([\s\S]*?)\*\//g;
  let m: RegExpExecArray | null;
  let fileLevelDoc: string | undefined;
  while ((m = blockRe.exec(before)) !== null) {
    if (m[1]!.includes('## ')) {
      fileLevelDoc = m[1]!;
      break;
    }
  }
  if (fileLevelDoc === undefined) throw new Error('extractRenames: 未找到含 ## 的 JSDoc 块');

  // 剥每行 ' * ' (或 ' *') 前缀
  const stripped = fileLevelDoc.split('\n').map((l) => {
    const sm = l.match(/^ \* ?(.*)$/);
    return sm ? (sm[1] ?? '') : l;
  });

  // 跳标题 + 跳其后的空行
  let i = 0;
  while (i < stripped.length && stripped[i] === '') i++;
  if (i >= stripped.length) throw new Error('extractRenames: JSDoc 无标题');
  i++; // skip title
  while (i < stripped.length && stripped[i] === '') i++;

  // 收非空行, 遇 '## ' 停
  const body: string[] = [];
  while (i < stripped.length) {
    const line = stripped[i]!;
    if (line.startsWith('## ')) break;
    if (line !== '') body.push(line);
    i++;
  }
  const promise = body.join(' ');
  return { renames, promise };
}

// ── 公开: extractMatrix (纯函数, IO 之外唯一抽口) ─────────────────────────────

export function extractMatrix(sources: SourceFiles): Matrix {
  const { renames, promise } = extractRenames(sources.toolRenames);
  const mapRaw = extractRawTools(sources.pathfinder, 'map');
  const solveRaw = extractRawTools(sources.goal, 'solve');
  const runRaw = extractRawTools(sources.dagTools, 'run');

  // §4 入矩阵筛选: pathfinder 全部 → map_*; goal 仅 dag_goal → solve; dag-tools 仅 dag_run → run
  const mapIn = mapRaw;
  const solveIn = solveRaw.filter((t) => t.sourceName === 'dag_goal');
  const runIn = runRaw.filter((t) => t.sourceName === 'dag_run');

  // §4: TOOL_RENAMES 每条目须判得出一层 (key 须在 raw 抽取里出现)
  const allRawSources = new Set<string>([...mapRaw, ...solveRaw, ...runRaw].map((t) => t.sourceName));
  for (const key of Object.keys(renames)) {
    if (!allRawSources.has(key)) {
      throw new Error(`extractMatrix: TOOL_RENAMES 条目 "${key}" 找不到对应 sourceName 工具 (未判出层)`);
    }
  }

  // 层序 map_* → solve → run; 层内按 fileOrder 升序
  const layerRank = (l: 'map' | 'solve' | 'run'): number => (l === 'map' ? 0 : l === 'solve' ? 1 : 2);
  const ordered = [...mapIn, ...solveIn, ...runIn].sort((a, b) => {
    const la = layerRank(a.fileLayer);
    const lb = layerRank(b.fileLayer);
    if (la !== lb) return la - lb;
    return a.fileOrder - b.fileOrder;
  });

  const tools: MatrixTool[] = [];
  for (const t of ordered) {
    const publicName = renames[t.sourceName] ?? t.sourceName;
    // §4: 落 map_* 层者 publicName 必须 map_ 开头
    if (t.fileLayer === 'map' && !publicName.startsWith('map_')) {
      throw new Error(`extractMatrix: map_* 层工具 ${t.sourceName} → publicName "${publicName}" 不以 map_ 开头`);
    }
    tools.push({
      layer: t.fileLayer,
      sourceName: t.sourceName,
      publicName,
      params: t.inputSchemaKeys,
    });
  }

  // rows = dag_goal ∪ dag_run 参数名, 码点升序去重
  const solveKeys = new Set(tools.filter((t) => t.layer === 'solve').flatMap((t) => t.params));
  const runKeys = new Set(tools.filter((t) => t.layer === 'run').flatMap((t) => t.params));
  const union = [...new Set([...solveKeys, ...runKeys])];
  union.sort();
  const rows: MatrixRow[] = union.map((k) => ({
    param: k,
    solve: solveKeys.has(k),
    run: runKeys.has(k),
  }));

  // §5 绊线 (硬编码字面量, 不派生): 层数=3, map_*=8, 行数=18
  const layers = new Set(tools.map((t) => t.layer));
  if (layers.size !== 3 || !(layers.has('map') && layers.has('solve') && layers.has('run'))) {
    throw new Error(
      `勘察计数与代码冲突: 期望 层数=3 (map/solve/run 每层非空), 实际 层数=${layers.size} = {${[...layers].join(',')}}`,
    );
  }
  const mapCount = tools.filter((t) => t.layer === 'map').length;
  if (mapCount !== 8) {
    throw new Error(`勘察计数与代码冲突: 期望 map_* 层工具数=8, 实际 ${mapCount}`);
  }
  if (rows.length !== 18) {
    throw new Error(`勘察计数与代码冲突: 期望 矩阵行数=18, 实际 ${rows.length}`);
  }

  return { promise, tools, rows };
}

// ── 公开: renderSegment (§3 模板, 不含 marker 行) ────────────────────────────

export function renderSegment(matrix: Matrix): string {
  const lines: string[] = [];
  // 行 2
  lines.push(matrix.promise);
  const mapT = matrix.tools.filter((t) => t.layer === 'map');
  const solveT = matrix.tools.filter((t) => t.layer === 'solve');
  const runT = matrix.tools.filter((t) => t.layer === 'run');
  // 行 3-5
  lines.push(`- **map_* 层**(${mapT.length} 工具, pathfinder.ts): ${mapT.map((t) => `\`${t.publicName}\``).join(' · ')}`);
  lines.push(`- **solve 层**(${solveT.length} 工具, goal.ts): ${solveT.map((t) => `\`${t.publicName}\``).join(' · ')}`);
  lines.push(`- **run 层**(${runT.length} 工具, dag-tools.ts): ${runT.map((t) => `\`${t.publicName}\``).join(' · ')}`);
  // 行 6..15: 每工具一行
  for (const t of matrix.tools) {
    const namePart =
      t.publicName === t.sourceName
        ? `\`${t.sourceName}\``
        : `\`${t.publicName}\` ← \`${t.sourceName}\``;
    const paramsPart =
      t.params.length === 0 ? '(无参数)' : t.params.map((p) => `\`${p}\``).join(', ');
    lines.push(`- ${namePart}: ${paramsPart}`);
  }
  // 行 16-17
  lines.push('| 能力 | solve (dag_goal) | run (dag_run) |');
  lines.push('|---|---|---|');
  // 行 18..36: ✓ = U+2713, — = U+2014, 逐字节冻结
  for (const r of matrix.rows) {
    lines.push(`| \`${r.param}\` | ${r.solve ? '✓' : '—'} | ${r.run ? '✓' : '—'} |`);
  }
  return lines.join('\n');
}

// ── 公开: buildMatrix (IO 唯一入口, --check 与测试共用) ───────────────────────

export function buildMatrix(): string {
  const sources: SourceFiles = {
    toolRenames: readFileSync(TOOL_RENAMES_PATH, 'utf8'),
    pathfinder: readFileSync(PATHFINDER_PATH, 'utf8'),
    goal: readFileSync(GOAL_PATH, 'utf8'),
    dagTools: readFileSync(DAG_TOOLS_PATH, 'utf8'),
  };
  const matrix = extractMatrix(sources);
  return [START_MARKER, renderSegment(matrix), END_MARKER].join('\n');
}

// ── 公开: compareSegment / readSegment / describeCompareResult ────────────────

export function compareSegment(onDisk: string, built: string): CompareResult {
  const a = onDisk.split('\n');
  const b = built.split('\n');
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (a[i] !== b[i]) {
      return { ok: false, line: i + 1, onDiskLine: a[i] ?? '', renderedLine: b[i] ?? '' };
    }
  }
  return { ok: true, line: null };
}

export function readSegment(fileText: string): ReadSegmentResult {
  const lines = fileText.split('\n');
  const startIdxs: number[] = [];
  const endIdxs: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === START_MARKER) startIdxs.push(i);
    if (lines[i] === END_MARKER) endIdxs.push(i);
  }
  if (startIdxs.length === 0) return { ok: false, error: '起 marker 缺失' };
  if (startIdxs.length > 1) return { ok: false, error: `起 marker 重复 ${startIdxs.length} 次` };
  if (endIdxs.length === 0) return { ok: false, error: '止 marker 缺失' };
  if (endIdxs.length > 1) return { ok: false, error: `止 marker 重复 ${endIdxs.length} 次` };
  const sIdx = startIdxs[0]!;
  const eIdx = endIdxs[0]!;
  if (eIdx < sIdx) return { ok: false, error: 'marker 顺序错乱 (止在起之前)' };
  const segment = lines.slice(sIdx, eIdx + 1).join('\n');
  return { ok: true, segment, startLine: sIdx + 1, endLine: eIdx + 1 };
}

export function describeCompareResult(r: CompareResult): string {
  if (r.ok) return 'capability-matrix: 对账段与真源一致';
  return `capability-matrix 漂移: CLAUDE.md 对账段与真源不一致, 首差在第 ${r.line} 行\n  盘上: ${r.onDiskLine}\n  真源: ${r.renderedLine}`;
}

// ── CLI (import.meta.main 才跑) ───────────────────────────────────────────────

if (import.meta.main) {
  const arg = process.argv[2];
  if (arg === '--check') {
    let onDisk: string;
    try {
      onDisk = readFileSync(DOC_PATH, 'utf8');
    } catch (e) {
      console.error(`capability-matrix --check: ${DOC_PATH} 读失败: ${(e as Error).message}`);
      process.exit(1);
    }
    let built: string;
    try {
      built = buildMatrix();
    } catch (e) {
      console.error(`capability-matrix --check: ${(e as Error).message}`);
      process.exit(1);
    }
    const seg = readSegment(onDisk);
    if (!seg.ok) {
      console.error(`capability-matrix --check: ${seg.error}`);
      process.exit(1);
    }
    const cmp = compareSegment(seg.segment, built);
    if (!cmp.ok) {
      console.error(describeCompareResult(cmp));
      process.exit(1);
    }
    console.log('capability-matrix: 对账段与真源一致');
    process.exit(0);
  } else if (arg === undefined || arg === '--write') {
    let onDisk: string;
    try {
      onDisk = readFileSync(DOC_PATH, 'utf8');
    } catch (e) {
      console.error(`capability-matrix: ${DOC_PATH} 读失败: ${(e as Error).message}`);
      process.exit(1);
    }
    const seg = readSegment(onDisk);
    if (!seg.ok) {
      console.error(`capability-matrix: ${seg.error}`);
      process.exit(1);
    }
    let built: string;
    try {
      built = buildMatrix();
    } catch (e) {
      console.error(`capability-matrix: ${(e as Error).message}`);
      process.exit(1);
    }
    const lines = onDisk.split('\n');
    const before = lines.slice(0, seg.startLine - 1).join('\n');
    const after = lines.slice(seg.endLine).join('\n');
    const newText = before + '\n' + built + '\n' + after;
    try {
      writeFileSync(DOC_PATH, newText);
    } catch (e) {
      console.error(`capability-matrix: ${DOC_PATH} 写失败: ${(e as Error).message}`);
      process.exit(1);
    }
    // §6 写后自检: 重读 → readSegment + compareSegment
    const reread = readFileSync(DOC_PATH, 'utf8');
    const seg2 = readSegment(reread);
    if (!seg2.ok) {
      console.error(`capability-matrix: 写后自检 ${seg2.error}`);
      process.exit(1);
    }
    const cmp2 = compareSegment(seg2.segment, built);
    if (!cmp2.ok) {
      console.error(describeCompareResult(cmp2));
      process.exit(1);
    }
    console.log(`capability-matrix: 写入 ${relative(ROOT, DOC_PATH)}`);
    process.exit(0);
  } else {
    console.error('usage: bun scripts/omd-capability-matrix.ts [--check | --write]');
    process.exit(1);
  }
}