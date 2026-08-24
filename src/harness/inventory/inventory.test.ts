/**
 * src/harness/inventory/inventory.test —— C-1 单元测试 (S1/片 1)。
 *
 * 契约来源: src/harness/inventory/inventory.ts 顶部 INV 列表 (INV-1 / INV-3 /
 * INV-4 / INV-5 / INV-S1-7) + 同文件 zod 字段定义 (字段顺序逐字锁定)。
 * 本测试:
 *   ① provenance 11 字段缺 1 → 注册被拒, verdict.issues 字面点名缺哪个字段
 *      (path.join('.'), 见 inventory.ts L165-167);
 *   ② 顶层条目 additionalProperties:false → 未知字段被拒, issues 含字段名;
 *   ③ 引擎原语 eager 常驻 + discovered-set 只读 + 未升格引用 NOT_IN_WORKING_SET;
 *      升格到 working-set 后再 promote → NOT_IN_DISCOVERED (原子升格删 discovered);
 *   ④ in-flight 升格: test_gate=green 入 in-flight + 同图 resolve 仍命中 working;
 *      status='red' → not_green; 同 id 二次入 in-flight → ALREADY_IN_FLIGHT;
 *   ⑤ INV-4 单写者: 同 worktree 第二名写者抢锁抛 SingleWriterViolation,
 *      错误体 worktree / lockPath / origin / message 字段逐字断言;
 *   ⑥ 健康组四字段 (probe_state / applicability / failure_reason / idle_days)
 *      仅做存在性断言 (探针实装属 S2, 不在此层断言值语义)。
 *
 * 断言一律走 toEqual 整形状, 不只断 truthy —— shape assertion 是约束判别联合
 * (ok/reason/id) 各分支互斥与在场性的唯一可靠方式。
 *
 * Implementation gap 登记 (本测试未改实装):
 *   - registerEntry 缺 `provenance.<field>` 时的 issue 字面 (path + message) 由 zod
 *     决定; 若 zod 升级改了 issue 形态, ① 必须重定 issue 串匹配模式;
 *   - assertSingleWriter.close() 只 closeSync fd 不 unlink 文件 (与契约一致,
 *     锁生命周期 = 持有者生命周期); 故 close 后第二次仍抛, 不需 rm。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  _resetInventoryForTests,
  assertSingleWriter,
  InventoryEntrySchema,
  isSingleWriter,
  promoteToWorkingSet,
  registerEntry,
  registerInFlight,
  resolve,
  SINGLE_WRITER_LOCK_NAME,
  SingleWriterViolation,
  type InventoryEntry,
} from './inventory';

// ─── 工厂 + 隔离 ──────────────────────────────────────────────────────────────

/** 11 个 provenance 字段 (INV-S1-7 字段顺序); 改顺序 = 加 SCHEMA_VERSION。 */
const PROVENANCE_KEYS = [
  'registered_at', 'registered_by', 'source_repo', 'source_path',
  'commit_sha', 'import_method', 'imported_at', 'imported_by',
  'upstream_version', 'content_sha256', 'schema_version',
] as const;

/** 一份**走 zod 校验**的合法条目 (用于 register/promote/in-flight 全链路)。 */
function validEntry(overrides: Record<string, unknown> = {}): InventoryEntry {
  const base: InventoryEntry = {
    id: 'demo:tool@1.0.0',
    name: 'demo-tool',
    when_to_use: 'when you need a demo',
    effect: 'read',
    safety_class: 'pure',
    cost_tier: 't0',
    defer_mode: 'eager',
    signature: { inputs: [], outputs: [] },
    oracle: { kind: 'command', gateScriptRef: 'test/fixtures/ok.sh' },
    probe_state: 'untested',
    applicability: 'always',
    idle_days: 0,
    provenance: {
      registered_at: '2026-01-01T00:00:00Z',
      registered_by: 'test',
      source_repo: 'demo/repo',
      source_path: 'src/tools/demo.ts',
      commit_sha: 'abc123',
      import_method: 'git',
      imported_at: '2026-01-01T00:00:00Z',
      imported_by: 'test',
      upstream_version: '1.0.0',
      content_sha256: 'a'.repeat(64),
      schema_version: '1.0',
    },
    search_hint: 'demo tool for tests',
    owner_pinned: false,
    oracle_bearing: false,
  };
  // 浅合并 (测试用, 不递归; provenance 必须整体替换或省略)
  return { ...base, ...overrides } as InventoryEntry;
}

