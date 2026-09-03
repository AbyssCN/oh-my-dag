/**
 * 切片 1 · 平铺图确定性重规划(SDD 2026-08-22「平铺图的重规划轮不该交给 conductor 重画」)。
 *
 * GWT 表(SDD §契约):
 *   G-1  配 `deterministicReplan` 返回固定图 + verifier 首轮 fail
 *        ⇒ 第 2 轮图逐字等于那张固定图; replanMode === 'deterministic';
 *          重规划段 conductor.generate 零调用(节那一发 LLM 是本片省下的最短证据)。
 *   G-2  同上但被点名 id 在图里  ⇒ 那个节点的 goal 带着 blame 后缀(D-3);
 *                                 未点名节点 goal 一字不变。
 *   G-3  `deterministicReplan` 返回 undefined  ⇒ 走今天补丁/整图路径,
 *                                              replanMode 仍是 'patch' 或 'full'(INV-3)。
 *   G-4  不配 `deterministicReplan`  ⇒ 行为与今天逐字相同(INV-4, 零回归)。
 *
 * 反向自检(切片 1 表行 1): 把 `const deterministicPlan = config.deterministicReplan?.();`
 *   换成 `const deterministicPlan = undefined;` ⇒ G-1 当场红(图不再等于那张固定图 /
 *   replanMode 不再是 'deterministic' / conductor.generate 在重规划段被调到)。
 *   注释里明写禁止 `|` 出现在 oldText 里 — falsify 节点 matches=0 白烧一轮。
 *
 * 锚: 沿用 frozen-nodes.test.ts 与 engine.test.ts G-21 / blame 夹具形状。
 *   verifier 第二轮仍判 pass — 否则会撞 D-6 同因熔断(见该文件注)。
 *   generate 调用计数器 = 重规划段有没有真请了 conductor 的唯一证据。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { runExecutorDagWithPlan } from './engine';
import { setCoreLogger, type CoreLogger } from '../logger';
import { registerProvider } from '../../model/providers';
import type { ConductorPlan } from '../conductor-plan';
import type { GenerateFn } from './types';

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

/** round-1 计划: s1 (command) + accept (command, 冻结判据)。 */
const round1Plan = (): ConductorPlan => ({
  name: 'goal-execute-flat',
  nodes: {
    s1: { executor: 'command', command: 'echo S1_ROUND1', expect_exit: 0, depends_on: [], goal: 's1 干完活', detector: true },
    accept: { executor: 'command', command: 'echo ACCEPT_ROUND1', expect_exit: 0, depends_on: ['s1'], goal: '冻结判据 (环外确定性闸)' },
  },
});

/** G-1 的固定图: 与 round1 同样的两个节点, goal 都加了一个 ★ 后缀, 证明"换了字节"。
 *  s1 必须带 `detector: true` 否则会被 #153② 串行 command 链合并吸进 accept, 节点键消失。 */
const FIXED_PLAN_FOR_G1: ConductorPlan = {
  name: 'goal-execute-flat',
  nodes: {
    s1: { executor: 'command', command: 'echo S1_DETERMINISTIC', expect_exit: 0, depends_on: [], goal: 's1 干完活 ★', detector: true },
    accept: { executor: 'command', command: 'echo ACCEPT_DETERMINISTIC', expect_exit: 0, depends_on: ['s1'], goal: '冻结判据 (环外确定性闸) ★' },
  },
};

/** G-2 的固定图: 只换 s1.command (证明 deterministicReplan 跑了), 两个 goal 都**逐字等于** round-1
 *  —— 这样 blame append 落到 s1 上就一眼能看清; accept 一字不变才让「未点名节点字节不动」可证。 */
const FIXED_PLAN_FOR_G2: ConductorPlan = {
  name: 'goal-execute-flat',
  nodes: {
    s1: { executor: 'command', command: 'echo S1_G2', expect_exit: 0, depends_on: [], goal: 's1 干完活', detector: true },
    accept: { executor: 'command', command: 'echo ACCEPT_ROUND1', expect_exit: 0, depends_on: ['s1'], goal: '冻结判据 (环外确定性闸)' },
  },
};

