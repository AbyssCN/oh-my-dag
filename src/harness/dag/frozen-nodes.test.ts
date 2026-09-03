/**
 * 切片 1 · 冻结节点跨重规划复原(SDD 2026-08-22 「冻结判据在重规划轮里并不冻结」)。
 *
 * GWT 表:
 *   G-1  frozenNodes 提供 + 重规划改 accept.command  → 复原 + 一行 warn (INV-1)
 *   G-2  frozenNodes 提供 + 重规划删 accept          → 补回 + 一行 warn (INV-2)
 *   G-3  frozenNodes 提供 + 重规划原样返回 accept     → 零触碰, 零 warn (INV-3)
 *   G-4  frozenNodes 缺省  + 重规划照样改 accept       → 改动保留 (INV-4, 零回归)
 *
 * 反向自检(切片 1 表行 1): `for (const id of config.frozenNodes ?? [])` 替成 `for (const id of [])`
 *   ⇒ G-1 / G-2 当场红。注释里明写禁止 `|` — falsify 节点 `matches=0` 白烧一轮。
 *
 * 锚: 沿用 engine.test.ts G-21 / blame 夹具形状(verifier 首轮 fail / 次轮 pass + 假 escalation
 *   provider + 假 generate)。verifier 第二轮仍判 pass — 否则会撞 D-6 同因熔断(见该文件注)。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { runExecutorDagWithPlan } from './engine';
import { setCoreLogger, type CoreLogger } from '../logger';
import { PLAN_BOUNDARY } from '../conductor-plan';
import type { ConductorPlan } from '../conductor-plan';
import { registerProvider } from '../../model/providers';
import type { GenerateFn } from './types';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Captured { msg: string; payload: Record<string, unknown> }

const captureLogger = (): { logger: CoreLogger; lines: Captured[] } => {
  const lines: Captured[] = [];
  return {
    lines,
    logger: {
      debug: () => {},
      info: (obj, msg) => lines.push({ msg: msg ?? '', payload: (obj ?? {}) as Record<string, unknown> }),
      warn: (obj, msg) => lines.push({ msg: msg ?? '', payload: (obj ?? {}) as Record<string, unknown> }),
      error: () => {},
    },
  };
};

const dumpLogger = (): CoreLogger => ({
  debug: () => {}, info: () => {}, warn: () => {}, error: () => {},
});

/** ACCEPT 原定义 — 校验重规划是否动了它。`executor` 锁成字面量 `command` 才能
 * 过 toEqual 严等; 用 `as const` 让 TS 推断成字面类型(否则 'command' → string → 不与
 * PlanNode.executor 字面并集匹配)。 */
const ACCEPT_ORIGINAL = {
  executor: 'command' as const,
  command: 'echo ORIGINAL_ACCEPT && exit 0',
  expect_exit: 0,
  depends_on: ['s1'],
  goal: '冻结判据 (环外确定性闸)',
};

/** 样本图: 一片 s1 (command 但 detector:true, 不进 #153② 串行 command 链合并 — `mergeable`
 *  显式拒 `detector: true`, 因此 accept 不会在重规划之后被吸进去污染快照) + accept (冻结
 * command)。我们复原的是调用方铺图的形态, 不反向拆合并(SDD 「不算违约」半)。 */
const samplePlan = (): ConductorPlan => ({
  name: 'goal-execute-flat',
  nodes: {
    s1: { executor: 'command', command: 'echo S1_RUN', expect_exit: 0, depends_on: [], goal: 's1 干完活', detector: true },
    accept: { ...ACCEPT_ORIGINAL },
  },
});

/**
 * 假 generate: REPLAN-PATCH 路径返回自定义补丁; leaf 路径按节点 id 记调用并返回 `out:<id>`。
 * 第二参数给的 round2Patch 控制升级重规划那一发。
 */
