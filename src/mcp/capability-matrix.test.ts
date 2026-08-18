/**
 * Capability matrix 闸 (capability-matrix.test.ts).
 *
 * 五道闸的正反两面钉在这里:
 *  ① 正闸        — .claude/CLAUDE.md 两条 marker 之间的段落与 buildMatrix() 重新渲染的结果
 *                  逐字节相等; 漂移用手动比对 + throw, 报文给出首个不一致行号 + 盘上原文 +
 *                  重新生成原文 (这条规矩与 owner §"闸作者" 同源: 不能只写 expect(a).toBe(b),
 *                  等号失守时必须能指着行说话)。
 *  ② marker 唯一闸 — 两条 marker 各恰好出现一次; 0 次 / 重复即红 (clone / 误删 / 双重插入 都
 *                  一次拒收, 不靠 buildMatrix 顺带发现)。
 *  ③ 反闸一       — 在盘上段尾部加一个字节, 断言 compareSegment 判不等 (证明闸非恒真)。
 *  ④ 反闸二       — 喂一份假源 (伪造 TOOL_RENAMES + 伪造工具定义), 断言抽取 / 渲染确实
 *                  反映假源, 且与真源盘上比对被判为不一致。
 *  ⑤ 结构绊线     — 硬编码字面量 3 层 / 8 工具 / 18 行 (刻意不派生, 派生即恒真式)。
 *                  **冲突时请停下报「勘察计数与代码冲突」, 不许就地改数** —— 绊线是冻结判据,
 *                  抬数 = 先回 owner 重定冻结接口规格。
 *
 * 不建生成器的独立测试文件 (脚本端走假源 case 已覆盖)。不改 scripts/omd-capability-matrix.ts
 * 与 .claude/CLAUDE.md —— 闸是消费者, 生成器与文档改了就改了对账段, 不是改闸。
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildMatrix,
  compareSegment,
  describeCompareResult,
  extractMatrix,
  readSegment,
  renderSegment,
  START_MARKER,
  END_MARKER,
} from '../../scripts/omd-capability-matrix';

const ROOT = join(import.meta.dir, '../..');

describe('capability-matrix 对账闸', () => {
  // describe 顶层只算一次 buildMatrix + 读盘 — 子用例复用; 漂移判词也走同一份 built。
  const built = buildMatrix();
  const onDisk = readFileSync(join(ROOT, '.claude/CLAUDE.md'), 'utf8');

  // ───────────────────────────────────────────────────────────────────────
  // ① 正闸 — 盘上对账段与 buildMatrix() 重新渲染结果逐字节相等
  // ───────────────────────────────────────────────────────────────────────
  test('正闸: 盘上对账段与 buildMatrix() 逐字节相等 (漂移 = 命名行 + 两文本)', () => {
    const seg = readSegment(onDisk);
    if (!seg.ok) throw new Error(`readSegment: ${seg.error} (盘上 marker 异常, 见 §2 唯一性闸)`);
    const cmp = compareSegment(seg.segment, built);
    if (!cmp.ok) throw new Error(describeCompareResult(cmp));
  });

  // ───────────────────────────────────────────────────────────────────────
  // ② marker 唯一性闸 — 两条 marker 各恰好一次, 0 / 重复即红
  // ───────────────────────────────────────────────────────────────────────
  test('marker 唯一性: 起 / 止 marker 各恰好一次 (整行精确相等计数)', () => {
    const lines = onDisk.split('\n');
    const startCount = lines.filter((l) => l === START_MARKER).length;
    const endCount = lines.filter((l) => l === END_MARKER).length;
    if (startCount !== 1) {
      throw new Error(`起 marker 出现 ${startCount} 次, 期望 1 (整行等于 ${START_MARKER.slice(0, 32)}…)`);
    }
    if (endCount !== 1) {
      throw new Error(`止 marker 出现 ${endCount} 次, 期望 1 (整行等于 ${END_MARKER})`);
    }
  });

  // ───────────────────────────────────────────────────────────────────────
  // ③ 反闸一 — 段尾加一字节, 断言 compareSegment 判不等 (闸非恒真)
  // ───────────────────────────────────────────────────────────────────────
  test('反闸一: 段尾追加一个空格, compareSegment 必须判不等 (闸非恒真)', () => {
    const seg = readSegment(onDisk);
    if (!seg.ok) throw new Error(`readSegment: ${seg.error}`);
    const tampered = seg.segment + ' ';
    const cmp = compareSegment(tampered, built);
    if (cmp.ok) {
      throw new Error(
        `段尾 + 1 字节后 compareSegment 仍判 ok: 恒真了 — 没在比, 只在"返回 ok"`,
      );
    }
  });

  // ───────────────────────────────────────────────────────────────────────
  // ④ 反闸二 — 假源: 伪造 TOOL_RENAMES + 伪造工具定义
  //
  // 假源设计: 8 个 map_* 工具 (空 inputSchema, 不贡献 rows) + 1 个 dag_goal (9 独立键)
  // + 1 个 dag_run (另 9 独立键) → union = 18 rows, 三层都齐, map = 8, 全 绊线 通过
  // → extractMatrix + renderSegment 走全程, 真源盘上段与它必不一致。
  //  —— 一道闸同时证两件事: (a) 抽取 / 渲染真反映假源 (b) compareSegment 判红。 ─────
  test('反闸二: 假源 → 抽取反映假源 (promise / 工具名) + 渲染与真源盘上比对红', () => {
    // 抽出器只看 PropertyAssignment (ts.isPropertyAssignment), ShorthandPropertyAssignment
    // 不收 — 所以假源 inputSchema 必须用全写法 `k: v`, 不能用 `{ a0, a1 }`。
    const dagGoalKeys = Array.from({ length: 9 }, (_, i) => `a${i}: z`).join(', ');
    const dagRunKeys = Array.from({ length: 9 }, (_, i) => `b${i}: z`).join(', ');
    const goalTpl = `const tools: any[] = [{ name: 'dag_goal', inputSchema: { ${dagGoalKeys} } }];`;
    const runTpl = `const tools: any[] = [{ name: 'dag_run', inputSchema: { ${dagRunKeys} } }];`;

    const fakeSources = {
      toolRenames: `
/**
 * 假源说明。
 *
 * FAKE PROMISE FROM FAKE SOURCE.
 *
 * ## 为什么
 */
