/**
 * src/harness/inventory/resolve.test —— INV-2 三态解析器单元测试 (S1/片 1)。
 *
 * 契约来源: src/harness/inventory/resolve.ts L11-16 (INV-2 字面照搬);
 * 形参与返回类型 L28-31 / L44-47。本测试:
 *   ① 全限定 id `<source>:<name>@<semver>` 直查命中 (state='resolved');
 *   ② 裸名在 entries 中全局唯一 → state='resolved';
 *   ③ A、B 两源同名 capture → 裸名 resolve 返回 state='ambiguous',
 *      candidates = 两条全限定 id, 排序 = entries 输入序 (不按 source/version/
 *      owner_pinned/oracle_bearing/注册顺序之外的任何优先级选边), 长度严格 = 2
 *      —— 供 PP-T02 tool_ambiguous 消费;
 *   ④ 未注册名 → state='miss', 候选数组不存在; 同时证伪近似/子串/Levenshtein
 *      这类「未命中却返回近似候选」的违规实现路径;
 *   ⑤ 未升格 (discovered-set only) 条目被引用 → state='miss', 即 plan-critic 消费
 *      时映射到 PP-T01 tool_unresolved 的字面空集 —— 调用方传 working-set 快照,
 *      discovered-only 条目缺席 = miss (INV-1 收敛一致)。
 *
 * 断言统一断返回值形状 (toEqual), 不只断 truthy —— shape assertion 是约束
 * 字段集合 (state / entry / candidates) 互斥与在场性的唯一可靠方式。
 *
 * Implementation gap (本测试未改实装, 仅在节点输出登记): 若实装引入按 source
 * 字面长度 / 注册时间排序的「tie-break」, ③ 会红; 若允许空字符串名或空 ID_RE
 * 命中后回退到裸名再查, ① 会红; 若未命中却降级返回任意一个候选, ④ 会红。
 */
import { describe, expect, test } from 'bun:test';
import type { InventoryEntry } from './inventory';
import { resolve } from './resolve';

// ─── InventoryEntry 工厂 ──────────────────────────────────────────────────────
// 字段顺序与 InventoryEntrySchema 严格一致 (zod schema 锁定, INV-S1-7);
// 23 个必填 + 1 个可选 (failure_reason)。测试只覆盖 resolve 模块, 不走 zod 解析,
// 因此 entry 作为 `InventoryEntry` 直接传入即可。
function makeEntry(over: {
  id: string;
  name: string;
  effect?: InventoryEntry['effect'];
  cost_tier?: InventoryEntry['cost_tier'];
  owner_pinned?: boolean;
  oracle_bearing?: boolean;
  failure_reason?: string;
}): InventoryEntry {
  const now = '2026-01-01T00:00:00Z';
  return {
    id: over.id,
    name: over.name,
    when_to_use: `use ${over.name}`,
    effect: over.effect ?? 'read',
    safety_class: 'safe',
    cost_tier: over.cost_tier ?? 't0',
    defer_mode: 'eager',
    signature: { inputs: [], outputs: [] },
    oracle: { kind: 'command', gateScriptRef: 'check.sh' },
    probe_state: 'UNPROBED',
    applicability: 'APPLICABLE',
    ...(over.failure_reason !== undefined ? { failure_reason: over.failure_reason } : {}),
    idle_days: 0,
    provenance: {
      registered_at: now,
      registered_by: 'test',
      source_repo: 'repo',
      source_path: `tools/${over.name}.ts`,
      commit_sha: 'a'.repeat(40),
      import_method: 'manual',
      imported_at: now,
      imported_by: 'test',
      upstream_version: '1.0.0',
      content_sha256: 'b'.repeat(64),
      schema_version: '1.0',
    },
    search_hint: over.name,
    owner_pinned: over.owner_pinned ?? false,
    oracle_bearing: over.oracle_bearing ?? false,
  };
}

