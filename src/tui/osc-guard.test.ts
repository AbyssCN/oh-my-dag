/**
 * src/tui/osc-guard.test —— 守卫的正反两面: 应答尾巴被吞, 真 Ctrl+G 不被吞。
 */
import { describe, expect, test } from 'bun:test';
import { createOscTailGuard, isDanglingOscPrefix } from './osc-guard';

const OSC11_HEAD = '\x1b]11;rgb:0c0c/0c0c/0c0c';

describe('isDanglingOscPrefix', () => {
  test('无终止符的 OSC 前缀 → true; 带 BEL / ST 的整段 → false; 非 OSC → false', () => {
    expect(isDanglingOscPrefix(OSC11_HEAD)).toBe(true);
    expect(isDanglingOscPrefix(`${OSC11_HEAD}\x07`)).toBe(false);
    expect(isDanglingOscPrefix(`${OSC11_HEAD}\x1b\\`)).toBe(false);
    expect(isDanglingOscPrefix('\x1b[I')).toBe(false);
    expect(isDanglingOscPrefix('\x07')).toBe(false);
  });
});

describe('createOscTailGuard', () => {
  test('★ 复现形态: 前缀 → 30ms 后 BEL → 两段都吞, 之后的 Ctrl+G 照常放行', () => {
    const g = createOscTailGuard();
    expect(g.feed(OSC11_HEAD, 0)).toBe('swallow');
    expect(g.feed('\x07', 30)).toBe('swallow');
    expect(g.feed('\x07', 60)).toBe('pass'); // 尾巴只吞一次
  });
  test('反向: 没有前缀在前, 落单 BEL 就是 Ctrl+G', () => {
    const g = createOscTailGuard();
    expect(g.feed('\x07', 0)).toBe('pass');
  });
  test('ST 形式的尾巴同样吞', () => {
    const g = createOscTailGuard();
    expect(g.feed(OSC11_HEAD, 0)).toBe('swallow');
    expect(g.feed('\x1b\\', 10)).toBe('swallow');
  });
  test('等尾巴期间来了别的键 → 清状态放行, 随后的 BEL 当按键', () => {
    const g = createOscTailGuard();
    expect(g.feed(OSC11_HEAD, 0)).toBe('swallow');
    expect(g.feed('a', 5)).toBe('pass');
    expect(g.feed('\x07', 10)).toBe('pass');
  });
  test('窗口过期后的 BEL 当按键', () => {
    const g = createOscTailGuard(100);
    expect(g.feed(OSC11_HEAD, 0)).toBe('swallow');
    expect(g.feed('\x07', 101)).toBe('pass');
  });
  test('整段到达的 OSC 应答不进守卫状态 (pi-tui 自己会消费它)', () => {
    const g = createOscTailGuard();
    expect(g.feed(`${OSC11_HEAD}\x07`, 0)).toBe('pass');
    expect(g.feed('\x07', 1)).toBe('pass');
  });
});
