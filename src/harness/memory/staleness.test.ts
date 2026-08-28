/**
 * 陈旧闸(L2)。**一条永远绿的闸不是闸** —— 所以每一格都配一条能让它红的操作。
 *
 * 反向自检(实跑过):
 *  - 把 `checkStaleness` 的 `actual === a.sha` 改成恒真 ⇒ 「改一个字节 → stale」当场红;
 *  - 把 `unanchored` 折成 `anchored-fresh` ⇒ 「没锚 ≠ 没变」当场红;
 *  - 把 `missing` 折成 `stale` ⇒ 「读不到 ≠ 变了」当场红;
 *  - 把 `STALE_RANK_FACTOR` 调回 1 ⇒ 「陈旧的会被压到后面」当场红。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  annotateStaleness,
  checkStaleness,
  fileFingerprint,
  fingerprintFile,
  stalenessLabel,
  STALE_RANK_FACTOR,
} from './staleness';
import type { MemoryHit } from './types';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'omd-staleness-'));
  mkdirSync(join(root, 'src'), { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function writeFile(rel: string, body: string): string {
  const abs = join(root, rel);
  writeFileSync(abs, body);
  return fileFingerprint(abs)!;
}

/** 只带 evidence 的最小 fact 形状(闸不认识 namespace,只认识那一列)。 */
const factWith = (evidence: { path: string; sha: string }[]) => ({ namespace: 'omd.pattern', evidence });

describe('陈旧闸 — 四态互不折叠', () => {
  test('没有 evidence → unanchored(**不是** anchored-fresh)', () => {
    const r = checkStaleness({ namespace: 'omd.pattern' }, root);
    expect(r.staleness).toBe('unanchored');
    expect(r.checks).toEqual([]);
    // 这一条是本闸最容易被"简化"掉的:库里 81/81 条 pattern 都没锚,
    // 折进 fresh 会让整个闸看起来 100% 绿而实际上一条都没验。
    expect(r.staleness).not.toBe('anchored-fresh');
  });

  test('空 evidence 数组也算 unanchored(schema 拦得住,旁路写入拦不住)', () => {
    expect(checkStaleness(factWith([]), root).staleness).toBe('unanchored');
  });

  test('文件没动 → anchored-fresh', () => {
    const sha = writeFile('src/a.ts', 'export const a = 1;\n');
    const r = checkStaleness(factWith([{ path: 'src/a.ts', sha }]), root);
    expect(r.staleness).toBe('anchored-fresh');
    expect(r.checks[0]!.verdict).toBe('fresh');
    expect(r.checks[0]!.actual).toBe(sha);
  });

  test('★ 改一个字节 → anchored-stale(闸真的在量内容)', () => {
    const sha = writeFile('src/a.ts', 'export const a = 1;\n');
    writeFileSync(join(root, 'src/a.ts'), 'export const a = 2;\n'); // 一个字符
    const r = checkStaleness(factWith([{ path: 'src/a.ts', sha }]), root);
    expect(r.staleness).toBe('anchored-stale');
    expect(r.checks[0]!.actual).not.toBe(sha);
  });

  test('★ 文件读不到 → anchored-missing(**不是** stale)', () => {
    const r = checkStaleness(factWith([{ path: 'src/gone.ts', sha: '0'.repeat(16) }]), root);
    expect(r.staleness).toBe('anchored-missing');
    expect(r.checks[0]!.verdict).toBe('missing');
    expect(r.checks[0]!.actual).toBeNull(); // null ≠ 空串 ≠ 对不上
    // 换 worktree / 换 checkout 会让整库 missing。折进 stale = 换一次目录全库告警。
    expect(r.staleness).not.toBe('anchored-stale');
  });

  test('绝对路径当 missing 处理,不拿它去读别人机器上的盘', () => {
    const abs = join(root, 'src', 'a.ts');
    writeFile('src/a.ts', 'x');
    const r = checkStaleness(factWith([{ path: abs, sha: '0'.repeat(16) }]), root);
    expect(r.staleness).toBe('anchored-missing');
    expect(r.checks[0]!.actual).toBeNull();
  });

  test('混合时 stale 压过 missing,missing 压过 fresh', () => {
    const shaA = writeFile('src/a.ts', 'a');
    const shaB = writeFile('src/b.ts', 'b');
    writeFileSync(join(root, 'src/b.ts'), 'B'); // b 变了

    expect(
      checkStaleness(
        factWith([
          { path: 'src/a.ts', sha: shaA },
          { path: 'src/b.ts', sha: shaB },
          { path: 'src/gone.ts', sha: '0'.repeat(16) },
        ]),
        root,
      ).staleness,
    ).toBe('anchored-stale');

    expect(
      checkStaleness(
        factWith([
          { path: 'src/a.ts', sha: shaA },
          { path: 'src/gone.ts', sha: '0'.repeat(16) },
        ]),
        root,
      ).staleness,
    ).toBe('anchored-missing');
  });
});

