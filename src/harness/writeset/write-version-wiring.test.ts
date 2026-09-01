/**
 * 版本守卫的**接线**自检 —— 纯函数绿不代表工具面真的调了它(2026-09-01)。
 *
 * `write-version.test.ts` 钉的是判据本身。这份钉另一件事:`read` 真的往观察台记了,
 * `write` 真的在写之前问了一遍。两者少哪个都会出现「闸写好了、跑着、绿着,而它管的
 * 那一段没人量」—— 同 `write-allow-wiring.test.ts` 头注记的那三次形态。
 *
 * ⚠ 只管**工具通道的 write**。`edit` 刻意不受它约束(理由见 `agent-tools.ts` 的
 * `requireFreshVersion` 注:edit 在同一次调用里先读再逐字唯一匹配,装上去永远判不出失配 ——
 * 一条永远绿的闸不是闸),下面有一条正控用例把这个刻意留白钉住。
 * bash 通道(`> file`)同样绕得过去,那一侧的边界是 jail 的 worktree。
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOmdAgentTools, type AnyOmdTool } from '../agent-tools';
import type { FileObservation } from './write-version';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'omd-write-version-'));
  dirs.push(root);
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'shared.ts'), 'export const A = 1;\n');
  return root;
}

/** `table` 省略 = **不传 `fileObservations`** = 闸缺席(对话位那条路)。 */
const toolsFor = (root: string, table?: Map<string, FileObservation>): Record<string, AnyOmdTool> =>
  Object.fromEntries(
    createOmdAgentTools({ cwd: root, ...(table === undefined ? {} : { fileObservations: () => table }) }).map((t) => [
      t.name,
      t,
    ]),
  );

const run = (t: AnyOmdTool, args: unknown): Promise<unknown> =>
  t.execute('call-1', args as never, undefined, undefined) as Promise<unknown>;

/** 并发兄弟在同一棵 worktree 里干的那一下(per-run 隔离 ⇒ 它和我们共用这个 root)。 */
const siblingWrites = (root: string, rel: string, content: string): void =>
  writeFileSync(join(root, rel), content);

describe('版本守卫接线 —— 拦住的那一侧', () => {
  test('★★ 读过 → 兄弟改了 → 整体覆写: 当场拒, 且兄弟的内容一个字没丢', () => {
    // 这就是这道闸存在的全部理由: 今天 (闸之前) 这一次 write 会成功, 兄弟那份改动整片消失,
    // 而 detectRuntimeWriteRace 要等整张图跑完才"只报不拦"地说一句。
    // 怎么让它红: 把 agent-tools.ts 的 write 里 `requireFreshVersion(full, 'write')` 那一行摘掉
    //            → 覆写成功, 这条红 (rejects 不成立, 且盘上内容变成 'MINE')。
    const root = fixture();
    const t = toolsFor(root, new Map());
    return (async () => {
      await run(t.read!, { path: 'src/shared.ts' });
      siblingWrites(root, 'src/shared.ts', 'export const A = 999; // 兄弟写的\n');
      await expect(run(t.write!, { path: 'src/shared.ts', content: 'MINE' })).rejects.toThrow(/BLOCKED 写版本失配/);
      expect(readFileSync(join(root, 'src', 'shared.ts'), 'utf8')).toContain('兄弟写的');
    })();
  });

  test('★★ 一次都没读过就整体覆写已存在的文件 → 拒 (FS_NOT_OBSERVED), 盘上原样', async () => {
    // 怎么让它红: 把 checkWriteVersion 的 `observed === undefined` 分支改成恒放行 → 这条红。
    const root = fixture();
    const t = toolsFor(root, new Map());
    await expect(run(t.write!, { path: 'src/shared.ts', content: 'MINE' })).rejects.toThrow(/BLOCKED 写前未观察/);
    expect(readFileSync(join(root, 'src', 'shared.ts'), 'utf8')).toBe('export const A = 1;\n');
  });

  test('★★ 拒了之后**重读再写**必须走得通 —— 否则这道闸就是个死胡同', async () => {
    // 判词让执行体去 read 再写。如果那条路也被拒, 判词就是骗人的, 而模型会原地空转到熔断。
    // 怎么让它红: 把 read 里的 `observed(full)` 摘掉 → 重读之后仍判 NOT_OBSERVED, 这条红。
    const root = fixture();
    const t = toolsFor(root, new Map());
    await expect(run(t.write!, { path: 'src/shared.ts', content: 'MINE' })).rejects.toThrow(/BLOCKED/);
    await run(t.read!, { path: 'src/shared.ts' }); // ← 判词点名的下一步
    await run(t.write!, { path: 'src/shared.ts', content: 'MINE' });
    expect(readFileSync(join(root, 'src', 'shared.ts'), 'utf8')).toBe('MINE');
  });
});

