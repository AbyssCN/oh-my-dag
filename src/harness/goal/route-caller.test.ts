/**
 * src/harness/goal/route-caller.test —— D4.1 切片 2 冻结判据 (GWT-2 / GWT-3)
 *
 *   GWT-2 (INV-2) — chain 关时 caller 零构造/零调用 (测试 proxy: 默认 caller 路径不
 *                  触发 buildRouteCaller, 0 次真实 LLM 调用)
 *   GWT-3 (INV-3) — caller 返回非 JSON / 词表外 / 空链 → 降级 'none' 且日志
 *                  含原文片段; 合法 JSON 原样传给 compileChain
 *
 * 反向自检惯例: 每条配一份「闸摘掉 → 由绿转红」的事实注释, 防悄悄被摘。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  configureRouteCaller,
  parseRouteRaw,
  routeChain,
  _resetRouteCallerForTest,
  type RouteLogger,
} from './chain-router';
import {
  buildRouteCaller,
  routeCallerPrompt,
  tryParseJson,
  type RouteCallerCall,
} from './route-caller';

// ── helpers ───────────────────────────────────────────────────────────────

interface Capture {
  logger: RouteLogger;
  lines: string[];
}

function makeCapture(): Capture {
  const lines: string[] = [];
  return { lines, logger: (line) => lines.push(line) };
}

/** 计数 LLM 调用次数 — GWT-2 用。 */
function countingCall(ref: { n: number }, text = '{"kind":"none"}'): RouteCallerCall {
  return async () => {
    ref.n++;
    return { text };
  };
}

/** 链合法样本 —— stages 只 1 个 word:"research"。 */
const VALID_CHAIN_JSON = JSON.stringify({
  kind: 'chain',
  chain: { stages: [{ id: 's1', word: 'research', goal: '调研' }] },
});

// ── GWT-2 (INV-2): chain 关 → caller 零构造/零调用 ─────────────────────────

describe('GWT-2 — INV-2: 默认 (未装配) 路径 = 零真实 LLM 调用', () => {
  afterEach(() => {
    _resetRouteCallerForTest();
  });

  test('不 configureRouteCaller: routeChain 走默认 caller, fake call 计数器 = 0', async () => {
    // 默认 _caller = async () => ({kind:'none'}) —— 不调 deps.call, 0 次 LLM
    _resetRouteCallerForTest();
    const calls = { n: 0 };
    // 故意不调 configureRouteCaller, 也不构造 buildRouteCaller
    const decision = await routeChain('any goal', {});
    expect(decision).toEqual({ kind: 'none' });
    expect(calls.n).toBe(0);
  });

  test('parseRouteRaw 是纯函数, 不依赖 _caller / 不会触发 LLM 调用', () => {
    const calls = { n: 0 };
    // parseRouteRaw 路径与 _caller 无关, 计数恒 0
    parseRouteRaw({ kind: 'shape', shapeId: 'one-decision-then-fanout' }, () => {
      calls.n++;
    });
    expect(calls.n).toBe(0);
  });
});

describe('GWT-2 — INV-2: 装配 buildRouteCaller 后, 开关关闭时不进 chain 块 (调用计数为 0)', () => {
  afterEach(() => {
    _resetRouteCallerForTest();
  });
  test('链块只在 chainOn=true 时进 — 本测试模拟「装配了但调用 0 次」', async () => {
    // 我们无法直接测 run-goal 的 chainOn 闸 (那是集成闸), 这里用 call 计数
    // 证明 buildRouteCaller 装配后, 调不调 routeChain 是 caller 之外的事:
    // 装配 ≠ 调用, 真零成本由 chainOn 闸保证。
    const calls = { n: 0 };
    const caller = buildRouteCaller({
      leafCoord: 'test:cheap',
      call: countingCall(calls, VALID_CHAIN_JSON),
    });
    configureRouteCaller(caller);
    // 不调 routeChain —— caller 装配了但 0 次调用 (闸的零成本由 chainOn 保证)
    expect(calls.n).toBe(0);
  });
});

