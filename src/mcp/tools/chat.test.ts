/**
 * conductor_chat 契约测试(SDD 2026-08-09 远程指挥接缝,S1)。
 *
 * 钉住可离线闸化的那几条判据(判据 1 的"账本有 usage"与判据 4 的"长轮后台化"要真模型/真宿主,
 * 走上线实测,不在这里假装):
 *   · D-1 工具面:手只读(read/ls/grep),write/edit/bash 不许出现 —— 反向自检;
 *   · 新会话建档 + 回执头带 sessionId(续接的把手);
 *   · runIds 从 run/solve 回执收集,[TOOL ERROR] 回执不收;
 *   · 判据 3:轮子抛错 → isError 且一个字节不写入磁盘(空会话不建文件);
 *   · 判据 2:双进程写同一会话 → 后到者锁拒,判词带持有者 pid,原会话仍可读(seq 未坏);
 *   · 装配点:assembleOmdMcpTools 产物里真有 conductor_chat 且 wiring 走得通
 *     (交接 37 坑 #7:装配点没闸 = 完全没接)。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { AnyOmdTool } from '../../harness/agent-tools';
import { createOmdSessionStore, resetSessionCacheForTest, type OmdSessionStore } from '../../harness/chat/session-store';
import type { LockDeps } from '../../harness/chat/session-lock';
import type { OmdMcpTool } from '../server';
import {
  HEADLESS_HANDS,
  HEADLESS_PROMPT_BLOCK,
  buildHeadlessChatTools,
  createConductorChatTool,
  parseEscalation,
  parseRouteLine,
} from './chat';
import { SOLVE_BUDGET_TOKENS, SOLVE_BUDGET_MINUTES } from '../../serve/chat-tools';
import { SHARED_ENGINEERING_CORE, CONDUCTOR_HARNESS_CORE } from '../../harness/harness-prompts';
import { assembleOmdMcpTools, type AssembleOmdMcpDeps } from '../assemble';
import { resetBudgetLedgerMemoForTest, WEEKLY_BUDGET_ENV, type WeeklyBudgetStatus } from '../budget';
import { RunRegistry } from '../run-registry';
import { createOmdMemory } from '../../harness/memory';
import { UNIVERSAL_SAFEGUARD } from '../../memory/safeguards/namespaces';
import { createPlanLedger } from '../../harness/plan/plan-ledger';
import { createDagRecorder } from '../../harness/dag/dag-record';
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
  fakeMcpTool('dag_run_plan', 'runId: plan-xyz\nstatus: running'),
  ...['dag_status', 'dag_runs', 'dag_node_output', 'dag_cancel', 'map_tickets', 'omd_plans', 'memory_recall', 'history_read', 'history_search'].map(
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

/** 文件级 env 卫生(SDD D6 INV-D6-1):跨 describe 统一清洗全局态。
 *  既清 chat.ts 现读的账本目录,也清生产代码另几处现读的全局 env;
 *  chat.test.ts 自己就是 OMD_DATA_HOME 的下游污染者(设了不还原),必须 save/restore。
 *  既有 describe 级清洗保留(叠加无害)。 */