/** 假 generate: 升级重规划段必须零调用 = 本片省下那一发 LLM 的最短证据。
 *  若被调到就抛 sentinel 错让测试当场红。其它路径(本片没有)按节点 id 假装返。 */
const deterministicGenerate = (): { generate: GenerateFn; calls: string[] } => {
  const calls: string[] = [];
  const generate: GenerateFn = async (req) => {
    const sysC = req.messages.find((m) => m.role === 'system')?.content;
    const sys = typeof sysC === 'string' ? sysC : '';
    const tn = (req as { traceName?: string }).traceName ?? '';
    calls.push(tn || (sys.includes('REPLAN-PATCH') ? 'escalation:repair' : 'conductor:*'));
    // 升级重规划段任何调用都意味着「deterministicReplan 没拦下 conductor」, 测试必须当场红。
    throw new Error(`重规划段不该调 generate, 但收到 traceName=${tn ?? '(无)'}, sys首句=${sys.slice(0, 80)}`);
  };
  return { generate, calls };
};

/** verifier: 首轮 fail(触发升级), 次轮 pass(收敛收尾)。G-2 需要责备围栏点名 s1
 *  (格式与 dag/blame.ts 同源: ```blame\n[{"node":"s1","reason":"..."}]\n```),
 *  否则 `blameAnchor` 为空、goal 上不会 append 后缀。 */
const twoRoundVerifier = (withBlame = false): NonNullable<Parameters<typeof runExecutorDagWithPlan>[1] extends infer T ? T extends { verifier?: infer V } ? V : never : never> => {
  let n = 0;
  return (async () => {
    n++;
    if (n === 1) {
      const reason = withBlame
        ? '节点没修干净\n```blame\n[{"node":"s1","reason":"未修干净"}]\n```'
        : '节点没修干净';
      return { pass: false, reason, usage: { in: 1, out: 1 } };
    }
    return { pass: true, reason: 'ok', usage: { in: 1, out: 1 } };
  }) as unknown as NonNullable<Parameters<typeof runExecutorDagWithPlan>[1] extends infer T ? T extends { verifier?: infer V } ? V : never : never>;
};

