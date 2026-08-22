/**
 * Seam 目录闸 (A1)。两道闸的正反两面都在这里钉死:
 *  - 漂移闸: 盘上 docs/architecture/seams.md 必须与类型真源重新生成的结果逐字节相等
 *    (改了 Dag*Seam 接口没重跑生成器 → 本文件红; 手改生成文档 → 本文件红)。
 *  - 死旋钮闸: 字段在 src/ (非测试) 零消费 → 生成器拒 (用注入的假字段证明它真的会拒)。
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildCatalog, deadFields, extractSeams, renderCatalog, scanConsumers } from '../../../scripts/gen-seam-catalog';

const ROOT = join(import.meta.dir, '../../..');

describe('seam 目录 (gen-seam-catalog)', () => {
  const built = buildCatalog();

  test('漂移闸: 盘上目录与类型真源重新生成结果逐字节相等', () => {
    const onDisk = readFileSync(join(ROOT, 'docs/architecture/seams.md'), 'utf8');
    expect(onDisk).toBe(built.markdown);
  });

  test('漂移闸反向: 内容差一个字节即不等 (闸不是恒真式)', () => {
    const onDisk = readFileSync(join(ROOT, 'docs/architecture/seams.md'), 'utf8');
    expect(`${onDisk} `).not.toBe(built.markdown);
  });

  test('死旋钮闸: 当前 48 个字段全部有非测试消费方', () => {
    expect(built.dead).toEqual([]);
  });

  test('死旋钮闸反向: 注入一个仓里不存在的字段名, 闸必须点名拒它', () => {
    const fixture = `
      /** 假 seam */
      export interface DagZzzSeam {
        /** 没人消费的旋钮 */
        zzzUnusedKnob9?: boolean;
      }
    `;
    const seams = extractSeams(fixture);
    expect(seams).toHaveLength(1);
    scanConsumers(seams);
    expect(deadFields(seams)).toEqual(['DagZzzSeam.zzzUnusedKnob9']);
  });

  test('结构绊线: 8 seam / 49 字段 (改了分组或增删字段 → 抬这两个数并重跑生成器)', () => {
    // 刻意保留字面量 —— 派生成 length 就成恒真式, 绊线就没了 (同 seat-check 16→18 的先例)
    const seams = extractSeams(readFileSync(join(ROOT, 'src/harness/dag/types.ts'), 'utf8'));
    expect(seams).toHaveLength(8);
    expect(seams.reduce((n, s) => n + s.fields.length, 0)).toBe(49);
  });

  test('抽取保真: 必填/可选与 JSDoc 首句都进目录', () => {
    const fixture = `
      /** 组说明。 */
      export interface DagAaaSeam {
        /** 首句到此。第二句不进目录。 */
        alpha: string;
        beta?: number;
      }
    `;
    const [seam] = extractSeams(fixture);
    expect(seam!.fields).toEqual([
      expect.objectContaining({ name: 'alpha', optional: false, doc: '首句到此。' }),
      expect.objectContaining({ name: 'beta', optional: true, doc: '' }),
    ]);
    const md = renderCatalog([seam!]);
    expect(md).toContain('`alpha` | **是**');
  });
});
