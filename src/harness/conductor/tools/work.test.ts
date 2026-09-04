/**
 * src/harness/conductor/tools/work.test —— 2026-09-04 conductor pass:leaf profile /
 * agent card / MCP plumbing.本文件 pinned 以测三个新字段(work + spawn),不再回头测
 * 旧 schema;旧 schema 行为由 orchestrating-loop.test.ts / conductor-prompt.test.ts 钉。
 *
 * 三个真源 (D-25:测试不复刻加载逻辑):
 *   · profiles  ← src/harness/profiles/profile.ts `loadProfiles(cwd)` (内置:design-review)
 *   · templates ← src/harness/agent-templates.ts `loadAgentTemplates({ root: cwd })`
 *                 (内置:code-reviewer, skeptic-verifier, researcher, synthesizer,
 *                  frontend-impl, ui-reviewer, design-review, implementer, spec-author)
 *   · servers   ← src/mcp/client/config.ts `knownMcpServerNames(cwd)`
 *
 * 测试 cwd 准备:`mkdtempSync` 起一个隔离 cwd,把已注册写进 `.omd/mcp.json` →
 * `knownMcpServerNames(cwd)` 真源返 ['filesystem']。profiles / templates 走项目**内置**
 * (builtin 不依赖 cwd),真源照样命中 — `profile: 'design-review'` /
 * `template: 'frontend-impl'` 由 `loadProfiles` / `loadAgentTemplates` 真源识别。
 *
 * 证伪:每条断言都附 `// 证伪:` 行,说明改哪一行 → 哪一条 expect 红。
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parsePlan, mergeMcpAllow, type ConductorPlan } from '../../conductor-plan';
import { renderManual } from '../render-manual';
import { CONDUCTOR_TOOL_NAMES } from './index';
import { createConductorRuntimeTools } from '../../goal/orchestrating-loop';
import type { ConductorCtx } from '../types';
import { loadProfiles } from '../../profiles/profile';
import { loadAgentTemplates } from '../../agent-templates';
import { knownMcpServerNames } from '../../../mcp/client/config';

/** 临时 cwd + .omd/mcp.json(列名 'filesystem');注册表真源由 loadProfiles + loadAgentTemplates +
 * knownMcpServerNames 直接取。 */
function setupCwd(): string {
  const cwd = mkdtempSync(join(tmpdir(), 'omd-leaf-plumbing-'));
  mkdirSync(join(cwd, '.omd'), { recursive: true });
  writeFileSync(
    join(cwd, '.omd', 'mcp.json'),
    JSON.stringify({ mcpServers: { filesystem: { command: 'echo', args: ['ok'] } } }),
  );
  return cwd;
}

/** 真实注册表来自 cwd(已含 .omd/mcp.json) → 钉死真名,反路断言用同一份作「已知名单」。 */
function realRegistries(cwd: string) {
  return {
    profiles: [...loadProfiles(cwd).keys()],
    templates: [...loadAgentTemplates({ root: cwd }).keys()],
    servers: [...knownMcpServerNames(cwd)],
  };
}

/** 装一个 CTX 给测试用:cwd 走隔离 tmp(让 knownMcpServerNames 见到 'filesystem')。 */
function makeCtx(cwd: string): ConductorCtx {
  return {
    cwd,
    writeRoot: cwd,
    allowlist: ['bun'],
    maxFanout: 4,
    seats: { worker: 'w:1', escalation: 'e:1', verify: 'v:1' },
    researchAvailable: false,
    registries: realRegistries(cwd),
  };
}

/** 一个"已收敛"的假子 run 结果 (agent 节点 done + 报告)。镜像 orchestrating-loop.test.ts 的 fakeExec。 */
const fakeExec = (plan: ConductorPlan) =>
  ({
    plan,
    sessionId: 's',
    levels: [Object.keys(plan.nodes)],
    results: Object.fromEntries(
      Object.keys(plan.nodes).map((id) => [
        id,
        { id, status: 'done', kind: 'agent', output: `report of ${id}\nline 2`, deps: plan.nodes[id]?.depends_on ?? [], usage: { in: 1, out: 1 }, filesTouched: ['src/a.ts'] },
      ]),
    ),
    usage: { conductor: { in: 0, out: 0 }, leavesIn: 1, leavesOut: 1, leavesCacheHit: 0 },
    reusedNodes: [],
    observations: [],
  }) as never;

