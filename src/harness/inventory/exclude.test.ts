/**
 * src/harness/inventory/exclude.test —— C-2 (片 2) 单元测试。
 *
 * 契约来源: 执行契约 D1 C-2 (INV-6 / INV-7 / INV-8 / INV-9) + 验收 #4 反向自检。
 *
 * 本测试覆盖:
 *   ① GWT-1: entry 带 `probe_state:'green'` (非枚举值) → schema 拒 + 字面含字段名
 *      (path.join('.'), 见 inventory.ts L165-167);
 *   ② GWT-2: `PROBED_FAIL ∧ APPLICABLE` 的条目 → resolve 返 miss + reason 可读;
 *   ③ GWT-3: `PROBE_ERROR ∧ APPLICABLE` → resolve 照常命中 (D-5 fail-open 那侧);
 *   ④ INV-8 反向自检: 把 healthShape 改回 `z.string().min(1)` → 这组用例红 (验收 #4);
 *      (由 grep 文件 + 字面断言锁死 zod z.enum 的引用存在);
 *   ⑤ INV-9 零回归: 未带 health 字段的存量条目行为字节不变
 *      (本仓库工作集 schema 是必填 health, 故这条用 workingSet 不带
 *      excluded 形态的字面照旧命中来保证);
 *   ⑥ 剔除 reason 字面锁定 (EXCLUDE_REASON) — 验收 #3 要求「理由可读」。
 *
 * 断言一律 shape (toEqual) 或字面相等; 不只断 truthy —— shape assertion 是
 * 判别联合互斥与字段在场性的唯一可靠方式。
 */
import { describe, expect, test } from 'bun:test';
import {
  APPLICABILITIES,
  APPLICABLE,
  NOT_APPLICABLE,
  PROBE_ERROR,
  PROBE_STATES,
  PROBED_FAIL,
  PROBED_OK,
  UNKNOWN,
  UNPROBED,
  isExcluded,
} from './health';
import { InventoryEntrySchema } from './inventory';
import { resolve, EXCLUDE_REASON } from './resolve';
import type { InventoryEntry } from './inventory';

// ─── InventoryEntry 工厂 ──────────────────────────────────────────────────────
// 字段顺序与 InventoryEntrySchema 严格一致 (INV-S1-7); health 三字段以参数注入。
function makeEntry(over: {
  id: string;
  name: string;
  probe_state?: InventoryEntry['probe_state'];
  applicability?: InventoryEntry['applicability'];
  failure_reason?: string;
}): InventoryEntry {
  const now = '2026-01-01T00:00:00Z';
  return {
    id: over.id,
    name: over.name,
    when_to_use: `use ${over.name}`,
    effect: 'read',
    safety_class: 'safe',
    cost_tier: 't0',
    defer_mode: 'eager',
    signature: {},
    oracle: { kind: 'command', gateScriptRef: 'check.sh' },
    probe_state: over.probe_state ?? UNPROBED,
    applicability: over.applicability ?? APPLICABLE,
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
    owner_pinned: false,
    oracle_bearing: false,
  };
}

// ─── ① GWT-1: probe_state 非枚举值 → schema 拒 + 字面含字段名 ─────────────────
describe('C-2 ① GWT-1: 非枚举值 → schema 拒 + 字面含字段名', () => {
  test("entry.probe_state='green' (非枚举) → 注册拒 + issues 字面含 'probe_state'", () => {
    const entry = makeEntry({ id: 'core:foo@1.0.0', name: 'foo' });
    const broken = { ...entry, probe_state: 'green' as unknown };
    const r = InventoryEntrySchema.safeParse(broken);
    expect(r.success).toBe(false);
    if (r.success) return;
    // 字面含字段名 (path.join('.') + 字段值, 见 inventory.ts L165-167)
    expect(r.error.issues.some((i) => i.path.join('.') === 'probe_state')).toBe(true);
  });

  test("entry.probe_state='live' / 'ok' / 'untested' → 全部拒 (C-2 现场 ② 五种拼法逐条红)", () => {
    for (const v of ['live', 'ok', 'untested', 'green', 'unknown']) {
      const entry = makeEntry({ id: 'core:foo@1.0.0', name: 'foo' });
      const broken = { ...entry, probe_state: v as unknown };
      const r = InventoryEntrySchema.safeParse(broken);
      expect(r.success).toBe(false);
      if (r.success) return;
      expect(r.error.issues.some((i) => i.path.join('.') === 'probe_state')).toBe(true);
    }
  });

  test('entry.applicability 非枚举值 → 注册拒 + 字面含字段名', () => {
    const entry = makeEntry({ id: 'core:foo@1.0.0', name: 'foo' });
    for (const v of ['always', 'builtin', 'bootstrap']) {
      const broken = { ...entry, applicability: v as unknown };
      const r = InventoryEntrySchema.safeParse(broken);
      expect(r.success).toBe(false);
      if (r.success) return;
      expect(r.error.issues.some((i) => i.path.join('.') === 'applicability')).toBe(true);
    }
  });

  test('合法枚举值全部 parse 通过 (字面锁: PROBE_STATES × APPLICABILITIES)', () => {
    for (const ps of PROBE_STATES) {
      for (const app of APPLICABILITIES) {
        const entry = makeEntry({
          id: `core:${ps}_${app}@1.0.0`,
          name: `e_${ps}_${app}`,
          probe_state: ps,
          applicability: app,
        });
        expect(InventoryEntrySchema.safeParse(entry).success).toBe(true);
      }
    }
  });
});

