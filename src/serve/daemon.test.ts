/**
 * daemon fetch handler 契约测试(不绑端口;读侧走 fixture 磁盘契约,命令面走假工具,
 * chat 走 loopFn 假循环)。反向自检:非法 id → 400、未知工具 → 404、坏 body → 400 都有负例。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { PlanLedger } from '../harness/plan/plan-ledger';
import { type OmdSessionStore, createOmdSessionStore, resetSessionCacheForTest } from '../harness/chat/session-store';
import { createDaemonFetch } from './daemon';

const RUN = '11111111-2222-3333-4444-555555555555';
let root: string;
let fetchFn: (req: Request) => Promise<Response>;
let store: OmdSessionStore;

const fakeLedger: PlanLedger = {
  record: () => null,
  families: () => [
    { id: 'f1', canonicalTask: '测任务', runs: 3, okRuns: 2, retired: false, versions: 1, createdAt: '2026-08-01' },
  ],
  plans: (familyId) => (familyId === 'f1' ? [{ id: 'p1', familyId: 'f1', version: 1, parentId: null, verified: true, runs: 3, okRuns: 2, totalCostUsd: 0.5, generation: null, createdAt: '2026-08-01' }] : []),
  planJson: (planId) => (planId === 'p1' ? '{"name":"p","nodes":{}}' : null),
  rebuild: () => 0,
  close: () => {},
};

/** 命令面假工具:echo 回显 args;rerun_probe 记录被桥调到的参数。 */
const bridged: Record<string, unknown>[] = [];
const fakeTools = [
  {
    name: 'echo',
    description: 'echo args back',
    inputSchema: { text: z.string() },
    handler: (args: { text?: string }) => ({ content: [{ type: 'text', text: `echo:${args.text}` }] }),
  },
  {
    name: 'dag_run_plan',
    description: 'probe',
    inputSchema: { plan: z.string() },
    handler: (args: Record<string, unknown>) => {
      bridged.push(args);
      return { content: [{ type: 'text', text: 'runId: fake-rerun\nstatus: running' }] };
    },
  },
] as unknown as Parameters<typeof createDaemonFetch>[0]['tools'];

const fakeLoop = async (prompts: AgentMessage[]): Promise<AgentMessage[]> => [
  ...prompts,
  { role: 'assistant', content: [{ type: 'text', text: '收到' }], timestamp: 2, stopReason: 'stop' } as unknown as AgentMessage,
];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'omd-serve-'));
  delete process.env.OMD_DATA_HOME;
  // fixture: 一个 run 的磁盘契约 (a done + out 文本; b 无 checkpoint = 未 settle)
  const dir = join(root, '.omd', 'continuity', RUN);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, '_dag.json'),
    JSON.stringify({
      runId: RUN, goal: '测试目标', createdAt: '2026-08-05T00:00:00Z',
      nodeIds: ['a', 'b'], deps: { a: [], b: ['a'] },
      plan: { name: 'fixture-plan', nodes: { a: { executor: 'command' }, b: { executor: 'agent' } } },
    }),
  );
  writeFileSync(join(dir, 'a.json'), JSON.stringify({ nodeId: 'a', leafKind: 'command', status: 'done', summary: 'ok', durationMs: 5 }));
  writeFileSync(join(dir, 'out-a.txt'), 'hello from a');
  resetSessionCacheForTest(); // 单写者表是模块级的 —— 不清会把上一条临时目录的实例带进来
  store = createOmdSessionStore(root);
  bridged.length = 0;
  fetchFn = createDaemonFetch({
    cwd: root,
    tools: fakeTools,
    chatStore: store,
    ledger: fakeLedger,
    resolveChatModel: () => 'deepseek:deepseek-v4-flash',
    chatTools: [],
    chatLoopFn: fakeLoop,
  });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const get = (path: string) => fetchFn(new Request(`http://x${path}`));
const post = (path: string, body: unknown) =>
  fetchFn(new Request(`http://x${path}`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }));

