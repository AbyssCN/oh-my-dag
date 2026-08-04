/**
 * Terminal-Bench / Frontier-Bench 抽取面的闸(2026-08-05)。
 *
 * 两件事各一条会红的闸:
 * ① **参考解不许进仓树**(污染通道 —— 交接 21 §四本仓栽过, Anthropic 也栽过同一条);
 * ② **「任务文本携带多少规模信号」这个数要钉住** —— 它是"别在这两个集上问规模问题"那条
 *    决策的唯一依据, 数据换了要重新裁。
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  loadTerminalBenchTasks,
  spearman,
  spearmanExpertVsInstructionLength,
  spearmanExpertVsJunior,
  withBothTimeEstimates,
  withExpertTime,
  type TerminalBenchTask,
} from './tasks';

/**
 * 泄漏形状 —— **只认脚本自身的形状**(行首 shebang / 行首 `def test_`),
 * 不认任务说明里可以合法出现的行内代码示例。判据修订经过见下面那条测试的注释。
 */
const LEAK_SHAPE = /^#!\/(bin|usr)\/|^\s*def test_/m;

const load = (f: string): TerminalBenchTask[] =>
  JSON.parse(readFileSync(join(import.meta.dir, 'data', f), 'utf8')) as TerminalBenchTask[];

const TB = load('terminal-bench-2.1.json');
const FB = load('frontier-bench.json');

describe('抽取面', () => {
  test('默认加载的是 Terminal-Bench 2.1(89 题)', () => {
    expect(loadTerminalBenchTasks().length).toBe(89);
  });

  test('Frontier-Bench 74 题', () => {
    expect(FB.length).toBe(74);
  });

  test('字段面正好是我们要的那几个 —— 多一个都可能是污染通道', () => {
    const keys = new Set(TB.flatMap((t) => Object.keys(t)));
    expect([...keys].sort()).toEqual(
      ['category', 'description', 'difficulty', 'expertTimeMin', 'id', 'instruction', 'juniorTimeMin', 'name', 'subcategory'].sort(),
    );
  });

  /**
   * ⚠ 这条闸的**判据本身修过一次**(2026-08-05):初版把 `assert .+==` 当泄漏特征,
   * 结果误报 `pypi-server` —— 那题的**任务说明里合法写着**
   * ``a user could do `from vectorops import dotproduct; assert 1 == dotproduct([1,1],[0,1])` ``。
   * 那是规格不是答案。**我在自己的闸上又犯了一次"代理指标 ≠ 它本身"。**
   * 现在只留真正脚本形状的特征, 并配一条注入式反向自检证明它仍会红。
   */
  test('⚠ 参考解/测试脚本没有混进来(污染通道)', () => {
    const suspicious = [...TB, ...FB].filter((t) => LEAK_SHAPE.test(t.instruction));
    expect(suspicious.map((t) => t.id)).toEqual([]);
  });

  test('反向自检: 真塞一份参考解进去, 上面那条会红', () => {
    const forged = '#!/bin/bash\nset -euo pipefail\npython -m pip install .\n';
    expect(LEAK_SHAPE.test(forged)).toBe(true);
    // 而合法的任务说明(含行内 assert 示例)不许误报 —— 这正是修掉的那个误报
    const legit = 'a user could do `from vectorops import dotproduct; assert 1 == dotproduct([1,1], [0,1])`.';
    expect(LEAK_SHAPE.test(legit)).toBe(false);
  });

  test('估时缺席记 null 不记 0(NULL ≠ 0, 仓规第一条)', () => {
    const all = [...TB, ...FB];
    expect(all.every((t) => t.expertTimeMin === null || t.expertTimeMin > 0)).toBe(true);
    // TB 里确实有一题没标估时 —— 它必须是 null, 而不是被抹成 0 混进"最简单"那一档
    expect(TB.length - withExpertTime(TB).length).toBe(1);
  });

  test('两代的估时单位已归一到分钟(FB 原文记小时)', () => {
    // FB 最长的一题是 60 小时 = 3600 分钟; 若单位没归一, 这里会是 60。
    expect(Math.max(...withExpertTime(FB).map((t) => t.expertTimeMin!))).toBe(3600);
  });

  test('⚠ Frontier-Bench 没有初级估时 —— 缺席要读成 NaN, 不许读成 0', () => {
    expect(withBothTimeEstimates(FB).length).toBe(0);
    expect(Number.isNaN(spearmanExpertVsJunior(FB))).toBe(true); // 不是 0!
    // 而只需要 expert 的那个读数照常算得出来 —— 初版就是在这里被连坐滤空的
    expect(Number.isFinite(spearmanExpertVsInstructionLength(FB))).toBe(true);
  });
});

describe('⚠ 难度轴的诚实性 —— 任务文本携带多少「这活有多大」的信号', () => {
  test('人类难度轴自身自洽(专家估时 vs 初级估时)', () => {
    expect(spearmanExpertVsJunior(TB)).toBeGreaterThan(0.8);
  });

  test('但引擎看得到的信号很弱 —— 两个独立数据集一致', () => {
    // 这两个数是"别在这两个集上问『图随规模长吗』"那条决策的唯一依据。
    // 松一点的阈值(< 0.4)是刻意的: 钉死具体小数会在数据集小改时假红。
    expect(spearmanExpertVsInstructionLength(TB)).toBeLessThan(0.4);
    expect(spearmanExpertVsInstructionLength(FB)).toBeLessThan(0.4);
  });

  /**
   * ⚠ **这条闸抓到过一个真缺陷**:初版 `rank()` 按排序下标给秩, 并列由排序稳定性任意决定。
   * 专家估时正是 `5/15/30/60/180` 这种粗刻度, 并列极多 → `spearman(x, -x)` 算出 **−0.977**。
   * 也就是这把尺子连"完美反相关"都量不准。改成并列取平均秩(mid-rank)后归位。
   */
  test('反向自检: 这把尺子测得出完美 ±1(并列很多时也要准)', () => {
    const exp = withExpertTime(TB).map((t) => t.expertTimeMin!);
    expect(exp.length - new Set(exp).size).toBeGreaterThan(50); // 先证明这批数据**确实**并列成堆
    expect(spearman(exp, exp)).toBeCloseTo(1, 6);
    expect(spearman(exp, exp.map((v) => -v))).toBeCloseTo(-1, 6);
  });

  test('样本太少时返回 NaN, 不返回一个似是而非的 ±1', () => {
    expect(Number.isNaN(spearman([1, 2], [2, 4]))).toBe(true);
  });
});
