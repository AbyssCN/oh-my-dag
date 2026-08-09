/**
 * L1:上下文健康度(切片⑤)。
 *
 * 反向自检:「平时不占位」那条 —— 把 line() 的 `if (!worst) return null` 改成返回空串,
 * 「两次不亮」当场红(空串会被 visible 判成占位)。
 */
import { describe, expect, test } from 'bun:test';
import { createContextHealth } from './health';

describe('createContextHealth', () => {
  test('★ 平时不占位: 没读过 / 读了两次 → null', () => {
    const h = createContextHealth();
    expect(h.line()).toBe(null);
    h.onTool('read', { path: 'a.ts' });
    h.onTool('read', { path: 'a.ts' });
    expect(h.line()).toBe(null);
  });

  test('★ 同一文件第 3 次 read → 亮, 报路径与次数', () => {
    const h = createContextHealth();
    for (let i = 0; i < 3; i++) h.onTool('read', { path: 'src/x.ts' });
    expect(h.line()).toContain('read src/x.ts 3x already');
  });

  test('只报最重的那个文件(一行, 不是第二张 HUD)', () => {
    const h = createContextHealth();
    for (let i = 0; i < 3; i++) h.onTool('read', { path: 'a.ts' });
    for (let i = 0; i < 5; i++) h.onTool('read', { path: 'b.ts' });
    expect(h.line()).toContain('b.ts 5x already');
    expect(h.line()).not.toContain('a.ts');
  });

  test('别的工具不计; 没 path 的 read 不计(不因脏参数崩)', () => {
    const h = createContextHealth();
    for (let i = 0; i < 5; i++) h.onTool('grep', { pattern: 'x', path: 'a.ts' });
    h.onTool('read', {});
    h.onTool('read', undefined);
    expect(h.line()).toBe(null);
  });

  test('reset 清零(换会话计数不带过去)', () => {
    const h = createContextHealth();
    for (let i = 0; i < 3; i++) h.onTool('read', { path: 'a.ts' });
    h.reset();
    expect(h.line()).toBe(null);
  });
});
