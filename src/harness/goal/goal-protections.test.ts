/**
 * 机械提取受保护路径的契约测试 (SDD D4.2 切片 1: GWT-1a / GWT-1b / INV-1)。
 */
import { describe, expect, test } from 'bun:test';
import { extractProtectedPaths } from './goal-protections';

describe('INV-1 提取忠实且 fail-open', () => {
  test('GWT-1a bench 真题面形态: "不许改动测试文件 `path`" 一行 → 数组含该路径', () => {
    // 字面取自 src/eval/bench 实际生成的 statement (scripts/omd-bench.ts:120)。
    const goal =
      '本仓存在一个缺陷。\n' +
      '判据: `bun test src/eval/tasks/blocking-forks.test.ts` 必须通过。\n' +
      '⚠ **不许改动测试文件 `src/eval/tasks/blocking-forks.test.ts`** —— 判分前会逐字节核对。';
    const got = extractProtectedPaths(goal);
    expect(got).toContain('src/eval/tasks/blocking-forks.test.ts');
  });

  test('GWT-1a 四档动词逐个命中, 每个都把同行反引号路径提出来', () => {
    const cases: Array<[string, string]> = [
      ['不许改动', '不许改动 `a.ts`'],
      ['禁止修改', '禁止修改 `b.ts`'],
      ['不得改动', '不得改动 `c.ts`'],
      ['不许改动', '不许改动 `d.ts`'],
    ];
    for (const [, line] of cases) {
      const got = extractProtectedPaths(line);
      expect(got.length).toBe(1);
      expect(got[0]).toBe(line.match(/`([^`]+)`/)![1]);
    }
  });

  test('GWT-1a 同行多反引号: 全部按出现顺序提, 去重', () => {
    const goal = '不许改动 `src/a.ts` 与 `src/b.ts`, 也不许动 `src/a.ts`';
    expect(extractProtectedPaths(goal)).toEqual([
      'src/a.ts',
      'src/b.ts',
    ]);
  });

  test('GWT-1b 无任何禁令句 → 返回 [] (与今日逐字节同)', () => {
    const goal = [
      '本仓存在一个缺陷。',
      '判据: `bun test foo.test.ts` 必须通过。',
      '相关实现文件: src/foo.ts',
    ].join('\n');
    expect(extractProtectedPaths(goal)).toEqual([]);
  });

  test('GWT-1b 空串与全空白 → 返回 []', () => {
    expect(extractProtectedPaths('')).toEqual([]);
    expect(extractProtectedPaths('\n\n   \n')).toEqual([]);
  });

  test('★ 跨行路径不被吃: 动词在一行, 反引号路径在另一行 → 不提取', () => {
    const goal = [
      '不许改动测试文件, 详见下面这行。',
      '`src/should-not-be-picked.ts`',
    ].join('\n');
    expect(extractProtectedPaths(goal)).toEqual([]);
  });

  test('★ 散文禁令 (无路径) 不提取: "别动配置" → []', () => {
    const goal = [
      '这是一个无路径的禁令句。',
      '别动配置, 自己想办法。',
    ].join('\n');
    expect(extractProtectedPaths(goal)).toEqual([]);
  });

  test('★ 动词大小写敏感: 繁体/全角不被当作中文禁令动词', () => {
    const goal = '不許改動 `src/a.ts`';
    expect(extractProtectedPaths(goal)).toEqual([]);
  });
});