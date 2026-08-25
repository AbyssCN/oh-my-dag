/**
 * src/harness/goal/accept-distill.test —— A3 蒸馏族排除的反向自检
 * (SDD 2026-08-25 A3, run 74c5cf10 冤案: 两条 ugrep verify 蒸馏出无文件废令)。
 *
 * 每条 test 注释里写**反向自检**(把该闸摘掉 test 当场红的方式)。
 */
import { describe, expect, test } from 'bun:test';
import { parseBreakdown, type SddBreakdown } from './sdd-direct';
import { acceptCommandFromBreakdown } from './sdd-compile';

const bdRows = (rows: string[]): SddBreakdown =>
  parseBreakdown(['## 分解 (Breakdown)', '| 切片 | 写集 | 依赖 | verify |', '|---|---|---|---|', ...rows].join('\n'));

describe('accept-distill — 检视族 (NON_REGRESSION_HEADS) 不进 fullRegression (INV-1)', () => {
  test('GWT-1 run 74c5cf10 真实形状: ugrep verify 蒸馏出裸形不带路径,且含 bun test', () => {
    // 反向自检: 把 NON_REGRESSION_HEADS 检查从 acceptCommandFromBreakdown 摘掉 →
    // 全量环多出 `ugrep -q lensCount` 与 `ugrep -q webQueries` 两段, 两条 expect 同步红。
    const cmd = acceptCommandFromBreakdown(
      bdRows([
        '| 1 a | src/a.ts | — | `ugrep -q lensCount src/harness/conductor-plan.ts && bun test ./src/harness/research/lens-count-wiring.test.ts` |',
        '| 2 b | src/b.ts | — | `ugrep -q webQueries src/harness/research/fanout.ts && bun test ./src/harness/research/second-pass-search.test.ts` |',
      ]),
    )!;
    const segs = cmd.split('&&').map((s) => s.trim());
    expect(cmd.includes('ugrep -q lensCount src/harness/conductor-plan.ts')).toBe(true);
    expect(segs).not.toContain('ugrep -q lensCount');
    expect(segs).not.toContain('ugrep -q webQueries');
    expect(segs).toContain('bun test');
  });

  test('GWT-2 pytest 跨生态裸形 (非检视族) 仍蒸出: `pytest tests/x.py` → 末环 `pytest`', () => {
    // 反向自检: 即便族排除把 `pytest` 也加进 NON_REGRESSION_HEADS → 末环消失, expect 红。
    const cmd = acceptCommandFromBreakdown(bdRows(['| 1 a | src/a.ts | — | `pytest tests/x.py` |']))!;
    const segs = cmd.split('&&').map((s) => s.trim());
    expect(segs[segs.length - 1]).toBe('pytest');
  });
});