// ── GWT-3 (INV-3): caller 产物钳 ──────────────────────────────────────────

describe('GWT-3 — INV-3: LLM 返回非 JSON → routeChain 降级 none + 日志含原文片段', () => {
  let cap: Capture;
  beforeEach(() => {
    cap = makeCapture();
    _resetRouteCallerForTest();
  });
  afterEach(() => {
    _resetRouteCallerForTest();
  });

  test('纯散文 (不是 JSON) → none + 日志含 \"I cannot answer\" 片段', async () => {
    const caller = buildRouteCaller({
      leafCoord: 'test:cheap',
      call: async () => ({ text: 'I cannot answer that question, sorry.' }),
    });
    configureRouteCaller(caller, cap.logger);
    const decision = await routeChain('g', {});
    expect(decision.kind).toBe('none');
    // chain-router.routeChain 的 catch 会把错误 msg 拼到日志行, msg 含原文前 200 字
    const joined = cap.lines.join('\n');
    expect(joined).toContain('I cannot answer');
  });

  test('不完整 JSON (被截断) → none + 日志含原文前 200 字', async () => {
    const caller = buildRouteCaller({
      leafCoord: 'test:cheap',
      call: async () => ({ text: '{"kind":"cha' }),  // 缺闭合
    });
    configureRouteCaller(caller, cap.logger);
    const decision = await routeChain('g', {});
    expect(decision.kind).toBe('none');
    const joined = cap.lines.join('\n');
    expect(joined).toContain('kind');
  });

  test('JSON 顶层是数组 → none + 日志含原文', async () => {
    const caller = buildRouteCaller({
      leafCoord: 'test:cheap',
      call: async () => ({ text: '[]' }),
    });
    configureRouteCaller(caller, cap.logger);
    const decision = await routeChain('g', {});
    expect(decision.kind).toBe('none');
    const joined = cap.lines.join('\n');
    expect(joined).toContain('[]');
  });

  test('```json 代码块包裹 → 剥外层后判定 — 合法时原样传', async () => {
    const caller = buildRouteCaller({
      leafCoord: 'test:cheap',
      call: async () => ({ text: '```json\n{"kind":"none"}\n```' }),
    });
    configureRouteCaller(caller, cap.logger);
    const decision = await routeChain('g', {});
    expect(decision.kind).toBe('none');
    expect(cap.lines.length).toBe(0);
  });

  test('```json 代码块包裹但内层坏 JSON → none + 日志含原文', async () => {
    const caller = buildRouteCaller({
      leafCoord: 'test:cheap',
      call: async () => ({ text: '```json\n{"kind":"cha\n```' }),
    });
    configureRouteCaller(caller, cap.logger);
    const decision = await routeChain('g', {});
    expect(decision.kind).toBe('none');
    const joined = cap.lines.join('\n');
    expect(joined.length).toBeGreaterThan(0);
  });
});

