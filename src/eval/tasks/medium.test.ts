/**
 * medium fixture 测 —— O1: worktree 建成 → 3 目标全清空 → sibling 依赖 + 3 测试在位 → 清理。
 * 集成测 (真建/摘 git worktree); 单例 fixture, afterAll 强清。
 */
import { afterAll, expect, test } from 'bun:test';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createMediumFixture } from './medium';
import type { WorktreeFixture } from './worktree';

let fx: WorktreeFixture | undefined;
afterAll(async () => {
  if (fx) await fx.cleanup();
});

async function exists(p: string): Promise<boolean> {
  try { await stat(p); return true; } catch { return false; }
}

const TARGETS = ['src/harness/dag-mermaid.ts', 'src/harness/slim/debt-scan.ts', 'src/harness/arch/hotspots.ts'];
const TESTS = ['src/harness/dag-mermaid.test.ts', 'src/harness/slim/debt-scan.test.ts', 'src/harness/arch/hotspots.test.ts'];

test('O1: medium worktree 建成, oracle 含 3 个测试', async () => {
  fx = await createMediumFixture();
  expect(await exists(fx.root)).toBe(true);
  for (const t of TESTS) expect(fx.oracleCmd).toContain(t);
});

test('3 个目标模块全被清空 (impl 移除, 换 EVAL FIXTURE 桩头)', async () => {
  for (const t of TARGETS) {
    const content = await readFile(join(fx!.root, t), 'utf8');
    expect(content).toContain('EVAL FIXTURE');
  }
  // 具体实现符号确实没了 (fleet 要照 SPEC 重建)
  const mermaid = await readFile(join(fx!.root, 'src/harness/dag-mermaid.ts'), 'utf8');
  expect(mermaid).not.toContain('export function planToMermaid');
});

test('3 个测试文件 + sibling 依赖在 worktree 里在位 (whole checkout 保证可解析)', async () => {
  for (const t of TESTS) expect(await exists(join(fx!.root, t))).toBe(true);
  // dag-mermaid 测试 import 的 sibling type
  expect(await exists(join(fx!.root, 'src/harness/conductor-plan.ts'))).toBe(true);
  // frontier 那类 sibling 也在 (证明是全量 checkout 而非选择性拷)
  expect(await exists(join(fx!.root, 'src/harness/pathfinder/frontier.ts'))).toBe(true);
  // SPEC 写入
  const spec = await readFile(join(fx!.root, 'EVAL_SPEC.md'), 'utf8');
  expect(spec).toContain('planToMermaid');
  expect(spec).toContain('parseDebtLine');
  expect(spec).toContain('computeHotspots');
});
