/**
 * src/harness/goal/sdd-self-check.test —— 切片 1「编译期挂 self_check」(C-1 · C-2)。
 *
 * SDD: 内环 v2 · 切片 1「compileBreakdown 给 sN 节点挂 self_check, 命令 = 该片 verify 列」。
 *
 * 承重的事:
 *  · INV-1  每个 sN 节点 ⇒ self_check.command 逐字等于该片 verify 列, expect_exit === 0。
 *  · INV-2  sN-green / sN-falsify-* / accept 三类节点**不挂** self_check。
 *  · INV-4  sN-green 节点仍在, command 与 expect_exit 与今天逐字相同 (D-2)。
 *
 * 反向自检 (切片 1 自带): 把 expect_exit: 0 改成 1 → 第一条 GWT 当场红,
 * 红的理由只准是「expect_exit 不是 0」。证伪后**必须还原**(本文件 runner 不替它还原)。
 */
import { describe, expect, test } from 'bun:test';
import { parseBreakdown, type SddBreakdown } from './sdd-direct';
import { compileBreakdown } from './sdd-compile';

const FULL_REGRESSION = 'bunx tsc --noEmit && bun test';

/** 两片: 1 写 src/a.ts, 2 依赖 1 写 src/b.ts, verify 各异 (供 GWT 逐字断言)。 */
const TWO_SLICES: SddBreakdown = parseBreakdown(
  [
    '# t',
    '## 契约 (Contracts)',
    '- G-1',
    '## 分解 (Breakdown)',
    '| 切片 | 写集 | 依赖 | verify |',
    '|---|---|---|---|',
    '| 1 a | src/a.ts | — | bun test src/a.test.ts |',
    '| 2 b | src/b.ts | 1 | bun test src/b.test.ts |',
    '',
    '并行波形:{1} → {2}',
  ].join('\n'),
);

/** 含 falsify 的两片 (供 INV-2 「falsify 节点不挂 self_check」使用)。
 *  反向自检小节必须在 `## 非目标` 之后 —— parseBreakdown 的 section 边界停在 `## `,
 *  `### 反向自检` 是 H3 不算边界, 会被当成切片行解析 (`cells[0]='#'` 触发「不以编号开头」)。
 *  与 falsify-compile.test.ts 同款解法 (那里的 `## 非目标` 把 falsify 推到段外)。 */
const TWO_SLICES_WITH_FALSIFY: SddBreakdown = parseBreakdown(
  [
    '# t',
    '## 契约 (Contracts)',
    '- G-1',
    '## 分解 (Breakdown)',
    '| 切片 | 写集 | 依赖 | verify |',
    '|---|---|---|---|',
    '| 1 a | src/a.ts | — | bun test src/a.test.ts |',
    '| 2 b | src/b.ts | 1 | bun test src/b.test.ts |',
    '',
    '并行波形:{1} → {2}',
    '',
    '## 非目标 (Non-goals)',
    '- 无',
    '',
    '### 反向自检 (切片 1)',
    '| # | 文件 | oldText | newText |',
    '|---|---|---|---|',
    '| 1 | src/a.ts | `const x = 1;` | `const x = 2;` |',
  ].join('\n'),
);

const compile = (b: SddBreakdown = TWO_SLICES) =>
  compileBreakdown(b, { acceptCommand: FULL_REGRESSION });

describe('compileBreakdown — C-1/C-2 挂 self_check (切片 1)', () => {
  test('GWT-1: s1 与 s2 都有 self_check, 命令 = 各自 verify 列, expect_exit = 0', () => {
    // 证伪 (切片 1 自带): 把 sN 节点里的 `expect_exit: 0` 改成 `1` → 本断言当场红,
    // 红的理由只可能是 `expect_exit` ≠ 0 (第二条 GWT 独立守「逐字等于 verify」)。
    const plan = compile();
    expect(plan.nodes['s1']!.self_check).toEqual({
      command: 'bun test src/a.test.ts',
      expect_exit: 0,
    });
    expect(plan.nodes['s2']!.self_check).toEqual({
      command: 'bun test src/b.test.ts',
      expect_exit: 0,
    });
  });

  test('GWT-2 (INV-2): s1-green / s2-green / accept 三类节点没有 self_check', () => {
    // 证伪: 若给 sN-green 也挂了 self_check → 下面三条全红。**D-2 不许动 GREEN 的 command
    // 与 expect_exit** —— 本测试只断言「不存在 self_check」, 不读 GREEN.command, 留给 GWT-3。
    const plan = compile();
    expect(plan.nodes['s1-green']!.self_check).toBeUndefined();
    expect(plan.nodes['s2-green']!.self_check).toBeUndefined();
    expect(plan.nodes['accept']!.self_check).toBeUndefined();
  });

  test('GWT-2 (INV-2): falsify 节点也不挂 self_check', () => {
    // 证伪: 若给 sN-falsify-N 节点挂了 self_check → 本断言红。INV-2 锁三类不挂。
    const plan = compile(TWO_SLICES_WITH_FALSIFY);
    const falsifyKey = 's1-falsify-1';
    expect(Object.keys(plan.nodes)).toContain(falsifyKey);
    expect(plan.nodes[falsifyKey]!.self_check).toBeUndefined();
  });

  test('GWT-3 (INV-4): s1-green 的 command 与 expect_exit 与今天逐字相同 (D-2 锁字面)', () => {
    // 证伪: 把 sN-green 节点的 command 改成别的 → 本断言红; 把 expect_exit 改成 1 → 红。
    // 这是 D-2 的核心锁 —— 内环会查 GREEN 的命令, 但「内环」是在叶子跑、不是改这条。
    const plan = compile();
    expect(plan.nodes['s1-green']!.command).toBe('bun test src/a.test.ts');
    expect(plan.nodes['s1-green']!.expect_exit).toBe(0);
    expect(plan.nodes['s2-green']!.command).toBe('bun test src/b.test.ts');
    expect(plan.nodes['s2-green']!.expect_exit).toBe(0);
  });

  test('阴性对照: 单片分解 (无依赖) 也照样挂 self_check', () => {
    // 防「只在多片循环里挂」漏写 —— 把切片表单切片化跑一遍, 仍要挂。
    const one = parseBreakdown(
      [
        '# t',
        '## 契约 (Contracts)',
        '- G-1',
        '## 分解 (Breakdown)',
        '| 切片 | 写集 | 依赖 | verify |',
        '|---|---|---|---|',
        '| 1 a | src/a.ts | — | bun test src/a.test.ts |',
      ].join('\n'),
    );
    const plan = compileBreakdown(one, { acceptCommand: FULL_REGRESSION });
    expect(plan.nodes['s1']!.self_check).toEqual({
      command: 'bun test src/a.test.ts',
      expect_exit: 0,
    });
    expect(plan.nodes['s1-green']!.self_check).toBeUndefined();
  });
});