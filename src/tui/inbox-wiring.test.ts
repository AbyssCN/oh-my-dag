/**
 * inbox-wiring (片 6 切片 3) —— TUI 收件箱接线的契约。
 *
 * 钉 SDD 片 6 INV-BOX-2/3/4/5/6/7。**测的对象是纯函数**(`decideInboxKey` /
 * `applyInboxAction`), 不是 TUI 的 input listener: 端到端靠 `scripts/tui-pty-check.mjs`
 * (owner 自己跑的那半), 那条路真起一次 PTY 才看得见 —— 这层测不到的是"按下键后到底
 * 落到了哪一行 JS", 而那一族 bug 全在**路由**(路由错就教人撞硬闸 / 静默改内存 /
 * 写完忘重读), 把路由抽成纯函数, 闸就能扫到。
 *
 * 钉的 GWT 列表:
 *   - INV-BOX-2: rule 路径**没有任何**执行触发 (resumeRun / run start 一律 0)。
 *   - INV-BOX-3: rule 的 Enter 开输入框, 输入框 null / '' = 取消 (一个字节都不写)。
 *   - INV-BOX-4: backend.rule 抛 → 返回 error 原文, item 仍在列表里(因为写没成)。
 *   - INV-BOX-5: confirm + Enter → noop (`decideInboxKey` 不返 confirm)。
 *   - INV-BOX-6: node + 'r' → resume; node + 'i' / 's' / Enter → prefill;
 *                node 的 hint 里 i/s 必须带 "prefill" 标注 (INV-BOX-6 的 UI 端)。
 *   - INV-BOX-7: 写完**必须**调 `refreshItems` (注入一个"恒返回原列表"的 reader,
 *                这条必须红 —— 反向自检的着力点)。
 *
 * 反向自检 (实跑过, 改完代码记得跑一遍):
 *   · 把 `decideInboxKey` 里 rule + Enter 改成直接返 `confirm` (抄错位) → "confirm Enter → noop" 红。
 *   · 把 `applyInboxAction` 里 promptRuling === null 那条删掉 → "Esc = 取消, 不写盘" 红。
 *   · 把 `applyInboxAction` 里 catch 块改成返回空 items → "写失败 → item 仍在" 红。
 *   · 把 `applyInboxAction` 里 refreshItems() 全替换成 `[]` (绕过重读) → "INV-BOX-7 反向自检" 红。
 *   · 把 `[closed-by-ruling] ` 前缀挪到 `promptRuling` 那边去 → "x 走 [closed-by-ruling] 前缀" 红。
 *   · 把 node + 'r' 改成 'R' (大小写误) → "node + r → resume" 红。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  applyInboxAction,
  decideInboxKey,
  type ApplyInboxActionDeps,
  type InboxAction,
  type InboxItem,
} from './render/inbox';
import type { PathBackend } from '../harness/pathfinder/backend';
import type { PathMap, SuggestionLogEntry } from '../harness/pathfinder/types';
import type { ConfirmAction } from '../harness/pathfinder/suggest';

// ── 工厂 ──────────────────────────────────────────────────────────────────────

const NOW_ISO = '2026-08-22T12:00:00.000Z';

const ruleItem = (over: Partial<Extract<InboxItem, { kind: 'rule' }>> = {}): Extract<InboxItem, { kind: 'rule' }> => ({
  kind: 'rule',
  slug: 'demo',
  ticketId: '177',
  title: 'do the thing',
  ...over,
});
const confirmItem = (over: Partial<Extract<InboxItem, { kind: 'confirm' }>> = {}): Extract<InboxItem, { kind: 'confirm' }> => ({
  kind: 'confirm',
  slug: 'demo',
  ticketId: '188',
  title: 'suggested thing',
  ...over,
});
const nodeItem = (over: Partial<Extract<InboxItem, { kind: 'node' }>> = {}): Extract<InboxItem, { kind: 'node' }> => ({
  kind: 'node',
  runId: 'aaaaaaaa-1111-2222-3333-444444444444',
  nodeId: 'e1',
  title: 'await node',
  ...over,
});
const takeItem = (over: Partial<Extract<InboxItem, { kind: 'take' }>> = {}): Extract<InboxItem, { kind: 'take' }> => ({
  kind: 'take',
  slug: 'demo',
  ticketId: '200',
  title: 'deliverable',
  ...over,
});

/** 空 PathMap (写侧不需要真图 —— applyInboxAction 直接拿 backend.rule, 不读 map)。 */
const emptyMap = (): PathMap => ({ destination: 'd', slug: 'demo', tickets: [], decisionsLog: [] });

