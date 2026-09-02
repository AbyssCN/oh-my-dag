/**
 * src/harness/dag/run-id.test —— run-id 归一 + mint 契约闸。
 *
 * 外部判据: `bun test src/harness/dag/run-id.test.ts` → exit 0。
 *
 * 覆盖:
 * - slugifyGoal: 大小写 / 非字面收为单 - / 头尾 trim / 40 截 / 空/null 返空 / CJK 保留
 * - mintRunId: 形状 / slug 缺席退化 / 撞名由 6hex 破
 */
import { describe, expect, test } from 'bun:test';
import { mintRunId, slugifyGoal } from './run-id';

describe('slugifyGoal', () => {
  test('lower + 标点收为单 -', () => {
    expect(slugifyGoal('Hello World!')).toBe('hello-world');
  });

  test('CJK 与拉丁数字保留, 之间收 -', () => {
    expect(slugifyGoal('为 omd TUI 加一个去往选单')).toBe('为-omd-tui-加一个去往选单');
  });

  test('头尾 - trim', () => {
    expect(slugifyGoal('---abc---')).toBe('abc');
  });

  test('超 40 截, 末位 - 不留', () => {
    const long = 'a'.repeat(60);
    const out = slugifyGoal(long);
    expect(out.length).toBeLessThanOrEqual(40);
    expect(out.endsWith('-')).toBe(false);
  });

  test('超 40 且尾段是分隔区: 截到 40 再剥尾 -', () => {
    // 22 字 + 19 字 + ' ' 收为 '-': 'aaa...aaa-' + 'bbb...bbb', 第 40 位是 '-'
    const s = 'a'.repeat(22) + ' ' + 'b'.repeat(19);
    const out = slugifyGoal(s);
    expect(out.length).toBeLessThanOrEqual(40);
    expect(out.endsWith('-')).toBe(false);
    expect(out).toBe('a'.repeat(22) + '-' + 'b'.repeat(17)); // 22 + 1 + 17 = 40, 末位是 'b' 不是 '-'
  });

  test('空串 / null / undefined → 空', () => {
    expect(slugifyGoal('')).toBe('');
    expect(slugifyGoal(null)).toBe('');
    expect(slugifyGoal(undefined)).toBe('');
    expect(slugifyGoal('   ')).toBe(''); // 仅空白 → 归一后空
    expect(slugifyGoal('!@#$%')).toBe(''); // 仅标点 → 同上
  });

  test('纯数字与连字符存活', () => {
    expect(slugifyGoal('feature-42')).toBe('feature-42');
  });
});

describe('mintRunId', () => {
  test('有 goal → `<slug>-<6hex>`', () => {
    const id = mintRunId('Hello World', () => 'a3f2be');
    expect(id).toBe('hello-world-a3f2be');
  });

  test('goal 归一后空 → 仅 6hex', () => {
    expect(mintRunId('', () => '123456')).toBe('123456');
    expect(mintRunId('!!!', () => '123456')).toBe('123456');
    expect(mintRunId(undefined, () => '123456')).toBe('123456');
  });

  test('同 goal 不同 hex → id 不同 (撞名破)', () => {
    const a = mintRunId('Hello World', () => 'aaaaaa');
    const b = mintRunId('Hello World', () => 'bbbbbb');
    expect(a).toBe('hello-world-aaaaaa');
    expect(b).toBe('hello-world-bbbbbb');
    expect(a).not.toBe(b);
  });

  test('默认 hex 是 uuid 头 6 位 (位长 + hex 集)', () => {
    const id = mintRunId('Hello');
    expect(id).toMatch(/^hello-[0-9a-f]{6}$/);
  });

  test('返值不含 `\n` / 空格 / 路径不安全字符', () => {
    // 走一次: 任务里塞 ANSI / 控制字符 / 反斜线 → 都应收为 -
    const dirty = 'a\nb\tc\\d/e f';
    const out = mintRunId(dirty, () => 'cafe01');
    expect(out).not.toMatch(/[\n\t\\\/]/);
    // slug 段应是 'a-b-c-d-e-f' 形态 (控制字符收为 -)
    expect(out).toBe('a-b-c-d-e-f-cafe01');
  });
});