beforeEach(() => {
  _resetInventoryForTests();
});

const tmpDirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'omd-inv-'));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

// ─── ① provenance 缺字段 → verdict 点名 ─────────────────────────────────────
describe('C-1 ① provenance 11 字段缺一 → 注册被拒 + verdict 点名', () => {
  test.each(
    PROVENANCE_KEYS.map((k) => [k]),
  )('缺 provenance.%s → issues 含该字段路径', (missingKey) => {
    const full = validEntry();
    const { [missingKey as keyof typeof full.provenance]: _, ...rest } = full.provenance;
    const broken = validEntry({ provenance: rest });
    const v = registerEntry(broken);
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.phase).toBe('register');
    expect(v.reason).toBe('schema_invalid');
    // 字面含字段名 (path.join('.'), 见 inventory.ts L165-167); 即使 message 改也不丢路径
    const hit = v.issues.find((s) => s.includes(missingKey));
    expect(hit).toBeDefined();
  });

  test('全部 11 字段齐 → 注册成功', () => {
    const v = registerEntry(validEntry());
    expect(v).toEqual({ ok: true, phase: 'register' });
  });
});

// ─── ② additionalProperties:false → 未知字段被拒 ────────────────────────────
describe('C-1 ② 顶层条目 additionalProperties:false → 未知字段被拒', () => {
  test('顶层塞 unknown_field → issues 含字段名', () => {
    const v = registerEntry(validEntry({ unknown_field: 'sneaky' }));
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.reason).toBe('schema_invalid');
    const hit = v.issues.find((s) => s.includes('unknown_field'));
    expect(hit).toBeDefined();
  });

  test('provenance 内塞未知字段 → issues 含字段名', () => {
    const full = validEntry();
    const v = registerEntry(
      validEntry({ provenance: { ...full.provenance, secret: 'leak' } }),
    );
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.reason).toBe('schema_invalid');
    expect(v.issues.some((s) => s.includes('secret'))).toBe(true);
  });

  test('id 不符 `<source>:<name>@<semver>` → issues 含字段名 + 拒绝', () => {
    const v = registerEntry(validEntry({ id: 'not-a-valid-id' }));
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.reason).toBe('schema_invalid');
    expect(v.issues.some((s) => s.includes('id'))).toBe(true);
  });
});

// ─── ③ INV-1: eager 常驻 + discovered 只读 + 未升格 NOT_IN_WORKING_SET ──────
describe('C-1 ③ INV-1 引擎原语 eager 常驻 / discovered 只读 / 升格', () => {
  const ID = 'demo:tool@1.0.0';

  test('register 后立刻可 promote (证明 eager 入 discovered)', () => {
    const r = registerEntry(validEntry());
    expect(r).toEqual({ ok: true, phase: 'register' });
    // 未 promote → resolve 返回 NOT_IN_WORKING_SET (INV-1 字面)
    expect(resolve(ID)).toEqual({ state: 'NOT_IN_WORKING_SET', id: ID });
    // promote 成功 → discovered → working-set
    expect(promoteToWorkingSet(ID)).toEqual({ ok: true, phase: 'promote', id: ID });
    // promote 后 resolve 命中
    const got = resolve(ID);
    expect(got.state).toBe('IN_WORKING_SET');
    if (got.state === 'IN_WORKING_SET') {
      expect(got.entry.id).toBe(ID);
    }
  });

  test('第二次 promote 同 id → NOT_IN_DISCOVERED (原子升格已删 discovered)', () => {
    registerEntry(validEntry());
    promoteToWorkingSet(ID);
    const second = promoteToWorkingSet(ID);
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second).toEqual({
      ok: false, phase: 'promote', reason: 'NOT_IN_DISCOVERED', id: ID,
    });
  });

  test('working-set 已占 → 重 register 再 promote → ALREADY_IN_WORKING_SET', () => {
    registerEntry(validEntry());
    promoteToWorkingSet(ID);
    registerEntry(validEntry()); // 同 id 再 register
    const p = promoteToWorkingSet(ID);
    expect(p.ok).toBe(false);
    if (p.ok) return;
    expect(p).toEqual({
      ok: false, phase: 'promote', reason: 'ALREADY_IN_WORKING_SET', id: ID,
    });
  });

  test('引用全未注册 id → NOT_IN_WORKING_SET', () => {
    expect(resolve('ghost:tool@9.9.9')).toEqual({
      state: 'NOT_IN_WORKING_SET', id: 'ghost:tool@9.9.9',
    });
  });
});

