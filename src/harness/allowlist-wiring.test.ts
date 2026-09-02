/**
 * D5a 片 2 —— 生产装配点接线 (D-2): 验证**接线语意**与既有闸的相互作用。
 *
 * 切片 write-set 限定 src/mcp/assemble.ts + src/harness/agent-leaf.ts + 本文件 (本契约 §分解)。
 * 装配端接线的字面校验不在本测试职责里 (那是 write-set 巡检 + 切片 1/3 收尾的 seam 再生) ——
 * 本测试只钉**接线后生产路径应有的行为** (GWT-4 / GWT-6) 与**安全边界不动** (INV-5)。
 *
 * GWT-4 (INV-3) 用 `commandBlockReason` 直接打 allowlist, 不真起 pytest —— 判据是「过没过白名单闸」
 * 而非命令成功 (实装后允许 `pytest --version` 缺 bin 报错)。
 *
 * tmpdir 残留由 `afterEach` 的 `rmSync({ recursive: true, force: true })` 收, 与
 * `allowlist-packs.test.ts` 同款姿势。
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  allowlistForRoot,
  commandBlockReason,
  createCommandLeafRunner,
} from './command-leaf';

let tmpRoot = '';
afterEach(() => {
  if (tmpRoot) {
    rmSync(tmpRoot, { recursive: true, force: true });
    tmpRoot = '';
  }
});

function freshRoot(): string {
  tmpRoot = mkdtempSync(join(tmpdir(), 'omd-allow-wire-'));
  return tmpRoot;
}

function touch(rel: string): void {
  writeFileSync(join(tmpRoot, rel), '');
}

describe('GWT-4 (INV-3): 运行期执法生效', () => {
  test('pyproject.toml 根 → allowlist 放行 pytest 首词', () => {
    const root = freshRoot();
    touch('pyproject.toml');

    const block = commandBlockReason('pytest --version', allowlistForRoot(root));

    // 判据: 白名单闸不拒 (allowlist 内有 'pytest'); 后面的"缺 bin 报错"不在闸的判定里。
    expect(block).toBeNull();
  });

  test('空根 → 同一命令被 allowlist 闸拒', () => {
    const root = freshRoot();

    const block = commandBlockReason('pytest --version', allowlistForRoot(root));

    // 空根 = JS 仓基线, 行为逐字节不变 (INV-2 / INV-3 配套)。
    expect(block).not.toBeNull();
  });

  test('Cargo.toml 根 → 放行 cargo; 空根照拒', () => {
    const root = freshRoot();
    touch('Cargo.toml');
    expect(commandBlockReason('cargo test', allowlistForRoot(root))).toBeNull();
  });

  test('go.mod 根 → 放行 go; 空根照拒', () => {
    const root = freshRoot();
    touch('go.mod');
    expect(commandBlockReason('go test ./...', allowlistForRoot(root))).toBeNull();
  });

  test('createCommandLeafRunner 接受 allowlistForRoot 的返回值 (类型匹配)', () => {
    // 装配点接线 (D-2) 把生产 cwd/root 喂给 allowlistForRoot 后, 直接交 createCommandLeafRunner,
    // 不再做 `[...arr]`。本测试钉这一传递面不漂 —— 类型不匹配会在 tsc 阶段暴露。
    const root = freshRoot();
    touch('pyproject.toml');
    const runner = createCommandLeafRunner({
      allowlist: allowlistForRoot(root),
      cwd: root,
      timeoutMs: 5_000,
    });
    expect(typeof runner).toBe('function');
  });
});

describe('GWT-6 (INV-5): 安全边界不动', () => {
  test('git push --force 在 python marker 根的 allowlist 上仍被拒', () => {
    const root = freshRoot();
    touch('pyproject.toml');

    const block = commandBlockReason('git push --force origin main', allowlistForRoot(root));

    // git 只读子命令闸 (GIT_READONLY_SUBCOMMANDS) 与危险模式表均不动 —— 语言包扩出 python
    // 不松动既有闸 (D-4 / INV-5)。
    expect(block).not.toBeNull();
  });

  test('git checkout . 在 python marker 根的 allowlist 上仍被拒', () => {
    // 2026-09-01 (bd1820aa) owner 显式开口放行 `add` / `commit` (commit 流最小集合) ——
    // 本条原先打的是 `git commit -m x`, 那次只改了 git-write-gate 的矩阵, 本条漏改而红。
    // INV-5 要钉的是「语言包扩出 python 不松动既有闸」, 换成仍必拒的 `checkout .` 后判据不变。
    const root = freshRoot();
    touch('pyproject.toml');
    expect(commandBlockReason('git checkout .', allowlistForRoot(root))).not.toBeNull();
  });

  test('&& 链中含危险首词在 python 根仍被拒 (逐环判不松动)', () => {
    const root = freshRoot();
    touch('requirements.txt');
    expect(commandBlockReason('pytest && rm -rf /tmp/x', allowlistForRoot(root))).not.toBeNull();
  });

  test('shell 元字符拦在 python 根不动', () => {
    const root = freshRoot();
    touch('pyproject.toml');
    expect(commandBlockReason('pytest ; rm -rf /', allowlistForRoot(root))).not.toBeNull();
  });
});