/**
 * mockPathBackend —— 录下写侧调用, 不真碰盘。`kind` 钉 'md' (PathBackend.kind 字面量)。
 * `rule` 默认成功; `confirmSuggestion` 默认成功; 给 `ruleImpl` / `confirmImpl` 注入失败路径。
 */
const mockPathBackend = (opts: {
  ruleImpl?: (cwd: string, slug: string, ticketId: string, ruling: string) => void;
  confirmImpl?: (
    cwd: string,
    slug: string,
    ticketId: string,
    action: ConfirmAction,
    o: { at: string; title?: string },
  ) => void;
  withConfirm?: boolean;
} = {}): PathBackend & {
  ruleCalls: Array<{ cwd: string; slug: string; ticketId: string; ruling: string }>;
  confirmCalls: Array<{ cwd: string; slug: string; ticketId: string; action: ConfirmAction; at: string }>;
} => {
  const ruleCalls: Array<{ cwd: string; slug: string; ticketId: string; ruling: string }> = [];
  const confirmCalls: Array<{
    cwd: string;
    slug: string;
    ticketId: string;
    action: ConfirmAction;
    at: string;
  }> = [];
  const confirmSuggestion: NonNullable<PathBackend['confirmSuggestion']> = (
    cwd,
    slug,
    ticketId,
    action,
    o,
  ): SuggestionLogEntry => {
    if (opts.confirmImpl) {
      opts.confirmImpl(cwd, slug, ticketId, action, o);
      // `confirmImpl` 注入是失败路径, 不必返真 entry —— 但 PathBackend 契约要 entry, 这里造一个最小骨架。
      return {
        at: o.at,
        ticketId,
        outcome: action === 'accept' ? 'accepted' : 'rejected',
        runId: 'mock-run',
      };
    }
    confirmCalls.push({ cwd, slug, ticketId, action, at: o.at });
    return {
      at: o.at,
      ticketId,
      outcome: action === 'accept' ? 'accepted' : 'rejected',
      runId: 'mock-run',
    };
  };
  const b: PathBackend = {
    kind: 'md',
    listMaps: () => [],
    readMap: () => null,
    createMap: () => emptyMap(),
    addTicket: () => {
      throw new Error('not used');
    },
    rule: (cwd, slug, ticketId, ruling): void => {
      if (opts.ruleImpl) return opts.ruleImpl(cwd, slug, ticketId, ruling);
      ruleCalls.push({ cwd, slug, ticketId, ruling });
    },
    collectResearchResults: () => [],
    ackResearchResult: (): void => {},
    markDelivered: (): void => {},
    ...(opts.withConfirm === false ? {} : { confirmSuggestion }),
  };
  return Object.assign(b, { ruleCalls, confirmCalls });
};

/** 录下 error, 回来断言 INV-BOX-4 "原文上屏"。 */
let lastError: string | null = null;
const captureOnError = (reason: string): void => {
  lastError = reason;
};

const baseDeps = (backend: PathBackend, refreshItems: () => Promise<readonly InboxItem[]>): ApplyInboxActionDeps => ({
  cwd: '/fake',
  backend,
  promptRuling: async () => null, // 默认 Esc, 验证"取消"那条路
  nowIso: () => NOW_ISO,
  refreshItems,
  onError: captureOnError,
});

beforeEach(() => {
  lastError = null;
});

// ── decideInboxKey (路由层) ────────────────────────────────────────────────────

describe('INV-BOX-3 · rule 的 Enter 走 rule-input (开输入框), 不直接落', () => {
  test('rule + Enter (\\r) → rule-input, closedByRuling=false', () => {
    const item = ruleItem();
    const r = decideInboxKey({ items: [item], selected: 0, key: '\r' });
    expect(r).toEqual({ kind: 'rule-input', item, closedByRuling: false });
  });
  test('rule + Enter (\\n) 同样走 rule-input', () => {
    const r = decideInboxKey({ items: [ruleItem()], selected: 0, key: '\n' });
    expect(r.kind).toBe('rule-input');
  });
  test('rule + x → rule-input, closedByRuling=true (走 [closed-by-ruling] 前缀)', () => {
    const item = ruleItem();
    const r = decideInboxKey({ items: [item], selected: 0, key: 'x' });
    expect(r).toEqual({ kind: 'rule-input', item, closedByRuling: true });
  });
  test('rule + c → noop (c 是 confirm 的 accept, 不是 rule 的动作)', () => {
    expect(decideInboxKey({ items: [ruleItem()], selected: 0, key: 'c' }).kind).toBe('noop');
  });
  test('rule + r → noop (r 是 node 的 resume, rule 没接这条线)', () => {
    expect(decideInboxKey({ items: [ruleItem()], selected: 0, key: 'r' }).kind).toBe('noop');
  });
});

