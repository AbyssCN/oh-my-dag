/**
 * D-M 图式引导(前置)+ D-N 展开闸(后置) —— P3 批次 3 item 10 (2026-07-29)。
 *
 * SDD 的原话是「骨架硬保证 → 图式引导(前置)+ 展开闸(后置)」: 放弃了预构造骨架之后, 质量得靠
 * 两头夹 —— 展开**之前**给它见过的图形状, 展开**之后**过一遍与外层同一条 pass 管线 + 体检。
 *
 * 代价 SDD 也写了: **conductor 的规划质量成为新的单点**。这组测试守的就是那两头夹的东西还在。
 */
import { describe, expect, test } from 'bun:test';
import { GRAPH_SHAPES, renderShapesForPrompt, shapeById } from '../../src/harness/shapes';
import { conductorSystemPrompt } from '../../src/harness/conductor-plan';
import { subgraphWarnings, expandConductorNode } from '../../src/harness/plan/conductor-expand';
import { stampPass } from '../../src/harness/plan-passes/stamp-pass';
import { runExecutorDagWithPlan } from '../../src/harness/dag/engine';
import type { ConductorPlan } from '../../src/harness/conductor-plan';
import type { ExecutorDagConfig, GenerateFn } from '../../src/harness/dag/types';

const leafId = (p: string): string => /\[omd leaf: ([^\]]+)\]/.exec(p)?.[1] ?? '';
const plan = (nodes: Record<string, unknown>): ConductorPlan => ({ name: 's', nodes }) as unknown as ConductorPlan;

// ── D-M 图式引导 ──────────────────────────────────────────────────────────────

describe('D-M 图式引导 — runtime-decomposition 进图式表 (单一真源, 两个消费面)', () => {
  const shape = () => shapeById('runtime-decomposition')!;

  test('图式存在, 且照表填齐了 what/when/whenNot/steps/why', () => {
    const s = shape();
    expect(s).toBeTruthy();
    expect(s.steps.length).toBeGreaterThan(0);
    expect(s.why.length).toBeGreaterThan(10);
  });

  test('**反例**点名 map —— 最容易选错的就是这两个之间 (异构 vs 同一件事的 N 份)', () => {
    const s = shape();
    expect(s.whenNot).toContain('map');
    expect(s.whenNot).toContain('异构');
  });

  test('反例也点名"现在就拆得出来" —— conductor 节点是多一次调用 + 多一层间接', () => {
    expect(shape().whenNot).toContain('拆得出来');
  });

  test('它是被引擎硬闸强制的 → 必须写明 enforced (否则读者分不清"建议"与"闸")', () => {
    const e = shape().enforced!;
    expect(e).toBeTruthy();
    expect(e).toContain('禁'); // D-D 禁嵌套
    expect(e).toContain('内容寻址'); // D-B
  });

  test('why 里认了代价 (规划质量成为新单点) —— 不是只讲好处', () => {
    expect(shape().why).toContain('单点');
  });

  test('两档 conductor prompt 都渲染到它 (图式表就是 prompt 的来源, 不抄第二份)', () => {
    for (const profile of ['full', 'lean'] as const) {
      expect(conductorSystemPrompt({ profile })).toContain('runtime-decomposition');
    }
    expect(renderShapesForPrompt('full').join('\n')).toContain('runtime-decomposition');
  });

  test('conductor 节点展开时用的就是这份 prompt (引导真的到得了展开调用)', async () => {
    let sysSeen = '';
    const generate: GenerateFn = async (req) => {
      const user = req.messages.find((m) => m.role === 'user');
      const text = typeof user?.content === 'string' ? user.content : '';
      if (!leafId(text)) {
        sysSeen = String(req.messages.find((m) => m.role === 'system')?.content ?? '');
        return { text: JSON.stringify({ name: 's', nodes: { a: { goal: 'A' } } }), usage: { in: 1, out: 1 } };
      }
      return { text: 'ok', usage: { in: 1, out: 1 } };
    };
    await runExecutorDagWithPlan(
      { name: 'o', nodes: { c: { goal: 'g', executor: 'conductor' } } } as ConductorPlan,
      { conductorModel: 'c:m', leafModel: 'l:m', generate, agentTemplates: new Map() },
    );
    expect(sysSeen).toContain('runtime-decomposition');
    expect(sysSeen).toContain('one-decision-then-fanout'); // 其余图式也在
  });

  test('图式表整体没退化 (新增一条不该让别的消失)', () => {
    const ids = GRAPH_SHAPES.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const must of ['ui-evidence', 'runtime-work-list', 'runtime-decomposition']) {
      expect(ids).toContain(must);
    }
  });
});