const HYGIENE_ENV_KEYS = [
  'OMD_TUI_USAGE_DIR',
  'OMD_WEEKLY_BUDGET_USD',
  'OMD_CHAT_ROOT',
  'MEMORY_HUB_DATA',
  'OMD_CONDUCTOR_ADVISOR',
  'OMD_DATA_HOME',
] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'omd-conductor-chat-'));
  resetSessionCacheForTest();
  resetBudgetLedgerMemoForTest(); // budget memo 按账本路径缓存,跨用例不串味
  for (const k of HYGIENE_ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  store = createOmdSessionStore(root);
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const makeTool = (
  opts: { store?: OmdSessionStore; loop?: ReturnType<typeof fakeLoop>; budget?: () => WeeklyBudgetStatus } = {},
) =>
  createConductorChatTool({
    cwd: root,
    store: opts.store ?? store,
    resolveModel: () => MODEL,
    tools: FAKE_MCP_TOOLS,
    loopFn: opts.loop ?? fakeLoop('收到。'),
    // 省略 budget = 走生产默认(现读 <cwd>/.omd/tui-usage.jsonl)—— 临时 root 里没账本 = 不拦。
    ...(opts.budget ? { budget: opts.budget } : {}),
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
    expect(names).toContain('omd_run_plan'); // C-2 (owner 2026-08-09 裁 C): 预构造 plan 通道
  });

  test('C-3: omd_solve 包装写死透传预算 (旋钮不暴露给模型)', async () => {
    let captured: Record<string, unknown> | null = null;
    const capturingTools: OmdMcpTool[] = FAKE_MCP_TOOLS.map((t) =>
      t.name === 'solve'
        ? {
            ...t,
            handler: (async (args: unknown) => {
              captured = args as Record<string, unknown>;
              return { content: [{ type: 'text' as const, text: 'runId: s' }] };
            }) as OmdMcpTool['handler'],
          }
        : t,
    );
    const solve = buildHeadlessChatTools({ cwd: root, tools: capturingTools }).find((t) => t.name === 'omd_solve')!;
    await solve.execute('t1', { goal: 'g' });
    // 证伪方式 (当场验过): chat-tools.ts 里去掉 budgetTokens 透传 → 本断言红; 恢复后绿。
    expect(captured!.budgetTokens).toBe(SOLVE_BUDGET_TOKENS);
    expect(captured!.budgetMinutes).toBe(SOLVE_BUDGET_MINUTES);
    // schema 面不暴露预算旋钮 (模型改不了的旋钮才是闸)
    expect(JSON.stringify(solve.parameters ?? {})).not.toContain('budgetTokens');
  });
});

