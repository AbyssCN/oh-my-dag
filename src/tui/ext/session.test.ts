/**
 * L1 判据:`/reload` 的执行侧(D3,2026-08-11)。
 *
 * ## 三条真正要钉的
 *
 * 1. **旧子进程真的被 kill 了** —— 不 kill 的话症状是"重载完看着好好的",而进程在后台叠着;
 *    这条走注入 spawn 数 kill 次数(真子进程里"有没有被杀"不好读)。
 * 2. **重载后工具接的是新子进程** —— 工具包装若闭包捕获旧 `LoadedExtension`,
 *    重载之后每次调用都打向一个已经死掉的进程,而它**不会响亮地错**,是停在那儿等超时。
 *    这条必须走真子进程,桩掉的话被测的正是那条边。
 * 3. **消失的工具明说它没了** —— 返回空串会被模型读成"跑了、结果为空"。
 *
 * ## 反向自检(2026-08-11 实跑,逐条证伪过)
 *
 * - 把 `reload()` 里 `e.stop()` 那个循环删掉 → 第 1 条当场红(`killed` 为空数组)。
 * - 把 `wrap()` 的 `callByName` 换成闭包捕获当时的 `LoadedExtension` → 第 2 条当场红
 *   (调用打向被 kill 的进程,`扩展 good 调用超时`)。
 * - 把"查不到 → 说它没了"那一支改成返回空串 → 第 3 条当场红。
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createExtSession } from './session';
import type { ChildHandle } from './host';

const FIX = join(import.meta.dir, '__fixtures__');
const GOOD = join(FIX, 'good.mjs');
const GREEDY = join(FIX, 'needs-more.mjs');

/** 沙箱由 bwrap 提供;这里注入 `which: () => null` 走降级路径,免得测试依赖 bwrap 装没装。 */
const deps = { which: () => null, timeoutMs: 20_000 };

function tmpCwd(entries: { name: string; entry: string }[]): string {
  const cwd = mkdtempSync(join(tmpdir(), 'omd-ext-session-'));
  writeManifest(cwd, entries);
  return cwd;
}

function writeManifest(cwd: string, entries: { name: string; entry: string }[]): void {
  mkdirSync(join(cwd, '.omd'), { recursive: true });
  writeFileSync(join(cwd, '.omd', 'extensions.json'), JSON.stringify({ extensions: entries }));
}

/** 工具包装的调用口 —— 取出那一段纯文本(工具面那边就是这么读的)。 */
async function callTool(tool: { execute: (id: string, p: unknown) => Promise<unknown> }, params: unknown): Promise<string> {
  const r = (await tool.execute('t1', params)) as { content: { text?: string }[] };
  return r.content.map((c) => c.text ?? '').join('');
}

describe('★ 真子进程:重载后工具接的是**新**子进程', () => {
  test('★ 同一份清单重载 —— 启动时冻结的那个工具包装照样调得动', async () => {
    const cwd = tmpCwd([{ name: 'good', entry: GOOD }]);
    const s = createExtSession(cwd, deps);
    try {
      const { tools, status } = await s.load();
      expect(tools.map((t) => t.name)).toEqual(['fixture_echo']);
      expect(status).toEqual([{ name: 'good', ok: true, sandboxed: false }]);
      expect(await callTool(tools[0]!, { text: '你好' })).toBe('echo: 你好');

      const r = await s.reload();
      expect(r.loaded).toEqual(['good']);
      expect(r.rejected).toEqual([]);
      // 工具名一个没变 → 两格都空(没变的时候屏上不多说一行)。
      expect(r.toolsAdded).toEqual([]);
      expect(r.toolsRemoved).toEqual([]);
      // ★ 这一句是本条的全部价值:同一个包装对象, 打向重载**之后**那个子进程。
      expect(await callTool(tools[0]!, { text: '再来' })).toBe('echo: 再来');
    } finally {
      s.stop();
    }
  }, 40_000);

  test('★ 清单里删掉扩展 → 面上那个工具明说它没了(不是空串, 不是挂着)', async () => {
    const cwd = tmpCwd([{ name: 'good', entry: GOOD }]);
    const s = createExtSession(cwd, deps);
    try {
      const { tools } = await s.load();
      writeManifest(cwd, []);
      const r = await s.reload();
      expect(r.loaded).toEqual([]);
      expect(r.toolsRemoved).toEqual(['fixture_echo']);
      const out = await callTool(tools[0]!, { text: '你好' });
      expect(out).toContain('fixture_echo');
      expect(out).toContain('/reload');
    } finally {
      s.stop();
    }
  }, 40_000);

  test('★ 空清单起步 → 重载装上的新工具**要重启才进工具面**, 这条限制要报出来', async () => {
    const cwd = tmpCwd([]);
    const s = createExtSession(cwd, deps);
    try {
      const { tools, status } = await s.load();
      expect(tools).toEqual([]);
      expect(status).toEqual([]);
      writeManifest(cwd, [{ name: 'good', entry: GOOD }]);
      const r = await s.reload();
      expect(r.loaded).toEqual(['good']);
      expect(r.toolsAdded).toEqual(['fixture_echo']);
    } finally {
      s.stop();
    }
  }, 40_000);

  test('★ 被拒的扩展带**原因**进回执 —— 藏在日志里等于加载期硬失败白做了', async () => {
    const cwd = tmpCwd([{ name: 'greedy', entry: GREEDY }]);
    const s = createExtSession(cwd, deps);
    try {
      const { status } = await s.load();
      expect(status).toEqual([{ name: 'greedy', ok: false, missing: ['ctx.sessionManager', 'registerShortcut'] }]);
      const r = await s.reload();
      expect(r.loaded).toEqual([]);
      expect(r.rejected).toHaveLength(1);
      expect(r.rejected[0]?.name).toBe('greedy');
      expect(r.rejected[0]?.reason).toContain('没有这');
    } finally {
      s.stop();
    }
  }, 40_000);
});