/** 装一副工具面,派一张卡,断言 runChild 收到的 plan + tool result text。
 * compile 拒时 calls 空 → plan/seq 为 null(分两类结果便于看 caller 判)。 */
async function dispatch(
  ctx: ConductorCtx,
  toolName: 'work' | 'spawn',
  raw: Record<string, unknown>,
): Promise<{
  plan: ConductorPlan | null;
  seq: number | null;
  text: string;
  ok: boolean;
  details: { ok: boolean; seq: number };
}> {
  const calls: { plan: ConductorPlan; seq: number }[] = [];
  const tools = createConductorRuntimeTools({
    ctx,
    runChild: async (plan, seq) => {
      calls.push({ plan, seq });
      return fakeExec(plan);
    },
  });
  const tool = tools.find((t) => t.name === toolName)!;
  const res = (await tool.execute('t1', raw)) as {
    content: { text: string }[];
    details: { ok: boolean; seq: number };
  };
  const sent = calls[0];
  return {
    plan: sent?.plan ?? null,
    seq: sent?.seq ?? null,
    text: res.content[0]!.text,
    ok: res.details.ok,
    details: res.details,
  };
}

const BRIEF_40 = 'repro: bun test src/harness/conductor/tools/work.test.ts → 0 pass / N fail. scope: only this file.';