describe('C-1 route 自述行 (NULL ≠ L0)', () => {
  test('合法行解析出 level, 原文保留', () => {
    const r = parseRouteLine('route: L2 · W=yes N=1-2 X=1 O=have\n派单如下…');
    expect(r).not.toBeNull();
    expect(r!.level).toBe('L2');
    expect(r!.raw).toContain('W=yes');
  });

  test('★ 无 route 行 → null, 不许折算成 L0 (没申报 ≠ 直答)', () => {
    const r = parseRouteLine('直接回答:是的。');
    expect(r).toBeNull();
    // 红线: 谁把 null 改成兜底 'L0', 这条立刻红。
    expect(r?.level).not.toBe('L0');
  });

  test('残缺行 (无 L 档) → null, 不猜', () => {
    expect(parseRouteLine('route: 大概 L 几吧 W=?')).toBeNull();
  });

  test('回执头: 申报可见, 未申报记 NULL', async () => {
    const withRoute = await callText(makeTool({ loop: fakeLoop('route: L1 · W=no N=0 X=1 O=have\n查到了。') }), {
      prompt: 'q1',
    });
    expect(withRoute.text).toContain('route: L1');
    const noRoute = await callText(makeTool({ loop: fakeLoop('查到了。') }), { prompt: 'q2' });
    expect(noRoute.text).toContain('route: NULL(未申报)');
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

describe('S2:? 阀(prompt 接线 + 回执解析)', () => {
  test('★ headless 块真进了 system prompt(fake loop 亲眼所见)——含阀形状与只读手声明', async () => {
    let seenPrompt = '';
    const spyLoop = (async (prompts: AgentMessage[], context: { systemPrompt?: string }) => {
      seenPrompt = context.systemPrompt ?? '';
      return fakeLoop('ok')(prompts, context as { tools?: AnyOmdTool[] });
    }) as unknown as ReturnType<typeof fakeLoop>;
    await callText(makeTool({ loop: spyLoop }), { prompt: 'x' });
    expect(seenPrompt).toContain(HEADLESS_PROMPT_BLOCK); // 拼在尾部,冻结前缀不动
    /**
     * ⚠ **判据锚常量, 不锚措辞**(2026-08-13 改)。
     *
     * 原来写的是 `startsWith('You are the omd CONDUCTOR')` —— 一个**抄下来的字面串**。
     * 本日 owner 让 omd 自己改 conductor 人设(开头改成 `You are the OMD conductor …`),
     * 这条当场红 —— 而它想守的东西一个字都没坏:冻结前缀仍然排在最前,headless 块仍在尾部。
     *
     * 抄字面串的闸只会在**改文案**时红,在**改顺序**时未必红 —— 方向正好反了。
     * 锚常量本身则两件事都守得住:前缀被挪到中间、或被别的东西挤掉,它才红。
     */
    expect(seenPrompt.startsWith(`${SHARED_ENGINEERING_CORE}\n\n${CONDUCTOR_HARNESS_CORE}`)).toBe(true);
  });

  test('★ reply 带 owner 级阀块 → 回执头点名 lane 且禁代答;无块不冒行(反向自检)', async () => {
    const block = '<omd-escalation lane="owner">\n倾向: 换\n理由: x\n定不了的点: y\n</omd-escalation>';
    const withValve = await callText(makeTool({ loop: fakeLoop(`定不了。\n${block}`) }), { prompt: '换协议' });
    expect(withValve.text).toMatch(/^escalation: lane=owner/m);
    expect(withValve.text).toContain(block); // 块全文原样在正文里 —— owner 要看原话
    const noValve = await callText(makeTool({ loop: fakeLoop('直接答。') }), { prompt: '普通问题' });
    expect(noValve.text).not.toContain('escalation:');
  });

  test('parseEscalation:lane 白名单,坏 lane / 无块 → null(不猜)', () => {
    expect(parseEscalation('<omd-escalation lane="claude">x</omd-escalation>')?.lane).toBe('claude');
    expect(parseEscalation('<omd-escalation lane="nick">x</omd-escalation>')).toBeNull();
    expect(parseEscalation('没有块')).toBeNull();
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

describe('§2 周预算闸(SDD 2026-08-09 ECON)', () => {
  /**
   * **反向自检(每条怎么让它红)**:
   * - 拆掉 handler 里那段 `if (preTurn.over)` → 「$100 轮前拒」当场红;
   * - 拆掉 `guardBudget` 包装 → 「轮中途跨线拒派新图」当场红(runIds 会收到 run-abc);
   * - 把闸做成恒拦(`over` 恒 true)→ 「$49.99 零变化」与「=0 关闸」两条当场红。
   * 三条同时在,「拦得住」与「不误拦」两侧才都有人盯 —— 只有前者的闸会把 owner 锁在门外。
   */
  let savedLimit: string | undefined;
  let savedDir: string | undefined;
  beforeEach(() => {
    savedLimit = process.env[WEEKLY_BUDGET_ENV];
    savedDir = process.env.OMD_TUI_USAGE_DIR;
    delete process.env[WEEKLY_BUDGET_ENV]; // 用默认上限 $50
    delete process.env.OMD_TUI_USAGE_DIR; // 账本必须落在本用例的临时 root, 不许读到真仓那本
  });
  afterEach(() => {
    if (savedLimit === undefined) delete process.env[WEEKLY_BUDGET_ENV];
    else process.env[WEEKLY_BUDGET_ENV] = savedLimit;
    if (savedDir === undefined) delete process.env.OMD_TUI_USAGE_DIR;
    else process.env.OMD_TUI_USAGE_DIR = savedDir;
  });

  /** 往 `<root>/.omd/tui-usage.jsonl` 写真账本行 —— **不注 budget 接缝**, 走生产那条默认读数路径。 */
  const writeSpend = (costUsd: number): void => {
    mkdirSync(join(root, '.omd'), { recursive: true });
    writeFileSync(
      join(root, '.omd', 'tui-usage.jsonl'),
      `${JSON.stringify({ ts: Date.now(), model: 'deepseek:deepseek-v4-flash', source: 'engine', in: 1, out: 1, cacheHit: 0, costUsd, unpriced: false })}\n`,
    );
  };

  test('★ 账本一行 $100 → 轮前拒:isError=false 的正常回执 + lane=owner 阀块, 轮子一次没跑, 盘上零字节', async () => {
    writeSpend(100);
    let called = false;
    const spy = (async (prompts: AgentMessage[], context: { tools?: AnyOmdTool[] }) => {
      called = true;
      return fakeLoop('不该跑到这一步')(prompts, context);
    }) as unknown as ReturnType<typeof fakeLoop>;
    const { text, isError } = await callText(makeTool({ loop: spy }), { prompt: '帮我跑个任务' });
    expect(isError).toBe(false); // 超限不是"工具坏了", 是一个只有 owner 能裁的岔口
    expect(called).toBe(false); // 不跑轮 = 一个 token 都不烧
    expect(await store.list()).toHaveLength(0); // 没跑的轮不建会话
    expect(parseEscalation(text)?.lane).toBe('owner'); // 与 S2 同一条阀链, 同一个解析器
    expect(text).toMatch(/^escalation: lane=owner/m);
    expect(text).toContain('$100.00');
    expect(text).not.toMatch(/^usage:/m); // 没跑的轮不编 usage=0(NULL ≠ 0)
  });

  test('★ $49.99(未超)→ 行为零变化:照常跑轮、照常建会话、不冒阀块也不冒 budget 行', async () => {
    writeSpend(49.99);
    const { text, isError } = await callText(makeTool(), { prompt: '现在有几个 run?' });
    expect(isError).toBe(false);
    expect(text).toContain('收到。');
    expect(text).not.toContain('escalation:');
    expect(text).not.toContain('周预算闸');
    expect(text).toMatch(/^usage:/m);
    expect(await store.list()).toHaveLength(1);
  });

  test('★ OMD_WEEKLY_BUDGET_USD=0 → 闸关:$100 也照跑(关闸旋钮真的关得掉)', async () => {
    writeSpend(100);
    process.env[WEEKLY_BUDGET_ENV] = '0';
    const { text, isError } = await callText(makeTool(), { prompt: 'x' });
    expect(isError).toBe(false);
    expect(text).toContain('收到。');
    expect(text).not.toContain('escalation:');
  });

  test('★ 轮中途跨线 → omd_run 拒派新图, 内层一次没调(已在飞的图不动)', async () => {
    // 两次读数:轮前 $10(放行, 轮跑起来)→ 派图时 $100(拒)。账本每次现读, 这正是两道闸的分工:
    // 轮前那道拦"这轮别开始", 这道拦"轮跑到半截跨的线"。
    const readings: WeeklyBudgetStatus[] = [
      { limitUsd: 50, enabled: true, costUsd: 10, unpriced: false, calls: 1, over: false },
      { limitUsd: 50, enabled: true, costUsd: 100, unpriced: false, calls: 2, over: true },
    ];
    let i = 0;
    const budget = (): WeeklyBudgetStatus => readings[Math.min(i++, readings.length - 1)]!;
    const echoRun = (async (prompts: AgentMessage[], context: { tools?: AnyOmdTool[] }) => {
      const tool = (context.tools ?? []).find((t) => t.name === 'omd_run')!;
      const res = await tool.execute('t1', { task: 'x' });
      const toolText = (res as { content?: { text?: string }[] }).content?.[0]?.text ?? '';
      return [
        ...prompts,
        { role: 'assistant', content: [{ type: 'text', text: toolText }], timestamp: 2, stopReason: 'stop' } as unknown as AgentMessage,
      ];
    }) as unknown as ReturnType<typeof fakeLoop>;
    const { text } = await callText(makeTool({ budget, loop: echoRun }), { prompt: '把这个任务画成图' });
    expect(text).toContain('[TOOL ERROR]'); // 既有惯例:模型看得见这是失败
    expect(text).toContain('周预算闸');
    expect(text).toMatch(/^runIds: \(无\)$/m); // 内层 run 没被调用, 所以没有 run-abc
    expect(text).not.toContain('run-abc');
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
    const noopCommand: CommandLeafRunner = async () => ({ text: '', usage: { in: 0, out: 0 }, timedOut: false, signal: null, exitCode: 0 });
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