// ── D-N 展开闸 (硬半边: 子图过与外层同一条 pass 管线) ─────────────────────────

describe('D-N 展开闸 — 子图过与外层同一条 pass 管线', () => {
  test('planFilters 真作用到子图 (此前子图一条 pass 都不过 → tier 是哑弹)', async () => {
    const modelsUsed: string[] = [];
    const generate: GenerateFn = async (req) => {
      const user = req.messages.find((m) => m.role === 'user');
      const text = typeof user?.content === 'string' ? user.content : '';
      if (!leafId(text)) {
        return {
          text: JSON.stringify({ name: 's', nodes: { a: { goal: 'A' }, b: { goal: 'B' } } }),
          usage: { in: 1, out: 1 },
        };
      }
      modelsUsed.push(req.model);
      return { text: 'ok', usage: { in: 1, out: 1 } };
    };
    // 一个把每个节点都钉上坐标的 pass —— 若子图没过管线, 子节点会掉到静态 leafModel。
    const cfg: ExecutorDagConfig = {
      conductorModel: 'c:m',
      leafModel: 'static:leaf',
      generate,
      agentTemplates: new Map(),
      planFilters: [
        (p) => ({
          ...p,
          nodes: Object.fromEntries(Object.entries(p.nodes).map(([k, n]) => [k, { ...n, model: 'stamped:coord' }])),
        }),
      ],
    };
    await runExecutorDagWithPlan({ name: 'o', nodes: { c: { goal: 'g', executor: 'conductor' } } } as ConductorPlan, cfg);
    expect(modelsUsed).toHaveLength(2);
    for (const m of modelsUsed) expect(m).toBe('stamped:coord'); // 不是 static:leaf
  });

  test('pass 抛错 → 拒整份子图, 一个子节点都不跑 (fail-closed, 同外层撞坏 pass)', async () => {
    const leafCalls: string[] = [];
    const generate: GenerateFn = async (req) => {
      const user = req.messages.find((m) => m.role === 'user');
      const text = typeof user?.content === 'string' ? user.content : '';
      if (!leafId(text)) return { text: JSON.stringify({ name: 's', nodes: { a: { goal: 'A' } } }), usage: { in: 1, out: 1 } };
      leafCalls.push(text);
      return { text: 'ok', usage: { in: 1, out: 1 } };
    };
    const r = await runExecutorDagWithPlan(
      { name: 'o', nodes: { c: { goal: 'g', executor: 'conductor' } } } as ConductorPlan,
      {
        conductorModel: 'c:m', leafModel: 'l:m', generate, agentTemplates: new Map(),
        // 只对**子图**抛 (按 plan.name 认): 外层 plan 也过同一条管线, 无差别抛会先把外层打死,
        // 那样测的就不是"子图撞上坏 pass"了。
        planFilters: [(p) => { if (p.name === 's') throw new Error('坏 pass'); return p; }],
      },
    );
    expect(r.results.c?.status).toBe('failed');
    expect(leafCalls).toHaveLength(0);
  });

  test('stamp pass 跳过 conductor 节点 (它用 conductor 座位, 盖 leaf 档坐标是空旋钮)', () => {
    const p = plan({
      c: { goal: '展开', executor: 'conductor' },
      l: { goal: '普通 leaf', tier: 'mid' },
    });
    const { plan: out, stamped } = stampPass(p, {
      pools: { strong: ['s:1'], mid: ['m:1'], cheap: ['ch:1'], multimodal: [] },
      familyOf: (c) => c.split(':')[0]!,
    });
    expect(stamped.c).toBeUndefined();
    expect(out.nodes.c!.model).toBeUndefined();
    expect(stamped.l).toBeTruthy(); // 控制组: 普通 leaf 照盖 (证明不是恒空)
  });

  test('显式 node.model 赢过 conductor 座位 (TPL-3 优先序对展开调用也成立)', async () => {
    let expandModel = '';
    const generate: GenerateFn = async (req) => {
      const user = req.messages.find((m) => m.role === 'user');
      const text = typeof user?.content === 'string' ? user.content : '';
      if (!leafId(text)) {
        expandModel = req.model;
        return { text: JSON.stringify({ name: 's', nodes: { a: { goal: 'A' } } }), usage: { in: 1, out: 1 } };
      }
      return { text: 'ok', usage: { in: 1, out: 1 } };
    };
    await runExecutorDagWithPlan(
      { name: 'o', nodes: { c: { goal: 'g', executor: 'conductor', model: 'pinned:by-hand' } } } as ConductorPlan,
      { conductorModel: 'seat:conductor', leafModel: 'l:m', generate, agentTemplates: new Map() },
    );
    expect(expandModel).toBe('pinned:by-hand');
  });
});

