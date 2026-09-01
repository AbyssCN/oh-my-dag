/**
 * src/harness/goal/sdd-legacy-breakdown.test —— 结晶器四列表 (切片|波形|写集|验证) 的兼容折叠
 * (票 t-spec-format · S-45 族)。
 *
 * 承重的事实 (run bd81b660 实测): goal 引擎的 `spec-author` 卡只说「Breakdown = construction
 * slices + dependencies」, **没钉列名**, 而它的 TDD SHAPE 段要求 TEST/RED/IMPL/GREEN 四片 ——
 * 结晶出来的表因此是「切片|波形|写集|验证」四列 + RED/GREEN 行写集写「同上」。直通 v2 要的是
 * 「切片|写集|依赖|verify」+ 写集两两不相交, 于是**引擎自己结晶的 spec 自己吃不下**
 * (当晚靠人工折叠绕过)。
 *
 * 下面这张表是 bd81b660 的真产物, 逐字取自
 * `docs/plan/2026-09-01-实现-pathfinder-票-t-gate-inmigrate-docs-plan-pathf.md` 的「### 切片表」
 * (只删了切片 7 名字里的一段, 与列结构无关)。
 *
 * 反向自检: 把 `parseBreakdown` 里的 `legacy ? foldLegacyRows(rows) : rows` 改成 `rows`
 * (即撤掉折叠) → 本文件三条用例当场红, 第一条报「写集有不像路径的项 "1"」——
 * 波形列被当成写集列。证伪完必须还原 (本文件 runner 不替它还原)。
 */
import { describe, expect, test } from 'bun:test';
import { parseBreakdown } from './sdd-direct';

/** bd81b660 结晶器真产物的分解段 (13 行四列表, 三个波形 + 一行全量验收)。 */
const LEGACY_SDD = [
  '# 实现 pathfinder 票 t-gate-inmigrate',
  '',
  '## 契约 (Contracts)',
  '- G-1 三闸内嵌后 night.sh 语义不变。',
  '',
  '## 分解 (Breakdown)',
  '',
  '### 切片表',
  '',
  '| 切片 | 波形 | 写集 | 验证 |',
  '|---|---|---|---|',
  '| 1 · TEST(闸 A/B/C 三道) | 1 | `src/harness/goal/ignition-preflight-extended.test.ts` | — |',
  '| 2 · RED(闸 A/B/C) | 1 | 同上 | `bun test src/harness/goal/ignition-preflight-extended.test.ts`, expect_exit 1 |',
  '| 3 · IMPL(`ignitionPreflight` opts 三字段 + 闸 A/B/C 顺序) | 1 | `src/harness/goal/ignition-preflight.ts` | — |',
  '| 4 · GREEN(闸 A/B/C) | 1 | 同上 | 同命令 expect_exit 0 |',
  '| 5 · TEST(`runGoal` 直调 + 默认加载) | 2 | `src/harness/goal/goal-preflight-wiring.test.ts` | — |',
  '| 6 · RED(`runGoal`) | 2 | 同上 | `bun test src/harness/goal/goal-preflight-wiring.test.ts`, expect_exit 1 |',
  '| 7 · IMPL(`runGoalInner` 入口直调 + 默认加载 + `goal-worker` 透传) | 2 | `src/harness/goal/run-goal.ts` + `scripts/goal-worker.ts` + `src/harness/cli-solve.ts` | — |',
  '| 8 · GREEN(`runGoal`) | 2 | 同上 | 同命令 expect_exit 0 |',
  '| 9 · TEST(night.sh 闸段删除 + dry-run 语义保护) | 3 | `scripts/autoresearch-night.test.ts`(新, 顶层) | — |',
  '| 10 · RED(night.sh) | 3 | 同上 | `bun test scripts/autoresearch-night.test.ts`, expect_exit 1 |',
  '| 11 · IMPL(night.sh L28-58 删除 + dry-run 报告三行) | 3 | `scripts/autoresearch-night.sh` | — |',
  '| 12 · GREEN(night.sh) | 3 | 同上 | 同命令 expect_exit 0 |',
  '| 13 · 全量验收 | — | — | `bun test && bunx tsc --noEmit`, expect_exit 0 |',
  '',
  '## 非目标 (Non-goals)',
  '- 无',
].join('\n');