describe('版本守卫接线 —— 放行的那一侧 (假 major 的代价是有人把闸关掉)', () => {
  test('★★ 新建盘上没有的文件 → 放行 (绝大多数正当写)', async () => {
    const root = fixture();
    const t = toolsFor(root, new Map());
    await run(t.write!, { path: 'src/brand-new.ts', content: 'hello' });
    expect(readFileSync(join(root, 'src', 'brand-new.ts'), 'utf8')).toBe('hello');
  });

  test('★★ 连写两次同一个文件 → 都放行 (写完会重新观察, 不许自己撞自己)', async () => {
    // 怎么让它红: 把 write 成功之后那行 `observed(full)` 摘掉 → 第二次写判 STALE, 这条红。
    const root = fixture();
    const t = toolsFor(root, new Map());
    await run(t.write!, { path: 'src/brand-new.ts', content: 'v1' });
    await run(t.write!, { path: 'src/brand-new.ts', content: 'v2' });
    expect(readFileSync(join(root, 'src', 'brand-new.ts'), 'utf8')).toBe('v2');
  });

  test('★★ edit 之后再 write 同一个文件 → 放行 (edit 也是观察侧)', async () => {
    // 怎么让它红: 把 edit 写回之后那行 `observed(full)` 摘掉 → 这条红。
    const root = fixture();
    const t = toolsFor(root, new Map());
    await run(t.read!, { path: 'src/shared.ts' });
    await run(t.edit!, { path: 'src/shared.ts', oldText: 'const A = 1', newText: 'const A = 2' });
    await run(t.write!, { path: 'src/shared.ts', content: 'FULL' });
    expect(readFileSync(join(root, 'src', 'shared.ts'), 'utf8')).toBe('FULL');
  });

  test('★★ edit **刻意不受版本闸约束**: 兄弟改了别处, edit 照样成功', async () => {
    // 这条钉的是留白, 不是漏接。edit 在同一次调用里先读再逐字唯一匹配 —— 兄弟改了同一段时
    // 它的 oldText 自己就会红 (下一条), 改了别处时这一次 edit 本来就该成功。
    // 怎么让它红: 给 edit 也加上 requireFreshVersion → 这条红 (一条不该拦的写被拦了)。
    const root = fixture();
    const t = toolsFor(root, new Map());
    await run(t.read!, { path: 'src/shared.ts' });
    siblingWrites(root, 'src/shared.ts', 'export const A = 1;\nexport const B = 2; // 兄弟加的\n');
    await run(t.edit!, { path: 'src/shared.ts', oldText: 'const A = 1', newText: 'const A = 9' });
    const now = readFileSync(join(root, 'src', 'shared.ts'), 'utf8');
    expect(now).toContain('const A = 9'); // 我的改动进去了
    expect(now).toContain('兄弟加的'); // 兄弟的改动没丢 —— 两条并存, 这正是不该拦的理由
  });

  test('★ 兄弟改的就是同一段时, edit 自己会红 (不需要版本闸兜)', async () => {
    const root = fixture();
    const t = toolsFor(root, new Map());
    await run(t.read!, { path: 'src/shared.ts' });
    siblingWrites(root, 'src/shared.ts', 'export const A = 42;\n');
    await expect(
      run(t.edit!, { path: 'src/shared.ts', oldText: 'const A = 1', newText: 'const A = 9' }),
    ).rejects.toThrow(/oldText .*找不到/);
  });
});

describe('版本守卫接线 —— 缺席 = 闸缺席, 放行 (不是"零竞争")', () => {
  test('★★ 不传 fileObservations → 覆写没读过的已存在文件照常成功 (与本闸出现之前逐字节一致)', async () => {
    // 对话位 (chat.ts / chat-seat.ts) 走的就是这条路: 人在场, 没有并发兄弟, 装上只会白多一轮 read。
    // 怎么让它红: 把 requireFreshVersion 里 `if (!table) return;` 摘掉 → 缺席被当成空观察台,
    //            所有对话位的覆写全拒, 这条红。
    const root = fixture();
    const t = toolsFor(root); // ← 不传
    await run(t.write!, { path: 'src/shared.ts', content: 'MINE' });
    expect(readFileSync(join(root, 'src', 'shared.ts'), 'utf8')).toBe('MINE');
  });

  test('★★ 观察台**按调用新建**: 上一次调用看过的版本, 不许放行这一次的覆写', async () => {
    // runner 跨调用复用 (MCP 长驻进程)。把观察台烤进装配期 = 拿上一个节点看过的版本
    // 放行这一个 —— 那比没有闸更糟, 因为它看起来是绿的。
    // 怎么让它红: 让 agent-leaf 的 wrapper 复用同一个 Map (而不是每次 new Map()) → 这条红。
    const root = fixture();
    const call1 = new Map<string, FileObservation>();
    const t1 = toolsFor(root, call1);
    await run(t1.read!, { path: 'src/shared.ts' });
    // 第二次调用: 新观察台 (agent-leaf.ts 的 wrapper 每次 `fileObservations: new Map()`)。
    const t2 = toolsFor(root, new Map<string, FileObservation>());
    await expect(run(t2.write!, { path: 'src/shared.ts', content: 'MINE' })).rejects.toThrow(/BLOCKED 写前未观察/);
  });
});