// ─── ② GWT-2: PROBED_FAIL ∧ APPLICABLE → 未命中 + reason 可读 ─────────────────
describe('C-2 ② GWT-2: PROBED_FAIL ∧ APPLICABLE → 未命中 + 理由可读', () => {
  test('直查全限定 id: PROBED_FAIL ∧ APPLICABLE → miss + reason 字面', () => {
    const e = makeEntry({
      id: 'core:foo@1.0.0',
      name: 'foo',
      probe_state: PROBED_FAIL,
      applicability: APPLICABLE,
      failure_reason: '402',
    });
    const r = resolve('core:foo@1.0.0', [e]);
    expect(r.state).toBe('miss');
    if (r.state !== 'miss') return;
    expect(r.reason).toBe(EXCLUDE_REASON);
  });

  test('裸名查: PROBED_FAIL ∧ APPLICABLE → miss + reason 字面 (单候选不歧义,但仍剔)', () => {
    const e = makeEntry({
      id: 'core:foo@1.0.0',
      name: 'foo',
      probe_state: PROBED_FAIL,
      applicability: APPLICABLE,
      failure_reason: '402',
    });
    const r = resolve('foo', [e]);
    expect(r.state).toBe('miss');
    if (r.state !== 'miss') return;
    expect(r.reason).toBe(EXCLUDE_REASON);
  });

  test('剔除 reason 字面锁定 (验收 #3 理由可读)', () => {
    expect(EXCLUDE_REASON).toBe('excluded:probe_state=PROBED_FAIL ∧ applicability=APPLICABLE');
  });

  test('剔除不静默: 未被剔除的 miss 不带 reason (resolve.test 现有 ④ 形状兼容)', () => {
    const foo = makeEntry({ id: 'core:foo@1.0.0', name: 'foo' });
    const r = resolve('bar', [foo]);
    expect(r).toEqual({ state: 'miss' });
    expect(Object.keys(r)).toEqual(['state']);
    expect('reason' in r).toBe(false);
  });
});

// ─── ③ GWT-3: PROBE_ERROR ∧ APPLICABLE → 照常命中 (fail-open 那侧) ────────────
describe('C-2 ③ GWT-3: PROBE_ERROR / UNPROBED / NOT_APPLICABLE / UNKNOWN → 照常命中', () => {
  test('PROBE_ERROR ∧ APPLICABLE → resolve 命中 (D-5: 探不出来 ≠ 探出来是坏的)', () => {
    const e = makeEntry({
      id: 'core:foo@1.0.0',
      name: 'foo',
      probe_state: PROBE_ERROR, // = PROBE_ERROR 字符串别名
      applicability: APPLICABLE,
    });
    const r = resolve('core:foo@1.0.0', [e]);
    expect(r.state).toBe('resolved');
    if (r.state !== 'resolved') return;
    expect(r.entry.id).toBe('core:foo@1.0.0');
  });

  test('UNPROBED ∧ APPLICABLE → resolve 命中 (D-3: 没探过不是失败)', () => {
    const e = makeEntry({
      id: 'core:foo@1.0.0',
      name: 'foo',
      probe_state: UNPROBED,
      applicability: APPLICABLE,
    });
    const r = resolve('core:foo@1.0.0', [e]);
    expect(r.state).toBe('resolved');
  });

  test('PROBED_FAIL ∧ NOT_APPLICABLE → 命中 (D-5: NOT_APPLICABLE 不剔)', () => {
    const e = makeEntry({
      id: 'core:foo@1.0.0',
      name: 'foo',
      probe_state: PROBED_FAIL,
      applicability: NOT_APPLICABLE,
      failure_reason: '402',
    });
    const r = resolve('core:foo@1.0.0', [e]);
    expect(r.state).toBe('resolved');
  });

  test('PROBED_FAIL ∧ UNKNOWN → 命中 (D-5: UNKNOWN 不剔)', () => {
    const e = makeEntry({
      id: 'core:foo@1.0.0',
      name: 'foo',
      probe_state: PROBED_FAIL,
      applicability: UNKNOWN,
      failure_reason: '402',
    });
    const r = resolve('core:foo@1.0.0', [e]);
    expect(r.state).toBe('resolved');
  });

  test('PROBED_OK ∧ APPLICABLE → 命中 (正常路径)', () => {
    const e = makeEntry({
      id: 'core:foo@1.0.0',
      name: 'foo',
      probe_state: PROBED_OK,
      applicability: APPLICABLE,
    });
    const r = resolve('core:foo@1.0.0', [e]);
    expect(r.state).toBe('resolved');
  });
});

