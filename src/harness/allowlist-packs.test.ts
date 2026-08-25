/**
 * D5a 片 1 —— 语言包探测 (INV-1 / INV-2)。
 *
 * 三条契约 GWT 对应测试名 (anchor = allowlistForRoot 与 LANGUAGE_PACKS 在实装前必须 0 命中):
 *   · GWT-1: 单 python marker → 含 pytest 且含 base 全部成员
 *   · GWT-2: python + go 双 marker → 含 pytest 与 go, 无重复
 *   · GWT-3: 无 marker → 集合与 base 相等 (JS 仓零变化)
 *
 * 探测是 `existsSync`, 测试用 mkdtemp + writeFileSync 真实落 marker 文件, 不打桩
 * (与契约 §判据自证同款姿势 —— 「mkdtemp 临时世界里跑一遍, 命令在错样本上没失败 = 判据是虚的」)。
 * tmpdir 残留由 `afterEach` 的 `rmSync({ recursive: true, force: true })` 收。
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_COMMAND_ALLOWLIST,
  LANGUAGE_PACKS,
  allowlistForRoot,
  type LanguagePack,
} from './command-leaf';

let tmpRoot = '';
afterEach(() => {
  if (tmpRoot) {
    rmSync(tmpRoot, { recursive: true, force: true });
    tmpRoot = '';
  }
});

function freshRoot(): string {
  tmpRoot = mkdtempSync(join(tmpdir(), 'omd-allow-packs-'));
  return tmpRoot;
}

function touch(rel: string): void {
  writeFileSync(join(tmpRoot, rel), '');
}

describe('allowlistForRoot × 语言包探测 (D5a)', () => {
  test('GWT-1: 单 python marker 启用包 → 含 pytest 且含 base 全部成员', () => {
    const root = freshRoot();
    touch('pyproject.toml');

    const out = allowlistForRoot(root);

    expect(out).toContain('pytest');
    for (const bin of DEFAULT_COMMAND_ALLOWLIST) expect(out).toContain(bin);
  });

  test('GWT-2: python + go 双 marker → 并集, 无重复', () => {
    const root = freshRoot();
    touch('pyproject.toml');
    touch('go.mod');

    const out = allowlistForRoot(root);

    expect(out).toContain('pytest');
    expect(out).toContain('go');
    expect(new Set(out).size).toBe(out.length);
  });

  test('GWT-3: 无 marker → 集合与 base 相等 (JS 仓零变化)', () => {
    const root = freshRoot();

    const out = allowlistForRoot(root);

    expect(new Set(out)).toEqual(new Set(DEFAULT_COMMAND_ALLOWLIST));
  });

  test('rust 包 (Cargo.toml) → 加 cargo, base 不变', () => {
    const root = freshRoot();
    touch('Cargo.toml');

    const out = allowlistForRoot(root);

    expect(out).toContain('cargo');
    for (const bin of DEFAULT_COMMAND_ALLOWLIST) expect(out).toContain(bin);
  });

  test('同语言多 marker (pyproject.toml + uv.lock) → bins 不重复', () => {
    const root = freshRoot();
    touch('pyproject.toml');
    touch('uv.lock');

    const out = allowlistForRoot(root);

    expect(out.filter((b) => b === 'pytest')).toHaveLength(1);
    expect(new Set(out).size).toBe(out.length);
  });

  test('每次调用返回新数组, 改返回值不污染下次调用 (与 command leaf 无 memo 同源)', () => {
    const root = freshRoot();
    const a = allowlistForRoot(root);
    a.push('FORGED_BIN');
    const b = allowlistForRoot(root);
    expect(b).not.toContain('FORGED_BIN');
  });
});

describe('LANGUAGE_PACKS 表', () => {
  test('每包至少一个 bin, marker 名字非空', () => {
    for (const pack of LANGUAGE_PACKS as readonly LanguagePack[]) {
      expect(pack.marker.length).toBeGreaterThan(0);
      expect(pack.bins.length).toBeGreaterThan(0);
    }
  });
});
