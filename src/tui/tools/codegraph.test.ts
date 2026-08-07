/**
 * L1 判据:符号能力的**探测式** provider(goal §4 S17)。
 *
 * goal 那条 verify 只有一句:探测不到 → 工具**从工具列表彻底消失**
 * (不是"注册了、调了才失败")。所以这里钉的全是"在不在",不是"调了会怎样"。
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCodegraphTools, probeCodegraph } from './codegraph';

const freshCwd = (indexed: boolean): string => {
  const d = mkdtempSync(join(tmpdir(), 'omd-cg-'));
  if (indexed) mkdirSync(join(d, '.codegraph'));
  return d;
};

const withBin = (bin: string | null) => (b: string) => (b === 'codegraph' ? bin : null);

describe('★ 两段探测, 少一段就会给出垃圾答案', () => {
  test('二进制不在 → 不可用, 且说得出是这一段', () => {
    const p = probeCodegraph({ cwd: freshCwd(true), which: withBin(null) });
    expect(p.available).toBe(false);
    expect((p as { reason: string }).reason).toContain('二进制');
  });

  test('★ 二进制在但**没建索引** → 也不可用 —— 查询会返回空, 而模型会把空读成"这符号不存在"', () => {
    const p = probeCodegraph({ cwd: freshCwd(false), which: withBin('/usr/bin/codegraph') });
    expect(p.available).toBe(false);
    expect((p as { reason: string }).reason).toContain('没建过索引');
  });

  test('两段都过 → 可用, 带上二进制路径', () => {
    const p = probeCodegraph({ cwd: freshCwd(true), which: withBin('/usr/bin/codegraph') });
    expect(p).toEqual({ available: true, bin: '/usr/bin/codegraph' });
  });

  test('★ 不可用时 reason 一定有内容 —— "为什么没有这个能力"是唯一能据以行动的东西', () => {
    for (const cwd of [freshCwd(false), freshCwd(true)]) {
      for (const bin of [null, '/usr/bin/codegraph']) {
        const p = probeCodegraph({ cwd, which: withBin(bin) });
        if (!p.available) expect(p.reason.length).toBeGreaterThan(0);
      }
    }
  });
});

describe('★ 探测不到 → 工具从列表里彻底消失', () => {
  // 反向自检 (2026-08-07 实跑): 把 createCodegraphTools 里的 `return []` 改成照常返回两个工具
  // → 下面两条当场红 (那正是 goal 禁止的"注册了、调了才失败")。
  test('二进制不在 → 空数组', () => {
    expect(createCodegraphTools({ cwd: freshCwd(true), which: withBin(null) })).toEqual([]);
  });

  test('没建索引 → 空数组', () => {
    expect(createCodegraphTools({ cwd: freshCwd(false), which: withBin('/x/codegraph') })).toEqual([]);
  });

  test('可用 → 挂两个工具, 名字稳定', () => {
    const tools = createCodegraphTools({ cwd: freshCwd(true), which: withBin('/x/codegraph') });
    expect(tools.map((t) => t.name)).toEqual(['codegraph_query', 'codegraph_context']);
  });
});

describe('调用形状', () => {
  const spy = () => {
    const calls: { bin: string; args: string[] }[] = [];
    return {
      calls,
      run: async (bin: string, args: string[]) => {
        calls.push({ bin, args });
        return { ok: true, text: 'sym1\nsym2' };
      },
    };
  };

  test('★ 参数走数组不拼字符串 —— 查询串来自模型, 拼字符串就要处理引号转义', async () => {
    const s = spy();
    const [q] = createCodegraphTools({ cwd: freshCwd(true), which: withBin('/x/codegraph'), run: s.run });
    await (q as { execute: (id: string, p: unknown) => Promise<unknown> }).execute('1', { q: 'foo; rm -rf /' });
    expect(s.calls[0]?.args).toEqual(['query', 'foo; rm -rf /', '-l', '10']);
  });

  test('★ 失败原文原样给模型 —— "索引过期了"与"符号不存在"是两种不同的下一步', async () => {
    const tools = createCodegraphTools({
      cwd: freshCwd(true),
      which: withBin('/x/codegraph'),
      run: async () => ({ ok: false, text: 'index is stale, run codegraph sync' }),
    });
    const r = (await (tools[0] as { execute: (id: string, p: unknown) => Promise<{ content: { text: string }[] }> }).execute('1', { q: 'x' }));
    expect(r.content[0]?.text).toContain('index is stale');
    expect(r.content[0]?.text).toContain('codegraph 失败');
  });

  test('空结果说"(无结果)", 不返回空串', async () => {
    const tools = createCodegraphTools({
      cwd: freshCwd(true),
      which: withBin('/x/codegraph'),
      run: async () => ({ ok: true, text: '' }),
    });
    const r = (await (tools[0] as { execute: (id: string, p: unknown) => Promise<{ content: { text: string }[] }> }).execute('1', { q: 'x' }));
    expect(r.content[0]?.text).toBe('(无结果)');
  });
});
