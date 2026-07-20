/**
 * 红测试: oracle-plan-filter —— plan 内 command 节点与 oracle-cmd 等价或被其包含时过滤。
 *
 * 契约:
 *  - oracle-cmd = "bun run typecheck && bun test"
 *  - plan 中 command 内容与之等价 (含空白差异: 多余空格/换行/Tab) 的节点 → 被移除/中和
 *  - plan 中 command 是 oracle-cmd 子串 (被 oracle 包含) 的节点 → 被移除/中和
 *  - plan 中 command 是 oracle-cmd 超集 (包含 oracle) 的节点 → 不移除 (conductor 额外步骤)
 *  - 被删节点下游 depends_on 被无害重接 (无悬空引用, topoLevels 不报环)
 *  - 非 oracle 来源、含 && 元字符的 command 节点 → 仍被 command-leaf 元字符闸拒绝 (闸未放宽)
 */
import { describe, expect, test } from 'bun:test';
import type { ConductorPlan } from './conductor-plan';
import { topoLevels } from './executor-dag';
import { createCommandLeafRunner } from './command-leaf';

// ── 待实现 (import 即红) ──────────────────────────────────────────────────────
import { filterOracleCommandNodes } from './oracle-plan-filter';

// ── fixtures ──────────────────────────────────────────────────────────────────

const ORACLE_CMD = 'bun run typecheck && bun test';

/** 基础 plan: verify 节点依赖一个与 oracle-cmd 等价的 command 节点。 */
function basePlan(): ConductorPlan {
  return {
    name: 'test-plan',
    nodes: {
      setup: { executor: 'leaf', goal: 'setup env' },
      verify: {
        executor: 'command',
        command: ORACLE_CMD,
        depends_on: ['setup'],
      },
      report: {
        executor: 'leaf',
        goal: 'write report',
        depends_on: ['verify'],
      },
    },
  };
}

// ── helpers ───────────────────────────────────────────────────────────────────

/** 验证 plan 无悬空 depends_on 引用 + 拓扑无环。 */
function assertGraphSound(plan: ConductorPlan): void {
  const idSet = new Set(Object.keys(plan.nodes));
  for (const [id, node] of Object.entries(plan.nodes)) {
    for (const dep of node.depends_on ?? []) {
      expect(idSet.has(dep)).toBe(true); // 无悬空引用
    }
  }
  expect(() => topoLevels(plan)).not.toThrow(); // 无环
}

// ── 1. 过滤器: 移除/中和 oracle 等价节点 ──────────────────────────────────────

describe('filterOracleCommandNodes', () => {
  test('精确匹配移除 oracle-cmd 节点', () => {
    const plan = basePlan();
    const filtered = filterOracleCommandNodes(plan, ORACLE_CMD);
    expect(filtered.nodes['verify']).toBeUndefined();
    expect(Object.keys(filtered.nodes)).toContain('setup');
    expect(Object.keys(filtered.nodes)).toContain('report');
  });

  test('多余空格变体仍被移除', () => {
    const plan = basePlan();
    plan.nodes['verify']!.command = 'bun  run typecheck  &&  bun  test';
    const filtered = filterOracleCommandNodes(plan, ORACLE_CMD);
    expect(filtered.nodes['verify']).toBeUndefined();
  });

  test('换行变体仍被移除', () => {
    const plan = basePlan();
    plan.nodes['verify']!.command = 'bun run typecheck\n&& bun test';
    const filtered = filterOracleCommandNodes(plan, ORACLE_CMD);
    expect(filtered.nodes['verify']).toBeUndefined();
  });

  test('Tab 变体仍被移除', () => {
    const plan = basePlan();
    plan.nodes['verify']!.command = 'bun run typecheck\t&&\tbun test';
    const filtered = filterOracleCommandNodes(plan, ORACLE_CMD);
    expect(filtered.nodes['verify']).toBeUndefined();
  });

  test('前缀/后缀空白变体仍被移除', () => {
    const plan = basePlan();
    plan.nodes['verify']!.command = '  bun run typecheck && bun test  \n';
    const filtered = filterOracleCommandNodes(plan, ORACLE_CMD);
    expect(filtered.nodes['verify']).toBeUndefined();
  });
  test('command 是 oracle 子串 (被 oracle 包含) → 移除', () => {
    const plan = basePlan();
    // oracle = "bun run typecheck && bun test"; command = "bun run typecheck" (子串)
    plan.nodes['verify']!.command = 'bun run typecheck';
    const filtered = filterOracleCommandNodes(plan, ORACLE_CMD);
    expect(filtered.nodes['verify']).toBeUndefined();
  });

  test('command 是 oracle 的另一子串 (被 oracle 包含) → 移除', () => {
    const plan = basePlan();
    // oracle = "bun run typecheck && bun test"; command = "bun test" (子串)
    plan.nodes['verify']!.command = 'bun test';
    const filtered = filterOracleCommandNodes(plan, ORACLE_CMD);
    expect(filtered.nodes['verify']).toBeUndefined();
  });

  test('command 包含 oracle (oracle 是 command 子串) → 不移除', () => {
    const plan = basePlan();
    // command 是 oracle 的超集 → conductor 额外加了步骤, 不应过滤
    plan.nodes['verify']!.command = 'bun run typecheck && bun test && echo done';
    const filtered = filterOracleCommandNodes(plan, ORACLE_CMD);
    expect(filtered.nodes['verify']).toBeDefined();
  });
});

