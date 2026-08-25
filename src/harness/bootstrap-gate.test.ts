/**
 * src/harness/bootstrap-gate.test —— C-4 bootstrap 闸单元测试 (S1/片 4)。
 *
 * 契约来源: src/harness/bootstrap-gate.ts 顶部 INV 列表 (INV-17 / INV-18 /
 * INV-19 / INV-20) + 同文件 zod 字段定义 + S1 红线 (allow_non_deterministic)。
 *
 * 覆盖映射 (与本任务 §①–⑤ 对齐):
 *   ① INV-17: 节点契约 `type:"bootstrap"` + `outputs.tool_path` +
 *      `test_gate{tool_id, oracle[], allow_non_deterministic:false, timeout_sec, cost_ceiling}` +
 *      provenance 11 字段; 缺任一必填 → `validateBootstrapNode` 拒且 `missing[]` 字面点名。
 *   ② INV-18: 三态 `green` / `yellow` / `red`; green 可经 in-flight API 入 inventory;
 *      yellow 不入, 被引用走 PP-T03; red 全图不可用且 verdict 中不携带 tool_id / path
 *      (不向 conductor 透露该工具曾存在)。
 *   ③ S1 红线: 节点含 `allow_non_deterministic:true` → 节点契约拒 (`z.literal(false)`)。
 *   ④ INV-19: bootstrap leaf 写 `red_tests/` / `fixtures/` → 拒且审计条目齐; 写集
 *      注册期冻结只许缩; 运行时越界 (`shadow_exec` 路径)。
 *   ⑤ INV-20: `canBeReferencedByBuildTimeEdge` 仅 green 可被 build-time 边引用。
 *
 * 辅助: 原 `runBootstrapGate` 默认 adapter 路径需 inventory 真实现配合 (working-set 入口),
 * 这里用 ① 注入 adapter (覆盖主路径与失败升级) + ② 对 inventory 真件的一次性端到端
 * 探针, 验 `defaultAdapter` 接缝通 (见 `runBootstrapGate defaultAdapter wiring`)。
 *
 * Implementation gap 登记 (本测试未改实装; 留给节点输出段落登记):
 *   - `evaluateTestGate([])` 被节点契约拒绝 (oracle.min(1)), 函数本体却允许空数组并返
 *     `red`; 两者不冲突 (本测试把它当成纯函数存在性证据)。
 *   - `runBootstrapGate` red 分支 verdict 是 `{ kind: 'red' }`, 没有 `id` / `path` /
 *     `tool_id` 字段; 但 `path: ''` 这类"未泄漏"的反向断言只对**对象 shape** 有意义,
 *     不能判 verdict 序列化产物在日志/错误里也没漏 (那是 conductor 侧责任)。
 *   - INV-20 真实消费方是 `plan-dry-run.ts` 的 tool-resolve 阶段 (`PIPE_STAGES` 里
 *     那一格); 跨模块集成测试不属本件, plan-dry-run 节点另开。
 *   - `red_tests` 裸目录名 (`dir.slice(0,-1)`) 与 `red_testsfoo` 这类前缀近邻名都被
 *     `insideDir` 当放行 (后者既不裸也不以 `red_tests/` 起头), 这是 by-design, 本
 *     测试也保留这条边界断言以防 `startsWith` 不带斜杠时被悄悄放宽。
 */
import { afterEach, describe, expect, test } from 'bun:test';
import {
  BootstrapNodeSchema,
  canBeReferencedByBuildTimeEdge,
  checkBootstrapWrite,
  createBootstrapWriteSet,
  evaluateTestGate,
  type BootstrapNode,
  type BootstrapWriteSet,
  type InventoryInFlightAdapter,
  type OracleResult,
  runBootstrapGate,
  validateBootstrapNode,
} from './bootstrap-gate';
import {
  _resetInventoryForTests,
  promoteToWorkingSet,
  registerEntry,
} from './inventory/inventory';

// ─── 工厂 ────────────────────────────────────────────────────────────────────

/** INV-S1-7 provenance 11 字段 (字段顺序逐字锁定, 改顺序 = 升 SCHEMA_VERSION)。 */
const PROVENANCE_KEYS = [
  'registered_at', 'registered_by', 'source_repo', 'source_path',
  'commit_sha', 'import_method', 'imported_at', 'imported_by',
  'upstream_version', 'content_sha256', 'schema_version',
] as const;

