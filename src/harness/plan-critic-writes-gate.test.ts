/**
 * plan-critic PP-O02 (#244 C-1) 反向自检 —— writes-without-gate 静态闸。
 *
 * 契约源: docs/plan/2026-08-25-夜间自主迭代-goal.md Wave B1 / #244 C-1。
 * 设计:
 *  - 纯 STATIC (零 LLM); 与 PP-O01/PP-I01/PP-I02 同性质。
 *  - 五条 GWT + INV-4 两条反向自检 (一正一反, 一绿一红, 真跑断言)。
 *  - 不复用 plan-critic.test.ts 的 fixture, 本文件独立装配避免与既有 12 码耦合。
 */
import { describe, expect, test } from 'bun:test';
import { critique, type CriticInput } from './plan-critic';
import { PlanSchema, type ConductorPlan } from './conductor-plan';

// ──────────────────────────────────────────────────────────────────────────────
// fixture 工厂 (本地精简版)
// ──────────────────────────────────────────────────────────────────────────────

/** 装配 ConductorPlan —— 故意不用 PlanSchema 的强校验 (passthrough 已允许任意字段);
 *  直接 .parse 一个最小骨架, 再把 nodes 覆盖, 保证字段不丢。 */
function mkPlan(nodes: Record<string, Record<string, unknown>>, suppressions: string[] = []): ConductorPlan {
  return PlanSchema.parse({
    name: 'pp-o02-test',
    schema_version: '1.0',
    suppressions,
    nodes,
  }) as ConductorPlan;
}

function mkInput(plan: ConductorPlan): CriticInput {
  return {
    plan,
    round: 1,
    workingSet: [],
    skills: [],
    runId: 'pp-o02-run',
  };
}

/** 写文件节点 + 全图无 command 节点 + 无 oracleKind —— PP-O02 应亮。 */
function pp_o02_shouldFire_plan(): ConductorPlan {
  return mkPlan({
    writer: {
      executor: 'leaf',
      goal: 'write file',
      // 无 oracleKind, output_type=file → 写节点 + 无 oracle + 全图无 command
      output_type: 'file',
      output_path: 'src/foo.ts',
      toolRefs: ['bash'],
      whyNoFanout: 'atomic write',
    },
  });
}

/** 取 PP-O02 诊断 (按 code 过滤)。 */
function pp_o02(diags: ReturnType<typeof critique>) {
  return diags.filter((d) => d.code === 'PP-O02');
}

// ──────────────────────────────────────────────────────────────────────────────
// GWT-1: 写文件节点无 oracleKind + 全图无 command → PP-O02, node_id 点名
// ──────────────────────────────────────────────────────────────────────────────

