/**
 * scripts/omd-session-repair.test —— 修复计划的闸。
 *
 * ⚠ 判据钉的是「**先到的留、重复的丢**,而且丢了什么逐行说得出」——
 * 不是"文件能读了"。一个"能读了但悄悄少了两条消息"的修复比不修更坏。
 *
 * 证伪方式(实跑过):
 * - 把 `seen.has(l.seq)` 那一支改成"后到的覆盖先到的" → 「先到的留下」当场红;
 * - 把 header 那一支删掉(`l.kind === 'header'` 判断)→ 「header 不许被丢」当场红;
 * - 把坏行也当 keep → 「半截行要丢」当场红。
 */
import { describe, expect, test } from 'bun:test';
import { parseLines, planRepair } from './omd-session-repair';

const header = '{"kind":"header","version":4,"id":"t","createdAt":1,"cwd":"/x"}';
const entry = (seq: number, text: string): string => JSON.stringify({ kind: 'entry', seq, entry: { type: 'message', message: { role: 'user', content: text } } });

describe('planRepair', () => {
  test('好文件:一行不丢', () => {
    const plan = planRepair(parseLines([header, entry(1, 'a'), entry(2, 'b')].join('\n')));
    expect(plan.drop.length).toBe(0);
    expect(plan.keep.length).toBe(3);
  });

  test('★ 重复 seq:先到的留下, 后到的丢, 而且说得出 seq 与原文', () => {
    const plan = planRepair(parseLines([header, entry(1, 'a'), entry(2, '先到'), entry(2, '后到')].join('\n')));
    expect(plan.drop.length).toBe(1);
    expect(plan.drop[0]?.why).toContain('seq 2');
    expect(plan.drop[0]?.line.raw).toContain('后到');
    expect(plan.keep.map((l) => l.raw).join('')).toContain('先到');
  });

  test('★ header 不许被丢(它没有 seq, 但它是文件的身份)', () => {
    const plan = planRepair(parseLines([header, entry(1, 'a')].join('\n')));
    expect(plan.keep[0]?.kind).toBe('header');
  });

  test('★ 半截写入的尾行要丢, 理由写"解析不出来"', () => {
    const plan = planRepair(parseLines([header, entry(1, 'a'), '{"kind":"entr'].join('\n')));
    expect(plan.drop.length).toBe(1);
    expect(plan.drop[0]?.why).toContain('解析不出来');
  });

  test('空行不算行(尾部换行不该被当成坏行)', () => {
    expect(parseLines(`${header}\n${entry(1, 'a')}\n\n`).length).toBe(2);
  });
});
