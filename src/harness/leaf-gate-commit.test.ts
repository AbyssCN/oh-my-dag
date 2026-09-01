/**
 * leaf 装配期闸事务 (commit) + 闸在场态 (缺席即具名) 的契约测试。
 *
 * 治的是一个**已实测发作过**的形态 (原文在 `writeset/touch-ledger.ts:27`, 2026-08-25 本仓主树库):
 * 碰撞台账 `rows=2924` 而 `strict=0 / inferred=0` —— agent 工具面一条都没记进来, 成因是装配处
 * 条件 spread 把 `touch` 键丢了。**leaf 照跑, tsc 干净, 测试全绿, 没有任何东西红。**
 *
 * 反向自检 (哪条接线被拆, 哪条断言红):
 *  - 删 `createAgentLeafRunner` 里的 `commitLeafGates(...)` 调用 → 用例 ①b 红;
 *  - `commitLeafGates` 里摘掉 touch / writeAllow / mcp / fileObservations 任一分支 →
 *    用例 ②/③/④/④c 对应那条红;
 *  - 把 `commitLeafGates` 的 writeAllow 判据从"读 ALS 哨兵"降成"是个函数就算过" → 用例 ③ 红
 *    (烤死在装配期的 thunk 会被放行);
 *  - 把第四道闸的判据从**对象身份** (`obs !== probeObservations`) 降成"是不是 Map" → 用例 ④c 红
 *    (每次新建 Map 的烤死 thunk 会被放行 —— 那正是它要抓的形态);
 *  - 把 wrapper 里结果上的 `gates` 摘掉 → 用例 ⑥ 红;
 *  - 把 `leafGateStates` 的 writeAllow 判据从 `!== undefined` 改成看长度 (把 `[]` 读成缺席) →
 *    用例 ⑤/⑥ 红 (NULL≠0: 声明了"什么都不许写" ≠ 没配这道闸)。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { commitLeafGates, createAgentLeafRunner, leafGateStates, type LeafCallScope, type LeafGateWiring } from './agent-leaf';

const MODEL = 'claude-code:claude-sonnet-5';
let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'omd-leaf-gate-'));
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

// SDK 假件 (形状照 agent-leaf-sdk.test.ts) —— 只为把一发 leaf 真跑完, 不发真请求。
const asst = (text: string): SDKMessage =>
  ({
    type: 'assistant',
    session_id: 's',
    message: {
      content: [{ type: 'text', text }],
      usage: { input_tokens: 20, output_tokens: 9, cache_read_input_tokens: 5, cache_creation_input_tokens: 4 },
      stop_reason: 'end_turn',
    },
  }) as unknown as SDKMessage;
const success = (): SDKMessage =>
  ({ type: 'result', subtype: 'success', result: 'done', session_id: 's', usage: {} }) as unknown as SDKMessage;
const fakeQuery = (script: SDKMessage[]) => (_props: { prompt: string; options: Options }) =>
  (async function* () {
    for (const m of script) yield m;
  })();

/** 接好线的那一份 (= 生产装配的形状), 各条用例在它上面**只拆一处**。 */
function wiredHanded(store: AsyncLocalStorage<LeafCallScope | undefined>): LeafGateWiring {
  return {
    agentTools: {
      writeAllow: () => store.getStore()?.writeAllow,
      touch: { session: () => store.getStore()?.session },
      fileObservations: () => store.getStore()?.fileObservations,
    },
    mcpTools: {
      policy: () => {
        const allow = store.getStore()?.mcpAllow;
        return allow && allow.length > 0 ? { sideEffects: { allow } } : { sideEffects: 'deny' };
      },
    },
  };
}

