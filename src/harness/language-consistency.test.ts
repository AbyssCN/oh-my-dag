/**
 * C-1 (片 1) —— 包表 js 行 + 语言一致判定 (D-2, D-1)。
 *
 * 四条 INV (GWT 字面照搬契约 §C-1, anchor = languageConsistencyBlockReason 与 LANGUAGE_PACKS
 * 在实装前必须 0 命中: 测试文件引用尚不存在的导出, bun test 会因模块导入失败而 RED):
 *   · INV-1 运行期白名单集合零变化: 任意 marker 组合下 allowlistForRoot 集合与改前相同
 *   · INV-2 Python 仓拒 JS 判据: pyproject.toml 仓 + bun test → 拒因含 package.json 字面
 *   · INV-3 JS 仓拒 Python 判据: package.json 仓 + pytest → 拒因含 pyproject.toml 字面
 *   · INV-4 base 非包词不受影响: grep / git 等 base-only 词永远 null
 *
 * tmpdir 残留由 afterEach 的 rmSync 收, 与 allowlist-packs.test.ts 同款姿势。
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_COMMAND_ALLOWLIST,
  LANGUAGE_PACKS,
  allowlistForRoot,
  languageConsistencyBlockReason,
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
  tmpRoot = mkdtempSync(join(tmpdir(), 'omd-lang-consist-'));
  return tmpRoot;
}

function touch(rel: string): void {
  writeFileSync(join(tmpRoot, rel), '');
}

describe('INV-1: 运行期白名单集合零变化', () => {
  test('无 marker → 集合与 base 相等 (JS 仓零变化)', () => {
    const root = freshRoot();
    const out = allowlistForRoot(root);
    expect(new Set(out)).toEqual(new Set(DEFAULT_COMMAND_ALLOWLIST));
  });

  test('package.json 仓 → 集合仍与 base 相等 (js bins 全部已在 base, dedupe)', () => {
    const root = freshRoot();
    touch('package.json');
    const out = allowlistForRoot(root);
    expect(new Set(out)).toEqual(new Set(DEFAULT_COMMAND_ALLOWLIST));
  });

  test('pyproject.toml + package.json → 与「pyproject.toml only」逐根相等 (js 不引入新 bin)', () => {
    const aRoot = freshRoot();
    touch('pyproject.toml');
    const aOut = allowlistForRoot(aRoot);

    const bRoot = freshRoot();
    touch('pyproject.toml');
    touch('package.json');
    const bOut = allowlistForRoot(bRoot);

    expect(new Set(bOut)).toEqual(new Set(aOut));
  });
});

describe('INV-2: Python 仓拒 JS 判据', () => {
  test('pyproject.toml 仓 + bun test x.test.ts → 拒因非 null 且含 package.json 字面', () => {
    const root = freshRoot();
    touch('pyproject.toml');

    const block = languageConsistencyBlockReason('bun test x.test.ts', root);

    expect(block).not.toBeNull();
    expect(block!).toContain('package.json');
  });

  test('pyproject.toml 仓 + pytest -q → null', () => {
    const root = freshRoot();
    touch('pyproject.toml');
    expect(languageConsistencyBlockReason('pytest -q', root)).toBeNull();
  });

  test('requirements.txt 仓 + tsc --noEmit → 拒因含 js 标记 (tsconfig.json)', () => {
    const root = freshRoot();
    touch('requirements.txt');

    const block = languageConsistencyBlockReason('tsc --noEmit', root);

    expect(block).not.toBeNull();
    expect(block!).toMatch(/tsconfig\.json|package\.json|bun\.lock/);
  });
});

describe('INV-3: JS 仓拒 Python 判据', () => {
  test('package.json 仓 + pytest -q → 拒因非 null 且含 pyproject.toml 字面', () => {
    const root = freshRoot();
    touch('package.json');

    const block = languageConsistencyBlockReason('pytest -q', root);

    expect(block).not.toBeNull();
    expect(block!).toContain('pyproject.toml');
  });

  test('package.json 仓 + bun test x.test.ts → null', () => {
    const root = freshRoot();
    touch('package.json');
    expect(languageConsistencyBlockReason('bun test x.test.ts', root)).toBeNull();
  });

  test('tsconfig.json 仓 + uv run pytest → null (uv 在 python 包里, marker uv.lock 也允许同包判定)', () => {
    const root = freshRoot();
    touch('tsconfig.toml'.replace('.toml', '.json')); // 写 tsconfig.json
    // 实际上 tsconfig.json 已经存在, 再加 pyproject.toml 让 pytest 有包
    touch('pyproject.toml');
    expect(languageConsistencyBlockReason('pytest -q', root)).toBeNull();
  });
});

describe('INV-4: base 非包词不受影响', () => {
  test('任意 marker (含全无) → grep -q x f 返回 null', () => {
    const root = freshRoot();
    expect(languageConsistencyBlockReason('grep -q x f', root)).toBeNull();
  });

  test('任意 marker (含全无) → git status 返回 null', () => {
    const root = freshRoot();
    expect(languageConsistencyBlockReason('git status', root)).toBeNull();
  });

  test('pyproject.toml 仓 → ls / cat / jq / echo 全部 null', () => {
    const root = freshRoot();
    touch('pyproject.toml');
    expect(languageConsistencyBlockReason('ls -la', root)).toBeNull();
    expect(languageConsistencyBlockReason('cat foo.txt', root)).toBeNull();
    expect(languageConsistencyBlockReason('jq . foo.json', root)).toBeNull();
    expect(languageConsistencyBlockReason('echo hi', root)).toBeNull();
  });

  test('package.json 仓 → git diff HEAD / rg pattern / codegraph query 全部 null', () => {
    const root = freshRoot();
    touch('package.json');
    expect(languageConsistencyBlockReason('git diff HEAD', root)).toBeNull();
    expect(languageConsistencyBlockReason('rg pattern src/', root)).toBeNull();
    expect(languageConsistencyBlockReason('codegraph query Foo', root)).toBeNull();
  });
});

describe('LANGUAGE_PACKS 表新增 js 行 (D-1)', () => {
  test('js 三个 marker (package.json / tsconfig.json / bun.lock) 都登记, bins 含全部 base-js 词', () => {
    const jsMarkers = ['package.json', 'tsconfig.json', 'bun.lock'];
    for (const marker of jsMarkers) {
      const pack = LANGUAGE_PACKS.find((p: LanguagePack) => p.marker === marker);
      expect(pack).toBeDefined();
      expect(pack!.bins).toContain('bun');
      expect(pack!.bins).toContain('bunx');
      expect(pack!.bins).toContain('tsc');
      expect(pack!.bins).toContain('npx');
      expect(pack!.bins).toContain('node');
    }
  });

  test('加包后仍满足: 每包至少一个 bin, marker 名字非空', () => {
    for (const pack of LANGUAGE_PACKS as readonly LanguagePack[]) {
      expect(pack.marker.length).toBeGreaterThan(0);
      expect(pack.bins.length).toBeGreaterThan(0);
    }
  });
});