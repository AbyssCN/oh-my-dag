import { describe, expect, test } from 'bun:test';
import { PlanSchema } from '../../src/harness/conductor-plan';
import { expandMapNode, DEFAULT_MAX_ITEMS, type MapSpecLike } from '../../src/harness/plan/map-expand';

// U1 动态扇出节点 P0 — 纯逻辑, 无模型/无 DB。
// 证: schema 交叉校验 (map⇔executor / INV-U5 禁嵌套) + 展开 (运行时宽度/稳定id/有界/空/非数组/路径唯一/插值)。

// ── schema 交叉校验 (superRefine) ─────────────────────────────────────────────

const plan = (node: Record<string, unknown>) => PlanSchema.safeParse({ name: 't', nodes: { n1: node } });

const validMap = {
  executor: 'map',
  map: {
    lister: { executor: 'command', command: 'codegraph files src/omd' },
    over: 'modules',
    itemVar: 'm',
    keyBy: 'path',
    template: { executor: 'agent', goal: '审计 ${m.path}', output_type: 'file', output_path: 'out.md' },
  },
};

describe('U1 schema · map⇔executor 互 required + INV-U5', () => {
  test('合法 map 节点通过', () => {
    expect(plan(validMap).success).toBe(true);
  });

  test("executor:'map' 缺 map spec → 拒", () => {
    const r = plan({ executor: 'map' });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues.some((i) => i.path.join('.') === 'nodes.n1.map')).toBe(true);
  });

  test("有 map spec 但 executor≠'map' → 拒", () => {
    const r = plan({ executor: 'agent', map: validMap.map });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues.some((i) => i.path.join('.') === 'nodes.n1.executor')).toBe(true);
  });

  test('INV-U5: 模板 executor:map (嵌套) → 拒', () => {
    const nested = { executor: 'map', map: { ...validMap.map, template: { executor: 'map' } } };
    const r = plan(nested);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues.some((i) => i.message.includes('INV-U5'))).toBe(true);
  });

  test('非 map 节点不受影响 (回归)', () => {
    expect(plan({ executor: 'leaf', goal: 'x' }).success).toBe(true);
  });
});

// ── 纯展开 expandMapNode ──────────────────────────────────────────────────────

const baseSpec: MapSpecLike = {
  over: 'modules',
  itemVar: 'm',
  keyBy: 'path',
  template: { executor: 'agent', goal: '审计 ${m.path} 的错误处理', output_type: 'file', output_path: 'audit.md' },
};

describe('U1 展开 · 运行时宽度 + 稳定 id', () => {
  test('G1 运行时宽度: lister 出 7 项 → 7 子节点 (非 author-time 定)', () => {
    const items = Array.from({ length: 7 }, (_, i) => ({ path: `src/omd/mod${i}` }));
    const r = expandMapNode('audit', baseSpec, { modules: items });
    expect(r.status).toBe('ok');
    expect(r.children).toHaveLength(7);
    expect(r.truncated).toBe(0);
  });

  test('子 id 格式 = `${mapId}::${key}` 且 key 来自 keyBy', () => {
    const r = expandMapNode('audit', baseSpec, { modules: [{ path: 'src/omd/plan' }] });
    expect(r.children[0]!.id).toBe('audit::src-omd-plan');
    expect(r.children[0]!.key).toBe('src-omd-plan');
  });

  test('G4 重排稳定: 同项不同序 → 同子 id 集 (按 key 排序, 顺序无关)', () => {
    const a = [{ path: 'b' }, { path: 'a' }, { path: 'c' }];
    const b = [{ path: 'c' }, { path: 'a' }, { path: 'b' }];
    const ids = (arr: unknown[]) => expandMapNode('m', baseSpec, { modules: arr }).children.map((c) => c.id);
    expect(ids(a)).toEqual(ids(b));
    expect(ids(a)).toEqual(['m::a', 'm::b', 'm::c']);
  });

  test('keyBy 缺省 → 内容 hash key (确定, 同内容同 key)', () => {
    const s = { ...baseSpec, keyBy: undefined };
    const r1 = expandMapNode('m', s, { modules: [{ path: 'x', v: 1 }] });
    const r2 = expandMapNode('m', s, { modules: [{ path: 'x', v: 1 }] });
    expect(r1.children[0]!.key).toBe(r2.children[0]!.key);
    expect(r1.children[0]!.key).toMatch(/^[0-9a-f]{8}$/);
  });

  test('key 撞车消歧: 两元素归一化后同 key → 追加 hash 短尾唯一', () => {
    const r = expandMapNode('m', baseSpec, { modules: [{ path: 'a/b' }, { path: 'a.b' }] }); // 都 → 'a-b'
    const keys = r.children.map((c) => c.key);
    expect(new Set(keys).size).toBe(2); // 唯一
    expect(keys.some((k) => k === 'a-b')).toBe(true);
  });
});

