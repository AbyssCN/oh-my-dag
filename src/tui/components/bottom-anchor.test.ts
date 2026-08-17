/**
 * L1 判据:转录贴底(W3a 片 V1)。
 *
 * 反向自检(实跑):把 `Math.max(0, …)` 的 0 下限删掉 → 「超屏零垫」当场红(负长度数组抛);
 * 把垫行改到尾部 → 「垫在前」当场红。
 */
import { describe, expect, test } from 'bun:test';
import type { Component } from '@earendil-works/pi-tui';
import { BottomAnchor } from './bottom-anchor';

const fixed = (lines: string[]): Component => ({ render: () => [...lines], invalidate: () => {} });

describe('BottomAnchor —— 空腔在上不在下', () => {
  test('★ 内容 5 行 视口 20 → 前垫 15 行空串, 内容一字不动地在尾部', () => {
    const out = new BottomAnchor(fixed(['a', 'b', 'c', 'd', 'e']), () => 20).render(80);
    expect(out).toHaveLength(20);
    expect(out.slice(0, 15).every((l) => l === '')).toBe(true);
    expect(out.slice(15)).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  test('★ 内容 ≥ 视口 → 零垫, 逐字 = 子件输出 (I3: 超屏行为与今相同)', () => {
    const lines = Array.from({ length: 25 }, (_, i) => `l${i}`);
    expect(new BottomAnchor(fixed(lines), () => 20).render(80)).toEqual(lines);
  });

  test('视口未知 (0) 或负数 → 零垫 (冷启第一帧不炸)', () => {
    expect(new BottomAnchor(fixed(['x']), () => 0).render(80)).toEqual(['x']);
    expect(new BottomAnchor(fixed(['x']), () => -3).render(80)).toEqual(['x']);
  });
});