// ─── ④ INV-3: in-flight 升格 (green 入 + 同图引用; red 拒) ─────────────────
describe('C-1 ④ INV-3 in-flight 升格 API', () => {
  const ID = 'demo:tool@1.0.0';

  function setupPromoted(): void {
    registerEntry(validEntry());
    promoteToWorkingSet(ID);
  }

  test('test_gate=green → 入 in-flight; 同图 resolve 仍命中 (working-set 不动)', () => {
    setupPromoted();
    const v = registerInFlight(ID, { status: 'green', gate: 'g1' });
    expect(v).toEqual({ ok: true, phase: 'in-flight', id: ID });
    // INV-1 出口契约不变: 同图引用 resolve 仍返 IN_WORKING_SET
    expect(resolve(ID).state).toBe('IN_WORKING_SET');
  });

  test('同 id 二次入 in-flight → ALREADY_IN_FLIGHT', () => {
    setupPromoted();
    registerInFlight(ID, { status: 'green', gate: 'g1' });
    const second = registerInFlight(ID, { status: 'green', gate: 'g2' });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second).toEqual({
      ok: false, phase: 'in-flight', reason: 'ALREADY_IN_FLIGHT', id: ID,
    });
  });

  test('test_gate=red → not_green (未入 in-flight)', () => {
    setupPromoted();
    const v = registerInFlight(ID, { status: 'red', gate: 'g1' });
    expect(v).toEqual({
      ok: false, phase: 'in-flight', reason: 'not_green', id: ID,
    });
    // working-set 仍未动: 同图引用仍命中
    expect(resolve(ID).state).toBe('IN_WORKING_SET');
  });

  test('未升格条目 → NOT_IN_WORKING_SET (不论 gate)', () => {
    registerEntry(validEntry()); // 仅 discovered, 未 promote
    const g = registerInFlight(ID, { status: 'green', gate: 'g1' });
    expect(g).toEqual({
      ok: false, phase: 'in-flight', reason: 'NOT_IN_WORKING_SET', id: ID,
    });
    const r = registerInFlight(ID, { status: 'red', gate: 'g1' });
    // red 在 NOT_IN_WORKING_SET 判定之前 → 返 not_green (实装先判 gate 再判 ws)
    expect(r).toEqual({
      ok: false, phase: 'in-flight', reason: 'not_green', id: ID,
    });
  });
});