export const TOOL_RENAMES: Readonly<Record<string, string>> = {
  map_a: 'map_alpha',
};
`,
      pathfinder: `
const tools: any[] = [
  { name: 'map_a', inputSchema: {} },
  { name: 'map_b', inputSchema: {} },
  { name: 'map_c', inputSchema: {} },
  { name: 'map_d', inputSchema: {} },
  { name: 'map_e', inputSchema: {} },
  { name: 'map_f', inputSchema: {} },
  { name: 'map_g', inputSchema: {} },
  { name: 'map_h', inputSchema: {} },
];
`,
      goal: goalTpl,
      dagTools: runTpl,
    };

    let m: ReturnType<typeof extractMatrix>;
    try {
      m = extractMatrix(fakeSources);
    } catch (e) {
      throw new Error(`假源本应过 绊线 (3 层 / map=8 / rows=18), 却 throw: ${(e as Error).message}`);
    }

    // (a) 抽取真反映假源 — promise 与工具 sourceName 来自 fake, 不是真源
    if (m.promise !== 'FAKE PROMISE FROM FAKE SOURCE.') {
      throw new Error(`promise 没从假源抽 (期望 "FAKE PROMISE FROM FAKE SOURCE."): ${m.promise}`);
    }
    const sourceNames = m.tools.map((t) => t.sourceName).sort();
    const expectedSources = [
      ...Array.from({ length: 8 }, (_, i) => `map_${String.fromCharCode(97 + i)}`),
      'dag_goal',
      'dag_run',
    ].sort();
    if (sourceNames.join(',') !== expectedSources.join(',')) {
      throw new Error(`抽出的 sourceName 不是来自假源: got [${sourceNames.join(',')}] expected [${expectedSources.join(',')}]`);
    }
    if (m.rows.length !== 18) {
      throw new Error(`union rows 不是 18: ${m.rows.length}`);
    }

    // (b) 渲染反映假源 + 跟真源盘上比对红
    const rendered = renderSegment(m);
    if (!rendered.includes('FAKE PROMISE FROM FAKE SOURCE.')) {
      throw new Error('rendered 未含假源 promise (提取没进渲染)');
    }
    if (!rendered.includes('`map_a`') || !rendered.includes('`dag_goal`')) {
      throw new Error('rendered 未含假源工具名');
    }
    const cmp = compareSegment(rendered, built);
    if (cmp.ok) {
      throw new Error('假源 renderSegment 与真源盘上段 一致 — 抽取根本没读假源');
    }
  });

  // ───────────────────────────────────────────────────────────────────────
  // ⑤ 结构绊线 — 硬编码字面量 3 层 / 8 工具 / 18 行
  //   派生就成恒真式, 绊线消失。冲突请停下报「勘察计数与代码冲突」, 不许就地改数。
  //   抬数 = 回 owner 重定冻结接口规格 (capability-matrix 冻结接口规格 §5)。
  // ───────────────────────────────────────────────────────────────────────
  test('结构绊线: 3 层 / map_*=8 / 矩阵 18 行 (硬编码字面量)', () => {
    const seg = readSegment(onDisk);
    if (!seg.ok) throw new Error(`readSegment: ${seg.error}`);

    // 行 3-5: 三个层头 (- **map_* 层**(N 工具, ...), - **solve 层**, - **run 层**)
    const layerHeaders = seg.segment
      .split('\n')
      .filter((l) => /^-\s+\*\*(map_\* 层|solve 层|run 层)\*\*/.test(l));
    expect(layerHeaders).toHaveLength(3);

    // map_* 层工具数: 行 3 中 "(N 工具" 的 N; 不派生 — 直接期待字面量 8
    const mapLine = layerHeaders.find((l) => l.includes('map_* 层'));
    if (!mapLine) throw new Error('map_* 层头缺失 (理论上不会发生, 上一步已断言 3 个)');
    const m = mapLine.match(/\((\d+) 工具/);
    if (!m) throw new Error(`map_* 层头未含 (N 工具: ${mapLine}`);
    expect(m[1]).toBe('8');

    // 矩阵数据行: 行 18..35 = 18 行 "| `param` | ✓ | — |" 形态; 不派生 — 直接期待 18
    const dataRows = seg.segment
      .split('\n')
      .filter((l) => /^\| `\w+` \| ✓ \| — \|$|^\| `\w+` \| — \| ✓ \|$|^\| `\w+` \| ✓ \| ✓ \|$/.test(l));
    expect(dataRows).toHaveLength(18);
  });
});
