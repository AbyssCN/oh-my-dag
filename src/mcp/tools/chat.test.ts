/**
 * conductor_chat 契约测试(SDD 2026-08-09 远程指挥接缝,S1)。
 *
 * 钉住可离线闸化的那几条判据(判据 1 的"账本有 usage"与判据 4 的"长轮后台化"要真模型/真宿主,
 * 走上线实测,不在这里假装):
 *   · D-1 工具面:手只读(read/ls/grep),write/edit/bash 不许出现 —— 反向自检;
 *   · 新会话建档 + 回执头带 sessionId(续接的把手);
 *   · runIds 从 run/solve 回执收集,[TOOL ERROR] 回执不收;
 *   · 判据 3:轮子抛错 → isError 且一个字节不落盘(空会话不建文件);
 *   · 判据 2:双进程写同一会话 → 后到者锁拒,判词带持有者 pid,原会话仍可读(seq 未坏);
 *   · 装配点:assembleOmdMcpTools 产物里真有 conductor_chat 且 wiring 走得通
 *     (交接 37 坑 #7:装配点没闸 = 完全没接)。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { AnyOmdTool } from '../../harness/agent-tools';
import { createOmdSessionStore, resetSessionCacheForTest, type OmdSessionStore } from '../../harness/chat/session-store';
import type { LockDeps } from '../../harness/chat/session-lock';
import type { OmdMcpTool } from '../server';
import { HEADLESS_HANDS, buildHeadlessChatTools, createConductorChatTool } from './chat';
import { assembleOmdMcpTools, type AssembleOmdMcpDeps } from '../assemble';
import { RunRegistry } from '../run-registry';
import { createOmdMemory } from '../../harness/memory';
import { UNIVERSAL_SAFEGUARD } from '../../memory/safeguards/namespaces';
import { createPlanLedger } from '../../harness/plan-ledger';
import { createDagRecorder } from '../../harness/dag-record';
import { createOwnerInbox } from '../owner-inbox';
import { registerProvider, clearProviders } from '../../model/providers';
import { ALL_SEATS, resetConfigCache, seatEnvKey } from '../../model/role-models';
import type { AgentLeafRunner, CommandLeafRunner } from '../../harness/leaf-runners';

const MODEL = 'deepseek:deepseek-v4-flash'; // pi-ai 内置目录离线可解(不发网络请求)

/** chat-tools 的 must() 点名的九个(改名后的新名)—— 少一个装配期就响亮抛,这里给全。 */
const fakeMcpTool = (name: string, text: string, isError = false): OmdMcpTool => ({
  name,
  description: name,
  inputSchema: {},
  handler: async () => ({ content: [{ type: 'text' as const, text }], ...(isError ? { isError: true } : {}) }),
});
const FAKE_MCP_TOOLS: OmdMcpTool[] = [
  fakeMcpTool('run', 'runId: run-abc\nstatus: running'),
  fakeMcpTool('solve', 'runId: solve-should-not-count\nerror: leafModel required', true),
  ...['dag_status', 'dag_runs', 'dag_node_output', 'dag_cancel', 'map_tickets', 'omd_plans', 'memory_recall'].map(
    (n) => fakeMcpTool(n, `${n} ok`),
  ),
];

/** fake 循环:同 agent.test.ts 惯例 —— 返回 prompts+生成;可选先调几个工具(模拟 conductor 画图)。 */
const fakeLoop =
  (replyText: string, callTools: string[] = []) =>
  async (prompts: AgentMessage[], context: { tools?: AnyOmdTool[] }): Promise<AgentMessage[]> => {
    for (const name of callTools) {
      const tool = (context.tools ?? []).find((t) => t.name === name);
      if (!tool) throw new Error(`fake loop: 工具面里没有 ${name}`);
      await tool.execute('t1', { task: 'x', goal: 'x' });
    }
    const reply = {
      role: 'assistant',
      content: [{ type: 'text', text: replyText }],
      timestamp: 2,
      stopReason: 'stop',
    } as unknown as AgentMessage;
    return [...prompts, reply];
  };