// ─── ⑤ INV-4: 单写者锁 ───────────────────────────────────────────────────────
describe('C-1 ⑤ INV-4 单写者锁 (同 worktree 第二名写者拒)', () => {
  test('第一写者抢锁成功 + 第二写者抛 SingleWriterViolation + 字段字面', () => {
    const wt = tmp();
    // 锁文件未存在 → isSingleWriter = true (没锁 = 空位)
    expect(isSingleWriter(wt)).toBe(true);
    const h1 = assertSingleWriter(wt);
    expect(h1.lockPath).toBe(join(wt, '.omd', SINGLE_WRITER_LOCK_NAME));
    expect(existsSync(h1.lockPath)).toBe(true);
    // 锁存在 → isSingleWriter = false
    expect(isSingleWriter(wt)).toBe(false);

    // 第二名写者抢同一 inode → 抛
    expect(() => assertSingleWriter(wt)).toThrow(SingleWriterViolation);

    // 错误体字段逐字断言
    let captured: unknown;
    try {
      assertSingleWriter(wt);
    } catch (e) {
      captured = e;
    }
    expect(captured).toBeInstanceOf(SingleWriterViolation);
    const v = captured as SingleWriterViolation;
    expect(v.worktree).toBe(wt);
    expect(v.lockPath).toContain(SINGLE_WRITER_LOCK_NAME);
    expect(v.message).toContain('INV-4');
    expect(v.message).toContain(wt);
    expect(v.origin).toBeDefined();

    // close() 只 closeSync fd, 不 unlink 文件 (契约: 锁生命周期 = 持有者生命周期);
    // 故 close 后再 assert 仍抛 —— 这是设计, 不是 bug
    h1.close();
    expect(() => assertSingleWriter(wt)).toThrow(SingleWriterViolation);
  });

  test('不同 worktree 各自独立', () => {
    const a = tmp();
    const b = tmp();
    // 两次抢锁均成功 (互不干扰)
    const ha = assertSingleWriter(a);
    const hb = assertSingleWriter(b);
    expect(ha.lockPath).not.toBe(hb.lockPath);
    // 两锁文件均存在, 互不污染
    expect(existsSync(ha.lockPath)).toBe(true);
    expect(existsSync(hb.lockPath)).toBe(true);
  });

  test('SINGLE_WRITER_LOCK_NAME 字面 = "inventory.lock"', () => {
    expect(SINGLE_WRITER_LOCK_NAME).toBe('inventory.lock');
  });
});

// ─── ⑥ 健康组字段存在性 (探针实装属 S2) ─────────────────────────────────────
describe('C-1 ⑥ 健康组字段仅存在性 (探针实装属 S2)', () => {
  test('InventoryEntrySchema.shape 含 probe_state / applicability / failure_reason / idle_days', () => {
    // zod v3: schema.shape 是字段字典; 字面在场 = 字段被注册
    const shape = InventoryEntrySchema.shape;
    expect(shape).toHaveProperty('probe_state');
    expect(shape).toHaveProperty('applicability');
    expect(shape).toHaveProperty('failure_reason');
    expect(shape).toHaveProperty('idle_days');
  });

  test('parsed 合法条目: 必填 3 字段在场 + idle_days 非负 number', () => {
    // 走 zod parse 直接拿到 parsed entry (不依赖 working-set 状态机)
    const entry: InventoryEntry = InventoryEntrySchema.parse(validEntry());
    expect(entry).toHaveProperty('probe_state');
    expect(entry).toHaveProperty('applicability');
    expect(entry).toHaveProperty('idle_days');
    expect(typeof entry.probe_state).toBe('string');
    expect(typeof entry.applicability).toBe('string');
    expect(typeof entry.idle_days).toBe('number');
    expect(entry.idle_days).toBeGreaterThanOrEqual(0);
  });

  test('failure_reason 显式带值 → parsed entry 含 failure_reason 字面', () => {
    const entry: InventoryEntry = InventoryEntrySchema.parse(
      validEntry({ failure_reason: 'probe-not-implemented' }),
    );
    expect(entry.failure_reason).toBe('probe-not-implemented');
    expect('failure_reason' in entry).toBe(true);
  });

  test('failure_reason 不带 → 仍合法, 字段键缺席 (optional)', () => {
    const entry: InventoryEntry = InventoryEntrySchema.parse(validEntry());
    expect('failure_reason' in entry).toBe(false);
  });
});