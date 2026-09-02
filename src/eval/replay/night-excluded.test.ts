/**
 * night-excluded.test —— 写集排除表的判别力 (契约 D-9)。
 *
 * 反向自检 —— **下面是真跑出来的读数**, 不是推的 (改一处再跑本文件):
 *  · 从 `NIGHT_EXCLUDED_GLOBS` 删掉 `src/eval/replay/**` 这一条  → 5 pass / 3 fail
 *  · 匹配判定改成恒 `false` (谁都不拦)                          → 2 pass / 6 fail
 *  · 匹配判定改成恒 `true` (全拦, 即「闸做成恒真」)             → 6 pass / 2 fail
 * 三个方向都能红 = 这把尺量的是排除表本身, 不是尺子。
 */
import { describe, expect, test } from 'bun:test';
import { NIGHT_EXCLUDED_GLOBS, touchesExcluded } from './night-excluded';

describe('night-excluded 排除表', () => {
  test('目标向量在表内 (改尺子 = 自己给自己判分)', () => {
    expect(touchesExcluded(['docs/plan/autoresearch-objective.md'])).toEqual([
      'docs/plan/autoresearch-objective.md',
    ]);
  });

  test('评估器代码在表内 (含本文件自身)', () => {
    expect(touchesExcluded(['src/eval/replay/fitness.ts'])).toHaveLength(1);
    expect(touchesExcluded(['src/eval/replay/select.ts'])).toHaveLength(1);
    expect(touchesExcluded(['src/eval/replay/night-excluded.ts'])).toHaveLength(1);
  });

  test('冻结语料在表内', () => {
    expect(touchesExcluded(['runs/autoresearch/corpus/manifest.json'])).toHaveLength(1);
  });

  test('autoresearch 脚本族在表内', () => {
    expect(touchesExcluded(['scripts/autoresearch-replay.ts'])).toHaveLength(1);
    expect(touchesExcluded(['scripts/autoresearch-session.ts'])).toHaveLength(1);
  });

  test('不误伤正常写集 (闸不是恒真)', () => {
    expect(
      touchesExcluded([
        'src/harness/dag/engine.ts',
        'src/harness/conductor-plan.ts',
        'docs/plan/NOTES.md',
        'runs/autoresearch/night-2026-09-02/cards.json',
        'scripts/omd-readout.ts',
      ]),
    ).toEqual([]);
  });

  test('`./` 前缀归一 (同一个文件两种写法判定一致)', () => {
    expect(touchesExcluded(['./src/eval/replay/fitness.ts'])).toHaveLength(1);
  });

  test('混合写集只回命中的那几条 (不是全有全无)', () => {
    const hits = touchesExcluded([
      'src/harness/dag/engine.ts',
      'src/eval/replay/fitness.ts',
      'docs/plan/autoresearch-objective.md',
    ]);
    expect(hits).toEqual(['src/eval/replay/fitness.ts', 'docs/plan/autoresearch-objective.md']);
  });

  test('表本身非空且逐条是相对仓根的 glob', () => {
    expect(NIGHT_EXCLUDED_GLOBS.length).toBeGreaterThanOrEqual(4);
    for (const g of NIGHT_EXCLUDED_GLOBS) {
      expect(g.startsWith('/')).toBe(false);
      expect(g.length).toBeGreaterThan(0);
    }
  });
});
