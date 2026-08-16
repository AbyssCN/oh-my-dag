/**
 * 闸红归因的判据网(#145 提议 5 Phase B1)。
 *
 * 这把尺子只有一个用途:量出来的数要能**决定 B2 做不做**。所以这份网的重点是
 * **三个桶不许混** —— `foreign`(够不着)与 `pathless`(不用归因)说明的事相反,
 * 合成一个 "unattributed" 就等于把这把尺子的刻度磨平了。
 */
import { describe, expect, test } from 'bun:test';
import { attributeBlame, renderAttribution } from './blame-attribution';
import type { LeafResult } from './types';

const leaf = (id: string, filesTouched: string[]): LeafResult =>
  ({ id, status: 'done', kind: 'agent', output: '', deps: [], usage: { in: 0, out: 0 }, filesTouched }) as LeafResult;

const table = (rs: LeafResult[]): Record<string, LeafResult> => Object.fromEntries(rs.map((r) => [r.id, r]));

/** 盘上存在性替身:把"哪些路径是真文件"变成显式输入,免得测试依赖真实 fs。 */
const statOf = (real: string[]) => (p: string): boolean => real.some((r) => p.endsWith(r));

const ROOT = '/repo';

// 真实形状: tsc 的诊断行 + 一条汇总行。
const TSC_OUT = [
  'src/screens/Leave.tsx(12,5): error TS2322: 类型不匹配',
  'src/screens/Leave.tsx(40,1): error TS7006: 隐式 any',
  'src/legacy/Untouched.tsx(3,3): error TS2304: 找不到名称',
  '',
  'Found 3 errors in 2 files.',
].join('\n');

describe('attributeBlame —— 三个桶', () => {
  test('★ 写者认领 / 本跑外文件 / 无路径 —— 三桶各归各的', () => {
    // 证伪: 把 foreign 与 pathless 合成一个桶 → 下面那两条断言分不开, 尺子失去决策力。
    const a = attributeBlame(TSC_OUT, table([leaf('w1', ['src/screens/Leave.tsx'])]), {
      root: ROOT,
      statFile: statOf(['src/screens/Leave.tsx', 'src/legacy/Untouched.tsx']),
    });
    expect(a.linesTotal).toBe(4); // 空行不进分母
    expect(a.byWriter).toEqual([
      {
        nodeId: 'w1',
        lines: [
          'src/screens/Leave.tsx(12,5): error TS2322: 类型不匹配',
          'src/screens/Leave.tsx(40,1): error TS7006: 隐式 any',
        ],
      },
    ]);
    // 盘上真有这个文件, 但本跑没人写过它 → **B2 够不着**
    expect(a.foreign).toEqual(['src/legacy/Untouched.tsx(3,3): error TS2304: 找不到名称']);
    // 没点名任何真实文件 → 汇总行, 无害
    expect(a.pathless).toEqual(['Found 3 errors in 2 files.']);
  });

  test('★ 一个写者都认不到 → byWriter 空, 而 foreign 非空(这是"形状不成立"的信号)', () => {
    // 这条是整把尺子存在的理由: 如果真跑下来长这样, B2(定向返修)就该停。
    const a = attributeBlame(TSC_OUT, table([leaf('w1', ['src/other/Nope.tsx'])]), {
      root: ROOT,
      statFile: statOf(['src/screens/Leave.tsx', 'src/legacy/Untouched.tsx']),
    });
    expect(a.byWriter).toEqual([]);
    expect(a.foreign.length).toBe(3);
    expect(a.pathless.length).toBe(1);
  });

  test('★ filesTouched 是绝对路径时按 root 归一化 —— 否则命中率会被系统性低估', () => {
    // 证伪: 把 rel 那行去掉(直接用 p)→ 本条红。agent leaf 自报的是它 cwd 下的路径,
    // 而诊断里那份是相对仓根的 —— 不归一化的话这把尺子会一路量出偏低的数, 而偏低的数
    // 会让人得出"B2 不成立"的错结论。
    const a = attributeBlame(TSC_OUT, table([leaf('w1', ['/repo/src/screens/Leave.tsx'])]), {
      root: ROOT,
      statFile: statOf(['src/screens/Leave.tsx', 'src/legacy/Untouched.tsx']),
    });
    expect(a.byWriter.map((w) => w.nodeId)).toEqual(['w1']);
    expect(a.byWriter[0]!.lines.length).toBe(2);
  });

  test('同一文件多写者 → 记先出现的那个(这一版不解决归属争议, 只求别丢行)', () => {
    const a = attributeBlame('src/a.ts(1,1): error', table([leaf('w1', ['src/a.ts']), leaf('w2', ['src/a.ts'])]), {
      root: ROOT,
      statFile: statOf(['src/a.ts']),
    });
    expect(a.byWriter.length).toBe(1);
    expect(a.byWriter[0]!.nodeId).toBe('w1');
  });

  test('★ 读数三个数分开印 —— 合并成一个"命中率"就废了这把尺子', () => {
    // 证伪: 让 renderAttribution 只印一个总命中率 → 本条红。
    const a = attributeBlame(TSC_OUT, table([leaf('w1', ['src/screens/Leave.tsx'])]), {
      root: ROOT,
      statFile: statOf(['src/screens/Leave.tsx', 'src/legacy/Untouched.tsx']),
    });
    const line = renderAttribution(a);
    expect(line).toContain('写者认领 2');
    expect(line).toContain('本跑外文件 1');
    expect(line).toContain('无路径 1');
  });

  test('空输入不炸, 分母为 0 时百分比印 —— 而不是 NaN', () => {
    const a = attributeBlame('', {}, { root: ROOT, statFile: () => false });
    expect(a.linesTotal).toBe(0);
    expect(renderAttribution(a)).toContain('—');
  });
});
