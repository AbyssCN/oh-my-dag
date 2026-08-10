/**
 * S4 ext 进 leaf —— 装配侧契约测试 (C-9, SDD 2026-08-10 omd-open-ecosystem-s4-ext-leaf, D-1..D-9)。
 *
 * 形状抄 host.test.ts: **真子进程不桩 spawn** —— ext 是 `__fixtures__/good.mjs`(我们自己写的
 * 12 行, 不是第三方代码), 加载与调用都经 host 的真 IPC 子进程 (host.test.ts:4-8 同注: 打桩掉
 * 子进程 = 把被测的那条边一起打掉)。`which: () => null` 注入与 host.test.ts **同惯例必须有**
 * (初版没注入, 3 条 5s 超时红): bwrap 在场时 host 起在 jail 里, 而 jail 只 bind cwd + 系统目录,
 * 本测试的 entry (仓内 __fixtures__) 与 runner 都在 tmp cwd 之外 → jail 内不可达, 握手挂死。
 * 该潜伏缺口对"全局 omd 包 + 他仓 ext"的生产形态同样成立, 记档见 ext-tools.ts:ExtHostDeps 注。
 *
 * 反向自检铁律 (仓内惯例 meta-tools.test.ts:114 / mcp-policy-wiring.test.ts:7-17): 每条闸的
 * 证伪方式写进 test 名 —— 删实现 → 本条红, 不许把断言写成恒真。
 *
 * ④ `enforceAppendOnly` 的断言在 host.test.ts(同目录既有, 一字不动), 本套件跑绿即覆盖。
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { buildLeafSystemPrompt, createAgentLeafRunner, loadProjectContext } from '../../harness/agent-leaf';
import { createOmdAgentTools, type AnyOmdTool } from '../../harness/agent-tools';
import { loadExtTools, stopExtTools } from '../../harness/ext-tools';
import { serializableOpts } from '../../harness/hooks/sandboxed-leaf';
import { logger } from '../../logger';

const FIX = join(import.meta.dir, '__fixtures__');
const NO_BWRAP = { which: () => null } as const; // 见文件头: jail 读不到 cwd 外的 entry/runner
const MODEL = 'claude-code:claude-sonnet-5';

// ── SDK 假查询 (agent-leaf-sdk.test.ts:39 同形状): 抓 options, 不回真模型 ──────────────

const asst = (text: string): SDKMessage =>
  ({
    type: 'assistant',
    session_id: 's',
    message: {
      content: [{ type: 'text', text }],
      usage: { input_tokens: 20, output_tokens: 9, cache_read_input_tokens: 5, cache_creation_input_tokens: 4 },
      stop_reason: 'end_turn',
    },
  }) as unknown as SDKMessage;

const success = (): SDKMessage =>
  ({ type: 'result', subtype: 'success', result: 'done', session_id: 's', usage: {} }) as unknown as SDKMessage;

const fakeQuery = (script: SDKMessage[], seen: { options?: Options } = {}) => {
  return (props: { prompt: string; options: Options }) => {
    seen.options = props.options;
    return (async function* () {
      for (const m of script) yield m;
    })();
  };
};

const text = (r: { content: { type: string; text?: string }[] }): string =>
  r.content.map((c) => (c.type === 'text' ? c.text ?? '' : '')).join('');

// ── 夹具 ───────────────────────────────────────────────────────────────────────────────

/** 夹具 cwd: tmp + `.omd/extensions.json` → `__fixtures__/good.mjs`(绝对路径 entry, host.test.ts:143-148 同形状)。 */
const extCwd = (): string => {
  const cwd = mkdtempSync(join(tmpdir(), 'omd-leaf-ext-'));
  mkdirSync(join(cwd, '.omd'), { recursive: true });
  writeFileSync(
    join(cwd, '.omd', 'extensions.json'),
    JSON.stringify({ extensions: [{ name: 'good', entry: join(FIX, 'good.mjs') }] }),
  );
  return cwd;
};

/** 临时接管 logger.warn 收集证据 (用完必须还原)。⚠ patch 的是 `src/logger.ts` 的 **pino 实例** ——
 *  生产代码 (sandboxed-leaf.ts/ext-tools.ts) import 的是它, 不是 src/harness/logger.ts 的 CoreLogger
 *  包装壳 (那是 cli.ts 经 setCoreLogger 注入用的另一只 logger; patch 错对象 = 抓不到)。 */
const captureWarns = (): { msgs: string[]; restore: () => void } => {
  const msgs: string[] = [];
  const orig = logger.warn;
  logger.warn = ((_obj: unknown, msg?: string) => {
    msgs.push(msg ?? '');
  }) as typeof logger.warn;
  return { msgs, restore: () => (logger.warn = orig) };
};

/** 合成工具声明 (沙箱闸三态用; 不真起子进程, serializableOpts 只读元数据)。 */
const decl = (name: string, sandboxSafe?: boolean): AnyOmdTool =>
  ({
    name,
    label: name,
    description: `desc ${name}`,
    parameters: { type: 'object', properties: { text: { type: 'string' } } },
    ...(sandboxSafe === undefined ? {} : { sandboxSafe }),
    executionMode: 'sequential',
    async execute() {
      return { content: [{ type: 'text', text: 'x' }], details: undefined };
    },
  }) as AnyOmdTool;