describe('work — leaf plumbing (2026-09-04): profile / template / mcp', () => {
  test('正路:带已知 profile + template + mcp → 节点三字段透传,过 mergeMcpAllow 后 mcp 列表含已注册 server', async () => {
    const cwd = setupCwd();
    const reg = realRegistries(cwd);
    expect(reg.profiles).toContain('design-review');
    expect(reg.templates).toContain('frontend-impl');
    expect(reg.servers).toContain('filesystem');
    const ctx = makeCtx(cwd);
    const out = await dispatch(ctx, 'work', {
      goal: 'one bounded',
      brief: BRIEF_40,
      profile: 'design-review',
      template: 'frontend-impl',
      mcp: ['filesystem'],
    });
    expect(out.ok).toBe(true);
    const node = Object.values(out.plan!.nodes)[0]!;
    expect(node).toMatchObject({
      executor: 'agent',
      profile: 'design-review',
      template: 'frontend-impl',
    });
    expect(node.mcp).toEqual(['filesystem']);
    // mergeMcpAllow 真源 (conductor-plan.ts:529) 走 node.mcp + 模板 tpl.mcp。tpl 缺席 (未传模板
    // 卡片) → 只看 node.mcp。验证 conductor 视角的 MCP 允许白名单含 'filesystem'。
    const allow = mergeMcpAllow({ mcp: node.mcp as string[] | undefined }, undefined);
    expect(allow).toContain('filesystem');
    // parsePlan 仍过 → 节点字段没踩 D-5 格式闸。
    const re = parsePlan(JSON.stringify(out.plan), { knownServers: new Set(['filesystem']) });
    expect(re.ok).toBe(true);
    // 证伪: 把 profile spread 删 → node.profile 缺失 → toMatchObject 红。
    // 证伪: 把 mcp spread 删 → node.mcp 缺失 → expect(node.mcp).toEqual 红。
    // 证伪: 把 mergeMcpAllow 改成只读模板 (忽略 node.mcp) → allow 不含 'filesystem' → 红。
  });

  test('反路:未知 profile 名 → compile ok:false,拒因含已知名单中的 design-review,runChild 零调用', async () => {
    const cwd = setupCwd();
    const ctx = makeCtx(cwd);
    const calls: ConductorPlan[] = [];
    const tools = createConductorRuntimeTools({
      ctx,
      runChild: async (p) => { calls.push(p); return fakeExec(p); },
    });
    const work = tools.find((t) => t.name === 'work')!;
    const res = (await work.execute('t1', {
      goal: 'one bounded',
      brief: BRIEF_40,
      profile: 'no-such-profile',
    })) as { content: { text: string }[]; details: { ok: boolean } };
    expect(res.details.ok).toBe(false);
    // 拒因必须给出真源名单中的第一个 profile 名 → conductor 调试时直接知道「我有谁」。
    expect(res.content[0]!.text).toContain('design-review');
    // zod 过 (profile 是 string),所以拒因走 compile 路径,首行应含 manual 标题。
    expect(res.content[0]!.text.startsWith(renderManual('work').split('\n')[0]!)).toBe(true);
    expect(calls).toHaveLength(0);
    // 证伪: 删掉 compile 顶层的 reg.profile 检查 → ok:true → 上面两条 expect 红。
    // 证伪: 把拒因里的 realRegistries 替换成硬编码 ['fake'] → 'design-review' 不出现 → 第一条 expect 红。
  });

  test('反路:未知 template 名 → 拒因含已知名单中的 frontend-impl', async () => {
    const cwd = setupCwd();
    const ctx = makeCtx(cwd);
    const res = await dispatch(ctx, 'work', {
      goal: 'one bounded',
      brief: BRIEF_40,
      template: 'bogus-card',
    });
    expect(res.ok).toBe(false);
    expect(res.text).toContain('frontend-impl');
    // 证伪: 删 reg.templates 检查 → ok:true,text 不含 'frontend-impl' → 红。
  });

  test('反路:未知 MCP server 名 → 拒因含已知名单中的 filesystem', async () => {
    const cwd = setupCwd();
    const ctx = makeCtx(cwd);
    const res = await dispatch(ctx, 'work', {
      goal: 'one bounded',
      brief: BRIEF_40,
      mcp: ['no-such-server'],
    });
    expect(res.ok).toBe(false);
    expect(res.text).toContain('filesystem');
    // 证伪: 删 mcp server 检查 → ok:true → 红。
  });

  test('兜底:旧调用(不带新字段)→ 节点 profile/template/mcp 字段缺席(不写空 / 不写 undefined)', async () => {
    const cwd = setupCwd();
    const ctx = makeCtx(cwd);
    const out = await dispatch(ctx, 'work', { goal: 'classic', brief: BRIEF_40 });
    expect(out.ok).toBe(true);
    const node = Object.values(out.plan!.nodes)[0]!;
    expect('profile' in node).toBe(false);
    expect('template' in node).toBe(false);
    expect('mcp' in node).toBe(false);
    // 证伪: 把 `...(params.profile ? { profile: params.profile } : {})` 改成无条件 spread →
    //       `profile: undefined` 写入,`'profile' in node` 变 true → 红。
  });

  test('不传 ctx.registries(旧接缝路径)→ 三字段透传不报(逐字节兼容,旧 compile 不读盘)', async () => {
    const cwd = setupCwd();
    const ctx: ConductorCtx = {
      cwd,
      writeRoot: cwd,
      allowlist: ['bun'],
      maxFanout: 4,
      seats: { worker: 'w:1', escalation: 'e:1', verify: 'v:1' },
      researchAvailable: false,
      // registries 故意缺席。
    };
    const out = await dispatch(ctx, 'work', {
      goal: 'legacy',
      brief: BRIEF_40,
      profile: 'design-review',
      template: 'frontend-impl',
      mcp: ['filesystem'],
    });
    expect(out.ok).toBe(true);
    const node = Object.values(out.plan!.nodes)[0]!;
    expect(node.profile).toBe('design-review');
    expect(node.template).toBe('frontend-impl');
    expect(node.mcp).toEqual(['filesystem']);
    // 证伪: 把 compile 顶层的 reg null 检查改 always-reject → ok:false → 红。
  });
});