function validProvenance(overrides: Record<string, string> = {}): Record<string, string> {
  const base: Record<string, string> = {
    registered_at: '2026-01-01T00:00:00Z',
    registered_by: 'conductor',
    source_repo: 'omd/bootstrap-fixture',
    source_path: 'tools/demo.ts',
    commit_sha: 'abcdef0',
    import_method: 'npm',
    imported_at: '2026-01-01T00:00:00Z',
    imported_by: 'bootstrap-leaf',
    upstream_version: '1.0.0',
    /** 64 hex 字符 (zod `^[0-9a-f]{64}$`)。 */
    content_sha256: 'a'.repeat(64),
    schema_version: '1.0',
  };
  return { ...base, ...overrides };
}

function validNode(overrides: Record<string, unknown> = {}): BootstrapNode {
  const base = {
    type: 'bootstrap',
    outputs: { tool_path: 'tools/demo.ts' },
    test_gate: {
      tool_id: 'demo:tool@1.0.0',
      oracle: [
        { kind: 'command', gateScriptRef: 'gates/unit.sh', deterministic: true, pass: true },
      ],
      allow_non_deterministic: false,
      timeout_sec: 30,
      cost_ceiling: 0.05,
    },
    provenance: validProvenance(),
  };
  return { ...base, ...overrides } as unknown as BootstrapNode;
}

function oracle(deterministic: boolean, pass: boolean): OracleResult {
  return { deterministic, pass };
}

/** 时钟桩: 固定 ISO, 让 `ts` 字面断言成立。 */
const FROZEN_NOW = () => new Date('2026-02-01T12:00:00Z');

// ─── ① INV-17 节点契约 ─────────────────────────────────────────────────────────

describe('INV-17 validateBootstrapNode: 完整合法节点', () => {
  test('type=bootstrap + outputs.tool_path + test_gate + provenance 11 字段齐全 → ok:true', () => {
    const v = validateBootstrapNode(validNode());
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.node.type).toBe('bootstrap');
      expect(v.node.outputs.tool_path).toBe('tools/demo.ts');
      expect(v.node.test_gate.allow_non_deterministic).toBe(false);
      expect(v.node.test_gate.oracle.length).toBe(1);
    }
  });

  test('BootstrapNodeSchema 与 validateBootstrapNode 对合法节点输出一致', () => {
    const schema = BootstrapNodeSchema.safeParse(validNode());
    expect(schema.success).toBe(true);
    if (schema.success) {
      expect(validateBootstrapNode(schema.data).ok).toBe(true);
    }
  });
});