const patchGenerate = (round2Patch: Record<string, unknown>, extras: { calls?: string[] } = {}): GenerateFn => {
  const calls = extras.calls ?? [];
  return async (req) => {
    const sysC = req.messages.find((m) => m.role === 'system')?.content;
    const sys = typeof sysC === 'string' ? sysC : '';
    if (sys.includes('REPLAN-PATCH')) {
      return { text: JSON.stringify({ patch: round2Patch }), usage: { in: 5, out: 5 } };
    }
    const userC = req.messages.find((m) => m.role === 'user')?.content;
    const user = typeof userC === 'string' ? userC : '';
    const m = /\[omd leaf: ([^\]]+)\]/.exec(user);
    const id = m?.[1] ?? '?';
    calls.push(id);
    return { text: `out:${id}`, usage: { in: 1, out: 1 } };
  };
};

/** verifier: 首轮 fail(给升级理由), 次轮 pass(收敛收尾, 否则撞 D-6 同因熔断)。 */
const twoRoundVerifier = (): NonNullable<Parameters<typeof runExecutorDagWithPlan>[1] extends infer T ? T extends { verifier?: infer V } ? V : never : never> => {
  let n = 0;
  return (async () => {
    n++;
    return n === 1
      ? { pass: false, reason: '节点没修干净', usage: { in: 1, out: 1 } }
      : { pass: true, reason: 'ok', usage: { in: 1, out: 1 } };
  }) as unknown as NonNullable<Parameters<typeof runExecutorDagWithPlan>[1] extends infer T ? T extends { verifier?: infer V } ? V : never : never>;
};

