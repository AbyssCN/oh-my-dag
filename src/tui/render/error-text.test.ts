/**
 * src/tui/render/error-text.test —— 「错误压成一行」的闸。
 *
 * 判据钉两件**互相拉扯**的事:
 * ① 屏上是**一行人话**(那条 403 原来占 4 行);
 * ② **证据不许吞** —— 认不出的原样返回、截断要说清还有多少字、URL(唯一的"怎么解决")要留。
 *
 * 逐条证伪方式(都实跑过):
 * - 「取 error.message」→ 把 `pickMessage` 的递归去掉 → 403 那条红;
 * - 「保留 URL」→ 把 tail 拼接删掉 → URL 那条红;
 * - 「认不出原样返回」→ 让 catch 里返回空串 → 半截 JSON 那条红;
 * - 「截断要标字数」→ 把 `cap` 改成裸 slice → 长文本那条红。
 */
import { describe, expect, test } from 'bun:test';
import { ERROR_LINE_MAX, humanizeProviderError } from './error-text';

/** 就是帧上那一条(`docs/bars/gauntlet-p3-账本.md` 件3 轮3 的判词指的那个)。 */
const REAL_403 =
  '[chat-agent] provider 错误: 403 {"error":{"type":"permission_error","message":"You\'ve reached your usage limit for this billing cycle. Your quota will be refreshed in the next cycle. To continue now, purchase extra usage or upgrade your plan: https://www.kimi.com/code/#pricing"},"type":"error"}';

describe('humanizeProviderError', () => {
  test('★ 真实那条 403:一行、带状态码、带人话、带 URL,没有 JSON 括号', () => {
    const line = humanizeProviderError(REAL_403);
    expect(line).not.toContain('{');
    expect(line).not.toContain('"error"');
    expect(line).toContain('403');
    expect(line).toContain('usage limit');
    expect(line).toContain('https://www.kimi.com/code/#pricing'); // 怎么解决的唯一线索
    expect(line.split('\n').length).toBe(1);
  });

  test('★ URL 已在 message 里 ⇒ 不再贴第二遍(同屏不说两次同一件事)', () => {
    const line = humanizeProviderError(REAL_403);
    expect(line.match(/https:\/\/www\.kimi\.com/g)?.length).toBe(1);
  });

  test('`{message}` 直接在顶层也认', () => {
    expect(humanizeProviderError('x: 500 {"message":"internal"}')).toBe('x: 500 internal');
  });

  test('`{error:"字符串"}` 也认', () => {
    expect(humanizeProviderError('y: 400 {"error":"bad request"}')).toBe('y: 400 bad request');
  });

  test('★ 纯文本原样返回(没有 JSON 就没有什么可压的)', () => {
    expect(humanizeProviderError('ECONNREFUSED 127.0.0.1:8080')).toBe('ECONNREFUSED 127.0.0.1:8080');
  });

  test('★ 半截 JSON 认不出 ⇒ **原样返回**, 不猜也不截成半句', () => {
    const half = 'z: 502 {"error":{"message":"gateway';
    expect(humanizeProviderError(half)).toBe(half);
  });

  test('★ 认得出但没有 message 字段 ⇒ 原样返回(不许返回空)', () => {
    const noMsg = 'w: 429 {"error":{"type":"rate_limit"}}';
    expect(humanizeProviderError(noMsg)).toBe(noMsg);
  });

  test('★ 太长 ⇒ 截断并**说清还有多少字**(静默截断会让人以为错误就这么短)', () => {
    const long = `q: 500 {"message":"${'x'.repeat(400)}"}`;
    const line = humanizeProviderError(long);
    expect(line.length).toBeLessThan(400);
    expect(line).toContain('还有');
    expect(line).toContain('全文在日志里');
  });

  test('★★ 截断也**不许把 URL 吃掉** —— 它是唯一告诉人"怎么解决"的东西', () => {
    // 这条就是第一版栽的那个:真实 403 恰好在 150 字处被切断, URL 正好在切口之后。
    const line = humanizeProviderError(REAL_403);
    expect(line.endsWith('https://www.kimi.com/code/#pricing')).toBe(true);
    expect(line).toContain('还有'); // 正文被截了, 而 URL 还在
  });

  test('换行被拍平(对话区一条 notice 就该是一行)', () => {
    expect(humanizeProviderError('a: 500 {"message":"line1\\nline2"}')).toBe('a: 500 line1 line2');
  });

  test('上限就是 ERROR_LINE_MAX(判据钉常量, 免得两处漂开)', () => {
    const line = humanizeProviderError(`q: 500 {"message":"${'y'.repeat(ERROR_LINE_MAX + 50)}"}`);
    expect(line.startsWith(`q: 500 ${'y'.repeat(10)}`)).toBe(true);
  });
});