// ── 2. 图连通性: 被删节点下游 depends_on 被无害重接 ─────────────────────────

describe('graph connectivity after filter', () => {
  test('被删节点的下游重接到上游, 无悬空引用', () => {
    const plan = basePlan();
    // verify (oracle) depends_on: [setup]; report depends_on: [verify]
    // 移除 verify → report.depends_on 应重接到 [setup] (verify 的上游)
    const filtered = filterOracleCommandNodes(plan, ORACLE_CMD);
    expect(filtered.nodes['report']?.depends_on).toContain('setup');
    expect(filtered.nodes['report']?.depends_on).not.toContain('verify');
    assertGraphSound(filtered);
  });

  test('被删节点无上游时, 下游 depends_on 为空 (变根)', () => {
    const plan: ConductorPlan = {
      name: 'no-upstream',
      nodes: {
        verify: { executor: 'command', command: ORACLE_CMD },
        report: { executor: 'leaf', goal: 'report', depends_on: ['verify'] },
      },
    };
    const filtered = filterOracleCommandNodes(plan, ORACLE_CMD);
    expect(filtered.nodes['verify']).toBeUndefined();
    expect(filtered.nodes['report']?.depends_on ?? []).toHaveLength(0);
    assertGraphSound(filtered);
  });

  test('被删节点有多个上游 + 多个下游', () => {
    const plan: ConductorPlan = {
      name: 'multi-fan',
      nodes: {
        a: { executor: 'leaf', goal: 'a' },
        b: { executor: 'leaf', goal: 'b' },
        verify: { executor: 'command', command: ORACLE_CMD, depends_on: ['a', 'b'] },
        c: { executor: 'leaf', goal: 'c', depends_on: ['verify'] },
        d: { executor: 'leaf', goal: 'd', depends_on: ['verify'] },
      },
    };
    const filtered = filterOracleCommandNodes(plan, ORACLE_CMD);
    expect(filtered.nodes['verify']).toBeUndefined();
    // c, d 应分别获得 [a, b] (verify 的上游)
    for (const down of ['c', 'd'] as const) {
      const deps = filtered.nodes[down]?.depends_on ?? [];
      expect(deps).toContain('a');
      expect(deps).toContain('b');
      expect(deps).not.toContain('verify');
    }
    assertGraphSound(filtered);
  });

  test('多级依赖链: A → oracle → B → C, 过滤后 B→A, C→B', () => {
    const plan: ConductorPlan = {
      name: 'chain',
      nodes: {
        A: { executor: 'leaf', goal: 'start' },
        oracle: { executor: 'command', command: ORACLE_CMD, depends_on: ['A'] },
        B: { executor: 'leaf', goal: 'mid', depends_on: ['oracle'] },
        C: { executor: 'leaf', goal: 'end', depends_on: ['B'] },
      },
    };
    const filtered = filterOracleCommandNodes(plan, ORACLE_CMD);
    expect(filtered.nodes['oracle']).toBeUndefined();
    expect(filtered.nodes['B']?.depends_on).toContain('A');
    expect(filtered.nodes['C']?.depends_on).toContain('B');
    assertGraphSound(filtered);
  });
});

// ── 3. 回归: command-leaf 元字符闸未放宽 ──────────────────────────────────────

describe('command-leaf metachar gate regression', () => {
  test('含 && 的非 oracle 来源 command 仍被元字符闸拒绝', async () => {
    const runner = createCommandLeafRunner({
      allowlist: ['bun'],
      spawn: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    });
    // 含 && 元字符 (非 oracle 来源, 这是 conductor 模型自己产出的 command)
    const result = await runner({ command: 'bun test && echo done' });
    expect(result.exitCode).toBe(-1);
    expect(result.text).toContain('blocked');
  });

  test('含 | 的 command 仍被元字符闸拒绝', async () => {
    const runner = createCommandLeafRunner({
      allowlist: ['bun'],
      spawn: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    });
    const result = await runner({ command: 'bun test | head -5' });
    expect(result.exitCode).toBe(-1);
    expect(result.text).toContain('blocked');
  });

  test('含 ; 的 command 仍被元字符闸拒绝', async () => {
    const runner = createCommandLeafRunner({
      allowlist: ['bun'],
      spawn: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    });
    const result = await runner({ command: 'bun test; rm -rf /tmp/x' });
    expect(result.exitCode).toBe(-1);
    expect(result.text).toContain('blocked');
  });

  test('安全 command 通过 (无元字符)', async () => {
    const runner = createCommandLeafRunner({
      allowlist: ['bun'],
      spawn: async () => ({ stdout: 'ok', stderr: '', exitCode: 0 }),
    });
    const result = await runner({ command: 'bun test' });
    expect(result.exitCode).toBe(0);
    expect(result.text).toBe('ok');
  });
});