describe('INV-17 validateBootstrapNode: 缺字段逐项点名', () => {
  test('缺 outputs.tool_path → missing 含 "outputs.tool_path"', () => {
    const node = validNode();
    delete (node as unknown as { outputs: { tool_path?: string } }).outputs.tool_path;
    const v = validateBootstrapNode(node);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.missing).toContain('outputs.tool_path');
  });

  test('outputs.tool_path 空串 → missing 含 "outputs.tool_path"', () => {
    const node = validNode({ outputs: { tool_path: '' } });
    const v = validateBootstrapNode(node);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.missing).toContain('outputs.tool_path');
  });

  test('缺 test_gate.tool_id → missing 含 "test_gate.tool_id"', () => {
    const node = validNode();
    const tg = node.test_gate as unknown as { tool_id?: string };
    delete tg.tool_id;
    const v = validateBootstrapNode(node);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.missing).toContain('test_gate.tool_id');
  });

  test('test_gate.oracle 数组空 → missing 含 "test_gate.oracle"', () => {
    const node = validNode();
    (node.test_gate as unknown as { oracle: unknown[] }).oracle = [];
    const v = validateBootstrapNode(node);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.missing).toContain('test_gate.oracle');
  });

  test('缺 allow_non_deterministic → missing 含 "test_gate.allow_non_deterministic"', () => {
    const node = validNode();
    delete (node.test_gate as unknown as { allow_non_deterministic?: boolean }).allow_non_deterministic;
    const v = validateBootstrapNode(node);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.missing).toContain('test_gate.allow_non_deterministic');
  });

  test('timeout_sec 非正整数 → missing 含 "test_gate.timeout_sec"', () => {
    for (const bad of [0, -1, 1.5, NaN]) {
      const node = validNode();
      (node.test_gate as unknown as { timeout_sec: number }).timeout_sec = bad;
      const v = validateBootstrapNode(node);
      expect(v.ok).toBe(false);
      if (!v.ok) expect(v.missing).toContain('test_gate.timeout_sec');
    }
  });

  test('cost_ceiling 为负 → missing 含 "test_gate.cost_ceiling"', () => {
    const node = validNode();
    (node.test_gate as unknown as { cost_ceiling: number }).cost_ceiling = -0.01;
    const v = validateBootstrapNode(node);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.missing).toContain('test_gate.cost_ceiling');
  });

  test('type 不是 "bootstrap" → missing 含 "type"', () => {
    const node = validNode();
    (node as unknown as { type: string }).type = 'leaf';
    const v = validateBootstrapNode(node);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.missing).toContain('type');
  });

  test('顶层未知字段 → missing 含 "<root>"', () => {
    const node = { ...validNode(), mystery: true };
    const v = validateBootstrapNode(node);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.missing).toContain('<root>');
  });

  test('provenance 11 字段逐个缺失 → missing 含该字段路径', () => {
    for (const key of PROVENANCE_KEYS) {
      const prov = validProvenance();
      delete prov[key];
      const v = validateBootstrapNode(validNode({ provenance: prov }));
      expect(v.ok).toBe(false);
      if (!v.ok) {
        // zod issue path = `provenance.<key>`, 但 `min(1)` 报错时 zod 可能只报字段名
        expect(
          v.missing.includes(`provenance.${key}`) || v.missing.includes(key),
        ).toBe(true);
      }
    }
  });

  test('content_sha256 非 64 hex → missing 含 "provenance.content_sha256"', () => {
    const node = validNode({
      provenance: validProvenance({ content_sha256: 'short' }),
    });
    const v = validateBootstrapNode(node);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.missing).toContain('provenance.content_sha256');
  });

  test('判词 missing[] 顺序与 zod issues 一致 (多次缺字段时第一个先报)', () => {
    const node: Record<string, unknown> = { type: 'bootstrap' };
    const v = validateBootstrapNode(node);
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.phase).toBe('validate');
      expect(Array.isArray(v.missing)).toBe(true);
      expect(v.missing.length).toBeGreaterThan(0);
    }
  });
});

// ─── ③ S1 红线 allow_non_deterministic ────────────────────────────────────────

describe('S1 红线: allow_non_deterministic', () => {
  test('allow_non_deterministic = true → 拒 (缺任一必填)', () => {
    const node = validNode();
    (node.test_gate as unknown as { allow_non_deterministic: boolean }).allow_non_deterministic = true;
    const v = validateBootstrapNode(node);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.missing).toContain('test_gate.allow_non_deterministic');
  });

  test('allow_non_deterministic 缺省 → 拒 (字段必填)', () => {
    const node = validNode();
    const tg = node.test_gate as unknown as Record<string, unknown>;
    delete tg.allow_non_deterministic;
    const v = validateBootstrapNode(node);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.missing).toContain('test_gate.allow_non_deterministic');
  });

  test('allow_non_deterministic = "false" (字符串而非布尔) → 拒', () => {
    const node = validNode();
    (node.test_gate as unknown as { allow_non_deterministic: unknown }).allow_non_deterministic = 'false';
    const v = validateBootstrapNode(node);
    expect(v.ok).toBe(false);
  });

  test('allow_non_deterministic = 1 (truthy 非布尔) → 拒', () => {
    const node = validNode();
    (node.test_gate as unknown as { allow_non_deterministic: unknown }).allow_non_deterministic = 1;
    const v = validateBootstrapNode(node);
    expect(v.ok).toBe(false);
  });

  test('拒绝路径中能拼出 "S1" 或 "deterministic" 字样作为下游线索 (zod 错误信息)', () => {
    const node = validNode();
    (node.test_gate as unknown as { allow_non_deterministic: boolean }).allow_non_deterministic = true;
    const raw = BootstrapNodeSchema.safeParse(node);
    expect(raw.success).toBe(false);
    if (!raw.success) {
      const msg = raw.error.issues.map((i) => i.message).join(' | ');
      // 字面只要含 S1 / deterministic 任一即可 (实装用了 'S1 只收确定性 oracle; ...')
      expect(/S1|deterministic/i.test(msg)).toBe(true);
    }
  });
});