describe('INV-BOX-5 · confirm 的 Enter 不在动作里 (c / x 才是)', () => {
  test('confirm + Enter → noop (这是 pathfinder.ts:503 那条硬闸的反面 —— UI 不许给人撞)', () => {
    expect(decideInboxKey({ items: [confirmItem()], selected: 0, key: '\r' }).kind).toBe('noop');
  });
  test('confirm + c → confirm, action=accept', () => {
    const item = confirmItem();
    expect(decideInboxKey({ items: [item], selected: 0, key: 'c' })).toEqual({
      kind: 'confirm',
      item,
      action: 'accept',
    });
  });
  test('confirm + x → confirm, action=reject', () => {
    const item = confirmItem();
    expect(decideInboxKey({ items: [item], selected: 0, key: 'x' })).toEqual({
      kind: 'confirm',
      item,
      action: 'reject',
    });
  });
});

describe('INV-BOX-6 · node 只接 r 真接线; i / s / Enter 全部 prefill', () => {
  test('node + r → resume (真接线: 走 OmdBackend.resumeRun, 不走 PathBackend)', () => {
    const item = nodeItem();
    expect(decideInboxKey({ items: [item], selected: 0, key: 'r' })).toEqual({
      kind: 'resume',
      item,
    });
  });
  test('node + R (大写) 同样 → resume', () => {
    const item = nodeItem();
    expect(decideInboxKey({ items: [item], selected: 0, key: 'R' })).toEqual({
      kind: 'resume',
      item,
    });
  });
  /**
   * ★ **2026-08-22(片 7)更正:`i` / `s` 已经真接线,这两条原本钉的是「它们还没接」。**
   *
   * 片 6 写它们时 `OmdBackend` 上没有 cancel/intervene,于是 INV-BOX-6 定的是
   * 「只有 `r` 真接线,`i`/`s` 预填并在屏上明说」。片 7 查清楚了写侧其实都在
   * (`dag_intervene` 的全部身体是 `appendBoard` 追一条;`dag_cancel` 对 detached run
   * 是「写 `.omd/continuity/<runId>/cancel` + 对属主 pid SIGTERM」),于是接上了。
   *
   * ⚠ 这两条真正管的事**没变**:**键位分派得分得开,不许合并成一个 prefill 兜底**。
   * 合并了就等于「按哪个键都一样」,而那三个键的后果完全不同(记一条 / 停一张图 / 续跑)。
   * 所以这里改成逐键钉住它各自的 action kind。
   *
   * 证伪:把 `decideInboxKey` 里 `i`/`s` 那两支删掉让它们落回 `prefill` → 本条当场红。
   */
  test('★ node 的三个键各走各的路 (i 记一条 / s 停图 / r 续跑), 不许合并成一个兜底', () => {
    const item = nodeItem();
    expect(decideInboxKey({ items: [item], selected: 0, key: 'i' })).toEqual({ kind: 'intervene', item });
    expect(decideInboxKey({ items: [item], selected: 0, key: 's' })).toEqual({ kind: 'cancel', item });
    expect(decideInboxKey({ items: [item], selected: 0, key: 'r' })).toEqual({ kind: 'resume', item });
    // Enter 仍是预填 —— node 类没有「就地做完」的语义, 它要你去看那张图。
    expect(decideInboxKey({ items: [item], selected: 0, key: '\r' })).toEqual({ kind: 'prefill', item });
  });
  test('node + Enter → prefill (ENTER 之外的真接线只有 r)', () => {
    const item = nodeItem();
    expect(decideInboxKey({ items: [item], selected: 0, key: '\r' })).toEqual({
      kind: 'prefill',
      item,
    });
  });
});

