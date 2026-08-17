/**
 * L1 判据:custom prompts(W4 第一件)。
 *
 * 反向自检(实跑):把 `expandPrompt` 的"找不到返 null"改成返原文 → 「不认识回落」当场红;
 * 把 loader 换成自写 readdir(绕开 pi 件)→ 「frontmatter description 被解析」当场红。
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROMPTS_DIR, expandPrompt, loadUserPrompts } from './prompts';

const world = (): string => mkdtempSync(join(tmpdir(), 'omd-prompts-'));

describe('loadUserPrompts —— pi loader 直通', () => {
  test('目录不存在 → 空表不是错误', async () => {
    const { promptTemplates } = await loadUserPrompts(world());
    expect(promptTemplates).toEqual([]);
  });

  test('★ 一文件一命令, frontmatter description 被 pi loader 解析', async () => {
    const cwd = world();
    mkdirSync(join(cwd, PROMPTS_DIR), { recursive: true });
    writeFileSync(join(cwd, PROMPTS_DIR, 'ship.md'), '---\ndescription: 提交并推送\n---\n跑测试, 然后 commit + push: $ARGUMENTS\n');
    const { promptTemplates } = await loadUserPrompts(cwd);
    expect(promptTemplates.map((t) => t.name)).toEqual(['ship']);
    expect(promptTemplates[0]?.description).toBe('提交并推送');
  });
});

describe('expandPrompt —— 交互层展开, core 不感知', () => {
  const T = [{ name: 'ship', content: '跑测试, 然后 commit: $ARGUMENTS' }];

  test('★ 参数替换进正文; 不认识的名字返 null 回落 (不抢内建/聊天)', () => {
    const out = expandPrompt(T, '/ship 修掉 flake');
    expect(out).toContain('commit: 修掉 flake');
    expect(out).not.toContain('$ARGUMENTS');
    expect(expandPrompt(T, '/nope x')).toBeNull();
    expect(expandPrompt(T, '平文本')).toBeNull();
  });

  test('无参调用: 占位符按 pi 语义处理, 不抛', () => {
    expect(() => expandPrompt(T, '/ship')).not.toThrow();
  });
});
