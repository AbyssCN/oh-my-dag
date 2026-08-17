/**
 * src/harness/hashline —— s2 stale 闸 (杠杆 4) 契约测试。
 *
 * 验 GWT-4/5/6:
 *   - GWT-4: edit 撞 stale → 未 read 再 edit 同文件 → 第二次拒 (BLOCKED, 文件未动, 文本含 BLOCKED 与下一步)。
 *   - GWT-5: 正常 read → edit(成功) → 用回执新标签再 edit → 全程无拦 (INV-1/D-4 零回归)。
 *   - GWT-6: 多文件 patch 含一个在集 path → 整拒, 全部文件未动 (D-3 部分 apply 比全拒更坏)。
 *
 * 反向自检: 注掉 `staleSince.set(...)` (MismatchError catch 内) → GWT-4 第二次 edit 退化为
 * `reason: 'stale_tag'` 而非 'stale_unre-grounded', 红。注掉 gate 前的 `blockedPaths` 检查 → GWT-6
 * 直接进 apply, 因多 section 部分准备先撞 stale 抛错, 退化为 'stale_tag', 红。
 */
import { describe, expect, test } from 'bun:test';
import { InMemoryFilesystem } from '@oh-my-pi/hashline';
import { createHashlineTools, type HashlineTools } from './hashline';

interface ToolsWithFs extends HashlineTools {
  fs: InMemoryFilesystem;
}

const textOf = (r: { content: { type: string; text?: string }[] }): string =>
  r.content.map((c) => (c.type === 'text' ? c.text ?? '' : '')).join('');

const details = (r: { details: Record<string, unknown> }): Record<string, unknown> => r.details;

/** 构造一个 InMemoryFilesystem 装的 hashline 工具组, 预置文件内容。 */
function toolsWith(files: Record<string, string>): ToolsWithFs {
  const fs = new InMemoryFilesystem(Object.entries(files));
  return { ...createHashlineTools({ fs }), fs };
}

/** 简单 patch: 替换第 1 行单行 → 新内容。 */
const replaceLine1 = (path: string, tag: string, newText: string): string =>
  `¶${path}#${tag}\nreplace 1..1:\n+${newText}\n`;

describe('s2 hashline stale 闸 — GWT-4', () => {
  test('★ edit 撞 stale → 未 read 再 edit → 第二次拒 (BLOCKED, 文件未动); read 后再 edit 恢复', async () => {
    const { readTool, editTool, fs } = toolsWith({ '/foo.ts': 'old\n' });

    // 1) read 拿原标签
    const r1 = await readTool.execute('r1', { path: '/foo.ts' });
    expect(details(r1).ok).toBe(true);
    const oldTag = details(r1).tag as string;
    expect(oldTag).toMatch(/^[0-9A-F]{4}$/);

    // 2) 外部把文件改了 → 标签失效
    fs.set('/foo.ts', 'new\n');

    // 3) 用旧标签 edit → MismatchError, reason='stale_tag'。
    //    准备/提交分离: prepare 抛错则不 commit, 文件不会被 edit 改; 已 drift 的内容仍在那。
    const e1 = await editTool.execute('e1', { patch: replaceLine1('/foo.ts', oldTag, 'new\n') });
    expect(details(e1).reason).toBe('stale_tag');
    expect(details(e1).ok).toBe(false);
    expect(fs.get('/foo.ts')).toBe('new\n'); // drift 后未再被 edit 改动

    // 4) 未 read 再 edit 同文件 → 闸整拒 (GWT-4 命中)
    const e2 = await editTool.execute('e2', { patch: replaceLine1('/foo.ts', oldTag, 'new\n') });
    expect(details(e2).reason).toBe('stale_unre-grounded');
    expect(details(e2).ok).toBe(false);
    expect(details(e2).blockedPaths).toEqual(['/foo.ts']);
    // 文本含 BLOCKED + 「未执行」 + 下一步指令 (INV-4)
    const t = textOf(e2);
    expect(t).toContain('BLOCKED');
    expect(t).toContain('本次编辑未执行');
    expect(t).toContain('hashline_read');
    // 文件仍未动 (闸拒绝 = 未执行, drift 后的状态保持)
    expect(fs.get('/foo.ts')).toBe('new\n');

    // 5) 重 read → 清 stale 闸, 拿新标签
    const r2 = await readTool.execute('r2', { path: '/foo.ts' });
    expect(details(r2).ok).toBe(true);
    const newTag = details(r2).tag as string;
    expect(newTag).toMatch(/^[0-9A-F]{4}$/);

    // 6) 用新标签 edit → 成功 (内容已是 'new\n', 写 'new\n' = 内容不变但流程走通)
    const e3 = await editTool.execute('e3', { patch: replaceLine1('/foo.ts', newTag, 'new\n') });
    expect(details(e3).ok).toBe(true);
    expect(fs.get('/foo.ts')).toBe('new\n');
  });

  test('闸不 throw: BLOCKED 是文本结果, 不进 pi loop 的 catch (loop 不断)', async () => {
    // INV-4 核心 — execute() 不抛异常, 返 ok:false 文本。
    const { readTool, editTool, fs } = toolsWith({ '/x.ts': 'a\n' });
    const r = await readTool.execute('r', { path: '/x.ts' });
    const tag = details(r).tag as string;
    fs.set('/x.ts', 'b\n');
    await editTool.execute('e1', { patch: replaceLine1('/x.ts', tag, 'b\n') }); // mark stale
    // 第二次不该 throw
    const e2 = await editTool.execute('e2', { patch: replaceLine1('/x.ts', tag, 'b\n') });
    expect(() => e2).not.toThrow();
    expect(details(e2).reason).toBe('stale_unre-grounded');
  });
});

