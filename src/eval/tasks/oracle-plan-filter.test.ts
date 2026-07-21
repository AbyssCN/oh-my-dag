/**
 * oracle-plan-filter worktree fixture 测 —— GWT-0b: 建 worktree → 清空目标 → sibling 依赖在位 → 清理。
 * 集成测 (真建/摘 git worktree); 单例 fixture, afterAll 强清避免泄漏 worktree。
 */
import { afterAll, expect, test } from 'bun:test';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createOraclePlanFilterFixture } from './oracle-plan-filter';
import type { WorktreeFixture } from './worktree';

let fx: WorktreeFixture | undefined;

afterAll(async () => {
  if (fx) await fx.cleanup();
});

async function exists(p: string): Promise<boolean> {
  try { await stat(p); return true; } catch { return false; }
}

test('GWT-0b: worktree 建成, oracle = tsc + scoped test', async () => {
  fx = await createOraclePlanFilterFixture();
  expect(await exists(fx.root)).toBe(true);
  expect(fx.oracleCmd).toContain('tsc --noEmit');
  expect(fx.oracleCmd).toContain('bun test src/harness/oracle-plan-filter.test.ts');
});

test('目标模块被清空 (impl 移除, 换成 EVAL FIXTURE 桩头)', async () => {
  const target = await readFile(join(fx!.root, 'src/harness/oracle-plan-filter.ts'), 'utf8');
  expect(target).toContain('EVAL FIXTURE');
  // 实现确实没了 (fleet 要照 SPEC 重建)
  expect(target).not.toContain('export function filterOracleCommandNodes');
});

test('sibling 依赖 + 测试在 worktree 里在位 (裸 /tmp 拷法解决不了的正是这个)', async () => {
  // 测试 import 的 sibling —— 全量 checkout 保证可解析
  expect(await exists(join(fx!.root, 'src/harness/conductor-plan.ts'))).toBe(true);
  expect(await exists(join(fx!.root, 'src/harness/executor-dag.ts'))).toBe(true);
  // oracle 测试文件原样在位 (判分依据)
  const testFile = await readFile(join(fx!.root, 'src/harness/oracle-plan-filter.test.ts'), 'utf8');
  expect(testFile).toContain('filterOracleCommandNodes');
  // prose SPEC 写入 worktree
  const spec = await readFile(join(fx!.root, 'EVAL_SPEC.md'), 'utf8');
  expect(spec).toContain('filterOracleCommandNodes');
  expect(spec).toContain('Expected behavior');
});
