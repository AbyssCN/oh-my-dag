/**
 * 责备集 (SDD 2026-08-10-blame-scoped-node-retry 切片 2) —— 解析 fail-open + 闭包语义。
 *
 * 反向自检 (实跑过): 把 blame.ts 的空数组守卫 (`parsed.length === 0`) 临时删掉 →
 * 「空数组 = 不合形」当场红; 把闭包不动点迭代删成单遍 → 「跨两跳下游」当场红。
 */
import { describe, expect, test } from 'bun:test';
import { invalidationClosure, parseBlameVerdict } from './blame';

describe('parseBlameVerdict (fail-open, INV-1)', () => {
  test('合形围栏解出条目', () => {
    const v = '判词散文。\n```blame\n[{"node": "draft", "reason": "验收段判卷命令不合格"}]\n```\n尾注。';
    expect(parseBlameVerdict(v)).toEqual([{ node: 'draft', reason: '验收段判卷命令不合格' }]);
  });

  test('无围栏 → undefined (走现行整轮)', () => {
    expect(parseBlameVerdict('纯散文打回, 不指认节点')).toBeUndefined();
  });

  test('JSON 坏 → undefined, 不抛 (证据留在判词原文)', () => {
    expect(parseBlameVerdict('```blame\n[{"node": }]\n```')).toBeUndefined();
  });

  test('空数组 = 「打回但谁都不怪」 → undefined (没有定点语义)', () => {
    expect(parseBlameVerdict('```blame\n[]\n```')).toBeUndefined();
  });

  test('条目缺 node/reason 或 node 空白 → 整批拒 (半好数据比没数据更危险)', () => {
    expect(parseBlameVerdict('```blame\n[{"node": "a", "reason": "r"}, {"node": "  "}]\n```')).toBeUndefined();
    expect(parseBlameVerdict('```blame\n[{"reason": "没指认节点"}]\n```')).toBeUndefined();
  });
});

describe('invalidationClosure (D-2: blamed ∪ downstream)', () => {
  // 图: survey ← draft ← polish; research 独立; report 依赖 draft+research
  const deps = {
    survey: [],
    research: [],
    draft: ['survey'],
    polish: ['draft'],
    report: ['draft', 'research'],
  } as const;

  test('责备 draft → draft + polish + report 失效, survey/research 保全 (G-1 的复用面)', () => {
    const c = invalidationClosure(['draft'], deps);
    expect([...c].sort()).toEqual(['draft', 'polish', 'report']);
  });

  test('跨两跳下游: 责备 survey → 全链失效, 独立的 research 不动', () => {
    const c = invalidationClosure(['survey'], deps);
    expect(c.has('draft')).toBe(true);
    expect(c.has('polish')).toBe(true);
    expect(c.has('report')).toBe(true);
    expect(c.has('research')).toBe(false);
  });

  test('幽灵节点原样保留 (调用方据此识破判官胡指 → fail-open 整轮)', () => {
    const c = invalidationClosure(['ghost'], deps);
    expect(c.has('ghost')).toBe(true);
    expect(c.size).toBe(1);
  });
});