describe("INV-2 resolve —— resolve.ts 三态解析器 (供 plan-critic PP-T01/PP-T02 消费)", () => {
  // ── ① 全限定 id 直查命中 ─────────────────────────────────────────────────
  test('① 全限定 id `<source>:<name>@<semver>` 直查 → state=resolved, entry 字面相等', () => {
    const target = makeEntry({ id: 'core:foo@1.0.0', name: 'foo' });
    const other = makeEntry({ id: 'core:bar@1.0.0', name: 'bar' });
    const r = resolve('core:foo@1.0.0', [other, target]);
    expect(r).toEqual({ state: 'resolved', entry: target });
    // 显式断 key 集合: resolved 形态不得携带 candidates (判别联合互斥)
    expect('candidates' in r).toBe(false);
  });

  test('① 直查命中的版本号必须字面相等, semver 元信息 (pre-release/build) 不允许前缀匹配', () => {
    const target = makeEntry({ id: 'core:foo@1.0.0', name: 'foo' });
    const wrongVer = makeEntry({ id: 'core:foo@1.0.0-alpha', name: 'foo' });
    const wrongMajor = makeEntry({ id: 'core:foo@2.0.0', name: 'foo' });
    expect(resolve('core:foo@1.0.0', [wrongVer, wrongMajor, target])).toEqual({
      state: 'resolved',
      entry: target,
    });
    // pre-release 版本必须包含在 entries 才能命中 —— 这里显式把 wrongVer 纳入
    expect(resolve('core:foo@1.0.0-alpha', [wrongVer, target, wrongMajor])).toEqual({
      state: 'resolved',
      entry: wrongVer,
    });
    // 不存在的版本字面 → miss (不向裸名回退, 否则「直查命中」语义失效)
    expect(resolve('core:foo@9.9.9', [target])).toEqual({ state: 'miss' });
  });

  // ── ② 裸名全局唯一 → resolve ─────────────────────────────────────────────
  test('② 裸名在 entries 中全局唯一 → state=resolved, entry 字面相等', () => {
    const foo = makeEntry({ id: 'core:foo@1.0.0', name: 'foo' });
    const bar = makeEntry({ id: 'core:bar@1.0.0', name: 'bar' });
    const r = resolve('foo', [foo, bar]);
    expect(r).toEqual({ state: 'resolved', entry: foo });
    expect('candidates' in r).toBe(false);
  });

  test('② 裸名字面相等, 即使 source / version / owner_pinned / oracle_bearing 各异也命中 (单条仍 resolved)', () => {
    const a = makeEntry({
      id: 'A:foo@1.0.0',
      name: 'foo',
      owner_pinned: true,
      oracle_bearing: true,
    });
    // 仅 a 在 entries → 唯一命中; 不撞名的 unrelated 条目不参与判定
    const unrelated = makeEntry({ id: 'X:bar@1.0.0', name: 'bar' });
    expect(resolve('foo', [a, unrelated])).toEqual({ state: 'resolved', entry: a });
  });

  // ── ③ 多源同名 capture → ambiguous, 不按任何优先级选边 ────────────────────
  test('③ A、B 两源同名 capture → 裸名 resolve 返回 state=ambiguous, 候选 = 两全限定 id', () => {
    const aFoo = makeEntry({ id: 'A:foo@1.0.0', name: 'foo', owner_pinned: true });
    const bFoo = makeEntry({ id: 'B:foo@1.0.0', name: 'foo', owner_pinned: false });
    const unrelated = makeEntry({ id: 'C:bar@1.0.0', name: 'bar' });
    const r = resolve('foo', [aFoo, bFoo, unrelated]);
    expect(r.state).toBe('ambiguous');
    if (r.state !== 'ambiguous') throw new Error('shape guard');
    // 长度严格 = 2 (不止 1, 不少 1, 不附加额外候选)
    expect(r.candidates).toHaveLength(2);
    // 顺序与 entries 输入序一致 (函数实现是 matches.map((e) => e.id))
    expect(r.candidates).toEqual(['A:foo@1.0.0', 'B:foo@1.0.0']);
    // 必须包含两条全限定 id —— 不允许「按 source/version/owner_pinned/oracle_bearing
    // 任一项排序后只返回首条」的违规实现漏掉另一条
    expect(r.candidates).toEqual(expect.arrayContaining(['A:foo@1.0.0', 'B:foo@1.0.0']));
    // ambiguous 形态不得携带 entry (判别联合互斥)
    expect('entry' in r).toBe(false);
  });

  test('③ 顺序倒置输入 → 候选序反映输入序, 不按 source/version 隐式排序', () => {
    const aFoo = makeEntry({ id: 'A:foo@1.0.0', name: 'foo' });
    const bFoo = makeEntry({ id: 'B:foo@1.0.0', name: 'foo' });
    const cFoo = makeEntry({ id: 'C:foo@1.0.0', name: 'foo' });
    // 输入序 [B, A, C] → 候选序严格一致 (无隐式排序)
    const r = resolve('foo', [bFoo, aFoo, cFoo]);
    expect(r.state).toBe('ambiguous');
    if (r.state !== 'ambiguous') throw new Error('shape guard');
    expect(r.candidates).toEqual(['B:foo@1.0.0', 'A:foo@1.0.0', 'C:foo@1.0.0']);
  });

  test('③ version 不同也照样 ambiguous —— 绝不允许「同 source 即合并」等隐式合并', () => {
    const a1 = makeEntry({ id: 'A:foo@1.0.0', name: 'foo' });
    const a2 = makeEntry({ id: 'A:foo@2.0.0', name: 'foo' });
    const r = resolve('foo', [a1, a2]);
    expect(r.state).toBe('ambiguous');
    if (r.state !== 'ambiguous') throw new Error('shape guard');
    expect(r.candidates).toHaveLength(2);
    expect(r.candidates).toEqual(expect.arrayContaining(['A:foo@1.0.0', 'A:foo@2.0.0']));
  });

  // ── ④ 未注册名 → 空集, 绝不近似/模糊 ─────────────────────────────────────
  test('④ 未注册名 → state=miss, 形态仅含 state 字段, 不带 entry / candidates', () => {
    const foo = makeEntry({ id: 'core:foo@1.0.0', name: 'foo' });
    const r = resolve('bar', [foo]);
    expect(r).toEqual({ state: 'miss' });
    expect(Object.keys(r)).toEqual(['state']);
    expect('entry' in r).toBe(false);
    expect('candidates' in r).toBe(false);
  });

  test('④ 空 entries 列表 → 任何裸名都 miss, 全限定 id 也 miss', () => {
    expect(resolve('foo', [])).toEqual({ state: 'miss' });
    expect(resolve('core:foo@1.0.0', [])).toEqual({ state: 'miss' });
  });

  test('④ 近似候选 / 子串 / 前缀 / 大小写差异一律 miss —— 证伪「模糊匹配」违规实现', () => {
    const foo = makeEntry({ id: 'core:foo@1.0.0', name: 'foo' });
    // 子串
    expect(resolve('fo', [foo])).toEqual({ state: 'miss' });
    // 前缀匹配会触发但不该触发
    expect(resolve('fooo', [foo])).toEqual({ state: 'miss' });
    // 大小写
    expect(resolve('Foo', [foo])).toEqual({ state: 'miss' });
    expect(resolve('FOO', [foo])).toEqual({ state: 'miss' });
    // Levenshtein 距离 1
    expect(resolve('fooz', [foo])).toEqual({ state: 'miss' });
    // 全限定 id 但来源不存在 → 不回退到裸名再扫 (直查路径不通即 miss)
    expect(resolve('ghost:foo@1.0.0', [foo])).toEqual({ state: 'miss' });
  });

  // ── ⑤ 未升格 (discovered-set only) 条目被引用 → miss (PP-T01 字面空集) ─────
  test('⑤ caller 传 working-set 快照 (discovered-only 条目缺席) → 引用 discovered-only 全限定 id 返回 miss', () => {
    // discovered-only 条目: 在 inventory 中只存在于 discovered-set, 未 promoteToWorkingSet
    const discoveredOnly = makeEntry({ id: 'core:foo@1.0.0', name: 'foo' });
    // working-set 快照: caller (plan-critic 等) 只 inject 已升格条目; discovered-only 缺席
    const workingSnapshot = makeEntry({ id: 'core:bar@1.0.0', name: 'bar' });
    // 直查 discovered-only 的全限定 id → miss (state='miss' 即 PP-T01 tool_unresolved 字面空集)
    const r1 = resolve('core:foo@1.0.0', [workingSnapshot]);
    expect(r1).toEqual({ state: 'miss' });
    expect(Object.keys(r1)).toEqual(['state']);
    // 裸名查 discovered-only 的 name → 同样 miss (即使 name 撞名 working-set 的另一条,
    // 这里 workingSnapshot.name='bar' 不撞, 所以是 miss; 撞名情况见 ③ 形状)
    const r2 = resolve('foo', [workingSnapshot]);
    expect(r2).toEqual({ state: 'miss' });
  });

  test('⑤ discovered-only 条目 id 与 working-set 条目 id 字面撞 → 直查走「全限定 id 直查」路径, 命中 working-set 条目', () => {
    // 工作集条目
    const promoted = makeEntry({ id: 'core:foo@1.0.0', name: 'foo' });
    // discovered-only 同 id 不可能并存 (INV-1 同 id 单 set), 这里仅证伪「直查命中后
    // 回退到裸名再扫」的违规路径 —— 工作集仅 promote, 行为仍是 resolved, entry=promoted
    const r = resolve('core:foo@1.0.0', [promoted]);
    expect(r).toEqual({ state: 'resolved', entry: promoted });
  });
});