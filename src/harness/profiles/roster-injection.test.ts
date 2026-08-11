/**
 * G-6:conductor prompt 的 profile 名册注入自检。
 * 覆盖两层防线:(1) conductorSystemPrompt 的 formatter 本身对超长/带换行 summary 做单行+≤80 截断
 * (INV-7,不含 persona 全文);(2) 真实内置档案 (design-review) 走 loadProfiles → DTO → 注入,
 * 断言 exact line 且不含 persona 原文。
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { conductorSystemPrompt } from '../conductor-plan';
import { loadProfiles } from './profile';

describe('conductor profile 名册注入', () => {
  test('INV-7: formatter 单行化 + 不泄漏 persona 全文', () => {
    const longSummary = 'skills=ui-reviewer; output=review-finding — 这是一段带换行的\nsummary，' +
      '故意写得很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长以便超过八十字';
    expect([...longSummary].length).toBeGreaterThan(80);
    expect(longSummary).toContain('\n');

    const prompt = conductorSystemPrompt({
      profiles: [{ name: 'weird-profile', summary: longSummary }],
    });

    // 名册段落里那一整条 entry 必须是单行:summary 里的换行不能原样穿透到 prompt 行结构。
    const lines = prompt.split('\n');
    const entryLine = lines.find((l) => l.includes('"weird-profile"'));
    expect(entryLine).toBeDefined();
    // formatter 本地折叠任意空白并截到 ≤80 code points;entry 保持单行 `- "name": summary` 形状。
    expect(entryLine!.startsWith('- "weird-profile": ')).toBe(true);

    // persona 全文 (若误传 ProfileSpec 而非 DTO) 不得出现 —— 这里 DTO 本就只含 name+summary,
    // 断言 prompt 不含常见 persona 关键字面量,防止未来有人把 persona 塞进 summary 参数。
    expect(prompt).not.toContain('前端审美审核');
  });

  test('真实内置名册 (design-review) 注入 exact line, 不含 persona 字段值', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'roster-injection-'));
    try {
      const profiles = loadProfiles(cwd);
      const designReview = profiles.get('design-review');
      expect(designReview).toBeDefined();

      const summary = designReview!.skills?.length
        ? `skills=${designReview!.skills.join(',')}; output=${designReview!.outputSchema}`
        : 'specialist profile';

      const prompt = conductorSystemPrompt({
        profiles: [{ name: 'design-review', summary }],
      });

      // 期望行从档案自身构造 (2026-08-11 集成修正: f7a4c38 换装三 skill 后不再硬编码 ui-reviewer)。
      expect(prompt).toContain(`- "design-review": ${summary}`);
      expect(prompt).not.toContain(designReview!.persona);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('无 profiles 时不产出名册段落', () => {
    const prompt = conductorSystemPrompt({});
    expect(prompt).not.toContain('Leaf profile roster');
  });

  test('name 数组含多条时逐条落成独立 "- name: summary" 行', () => {
    const prompt = conductorSystemPrompt({
      profiles: [
        { name: 'a', summary: 'sum-a' },
        { name: 'b', summary: 'sum-b' },
      ],
    });
    expect(prompt).toContain('- "a": sum-a');
    expect(prompt).toContain('- "b": sum-b');
    expect(prompt).toContain('Leaf profile roster (field "profile", optional; use ONLY these names):');
    expect(prompt).toContain('Do not invent profile names.');
  });
});
