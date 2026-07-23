/**
 * sandbox-guard 测试 —— 锁 containment 不变量: 结构化写只能落 sandboxRoot 子树内。
 *
 * 溯源 2026-07-23: eval leaf 用绝对路径调 write 写穿 worktree、污染主树真源码 (pi write 对绝对路径原样放行)。
 * 本 hook 是事前闸; 这些用例钉死"什么 block / 什么放行", 防回归把安全闸改松。
 */
import { describe, test, expect } from 'bun:test';
import { createSandboxGuardHook } from './sandbox-guard';

const ROOT = '/home/nick/repos/xihe/.omd/eval-worktrees/large-XXX';

/** 把 hook 挂到一个假 pi, 返回 (toolName, input) → reason|null 的调用器。 */
function mountGuard(root: string): (toolName: string, input: unknown) => string | null {
  let handler: ((e: { toolName: string; input: unknown }) => { block?: boolean; reason?: string } | undefined) | null =
    null;
  const pi = { on: (_ev: string, h: typeof handler) => { handler = h; } };
  createSandboxGuardHook({ root })(pi as never);
  return (toolName, input) => {
    const r = handler?.({ toolName, input });
    return r?.block ? (r.reason ?? 'blocked') : null;
  };
}

describe('sandbox-guard', () => {
  const call = mountGuard(ROOT);

  test('write 相对路径 (worktree 内) → 放行', () => {
    expect(call('write', { path: 'src/harness/pathfinder/types.ts' })).toBeNull();
  });

  test('write 绝对主树路径 → BLOCK (就是那次泄漏)', () => {
    expect(call('write', { path: '/home/nick/repos/xihe/src/harness/pathfinder/types.ts' })).toContain('sandbox');
  });

  test('write 绝对 worktree 内路径 → 放行', () => {
    expect(call('write', { path: `${ROOT}/src/foo.ts` })).toBeNull();
  });

  test('edit ../ 逃逸 → BLOCK', () => {
    expect(call('edit', { file_path: '../../../src/model/index.ts' })).toContain('sandbox');
  });

  test('hashline_edit patch 头指向主树绝对路径 → BLOCK', () => {
    expect(call('hashline_edit', { patch: '¶/home/nick/repos/xihe/src/model/x.ts#a1b2\nreplace 1: foo' })).toContain(
      'sandbox',
    );
  });

  test('hashline_edit patch 头相对内 → 放行', () => {
    expect(call('hashline_edit', { patch: '¶src/harness/arch/hotspots.ts#a1b2\nreplace 1: foo' })).toBeNull();
  });

  test('hashline_edit 多 section, 一个越界即 BLOCK', () => {
    const patch = '¶src/ok.ts#a1b2\nreplace 1: x\n¶/etc/evil.ts#c3d4\nreplace 1: y';
    expect(call('hashline_edit', { patch })).toContain('sandbox');
  });

  test('read (非写工具) 绝对路径 → 放行 (只守写, 不守读)', () => {
    expect(call('read', { path: '/etc/passwd' })).toBeNull();
  });

  test('bash → 放行 (不在 tool_call 层守, 由 F1 事后闸兜底)', () => {
    expect(call('bash', { command: 'cat > /home/nick/repos/xihe/src/x.ts' })).toBeNull();
  });

  test('write 缺 path → 放行 (畸形输入不误杀, 交下游校)', () => {
    expect(call('write', {})).toBeNull();
  });
});
