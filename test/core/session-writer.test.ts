/**
 * W1 session-writer excerpt 硬化测试切片 (SDD 契约 · GWT-H1, `src/harness/session/writer.ts`)。
 *
 * 契约面 (GWT-H1):
 * - Given 主 transcript user 文本以 `<task-notification` 或 `Base directory for this skill:` 开头,
 *   When W1 excerpt 构建 `U:` 行, Then 该行不出现 (锚 `writer.ts:143`, `:148` 同)。
 * - `<system-reminder` 既有过滤不回退 (回归)。
 * - 正向对照: 普通 user 文本照常出 `U:` 行; assistant text/tool_use 照常出 `A:`/`T:` 行,
 *   防硬化过度过滤。
 *
 * 前缀名单与 `stop-ledger.ts:118-120` 同源 (import 复用, 不复制字面); 本测试不直连 parser。
 */
import { describe, expect, test } from 'bun:test';
import { excerpt } from '../../src/harness/session/writer';

const jsonl = (recs: unknown[]): string => recs.map((r) => JSON.stringify(r)).join('\n');

const userLine = (content: unknown) => ({ type: 'user', message: { content } });

describe('excerpt U: 行前缀过滤 (GWT-H1)', () => {
  test('string 分支: `<task-notification` 开头的 user 文本不进 U: 行', () => {
    const src = jsonl([userLine('<task-notification 于 10:00: 需继续 W3 硬化')]);
    expect(excerpt(src)).not.toContain('U: ');
  });

  test('string 分支: skill 前导开头的 user 文本不进 U: 行', () => {
    const src = jsonl([userLine('Base directory for this skill: /home/dev/repos/oh-my-dag')]);
    expect(excerpt(src)).not.toContain('U: ');
  });

  test('string 分支: `<system-reminder` 过滤不回退 (回归)', () => {
    const src = jsonl([userLine('<system-reminder> 续接上下文注入')]);
    expect(excerpt(src)).not.toContain('U: ');
  });

  test('text array 分支: `<task-notification` 开头的 text 块不进 U: 行', () => {
    const src = jsonl([userLine([{ type: 'text', text: '<task-notification 轮次开始' }])]);
    expect(excerpt(src)).not.toContain('U: ');
  });

  test('text array 分支: skill 前导开头的 text 块不进 U: 行', () => {
    const src = jsonl([userLine([{ type: 'text', text: 'Base directory for this skill: /tmp/x' }])]);
    expect(excerpt(src)).not.toContain('U: ');
  });

  test('text array 分支: `<system-reminder` text 块不回退 (回归)', () => {
    const src = jsonl([userLine([{ type: 'text', text: '<system-reminder> 注入' }])]);
    expect(excerpt(src)).not.toContain('U: ');
  });

  test('正向对照: 普通 user 文本照常出 U: 行', () => {
    const src = jsonl([userLine('把 W3-H 硬化做完')]);
    expect(excerpt(src)).toContain('U: 把 W3-H 硬化做完');
  });

  test('正向对照: 普通 text 块照常出 U: 行', () => {
    const src = jsonl([userLine([{ type: 'text', text: '继续 ledgers 移植' }])]);
    expect(excerpt(src)).toContain('U: 继续 ledgers 移植');
  });

  test('正向对照: 混合行中噪音前缀只挡自身, 不影响相邻真实内容', () => {
    const src = jsonl([
      userLine('<task-notification 轮次 2'),
      userLine('真实问题: excerpt 是否过滤'),
      userLine([{ type: 'text', text: 'Base directory for this skill: /repo' }]),
    ]);
    const out = excerpt(src);
    expect(out).toContain('U: 真实问题: excerpt 是否过滤');
    expect(out.match(/U: /g)?.length).toBe(1);
  });

  test('正向对照: assistant text/tool_use 照常出 A:/T: 行', () => {
    const src = jsonl([
      { type: 'assistant', message: { content: [{ type: 'text', text: '已核对常量' }] } },
      {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'bun test test/core/session-writer.test.ts' } }] },
      },
    ]);
    const out = excerpt(src);
    expect(out).toContain('A: 已核对常量');
    expect(out).toContain('T: Bash bun test test/core/session-writer.test.ts');
  });
});