describe('s2 hashline stale 闸 — GWT-5 (INV-1/D-4 零回归)', () => {
  test('★ 正常 read → edit(成功) → 用回执新标签再 edit → 全程无拦', async () => {
    const { readTool, editTool, fs } = toolsWith({ '/c.ts': 'one\ntwo\nthree\n' });

    // read
    const r = await readTool.execute('r', { path: '/c.ts' });
    expect(details(r).ok).toBe(true);
    const tag1 = details(r).tag as string;

    // edit 1: 改第 2 行 (one|two|three → one|TWO|three)
    const e1 = await editTool.execute('e1', {
      patch: `¶/c.ts#${tag1}\nreplace 2..2:\n+TWO\n`,
    });
    expect(details(e1).ok).toBe(true);
    expect(details(e1).reason).toBeUndefined();
    expect(fs.get('/c.ts')).toBe('one\nTWO\nthree\n');

    // 从回执文本抽新标签 (D-4: 不入 staleSince, 直接可链)
    const m1 = textOf(e1).match(/#([0-9A-F]{4})/);
    expect(m1).not.toBeNull();
    const tag2 = m1![1]!;

    // edit 2: 用新标签继续改第 3 行
    const e2 = await editTool.execute('e2', {
      patch: `¶/c.ts#${tag2}\nreplace 3..3:\n+THREE\n`,
    });
    expect(details(e2).ok).toBe(true);
    expect(details(e2).reason).toBeUndefined();
    expect(fs.get('/c.ts')).toBe('one\nTWO\nTHREE\n');

    // edit 3: 再链
    const m2 = textOf(e2).match(/#([0-9A-F]{4})/);
    expect(m2).not.toBeNull();
    const tag3 = m2![1]!;
    const e3 = await editTool.execute('e3', {
      patch: `¶/c.ts#${tag3}\nreplace 1..1:\n+ONE\n`,
    });
    expect(details(e3).ok).toBe(true);
    expect(fs.get('/c.ts')).toBe('ONE\nTWO\nTHREE\n');
  });

  test('stale 标记不影响其他 path (隔离): A stale 后 B 的 edit 仍正常', async () => {
    // D-3: 闸按 canonicalPath 分桶, 不同 path 互不干扰 (INV-1: 正常链行为不变)。
    const { readTool, editTool, fs } = toolsWith({ '/a.ts': 'A\n', '/b.ts': 'B\n' });
    const ra = await readTool.execute('ra', { path: '/a.ts' });
    const rb = await readTool.execute('rb', { path: '/b.ts' });
    const tagA = details(ra).tag as string;
    const tagB = details(rb).tag as string;

    // A 撞 stale
    fs.set('/a.ts', 'A2\n');
    const eA = await editTool.execute('eA', { patch: replaceLine1('/a.ts', tagA, 'A2\n') });
    expect(details(eA).reason).toBe('stale_tag');

    // B 用原标签 edit → 不受 A 闸影响, 正常成功
    const eB = await editTool.execute('eB', { patch: replaceLine1('/b.ts', tagB, 'B2\n') });
    expect(details(eB).ok).toBe(true);
    expect(fs.get('/b.ts')).toBe('B2\n');
    // A 的 stale 闸仍在
    const eA2 = await editTool.execute('eA2', { patch: replaceLine1('/a.ts', tagA, 'A3\n') });
    expect(details(eA2).reason).toBe('stale_unre-grounded');
  });
});

describe('s2 hashline stale 闸 — GWT-6 (多文件 patch 整拒)', () => {
  test('★ 多文件 patch 含一个在集 path → 整拒, 全部文件未动', async () => {
    const { readTool, editTool, fs } = toolsWith({ '/a.ts': 'A1\n', '/b.ts': 'B1\n' });

    const ra = await readTool.execute('ra', { path: '/a.ts' });
    const rb = await readTool.execute('rb', { path: '/b.ts' });
    const tagA = details(ra).tag as string;
    const tagB = details(rb).tag as string;

    // A 撞 stale
    fs.set('/a.ts', 'A2\n');
    await editTool.execute('eA', { patch: replaceLine1('/a.ts', tagA, 'A2\n') });
    expect(
      details(await editTool.execute('eA2', { patch: replaceLine1('/a.ts', tagA, 'A2\n') })).reason,
    ).toBe('stale_unre-grounded');

    // 多文件 patch: [A(stale), B(valid)]
    const multiPatch = `¶/a.ts#${tagA}\nreplace 1..1:\n+A3\n¶/b.ts#${tagB}\nreplace 1..1:\n+B2\n`;
    const em = await editTool.execute('em', { patch: multiPatch });
    expect(details(em).ok).toBe(false);
    expect(details(em).reason).toBe('stale_unre-grounded');
    expect(details(em).blockedPaths).toEqual(['/a.ts']);
    // 整拒: A 和 B 都没被改
    expect(fs.get('/a.ts')).toBe('A2\n');
    expect(fs.get('/b.ts')).toBe('B1\n');

    // 重 read A → 清 A 闸
    const ra2 = await readTool.execute('ra2', { path: '/a.ts' });
    const tagA2 = details(ra2).tag as string;

    // 同样 patch, A 用新标签 → 成功
    const em2 = await editTool.execute('em2', {
      patch: `¶/a.ts#${tagA2}\nreplace 1..1:\n+A3\n¶/b.ts#${tagB}\nreplace 1..1:\n+B2\n`,
    });
    expect(details(em2).ok).toBe(true);
    expect(fs.get('/a.ts')).toBe('A3\n');
    expect(fs.get('/b.ts')).toBe('B2\n');
  });

  test('多文件 patch 中非 stale path 不会出现在 blockedPaths (只列在集的)', async () => {
    // GWT-6 收口: blockedPaths 只列触发闸的 path, 别的正常 path 不进文本, 不让模型误判 B 也坏了。
    const { readTool, editTool, fs } = toolsWith({ '/a.ts': 'A1\n', '/b.ts': 'B1\n' });
    const ra = await readTool.execute('ra', { path: '/a.ts' });
    const rb = await readTool.execute('rb', { path: '/b.ts' });
    const tagA = details(ra).tag as string;
    const tagB = details(rb).tag as string;
    fs.set('/a.ts', 'A2\n');
    await editTool.execute('eA', { patch: replaceLine1('/a.ts', tagA, 'A2\n') });

    const multiPatch = `¶/a.ts#${tagA}\nreplace 1..1:\n+A3\n¶/b.ts#${tagB}\nreplace 1..1:\n+B2\n`;
    const em = await editTool.execute('em', { patch: multiPatch });
    expect(details(em).blockedPaths).toEqual(['/a.ts']);
    expect(details(em).blockedPaths).not.toContain('/b.ts');
    const t = textOf(em);
    expect(t).toContain('/a.ts');
    expect(t).not.toContain('- /b.ts');
  });
});