// ── D-N 展开闸 (软半边: 体检) ────────────────────────────────────────────────

describe('D-N 展开闸 — 结构体检**只 warn 不拒** (两条都有正当反例, 没证据别装有阈值)', () => {
  const childrenOf = (nodes: Record<string, unknown>) => expandConductorNode('P', plan(nodes)).children;

  test('单节点子图 → 报「没有分解, 只是加了一层间接」', () => {
    const w = subgraphWarnings(childrenOf({ only: { goal: '一步' } }));
    expect(w.map((x) => x.check)).toContain('single-node');
    expect(w.find((x) => x.check === 'single-node')!.message).toContain('白花');
  });

  test('多节点 → 不报 single-node', () => {
    const w = subgraphWarnings(childrenOf({ a: { goal: 'A' }, b: { goal: 'B' } }));
    expect(w.map((x) => x.check)).not.toContain('single-node');
  });

  test('有写文件节点却无 command 验证步 → 报「产物对不对只由模型自述」', () => {
    const w = subgraphWarnings(childrenOf({
      impl: { goal: '实装', executor: 'agent', output_type: 'file', output_path: 'src/x.ts' },
      doc: { goal: '写说明' },
    }));
    const hit = w.find((x) => x.check === 'writes-without-gate')!;
    expect(hit).toBeTruthy();
    expect(hit.message).toContain('静默');
  });

  test('写文件 + 有 command 闸 → 不报 (地板在了)', () => {
    const w = subgraphWarnings(childrenOf({
      impl: { goal: '实装', executor: 'agent', output_type: 'file', output_path: 'src/x.ts' },
      gate: { goal: '跑闸', executor: 'command', command: 'bun test' },
    }));
    expect(w.map((x) => x.check)).not.toContain('writes-without-gate');
  });

  test('纯文本子图 (无人写文件) → 不报 writes-without-gate', () => {
    const w = subgraphWarnings(childrenOf({ a: { goal: '分析' }, b: { goal: '综合' } }));
    expect(w.map((x) => x.check)).not.toContain('writes-without-gate');
  });

  test('体检**不改变执行**: 有告警的子图照跑不误 (它是提示不是闸)', async () => {
    const leafCalls: string[] = [];
    const generate: GenerateFn = async (req) => {
      const user = req.messages.find((m) => m.role === 'user');
      const text = typeof user?.content === 'string' ? user.content : '';
      if (!leafId(text)) {
        // 单节点 + 写文件无闸 —— 两条告警全中。
        return {
          text: JSON.stringify({ name: 's', nodes: { only: { goal: '写文件', output_type: 'file', output_path: 'a.md' } } }),
          usage: { in: 1, out: 1 },
        };
      }
      leafCalls.push(text);
      return { text: 'done', usage: { in: 1, out: 1 }, filesTouched: [] };
    };
    const r = await runExecutorDagWithPlan(
      { name: 'o', nodes: { c: { goal: 'g', executor: 'conductor' } } } as ConductorPlan,
      { conductorModel: 'c:m', leafModel: 'l:m', generate, agentTemplates: new Map() },
    );
    // 写文件节点无 agentRunner → 引擎本来就判 failed (拒 inproc 静默假成功), 但那与体检无关:
    // 关键是展开没被体检拦住, 子节点真的被调度了。
    expect(r.results.c).toBeTruthy();
    expect(Object.keys(r.results).some((k) => k.startsWith('c::'))).toBe(true);
  });
});
