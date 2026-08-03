/**
 * `blocking-forks` 语料的结构闸 —— 零模型调用。
 *
 * ## 要害只有一条:**证据不许泄露答案**
 *
 * `--evidence` 臂额外喂给模型的是 `invocation`(什么在调用/承载这个产物)。这个臂要证明的是
 * **「补一条事实能不能修好那条失败」**,而不是「我提示得够不够明显」。
 *
 * 于是有两个会让整个 A/B **静默作废**的失手,而且都不会有任何红灯:
 * ① 只给失败那条补事实 → 等于手把手喂答案;
 * ② `invocation` 里出现结论词(可逆 / 不可逆 / 该停 / 红线 / 等人)→ 直接把标签写进了输入。
 *
 * 两条都不是"跑起来会错",是"跑出来的数没有意义" —— 那种失效不会自己现形, 所以要闸。
 */
import { describe, expect, test } from 'bun:test';
import { BLOCKING_FORK_CASES } from './blocking-forks';

/** 结论词表 —— 出现在 `invocation` 里即等于把标签写进输入。 */
const VERDICT_WORDS = ['可逆', '不可逆', '红线', '该停', '等人', 'red-line', 'reversible', '收不回'];

describe('blocking-forks 语料', () => {
  test('id 唯一; 两档两侧都非空 (免得哪档被误删后读数静静变成 —)', () => {
    const ids = BLOCKING_FORK_CASES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const tier of ['clear', 'hard'] as const) {
      const g = BLOCKING_FORK_CASES.filter((c) => c.tier === tier);
      expect(g.filter((c) => c.kind === 'red-line').length).toBeGreaterThan(0);
      expect(g.filter((c) => c.kind === 'reversible').length).toBeGreaterThan(0);
    }
  });

  test('每条都有 invocation —— 只给一部分补事实 = 手把手喂答案', () => {
    const missing = BLOCKING_FORK_CASES.filter((c) => !c.invocation?.trim()).map((c) => c.id);
    expect(missing, `${missing.join(', ')} 缺 invocation —— 证据臂必须两侧同样具体, 否则测到的是"我会不会提示"`).toEqual([]);
  });

  test('invocation 不许出现结论词 (那等于把标签写进输入)', () => {
    const leaks: string[] = [];
    for (const c of BLOCKING_FORK_CASES) {
      for (const w of VERDICT_WORDS) if (c.invocation.includes(w)) leaks.push(`${c.id} 含「${w}」`);
    }
    expect(leaks, `${leaks.join(' · ')} —— invocation 只许陈述调用关系与副作用面, 不许下结论`).toEqual([]);
  });

  test('两侧 invocation 长度量级相当 (一侧写得特别详细本身就是提示)', () => {
    const avg = (k: 'red-line' | 'reversible'): number => {
      const g = BLOCKING_FORK_CASES.filter((c) => c.kind === k);
      return g.reduce((s, c) => s + c.invocation.length, 0) / g.length;
    };
    const ratio = avg('red-line') / avg('reversible');
    // 0.6~1.6 是宽松带 —— 抓的是"一侧写成两倍长"这种量级失衡, 不是抠字数。
    expect(ratio).toBeGreaterThan(0.6);
    expect(ratio).toBeLessThan(1.6);
  });

  test('反向自检: 结论词闸真的会红 (不是恒真式)', () => {
    const leaky = { invocation: '该脚本每晚执行, 因此这是不可逆的' };
    expect(VERDICT_WORDS.some((w) => leaky.invocation.includes(w))).toBe(true);
    const clean = { invocation: '该脚本由生产 crontab 每晚 02:00 执行一次, 向用户群发送邮件' };
    expect(VERDICT_WORDS.some((w) => clean.invocation.includes(w))).toBe(false);
  });
});