describe('plan-critic PP-O02 — GWT-1 写节点无 oracle + 全图无 command 触发', () => {
  test('output_type=file 节点 + 无 oracleKind + 全图无 command → PP-O02, node_id="writer"', () => {
    const plan = pp_o02_shouldFire_plan();
    const diags = critique(mkInput(plan));
    const o02 = pp_o02(diags);
    expect(o02.length).toBe(1);
    expect(o02[0]?.node_id).toBe('writer');
    expect(o02[0]?.severity).toBe('error');
    expect(o02[0]?.suppressible).toBe(false);
    // evidence 必含四项 (output_type / output_path / oracleKind / command_verifier=none)
    const ev = o02[0]?.evidence ?? [];
    expect(ev.some((e) => e === 'output_type=file')).toBe(true);
    expect(ev.some((e) => e === 'output_path=src/foo.ts')).toBe(true);
    expect(ev.some((e) => e === 'oracleKind=<unset>')).toBe(true);
    expect(ev.some((e) => e === 'command_verifier=none')).toBe(true);
    // remediation 必须包含两条出路原文
    expect(o02[0]?.remediation).toContain('executor:"command"');
    expect(o02[0]?.remediation).toContain('oracleKind');
    expect(o02[0]?.remediation).toContain('judge');
  });

  test('output_path 非空 (无 output_type) 同样触发 PP-O02', () => {
    // 即只声明 output_path 不声明 output_type 也算写节点
    const plan = mkPlan({
      writer: {
        executor: 'leaf',
        goal: 'write file via path only',
        // oracleKind 故意缺
        output_path: 'src/bar.ts',
        toolRefs: ['bash'],
        whyNoFanout: 'atomic write',
      },
    });
    const diags = critique(mkInput(plan));
    expect(pp_o02(diags).length).toBe(1);
  });

  test('output_type=git 同样触发 PP-O02', () => {
    const plan = mkPlan({
      committer: {
        executor: 'leaf',
        goal: 'commit file',
        // oracleKind 故意缺
        output_type: 'git',
        output_path: '.omd/runs/x',
        toolRefs: ['bash'],
        whyNoFanout: 'atomic commit',
      },
    });
    const diags = critique(mkInput(plan));
    expect(pp_o02(diags).length).toBe(1);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// GWT-2: 同上 + 图含 command 节点 → 无 PP-O02 (command 验证步充当图级闸)
// ──────────────────────────────────────────────────────────────────────────────

describe('plan-critic PP-O02 — GWT-2 写节点 + 图含 command → 不亮', () => {
  test('写节点无 oracleKind, 但全图有 executor=command 节点 → PP-O02 不亮', () => {
    const plan = mkPlan({
      writer: {
        executor: 'leaf',
        goal: 'write file',
        // oracleKind 故意缺
        output_type: 'file',
        output_path: 'src/foo.ts',
        toolRefs: ['bash'],
        whyNoFanout: 'atomic write',
      },
      verifier: {
        // 哪怕命令里啥都不跑, 只要 executor=command 就算图级验证步
        executor: 'command',
        command: 'test -f src/foo.ts',
        oracleKind: 'cheap',
        toolRefs: ['bash'],
        whyNoFanout: 'verify file exists',
      },
    });
    const diags = critique(mkInput(plan));
    expect(pp_o02(diags).length).toBe(0);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// GWT-3: 写节点声明 oracleKind:judge → 无 PP-O02 (文档类交付合法)
// ──────────────────────────────────────────────────────────────────────────────

describe('plan-critic PP-O02 — GWT-3 写节点 oracleKind=judge → 不亮', () => {
  test('oracleKind=judge 即便全图无 command 节点也不触发 PP-O02', () => {
    const plan = mkPlan({
      doc: {
        executor: 'leaf',
        goal: 'write doc',
        oracleKind: 'judge', // 文档类交付合法
        output_type: 'file',
        output_path: 'docs/x.md',
        toolRefs: ['bash'],
        whyNoFanout: 'docs atomic',
      },
    });
    const diags = critique(mkInput(plan));
    expect(pp_o02(diags).length).toBe(0);
  });

  test('oracleKind=cheap 也豁免 PP-O02 (cheap 本身就是 oracle)', () => {
    const plan = mkPlan({
      cheapie: {
        executor: 'command',
        command: 'echo > out.txt',
        oracleKind: 'cheap',
        output_type: 'file',
        output_path: 'out.txt',
        toolRefs: ['bash'],
        whyNoFanout: 'atomic cheap write',
      },
    });
    const diags = critique(mkInput(plan));
    expect(pp_o02(diags).length).toBe(0);
  });

  test('oracleKind=render 也豁免 PP-O02', () => {
    const plan = mkPlan({
      render: {
        executor: 'leaf',
        goal: 'render',
        oracleKind: 'render',
        output_type: 'file',
        output_path: 'out.svg',
        toolRefs: ['bash'],
        whyNoFanout: 'atomic render',
      },
    });
    const diags = critique(mkInput(plan));
    expect(pp_o02(diags).length).toBe(0);
  });

  test('oracleKind=self_built 也豁免 PP-O02', () => {
    const plan = mkPlan({
      self: {
        executor: 'leaf',
        goal: 'self built',
        oracleKind: 'self_built',
        output_type: 'file',
        output_path: 'out.bin',
        toolRefs: ['bash'],
        whyNoFanout: 'atomic self built',
      },
    });
    const diags = critique(mkInput(plan));
    expect(pp_o02(diags).length).toBe(0);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// GWT-4: 写节点声明 oracleKind='none' → PP-O02 仍亮 (none 不是逃生门)
// ──────────────────────────────────────────────────────────────────────────────

describe('plan-critic PP-O02 — GWT-4 oracleKind="none" 非逃生门', () => {
  test('写节点 oracleKind="none" + 全图无 command → PP-O02 必亮', () => {
    const plan = mkPlan({
      writer: {
        executor: 'leaf',
        goal: 'write file',
        oracleKind: 'none', // 显式 none —— 不是逃生门
        output_type: 'file',
        output_path: 'src/foo.ts',
        toolRefs: ['bash'],
        whyNoFanout: 'atomic write',
      },
    });
    const diags = critique(mkInput(plan));
    const o02 = pp_o02(diags);
    expect(o02.length).toBe(1);
    expect(o02[0]?.node_id).toBe('writer');
    // evidence 中 oracleKind=none (而不是 <unset>)
    expect(o02[0]?.evidence.some((e) => e === 'oracleKind=none')).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// GWT-5: 全图无写节点 → PP-O02 不亮
// ──────────────────────────────────────────────────────────────────────────────

describe('plan-critic PP-O02 — GWT-5 全图无写节点 → 不亮', () => {
  test('纯只读 plan (无 output_type/output_path) → PP-O02 不亮', () => {
    const plan = mkPlan({
      reader: {
        executor: 'leaf',
        goal: 'read code',
        oracleKind: 'cheap',
        toolRefs: ['bash'],
        whyNoFanout: 'atomic read',
      },
      thinker: {
        executor: 'leaf',
        goal: 'think',
        oracleKind: 'judge',
        toolRefs: ['bash'],
        whyNoFanout: 'atomic think',
      },
    });
    const diags = critique(mkInput(plan));
    expect(pp_o02(diags).length).toBe(0);
  });

  test('单叶非写节点 → PP-O02 不亮 (单节点图但无 output_path/output_type)', () => {
    const plan = mkPlan({
      reader: {
        executor: 'leaf',
        goal: 'read code',
        oracleKind: 'cheap',
        toolRefs: ['bash'],
        whyNoFanout: 'atomic',
      },
    });
    const diags = critique(mkInput(plan));
    expect(pp_o02(diags).length).toBe(0);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// INV-4 反向自检: 一条永远红的码与永远绿的码一样不是闸 (两条反例)
// ──────────────────────────────────────────────────────────────────────────────

describe('plan-critic PP-O02 — INV-4 反向自检 (两条反例必不触发)', () => {
  test('反例 A: 写节点 + 图含 command 节点 → 无 PP-O02 (不是永远红)', () => {
    const plan = mkPlan({
      writer: {
        executor: 'leaf',
        goal: 'write',
        // oracleKind 故意缺
        output_type: 'file',
        output_path: 'x.ts',
        toolRefs: ['bash'],
        whyNoFanout: 'atomic',
      },
      verifier: {
        executor: 'command',
        command: 'true',
        oracleKind: 'cheap',
        toolRefs: ['bash'],
        whyNoFanout: 'verify',
      },
    });
    expect(pp_o02(critique(mkInput(plan))).length).toBe(0);
  });

  test('反例 B: 写节点声明 oracleKind=judge → 无 PP-O02 (不是永远红)', () => {
    const plan = mkPlan({
      doc: {
        executor: 'leaf',
        goal: 'doc',
        oracleKind: 'judge',
        output_type: 'file',
        output_path: 'doc.md',
        toolRefs: ['bash'],
        whyNoFanout: 'docs atomic',
      },
    });
    expect(pp_o02(critique(mkInput(plan))).length).toBe(0);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// 形状契约: 7 字段齐全 + remediation 非空 + suppressible=false
// ──────────────────────────────────────────────────────────────────────────────

describe('plan-critic PP-O02 — Diagnostic 形态契约', () => {
  test('PP-O02 必含 7 字段且 remediation 非空, suppressible=false', () => {
    const plan = pp_o02_shouldFire_plan();
    const diags = critique(mkInput(plan));
    const o02 = pp_o02(diags);
    expect(o02.length).toBe(1);
    const d = o02[0]!;
    expect(typeof d.code).toBe('string');
    expect(d.code.length).toBeGreaterThan(0);
    expect(d.severity).toBe('error');
    expect(typeof d.check).toBe('string');
    expect(d.check.length).toBeGreaterThan(0);
    expect(typeof d.node_id).toBe('string');
    expect(d.node_id.length).toBeGreaterThan(0);
    expect(Array.isArray(d.evidence)).toBe(true);
    expect(d.evidence.length).toBeGreaterThan(0);
    expect(typeof d.round).toBe('number');
    expect(d.round).toBeGreaterThanOrEqual(1);
    expect(typeof d.remediation).toBe('string');
    expect(d.remediation.length).toBeGreaterThan(0);
    expect(d.suppressible).toBe(false);
  });

  test('PP-O02 不可被 plan.suppressions 抑制 (suppressible:false 硬闸)', () => {
    const plan = mkPlan(
      {
        writer: {
          executor: 'leaf',
          goal: 'write file',
          output_type: 'file',
          output_path: 'x.ts',
          toolRefs: ['bash'],
          whyNoFanout: 'atomic',
        },
      },
      ['PP-O02'],
    );
    const diags = critique(mkInput(plan));
    expect(pp_o02(diags).length).toBe(1); // 抑制无效, 仍亮
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// 多写节点: 逐写节点出诊断, 不合成一条
// ──────────────────────────────────────────────────────────────────────────────

describe('plan-critic PP-O02 — 多写节点逐条诊断', () => {
  test('3 个写节点均无 oracleKind + 全图无 command → 出 3 条 PP-O02', () => {
    const plan = mkPlan({
      w1: {
        executor: 'leaf',
        goal: 'w1',
        output_type: 'file',
        output_path: 'a.ts',
        toolRefs: ['bash'],
        whyNoFanout: 'atomic',
      },
      w2: {
        executor: 'leaf',
        goal: 'w2',
        output_type: 'file',
        output_path: 'b.ts',
        toolRefs: ['bash'],
        whyNoFanout: 'atomic',
      },
      w3: {
        executor: 'leaf',
        goal: 'w3',
        output_path: 'c.ts', // 仅 output_path
        toolRefs: ['bash'],
        whyNoFanout: 'atomic',
      },
    });
    const diags = critique(mkInput(plan));
    const o02 = pp_o02(diags);
    expect(o02.length).toBe(3);
    expect(o02.map((d) => d.node_id).sort()).toEqual(['w1', 'w2', 'w3']);
  });

  test('3 写节点中 1 个声明 oracleKind=judge → 仅剩 2 条 PP-O02 (按节点逐判)', () => {
    const plan = mkPlan({
      judged: {
        executor: 'leaf',
        goal: 'judged doc',
        oracleKind: 'judge',
        output_type: 'file',
        output_path: 'doc.md',
        toolRefs: ['bash'],
        whyNoFanout: 'atomic',
      },
      w2: {
        executor: 'leaf',
        goal: 'w2',
        output_type: 'file',
        output_path: 'b.ts',
        toolRefs: ['bash'],
        whyNoFanout: 'atomic',
      },
      w3: {
        executor: 'leaf',
        goal: 'w3',
        output_path: 'c.ts',
        toolRefs: ['bash'],
        whyNoFanout: 'atomic',
      },
    });
    const diags = critique(mkInput(plan));
    const o02 = pp_o02(diags);
    expect(o02.length).toBe(2);
    expect(o02.map((d) => d.node_id).sort()).toEqual(['w2', 'w3']);
  });
});