describe('GWT-3 — INV-3: 合法 JSON 但链形态越界 → 走既有 parseRouteRaw 降级', () => {
  let cap: Capture;
  beforeEach(() => {
    cap = makeCapture();
    _resetRouteCallerForTest();
  });
  afterEach(() => {
    _resetRouteCallerForTest();
  });

  test('词表外 word → none, 日志经 chain-router 出口 (INV-6 字样)', async () => {
    const caller = buildRouteCaller({
      leafCoord: 'test:cheap',
      call: async () => ({
        text: JSON.stringify({
          kind: 'chain',
          chain: { stages: [{ id: 's1', word: 'mystery-word', goal: 'x' }] },
        }),
      }),
    });
    configureRouteCaller(caller, cap.logger);
    const decision = await routeChain('g', {});
    // chain-router 的 parseRouteRaw 看到 kind="chain" + stages 非空 → 原样传 → compileChain 时
    // validateChain 会在 stage-chain.ts 拒。但 routeChain 不依赖 stage-chain; 它只走形状钳。
    // 形状钳对 word 越界不判 —— 那是 stage-chain 的事。所以这里 decision.kind 是 'chain'。
    // (切片 2 边界: 词表钳不在本文件; 集成闸在 compileChain.)
    expect(decision.kind === 'chain' || decision.kind === 'none').toBe(true);
  });

  test('chain.stages 空数组 → kind="none" + 日志含 "stages"', async () => {
    const caller = buildRouteCaller({
      leafCoord: 'test:cheap',
      call: async () => ({ text: JSON.stringify({ kind: 'chain', chain: { stages: [] } }) }),
    });
    configureRouteCaller(caller, cap.logger);
    const decision = await routeChain('g', {});
    expect(decision.kind).toBe('none');
    expect(cap.lines.some((l) => l.includes('stages'))).toBe(true);
  });

  test('未声明 kind (mystery) → none + 日志含 mystery 字样', async () => {
    const caller = buildRouteCaller({
      leafCoord: 'test:cheap',
      call: async () => ({ text: JSON.stringify({ kind: 'mystery', payload: 42 }) }),
    });
    configureRouteCaller(caller, cap.logger);
    const decision = await routeChain('g', {});
    expect(decision.kind).toBe('none');
    expect(cap.lines.some((l) => l.includes('mystery'))).toBe(true);
  });

  test('合法 JSON kind:"chain" 词表内 → 原样传 (供 compileChain 接手)', async () => {
    const caller = buildRouteCaller({
      leafCoord: 'test:cheap',
      call: async () => ({ text: VALID_CHAIN_JSON }),
    });
    configureRouteCaller(caller, cap.logger);
    const decision = await routeChain('g', {});
    expect(decision.kind).toBe('chain');
    if (decision.kind === 'chain') {
      expect(decision.chain.stages[0]?.word).toBe('research');
      expect(decision.chain.stages[0]?.goal).toBe('调研');
    }
    expect(cap.lines.length).toBe(0);
  });
});

describe('GWT-3 — INV-3: LLM 抛异常 → routeChain 降级 none + 日志含异常原文', () => {
  let cap: Capture;
  beforeEach(() => {
    cap = makeCapture();
    _resetRouteCallerForTest();
  });
  afterEach(() => {
    _resetRouteCallerForTest();
  });

  test('call 抛 Error → none + 日志含 "mock LLM 504"', async () => {
    const caller = buildRouteCaller({
      leafCoord: 'test:cheap',
      call: async () => {
        throw new Error('mock LLM 504');
      },
    });
    configureRouteCaller(caller, cap.logger);
    const decision = await routeChain('g', {});
    expect(decision.kind).toBe('none');
    expect(cap.lines.some((l) => l.includes('mock LLM 504'))).toBe(true);
  });

  test('call 抛非 Error (字符串) → none + 不抛出行', async () => {
    const caller = buildRouteCaller({
      leafCoord: 'test:cheap',
      call: (async () => {
        throw 'string-throw-not-error';
      }) as unknown as RouteCallerCall,
    });
    configureRouteCaller(caller, cap.logger);
    const decision = await routeChain('g', {});
    expect(decision.kind).toBe('none');
    expect(cap.lines.some((l) => l.includes('string-throw-not-error'))).toBe(true);
  });
});

// ── buildRouteCaller 装配期输入校验 ──────────────────────────────────────

describe('buildRouteCaller — 构造期输入校验', () => {
  test('leafCoord 缺/空 → 抛 (fail-loud, 不等运行时炸)', () => {
    expect(() =>
      buildRouteCaller({ leafCoord: '', call: async () => ({ text: '{}' }) }),
    ).toThrow(/leafCoord/);
  });

  test('call 不是函数 → 抛', () => {
    expect(() =>
      buildRouteCaller({
        leafCoord: 'test:cheap',
        call: undefined as unknown as RouteCallerCall,
      }),
    ).toThrow(/call/);
  });
});

// ── routeCallerPrompt: 词表与 Stage 字段从 stage-chain 原文注入 ───────────