describe('① C-9 正向: 真子进程 ext → leaf 装配 (loader + runner seam)', () => {
  let cwd: string;
  beforeAll(() => {
    cwd = extCwd();
  });
  afterAll(() => {
    stopExtTools(cwd); // D-9: 防孤儿子进程 (host.test.ts 逐测显式 r.ext.stop() 同精神)
    rmSync(cwd, { recursive: true, force: true });
  });

  test('★ loadExtTools 注册 fixture_echo, execute 经真 IPC 子进程执行成功 (证伪: 删 ext-tools.ts 的 wrap / callTool 代理 → 本条红)', async () => {
    const tools = await loadExtTools(cwd, NO_BWRAP);
    expect(tools.map((t) => t.name)).toEqual(['fixture_echo']);
    const r = await tools[0]!.execute('call-1', { text: '你好' });
    expect(text(r)).toBe('echo: 你好');
  });

  test('★ C-4 共享单例: 同一 cwd 两次 loadExtTools → 同一 Promise 引用 (证伪: ext-tools.ts 去掉 per-cwd 缓存 → 本条红)', () => {
    expect(loadExtTools(cwd, NO_BWRAP)).toBe(loadExtTools(cwd, NO_BWRAP));
  });

  test('★ leaf 装配含该工具: allowedTools 带 mcp__omd__fixture_echo, systemPrompt 含 promptSnippet (证伪: runner 不传 customTools / assemble.ts 条件 spread 删掉 → 本条红)', async () => {
    const seen: { options?: Options } = {};
    const tools = await loadExtTools(cwd, NO_BWRAP);
    const run = createAgentLeafRunner({
      cwd,
      customTools: tools,
      sdkQueryFn: fakeQuery([asst('改完了'), success()], seen),
      skillDeps: { roots: [] },
    });
    await run({ prompt: 'x', model: MODEL });
    expect(seen.options?.allowedTools).toContain('mcp__omd__fixture_echo');
    expect(seen.options?.systemPrompt).toContain('fixture_echo(text)');
  });
});

describe('② I-1: 零 extensions.json → 工具面字节零变化 (冻结基线)', () => {
  test('★ 零清单 cwd → loadExtTools 空数组, leaf 装配与冻结基线逐字节相等, 无任何 ext 工具名 (证伪: 零 ext 也注入空段/前缀 → 本条红; 同口径 agent-tools.test.ts:290-291)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'omd-leaf-ext-none-'));
    try {
      expect(await loadExtTools(root, NO_BWRAP)).toEqual([]);
      const seen: { options?: Options } = {};
      const run = createAgentLeafRunner({
        cwd: root,
        sdkQueryFn: fakeQuery([asst('改完了'), success()], seen),
        skillDeps: { roots: [] },
      });
      await run({ prompt: 'x', model: MODEL });
      const baseline = buildLeafSystemPrompt({
        cwd: root,
        tools: createOmdAgentTools({ cwd: root }),
        contextFiles: loadProjectContext(root),
      });
      expect(seen.options?.systemPrompt).toBe(baseline);
      expect(seen.options?.allowedTools).toEqual([
        'mcp__omd__read', 'mcp__omd__write', 'mcp__omd__edit', 'mcp__omd__ls', 'mcp__omd__grep', 'mcp__omd__bash',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('③ sandboxed-leaf 闸: serializableOpts 按 sandboxSafe 剥除 + warn 列名', () => {
  test('★ 未声明 → 剥除 + warn 文本含工具名, 输出无 customTools 键 (证伪: 删 sandboxed-leaf.ts:65 filter 或 :69 warn → 本条红)', () => {
    const cap = captureWarns();
    try {
      const out = serializableOpts({ cwd: '/x', customTools: [decl('t2')] });
      expect(out.customTools).toBeUndefined();
      expect(cap.msgs.some((m) => m.includes('[omd/sandboxed-leaf]') && m.includes('t2'))).toBe(true);
    } finally {
      cap.restore();
    }
  });

  test('★ 三态混合: 只保留 sandboxSafe:true, warn 只列被剥的两个名字 (证伪: filter 条件写反/漏分支 → 本条红)', () => {
    const cap = captureWarns();
    try {
      const out = serializableOpts({ cwd: '/x', customTools: [decl('t1', true), decl('t2'), decl('t3', false)] });
      expect((out.customTools as AnyOmdTool[]).map((t) => t.name)).toEqual(['t1']);
      const warn = cap.msgs.find((m) => m.includes('[omd/sandboxed-leaf]')) ?? '';
      expect(warn).toContain('t2');
      expect(warn).toContain('t3');
      expect(warn).not.toContain('t1');
    } finally {
      cap.restore();
    }
  });

  test('★ 保留工具跨 JSON 边界: 元数据原样过线, execute 闭包剥落 (证伪: filter 剥掉 true → 本条红; D-7 留证)', () => {
    const out = serializableOpts({ cwd: '/x', customTools: [decl('t1', true)] });
    const kept = (out.customTools as AnyOmdTool[])[0]!;
    expect(kept.name).toBe('t1');
    expect(kept.description).toBe('desc t1');
    expect(kept.sandboxSafe).toBe(true);
    const round = JSON.parse(JSON.stringify(out)) as { customTools?: Record<string, unknown>[] };
    expect(round.customTools![0]!.name).toBe('t1');
    expect('execute' in round.customTools![0]!).toBe(false);
  });

  test('★ 生产 wrap 的形状: good.mjs 未声明 sandboxSafe → 真 ext 工具被剥 + warn 列 fixture_echo (证伪: ext-tools.ts:72 把未声明烤成 true → 本条红)', async () => {
    const cwd = extCwd();
    const cap = captureWarns();
    try {
      const tools = await loadExtTools(cwd, NO_BWRAP);
      expect(tools[0]!.sandboxSafe).toBe(false);
      const out = serializableOpts({ cwd, customTools: tools });
      expect(out.customTools).toBeUndefined();
      expect(cap.msgs.some((m) => m.includes('[omd/sandboxed-leaf]') && m.includes('fixture_echo'))).toBe(true);
    } finally {
      cap.restore();
      stopExtTools(cwd);
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
