import { describe, expect, test } from 'bun:test';
import { runExecutorDag, runExecutorDagWithPlan, topoLevels, type GenerateFn } from '../../src/harness/executor-dag';
import type { AgentLeafInput } from '../../src/harness/leaf-runners';
import type { ConductorPlan } from '../../src/harness/conductor-plan';

// omd 本体内部 executor-DAG (现场 fan-out) — 单测用 fake generate, 不碰 live 模型 / PG。
// 证: conductor 规划 → 拓扑分层 → 层内并行 leaf + fan-in context → usage 账本 + 失败隔离 + 无硬默认。

const CONDUCTOR = 'mimo:mimo-v2.5-pro';
const LEAF = 'deepseek:deepseek-v4-flash';

/** plan: a(root) → b(dep a) → c(dep b); 另有 d(root, 与 a 同层并行)。 */
const PLAN_JSON = JSON.stringify({
  name: 'fake-plan',
  nodes: {
    a: { agent: 'x', goal: 'step a' },
    d: { agent: 'x', goal: 'step d' },
    b: { agent: 'x', goal: 'step b', depends_on: ['a'] },
    c: { agent: 'x', goal: 'step c', depends_on: ['b'] },
  },
});

/** 记录每次调用 + 按 model 分流 conductor/leaf 的 fake。 */
function makeFake(planText: string) {
  const calls: { model: string; prompt: string; thinkingLevel?: string }[] = [];
  const gen: GenerateFn = async ({ model, messages, thinkingLevel }) => {
    const prompt = messages.map((m) => m.content).join('\n');
    calls.push({ model, prompt, thinkingLevel });
    if (model === CONDUCTOR) return { text: planText, usage: { in: 100, out: 50 } };
    // leaf: 回显末段 leaf id 标记 + 长度, usage 固定。
    const idMatch = prompt.match(/\[omd leaf: (\w+)\]/);
    return { text: `OUT:${idMatch?.[1] ?? '?'}`, usage: { in: 10, out: 7 } };
  };
  return { gen, calls };
}

