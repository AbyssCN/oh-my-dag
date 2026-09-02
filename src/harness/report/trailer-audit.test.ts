/**
 * P3 S3 —— 尾块 vs 引擎记录差集 (INV-5 / INV-6 / D-24)。
 * 证伪: 缺席分支改判红 → ①红;`record.acceptance === undefined` 改判红 → ④红;
 * `changed` 差集判反 → ⑤红;散文正则接回来 → ⑦红。
 */
import { describe, expect, test } from 'bun:test';
import { auditTrailer, REPORT_TRAILER_VERDICT } from './trailer-audit';

const trailer = (fields: Record<string, string>) =>
  '```omd-report\n' +
  Object.entries({ changed: '[]', acceptance_ran: 'false', acceptance_exit: 'null', not_verified: '[]', stuck: 'false', next: 'done', ...fields })
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n') +
  '\n```';

describe('auditTrailer', () => {
  test('★ ① 尾块缺席 → 零 red, selfReport=missing, 合成尾块用记录 (INV-5)', () => {
    const a = auditTrailer('只有散文。测试全部通过。', { acceptance: { ran: true, exit: 0 }, changed: ['a.ts'] });
    expect(a.red).toBe(false);
    expect(a.selfReport).toBe('missing');
    expect(a.trailer).toEqual({ changed: ['a.ts'], acceptance_ran: true, acceptance_exit: 0, not_verified: [], stuck: false, next: '' });
    expect(a.verdicts.map((v) => v.severity)).toEqual(['notice']);
  });
  test('② 解析失败 → 零 red, selfReport=unparsable, 原文在 read.raw', () => {
    const a = auditTrailer('```omd-report\nnonsense\n```', { acceptance: null, changed: [] });
    expect(a.red).toBe(false);
    expect(a.selfReport).toBe('unparsable');
    expect(a.read.kind === 'unparsable' && a.read.raw).toBe('nonsense');
  });
  test('★ ③ acceptance_ran=true 而记录 ran=false → red, 判词带前缀', () => {
    const a = auditTrailer(trailer({ acceptance_ran: 'true', acceptance_exit: '0' }), { acceptance: { ran: false, exit: null }, changed: [] });
    expect(a.red).toBe(true);
    const red = a.verdicts.find((v) => v.severity === 'red')!;
    expect(red.code).toBe('acceptance-ran');
    expect(red.message.startsWith(REPORT_TRAILER_VERDICT)).toBe(true);
  });
  test('③b acceptance_ran=true 而记录 acceptance=null (派了没作用域) → 同样 red', () => {
    const a = auditTrailer(trailer({ acceptance_ran: 'true', acceptance_exit: '0' }), { acceptance: null, changed: [] });
    expect(a.red).toBe(true);
  });
  test('★ ④ 记录面缺 acceptance (视图没带过来) → notice + 证据, 不判红 (D-24)', () => {
    const a = auditTrailer(trailer({ acceptance_ran: 'true', acceptance_exit: '0' }), { changed: [] });
    expect(a.red).toBe(false);
    expect(a.verdicts.some((v) => v.code === 'record-missing' && v.severity === 'notice')).toBe(true);
  });
  test('★ ⑤ changed 里有引擎没核实的文件 → red;子集 → 不红', () => {
    const bad = auditTrailer(trailer({ changed: '[src/a.ts, src/ghost.ts]' }), { acceptance: { ran: false, exit: null }, changed: ['src/a.ts'] });
    expect(bad.red).toBe(true);
    expect(bad.verdicts.find((v) => v.severity === 'red')!.message).toContain('src/ghost.ts');
    const ok = auditTrailer(trailer({ changed: '[./src/a.ts]' }), { acceptance: { ran: false, exit: null }, changed: ['src/a.ts', 'src/b.ts'] });
    expect(ok.red).toBe(false);
  });
  test('⑥ acceptance_exit 与引擎复验不符 → notice, 不是 red', () => {
    const a = auditTrailer(trailer({ acceptance_ran: 'true', acceptance_exit: '0' }), { acceptance: { ran: true, exit: 1 }, changed: [] });
    expect(a.red).toBe(false);
    expect(a.verdicts.some((v) => v.code === 'acceptance-exit')).toBe(true);
  });
  test('★ ⑦ 散文里的「测试通过」不再产生任何判定 —— 整改回执配诚实尾块 → 零 finding', () => {
    const text = '已按 verifier 意见修改, 确保测试通过, 本次已由引擎实测通过。\n' + trailer({ acceptance_ran: 'true', acceptance_exit: '0', changed: '[src/a.ts]' });
    const a = auditTrailer(text, { acceptance: { ran: true, exit: 0 }, changed: ['src/a.ts'] });
    expect(a.verdicts).toEqual([]);
    expect(a.red).toBe(false);
    expect(a.selfReport).toBe('leaf');
  });
});