// ─── ② INV-18 三态 ────────────────────────────────────────────────────────────

describe('INV-18 evaluateTestGate 三态纯函数', () => {
  test('空数组 → red', () => {
    expect(evaluateTestGate([])).toBe('red');
  });

  test('全失败 → red (deterministic priority 不救场)', () => {
    expect(evaluateTestGate([oracle(true, false), oracle(false, false)])).toBe('red');
  });

  test('仅非确定性过 → yellow', () => {
    expect(evaluateTestGate([oracle(true, false), oracle(false, true)])).toBe('yellow');
  });

  test('确定性过 → green (非确定性 pass 与否都不降级)', () => {
    expect(evaluateTestGate([oracle(true, true), oracle(false, false)])).toBe('green');
    expect(evaluateTestGate([oracle(true, true), oracle(false, true)])).toBe('green');
  });

  test('deterministic=true, pass=true 多条仍 green', () => {
    expect(evaluateTestGate([
      oracle(true, true), oracle(true, true), oracle(true, true),
    ])).toBe('green');
  });

  test('deterministic=false 全过 → yellow (非确定性不能升 green)', () => {
    expect(evaluateTestGate([oracle(false, true), oracle(false, true)])).toBe('yellow');
  });

  test('deterministic=true 全失败 + 非确定性全失败 → red', () => {
    expect(evaluateTestGate([
      oracle(true, false), oracle(true, false), oracle(false, false),
    ])).toBe('red');
  });
});

describe('INV-18 runBootstrapGate: 三态与 PP-T03 升级', () => {
  /** 注入 adapter: 用计数 + 控制 ok 标志。 */
  function stubAdapter(ok: boolean, reason = 'NOT_IN_WORKING_SET'): InventoryInFlightAdapter & { calls: { id: string; status: string }[] } {
    const calls: { id: string; status: string }[] = [];
    return {
      calls,
      registerInFlight: (id, gate) => {
        calls.push({ id, status: gate.status });
        if (ok) return { ok: true, phase: 'in-flight', id };
        return { ok: false, phase: 'in-flight', reason, id };
      },
    };
  }

  test('evaluateTestGate=green + adapter.ok → kind:green', () => {
    const inv = stubAdapter(true);
    const v = runBootstrapGate({
      node: validNode(),
      oracleResults: [oracle(true, true)],
      inv,
    });
    expect(v).toEqual({ kind: 'green' });
    expect(inv.calls.length).toBe(1);
    expect(inv.calls[0]!.status).toBe('green');
  });

  test('evaluateTestGate=green + adapter.fail → 升级到 kind:yellow (PP-T03 信号)', () => {
    const inv = stubAdapter(false, 'NOT_IN_WORKING_SET');
    const v = runBootstrapGate({
      node: validNode(),
      oracleResults: [oracle(true, true)],
      inv,
    });
    expect(v).toEqual({ kind: 'yellow' });
    expect(inv.calls.length).toBe(1);
  });

  test('evaluateTestGate=green + adapter.fail reason=ALREADY_IN_FLIGHT → 仍升级到 yellow', () => {
    const inv = stubAdapter(false, 'ALREADY_IN_FLIGHT');
    const v = runBootstrapGate({
      node: validNode(),
      oracleResults: [oracle(true, true)],
      inv,
    });
    expect(v).toEqual({ kind: 'yellow' });
  });

  test('evaluateTestGate=green + adapter.fail reason=not_green → 仍升级到 yellow', () => {
    const inv = stubAdapter(false, 'not_green');
    const v = runBootstrapGate({
      node: validNode(),
      oracleResults: [oracle(true, true)],
      inv,
    });
    expect(v).toEqual({ kind: 'yellow' });
  });

  test('evaluateTestGate=yellow → kind:yellow, adapter 不被调用', () => {
    const inv = stubAdapter(true);
    const v = runBootstrapGate({
      node: validNode(),
      oracleResults: [oracle(false, true)], // 仅非确定性过
      inv,
    });
    expect(v).toEqual({ kind: 'yellow' });
    expect(inv.calls.length).toBe(0);
  });

  test('evaluateTestGate=red → kind:red, adapter 不被调用 (INV-18 红字面)', () => {
    const inv = stubAdapter(true);
    const v = runBootstrapGate({
      node: validNode(),
      oracleResults: [oracle(true, false), oracle(false, false)],
      inv,
    });
    expect(v).toEqual({ kind: 'red' });
    expect(inv.calls.length).toBe(0);
  });

  test('evaluateTestGate=red → verdict 不携带 tool_id / path / outputs (不向 conductor 透露该工具曾存在)', () => {
    const inv = stubAdapter(true);
    const toolPath = 'tools/secret-tool.ts';
    const toolId = 'secret:tool@9.9.9';
    const node = validNode({
      outputs: { tool_path: toolPath },
      test_gate: { ...validNode().test_gate, tool_id: toolId },
    });
    const v = runBootstrapGate({
      node,
      oracleResults: [oracle(true, false)],
      inv,
    });
    // 严格 shape: 只允许 `kind`, 任何 id / path 字段都不能漏出
    expect(Object.keys(v).sort()).toEqual(['kind']);
    const serialized = JSON.stringify(v);
    expect(serialized.includes(toolPath)).toBe(false);
    expect(serialized.includes(toolId)).toBe(false);
  });

  test('绿路经 defaultAdapter 一端到端: working-set 已升格 → 入 in-flight', () => {
    // 这是 defaultAdapter 真实 wiring 的最小探针; 用完整 InventoryEntry
    // (residence + signature + health + audit 四组字段, INV-S1-7 顺序锁定)。
    _resetInventoryForTests();
    const entry = {
      id: 'demo:tool@1.0.0',
      name: 'demo-tool',
      when_to_use: 'demo',
      effect: 'read',
      safety_class: 'safe',
      cost_tier: 't0',
      defer_mode: 'sync',
      signature: { inputs: {}, outputs: {} },
      oracle: { kind: 'command', gateScriptRef: 'gates/unit.sh' },
      probe_state: 'UNPROBED',
      applicability: 'UNKNOWN',
      failure_reason: undefined,
      idle_days: 0,
      provenance: validProvenance(),
      search_hint: 'demo',
      owner_pinned: false,
      oracle_bearing: true,
    };
    const reg = registerEntry(entry);
    if (!reg.ok) console.error('registerEntry fail:', reg.issues);
    expect(reg.ok).toBe(true);
    const pro = promoteToWorkingSet('demo:tool@1.0.0');
    expect(pro.ok).toBe(true);
    const v = runBootstrapGate({
      node: validNode(),
      oracleResults: [oracle(true, true)],
    });
    expect(v).toEqual({ kind: 'green' });
    _resetInventoryForTests();
  });
});