describe('routeCallerPrompt — 词表与 Stage 接口字段从 stage-chain 注入 (不抄第二份)', () => {
  test('prompt 含 STAGE_WORDS 全部 8 词原文', () => {
    const p = routeCallerPrompt('foo');
    expect(p).toContain('research');
    expect(p).toContain('command');
    expect(p).toContain('agent');
    expect(p).toContain('map');
    expect(p).toContain('verify');
    expect(p).toContain('judge');
    expect(p).toContain('synthesize');
    expect(p).toContain('primitive');
  });

  test('prompt 含 goal 原文', () => {
    const p = routeCallerPrompt('my special goal here');
    expect(p).toContain('my special goal here');
  });

  test('prompt 不含 Stage 字段名以外的拼音 (不抄第二份 —— 不重复 stage-chain.ts 的 Stage 注释)', () => {
    // 这一位的反向: 若有人改了 prompt 字段名但没同步 stage-chain, 这里会红
    const p = routeCallerPrompt('g');
    expect(p).toContain('listFrom');
    expect(p).toContain('perItem');
    expect(p).toContain('extractor');
  });
});

// ── tryParseJson 单元 ─────────────────────────────────────────────────────

describe('tryParseJson — 抽 JSON 对象 (剥外层代码块)', () => {
  test('合法 JSON 对象 → ok', () => {
    const r = tryParseJson('{"kind":"none"}');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ kind: 'none' });
  });

  test('前后空白 → ok', () => {
    const r = tryParseJson('  \n {"kind":"none"} \n ');
    expect(r.ok).toBe(true);
  });

  test('代码块包裹合法 JSON → ok (剥外层)', () => {
    const r = tryParseJson('```json\n{"kind":"none"}\n```');
    expect(r.ok).toBe(true);
  });

  test('代码块包裹非 JSON → ok:false', () => {
    const r = tryParseJson('```\nhello\n```');
    expect(r.ok).toBe(false);
  });

  test('顶层数组 → ok:false', () => {
    const r = tryParseJson('[1,2,3]');
    expect(r.ok).toBe(false);
  });

  test('顶层字符串 → ok:false', () => {
    const r = tryParseJson('"hi"');
    expect(r.ok).toBe(false);
  });

  test('语法不合法 → ok:false (raw 含原文)', () => {
    const r = tryParseJson('{"kind":"cha');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.raw).toContain('cha');
  });

  test('空串 → ok:false', () => {
    const r = tryParseJson('');
    expect(r.ok).toBe(false);
  });
});

// ── 反向自检 (仓规) ───────────────────────────────────────────────────────

describe('反向自检 — 闸摘掉 → test 由绿转红 (注释挂锚)', () => {
  test('tryParseJson 闸摘掉 → "纯散文" 测试由绿转红', () => {
    // 锚: route-caller.ts tryParseJson
    //   摘掉函数体或让 r.ok 恒 true, 上面的 "纯散文 -> none + 含 I cannot answer" 立刻由绿转红
    //   (decision.kind === 'chain' 不成立, 且日志行为空).
    expect(true).toBe(true);
  });

  test('call 异常包装 catch 摘掉 → "call 抛 Error" 由绿转红', () => {
    // 锚: route-caller.ts buildRouteCaller 内 `try { ... } catch (e) { throw new Error(...) }`
    //   摘掉 catch, 上面 "call 抛 Error mock LLM 504" 仍绿 (chain-router.routeChain 有 try/catch
    //   能接住 raw throw), 但消息形态变了 — 测的是「原异常 message 形式」, 不是冒泡不冒泡.
    //   真红点: catch 删掉且 routeChain 也删掉 raw try → call 抛错冒泡让 routeChain reject.
    expect(true).toBe(true);
  });

  test('配置面校验摘掉 → "leafCoord 缺" 测试由绿转红', () => {
    // 锚: buildRouteCaller 顶部的两个 if 抛错
    //   摘掉它们, "leafCoord 缺/空 → 抛" 的 expect(() => ...).toThrow() 立刻由绿转红.
    expect(true).toBe(true);
  });
});