describe('take · 本片非目标 (任何键都 prefill)', () => {
  test('take + Enter → prefill', () => {
    const item = takeItem();
    expect(decideInboxKey({ items: [item], selected: 0, key: '\r' })).toEqual({
      kind: 'prefill',
      item,
    });
  });
});

describe('decideInboxKey · 杂项', () => {
  test('空 items → noop (越界 / 空仓不该静默返 null —— 那更难查)', () => {
    expect(decideInboxKey({ items: [], selected: 0, key: '\r' }).kind).toBe('noop');
  });
  test('selected 越界 / 负数 → 自动 mod (与 renderer 同口径)', () => {
    const item = ruleItem();
    expect(decideInboxKey({ items: [item], selected: 1, key: '\r' })).toEqual({
      kind: 'rule-input',
      item,
      closedByRuling: false,
    });
    expect(decideInboxKey({ items: [item], selected: -3, key: '\r' })).toEqual({
      kind: 'rule-input',
      item,
      closedByRuling: false,
    });
  });
});

// ── applyInboxAction (执行层) ──────────────────────────────────────────────────

describe('INV-BOX-3 · rule-input 走 promptRuling; null / 空 = 取消, 不写盘', () => {
  test('promptRuling → null (Esc): backend.rule 一行都不调', async () => {
    const backend = mockPathBackend();
    const items = [ruleItem()];
    const r = await applyInboxAction(
      { kind: 'rule-input', item: items[0]!, closedByRuling: false },
      baseDeps(backend, async () => items),
    );
    expect(backend.ruleCalls).toHaveLength(0);
    expect(r.error).toBeUndefined();
  });
  test('promptRuling → "" (空串): 同样不写盘', async () => {
    const backend = mockPathBackend();
    const items = [ruleItem()];
    const r = await applyInboxAction(
      { kind: 'rule-input', item: items[0]!, closedByRuling: false },
      { ...baseDeps(backend, async () => items), promptRuling: async () => '' },
    );
    expect(backend.ruleCalls).toHaveLength(0);
    expect(r.error).toBeUndefined();
  });
  test('promptRuling → "   " (全空白): trim 之后空 = 取消', async () => {
    const backend = mockPathBackend();
    const items = [ruleItem()];
    const r = await applyInboxAction(
      { kind: 'rule-input', item: items[0]!, closedByRuling: false },
      { ...baseDeps(backend, async () => items), promptRuling: async () => '   \t\n' },
    );
    expect(backend.ruleCalls).toHaveLength(0);
    expect(r.error).toBeUndefined();
  });
  test('promptRuling → "build a bench": backend.rule 收到 ruling=原字, closedByRuling=false', async () => {
    const backend = mockPathBackend();
    const items = [ruleItem({ ticketId: 't1' })];
    await applyInboxAction(
      { kind: 'rule-input', item: items[0]!, closedByRuling: false },
      { ...baseDeps(backend, async () => items), promptRuling: async () => 'build a bench' },
    );
    expect(backend.ruleCalls).toEqual([{ cwd: '/fake', slug: 'demo', ticketId: 't1', ruling: 'build a bench' }]);
  });
  test('promptRuling → "build a bench" with closedByRuling=true: ruling = "[closed-by-ruling] build a bench" (字面前缀, pathfinder.ts:501)', async () => {
    const backend = mockPathBackend();
    const items = [ruleItem({ ticketId: 't1' })];
    await applyInboxAction(
      { kind: 'rule-input', item: items[0]!, closedByRuling: true },
      { ...baseDeps(backend, async () => items), promptRuling: async () => 'build a bench' },
    );
    expect(backend.ruleCalls).toEqual([
      { cwd: '/fake', slug: 'demo', ticketId: 't1', ruling: '[closed-by-ruling] build a bench' },
    ]);
  });
});

describe('INV-BOX-4 · backend.rule 抛了 → error 原文, item 仍在列表', () => {
  test('rule 抛 → 返回 error = 原文, onError 被调, refreshItems 仍被调 (item 留在盘上)', async () => {
    const items = [ruleItem({ ticketId: 'bad' })];
    const backend = mockPathBackend({
      ruleImpl: () => {
        throw new Error('票 "bad" 不存在');
      },
    });
    const r = await applyInboxAction(
      { kind: 'rule-input', item: items[0]!, closedByRuling: false },
      { ...baseDeps(backend, async () => items), promptRuling: async () => 'go' },
    );
    expect(r.error).toBe('票 "bad" 不存在');
    expect(lastError).toBe('票 "bad" 不存在'); // 不吞证据 (fail-open 不吞证据)
    expect(r.items).toEqual(items); // 写没成 → 盘上没变 → 重读还是原样
  });
  test('confirm 抛 → 同样返回 error 原文', async () => {
    const items = [confirmItem({ ticketId: '188' })];
    const backend = mockPathBackend({
      confirmImpl: () => {
        throw new Error('issue 188 已 archived');
      },
    });
    const r = await applyInboxAction(
      { kind: 'confirm', item: items[0]!, action: 'accept' },
      baseDeps(backend, async () => items),
    );
    expect(r.error).toBe('issue 188 已 archived');
    expect(lastError).toBe('issue 188 已 archived');
  });
});