describe('结晶器四列表 (切片|波形|写集|验证) → 直通 v2 的确定性折叠', () => {
  test('bd81b660 真产物过得了 parseBreakdown, 且按波形折成 3 片', () => {
    const { slices } = parseBreakdown(LEGACY_SDD);
    // 13 行四列表 = 3 个波形 (每波 TEST/RED/IMPL/GREEN) + 1 行全量验收。
    // 全量验收行没有写集也没有波形 —— accept 节点由 sdd-compile 自己生成, 不占切片位。
    expect(slices.map((s) => s.id)).toEqual([1, 2, 3]);
  });

  test('切片写集两两不相交 (直通 v2 的并行安全机器判据)', () => {
    const { slices } = parseBreakdown(LEGACY_SDD);
    expect(slices[0]!.writeSet).toEqual([
      'src/harness/goal/ignition-preflight-extended.test.ts',
      'src/harness/goal/ignition-preflight.ts',
    ]);
    expect(slices[1]!.writeSet).toEqual([
      'src/harness/goal/goal-preflight-wiring.test.ts',
      'src/harness/goal/run-goal.ts',
      'scripts/goal-worker.ts',
      'src/harness/cli-solve.ts',
    ]);
    expect(slices[2]!.writeSet).toEqual([
      'scripts/autoresearch-night.test.ts',
      'scripts/autoresearch-night.sh',
    ]);
    const seen = new Set<string>();
    for (const s of slices)
      for (const f of s.writeSet) {
        expect(seen.has(f)).toBe(false); // 相交 = 两片并行时互相覆盖
        seen.add(f);
      }
  });

  test('波形列变依赖列, RED/GREEN 的 expect_exit 与回指不进 verify', () => {
    const { slices } = parseBreakdown(LEGACY_SDD);
    expect(slices.map((s) => s.deps)).toEqual([[], [1], [2]]);
    // RED 行带的命令是那一波真正的判据; `同命令 expect_exit 0` 是回指不是命令, 折叠时丢掉,
    // 红/绿由 sdd-compile 生成的 sN-green 节点负责 (RED 节点 2026-08-22 已删)。
    expect(slices.map((s) => s.verify)).toEqual([
      'bun test src/harness/goal/ignition-preflight-extended.test.ts',
      'bun test src/harness/goal/goal-preflight-wiring.test.ts',
      'bun test scripts/autoresearch-night.test.ts',
    ]);
  });

  /**
   * 盘上第二份结晶器产物 (`docs/plan/2026-08-18-按-pathfinder-票-165-…`) 的两处变体:
   *  · 退出码写成中文「，期望退出码 1」而不是 `expect_exit 1`;
   *  · 表里插一行分组标题 (`| 波形 1 · 洞① … | | | |`), 四格里三格是空的。
   * 两处都不折掉的话, verify 会带着中文尾巴进 command 闸 (拒), 分组标题会变成一片空写集切片。
   */
  test('中文退出码尾巴与分组标题行 (第二份真产物的变体)', () => {
    const { slices } = parseBreakdown(
      [
        '# t',
        '## 契约 (Contracts)',
        '- G-1',
        '## 分解 (Breakdown)',
        '| 切片 | 波形 | 写集 | 验证 |',
        '|---|---|---|---|',
        '| 波形 1 · 洞① outcome-partial（TEST → RED → IMPL → GREEN） | | | |',
        '| 1 | 1 | src/harness/goal/outcome-partial.test.ts | — |',
        '| 2 | 1 | src/harness/goal/outcome-partial.test.ts | bun test src/harness/goal/outcome-partial.test.ts，期望退出码 1 |',
        '| 3 | 1 | src/harness/goal/run-goal.ts | — |',
        '',
        '## 非目标 (Non-goals)',
        '- 无',
      ].join('\n'),
    );
    expect(slices).toHaveLength(1);
    expect(slices[0]!.writeSet).toEqual([
      'src/harness/goal/outcome-partial.test.ts',
      'src/harness/goal/run-goal.ts',
    ]);
    expect(slices[0]!.verify).toBe('bun test src/harness/goal/outcome-partial.test.ts');
  });
});
