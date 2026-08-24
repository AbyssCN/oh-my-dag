/**
 * review-ledger 不变量测试 (INV-5 / G-5 前半):
 *   指纹去重计数 · 64 上限溢出 (丢最老 + 证据行存在) · 空/不存在 ledgerPath → 空数组。
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendFindings, fingerprintOf, LEDGER_CAP, loadLedger, type ReviewFinding } from './review-ledger';

/** 造一条 finding, 指纹按冻结规则现算 (where + 归一化 evidence 类别)。 */
function finding(where: string, evidence: string): ReviewFinding {
  return {
    where,
    severity: 'p2',
    evidence,
    suggestion: 'suggestion',
    uncertainty: 'uncertainty',
    fingerprint: fingerprintOf(where, evidence),
  };
}

function tmpLedger(): string {
  return join(mkdtempSync(join(tmpdir(), 'review-ledger-')), 'ledger.json');
}

describe('fingerprintOf (指纹 = sha256(where + 归一化 evidence 类别))', () => {
  test('同一 where + 排版不同的 evidence → 同指纹; where 不同 → 不同指纹', () => {
    expect(fingerprintOf('src/a.ts', '证据  A')).toBe(fingerprintOf('src/a.ts', '证据A'));
    expect(fingerprintOf('src/a.ts', '证据A!')).toBe(fingerprintOf('src/a.ts', '证据A'));
    expect(fingerprintOf('src/a.ts', '证据A')).not.toBe(fingerprintOf('src/b.ts', '证据A'));
  });
  test('完整 sha256 hex (64 位)', () => {
    expect(fingerprintOf('src/a.ts', '证据A')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('指纹去重 (G-5 前半)', () => {
  test('同指纹再来 → deduped+1, 不重报', () => {
    const p = tmpLedger();
    const f = finding('w', 'e');
    expect(appendFindings(p, [f])).toEqual({ added: 1, deduped: 0 });
    expect(appendFindings(p, [f])).toEqual({ added: 0, deduped: 1 });
    expect(loadLedger(p)).toHaveLength(1);
  });
  test('同一批内重复指纹也去重', () => {
    const p = tmpLedger();
    const f = finding('w', 'e');
    expect(appendFindings(p, [f, { ...f, suggestion: '另一个建议' }])).toEqual({ added: 1, deduped: 1 });
    expect(loadLedger(p)).toHaveLength(1);
  });
  test('不同指纹都落账', () => {
    const p = tmpLedger();
    expect(appendFindings(p, [finding('w1', 'e1'), finding('w2', 'e2')])).toEqual({ added: 2, deduped: 0 });
    expect(loadLedger(p)).toHaveLength(2);
  });
});

describe('INV-5 上限 64 (有界台账, 溢出丢最老 + 必留证据行)', () => {
  test('恰好 64 条不溢出, 无证据行', () => {
    const p = tmpLedger();
    appendFindings(p, Array.from({ length: 64 }, (_, i) => finding(`w${i}`, `e${i}`)));
    expect(loadLedger(p)).toHaveLength(64);
    const raw = JSON.parse(readFileSync(p, 'utf8')) as { overflows: unknown[] };
    expect(raw.overflows).toEqual([]);
  });
  test('溢出 70 条 → 剩 64, 丢最老 6 条, 证据行记 dropped 与时间', () => {
    const p = tmpLedger();
    const batch = Array.from({ length: 70 }, (_, i) => finding(`w${i}`, `e${i}`));
    expect(appendFindings(p, batch)).toEqual({ added: 70, deduped: 0 });

    const kept = loadLedger(p);
    expect(kept).toHaveLength(LEDGER_CAP);
    expect(kept[0]?.where).toBe('w6'); // w0..w5 是最老, 被丢
    expect(kept[63]?.where).toBe('w69');

    const raw = JSON.parse(readFileSync(p, 'utf8')) as { overflows: Array<{ dropped: number; at: string }> };
    expect(raw.overflows).toHaveLength(1);
    expect(raw.overflows[0]?.dropped).toBe(6);
    expect(Number.isNaN(Date.parse(raw.overflows[0]?.at ?? ''))).toBe(false);
  });
  test('多次溢出各留一条证据行', () => {
    const p = tmpLedger();
    appendFindings(p, Array.from({ length: 70 }, (_, i) => finding(`w${i}`, `e${i}`))); // 溢出: 丢 6
    appendFindings(p, Array.from({ length: 5 }, (_, i) => finding(`x${i}`, `e${i}`))); // 69 > 64 → 再丢 5
    expect(loadLedger(p)).toHaveLength(64);
    const raw = JSON.parse(readFileSync(p, 'utf8')) as { overflows: Array<{ dropped: number; at: string }> };
    expect(raw.overflows).toHaveLength(2);
    expect(raw.overflows[0]?.dropped).toBe(6);
    expect(raw.overflows[1]?.dropped).toBe(5);
  });
});

describe('空 / 不存在 ledgerPath', () => {
  test('空路径 → 空数组', () => {
    expect(loadLedger('')).toEqual([]);
  });
  test('不存在的路径 → 空数组', () => {
    expect(loadLedger(join(tmpdir(), 'no-such-dir', 'nope.json'))).toEqual([]);
  });
});

describe('写盘往返', () => {
  test('appendFindings 建文件并写盘, loadLedger 读回同序', () => {
    const p = tmpLedger();
    appendFindings(p, [finding('a', 'e1'), finding('b', 'e2')]);
    const back = loadLedger(p);
    expect(back).toHaveLength(2);
    expect(back[0]?.where).toBe('a');
    expect(back[1]?.where).toBe('b');
  });
});
