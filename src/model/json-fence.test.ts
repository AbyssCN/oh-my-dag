/**
 * 结构化回复的 JSON 抠取 —— 锁住 2026-08-11 run 7d50fda2 的事故形状。
 *
 * 事故: 判官按责备集协议 (verifier.ts D-1) 把 ```blame 围栏写进 `reason` **字段值**里,
 * 而老的 stripFences 只认「第一个 ``` 到下一个 ```」→ 把 payload 里的内嵌围栏当成包裹层,
 * 抠出 `blame\n[...]` 送进 JSON.parse → `invalid JSON: Unexpected identifier "blame"`,
 * 三次纠偏重试全撞同一条 (模型回的其实是对的), 判卷失败把一个已收敛的 run 掀成 infra-error。
 *
 * 反向自检 (每条 ★ 都实跑证伪过): 把 jsonCandidates 换回单条懒惰围栏正则
 * (`text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] ?? text`) → ★ 两条当场红。
 */
import { describe, expect, test } from 'bun:test';
import { jsonCandidates } from './index';

/** 逐候选试 parse —— 与 callModel 结构化分支同一条消费方式。 */
const parseFirst = (text: string): unknown => {
  let err: Error | undefined;
  for (const cand of jsonCandidates(text)) {
    try {
      return JSON.parse(cand);
    } catch (e) {
      err ??= e as Error;
    }
  }
  throw err;
};

/** 事故当天那份判词的形状: 结构化 verdict, reason 里嵌责备集围栏。 */
const verdictWithBlame = JSON.stringify({
  pass: false,
  reason: 's3 没交付。\n```blame\n[{"node":"s3","reason":"前驱 429"}]\n```',
  usage: { in: 1, out: 2 },
});

describe('jsonCandidates —— 内嵌围栏不该被当成包裹层 (run 7d50fda2)', () => {
  test('★ 裸 JSON + reason 内嵌 ```blame 围栏 → 解得出, 且 blame 围栏原样留在 reason 里', () => {
    const v = parseFirst(verdictWithBlame) as { pass: boolean; reason: string };
    expect(v.pass).toBe(false);
    expect(v.reason).toContain('```blame');
    // 责备集要能被下游 parseBlameVerdict 解出来 —— 抠坏了它, 定点重跑就退化成整轮。
    expect(v.reason).toContain('"node":"s3"');
  });

  test('★ 外层 ```json 包裹 + 内嵌 ```blame 围栏 → 贪婪候选兜住 (老实现在这里报 Unterminated string)', () => {
    const v = parseFirst(`\`\`\`json\n${verdictWithBlame}\n\`\`\``) as { pass: boolean };
    expect(v.pass).toBe(false);
  });

  test('老行为不动: 外层 ```json 包裹的普通 JSON', () => {
    expect(parseFirst('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  test('老行为不动: 散文 + 围栏', () => {
    expect(parseFirst('这是我的判断:\n```json\n{"a":1}\n```\n以上。')).toEqual({ a: 1 });
  });

  test('老行为不动: 裸 JSON', () => {
    expect(parseFirst('{"a":1}')).toEqual({ a: 1 });
  });

  test('真的不是 JSON → 仍抛, 且报的是**第一个候选** (模型真回的那段) 的原话', () => {
    expect(() => parseFirst('我觉得这活儿干完了。')).toThrow();
  });
});