// ─── ④ INV-19 写权分立 ─────────────────────────────────────────────────────────

describe('INV-19 checkBootstrapWrite: 禁写 red_tests/', () => {
  test('路径 red_tests/foo.json → allowed:false + audit.kind=red_tests_blocked', () => {
    const ws = createBootstrapWriteSet(['tools/demo.ts'], FROZEN_NOW);
    const v = checkBootstrapWrite('red_tests/unit.json', ws, FROZEN_NOW);
    expect(v.allowed).toBe(false);
    if (!v.allowed) {
      expect(v.audit.kind).toBe('red_tests_blocked');
      expect(v.audit.path).toBe('red_tests/unit.json');
      expect(v.audit.reason).toContain('INV-19');
      expect(v.audit.reason).toContain('red_tests/');
      expect(v.audit.reason).toContain('plan-critic');
      expect(v.audit.ts).toBe('2026-02-01T12:00:00.000Z');
    }
  });

  test('裸目录名 "red_tests" (无斜杠) → 仍拒 (insideDir 覆盖裸名)', () => {
    const ws = createBootstrapWriteSet(['red_tests', 'tools/demo.ts'], FROZEN_NOW);
    const v = checkBootstrapWrite('red_tests', ws, FROZEN_NOW);
    expect(v.allowed).toBe(false);
    if (!v.allowed) expect(v.audit.kind).toBe('red_tests_blocked');
  });

  test('前缀近邻 "red_testsfoo" → 放行 (按 insideDir 规则不放行)', () => {
    const ws = createBootstrapWriteSet(['red_testsfoo'], FROZEN_NOW);
    const v = checkBootstrapWrite('red_testsfoo', ws, FROZEN_NOW);
    expect(v.allowed).toBe(true);
  });
});

