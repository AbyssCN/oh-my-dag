/**
 * drift-sig-position: edit 的签名带**改动位置** (SDD §C-1 / §C-2, 2026-08-22)。
 *
 * 背景: 今天的签名 = 工具名 + 路径, 不含改动位置。
 * 改同一个文件的 N 处 = N 次同签名 → sameCount 超阈值 (默认 4) → 判 spin → 累计 10 回合 → 熔断。
 * 而多点改动是合法工作 (尤其 TDD 多点迭代 + 测试失败重改) —— 它不是空转。
 *
 * 本片把 edit 的签名扩成 `edit:<pathSig>#<hash8(oldText前 32 字符)>`, 让:
 *   · "改同一处的 N 次" → 仍触发 spinning (闸没钝);
 *   · "改同一文件的不同处" → 不再被并成同一个签名 (闸没误报)。
 *
 * ## 反向自检注入方式 (E-2, verifier 必看的两条故障注入剧本)
 *
 * 注入 A —— 把位置指纹去掉 (签名退回纯路径):
 *   改: 把 computeSig 里 edit 分支整段删掉 (恢复成 `return ${toolName}:${pathSig(path)}` 单一返回)
 *   应红: 「INV-2 同一文件不同 oldText ⇒ 不同签名」(a === b, 但不同 anchor)
 *        + 「GWT: 同一文件 5 次 edit 不同 oldText → 不触发 spinning」(5 个不同 anchor 也都同 sig)
 *   还原: 把 edit 分支恢复完整。
 *
 * 注入 B —— 改成每次都不同的随机签名:
 *   改: `posHash = Math.random().toString(16).slice(0, 8)`
 *   应红: 「INV-6 同一文件同一处连改 ≥ 阈值 → 仍触发 spinning」(5 次同 oldText 每次不同 sig → spinEvents = 0)
 *        + 「GWT: 同一文件 5 次 edit 同一 oldText → 触发 spinning」
 *   还原: 恢复成 `Bun.hash(oldText.slice(0, 32))` 计算。
 */
import { describe, expect, test } from 'bun:test';
import { computeSig, createDriftTracker } from './drift-detector';

