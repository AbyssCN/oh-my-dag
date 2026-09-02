/**
 * P3 S3 —— `omd-report` 尾块三态读取 (D-12)。
 * 证伪: 把 readTrailer 的 missing 分支改成抛错 → ①红;把 zod 校验拿掉 → ③红(多余键放行);
 * 把 extractTrailerRaw 改成取第一个 fence → ⑤红。
 */
import { describe, expect, test } from 'bun:test';
import { extractTrailerRaw, parseTrailerYaml, readTrailer, synthesizeTrailer } from './trailer';

const GOOD = [
  '改完了。下面是尾块。',
  '```omd-report',
  'changed: [src/a.ts, src/b.test.ts]',
  'acceptance_ran: true',
  'acceptance_exit: 0',
  'acceptance_tail: |',
  '  3 pass',
  '  0 fail',
  'not_verified: []',
  'stuck: false',
  'next: done',
  '```',
].join('\n');

describe('readTrailer 三态', () => {
  test('① 无 fence → missing', () => {
    expect(readTrailer('只有散文, 没有尾块')).toEqual({ kind: 'missing' });
  });
  test('② 合法尾块 → parsed, 七个字段全出, 块标量按行保留', () => {
    const r = readTrailer(GOOD);
    expect(r.kind).toBe('parsed');
    if (r.kind !== 'parsed') return;
    expect(r.trailer).toEqual({
      changed: ['src/a.ts', 'src/b.test.ts'],
      acceptance_ran: true,
      acceptance_exit: 0,
      acceptance_tail: '3 pass\n0 fail',
      not_verified: [],
      stuck: false,
      next: 'done',
    });
  });
  test('③ 有 fence 但缺必填键 / 多余键 → unparsable 且 raw 原文在', () => {
    const r = readTrailer('```omd-report\nchanged: []\nfoo: 1\n```');
    expect(r.kind).toBe('unparsable');
    if (r.kind !== 'unparsable') return;
    expect(r.raw).toContain('foo: 1');
    expect(r.why.length).toBeGreaterThan(0);
  });
  test('④ 有 fence 但不是 key: value 行 → unparsable, 不抛', () => {
    const r = readTrailer('```omd-report\n这不是 yaml\n```');
    expect(r.kind).toBe('unparsable');
  });
  test('⑤ 多个 fence → 取最后一个 (leaf 的最终陈述)', () => {
    const two = `${GOOD}\n再想了一下, 改口:\n\`\`\`omd-report\nchanged: []\nacceptance_ran: false\nacceptance_exit: null\nnot_verified: [x]\nstuck: true\nnext: retry\n\`\`\``;
    const r = readTrailer(two);
    expect(r.kind).toBe('parsed');
    if (r.kind === 'parsed') expect(r.trailer.stuck).toBe(true);
  });
  test('列表的 `- item` 形态与 null / 引号串', () => {
    const obj = parseTrailerYaml('changed:\n  - "src/x.ts"\n  - src/y.ts\nacceptance_exit: null\nnext: "all good"');
    expect(obj).toEqual({ changed: ['src/x.ts', 'src/y.ts'], acceptance_exit: null, next: 'all good' });
  });
  test('extractTrailerRaw 对无 fence 返 null, 不返空串 (缺席 ≠ 空)', () => {
    expect(extractTrailerRaw('x')).toBeNull();
  });
  test('synthesizeTrailer 只用记录, 不猜: 无记录 → ran=false exit=null changed=[]', () => {
    expect(synthesizeTrailer({})).toEqual({ changed: [], acceptance_ran: false, acceptance_exit: null, not_verified: [], stuck: false, next: '' });
    expect(synthesizeTrailer({ changed: ['a'], acceptance: { ran: true, exit: 0 } }).acceptance_ran).toBe(true);
  });
});