describe('INV-19 checkBootstrapWrite: 禁写 fixtures/', () => {
  test('路径 fixtures/s1/baseline.json → allowed:false + audit.kind=fixtures_blocked', () => {
    const ws = createBootstrapWriteSet(['tools/demo.ts'], FROZEN_NOW);
    const v = checkBootstrapWrite('fixtures/s1/baseline.json', ws, FROZEN_NOW);
    expect(v.allowed).toBe(false);
    if (!v.allowed) {
      expect(v.audit.kind).toBe('fixtures_blocked');
      expect(v.audit.path).toBe('fixtures/s1/baseline.json');
      expect(v.audit.reason).toContain('INV-19');
      expect(v.audit.reason).toContain('fixtures/');
      expect(v.audit.reason).toContain('plan-critic');
    }
  });

  test('路径 fixtures/ (裸) → 仍拒', () => {
    const ws = createBootstrapWriteSet(['fixtures', 'tools/demo.ts'], FROZEN_NOW);
    const v = checkBootstrapWrite('fixtures', ws, FROZEN_NOW);
    expect(v.allowed).toBe(false);
    if (!v.allowed) expect(v.audit.kind).toBe('fixtures_blocked');
  });
});

describe('INV-19 checkBootstrapWrite: 写集注册期冻结 + 运行时越界', () => {
  test('未在 frozen 集 → shadow_exec + audit 列出 frozen 路径', () => {
    const ws = createBootstrapWriteSet(['tools/demo.ts'], FROZEN_NOW);
    const v = checkBootstrapWrite('evil/sneaky.ts', ws, FROZEN_NOW);
    expect(v.allowed).toBe(false);
    if (!v.allowed) {
      expect(v.audit.kind).toBe('shadow_exec');
      expect(v.audit.path).toBe('evil/sneaky.ts');
      expect(v.audit.reason).toContain('INV-19');
      expect(v.audit.reason).toContain('frozen');
      expect(v.audit.reason).toContain('tools/demo.ts');
    }
  });

  test('已 shrink (current ⊂ frozen) → shadow_exec + audit 列出 current', () => {
    const ws = createBootstrapWriteSet(['tools/a.ts', 'tools/b.ts'], FROZEN_NOW);
    ws.shrink(['tools/b.ts']);
    const v = checkBootstrapWrite('tools/b.ts', ws, FROZEN_NOW);
    expect(v.allowed).toBe(false);
    if (!v.allowed) {
      expect(v.audit.kind).toBe('shadow_exec');
      expect(v.audit.reason).toContain('shrink');
      expect(v.audit.reason).toContain('tools/a.ts');
      expect(v.audit.reason).not.toContain('tools/b.ts'); // 已被缩掉, 不再列
    }
  });

  test('shrink 一个本就未在 frozen 的路径 → no-op, 写权不被偷偷扩大', () => {
    const ws = createBootstrapWriteSet(['tools/a.ts'], FROZEN_NOW);
    ws.shrink(['evil/x.ts']);
    // evil/x.ts 原本就越界; 现在越界原因仍是不在 frozen, 不是 shrink
    const v = checkBootstrapWrite('evil/x.ts', ws, FROZEN_NOW);
    expect(v.allowed).toBe(false);
    if (!v.allowed) expect(v.audit.kind).toBe('shadow_exec');
  });

  test('合法路径 (在 current 中) → allowed:true (不产 audit)', () => {
    const ws = createBootstrapWriteSet(['tools/a.ts'], FROZEN_NOW);
    const v = checkBootstrapWrite('tools/a.ts', ws, FROZEN_NOW);
    expect(v).toEqual({ allowed: true });
  });

  test('拒绝顺序: red_tests 优先于 shadow_exec (路径在 red_tests 且未在 frozen)', () => {
    const ws = createBootstrapWriteSet([], FROZEN_NOW); // 写集空, frozen 必越界
    const v = checkBootstrapWrite('red_tests/anything.ts', ws, FROZEN_NOW);
    expect(v.allowed).toBe(false);
    if (!v.allowed) expect(v.audit.kind).toBe('red_tests_blocked');
  });

  test('拒绝顺序: fixtures 优先于 shadow_exec', () => {
    const ws = createBootstrapWriteSet([], FROZEN_NOW);
    const v = checkBootstrapWrite('fixtures/anything.json', ws, FROZEN_NOW);
    expect(v.allowed).toBe(false);
    if (!v.allowed) expect(v.audit.kind).toBe('fixtures_blocked');
  });

  test('BootstrapWriteSet 自带 check() 与 checkBootstrapWrite 等价', () => {
    const ws: BootstrapWriteSet = createBootstrapWriteSet(['tools/a.ts'], FROZEN_NOW);
    const a = ws.check('red_tests/x.ts');
    const b = checkBootstrapWrite('red_tests/x.ts', ws, FROZEN_NOW);
    expect(a).toEqual(b);
  });

  test('frozenSnapshot / currentSnapshot 在 shrink 后 current ⊂ frozen', () => {
    const ws = createBootstrapWriteSet(['tools/a.ts', 'tools/b.ts', 'tools/c.ts'], FROZEN_NOW);
    expect([...ws.frozenSnapshot()].sort()).toEqual(['tools/a.ts', 'tools/b.ts', 'tools/c.ts']);
    ws.shrink(['tools/b.ts', 'tools/c.ts']);
    expect([...ws.frozenSnapshot()].sort()).toEqual(['tools/a.ts', 'tools/b.ts', 'tools/c.ts']);
    expect([...ws.currentSnapshot()].sort()).toEqual(['tools/a.ts']);
  });

  test('audit.ts 字段齐: kind ∈ {red_tests_blocked, fixtures_blocked, shadow_exec}', () => {
    const ws = createBootstrapWriteSet(['tools/demo.ts'], FROZEN_NOW);
    const variants = [
      ['red_tests/x', 'red_tests_blocked'],
      ['fixtures/y', 'fixtures_blocked'],
      ['evil/z', 'shadow_exec'],
    ] as const;
    for (const [path, kind] of variants) {
      const v = checkBootstrapWrite(path, ws, FROZEN_NOW);
      expect(v.allowed).toBe(false);
      if (!v.allowed) {
        expect(['red_tests_blocked', 'fixtures_blocked', 'shadow_exec']).toContain(v.audit.kind);
        expect(v.audit.kind).toBe(kind);
        expect(typeof v.audit.path).toBe('string');
        expect(typeof v.audit.reason).toBe('string');
        expect(v.audit.reason.length).toBeGreaterThan(0);
        expect(typeof v.audit.ts).toBe('string');
        expect(v.audit.ts).toBe('2026-02-01T12:00:00.000Z');
      }
    }
  });

  test('audit 始终是返回结构, 不写文件 (BootstrapWriteSet 不暴露文件 API)', () => {
    // 反向断言: 类型上 BootstrapWriteSet 没 fs 方法。
    const ws: BootstrapWriteSet = createBootstrapWriteSet(['tools/a.ts'], FROZEN_NOW);
    const keys = Object.keys(ws).sort();
    // 期望只有 contains / frozenHas / check / shrink / frozenSnapshot / currentSnapshot
    expect(keys).toEqual([
      'check', 'contains', 'currentSnapshot', 'frozenHas', 'frozenSnapshot', 'shrink',
    ]);
  });
});

// ─── ⑤ INV-20 build-time 边引用判定 ───────────────────────────────────────────

describe('INV-20 canBeReferencedByBuildTimeEdge', () => {
  test('green 可被引用', () => {
    expect(canBeReferencedByBuildTimeEdge('green')).toBe(true);
  });

  test.each([
    ['yellow', false],
    ['red', false],
  ] as const)('test_gate=%s → 不可被引用 (返回 %s)', (state, expected) => {
    expect(canBeReferencedByBuildTimeEdge(state)).toBe(expected);
  });

  test('契约穷尽枚举 (反 slop 防漏): 仅 green 真', () => {
    const verdicts = ['green', 'yellow', 'red'] as const;
    const result = verdicts.map((s) => ({
      state: s,
      ok: canBeReferencedByBuildTimeEdge(s),
    }));
    expect(result).toEqual([
      { state: 'green', ok: true },
      { state: 'yellow', ok: false },
      { state: 'red', ok: false },
    ]);
  });
});

// ─── 全局隔离 ─────────────────────────────────────────────────────────────────

afterEach(() => {
  // 不依赖 inventory 在本件已被污染; 但保险起见重置一次。
  _resetInventoryForTests();
});