describe('U1 展开 · 有界 / 空 / 非数组 (反 happy-path)', () => {
  test('G5 有界: 500 项 maxItems 50 → 50 子 + truncated 450', () => {
    const items = Array.from({ length: 500 }, (_, i) => ({ path: `m${String(i).padStart(3, '0')}` }));
    const r = expandMapNode('m', { ...baseSpec, maxItems: 50 }, { modules: items });
    expect(r.children).toHaveLength(50);
    expect(r.truncated).toBe(450);
  });

  test('默认 maxItems = 64', () => {
    const items = Array.from({ length: 100 }, (_, i) => ({ path: `m${String(i).padStart(3, '0')}` }));
    const r = expandMapNode('m', baseSpec, { modules: items });
    expect(r.children).toHaveLength(DEFAULT_MAX_ITEMS);
    expect(r.truncated).toBe(100 - DEFAULT_MAX_ITEMS);
  });

  test('G9 空清单 → status empty, 0 子 (不报错)', () => {
    const r = expandMapNode('m', baseSpec, { modules: [] });
    expect(r.status).toBe('empty');
    expect(r.children).toHaveLength(0);
  });

  test('over 键非数组 → status not_array', () => {
    expect(expandMapNode('m', baseSpec, { modules: 'oops' }).status).toBe('not_array');
    expect(expandMapNode('m', baseSpec, {}).status).toBe('not_array');
    expect(expandMapNode('m', baseSpec, null).status).toBe('not_array');
  });

  test('INV-U5 防御性二道闸: 模板 executor:map → nested_map', () => {
    const r = expandMapNode('m', { ...baseSpec, template: { executor: 'map' } }, { modules: [{ path: 'a' }] });
    expect(r.status).toBe('nested_map');
    expect(r.children).toHaveLength(0);
  });
});

describe('U1 展开 · 插值 + 路径唯一 (INV-U8)', () => {
  test('${itemVar.field} 插值进 goal', () => {
    const r = expandMapNode('m', baseSpec, { modules: [{ path: 'src/omd/dag' }] });
    expect(r.children[0]!.node.goal).toBe('审计 src/omd/dag 的错误处理');
  });

  test('${itemVar} 整元素 (字符串直插) + ${key}', () => {
    const s: MapSpecLike = { over: 'xs', itemVar: 'x', template: { goal: 'do ${x} @${key}' } };
    const r = expandMapNode('m', s, { xs: ['alpha'] });
    expect(r.children[0]!.node.goal).toBe('do alpha @alpha');
  });

  test('未解析 token 保留字面 (可见失败)', () => {
    const s: MapSpecLike = { over: 'xs', itemVar: 'x', template: { goal: 'a ${nope} b' } };
    const r = expandMapNode('m', s, { xs: ['q'] });
    expect(r.children[0]!.node.goal).toBe('a ${nope} b');
  });

  test('G10 路径唯一: 模板 output_path 不含 key → 按 key 唯一化, N 子路径互不撞', () => {
    const items = [{ path: 'a' }, { path: 'b' }, { path: 'c' }];
    const r = expandMapNode('m', baseSpec, { modules: items }); // output_path: 'audit.md' (无 token)
    const paths = r.children.map((c) => c.node.output_path);
    expect(new Set(paths).size).toBe(3);
    expect(paths).toContain('audit.a.md');
  });

  test('模板已含 key token → 不重复唯一化', () => {
    const s = { ...baseSpec, template: { ...baseSpec.template, output_path: 'out/${key}/report.md' } };
    const r = expandMapNode('m', s, { modules: [{ path: 'x' }] });
    expect(r.children[0]!.node.output_path).toBe('out/x/report.md');
  });

  test('展开不改原模板 (structuredClone 隔离)', () => {
    const s: MapSpecLike = { over: 'xs', itemVar: 'x', template: { goal: 'hi ${x}' } };
    expandMapNode('m', s, { xs: ['a'] });
    expect(s.template.goal).toBe('hi ${x}'); // 原模板未被插值污染
  });
});
