/**
 * S0 闸: 记忆库**单一真源** —— TUI 对话位与 MCP 装配解析出**同一个** SQLite 路径。
 * (契约: docs/plan/2026-08-09-dream-as-dag-记忆固化器-执行契约-sdd.md §S0)
 *
 * 病灶 (修复前): `cli.ts` 对话位写 `memory: createOmdMemory()` 无参 → store.ts:133 落
 * `:memory:` 进程内临时库, 而 MCP 装配 (`assemble.ts` createDefaultMemory) 读写
 * `OMD_MEMORY_PATH ?? .omd/memory.db` —— 两处互不可见, 固化进盘的 fact 在 TUI 永远召不回。
 *
 * 闸的两层:
 *  ① 运行时探针: 真源函数 createDefaultMemory 解析出的路径 = env.OMD_MEMORY_PATH ?? '.omd/memory.db'
 *     —— 不看源码看盘面: 库文件落盘位置 + 同 env 两实例互见 / 异 env 互不可见。
 *  ② 结构性断言: cli.ts 的对话位不自己开第二份库 —— 旧接线 `createOmdMemory()` **不存在**;
 *     2026-08-18 起对话位干脆不接记忆 (owner 裁: 召回按需调, 不每轮注入), 故该断言改成
 *     条件式: 一处 `memory:` 都不许有; 哪天接回来也只能是 assemble.ts 那一份。
 *
 * ⚠ 反向自检 (已当场证伪, 2026-08-09):
 *   把 cli.ts 改回旧接线 ——
 *     const { createOmdMemory } = await import('./memory/store');
 *     ...
 *     memory: createOmdMemory(),
 *   → 本文件两条结构性断言当场红:
 *     - "对话位接线同一真源 createDefaultMemory" 红:
 *       `expect(cliSrc).toContain('memory: createDefaultMemory(process.env)')`
 *       error: expect(received).toContain(expected)
 *       `Expected to contain: "memory: createDefaultMemory(process.env)"` — received 中无此串;
 *     - "旧的无参 createOmdMemory() 接线不复存在" 红:
 *       `expect(cliSrc).not.toMatch(/\bcreateOmdMemory\(/)`
 *       error: expect(received).not.toMatch(expected)
 *       `Expected substring or pattern: not /\bcreateOmdMemory\(/` — 旧接线的 import 与调用两处命中。
 *   改回正确实装后全绿。
 */
import { describe, expect, test, afterEach } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createDefaultMemory } from '../src/mcp/assemble';
import type { OmdMemory } from '../src/harness/memory';

const tmpRoot = mkdtempSync(join(tmpdir(), 'omd-s0-single-source-'));

const probeFact = {
  namespace: 'user.preference',
  category: 's0-probe',
  value: 'single-source',
  source_event_id: 's0-gate',
  confidence: { level: 'agent_tentative' as const, source_event_ids: ['s0-gate'], created_at: new Date() },
};

const live: OmdMemory[] = [];
afterEach(() => {
  while (live.length) live.pop()!.close();
});

describe('S0 运行时探针: createDefaultMemory 解析路径 = env.OMD_MEMORY_PATH ?? .omd/memory.db', () => {
  test('OMD_MEMORY_PATH 覆盖: 库落在覆盖路径, 同 env 两实例互见 (同一个文件)', async () => {
    const dbPath = join(tmpRoot, 'override', 'mem.db');
    const env = { OMD_MEMORY_PATH: dbPath };
    const a = createDefaultMemory(env);
    const b = createDefaultMemory(env);
    live.push(a, b);
    // 路径字符串证据: 覆盖路径处真的出现了 SQLite 库文件 (含 mkdirSync 建出的父目录)。
    expect(existsSync(dbPath)).toBe(true);
    const w = await a.writeFact({ ...probeFact });
    expect(w.status).toBe('written');
    // 同一路径的第二实例看得见 → 解析出的路径字符串相同 (否则是两个互不可见的库)。
    expect(b.liveByIdentity('user.preference', b.identityKeyOf({ ...probeFact }))).not.toBeNull();
  });

  test('异 env → 异路径 → 互不可见 (证明路径真的由 env 驱动, 不是常量)', async () => {
    const envA = { OMD_MEMORY_PATH: join(tmpRoot, 'a.db') };
    const envB = { OMD_MEMORY_PATH: join(tmpRoot, 'b.db') };
    const a = createDefaultMemory(envA);
    const b = createDefaultMemory(envB);
    live.push(a, b);
    await a.writeFact({ ...probeFact });
    expect(b.liveByIdentity('user.preference', b.identityKeyOf({ ...probeFact }))).toBeNull();
  });

  test('无 OMD_MEMORY_PATH: 落 cwd 相对 .omd/memory.db', () => {
    const prevCwd = process.cwd();
    const sandbox = join(tmpRoot, 'cwd-sandbox');
    mkdirSync(sandbox, { recursive: true });
    try {
      process.chdir(sandbox);
      const m = createDefaultMemory({});
      live.push(m);
      expect(existsSync(resolve(sandbox, '.omd/memory.db'))).toBe(true);
    } finally {
      process.chdir(prevCwd);
    }
  });
});

describe('S0 结构性闸: cli.ts 对话位接线到 assemble.ts 的同一真源', () => {
  const cliSrc = readFileSync(resolve(import.meta.dir, '../src/harness/cli.ts'), 'utf8');
  const assembleSrc = readFileSync(resolve(import.meta.dir, '../src/mcp/assemble.ts'), 'utf8');

  test('真源唯一: createDefaultMemory 从 assemble.ts 导出, MCP 装配 fallback 用它', () => {
    expect(assembleSrc).toContain('export function createDefaultMemory(env: NodeJS.ProcessEnv)');
    expect(assembleSrc).toContain('deps.memory ?? createDefaultMemory(env)');
  });

  /**
   * 2026-08-18 owner 裁: 对话位**不接记忆** —— 传 `memory` 就等于每轮自动召回
   * (`agent.ts` 的 `transformContext`), 而召回改成按需调 `memory_recall` 工具。
   * 于是原来那条 `expect(cliSrc).toContain('memory: createDefaultMemory(process.env)')`
   * 不再成立: 它钉的是"接了, 且接对了", 而现在的判据是"没接; 若哪天接回来, 只能接这一份"。
   * **单一真源这条不变量本身没变**, 上面两组运行时探针仍在量它。
   * 「对话位每轮不召回」那条独立的闸在 `src/tui/tools/chat-seat.test.ts` (只看 tui 分支)。
   */
  test('对话位不接记忆; 若接回来只能是同一真源 createDefaultMemory(process.env)', () => {
    const memoryKeyLines = cliSrc.split('\n').filter((l) => /^\s*memory:/.test(l));
    expect(memoryKeyLines).toEqual([]); // 现状: 一处都不传
    // 条件式判据 (接回来那天才生效): 任何 `memory:` 键都必须来自 assemble.ts 那一份。
    for (const l of memoryKeyLines) expect(l).toContain('createDefaultMemory(process.env)');
  });

  test('旧的无参 createOmdMemory() 接线不复存在 (cli.ts 全文无 createOmdMemory 出现)', () => {
    // 旧病灶形态 = `createOmdMemory()` 无参落 ':memory:'。出现该符号 (import 或调用) 即红。
    expect(cliSrc).not.toMatch(/\bcreateOmdMemory\(/);
    expect(cliSrc).not.toContain("import('./memory/store')");
  });
});
