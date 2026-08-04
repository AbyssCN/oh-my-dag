/** G1/G2 语料规范表: 锚/失效点接地存在性 + 计数钉死。 */
import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { G1_ANCHORS, scoreG1 } from './g1-rubric';
import { G2_INVALIDATIONS, G2_CHANGE, scoreG2 } from './g2-registry';

const ROOT = new URL('../../../..', import.meta.url).pathname;

describe('G1/G2 语料规范表', () => {
  test('G1: 7 锚全部接地于真实存在的文件', () => {
    expect(G1_ANCHORS).toHaveLength(7);
    for (const a of G1_ANCHORS) expect(existsSync(join(ROOT, a.groundedIn)) ? '' : `${a.id} 证物不存在: ${a.groundedIn}`).toBe('');
  });

  test('G2: 4 失效点接地 + 变化描述含阈值两端数字', () => {
    expect(G2_INVALIDATIONS).toHaveLength(4);
    for (const v of G2_INVALIDATIONS) expect(existsSync(join(ROOT, v.groundedIn)) ? '' : `${v.id} 证物不存在`).toBe('');
    expect(G2_CHANGE).toContain('0.60');
    expect(G2_CHANGE).toContain('0.75');
  });

  test('评分器冒烟: 命中与不命中分得开', () => {
    expect(scoreG1('gh 后端还没有 path:suggested 的映射').hits).toContain('a1');
    expect(scoreG1('加个 AI 就好了').hits).toHaveLength(0);
    expect(scoreG2('阈值提高后语义去重命中会下降, 重复容易漏进图').hits).toContain('v1');
  });
});