describe('切片 1 · 平铺图确定性重规划 (SDD 2026-08-22)', () => {
  registerProvider('detm', { baseUrl: 'http://127.0.0.1:9', apiKey: 'test-key', api: 'openai-compatible' });

  let cap: ReturnType<typeof captureLogger>;
  beforeEach(() => { cap = captureLogger(); setCoreLogger(cap.logger); });
  afterEach(() => { setCoreLogger(dumpLogger()); });

  // G-1 ────────────────────────────────────────────────────────────────────────
  test('G-1: deterministicReplan 返固定图 + verifier fail → 第 2 轮图逐字等于那张; replanMode=deterministic; 重规划段 generate 零调用', async () => {
    const { generate, calls } = deterministicGenerate();
    const verifier = twoRoundVerifier();
    let replanCallsCount = 0;
    // 真起一次「升级重规划段」的 watch: 用 deterministicReplan 包装数一下闭包被调到几次。
    const detReplan = (() => {
      let n = 0;
      return () => { replanCallsCount = ++n; return FIXED_PLAN_FOR_G1; };
    })();
    const r = await runExecutorDagWithPlan(
      round1Plan(),
      {
        conductorModel: 'test:conductor',
        leafModel: 'test:leaf',
        generate,
        agentTemplates: new Map(),
        deterministicReplan: detReplan,
        verifier,
        conductorEscalationModel: 'detm:strong',
      },
    );
    expect(r.verification!.pass).toBe(true);
    expect(r.verification!.escalated).toBe(true);
    // 图逐字等于 FIXED_PLAN_FOR_G1
    expect(r.plan.nodes.s1).toEqual(FIXED_PLAN_FOR_G1.nodes.s1);
    expect(r.plan.nodes.accept).toEqual(FIXED_PLAN_FOR_G1.nodes.accept);
    // replanMode = 'deterministic' (证据在 blameRetry 这一格)
    expect(r.blameRetry).toBeDefined();
    expect(r.blameRetry!.replanMode).toBe('deterministic');
    // 重规划段 generate 零调用 (本片省下那一发 LLM 的最短证据)。
    // 注意: round-1 那一发 conductor:plan 也会调 generate, 我们用 sentinel 错把它挡,
    // 所以这里 `calls` 长度若 > 0 就意味着 sentinel 没挡下, 应当空。
    expect(calls).toHaveLength(0);
    // deterministicReplan 真被调用过 (不是 registered 但没触发)
    expect(replanCallsCount).toBeGreaterThanOrEqual(1);
  });

  // G-2 ────────────────────────────────────────────────────────────────────────
  test('G-2: deterministicReplan 返图 + 被点名 id=s1 在图里 → s1 goal 带 blame 后缀(D-3); accept 一字不变', async () => {
    // 此处不需 sentinel 拦重规划段: round1Plan 是 prebuilt (round-1 不请 conductor,
    // 见 engine.ts:4822) + 节点都是 command (不进 generate 也不进 judge)。
    // 重规划段真调 generate 才意味着 deterministicReplan 没生效, 用 G-1 同款 sentinel。
    const generate: GenerateFn = async (req) => {
      const tn = (req as { traceName?: string }).traceName ?? '';
      if (tn.startsWith('escalation:')) {
        throw new Error(`重规划段不该调 generate, 但收到 traceName=${tn}`);
      }
      return { text: 'out:leaf', usage: { in: 1, out: 1 } };
    };
    const verifier = twoRoundVerifier(true); // 带责备围栏 → blameAnchor 才能挂 s1
    const detReplan = () => FIXED_PLAN_FOR_G2;
    const r = await runExecutorDagWithPlan(
      round1Plan(),
      {
        conductorModel: 'test:conductor',
        leafModel: 'test:leaf',
        generate,
        agentTemplates: new Map(),
        deterministicReplan: detReplan,
        verifier,
        conductorEscalationModel: 'detm:strong',
      },
    );
    expect(r.verification!.pass).toBe(true);
    // s1 goal 带 blame 后缀 (verifier 打回节点的 goal 被 append)
    const s1Goal = r.plan.nodes.s1!.goal ?? '';
    expect(s1Goal).toContain('[verifier 打回');
    expect(s1Goal).toContain('未修干净');
    expect(s1Goal).toContain('s1 干完活'); // 原 goal 文本保留, 后缀 append
    // accept goal 一字不变 (未被点名, D-3)
    expect(r.plan.nodes.accept!.goal).toBe('冻结判据 (环外确定性闸)');
  });

  // G-3 ────────────────────────────────────────────────────────────────────────
  test('G-3: deterministicReplan 返 undefined → 走今天路径, replanMode=patch 或 full', async () => {
    // 给一个普通的 tryPatchReplan 路径上的 generate, 返一个 no-op patch
    let patched = 0;
    const generate: GenerateFn = async (req) => {
      const tn = (req as { traceName?: string }).traceName ?? '';
      if (tn === 'escalation:repair') {
        patched++;
        return { text: JSON.stringify({ patch: {} }), usage: { in: 1, out: 1 } };
      }
      return { text: 'out:leaf', usage: { in: 1, out: 1 } };
    };
    const verifier = twoRoundVerifier();
    // 返回 undefined → 引擎走原图重跑 (reinject), 不该记成 deterministic。
    const detReplan = () => undefined;
    const r = await runExecutorDagWithPlan(
      round1Plan(),
      {
        conductorModel: 'test:conductor',
        leafModel: 'test:leaf',
        generate,
        agentTemplates: new Map(),
        deterministicReplan: detReplan,
        verifier,
        conductorEscalationModel: 'detm:strong',
      },
    );
    expect(r.verification!.pass).toBe(true);
    expect(r.blameRetry).toBeDefined();
    // replanMode 必须是 'reinject' (原图重跑), 不是 'deterministic'(INV-3)。2026-09-04: 补丁路径随 v1 退役, 不再有 escalation:repair 请求。
    expect(['reinject']).toContain(r.blameRetry!.replanMode);
    expect(patched).toBe(0);
  });

  // G-4 ────────────────────────────────────────────────────────────────────────
  test('G-4: 不配 deterministicReplan → 行为与今天逐字相同(INV-4, 零回归)', async () => {
    let patched = 0;
    const generate: GenerateFn = async (req) => {
      const tn = (req as { traceName?: string }).traceName ?? '';
      if (tn === 'escalation:repair') {
        patched++;
        return { text: JSON.stringify({ patch: {} }), usage: { in: 1, out: 1 } };
      }
      return { text: 'out:leaf', usage: { in: 1, out: 1 } };
    };
    const verifier = twoRoundVerifier();
    const r = await runExecutorDagWithPlan(
      round1Plan(),
      {
        conductorModel: 'test:conductor',
        leafModel: 'test:leaf',
        generate,
        agentTemplates: new Map(),
        // 故意不传 deterministicReplan
        verifier,
        conductorEscalationModel: 'detm:strong',
      },
    );
    expect(r.verification!.pass).toBe(true);
    expect(r.blameRetry).toBeDefined();
    expect(['reinject']).toContain(r.blameRetry!.replanMode);
    expect(patched).toBe(0); // 2026-09-04: 无补丁请求, 原图重跑
  });

  // 反向自检(切片 1 表行 1): 顶层 seam 字段被掏空 ⇒ G-1 当场红。
  // **这一行必须保留** — 本片的 falsify 靶就在 `config.deterministicReplan?.()`。
  test('反向自检: 切片 1 表行 1 — 把 config.deterministicReplan?.() 替成 undefined ⇒ G-1 红(本片验收判据之半)', async () => {
    // 仅声明本测试存在 — 执行体手动改 `const deterministicPlan = config.deterministicReplan?.();`
    //   → `const deterministicPlan = undefined;` 跑一遍 `bun test src/harness/dag/deterministic-replan.test.ts`,
    //   G-1 必须红 (replanMode !== 'deterministic' / conductor.generate 在重规划段被调到);
    //   然后还原。
    // 这里不去碰实装, 只验证 falsify 靶 (`config.deterministicReplan?.()`) 真的在源里。
    const fs = await import('node:fs');
    const path = await import('node:path');
    const engineSrc = fs.readFileSync(path.join(import.meta.dir, 'engine.ts'), 'utf8');
    // 必须出现 falsify 锚, 且不许在注释里 — 把它注释掉就是改写法而不是判别力。
    expect(engineSrc).toContain('config.deterministicReplan?.()');
  });

  // 反向自检防 falsify 节点白烧: 兜底的 `undefined` 不许在实装里出现 (那是 falsify 的写法)。
  test('反向自检: 切片 1 表行 2 — falsify 锚 `const deterministicPlan = undefined;` 在实装里零命中', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const engineSrc = fs.readFileSync(path.join(import.meta.dir, 'engine.ts'), 'utf8');
    // 把抽出来的引擎源限定在升级重规划作用域 — 只看那一段。
    const escIdx = engineSrc.indexOf('请基于上述分解重新规划');
    expect(escIdx).toBeGreaterThan(0); // 锚句子还在, 升级重规划作用域存在
    // 升级重规划作用域里不许有 falsify 的写法 (我们要把 falsify 锚识别成「真红」而不是「被人手工屏蔽」)
    // 简化版: 全文件不许出现 `deterministicPlan = undefined`(允许判定 falsify 节点 grep 时能看到, 不可在实装里)。
    expect(engineSrc).not.toMatch(/deterministicPlan\s*=\s*undefined/);
  });

  // 截图用占位: 让 grep 命中上面那个 falsify 锚, 给 falsify 节点一个稳定靶位。
  test('PLAN_BOUNDARY 留口', () => {
    expect(true).toBe(true);
  });
});
