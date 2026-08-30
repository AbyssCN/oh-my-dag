/**
 * head-baseline.test —— 刀①-2 (2026-08-30 闸门三角结) head 档 run 基线的判据钉死。
 *
 * 反向自检 (手做过一次, 记录在此): 把 `changedSinceHeadBaseline` 的
 * `now.hash !== before.hash` 改成恒 `true` → 「跑前跑后一字未动」用例当场红
 * (no-change 被误判成 changed)。还原复绿。
 */
import { describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureHeadBaseline, changedSinceHeadBaseline, headBaselineUnsupported } from './head-baseline';

function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), 'omd-headbase-'));
}

describe('captureHeadBaseline + changedSinceHeadBaseline', () => {
  test('跑前跑后一字未动 → no-change (不是 changed)', () => {
    const root = makeRoot();
    try {
      writeFileSync(join(root, 'a.ts'), 'const a = 1;\n');
      const base = captureHeadBaseline(root, ['a.ts']);
      const ev = changedSinceHeadBaseline({ root, writeSet: ['a.ts'], baseline: base });
      expect(ev.changed).toEqual([]);
      expect(ev.reason).toBe('no-change');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('内容变了 (哪怕一字节) → changed — 零容差', () => {
    const root = makeRoot();
    try {
      writeFileSync(join(root, 'a.ts'), 'const a = 1;\n');
      const base = captureHeadBaseline(root, ['a.ts']);
      writeFileSync(join(root, 'a.ts'), 'const a = 1; \n'); // 一个空格的漂移
      const ev = changedSinceHeadBaseline({ root, writeSet: ['a.ts'], baseline: base });
      expect(ev.changed).toEqual(['a.ts']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('mode 位变了 (内容没变) → changed — 哈希的盲区由 mode 位抓', () => {
    const root = makeRoot();
    try {
      const p = join(root, 'run.sh');
      writeFileSync(p, '#!/bin/sh\n');
      chmodSync(p, 0o644);
      const base = captureHeadBaseline(root, ['run.sh']);
      chmodSync(p, 0o755); // chmod +x, 内容逐字相同
      const ev = changedSinceHeadBaseline({ root, writeSet: ['run.sh'], baseline: base });
      expect(ev.changed).toEqual(['run.sh']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('symlink 换目标 (真身内容相同) → changed — 哈希跟随读真身抓不到, realpath 抓', () => {
    const root = makeRoot();
    try {
      writeFileSync(join(root, 't1.txt'), 'same\n');
      writeFileSync(join(root, 't2.txt'), 'same\n'); // 内容逐字相同的另一个真身
      symlinkSync(join(root, 't1.txt'), join(root, 'ln.txt'));
      const base = captureHeadBaseline(root, ['ln.txt']);
      rmSync(join(root, 'ln.txt'));
      symlinkSync(join(root, 't2.txt'), join(root, 'ln.txt'));
      const ev = changedSinceHeadBaseline({ root, writeSet: ['ln.txt'], baseline: base });
      expect(ev.changed).toEqual(['ln.txt']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('跑前不存在、跑后新建 → changed (hash null → 非 null 也是变化)', () => {
    const root = makeRoot();
    try {
      const base = captureHeadBaseline(root, ['new.ts']);
      expect(base.entries['new.ts']).toEqual({ hash: null, mode: null, link: null });
      writeFileSync(join(root, 'new.ts'), 'export {};\n');
      const ev = changedSinceHeadBaseline({ root, writeSet: ['new.ts'], baseline: base });
      expect(ev.changed).toEqual(['new.ts']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('写集路径不在基线里 (重画新增) → 判不了那条, reason 点名 (fail-closed 留证)', () => {
    const root = makeRoot();
    try {
      const base = captureHeadBaseline(root, ['a.ts']);
      writeFileSync(join(root, 'later.ts'), 'export {};\n');
      const ev = changedSinceHeadBaseline({ root, writeSet: ['later.ts'], baseline: base });
      expect(ev.changed).toEqual([]); // 证不出跑前长什么样 → 不许说「变了」
      expect(ev.reason).toContain('未入基线判不了');
      expect(ev.reason).toContain('later.ts');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('写集空 → no-write-set (没合同就没判据, 与隔离档 INV-2 同格)', () => {
    const root = makeRoot();
    try {
      const base = captureHeadBaseline(root, []);
      expect(changedSinceHeadBaseline({ root, writeSet: [], baseline: base }).reason).toBe('no-write-set');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('headBaselineUnsupported — submodule/LFS/sparse-checkout 显式不支持', () => {
  test('干净树 → null (支持)', () => {
    const root = makeRoot();
    try {
      expect(headBaselineUnsupported(root)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('.gitmodules → 不支持并点名', () => {
    const root = makeRoot();
    try {
      writeFileSync(join(root, '.gitmodules'), '[submodule "x"]\n');
      expect(headBaselineUnsupported(root)).toContain('submodule');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('.gitattributes 声明 filter=lfs → 不支持并点名', () => {
    const root = makeRoot();
    try {
      writeFileSync(join(root, '.gitattributes'), '*.bin filter=lfs diff=lfs merge=lfs -text\n');
      expect(headBaselineUnsupported(root)).toContain('git-lfs');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('.git/info/sparse-checkout → 不支持并点名', () => {
    const root = makeRoot();
    try {
      mkdirSync(join(root, '.git/info'), { recursive: true });
      writeFileSync(join(root, '.git/info/sparse-checkout'), 'src/\n');
      expect(headBaselineUnsupported(root)).toContain('sparse-checkout');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