describe('INV-BOX-2 · rule 路径里没有任何执行触发 (run 一律不启)', () => {
  test('rule 写完之后, mock 后端上**只有** rule 这条调用, 没有 markDelivered / 没有别的', async () => {
    const backend = mockPathBackend();
    const items = [ruleItem({ ticketId: 't9' })];
    await applyInboxAction(
      { kind: 'rule-input', item: items[0]!, closedByRuling: false },
      { ...baseDeps(backend, async () => items), promptRuling: async () => 'go' },
    );
    // 显式枚举后端暴露的写方法, 验证只有 rule 被调到。
    // (其它方法在 mockPathBackend 上是 no-op, 但**没有**接到这条路径里 —— markDelivered
    //  是 close 路才接, INV-BOX-2 的 "rule ≠ 执行" 就是说: 没有那种复合副作用。)
    expect(backend.ruleCalls).toHaveLength(1);
  });
});

describe('INV-BOX-7 · 写完必须调 refreshItems (反向自检)', () => {
  test('rule 成功后 refreshItems 被调, 它的返回值就是结果里的 items', async () => {
    const backend = mockPathBackend();
    const before = [ruleItem({ ticketId: 't1' })];
    const after: InboxItem[] = []; // 裁完 → 盘上没了
    let calls = 0;
    await applyInboxAction(
      { kind: 'rule-input', item: before[0]!, closedByRuling: false },
      {
        ...baseDeps(backend, async () => {
          calls++;
          return after;
        }),
        promptRuling: async () => 'go',
      },
    );
    expect(calls).toBeGreaterThanOrEqual(1);
  });

  test('★ 反向自检: 把 refreshItems 钉成 "恒返回原列表", 写完后 items **仍是原列表** —— 证明走的是重读而不是内存改写', async () => {
    const backend = mockPathBackend();
    const before = [ruleItem({ ticketId: 't1' })];
    // 这是反向自检的精髓: 即使 rule 真的"成功了", 只要 refreshItems 不返"那张票没了",
    // 结果里就**还有那张票** —— 那就是钉死了"写完必须重读盘"。
    const r = await applyInboxAction(
      { kind: 'rule-input', item: before[0]!, closedByRuling: false },
      { ...baseDeps(backend, async () => before), promptRuling: async () => 'go' },
    );
    expect(r.items).toEqual(before); // 重读没反映 → 列表没变 → 写动作的"消失"完全来自重读
    expect(backend.ruleCalls).toHaveLength(1); // 但 rule 确实被调了 (证明是写完重读, 不是被绕过)
  });

  test('★ 反向自检: 写失败时 refreshItems 也要被调 (失败路径也要重读, 不许在内存里假装', async () => {
    const backend = mockPathBackend({
      ruleImpl: () => {
        throw new Error('boom');
      },
    });
    const before = [ruleItem({ ticketId: 't1' })];
    let calls = 0;
    const r = await applyInboxAction(
      { kind: 'rule-input', item: before[0]!, closedByRuling: false },
      {
        ...baseDeps(backend, async () => {
          calls++;
          return before;
        }),
        promptRuling: async () => 'go',
      },
    );
    expect(calls).toBeGreaterThanOrEqual(1);
    expect(r.error).toBe('boom');
    expect(r.items).toEqual(before); // 失败也走重读 → 列表就是 refreshItems 返的
  });
});