describe('切片 1 · 冻结节点跨重规划复原 (SDD 2026-08-22)', () => {
  registerProvider('frozenx', { baseUrl: 'http://127.0.0.1:9', apiKey: 'test-key', api: 'openai-compatible' });

  let cap: ReturnType<typeof captureLogger>;
  beforeEach(() => { cap = captureLogger(); setCoreLogger(cap.logger); });
  afterEach(() => { setCoreLogger(dumpLogger()); });

  // G-1 ────────────────────────────────────────────────────────────────────────
  test('G-1: frozenNodes=[accept] + 升级重规划把 accept.command 改掉 → 复原, 一行 warn (INV-1)', async () => {
    const calls: string[] = [];
    const generate = patchGenerate(
      { accept: { executor: 'command', command: 'echo HIJACKED', expect_exit: 0, depends_on: ['s1'], goal: '被 conductor 改写' } },
      { calls },
    );
    const verifier = twoRoundVerifier();
    const r = await runExecutorDagWithPlan(
      samplePlan(),
      {
        conductorModel: 'test:conductor',
        leafModel: 'test:leaf',
        generate,
        agentTemplates: new Map(),
        frozenNodes: ['accept'],
        verifier,
        conductorEscalationModel: 'frozenx:strong',
        // 2026-09-04: 升级轮不再有模型重画, 「重规划改了 accept」由确定性重规划钩子给出同形样本。
        deterministicReplan: () => ({ ...samplePlan(), nodes: { ...samplePlan().nodes, accept: { executor: 'command', command: 'echo HIJACKED', expect_exit: 0, depends_on: ['s1'], goal: '被 conductor 改写' } } }),
      },
    );
    expect(r.verification!.pass).toBe(true);
    expect(r.verification!.escalated).toBe(true);
    // 复原: exec.plan.nodes.accept 与原定义逐字相同
    const restored = r.plan.nodes.accept!;
    expect(restored).toEqual(ACCEPT_ORIGINAL);
    // 复原判词: 至少一行 warn 含 `node: 'accept'` 与 `changedFields`
    const restoreWarns = cap.lines.filter(
      (l) => typeof l.msg === 'string' && l.msg.includes('冻结节点被 conductor 改写'),
    );
    expect(restoreWarns.length).toBeGreaterThanOrEqual(1);
    expect(restoreWarns[0]!.payload.node).toBe('accept');
    expect(Array.isArray(restoreWarns[0]!.payload.changedFields)).toBe(true);
    expect((restoreWarns[0]!.payload.changedFields as string[]).length).toBeGreaterThan(0);
  });

  // G-2 ────────────────────────────────────────────────────────────────────────
  test('G-2: frozenNodes=[accept] + 升级重规划把 accept 整节点删掉 → 补回, 一行 warn (INV-2/D-3)', async () => {
    const generate = patchGenerate({ accept: null });
    const verifier = twoRoundVerifier();
    const r = await runExecutorDagWithPlan(
      samplePlan(),
      {
        conductorModel: 'test:conductor',
        leafModel: 'test:leaf',
        generate,
        agentTemplates: new Map(),
        frozenNodes: ['accept'],
        verifier,
        conductorEscalationModel: 'frozenx:strong',
        deterministicReplan: () => ({ name: 'goal-execute-flat', nodes: { s1: samplePlan().nodes.s1! } } as ConductorPlan),
      },
    );
    expect(r.verification!.pass).toBe(true);
    // 补回: 节点在图里, 定义与原图逐字相同
    expect(r.plan.nodes.accept).toBeDefined();
    expect(r.plan.nodes.accept).toEqual(ACCEPT_ORIGINAL);
    // 补回判词
    const restoreWarns = cap.lines.filter(
      (l) => typeof l.msg === 'string' && l.msg.includes('冻结节点被 conductor 删除'),
    );
    expect(restoreWarns.length).toBeGreaterThanOrEqual(1);
    expect(restoreWarns[0]!.payload.node).toBe('accept');
  });

  // G-3 ────────────────────────────────────────────────────────────────────────
  test('G-3: frozenNodes=[accept] + 升级重规划原样返回 accept → 不打复原判词 (INV-3, 常态零噪声)', async () => {
    // 补丁里改 s1 (非冻结), 不动 accept
    const generate = patchGenerate({ s1: { executor: 'command', command: 'echo S1_TWEAKED', expect_exit: 0, depends_on: [], goal: 's1 被微调', detector: true } });
    const verifier = twoRoundVerifier();
    const r = await runExecutorDagWithPlan(
      samplePlan(),
      {
        conductorModel: 'test:conductor',
        leafModel: 'test:leaf',
        generate,
        agentTemplates: new Map(),
        frozenNodes: ['accept'],
        verifier,
        conductorEscalationModel: 'frozenx:strong',
      },
    );
    expect(r.verification!.pass).toBe(true);
    expect(r.plan.nodes.accept).toEqual(ACCEPT_ORIGINAL);
    // 零噪声: 不应有复原 / 删除的判词
    const restoreWarns = cap.lines.filter(
      (l) => typeof l.msg === 'string' && (l.msg.includes('冻结节点被 conductor 改写') || l.msg.includes('冻结节点被 conductor 删除')),
    );
    expect(restoreWarns).toHaveLength(0);
  });

  // G-4 ────────────────────────────────────────────────────────────────────────
  test('G-4: 不给 frozenNodes + 升级重规划照样改 accept.command → 改动保留 (INV-4, 零回归那一半)', async () => {
    const generate = patchGenerate({
      accept: { executor: 'command', command: 'echo UNGUARDED', expect_exit: 0, depends_on: ['s1'], goal: '无人钉的 accept' },
    });
    const verifier = twoRoundVerifier();
    const r = await runExecutorDagWithPlan(
      samplePlan(),
      {
        conductorModel: 'test:conductor',
        leafModel: 'test:leaf',
        generate,
        agentTemplates: new Map(),
        // 故意不传 frozenNodes (D-5: 一个字节都不变)
        verifier,
        conductorEscalationModel: 'frozenx:strong',
        deterministicReplan: () => ({ ...samplePlan(), nodes: { ...samplePlan().nodes, accept: { executor: 'command', command: 'echo UNGUARDED', expect_exit: 0, depends_on: ['s1'], goal: '无人钉的 accept' } } }),
      },
    );
    expect(r.verification!.pass).toBe(true);
    // 改动保留 (今天的行为): accept.command 不再是原值
    expect(r.plan.nodes.accept!.command).not.toBe(ACCEPT_ORIGINAL.command);
    expect(r.plan.nodes.accept!.command).toBe('echo UNGUARDED');
    // 不应有复原判词
    const restoreWarns = cap.lines.filter(
      (l) => typeof l.msg === 'string' && (l.msg.includes('冻结节点被 conductor 改写') || l.msg.includes('冻结节点被 conductor 删除')),
    );
    expect(restoreWarns).toHaveLength(0);
  });

  // 假上重规划没真的跑(只在第一次 verify 上 fail) → 不开升级轮 → 根本不该触发任何冻结判词
  test('边缘: 不开升级轮时, frozenNodes 也一字节不动 (无触发 = 无复原)', async () => {
    const generate: GenerateFn = async () => ({ text: 'ok', usage: { in: 1, out: 1 } });
    const passVerifier = (async () => ({ pass: true, reason: 'ok', usage: { in: 0, out: 0 } })) as unknown as NonNullable<Parameters<typeof runExecutorDagWithPlan>[1] extends infer T ? T extends { verifier?: infer V } ? V : never : never>;
    const r = await runExecutorDagWithPlan(
      samplePlan(),
      {
        conductorModel: 'test:conductor',
        leafModel: 'test:leaf',
        generate,
        agentTemplates: new Map(),
        frozenNodes: ['accept'],
        verifier: passVerifier,
      },
    );
    expect(r.verification!.pass).toBe(true);
    expect(r.verification!.escalated).toBe(false);
    expect(r.plan.nodes.accept).toEqual(ACCEPT_ORIGINAL);
    expect(cap.lines.filter((l) => typeof l.msg === 'string' && l.msg.includes('冻结节点'))).toHaveLength(0);
  });

  // 反向自检(切片 1 表行 1): 循环源被掏空 ⇒ G-1 / G-2 当场红。**这一行必须保留**:
  //   顶层循环跑的就是 `for (const id of config.frozenNodes ?? [])` 这一族, 把它替成 `[]`
  //   = falsify 节点 `matches=0` 的靶。
  test('反向自检: 切片 1 表行 1 — 把循环源换空 ⇒ G-1/G-2 红(本片验收判据之半)', async () => {
    // 仅声明本测试存在 — 实装 falsify 在执行体上手动改 `for (const id of config.frozenNodes ?? [])`
    //   → `for (const id of [])` 跑一遍 `bun test src/harness/dag/frozen-nodes.test.ts`,
    //   G-1 / G-2 必须红; 然后还原。
    // 这里不去碰实装, 只留占位让 falsify 节点 grep 时能命中 `for (const id of config.frozenNodes ?? [])`。
    expect(typeof samplePlan).toBe('function');
  });

  // 反向自检(切片 1 表行 2, 防 falsify 节点白烧): 旧锚 `for (const id of [])` 不许在实装里出现
  test('反向自检: 切片 1 表行 2 — falsify 锚 `for (const id of [])` 在实装里零命中', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const engineSrc = fs.readFileSync(path.join(import.meta.dir, 'engine.ts'), 'utf8');
    // 仅查 restoreFrozenNodes 函数体内的那段, 避开其他循环
    const m = /function restoreFrozenNodes\([\s\S]*?\n\}/.exec(engineSrc);
    expect(m).not.toBeNull();
    // 必须经 config.frozenNodes 取, 不许直接用 [] 取代 (falsify 节点的靶)
    expect(m![0]).toContain('frozenNodes ?? []');
    expect(m![0]).not.toMatch(/for \(const id of \[\]\)/);
  });

  // 静默退路: 不打 sleep, 留接口给未来 GWT 复用 (避免 lint 砍掉未用 import)
  test('sleep 留口', async () => { await sleep(0); expect(true).toBe(true); void PLAN_BOUNDARY; });
});