describe('读侧 (纯磁盘契约)', () => {
  test('health / runs 列表 (settled 数出自 checkpoint 文件)', async () => {
    expect((await (await get('/api/health')).json() as { ok: boolean }).ok).toBe(true);
    const runs = (await (await get('/api/runs')).json()) as { runId: string; settled: number; nodeCount: number }[];
    expect(runs.length).toBe(1);
    expect(runs[0]).toMatchObject({ runId: RUN, settled: 1, nodeCount: 2, goal: '测试目标' });
  });

  test('★ run 详情: checkpoint 覆盖 + hasOutput + 未 settle 节点 null', async () => {
    const d = (await (await get(`/api/runs/${RUN}`)).json()) as {
      nodes: { id: string; checkpoint: { status: string } | null; hasOutput: boolean; deps: string[] }[];
    };
    const a = d.nodes.find((n) => n.id === 'a')!;
    const b = d.nodes.find((n) => n.id === 'b')!;
    expect(a.checkpoint?.status).toBe('done');
    expect(a.hasOutput).toBe(true);
    expect(b.checkpoint).toBeNull();
    expect(b.deps).toEqual(['a']);
  });

  test('节点输出全文;缺席 404;非法 id 400 (白名单闸)', async () => {
    expect(await (await get(`/api/runs/${RUN}/nodes/a`)).text()).toBe('hello from a');
    expect((await get(`/api/runs/${RUN}/nodes/b`)).status).toBe(404);
    // 裸 `..` 被 URL 解析器归一化, 到不了路由 (404 也安全); 真正打到白名单闸的是非法字符与内嵌 `..`:
    expect((await get('/api/runs/x!y')).status).toBe(400);
    expect((await get(`/api/runs/${RUN}/nodes/a..b`)).status).toBe(400);
  });

  test('plans 图库: families / 版本链 / planJson;未知 planId 404', async () => {
    const fams = (await (await get('/api/plans')).json()) as { id: string }[];
    expect(fams[0]!.id).toBe('f1');
    const versions = (await (await get('/api/plans/f1')).json()) as { id: string }[];
    expect(versions[0]!.id).toBe('p1');
    expect((await get('/api/plans/version/nope')).status).toBe(404);
  });

  test('maps: 无 pathfinder 目录 → 空列表不是错误', async () => {
    expect(await (await get('/api/maps')).json()).toEqual([]);
  });
});

describe('命令面 (装配层桥)', () => {
  test('/board: 200 html, 六列齐全, 且**不被 SPA 回落吃掉**', async () => {
    const r = await fetchFn(new Request('http://x/board'));
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('text/html');
    const html = await r.text();
    // 列序 = 票的生命周期。少一列 = 有一种状态的票在板上永远看不见 (静默漏掉一整格)。
    for (const label of ['待 owner 决断', '机器建议待确认', '前沿可动', '前置未散', '已裁决', '已交付']) {
      expect(html).toContain(label);
    }
  });

  test('★ /board 零写回: 页面脚本里一个写方法都没有 (纪律③ 的闸)', async () => {
    // 看板一旦能写就有两份真相 (真相文件是 docs/plan/pathfinder/*.md)。这条闸钉的是
    // **投影只读**这件事本身, 不是某一处代码长什么样。
    // 证伪: 在 board-page.ts 的 SCRIPT 里加一个 method:'POST' 的 fetch → 当场红。
    const html = await (await fetchFn(new Request('http://x/board'))).text();
    for (const w of ['POST', 'PUT', 'DELETE', 'PATCH']) expect(html).not.toContain(w);
  });

  test('/board 只认 GET: POST 落 404, 不被当成页面请求静默返 200', async () => {
    const r = await fetchFn(new Request('http://x/board', { method: 'POST' }));
    expect(r.status).toBe(404);
  });

  test('★ POST /api/tools/:name 直调 handler;未知工具 404', async () => {
    const r = (await (await post('/api/tools/echo', { text: 'hi' })).json()) as { content: { text: string }[] };
    expect(r.content[0]!.text).toBe('echo:hi');
    expect((await post('/api/tools/ghost', {})).status).toBe(404);
  });

  test('★ 复跑: planJson 经桥进 dag_run_plan (同一控制面, 零复制)', async () => {
    const r = (await (await post('/api/plans/version/p1/rerun', { leafModel: 'x:y' })).json()) as {
      content: { text: string }[];
    };
    expect(r.content[0]!.text).toContain('runId:');
    expect(bridged[0]).toMatchObject({ plan: '{"name":"p","nodes":{}}', leafModel: 'x:y' });
  });
});

describe('chat (SSE)', () => {
  test('★ 一轮对话: SSE 有 result 帧, 会话写入磁盘', async () => {
    const res = await post('/api/chat/web1/messages', { message: '你好' });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const body = await res.text();
    expect(body).toContain('event: result');
    expect(body).toContain('收到');
    expect((await (await store.open('web1'))?.messages())?.length).toBe(2);
  });

  test('空 message → 400;会话列表/详情/删除', async () => {
    expect((await post('/api/chat/web1/messages', {})).status).toBe(400);
    // ⚠ 必须**把 SSE 读完**再问列表:响应一发就返回, 轮子还在流里跑。
    //   此前不读也过, 是因为老 store 是同步写、恰好在下一个 await 之前写完了 —— 那是碰运气。
    await (await post('/api/chat/web1/messages', { message: 'hi' })).text();
    const list = (await (await get('/api/chat')).json()) as { id: string }[];
    expect(list.map((s) => s.id)).toEqual(['web1']);
    expect((await get('/api/chat/web1')).status).toBe(200);
    const del = await fetchFn(new Request('http://x/api/chat/web1', { method: 'DELETE' }));
    expect(del.status).toBe(200);
    expect((await get('/api/chat/web1')).status).toBe(404);
  });
});