describe('spawn — leaf plumbing (2026-09-04): task.profile / task.template / task.mcp', () => {
  test('正路:tasks 中一个带三字段 → runChild 收到该 task 节点透传三字段', async () => {
    const cwd = setupCwd();
    const ctx = makeCtx(cwd);
    const out = await dispatch(ctx, 'spawn', {
      tasks: [
        { goal: 'task a', brief: BRIEF_40, write_set: ['src/a.ts'], profile: 'design-review', template: 'frontend-impl', mcp: ['filesystem'] },
        { goal: 'task b', brief: BRIEF_40, write_set: ['src/b.ts'] },
      ],
    });
    expect(out.ok).toBe(true);
    expect(out.plan).not.toBeNull();
    const nodes = out.plan!.nodes;
    // adaptCard 在 runChild 之前过 prefixPlanIds → 节点 id 是 `d1.task-1` / `d1.task-2`。
    const t1 = nodes['d1.task-1']!;
    expect(t1.profile).toBe('design-review');
    expect(t1.template).toBe('frontend-impl');
    expect(t1.mcp).toEqual(['filesystem']);
    // d1.task-2 不带三字段 → 字段缺席。
    const t2 = nodes['d1.task-2']!;
    expect('profile' in t2).toBe(false);
    expect('template' in t2).toBe(false);
    expect('mcp' in t2).toBe(false);
    // 证伪: 把 spread 三行删 → t1 上三字段全部缺失 → 三条 expect 红。
  });

  test('反路:task 带未知 template 名 → compile ok:false,拒因含已知名单中的 frontend-impl,runChild 零调用', async () => {
    const cwd = setupCwd();
    const ctx = makeCtx(cwd);
    const calls: ConductorPlan[] = [];
    const tools = createConductorRuntimeTools({
      ctx,
      runChild: async (p) => { calls.push(p); return fakeExec(p); },
    });
    const spawn = tools.find((t) => t.name === 'spawn')!;
    const res = (await spawn.execute('t1', {
      tasks: [
        { goal: 'a', brief: BRIEF_40, template: 'bogus-card' },
        { goal: 'b', brief: BRIEF_40 },
      ],
    })) as { content: { text: string }[]; details: { ok: boolean } };
    expect(res.details.ok).toBe(false);
    expect(res.content[0]!.text).toContain('frontend-impl');
    expect(res.content[0]!.text.startsWith(renderManual('spawn').split('\n')[0]!)).toBe(true);
    expect(calls).toHaveLength(0);
    // 证伪: 把 for 循环里的 checkTaskRegistries 删 → ok:true,文字不含 frontend-impl → 红。
  });

  test('反路:task 带未知 profile 名 → 拒因含 design-review', async () => {
    const cwd = setupCwd();
    const ctx = makeCtx(cwd);
    const res = await dispatch(ctx, 'spawn', {
      tasks: [
        { goal: 'a', brief: BRIEF_40, profile: 'no-such' },
        { goal: 'b', brief: BRIEF_40 },
      ],
    });
    expect(res.ok).toBe(false);
    expect(res.text).toContain('design-review');
    // 证伪: 同上。
  });

  test('兜底:tasks 都不带新字段 → 各 task 节点 profile/template/mcp 字段全部缺席', async () => {
    const cwd = setupCwd();
    const ctx = makeCtx(cwd);
    const out = await dispatch(ctx, 'spawn', {
      tasks: [
        { goal: 'a', brief: BRIEF_40 },
        { goal: 'b', brief: BRIEF_40 },
      ],
    });
    expect(out.ok).toBe(true);
    expect(out.plan).not.toBeNull();
    for (const id of ['d1.task-1', 'd1.task-2']) {
      const n = out.plan!.nodes[id]!;
      expect('profile' in n).toBe(false);
      expect('template' in n).toBe(false);
      expect('mcp' in n).toBe(false);
    }
    // 证伪: 把 spread 改成无条件 → 字段出现为 undefined → `in` 变 true → 红。
  });
});

describe('conductor tools 接线 (D-2): 七张卡仍未被拆分', () => {
  test('CONDUCTOR_TOOL_NAMES 含 work + spawn 共 7 张卡', () => {
    expect(CONDUCTOR_TOOL_NAMES).toContain('work');
    expect(CONDUCTOR_TOOL_NAMES).toContain('spawn');
    expect(CONDUCTOR_TOOL_NAMES).toHaveLength(7);
    // 证伪: 从 CONDUCTOR_TOOL_NAMES 删 'work' → 第一个 expect 红;加新卡 → length 红。
  });

  test('createConductorRuntimeTools 全部 customTools = CONDUCTOR_TOOL_NAMES', async () => {
    const cwd = setupCwd();
    const ctx = makeCtx(cwd);
    const tools = createConductorRuntimeTools({ ctx, runChild: async (p) => fakeExec(p) });
    expect(tools.map((t) => t.name).sort()).toEqual([...CONDUCTOR_TOOL_NAMES].sort());
    // 证伪: createConductorTools 漏装任一卡 → toEqual 红。
  });
});