describe('★ 注入 spawn:旧子进程真的被 kill 了', () => {
  /** 只走握手的假子进程 —— 这条测的是"谁被 kill 了", 不测协议。 */
  function fakeSpawn(killed: string[], spawned: string[]) {
    return (argv: string[]): ChildHandle => {
      const entry = argv[argv.length - 1] ?? '?';
      spawned.push(entry);
      const listeners: ((l: string) => void)[] = [];
      let finish: (n: number) => void = () => {};
      const exited = new Promise<number>((r) => {
        finish = r;
      });
      queueMicrotask(() => {
        const ready = { t: 'ready', tools: [{ name: 'fake_tool', description: '', parameters: {} }], events: [], touched: ['on', 'registerTool'] };
        for (const fn of listeners) fn(JSON.stringify(ready));
      });
      return {
        write: () => {},
        onLine: (fn) => listeners.push(fn),
        kill: () => {
          killed.push(entry);
          finish(0);
        },
        exited,
      };
    };
  }

  test('★ reload = kill 旧的 + 起新的, 不是"起了第二批, 旧的留着"', async () => {
    const killed: string[] = [];
    const spawned: string[] = [];
    const cwd = tmpCwd([{ name: 'good', entry: GOOD }]);
    const s = createExtSession(cwd, { ...deps, spawn: fakeSpawn(killed, spawned) });
    const { tools } = await s.load();
    expect(tools.map((t) => t.name)).toEqual(['fake_tool']);
    expect(spawned).toHaveLength(1);
    expect(killed).toEqual([]);

    await s.reload();
    // ★ 一杀一起。少了 kill 这一半 = 每次 /reload 都在后台叠一批进程。
    expect(killed).toEqual([GOOD]);
    expect(spawned).toEqual([GOOD, GOOD]);
  });

  test('★ 并发两次 /reload 返回同一个 Promise —— 两次 kill 交叉是真会发生的', async () => {
    const killed: string[] = [];
    const spawned: string[] = [];
    const cwd = tmpCwd([{ name: 'good', entry: GOOD }]);
    const s = createExtSession(cwd, { ...deps, spawn: fakeSpawn(killed, spawned) });
    await s.load();
    const a = s.reload();
    const b = s.reload();
    expect(a).toBe(b);
    await a;
    expect(killed).toHaveLength(1);
    expect(spawned).toHaveLength(2);
  });
});

describe('systemPromptHook', () => {
  test('★ 零扩展时原样返回 —— cli.ts 因此可以**无条件挂**这个钩子(0 个扩展重载成 N 个也生效)', async () => {
    const s = createExtSession(tmpCwd([]), deps);
    await s.load();
    expect(await s.systemPromptHook('冻结前缀')).toBe('冻结前缀');
  });

  test('★ 真子进程:重载后下一句就用新扩展的追加', async () => {
    const cwd = tmpCwd([]);
    const s = createExtSession(cwd, deps);
    try {
      await s.load();
      writeManifest(cwd, [{ name: 'good', entry: GOOD }]);
      await s.reload();
      expect(await s.systemPromptHook('冻结前缀')).toBe('冻结前缀\n[fixture 追加]');
    } finally {
      s.stop();
    }
  }, 40_000);
});
