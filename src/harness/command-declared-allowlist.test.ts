/**
 * owner 显式声明的命令进白名单 (2026-10-02, plana 实账: evidence-pass 照 `.omd/config.json` 的
 * `render.command` = `npm run drive:web` 补挂渲染步, 被 `'npm' ∉ allowlist` 拒, 下游截图链全断)。
 * 证伪方式: 把 withDeclaredCommands 改成原样返回 → ★① 红。
 */
import { describe, expect, test } from 'bun:test';
import { commandBlockReason, DEFAULT_COMMAND_ALLOWLIST, withDeclaredCommands } from './command-leaf';

const RENDER = 'npm run drive:web && bun run scripts/omd-shots-verify.ts docs/design/_shots-web';

describe('withDeclaredCommands', () => {
  test('★① 声明的渲染命令: 改前被拒, 并入后放行', () => {
    expect(commandBlockReason(RENDER, DEFAULT_COMMAND_ALLOWLIST)).toContain("'npm' ∉ allowlist");
    expect(commandBlockReason(RENDER, withDeclaredCommands(DEFAULT_COMMAND_ALLOWLIST, [RENDER]))).toBeNull();
  });

  test('没有声明 → 白名单不变; 已在白名单的 bin 不重复', () => {
    expect(withDeclaredCommands(['bun'], [undefined])).toEqual(['bun']);
    expect(withDeclaredCommands(['bun'], ['bun run x | tee y'])).toEqual(['bun', 'tee']);
  });

  test('并入只放宽白名单这一道: 危险命令表照旧在前面拦', () => {
    const list = withDeclaredCommands(DEFAULT_COMMAND_ALLOWLIST, [RENDER, 'git reset --hard HEAD~3']);
    expect(commandBlockReason('git reset --hard HEAD~3', list)).not.toBeNull();
  });
});