describe('装配期闸事务 (commit): 闸装不上, 这个节点就不发布', () => {
  test('★① 生产装配路径过 commit —— 三道闸都真接上了 (闸不能挡住正常的活)', () => {
    expect(() => createAgentLeafRunner({ cwd, sdkQueryFn: fakeQuery([asst('x'), success()]) })).not.toThrow();
  });

  /**
   * ①b commit **真的挂在生产装配路上**。
   *
   * 为什么只能这么钉: 生产路径结构上造不出"接线断了"的 runner (断线要靠改源码), 于是"这道闸
   * 在不在那条路上"没有运行期可观察面 —— 只能看那条路本身。删掉调用行 → 本条当场红。
   */
  test('★①b commit 挂在 createAgentLeafRunner 的装配段上 (删掉调用行本条红)', () => {
    expect(createAgentLeafRunner.toString()).toContain('commitLeafGates(');
  });

  test('★② 键丢了 (条件 spread 把 touch 抹掉 —— 2026-08-25 台账缺口的真实形态) → 当场抛', () => {
    const store = new AsyncLocalStorage<LeafCallScope | undefined>();
    const handed = wiredHanded(store);
    delete handed.agentTools.touch; // 唯一改动: 把 touch 键拿掉
    expect(() => commitLeafGates(store, handed)).toThrow(/touchSession/);
  });

  test('★③ getter 烤死在装配期 (不读 per-call ALS) → 当场抛; 类型一样过, 后果是拿上个节点的写集判这个', () => {
    const store = new AsyncLocalStorage<LeafCallScope | undefined>();
    const handed = wiredHanded(store);
    const baked = ['src/固定不动.ts']; // 装配期烤进去的常量写集
    handed.agentTools.writeAllow = () => baked;
    expect(() => commitLeafGates(store, handed)).toThrow(/writeAllow/);
  });

  test('★④ MCP 授权清单读不到 → 当场抛', () => {
    const store = new AsyncLocalStorage<LeafCallScope | undefined>();
    const handed = wiredHanded(store);
    handed.mcpTools.policy = undefined;
    expect(() => commitLeafGates(store, handed)).toThrow(/mcpAllow/);
  });

  test('★④c 版本守卫的观察台键丢了 → 当场抛 (第四道闸, 2026-09-01)', () => {
    const store = new AsyncLocalStorage<LeafCallScope | undefined>();
    const handed = wiredHanded(store);
    delete handed.agentTools.fileObservations; // 唯一改动: 条件 spread 把这个键抹掉
    expect(() => commitLeafGates(store, handed)).toThrow(/fileObservations/);
  });

  test('★④d 观察台 getter 烤死在装配期 (每次新建 Map, 不读 ALS) → 当场抛', () => {
    // 这是第四道闸**独有**的形态: 返回值也是个 Map, "是不是 Map" 判不出来, 只有对象身份判得出。
    // 后果比断线更糟 —— 观察台跨调用不共享, 每次写都判 NOT_OBSERVED, 闸看起来"很严格"而其实全是假阳性;
    // 反过来若指向同一个常量 Map, 则拿上一个节点看过的版本放行这一个 (真阴性)。两种都由这条抓。
    const store = new AsyncLocalStorage<LeafCallScope | undefined>();
    const handed = wiredHanded(store);
    handed.agentTools.fileObservations = () => new Map();
    expect(() => commitLeafGates(store, handed)).toThrow(/fileObservations/);
  });

  test('★④b 四条全断 → 判词把四条**一次报全** (报一条就跑 = 修完一条再撞一次)', () => {
    const store = new AsyncLocalStorage<LeafCallScope | undefined>();
    let err = '';
    try {
      commitLeafGates(store, { agentTools: {}, mcpTools: {} });
    } catch (e) {
      err = (e as Error).message;
    }
    expect(err).toContain('touchSession');
    expect(err).toContain('writeAllow');
    expect(err).toContain('mcpAllow');
    expect(err).toContain('fileObservations');
  });
});

describe('闸在场态: 缺席是一个有名字的值', () => {
  test('★⑤ 判据是「判据面在不在」, 不是「判出没判出问题」—— `[]` 是 enforced, undefined 才是 unavailable', () => {
    expect(leafGateStates({}, {})).toEqual({ writeAllow: 'unavailable', mcpAllow: 'unavailable', touchSession: 'unavailable' });
    // 写集 `[]` = 声明了"什么都不许写" —— 与"没配这道闸"是两件事 (NULL≠0≠不适用)。
    expect(leafGateStates({ writeAllow: [] }, {}).writeAllow).toBe('enforced');
    // mcpAllow 空清单在 leafMcpPolicy 那里就等于没声明 (deny 全部) → 这里同判 unavailable。
    expect(leafGateStates({ mcpAllow: [] }, {}).mcpAllow).toBe('unavailable');
    expect(leafGateStates({ mcpAllow: ['t'] }, {}).mcpAllow).toBe('enforced');
    expect(leafGateStates({ touchSession: 'run:node' }, {}).touchSession).toBe('enforced');
    // runner 级兜底也算配了 —— 只看 input 会把它误报成缺席 (三个 getter 都是 store ?? opts 形)。
    expect(leafGateStates({}, { writeAllow: ['a.ts'], touch: { session: 's' } })).toEqual({
      writeAllow: 'enforced',
      mcpAllow: 'unavailable',
      touchSession: 'enforced',
    });
  });

  test('★⑥ 在场态随结果出 leaf —— 读结果的人分得开「写闸没配」与「配了且没越界」', async () => {
    const run = createAgentLeafRunner({ cwd, sdkQueryFn: fakeQuery([asst('改完了'), success()]) });
    const bare = await run({ prompt: 'p', model: MODEL });
    expect(bare.gates).toEqual({ writeAllow: 'unavailable', mcpAllow: 'unavailable', touchSession: 'unavailable' });
    // 同一个 runner、同一发假件: 只有闸的声明面变了 —— 结果里那三格必须跟着变。
    const gated = await run({ prompt: 'p', model: MODEL, writeAllow: [], mcpAllow: ['t'], touchSession: 'run:node' });
    expect(gated.gates).toEqual({ writeAllow: 'enforced', mcpAllow: 'enforced', touchSession: 'enforced' });
    // 两发都没撞过闸 → writeDenials 两边都缺席: 这正是"缺席与合规长得一样"的那一格, 它自己分不开。
    expect(bare.writeDenials).toBeUndefined();
    expect(gated.writeDenials).toBeUndefined();
  });
});
