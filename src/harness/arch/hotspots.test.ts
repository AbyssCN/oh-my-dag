/**
 * arch/hotspots 测试 —— 假 git log 输出注入 (零真 git): 计数 / 目录聚簇 / topK / scope 覆盖。
 */
import { describe, expect, test } from 'bun:test';
import { computeHotspots, countTouches } from './hotspots';

// 仿真 `git log --oneline --name-only -n N` 输出: 抬头行 + 文件行 + 空行分隔。
const FAKE_LOG = [
  'abc1234 feat: rework planner',
  'src/harness/plan/planner.ts',
  'src/harness/plan/types.ts',
  'src/harness/review/run.ts',
  '',
  'def5678 fix: planner edge case',
  'src/harness/plan/planner.ts',
  'docs/notes.md',
  '',
  '9abcdef chore: bump lockfile',
  'bun.lock',
  'package.json',
  '',
  'fedcba9 feat: review verify layer',
  'src/harness/review/run.ts',
  'src/harness/review/verify.ts',
  'src/harness/plan/planner.ts',
  '',
  '1234abc refactor: root script',
  'main.ts',
].join('\n');

describe('countTouches', () => {
  test('数文件触碰; 跳过 commit 抬头行/空行/非代码文件', () => {
    const counts = countTouches(FAKE_LOG);
    expect(counts.get('src/harness/plan/planner.ts')).toBe(3);
    expect(counts.get('src/harness/review/run.ts')).toBe(2);
    expect(counts.get('src/harness/plan/types.ts')).toBe(1);
    // 非代码文件不算摩擦
    expect(counts.has('docs/notes.md')).toBe(false);
    expect(counts.has('bun.lock')).toBe(false);
    expect(counts.has('package.json')).toBe(false);
    // 抬头行不被当文件
    expect([...counts.keys()].some((k) => k.startsWith('abc1234'))).toBe(false);
  });

  test('rename 行 (a -> b) 取新名', () => {
    const counts = countTouches('abc1234 mv\nsrc/old.ts -> src/new.ts\n');
    expect(counts.get('src/new.ts')).toBe(1);
    expect(counts.has('src/old.ts')).toBe(false);
  });
});

describe('computeHotspots', () => {
  test('按目录聚簇 + 触碰量降序; 组内文件降序', () => {
    const hs = computeHotspots(FAKE_LOG);
    expect(hs[0]!.dir).toBe('src/harness/plan'); // 3+1 = 4 触碰
    expect(hs[0]!.touches).toBe(4);
    expect(hs[0]!.files[0]!.path).toBe('src/harness/plan/planner.ts');
    expect(hs[1]!.dir).toBe('src/harness/review'); // 2+1 = 3
    expect(hs[1]!.touches).toBe(3);
    // 根文件归 '.'
    expect(hs.some((h) => h.dir === '.' && h.files[0]!.path === 'main.ts')).toBe(true);
  });

  test('topK 截断', () => {
    const hs = computeHotspots(FAKE_LOG, { topK: 1 });
    expect(hs.length).toBe(1);
    expect(hs[0]!.dir).toBe('src/harness/plan');
  });

  test('scope 覆盖: 只聚该前缀内的文件 (尾斜杠归一)', () => {
    const hs = computeHotspots(FAKE_LOG, { scope: 'src/harness/review' });
    expect(hs.length).toBe(1);
    expect(hs[0]!.dir).toBe('src/harness/review');
    expect(hs[0]!.files.map((f) => f.path).sort()).toEqual(['src/harness/review/run.ts', 'src/harness/review/verify.ts']);
    // 前缀是字面路径段, 不是字符串前缀 ('src/harness/rev' 不该命中 review)
    const none = computeHotspots(FAKE_LOG, { scope: 'src/harness/rev' });
    expect(none).toEqual([{ dir: 'src/harness/rev', files: [], touches: 0 }]);
  });

  test('scope 零命中 → 仍返回一个空热点 (扫描叶自己去探目录)', () => {
    const hs = computeHotspots(FAKE_LOG, { scope: 'src/untouched' });
    expect(hs).toEqual([{ dir: 'src/untouched', files: [], touches: 0 }]);
  });

  test('无 scope 且日志空 → 空数组', () => {
    expect(computeHotspots('')).toEqual([]);
  });
});