describe('applyInboxAction · noop / prefill / resume 一律走 refreshItems (不写盘, 不算错)', () => {
  test('noop → refreshItems 被调, error undefined', async () => {
    const backend = mockPathBackend();
    const items: InboxItem[] = [];
    let calls = 0;
    const r = await applyInboxAction({ kind: 'noop' }, {
      ...baseDeps(backend, async () => {
        calls++;
        return items;
      }),
    });
    expect(calls).toBe(1);
    expect(r.error).toBeUndefined();
    expect(r.items).toEqual([]);
  });
  test('prefill → refreshItems 被调, backend 没碰', async () => {
    const backend = mockPathBackend();
    const items = [nodeItem()];
    let calls = 0;
    const r = await applyInboxAction({ kind: 'prefill', item: items[0]! }, {
      ...baseDeps(backend, async () => {
        calls++;
        return items;
      }),
    });
    expect(calls).toBe(1);
    expect(backend.ruleCalls).toHaveLength(0);
    expect(r.error).toBeUndefined();
  });
  test('resume → refreshItems 被调, backend.path-rule 没碰 (resume 走 OmdBackend 不走 PathBackend)', async () => {
    const backend = mockPathBackend();
    const items = [nodeItem()];
    let calls = 0;
    const r = await applyInboxAction({ kind: 'resume', item: items[0]! }, {
      ...baseDeps(backend, async () => {
        calls++;
        return items;
      }),
    });
    expect(calls).toBe(1);
    expect(backend.ruleCalls).toHaveLength(0);
    expect(r.error).toBeUndefined();
  });
});

describe('confirm 路径 · confirmSuggestion 签名逐字 (cwd/slug/ticketId/action/at)', () => {
  test('c → action=accept, x → action=reject', async () => {
    const backend = mockPathBackend();
    const items = [confirmItem({ ticketId: '188' })];
    await applyInboxAction(
      { kind: 'confirm', item: items[0]!, action: 'accept' },
      baseDeps(backend, async () => items),
    );
    await applyInboxAction(
      { kind: 'confirm', item: items[0]!, action: 'reject' },
      baseDeps(backend, async () => items),
    );
    expect(backend.confirmCalls).toEqual([
      { cwd: '/fake', slug: 'demo', ticketId: '188', action: 'accept', at: NOW_ISO },
      { cwd: '/fake', slug: 'demo', ticketId: '188', action: 'reject', at: NOW_ISO },
    ]);
  });
  test('后端没 confirmSuggestion → 返回 error, refreshItems 仍调', async () => {
    const backend = mockPathBackend({ withConfirm: false });
    const items = [confirmItem()];
    let calls = 0;
    const r = await applyInboxAction(
      { kind: 'confirm', item: items[0]!, action: 'accept' },
      {
        ...baseDeps(backend, async () => {
          calls++;
          return items;
        }),
      },
    );
    expect(calls).toBeGreaterThanOrEqual(1);
    expect(r.error).toContain('confirmSuggestion');
  });
});

// ── 给 INV-BOX-6 的渲染侧 (renderer 那条测试不在本片写集, 但本片接入要 pin) ───

describe('INV-BOX-6 · renderer 那侧 i / s 必须带 "prefill" 标注 (本片 pin 是端到端保险)', () => {
  // 渲染那条测试见 `render/inbox.test.ts`, 但本片也 pin 一遍: 避免以后有人把 i / s
  // 真接线后忘了改文案。直接 import renderInbox —— 与 inbox.ts 同模块同源。
  test('node + i / s 字面带 "prefill", r 不带 (INV-BOX-6: 不画一个点了没反应的入口)', async () => {
    const { renderInbox } = await import('./render/inbox');
    const out = renderInbox([nodeItem()], { width: 100, height: 30, selected: 0, now: 1_700_000_000_000 });
    const body = out.join('\n');
    // 2026-08-22(片 7): `i`/`s` 接真之后标注从 `prefill` 换成它们真做的事。
    // ⚠ 这条闸管的是**屏上说的与实际做的一致**, 不是那个词 —— 所以现在反过来钉:
    //   `i` 说 record(它只往公告板追一条, **不标绿任何东西**),
    //   `s` 说 stop 且带 confirm 提示(二次确认, INV-RC-3),
    //   而**整段不许再出现 `prefill`**(那是接线前的说法)。
    expect(body).toMatch(/i\s+record/);
    expect(body).toMatch(/s\s+stop/);
    expect(body).not.toContain('prefill');
    // r 那段必须不带 "prefill" —— 它是真接线, 不该混进预填字样。
    expect(body).toMatch(/r\s+resume/); // r resume 头, 但 r 后面不带 prefill
  });
});

afterEach(() => {
  lastError = null;
});