describe('陈旧闸 — 读侧降权', () => {
  const hit = (id: string, rrf: number, fact: unknown): MemoryHit =>
    ({ id, rrf, text: id, fact } as unknown as MemoryHit);

  test('★ 陈旧的被压到后面,但**仍在结果里**(降权不是删除)', () => {
    const sha = writeFile('src/a.ts', 'v1');
    writeFileSync(join(root, 'src/a.ts'), 'v2');

    const out = annotateStaleness(
      [
        hit('stale-but-top', 0.03, factWith([{ path: 'src/a.ts', sha }])),
        hit('fresh-but-lower', 0.02, { namespace: 'omd.pattern' }),
      ],
      root,
    );
    expect(out.length).toBe(2); // 没被删
    expect(out[0]!.id).toBe('fresh-but-lower'); // 换位了
    expect(out[1]!.staleness).toBe('anchored-stale');
    expect(out[1]!.rankScore).toBeCloseTo(0.03 * STALE_RANK_FACTOR, 10);
  });

  test('rrf 原值不许被降权覆盖(检索器读数 vs 读侧策略要分得开)', () => {
    const sha = writeFile('src/a.ts', 'v1');
    writeFileSync(join(root, 'src/a.ts'), 'v2');
    const out = annotateStaleness([hit('h', 0.03, factWith([{ path: 'src/a.ts', sha }]))], root);
    expect(out[0]!.rrf).toBe(0.03);
    expect(out[0]!.rankScore).toBeLessThan(out[0]!.rrf);
  });

  test('unanchored / missing / fresh 都不动分 —— 只罚真变了的那一种', () => {
    const sha = writeFile('src/a.ts', 'v1');
    const out = annotateStaleness(
      [
        hit('un', 0.03, { namespace: 'omd.pattern' }),
        hit('fresh', 0.02, factWith([{ path: 'src/a.ts', sha }])),
        hit('miss', 0.01, factWith([{ path: 'src/gone.ts', sha: '0'.repeat(16) }])),
      ],
      root,
    );
    for (const h of out) expect(h.rankScore).toBe(h.rrf);
    expect(out.map((h) => h.staleness)).toEqual(['unanchored', 'anchored-fresh', 'anchored-missing']);
  });

  test('unanchored 不加标签 —— 多数派不该被噪声淹掉', () => {
    expect(stalenessLabel('unanchored')).toBe('');
    expect(stalenessLabel('anchored-stale')).toContain('⚠');
    expect(stalenessLabel('anchored-missing')).toContain('?');
    expect(stalenessLabel('anchored-fresh')).toContain('✓');
  });
});

describe('指纹口径', () => {
  test('sha256 前 16 hex(与 hashArtifact 同口径 —— 改这里要同时改那边)', () => {
    const sha = writeFile('src/a.ts', 'hello');
    expect(sha).toMatch(/^[0-9a-f]{16}$/);
    // sha256('hello') = 2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824
    expect(sha).toBe('2cf24dba5fb0a30e');
  });

  test('读不到 → null(不是空串,不是抛)', () => {
    expect(fileFingerprint(join(root, 'nope.ts'))).toBeNull();
    expect(fileFingerprint(root)).toBeNull(); // 目录也读不成
  });

  test('★ 读不到时**理由跟着返回值走** —— 文件没了 vs 是目录, 两种别塌成一个裸 null', () => {
    const gone = fingerprintFile(join(root, 'nope.ts'));
    const isDir = fingerprintFile(root);
    expect(gone.sha).toBeNull();
    expect(isDir.sha).toBeNull();
    expect(gone.why).toBeTruthy();
    expect(isDir.why).toBeTruthy();
    expect(gone.why).not.toBe(isDir.why); // 两种读不到, 两种理由
    // 读到了就没有理由 —— 别让这一列变成永远有值的装饰。
    writeFile('src/ok.ts', 'x');
    expect(fingerprintFile(join(root, 'src/ok.ts')).why).toBeNull();
  });

  test('checkStaleness 把理由带到 missing 明细里(memory_fact 打印它)', () => {
    const r = checkStaleness(factWith([{ path: 'src/gone.ts', sha: '0'.repeat(16) }]), root);
    expect(r.checks[0]!.verdict).toBe('missing');
    expect(r.checks[0]!.why).toBeTruthy();
  });
});
