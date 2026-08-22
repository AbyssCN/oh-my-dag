/**
 * 写域闸的**接线**自检 —— 纯函数绿不代表工具面真的调了它(2026-08-21)。
 *
 * `write-allow.test.ts` 钉的是判据本身。这份钉的是另一件事:`write` / `edit` 的
 * `requireWritable` 真的把 `opts.writeAllow()` 问了一遍。两者少哪个都会出现
 * 「闸写好了、跑着、绿着,而它管的那一段没人量」—— 本程已经撞见三次这个形态。
 *
 * ⚠ 只管**工具通道**。leaf 的 bash 绕得过去(`> file` / `python3 -c` / `node -e`),
 * 那一侧的边界是 jail 的 worktree,不是这道闸。判词里也这么写。
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOmdAgentTools, type AnyOmdTool } from '../agent-tools';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'omd-write-allow-'));
  dirs.push(root);
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'allowed.ts'), 'export const A = 1;\n');
  writeFileSync(join(root, 'src', 'forbidden.ts'), 'export const B = 1;\n');
  return root;
}

const toolsFor = (root: string, allow?: readonly string[]): Record<string, AnyOmdTool> =>
  Object.fromEntries(
    createOmdAgentTools({ cwd: root, ...(allow === undefined ? {} : { writeAllow: () => allow }) }).map((t) => [t.name, t]),
  );

const run = (t: AnyOmdTool, args: unknown): Promise<unknown> =>
  t.execute('call-1', args as never, undefined, undefined) as Promise<unknown>;

describe('写域闸接线 —— write / edit 真的问了写集', () => {
  test('★★ write 到声明外 → 拒, 且盘上没被建出来', () => {
    // 怎么让它红: 把 requireWritable 里那段 writeAllow 判定摘掉 → 文件被建出来, 这条红。
    const root = fixture();
    const t = toolsFor(root, ['src/allowed.ts']);
    expect(run(t.write!, { path: 'src/brand-new.ts', content: 'x' })).rejects.toThrow(/写域越界/);
    expect(existsSync(join(root, 'src', 'brand-new.ts'))).toBe(false);
  });

  test('★★ edit 到声明外 → 拒, 且原文件一个字没动', () => {
    const root = fixture();
    const t = toolsFor(root, ['src/allowed.ts']);
    expect(
      run(t.edit!, { path: 'src/forbidden.ts', oldText: 'export const B = 1;', newText: 'export const B = 2;' }),
    ).rejects.toThrow(/写域越界/);
    expect(readFileSync(join(root, 'src', 'forbidden.ts'), 'utf8')).toBe('export const B = 1;\n');
  });

  test('★ 声明内的 write / edit 照常放行(正控 —— 闸不是恒拒)', async () => {
    const root = fixture();
    const t = toolsFor(root, ['src/allowed.ts', 'src/new-ok.ts']);
    await run(t.write!, { path: 'src/new-ok.ts', content: 'hello' });
    expect(readFileSync(join(root, 'src', 'new-ok.ts'), 'utf8')).toBe('hello');
    await run(t.edit!, { path: 'src/allowed.ts', oldText: 'const A = 1', newText: 'const A = 2' });
    expect(readFileSync(join(root, 'src', 'allowed.ts'), 'utf8')).toContain('const A = 2');
  });

  test('★★ **缺席 = 闸缺席, 放行** —— 不是"零越界"', async () => {
    // conductor 铺图路径本就没有逐节点写集。缺席时行为必须与本闸出现之前**逐字节一致**,
    // 否则一接线就把所有非平铺图的 run 全打红。
    // 怎么让它红: 把 `allow !== undefined` 改成 `allow?.length` → 缺席被当成空写集, 全拒, 这条红。
    const root = fixture();
    const t = toolsFor(root); // 不传 writeAllow
    await run(t.write!, { path: 'src/anything.ts', content: 'x' });
    expect(existsSync(join(root, 'src', 'anything.ts'))).toBe(true);
  });

  test('★★ 空写集 `[]` → **全拒**(与"缺席"分叉的唯一那一格)', () => {
    // ⚠ 这条是 2026-08-21 做证伪时补的: 原来只有"整个不传"那条, 而
    // `allow !== undefined` 与 `allow?.length` 在那种输入上**结果相同** ——
    // 于是那条用例并不判别它声称判别的东西(闸量的不是那件事, 这次是测试自己)。
    // 两者只在 `[]` 上分叉: 声明了"什么都不许写" vs 没配这道闸。NULL≠0≠不适用。
    // 怎么让它红: 把 `allow !== undefined` 改成 `allow?.length` → 空写集被当成缺席放行。
    const root = fixture();
    const t = toolsFor(root, []);
    expect(run(t.write!, { path: 'src/anything.ts', content: 'x' })).rejects.toThrow(/写域越界/);
    expect(existsSync(join(root, 'src', 'anything.ts'))).toBe(false);
  });

  test('★ 判词点名允许清单 + 指向契约 —— 别让执行体反复试同一批路径', () => {
    const root = fixture();
    const t = toolsFor(root, ['src/allowed.ts']);
    expect(run(t.write!, { path: 'src/nope.ts', content: 'x' })).rejects.toThrow(/src\/allowed\.ts/);
  });
});