describe('omd executor-dag (in-process, fake model)', () => {
  test('无硬默认: 缺 conductorModel / leafModel 抛错', async () => {
    await expect(runExecutorDag('t', { conductorModel: '', leafModel: LEAF })).rejects.toThrow(/conductorModel 必填/);
    await expect(runExecutorDag('t', { conductorModel: CONDUCTOR, leafModel: '' })).rejects.toThrow(/leafModel 必填/);
  });

  test('topoLevels: 正确分层 (a,d 同层 → b → c)', () => {
    const plan = { name: 'p', nodes: JSON.parse(PLAN_JSON).nodes } as ConductorPlan;
    const levels = topoLevels(plan);
    expect(levels.length).toBe(3);
    expect(new Set(levels[0])).toEqual(new Set(['a', 'd'])); // 两个根并行
    expect(levels[1]).toEqual(['b']);
    expect(levels[2]).toEqual(['c']);
  });

  test('topoLevels: 环 → 抛错', () => {
    const plan = { name: 'p', nodes: { x: { agent: 'a', depends_on: ['y'] }, y: { agent: 'a', depends_on: ['x'] } } } as unknown as ConductorPlan;
    expect(() => topoLevels(plan)).toThrow(/cycle/);
  });

  test('端到端: 规划 → 分层执行 → 全 done + fan-in context 传递', async () => {
    const { gen, calls } = makeFake(PLAN_JSON);
    const res = await runExecutorDag('build a thing', { conductorModel: CONDUCTOR, leafModel: LEAF, generate: gen, maxFanout: 4 });

    // 4 节点全 done
    expect(Object.keys(res.results).sort()).toEqual(['a', 'b', 'c', 'd']);
    expect(Object.values(res.results).every((r) => r.status === 'done')).toBe(true);

    // conductor 调 1 次 (CONDUCTOR), leaf 调 4 次 (LEAF)
    expect(calls.filter((c) => c.model === CONDUCTOR).length).toBe(1);
    expect(calls.filter((c) => c.model === LEAF).length).toBe(4);

    // fan-in: b 的 leaf prompt 必含前驱 a 的输出 (OUT:a)
    const bCall = calls.find((c) => c.model === LEAF && c.prompt.includes('[omd leaf: b]'));
    expect(bCall?.prompt).toContain('OUT:a');
    // 根节点 a 无前驱上下文
    const aCall = calls.find((c) => c.model === LEAF && c.prompt.includes('[omd leaf: a]'));
    expect(aCall?.prompt).not.toContain('Predecessor outputs');

    // usage 账本: conductor in/out 累计; leaves 各 in=10/out=7 ×4
    expect(res.usage.conductor).toEqual({ in: 100, out: 50, cacheHit: 0 });
    expect(res.usage.leavesIn).toBe(40);
    expect(res.usage.leavesOut).toBe(28);
    expect(res.usage.leavesCacheHit).toBe(0); // fake usage 无 cacheHit

  });

  test('sessionId: 注入则回显 (跨平面关联键); 省略则自生成非空', async () => {
    const { gen } = makeFake(PLAN_JSON);
    // 注入: result.sessionId === config.sessionId (派活飞轮 dispatchId ↔ Langfuse session join key)。
    const injected = await runExecutorDag('t', { conductorModel: CONDUCTOR, leafModel: LEAF, generate: gen, sessionId: 'dispatch-xyz' });
    expect(injected.sessionId).toBe('dispatch-xyz');
    // 省略: 自生成 (randomUUID), 非空 → 调用方仍可读回做关联。
    const auto = await runExecutorDag('t', { conductorModel: CONDUCTOR, leafModel: LEAF, generate: makeFake(PLAN_JSON).gen });
    expect(auto.sessionId).toBeTruthy();
    expect(auto.sessionId).not.toBe('dispatch-xyz');
  });

  test('leaf 失败隔离: 抛错的 leaf → failed, 不沉整层', async () => {
    const gen: GenerateFn = async ({ model, messages }) => {
      if (model === CONDUCTOR) return { text: PLAN_JSON, usage: { in: 1, out: 1 } };
      const prompt = messages.map((m) => m.content).join('\n');
      if (prompt.includes('[omd leaf: a]')) throw new Error('boom');
      return { text: 'ok', usage: { in: 1, out: 1 } };
    };
    const res = await runExecutorDag('t', { conductorModel: CONDUCTOR, leafModel: LEAF, generate: gen });
    expect(res.results.a!.status).toBe('failed');
    expect(res.results.d!.status).toBe('done'); // 同层 d 不受 a 失败影响
  });

  test('双模 leaf: executor:agent 节点经 agentRunner 跑(能改文件), leaf 节点走 inproc', async () => {
    // plan: research(leaf) → write_file(agent, 改文件)
    const planJson = JSON.stringify({
      name: 'dual-mode',
      nodes: {
        research: { agent: 'x', goal: 'gather', executor: 'leaf' },
        write_file: { agent: 'x', goal: 'write the file', executor: 'agent', depends_on: ['research'] },
      },
    });
    const agentCalls: AgentLeafInput[] = [];
    const gen: GenerateFn = async ({ model }) =>
      model === CONDUCTOR ? { text: planJson, usage: { in: 1, out: 1 } } : { text: 'inproc-out', usage: { in: 5, out: 5 } };
    const agentRunner = async (input: AgentLeafInput) => {
      agentCalls.push(input);
      return { text: 'FILE EDITED', usage: { in: 0, out: 0 } };
    };
    const res = await runExecutorDag('t', { conductorModel: CONDUCTOR, leafModel: LEAF, generate: gen, agentRunner });

    expect(res.results.research!.kind).toBe('inproc');
    expect(res.results.research!.output).toBe('inproc-out');
    expect(res.results.write_file!.kind).toBe('agent');
    expect(res.results.write_file!.output).toBe('FILE EDITED');
    // agent leaf 经 agentRunner, 且收到 fan-in 的前驱输出
    expect(agentCalls.length).toBe(1);
    expect(agentCalls[0]!.prompt).toContain('inproc-out'); // research 的输出灌进 write_file
  });

  test('双模降级: executor:agent 但无 agentRunner → 降级 inproc(仍 done, 不静默假装改了文件)', async () => {
    const planJson = JSON.stringify({ name: 'no-runner', nodes: { w: { agent: 'x', executor: 'agent' } } });
    const gen: GenerateFn = async ({ model }) =>
      model === CONDUCTOR ? { text: planJson, usage: { in: 1, out: 1 } } : { text: 'fallback', usage: { in: 1, out: 1 } };
    const res = await runExecutorDag('t', { conductorModel: CONDUCTOR, leafModel: LEAF, generate: gen }); // 无 agentRunner
    expect(res.results.w!.status).toBe('done');
    expect(res.results.w!.kind).toBe('inproc'); // 降级
  });

  test('cacheHit 聚合 + warmThenFanout: 全 done, leavesCacheHit 累计', async () => {
    // 3 个并行根 (a,d) ... 实际用 PLAN_JSON 的 a/d 同层 + b/c。leaf 模拟带 cacheHit。
    const gen: GenerateFn = async ({ model }) =>
      model === CONDUCTOR
        ? { text: PLAN_JSON, usage: { in: 1, out: 1 } }
        : { text: 'ok', usage: { in: 20, out: 4, cacheHit: 18 } }; // 18/20 命中
    const res = await runExecutorDag('t', {
      conductorModel: CONDUCTOR,
      leafModel: LEAF,
      generate: gen,
      warmThenFanout: true,
    });
    expect(Object.values(res.results).every((r) => r.status === 'done')).toBe(true);
    expect(res.usage.leavesIn).toBe(80); // 4 leaf × 20
    expect(res.usage.leavesCacheHit).toBe(72); // 4 × 18
    expect(res.usage.leavesOut).toBe(16); // 4 × 4
  });

  test('caveman 路由: 干活节点默认注入 full 规则, creative 节点不注入 (护交付物)', async () => {
    const planJson = JSON.stringify({
      name: 'caveman-route',
      nodes: {
        copy: { agent: 'x', goal: 'write a slogan', creative: true }, // 创意 → caveman off
        analyze: { agent: 'x', goal: 'count the lines' }, // 干活 → caveman full (2026-07-21 默认档)
      },
    });
    const calls: { prompt: string }[] = [];
    const gen: GenerateFn = async ({ model, messages }) => {
      const prompt = messages.map((m) => m.content).join('\n');
      if (model === CONDUCTOR) return { text: planJson, usage: { in: 1, out: 1 } };
      calls.push({ prompt });
      return { text: 'ok', usage: { in: 1, out: 1 } };
    };
    await runExecutorDag('t', { conductorModel: CONDUCTOR, leafModel: LEAF, generate: gen }); // 默认 full

    const copyCall = calls.find((c) => c.prompt.includes('[omd leaf: copy]'));
    const analyzeCall = calls.find((c) => c.prompt.includes('[omd leaf: analyze]'));
    // 创意节点: 无任何 caveman 压缩规则 (off = 空串)
    expect(copyCall?.prompt).not.toMatch(/smart caveman|MAXIMUM compression/i);
    // 干活节点: 默认注入 full 规则 (非 ultra 的 "MAXIMUM compression")
    expect(analyzeCall?.prompt).toMatch(/terse like a smart caveman/i);
    expect(analyzeCall?.prompt).not.toMatch(/MAXIMUM compression/);
  });

  test('cavemanLevel:ultra → opt-in 恢复 ultra 压到底 (默认已降 full)', async () => {
    const planJson = JSON.stringify({ name: 'ultra-optin', nodes: { w: { agent: 'x', goal: 'do work' } } });
    const calls: string[] = [];
    const gen: GenerateFn = async ({ model, messages }) => {
      if (model === CONDUCTOR) return { text: planJson, usage: { in: 1, out: 1 } };
      calls.push(messages.map((m) => m.content).join('\n'));
      return { text: 'ok', usage: { in: 1, out: 1 } };
    };
    await runExecutorDag('t', { conductorModel: CONDUCTOR, leafModel: LEAF, generate: gen, cavemanLevel: 'ultra' });
    expect(calls[0]).toMatch(/MAXIMUM compression/); // opt-in 拿回 ultra
  });

  test('command leaf (方案 A): executor:command 经 commandRunner 跑确定性 CLI, kind=command', async () => {
    const planJson = JSON.stringify({
      name: 'cmd-dag',
      nodes: {
        trace: { agent: 'x', executor: 'command', command: 'codegraph trace A B' },
        synth: { agent: 'x', goal: 'summarize', depends_on: ['trace'] }, // inproc 综合
      },
    });
    const cmdCalls: string[] = [];
    const gen: GenerateFn = async ({ model, messages }) =>
      model === CONDUCTOR
        ? { text: planJson, usage: { in: 1, out: 1 } }
        : { text: `synth saw: ${messages.map((m) => m.content).join(' ')}`, usage: { in: 1, out: 1 } };
    const commandRunner = async ({ command }: { command: string }) => {
      cmdCalls.push(command);
      return { text: 'PATH: A -> svc -> B', usage: { in: 0, out: 0 }, exitCode: 0 };
    };
    const res = await runExecutorDag('t', { conductorModel: CONDUCTOR, leafModel: LEAF, generate: gen, commandRunner });

    expect(res.results.trace!.kind).toBe('command');
    expect(res.results.trace!.output).toBe('PATH: A -> svc -> B');
    expect(cmdCalls).toEqual(['codegraph trace A B']);
    // command 输出经 fan-in 灌进下游 synth 节点
    expect(res.results.synth!.status).toBe('done');
    expect(res.results.synth!.output).toContain('PATH: A -> svc -> B');
  });

  test('command leaf 缺 commandRunner → failed (不静默)', async () => {
    const planJson = JSON.stringify({ name: 'no-cmd', nodes: { t: { agent: 'x', executor: 'command', command: 'codegraph status' } } });
    const gen: GenerateFn = async () => ({ text: planJson, usage: { in: 1, out: 1 } });
    const res = await runExecutorDag('t', { conductorModel: CONDUCTOR, leafModel: LEAF, generate: gen }); // 无 commandRunner
    expect(res.results.t!.status).toBe('failed');
    expect(res.results.t!.kind).toBe('command');
  });

  test('cavemanLevel:off → 干活节点也不注入', async () => {
    const planJson = JSON.stringify({ name: 'no-cav', nodes: { w: { agent: 'x', goal: 'do' } } });
    const calls: string[] = [];
    const gen: GenerateFn = async ({ model, messages }) => {
      if (model === CONDUCTOR) return { text: planJson, usage: { in: 1, out: 1 } };
      calls.push(messages.map((m) => m.content).join('\n'));
      return { text: 'ok', usage: { in: 1, out: 1 } };
    };
    await runExecutorDag('t', { conductorModel: CONDUCTOR, leafModel: LEAF, generate: gen, cavemanLevel: 'off' });
    expect(calls[0]).not.toMatch(/MAXIMUM compression|caveman/i);
  });

  test('onComplete 钩子: 运行结束传完整 result (留痕层接入点)', async () => {
    const planJson = JSON.stringify({ name: 'hooked', nodes: { a: { agent: 'x', goal: 'do' } } });
    const gen: GenerateFn = async ({ model }) =>
      model === CONDUCTOR ? { text: planJson, usage: { in: 1, out: 1 } } : { text: 'ok', usage: { in: 1, out: 1 } };
    const captured: { name: string; levels: number; nodes: number }[] = [];
    await runExecutorDag('t', {
      conductorModel: CONDUCTOR,
      leafModel: LEAF,
      generate: gen,
      onComplete: (r) => {
        captured.push({ name: r.plan.name, levels: r.levels.length, nodes: Object.keys(r.results).length });
      },
    });
    expect(captured[0]).toEqual({ name: 'hooked', levels: 1, nodes: 1 });
  });

  test('conductor 产无效 → 有界重试后抛错', async () => {
    const gen: GenerateFn = async () => ({ text: 'not json at all', usage: { in: 1, out: 1 } });
    await expect(
      runExecutorDag('t', { conductorModel: CONDUCTOR, leafModel: LEAF, generate: gen, maxPlanRetries: 1 }),
    ).rejects.toThrow(/未产出有效 plan/);
  });

  // ── D-7 预构造入口 (runExecutorDagWithPlan): 跳过 conductor, 下游机器一致 ──
  test('D-7 预构造入口: 跳过 conductor LLM 步 (conductor fn 不被调用), 下游正常执行', async () => {
    const { gen, calls } = makeFake(PLAN_JSON);
    const prebuilt = { name: 'prebuilt-plan', nodes: JSON.parse(PLAN_JSON).nodes } as ConductorPlan;
    const res = await runExecutorDagWithPlan(prebuilt, { conductorModel: CONDUCTOR, leafModel: LEAF, generate: gen, maxFanout: 4 });

    // 关键: conductor 模型**从未**被调用 (预构造 plan 直执, 零 conductor LLM 步)。
    expect(calls.filter((c) => c.model === CONDUCTOR).length).toBe(0);
    // 下游 ready-set 调度 / 叶子 fan-out 与 conductor 路径一致: 4 节点全 done + fan-in 传递。
    expect(Object.keys(res.results).sort()).toEqual(['a', 'b', 'c', 'd']);
    expect(Object.values(res.results).every((r) => r.status === 'done')).toBe(true);
    expect(calls.filter((c) => c.model === LEAF).length).toBe(4);
    const bCall = calls.find((c) => c.model === LEAF && c.prompt.includes('[omd leaf: b]'));
    expect(bCall?.prompt).toContain('OUT:a'); // fan-in: b 见前驱 a 输出
    // 预构造路径 conductor 用量记 0 (无规划调用)。
    expect(res.usage.conductor).toEqual({ in: 0, out: 0 });
    // 返回的 plan = 传入的预构造 plan (接缝: 下游零感知来源)。
    expect(res.plan.name).toBe('prebuilt-plan');
  });

  test('D-7 预构造入口: leafModel 仍必填 (conductorModel 可省)', async () => {
    const prebuilt = { name: 'p', nodes: { a: { agent: 'x', goal: 'do' } } } as ConductorPlan;
    await expect(runExecutorDagWithPlan(prebuilt, { conductorModel: '', leafModel: '' })).rejects.toThrow(/leafModel 必填/);
    // conductorModel 省略但 leafModel 有 → 不抛 (纯预构造执行不需 conductor)。
    const gen: GenerateFn = async () => ({ text: 'ok', usage: { in: 1, out: 1 } });
    const res = await runExecutorDagWithPlan(prebuilt, { conductorModel: '', leafModel: LEAF, generate: gen });
    expect(res.results.a!.status).toBe('done');
  });

  test('D-7 预构造入口: verifier 通过 → 不触 escalation (仍零 conductor 调用)', async () => {
    const { gen, calls } = makeFake(PLAN_JSON);
    const prebuilt = { name: 'verified', nodes: JSON.parse(PLAN_JSON).nodes } as ConductorPlan;
    const res = await runExecutorDagWithPlan(prebuilt, {
      conductorModel: CONDUCTOR,
      leafModel: LEAF,
      generate: gen,
      verifier: async () => ({ pass: true, reason: 'ok', usage: { in: 2, out: 1 } }),
    });
    expect(res.verification?.pass).toBe(true);
    expect(calls.filter((c) => c.model === CONDUCTOR).length).toBe(0); // verify pass → 无重规划
  });

  test('thinking 档传下去: conductor=high 默认 / inproc leaf=high / config 可覆盖', async () => {
    const { gen, calls } = makeFake(PLAN_JSON);
    await runExecutorDag('t', { conductorModel: CONDUCTOR, leafModel: LEAF, generate: gen, maxFanout: 4 });
    const conductorCall = calls.find((c) => c.model === CONDUCTOR);
    const leafCall = calls.find((c) => c.model === LEAF);
    expect(conductorCall?.thinkingLevel).toBe('high'); // 分解器默认 high
    expect(leafCall?.thinkingLevel).toBe('high'); // inproc leaf high

    const { gen: gen2, calls: calls2 } = makeFake(PLAN_JSON);
    await runExecutorDag('t', {
      conductorModel: CONDUCTOR,
      leafModel: LEAF,
      generate: gen2,
      conductorThinkingLevel: 'xhigh', // 复杂 plan 升 max
      inprocThinkingLevel: 'medium',
    });
    expect(calls2.find((c) => c.model === CONDUCTOR)?.thinkingLevel).toBe('xhigh');
    expect(calls2.find((c) => c.model === LEAF)?.thinkingLevel).toBe('medium');
  });
});