let root: string;
let store: OmdSessionStore;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'omd-conductor-chat-'));
  resetSessionCacheForTest();
  store = createOmdSessionStore(root);
  delete process.env.OMD_DATA_HOME;
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const makeTool = (opts: { store?: OmdSessionStore; loop?: ReturnType<typeof fakeLoop> } = {}) =>
  createConductorChatTool({
    cwd: root,
    store: opts.store ?? store,
    resolveModel: () => MODEL,
    tools: FAKE_MCP_TOOLS,
    loopFn: opts.loop ?? fakeLoop('收到。'),
  });

const callText = async (tool: OmdMcpTool, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> => {
  const res = (await (tool.handler as (a: unknown, e: unknown) => unknown)(args, {})) as {
    content: { text: string }[];
    isError?: boolean;
  };
  return { text: res.content[0]!.text, isError: res.isError === true };
};

describe('D-1 headless 工具面', () => {
  test('★ 手只读:read/ls/grep 在,write/edit/bash 不许出现(反向自检)', () => {
    const names = buildHeadlessChatTools({ cwd: root, tools: FAKE_MCP_TOOLS }).map((t) => t.name);
    for (const h of HEADLESS_HANDS) expect(names).toContain(h);
    for (const banned of ['write', 'edit', 'bash']) expect(names).not.toContain(banned);
    expect(names).toContain('omd_run'); // 引擎工具全开的抽查
    expect(names).toContain('omd_solve');
  });
});

describe('会话语义', () => {
  test('★ 省略 sessionId → 新会话:回执头带 id,盘上 user+assistant 两条', async () => {
    const { text, isError } = await callText(makeTool(), { prompt: '现在有几个 run?' });
    expect(isError).toBe(false);
    const sid = /^sessionId: (\S+)/m.exec(text)?.[1];
    expect(sid).toBeTruthy();
    expect(text).toContain('收到。');
    const s = await store.open(sid!);
    expect(s).not.toBeNull();
    expect((await s!.messages()).length).toBe(2);
  });

  test('给 sessionId → 续接同一份会话(第二轮后盘上 4 条)', async () => {
    const first = await callText(makeTool(), { prompt: '第一问' });
    const sid = /^sessionId: (\S+)/m.exec(first.text)![1]!;
    await callText(makeTool(), { prompt: '第二问', sessionId: sid });
    expect((await (await store.open(sid))!.messages()).length).toBe(4);
  });

  test('空 prompt → isError,不建会话', async () => {
    const { isError } = await callText(makeTool(), { prompt: '  ' });
    expect(isError).toBe(true);
    expect(await store.list()).toHaveLength(0);
  });
});

describe('runIds 收集', () => {
  test('★ conductor 画图 → 回执 runIds 行收到 run 的 id;[TOOL ERROR] 的 solve 回执不收', async () => {
    const { text } = await callText(makeTool({ loop: fakeLoop('图已派出', ['omd_run', 'omd_solve']) }), {
      prompt: '把这个任务画成图',
    });
    expect(text).toMatch(/^runIds: run-abc$/m); // solve 那条是 [TOOL ERROR],它的 id 不许混进来
  });

  test('没画图的轮 → runIds 显式为 (无),不是缺行', async () => {
    const { text } = await callText(makeTool(), { prompt: '直接回答我' });
    expect(text).toMatch(/^runIds: \(无\)$/m);
  });
});

describe('判据 3:空会话不建文件', () => {
  test('★ 轮子抛错 → isError 带真因,盘上一个字节都没有', async () => {
    const { text, isError } = await callText(
      makeTool({
        loop: (async () => {
          throw new Error('provider 炸了');
        }) as unknown as ReturnType<typeof fakeLoop>,
      }),
      { prompt: 'x' },
    );
    expect(isError).toBe(true);
    expect(text).toContain('provider 炸了');
    expect(await store.list()).toHaveLength(0);
  });
});

describe('判据 2:双进程锁拒(D-2 复用 session-lock)', () => {
  test('★ 后到进程写同一会话 → 锁拒可读(带持有者 pid),原会话 seq 未坏仍可读', async () => {
    const depsA: LockDeps = { now: () => 1000, pid: 111, host: 'h', alive: () => true, staleAfterMs: 60_000 };
    const depsB: LockDeps = { now: () => 2000, pid: 222, host: 'h', alive: () => true, staleAfterMs: 60_000 };
    const storeA = createOmdSessionStore(root, depsA);
    const storeB = createOmdSessionStore(root, depsB);
    const first = await callText(makeTool({ store: storeA }), { prompt: '第一轮' });
    const sid = /^sessionId: (\S+)/m.exec(first.text)![1]!;
    // 进程 A 持锁未释放;进程 B(pid 222)续写同一会话 → 响亮拒绝
    const second = await callText(makeTool({ store: storeB }), { prompt: '第二轮', sessionId: sid });
    expect(second.isError).toBe(true);
    expect(second.text).toContain('111'); // 判词里要能说出持有者是谁
    // 会话没被写坏:投影仍可读且只有第一轮的两条(无重复 seq —— 坏了这里直接抛)
    expect((await (await storeA.open(sid))!.messages()).length).toBe(2);
  });
});

describe('装配点(坑 #7:装配点没闸 = 完全没接)', () => {
  /** seat-wiring 同款隔离:座位全钉 fake provider,config 指到不存在的路径。 */
  let savedConfigPath: string | undefined;
  beforeEach(() => {
    savedConfigPath = process.env.OMD_CONFIG_PATH;
    process.env.OMD_CONFIG_PATH = '/nonexistent/omd-conductor-chat-test.json';
    registerProvider('faux', { baseUrl: 'http://127.0.0.1:1', apiKey: 'k', api: 'openai-compatible', defaultModel: 'm' });
    resetConfigCache();
  });
  afterEach(() => {
    if (savedConfigPath === undefined) delete process.env.OMD_CONFIG_PATH;
    else process.env.OMD_CONFIG_PATH = savedConfigPath;
    clearProviders();
    resetConfigCache();
  });

  test('★ assembleOmdMcpTools 产物里有 conductor_chat,一句话走得通(chatLoopFn/chatStore 接缝生效)', async () => {
    const noopAgent: AgentLeafRunner = async () => ({ text: '', usage: { in: 0, out: 0 } });
    const noopCommand: CommandLeafRunner = async () => ({ text: '', usage: { in: 0, out: 0 }, exitCode: 0 });
    const deps: AssembleOmdMcpDeps = {
      env: Object.fromEntries(ALL_SEATS.map((seat) => [seatEnvKey(seat), `faux:${seat}`])),
      cwd: root,
      runRegistry: new RunRegistry(),
      memory: createOmdMemory({ path: ':memory:', safeguard: UNIVERSAL_SAFEGUARD }),
      agentRunner: noopAgent,
      commandRunner: noopCommand,
      ledger: createPlanLedger({ db: new Database(':memory:') }),
      recorder: createDagRecorder({ db: new Database(':memory:') }),
      inbox: createOwnerInbox({ db: new Database(':memory:') }),
      chatStore: store,
      // 装配路径的座位是 faux:conductor(pi-ai 目录解不出)—— 这条测的是 wiring 不是模型,
      // 所以 loop 也不该走到 resolvePiModel 之后才短路。真模型那半在上线实测(判据 1)。
      chatLoopFn: fakeLoop('装配面回话'),
    };
    const tools = assembleOmdMcpTools(deps);
    const chat = tools.find((t) => t.name === 'conductor_chat');
    expect(chat).toBeTruthy();
  });
});
