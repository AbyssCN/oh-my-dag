/**
 * 研究 bench runner 的选题半(纯函数,不点火)。
 *
 * 反向自检: 把 pickSmoke 的分层改成 `tasks.slice(0,3)` → 「三层各一个」当场红。
 */
import { describe, expect, test } from 'bun:test';
import { pickSmoke } from './research-bench-run';

const mk = (id: string, exploration: string, rubrics: number) => ({
  prompt: 'p', sample_id: id, exploration, rubrics: Array.from({ length: rubrics }, () => ({})),
});

describe('pickSmoke —— 冒烟选题按探索度分层', () => {
  test('★ 三层各取一个 (同类三个样本外推不出"搜索次数随探索度怎么涨")', () => {
    const tasks = [
      mk('lo1', 'Low', 30), mk('lo2', 'Low', 10),
      mk('me1', 'Medium', 25), mk('me2', 'Medium', 40),
      mk('hi1', 'High', 20), mk('hi2', 'High', 22),
    ];
    const got = pickSmoke(tasks);
    expect(got.map((t) => t.exploration)).toEqual(['Low', 'Medium', 'High']);
  });

  test('同层里挑 rubric 最少的 (冒烟阶段判分也便宜)', () => {
    const tasks = [mk('lo1', 'Low', 30), mk('lo2', 'Low', 10), mk('me1', 'Medium', 5), mk('hi1', 'High', 7)];
    expect(pickSmoke(tasks).map((t) => t.sample_id)).toEqual(['lo2', 'me1', 'hi1']);
  });

  test('某一层缺席 → 少给一个, 不拿别层凑数 (凑出来的分层不是分层)', () => {
    const tasks = [mk('lo1', 'Low', 3), mk('hi1', 'High', 4)];
    const got = pickSmoke(tasks);
    expect(got.map((t) => t.exploration)).toEqual(['Low', 'High']);
  });
});