// ─── ④ INV-6 反向自检: schema 真用 enum (验收 #4) ────────────────────────────
describe('C-2 ④ INV-6 反向自检: InventoryEntrySchema 的 probe_state/applicability 真用 z.enum', () => {
  test('schema.shape.probe_state 是 ZodEnum 实例 (非 ZodString, 否则 INV-8 失效)', () => {
    // zod v4: z.enum 的 _def.type='enum' (字符串), z.string() 是 'string'。用 _def.type 锁字面。
    const ps = InventoryEntrySchema.shape.probe_state;
    expect(ps._def.type).toBe('enum');
    const app = InventoryEntrySchema.shape.applicability;
    expect(app._def.type).toBe('enum');
  });

  test('枚举可选值字面 = health.ts 同一份 (INV-2: 枚举与断言共用同一份)', () => {
    const ps = InventoryEntrySchema.shape.probe_state;
    expect(ps.options).toEqual([...PROBE_STATES]);
    const app = InventoryEntrySchema.shape.applicability;
    expect(app.options).toEqual([...APPLICABILITIES]);
  });
});

// ─── ⑤ INV-9 零回归: workingSet 正常命中 (PROBED_OK / UNPROBED) ────────────────
describe('C-2 ⑤ INV-9 零回归: 正常条目照常命中', () => {
  test('PROBED_OK ∧ APPLICABLE 条目直查 + 裸名都命中', () => {
    const e = makeEntry({
      id: 'core:bash@1.0.0',
      name: 'bash',
      probe_state: PROBED_OK,
      applicability: APPLICABLE,
    });
    expect(resolve('core:bash@1.0.0', [e]).state).toBe('resolved');
    expect(resolve('bash', [e]).state).toBe('resolved');
  });

  test('多条目 working-set 中: 非剔除照常命中, 剔除者未命中', () => {
    const ok = makeEntry({
      id: 'core:bash@1.0.0',
      name: 'bash',
      probe_state: PROBED_OK,
      applicability: APPLICABLE,
    });
    const bad = makeEntry({
      id: 'core:read@1.0.0',
      name: 'read',
      probe_state: PROBED_FAIL,
      applicability: APPLICABLE,
      failure_reason: '402',
    });
    expect(resolve('bash', [ok, bad]).state).toBe('resolved');
    const r = resolve('read', [ok, bad]);
    expect(r.state).toBe('miss');
    if (r.state !== 'miss') return;
    expect(r.reason).toBe(EXCLUDE_REASON);
  });
});

// ─── ⑥ isExcluded 行为锁 (与 health.test.ts 表对账) ───────────────────────────
describe('C-2 ⑥ isExcluded 复用 health.ts 的同表 (INV-2: 单一真源)', () => {
  test('4 状态 × 3 适用性 = 12 组合, 唯一真的还是 PROBED_FAIL ∧ APPLICABLE', () => {
    const cases: Array<[typeof PROBED_FAIL | typeof PROBED_OK | typeof PROBE_ERROR | typeof UNPROBED, typeof APPLICABLE | typeof NOT_APPLICABLE | typeof UNKNOWN, boolean]> = [
      [PROBED_FAIL, APPLICABLE, true],
      [PROBED_FAIL, NOT_APPLICABLE, false],
      [PROBED_FAIL, UNKNOWN, false],
      [PROBED_OK, APPLICABLE, false],
      [PROBED_OK, NOT_APPLICABLE, false],
      [PROBED_OK, UNKNOWN, false],
      [PROBE_ERROR, APPLICABLE, false],
      [PROBE_ERROR, NOT_APPLICABLE, false],
      [PROBE_ERROR, UNKNOWN, false],
      [UNPROBED, APPLICABLE, false],
      [UNPROBED, NOT_APPLICABLE, false],
      [UNPROBED, UNKNOWN, false],
    ];
    for (const [ps, app, expected] of cases) {
      expect(isExcluded({ probe_state: ps, applicability: app })).toBe(expected);
    }
  });
});
