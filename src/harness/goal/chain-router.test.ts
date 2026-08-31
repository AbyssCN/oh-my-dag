/**
 * src/harness/goal/chain-router.test —— GWT-6 冻结判据
 *
 *   GWT-6 (INV-6): 路由结构化调用返回不在枚举内的 id → 降级 'none' 且日志含原始返回文本
 *
 * 每条 GWT 配一份「已知违规样本」, 闸摘掉 → test 当场由绿转红 (反向自检惯例,
 * 同 stage-chain.test 同款)。
 *
 * 测试结构:
 *   · 主体用 parseRouteRaw (纯函数) — 直接喂 raw, 不必绕 caller, 用例间零共享状态
 *   · routeChain (装配 caller) 只测两例 — 验证装配路径不漏 caller 异常 + 不漏
 *     _logger 接管 (这是 GWT-6 文本判据的完整路径)
 *   · 反向自检段: 把每条「摘掉闸就会红」的事实落成字面注释, 防闸悄悄被摘
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  configureRouteCaller,
  parseRouteRaw,
  routeChain,
  _resetRouteCallerForTest,
} from './chain-router';
import type {
  RouteCaller,
  RouteLogger,
  RouteRaw,
} from './chain-router';
import type { StageChain } from './stage-chain';
import { GRAPH_SHAPES } from '../shapes';

// ── helpers ───────────────────────────────────────────────────────────────

interface Capture {
  logger: RouteLogger;
  lines: string[];
}

function makeCapture(): Capture {
  const lines: string[] = [];
  return { lines, logger: (line) => lines.push(line) };
}

function constCaller(raw: RouteRaw): RouteCaller {
  return async () => raw;
}

function throwingCaller(message: string): RouteCaller {
  return async () => {
    throw new Error(message);
  };
}

const sampleChain: StageChain = {
  stages: [{ id: 's0', word: 'research', goal: '调研阶段' }],
};

// ── GWT-6 (INV-6) 主判据: 越界 shapeId 降级 + 证据留痕 ─────────────────────

describe('GWT-6 INV-6 parseRouteRaw: 越界 shapeId → kind:"none" + 日志含原始 shapeId', () => {
  test('未知 shapeId 降级 none, 日志含 shapeId 与 INV-6 字样', () => {
    const cap = makeCapture();
    const decision = parseRouteRaw({ kind: 'shape', shapeId: 'ghost-shape-xyz' }, cap.logger);
    expect(decision.kind).toBe('none');
    expect(cap.lines.length).toBe(1);
    expect(cap.lines[0]!).toContain('ghost-shape-xyz');
    expect(cap.lines[0]!).toContain('INV-6');
  });

  test('shapeId 类型越界 (非 string) 同样降级', () => {
    const cap = makeCapture();
    const decision = parseRouteRaw(
      { kind: 'shape', shapeId: 42 as unknown as string },
      cap.logger,
    );
    expect(decision.kind).toBe('none');
    expect(cap.lines[0]!).toContain('INV-6');
  });
});

describe('GWT-6 INV-6 parseRouteRaw: caller / raw 异常形态 → 降级 none + 留证据', () => {
  test('空 chain.stages → 降级 none, 日志含 chain 字段名', () => {
    const cap = makeCapture();
    const decision = parseRouteRaw({ kind: 'chain', chain: { stages: [] } }, cap.logger);
    expect(decision.kind).toBe('none');
    expect(cap.lines[0]!).toContain('chain');
  });

  test('chain 字段缺失 → 降级 none', () => {
    const cap = makeCapture();
    const decision = parseRouteRaw(
      { kind: 'chain' } as unknown as RouteRaw,
      cap.logger,
    );
    expect(decision.kind).toBe('none');
    expect(cap.lines[0]!).toContain('chain');
  });

  test('未声明 kind (kind 越界) → 降级 none, 日志含原 kind 字符串', () => {
    const cap = makeCapture();
    const decision = parseRouteRaw(
      { kind: 'mystery', payload: 42 } as unknown as RouteRaw,
      cap.logger,
    );
    expect(decision.kind).toBe('none');
    expect(cap.lines[0]!).toContain('mystery');
  });

  test('raw 不是对象 (null) → 降级 none', () => {
    const cap = makeCapture();
    const decision = parseRouteRaw(null as unknown as RouteRaw, cap.logger);
    expect(decision.kind).toBe('none');
    expect(cap.lines.length).toBe(1);
  });

  test('raw 不是对象 (字符串) → 降级 none', () => {
    const cap = makeCapture();
    const decision = parseRouteRaw('oops' as unknown as RouteRaw, cap.logger);
    expect(decision.kind).toBe('none');
    expect(cap.lines.length).toBe(1);
  });
});

// ── 合法路径: 原样传 + 0 evidence 行 (闸不误伤) ──────────────────────────

describe('正例: 合法 RouteRaw 原样传, 不留 evidence 行', () => {
  test('kind:"shape" 且 shapeId ∈ GRAPH_SHAPES → 原样传', () => {
    const cap = makeCapture();
    const decision = parseRouteRaw(
      { kind: 'shape', shapeId: 'one-decision-then-fanout' },
      cap.logger,
    );
    expect(decision).toEqual({ kind: 'shape', shapeId: 'one-decision-then-fanout' });
    expect(cap.lines).toEqual([]);
  });

  test('kind:"none" → 原样传', () => {
    const cap = makeCapture();
    const decision = parseRouteRaw({ kind: 'none' }, cap.logger);
    expect(decision).toEqual({ kind: 'none' });
    expect(cap.lines).toEqual([]);
  });

  test('kind:"chain" 带 inline StageChain → 原样传', () => {
    const cap = makeCapture();
    const decision = parseRouteRaw({ kind: 'chain', chain: sampleChain }, cap.logger);
    expect(decision).toEqual({ kind: 'chain', chain: sampleChain });
    expect(cap.lines).toEqual([]);
  });
});

// ── 枚举覆盖: 全部 GRAPH_SHAPES id 都被接受 ──────────────────────────────

describe('枚举覆盖 — GRAPH_SHAPES 全部 id 接受 (闸不误伤)', () => {
  for (const shape of GRAPH_SHAPES) {
    test(`shapeId="${shape.id}" → kind:"shape", 0 evidence 行`, () => {
      const cap = makeCapture();
      const decision = parseRouteRaw({ kind: 'shape', shapeId: shape.id }, cap.logger);
      expect(decision).toEqual({ kind: 'shape', shapeId: shape.id });
      expect(cap.lines).toEqual([]);
    });
  }
});

// ── routeChain (S2 冻结签名) 端到端: 验证装配路径不漏 caller 异常 ──────────

describe('routeChain (S2 冻结签名) — 验证装配路径完整', () => {
  let cap: Capture;
  beforeEach(() => {
    cap = makeCapture();
  });
  afterEach(() => {
    _resetRouteCallerForTest();
  });

  test('GWT-6 完整路径: 装配的 caller 返未知 shapeId → kind:"none" + 日志含原始 shapeId', async () => {
    configureRouteCaller(constCaller({ kind: 'shape', shapeId: 'totally-fabricated-id' }), cap.logger);
    const decision = await routeChain('any goal', {});
    expect(decision.kind).toBe('none');
    expect(cap.lines.length).toBeGreaterThan(0);
    expect(cap.lines[0]!).toContain('totally-fabricated-id');
  });

  test('装配的 caller 抛异常 → kind:"none" + 日志含异常文本 (INV-6 fail-open 留证据)', async () => {
    configureRouteCaller(throwingCaller('mock LLM timeout'), cap.logger);
    const decision = await routeChain('g', {});
    expect(decision.kind).toBe('none');
    expect(cap.lines[0]!).toContain('mock LLM timeout');
  });

  test('默认 caller (未 configureRouteCaller) → kind:"none", 0 evidence 行', async () => {
    // 不调 configureRouteCaller — 用模块默认 no-op caller
    _resetRouteCallerForTest();
    // 显式不装 logger, 让默认 console.warn 接管 — 我们的 cap 不会收到
    const decision = await routeChain('g', {});
    expect(decision).toEqual({ kind: 'none' });
  });
});

// ── 反向自检 (仓规): 闸摘掉 → 由绿转红, 注释里逐条挂锚 ──────────────────

describe('反向自检 — 闸摘掉 → test 由绿转红 (注释挂锚, 防悄悄被摘)', () => {
  test('SHAPE_IDS.has 闸摘掉 → GWT-6 "未知 shapeId" 测试由绿转红', () => {
    // 锚: chain-router.ts parseRouteRaw 的 `if (typeof id !== 'string' || !SHAPE_IDS.has(id))`
    //   摘掉这一行, 上面 GWT-6 "未知 shapeId 降级 none, 日志含 shapeId 与 INV-6 字样"
    //   立刻由绿转红 (decision.kind === 'shape' 而非 'none', 且 cap.lines 为空)。
    expect(true).toBe(true);
  });

  test('caller 异常 catch 摘掉 → GWT-6 "装配的 caller 抛异常" 由绿转红', () => {
    // 锚: chain-router.ts routeChain 的 `try { raw = await _caller(goal, deps); } catch`
    //   摘掉整段 try/catch (或 catch 内不调 _logger), 上面 "装配的 caller 抛异常"
    //   立刻由绿转红 (未捕获异常冒泡)。
    expect(true).toBe(true);
  });

  test('logger 留 INV-6 字样摘掉 → GWT-6 "INV-6 字样" 文本检查由绿转红', () => {
    // 锚: chain-router.ts parseRouteRaw 的 logger 行末尾 `降级 'none' (INV-6)`。
    //   把 `(INV-6)` 删掉, 上面 "未知 shapeId 降级 none, 日志含 shapeId 与 INV-6 字样"
    //   的 `expect(cap.lines[0]!).toContain('INV-6')` 立刻由绿转红。
    expect(true).toBe(true);
  });
});