describe('C-1 · INV-1 edit 且能取到 oldText ⇒ 签名为 edit:<pathSig>#<hash8>', () => {
  test('短路径 edit + oldText → 返回 #<8 位 hex> 后缀', () => {
    const sig = computeSig('edit', { path: 'src/some/file.ts', oldText: 'foo', newText: 'bar' });
    expect(sig).toMatch(/^edit:src\/some\/file\.ts#[0-9a-f]{8}$/);
  });

  test('长路径 edit + oldText → 仍 #<hash8>, path 段用取尾形式', () => {
    const longPath = '/home/dev/repos/oh-my-dag/.omd/runs/abc/src/some/file.ts'.padEnd(120, 'x');
    const sig = computeSig('edit', { path: longPath, oldText: 'foo', newText: 'bar' });
    expect(sig).toMatch(/^edit:…[^\s]+#[0-9a-f]{8}$/);
    // 不带 # 后会失败
    expect(sig).toContain('#');
  });

  test('edit 也吃 file_path 参数 (与既有兼容, 不破坏 hashline_edit 那条路径)', () => {
    const sig = computeSig('edit', { file_path: 'src/x.ts', oldText: 'a', newText: 'b' });
    expect(sig).toMatch(/^edit:src\/x\.ts#[0-9a-f]{8}$/);
  });
});

describe('C-1 · INV-2 同一文件不同 oldText ⇒ 不同签名', () => {
  test('同 path + 不同 oldText → 签名不同', () => {
    const a = computeSig('edit', { path: 'src/x.ts', oldText: 'const A = 1', newText: 'const A = 2' });
    const b = computeSig('edit', { path: 'src/x.ts', oldText: 'const B = 1', newText: 'const B = 2' });
    expect(a).not.toBe(b);
  });

  test('同 path + oldText 仅差一字符 → 签名不同 (位置指纹敏感到 anchor)', () => {
    const a = computeSig('edit', { path: 'src/x.ts', oldText: 'foo bar', newText: 'x' });
    const b = computeSig('edit', { path: 'src/x.ts', oldText: 'foo baz', newText: 'x' });
    expect(a).not.toBe(b);
  });
});

describe('C-1 · INV-3 同一文件同一 oldText ⇒ 相同签名', () => {
  test('同 path + 同 oldText → 完全相同签名', () => {
    const args = { path: 'src/x.ts', oldText: 'same anchor', newText: 'x' };
    expect(computeSig('edit', args)).toBe(computeSig('edit', args));
  });

  test('newText 不同时同 anchor → 签名仍相同 (新内容不参与位置指纹)', () => {
    const a = computeSig('edit', { path: 'src/x.ts', oldText: 'anchor', newText: 'replace-1' });
    const b = computeSig('edit', { path: 'src/x.ts', oldText: 'anchor', newText: 'replace-2' });
    expect(a).toBe(b);
  });
});

describe('C-1 · INV-4 edit 取不到 oldText ⇒ 退回纯路径签名 (fail-open)', () => {
  test('edit 无 oldText 字段 → edit:<pathSig>, 无 # 后缀', () => {
    const sig = computeSig('edit', { path: 'src/a.ts', newText: 'something' });
    expect(sig).toBe('edit:src/a.ts');
  });

  test('edit oldText 是空字符串 → 同样退回 (fail-open, 不算新签名)', () => {
    const sig = computeSig('edit', { path: 'src/a.ts', oldText: '', newText: 'something' });
    expect(sig).toBe('edit:src/a.ts');
  });

  test('edit path 也缺席 → 落到既有兜底 (键名签名), 不崩', () => {
    const sig = computeSig('edit', { oldText: 'x', newText: 'y' });
    expect(sig).toBe('edit:newText,oldText'); // 既有行为
  });
});

describe('C-1 · INV-5 write / read / grep / ls / bash 签名逐字不变', () => {
  test('write 仍是 write:<pathSig>', () => {
    expect(computeSig('write', { path: 'src/a.ts', content: 'x' })).toBe('write:src/a.ts');
  });
  test('write 长路径 → 仍是 write:…<尾 60>', () => {
    const longPath = `/home/dev/repos/oh-my-dag/.omd/runs/abc/${'x'.repeat(80)}.ts`;
    expect(computeSig('write', { path: longPath, content: 'x' })).toBe(`write:…${longPath.slice(-60)}`);
  });
  test('read 仍是 read:<pathSig>', () => {
    expect(computeSig('read', { path: 'src/a.ts' })).toBe('read:src/a.ts');
  });
  test('grep 仍是 grep:<pattern 前 60>', () => {
    expect(computeSig('grep', { pattern: 'TODO' })).toBe('grep:TODO');
  });
  test('ls 仍是 ls:<pathSig>', () => {
    expect(computeSig('ls', { path: 'src' })).toBe('ls:src');
  });
  test('bash 仍是 bash:<cd 剥后前 50>', () => {
    const cmd = 'cd /tmp/jail && bun test a.test.ts';
    expect(computeSig('bash', { command: cmd })).toBe('bash:bun test a.test.ts');
  });
  test('hashline_edit 仍走 patch 头提取路径 (既有行为, 不在写集内)', () => {
    const patch = '¶src/a.ts#a1b2\nreplace 3..3:\n+new line';
    expect(computeSig('hashline_edit', { patch })).toBe('hashline_edit:src/a.ts');
  });
});

describe('C-2 · INV-6 同一文件同一处连改 ≥ 阈值 → 仍触发 spinning (闸没钝)', () => {
  test('edit 同 path + 同 oldText × 4 → spinningDetected', () => {
    const t = createDriftTracker({ threshold: 4 });
    const args = { path: 'src/x.ts', oldText: 'same anchor', newText: 'whatever' };
    for (let i = 0; i < 4; i++) t.note('edit', args);
    expect(t.summary().spinEvents).toBe(1);
  });

  test('edit 同 path + 同 oldText × 5 → 仍是 1 个 spinEvents, maxSameCount = 5', () => {
    const t = createDriftTracker({ threshold: 4 });
    const args = { path: 'src/x.ts', oldText: 'same anchor', newText: 'whatever' };
    for (let i = 0; i < 5; i++) t.note('edit', args);
    const s = t.summary();
    expect(s.spinEvents).toBe(1);
    expect(s.maxSameCount).toBe(5);
  });
});

describe('GWT · 同一文件 5 次 edit 不同 oldText → 不触发 spinning', () => {
  test('5 个不同 anchor → 5 个不同签名 → spinEvents = 0', () => {
    const t = createDriftTracker({ threshold: 4 });
    const anchors = ['anchor-1', 'anchor-2', 'anchor-3', 'anchor-4', 'anchor-5'];
    for (const a of anchors) t.note('edit', { path: 'src/x.ts', oldText: a, newText: 'new' });
    expect(t.summary().spinEvents).toBe(0);
    // 不同 sig → sameCount 从未到阈值 → maxSameCount 保持 0 (没卡过就 0, 不算 1)。
    expect(t.summary().maxSameCount).toBe(0);
  });

  test('★ 8 次 edit 各不同 anchor → 仍不触发 (覆盖正当 TDD 多点迭代)', () => {
    const t = createDriftTracker({ threshold: 4 });
    for (let i = 0; i < 8; i++) t.note('edit', { path: 'src/x.ts', oldText: `anchor-${i}`, newText: 'new' });
    expect(t.summary().spinEvents).toBe(0);
    expect(t.fuseTripped()).toBeNull();
  });
});

describe('GWT · 同一文件 5 次 edit 同一 oldText → 触发 spinning', () => {
  test('5 次同 anchor → spinEvents = 1', () => {
    const t = createDriftTracker({ threshold: 4 });
    for (let i = 0; i < 5; i++) t.note('edit', { path: 'src/x.ts', oldText: 'same', newText: 'x' });
    expect(t.summary().spinEvents).toBe(1);
  });
});

describe('GWT · 连续 5 次 read 同一文件 → 触发 spinning (与今天逐字相同)', () => {
  test('read 同 path × 5 → spinEvents = 1', () => {
    const t = createDriftTracker({ threshold: 4 });
    for (let i = 0; i < 5; i++) t.note('read', { path: 'src/x.ts' });
    expect(t.summary().spinEvents).toBe(1);
  });
});

describe('GWT · edit 调用里没有 oldText → 退回纯路径签名 (INV-4 现场)', () => {
  test('edit 无 oldText × 5 → 仍触发 spinning (今天的纯路径行为)', () => {
    const t = createDriftTracker({ threshold: 4 });
    for (let i = 0; i < 5; i++) t.note('edit', { path: 'src/x.ts', newText: 'whatever' });
    expect(t.summary().spinEvents).toBe(1);
  });
});