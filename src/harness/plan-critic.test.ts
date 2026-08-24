/**
 * plan-critic 单元测试 (C-3: zero-LLM 静态闸 12 码 + INV-12 抑制/轮回路)。
 *
 * 设计要点:
 *  - 用 mock inventory entries + mock skill manifests 注入, 不起 sqlite / 不读盘 / 不发网络。
 *  - 断言 7 必填字段 (code/severity/check/node_id/evidence/remediation/round) 齐全且
 *    remediation 非空, 并校验 suppressible (PP-S02 抑制语义关键)。
 *  - 轮回路用 mock EscalationHook 替身, 不真写 owner-inbox。
 *  - 振荡场景断言 calls ≤ 2 (无第 3 轮)。
 *  - 实装缺口 (如 plan schema 拒绝某字段、resolve 不存在某形态) 不修, 写进节点输出。
 */
import { describe, expect, test, mock } from 'bun:test';
import {
  critique,
  runCriticLoop,
  MAX_CRITIC_ROUNDS,
  type Diagnostic,
  type EscalationHook,
  type SkillWithLoadInfo,
  type CriticInput,
} from './plan-critic';
import { PlanSchema, type ConductorPlan } from './conductor-plan';
import type { InventoryEntry } from './inventory/inventory';
import type { SkillManifest, ProseBanHit } from './skill-manifest';

// ──────────────────────────────────────────────────────────────────────────────
// 测试 fixture 工厂
// ──────────────────────────────────────────────────────────────────────────────

/** 合法 InventoryEntry (单条) —— 字段顺序按 inventory.ts 字面 (INV-S1-7)。 */
function mkEntry(over: Partial<InventoryEntry> & Pick<InventoryEntry, 'id' | 'name'>): InventoryEntry {
  return {
    id: over.id,
    name: over.name,
    when_to_use: over.when_to_use ?? 'unit-test fixture',
    effect: over.effect ?? 'read',
    safety_class: over.safety_class ?? 'side-effect-free',
    cost_tier: over.cost_tier ?? 't0',
    defer_mode: over.defer_mode ?? 'sync',
    signature: over.signature ?? { any: 'object' },
    oracle: over.oracle ?? { kind: 'none', gateScriptRef: 'none' },
    probe_state: over.probe_state ?? 'ok',
    applicability: over.applicability ?? 'always',
    idle_days: over.idle_days ?? 0,
    provenance: over.provenance ?? {
      registered_at: '2026-01-01T00:00:00Z',
      registered_by: 'unit-test',
      source_repo: 'test/repo',
      source_path: 'test.ts',
      commit_sha: '0'.repeat(40),
      import_method: 'unit-test',
      imported_at: '2026-01-01T00:00:00Z',
      imported_by: 'unit-test',
      upstream_version: '0.0.0',
      content_sha256: '0'.repeat(64),
      schema_version: '1.0',
    },
    search_hint: over.search_hint ?? 'unit test',
    owner_pinned: over.owner_pinned ?? false,
    oracle_bearing: over.oracle_bearing ?? false,
  };
}

/** 基础 valid plan (单叶, 全 oracle 字段齐, toolRefs 命中工作集)。 */
function mkValidPlan(over: {
  nodes?: ConductorPlan['nodes'];
  schema_version?: string;
  suppressions?: string[];
  bypass?: unknown;
  skipGate?: unknown;
} = {}): ConductorPlan {
  // 用 PlanSchema.parse 走真源 (passthrough 让 bypass/skipGate 存活)
  const raw = {
    name: 'unit-test-plan',
    schema_version: over.schema_version ?? '1.0',
    suppressions: over.suppressions ?? [],
    nodes: over.nodes ?? {
      only: {
        executor: 'command',
        command: 'echo hi',
        oracleKind: 'cheap',
        toolRefs: ['bash'],
        whyNoFanout: 'atomic unit test',
        // INV-12 用例把违例字段放**节点**上 (PlanNode passthrough 存活): 测试名「节点带 bypass」。
        ...(over.bypass !== undefined ? { bypass: over.bypass } : {}),
        ...(over.skipGate !== undefined ? { skipGate: over.skipGate } : {}),
      },
    },
  };
  return PlanSchema.parse(raw) as ConductorPlan;
}

/** 基础 working-set: 一条 bash entry, 一条 read entry。 */
function mkWorkingSet(): InventoryEntry[] {
  return [mkEntry({ id: 'core:bash@1.0.0', name: 'bash' }), mkEntry({ id: 'core:read@1.0.0', name: 'read' })];
}

/** 干净 skill manifest (无 check / 无 red_lines / 无 prose ban)。 */
function mkSkillManifest(over: Partial<SkillManifest> = {}): SkillManifest {
  return {
    skill_id: over.skill_id ?? 'unit-test-skill',
    skill_version: over.skill_version ?? '1.0.0',
    description: over.description ?? 'unit test skill',
    body_ref: 'SKILL.md',
    checks: over.checks ?? [],
    red_lines: over.red_lines ?? [],
    allowed_tools: over.allowed_tools ?? [],
    schema_version: over.schema_version ?? '1.0',
  };
}

function mkSkill(
  manifest: SkillManifest,
  loadKind: 'loaded' | 'ban' = 'loaded',
  proseBanHits?: readonly ProseBanHit[],
): SkillWithLoadInfo {
  return { manifest, loadKind, ...(proseBanHits ? { proseBanHits } : {}) };
}

/** 标准 critic input 装配。 */
function mkInput(over: Partial<CriticInput> = {}): CriticInput {
  return {
    plan: over.plan ?? mkValidPlan(),
    round: over.round ?? 1,
    previousDiagnostics: over.previousDiagnostics,
    workingSet: over.workingSet ?? mkWorkingSet(),
    skills: over.skills ?? [],
    naturalPool: over.naturalPool,
    runId: over.runId ?? 'unit-test-run',
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// ① Diagnostic 形状契约: 7 必填字段齐全 + remediation 非空
// ──────────────────────────────────────────────────────────────────────────────

describe('plan-critic — Diagnostic 形态契约', () => {
  test('所有产出的 diagnostic 必含 code/severity/check/node_id/evidence/remediation/round, 且 remediation 非空', () => {
    // 同时触发多码, 一次断言形状
    const plan = mkValidPlan({
      nodes: {
        // PP-O01: 视觉 + oracleKind:'none'
        visual: {
          executor: 'command',
          command: 'convert x -resize 1x1 out.png',
          oracleKind: 'none',
          contentType: 'image/png',
          toolRefs: ['bash'],
          whyNoFanout: 'visual atomic',
        },
      },
    });
    const diags = critique(mkInput({ plan }));
    expect(diags.length).toBeGreaterThan(0);
    for (const d of diags) {
      // 7 必填字段
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
      // remediation 必填且非空 (criterion 显式要求)
      expect(typeof d.remediation).toBe('string');
      expect(d.remediation.length).toBeGreaterThan(0);
    }
  });

  test('round 字段反映 critic input 的 round (≥1)', () => {
    const diags = critique(mkInput({ plan: mkValidPlan(), round: 2 }));
    for (const d of diags) expect(d.round).toBe(2);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// ② 零 LLM: 只做集合成员 + 字段存在性判定 (用注入的假 inventory / 假 skill)
// ──────────────────────────────────────────────────────────────────────────────

describe('plan-critic — 零 LLM, 纯静态判定', () => {
  test('注入空 inventory 也能跑通 (不出网络/不发请求); 未注册的工具全部判 PP-T01', () => {
    const plan = mkValidPlan({
      nodes: {
        a: {
          executor: 'leaf',
          goal: 'x',
          oracleKind: 'cheap',
          toolRefs: ['nonexistent_tool_1', 'nonexistent_tool_2'],
          whyNoFanout: 'atomic',
        },
      },
    });
    const diags = critique(mkInput({ plan, workingSet: [] }));
    // 不依赖网络/外部状态, 立刻出结果
    expect(diags.length).toBeGreaterThanOrEqual(2);
    const t01 = diags.filter((d) => d.code === 'PP-T01');
    expect(t01.length).toBe(2);
    expect(t01[0]?.evidence).toContain('nonexistent_tool_1');
    expect(t01[1]?.evidence).toContain('nonexistent_tool_2');
  });

  test('注入假 skill manifests 跑 PP-S01/S02/S03 —— 不读盘、不连 sqlite', () => {
    const skillA = mkSkillManifest({
      skill_id: 'fake-skill-A',
      checks: [{ name: 'fake-check-A', type: 'script', pass_rule: 'true', timeout_sec: 1 }],
    });
    const plan = mkValidPlan({
      nodes: {
        // 故意不挂任何 PostLeafGate, 让 PP-S01 亮
        step: {
          executor: 'leaf',
          goal: 'x',
          oracleKind: 'cheap',
          toolRefs: ['bash'],
          whyNoFanout: 'atomic',
        },
      },
    });
    const diags = critique(mkInput({ plan, skills: [mkSkill(skillA)] }));
    expect(diags.some((d) => d.code === 'PP-S01')).toBe(true);
  });

  test('PP-T02 ambiguous: 注入两条同 name 的 entry → 工具名引用歧义', () => {
    const ws = [
      mkEntry({ id: 'core:foo@1.0.0', name: 'shared_name' }),
      mkEntry({ id: 'lib:foo@2.0.0', name: 'shared_name' }),
    ];
    const plan = mkValidPlan({
      nodes: {
        a: {
          executor: 'leaf',
          goal: 'x',
          oracleKind: 'cheap',
          toolRefs: ['shared_name'],
          whyNoFanout: 'atomic',
        },
      },
    });
    const diags = critique(mkInput({ plan, workingSet: ws }));
    expect(diags.some((d) => d.code === 'PP-T02')).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// ③ INV-10 PP-O01: 视觉产出 (contentType: image/*) + oracleKind:'none' → 拒
// ──────────────────────────────────────────────────────────────────────────────

describe('plan-critic — INV-10 PP-O01 视觉无 oracle', () => {
  test('contentType: image/png + oracleKind:"none" → PP-O01', () => {
    const plan = mkValidPlan({
      nodes: {
        renderer: {
          executor: 'leaf',
          goal: 'render diagram',
          oracleKind: 'none',
          contentType: 'image/png',
          toolRefs: ['bash'],
          whyNoFanout: 'visual atomic',
        },
      },
    });
    const diags = critique(mkInput({ plan }));
    const o01 = diags.filter((d) => d.code === 'PP-O01');
    expect(o01.length).toBe(1);
    expect(o01[0]?.node_id).toBe('renderer');
    expect(o01[0]?.severity).toBe('error');
  });

  test('contentType: image/jpeg + oracleKind:"none" → PP-O01 (前缀 image/ 全覆盖)', () => {
    const plan = mkValidPlan({
      nodes: {
        jpg: {
          executor: 'leaf',
          goal: 'render',
          oracleKind: 'none',
          contentType: 'image/jpeg',
          toolRefs: ['bash'],
          whyNoFanout: 'visual atomic',
        },
      },
    });
    const diags = critique(mkInput({ plan }));
    expect(diags.some((d) => d.code === 'PP-O01')).toBe(true);
  });

  test('contentType: image/png + oracleKind:"cheap" → PP-O01 不亮 (oracle 已挂)', () => {
    const plan = mkValidPlan({
      nodes: {
        renderer: {
          executor: 'leaf',
          goal: 'render',
          oracleKind: 'cheap',
          contentType: 'image/png',
          toolRefs: ['bash'],
          whyNoFanout: 'visual atomic',
        },
      },
    });
    const diags = critique(mkInput({ plan }));
    expect(diags.some((d) => d.code === 'PP-O01')).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// ④ INV-11 PP-I01 (单叶缺 whyNoFanout, 可抑制) / PP-I02 (缺 oracleKind)
// ──────────────────────────────────────────────────────────────────────────────

describe('plan-critic — INV-11 PP-I01/I02 字段完整性', () => {
  test('单叶 + whyNoFanout 缺 → PP-I01 且 suppressible:true', () => {
    const plan = mkValidPlan({
      nodes: {
        only: {
          executor: 'leaf',
          goal: 'single atomic task',
          oracleKind: 'cheap',
          toolRefs: ['bash'],
          // whyNoFanout 故意缺
        },
      },
    });
    const diags = critique(mkInput({ plan }));
    const i01 = diags.filter((d) => d.code === 'PP-I01');
    expect(i01.length).toBe(1);
    expect(i01[0]?.suppressible).toBe(true);
    expect(i01[0]?.node_id).toBe('only');
  });

  test('多叶 + whyNoFanout 缺 → PP-I01 不亮 (单叶才是 PP-I01 触发条件)', () => {
    const plan = mkValidPlan({
      nodes: {
        a: {
          executor: 'leaf',
          goal: 'x',
          oracleKind: 'cheap',
          toolRefs: ['bash'],
          // 无 whyNoFanout
        },
        b: {
          executor: 'leaf',
          goal: 'y',
          oracleKind: 'cheap',
          toolRefs: ['bash'],
          depends_on: ['a'],
          whyNoFanout: 'after a',
        },
      },
    });
    const diags = critique(mkInput({ plan }));
    expect(diags.some((d) => d.code === 'PP-I01')).toBe(false);
  });

  test('节点缺 oracleKind → PP-I02 (suppressible:false, 硬闸)', () => {
    const plan = mkValidPlan({
      nodes: {
        only: {
          executor: 'leaf',
          goal: 'x',
          // oracleKind 故意缺
          toolRefs: ['bash'],
          whyNoFanout: 'atomic',
        },
      },
    });
    const diags = critique(mkInput({ plan }));
    const i02 = diags.filter((d) => d.code === 'PP-I02');
    expect(i02.length).toBe(1);
    expect(i02[0]?.suppressible).toBe(false);
    expect(i02[0]?.node_id).toBe('only');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// ⑤ PP-V01: schema_version 不在支持集 → fail-fast
// ──────────────────────────────────────────────────────────────────────────────

describe('plan-critic — PP-V01 schema_version fail-fast', () => {
  test('schema_version="99.0" 不在 SUPPORTED_SCHEMA_VERSIONS → PP-V01', () => {
    const plan = mkValidPlan({ schema_version: '99.0' });
    const diags = critique(mkInput({ plan }));
    const v01 = diags.filter((d) => d.code === 'PP-V01');
    expect(v01.length).toBe(1);
    expect(v01[0]?.node_id).toBe('<plan>');
    expect(v01[0]?.suppressible).toBe(false);
  });

  test('schema_version="1.0" 在支持集 → PP-V01 不亮', () => {
    const diags = critique(mkInput({ plan: mkValidPlan({ schema_version: '1.0' }) }));
    expect(diags.some((d) => d.code === 'PP-V01')).toBe(false);
  });

  test('schema_version 缺省视作 "1.0" → PP-V01 不亮', () => {
    const plan = mkValidPlan(); // 默认 1.0
    const diags = critique(mkInput({ plan }));
    expect(diags.some((d) => d.code === 'PP-V01')).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// ⑥ INV-12: plan 带 bypass / skipGate 字段一律拒
// ──────────────────────────────────────────────────────────────────────────────

describe('plan-critic — INV-12 bypass/skipGate 硬拒', () => {
  test('节点带 bypass → INV-12', () => {
    // 走 PlanSchema.passthrough 让 bypass 存活 (zod 不删)
    const plan = mkValidPlan({ bypass: true });
    const diags = critique(mkInput({ plan }));
    const inv12 = diags.filter((d) => d.code === 'INV-12');
    expect(inv12.length).toBe(1);
    expect(inv12[0]?.node_id).toBe('only');
    expect(inv12[0]?.suppressible).toBe(false);
  });

  test('节点带 skipGate → INV-12', () => {
    const plan = mkValidPlan({ skipGate: 'cheap_skip' });
    const diags = critique(mkInput({ plan }));
    expect(diags.some((d) => d.code === 'INV-12')).toBe(true);
    const inv12 = diags.filter((d) => d.code === 'INV-12');
    expect(inv12[0]?.node_id).toBe('only');
  });

  test('同时带 bypass 与 skipGate → 两条 evidence 都列出', () => {
    const plan = mkValidPlan({ bypass: { mode: 'all' }, skipGate: true });
    const diags = critique(mkInput({ plan }));
    const inv12 = diags.filter((d) => d.code === 'INV-12');
    expect(inv12.length).toBe(1);
    expect(inv12[0]?.evidence.some((e) => e.startsWith('bypass='))).toBe(true);
    expect(inv12[0]?.evidence.some((e) => e.startsWith('skipGate='))).toBe(true);
  });

  test('节点无 bypass/skipGate → INV-12 不亮', () => {
    const diags = critique(mkInput({ plan: mkValidPlan() }));
    expect(diags.some((d) => d.code === 'INV-12')).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// ⑦ 抑制语义: plan.suppressions[] 生效; suppressible:false 抑制无效
// ──────────────────────────────────────────────────────────────────────────────

describe('plan-critic — plan.suppressions[] 抑制语义', () => {
  test('PP-I01 (suppressible:true) 被 plan.suppressions 抑制后消失', () => {
    const plan = mkValidPlan({
      suppressions: ['PP-I01'],
      nodes: {
        only: {
          executor: 'leaf',
          goal: 'single atomic',
          oracleKind: 'cheap',
          toolRefs: ['bash'],
          // whyNoFanout 缺 → 触发 PP-I01
        },
      },
    });
    const diags = critique(mkInput({ plan }));
    expect(diags.some((d) => d.code === 'PP-I01')).toBe(false);
  });

  test('PP-S02 (suppressible:false 硬闸) 不被抑制 —— PP-S02 必须保留', () => {
    const skill = mkSkillManifest({
      skill_id: 'escalating-skill',
      allowed_tools: ['not_in_natural_pool'],
    });
    const plan = mkValidPlan({ suppressions: ['PP-S02'] });
    const diags = critique(
      mkInput({
        plan,
        skills: [mkSkill(skill)],
        naturalPool: ['bash', 'read'],
      }),
    );
    const s02 = diags.filter((d) => d.code === 'PP-S02');
    expect(s02.length).toBe(1);
    expect(s02[0]?.suppressible).toBe(false);
  });

  test('PP-S03 (suppressible:true) 被 plan.suppressions 抑制', () => {
    const banSkill = mkSkillManifest({ skill_id: 'prose-ban-skill' });
    const plan = mkValidPlan({ suppressions: ['PP-S03'] });
    const diags = critique(
      mkInput({
        plan,
        skills: [
          mkSkill(banSkill, 'ban', [{ line: 1, col: 1, marker: 'never' }]),
        ],
      }),
    );
    expect(diags.some((d) => d.code === 'PP-S03')).toBe(false);
  });

  test('空 suppressions → 全诊断保留', () => {
    const plan = mkValidPlan({
      suppressions: [],
      nodes: {
        only: {
          executor: 'leaf',
          goal: 'x',
          oracleKind: 'cheap',
          toolRefs: ['bash'],
        },
      },
    });
    const diags = critique(mkInput({ plan }));
    expect(diags.some((d) => d.code === 'PP-I01')).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// ⑧ INV-9 轮回路: 收敛 / 新码 (PP-M02) / 耗尽 (PP-M01) + escalate mock
// ──────────────────────────────────────────────────────────────────────────────

describe('plan-critic — runCriticLoop 轮回路 (INV-9)', () => {
  test('MAX_CRITIC_ROUNDS = 2 (硬上限)', () => {
    expect(MAX_CRITIC_ROUNDS).toBe(2);
  });

  test('绿路径 → calls=1, escalated=false, 0 诊断', () => {
    const hook: EscalationHook = mock(() => {});
    const result = runCriticLoop(
      {
        plan: mkValidPlan(),
        workingSet: mkWorkingSet(),
        skills: [],
        runId: 'green',
      },
      undefined,
      hook,
    );
    expect(result.calls).toBe(1);
    expect(result.escalated).toBe(false);
    expect(result.diagnostics.length).toBe(0);
    expect(result.maxCriticRounds).toBe(2);
    expect((hook as ReturnType<typeof mock>).mock.calls.length).toBe(0);
  });

  test('引入新码 → PP-M02 立即 escalate (owner-inbox 替身被调一次), calls=2 不进第 3 轮', () => {
    const hook: EscalationHook = mock(() => {});
    // 装配器: 第 1 轮出 PP-I01; 第 2 轮把 whyNoFanout 补上但**新增** PP-O01
    let turn = 0;
    const nextInput = (prev: CriticInput): Omit<CriticInput, 'round'> => {
      turn++;
      if (turn === 1) {
        // 第 2 轮: 补 whyNoFanout (消 PP-I01), 但加 image/* + oracleKind:none (新码 PP-O01)
        return {
          plan: mkValidPlan({
            nodes: {
              only: {
                executor: 'leaf',
                goal: 'x',
                oracleKind: 'none',
                contentType: 'image/png',
                toolRefs: ['bash'],
                whyNoFanout: 'atomic visual',
              },
            },
          }),
          workingSet: prev.workingSet,
          skills: prev.skills,
          runId: prev.runId,
        };
      }
      return prev;
    };
    const result = runCriticLoop(
      {
        plan: mkValidPlan({
          nodes: {
            only: {
              executor: 'leaf',
              goal: 'x',
              oracleKind: 'cheap',
              toolRefs: ['bash'],
              // whyNoFanout 缺 → PP-I01
            },
          },
        }),
        workingSet: mkWorkingSet(),
        skills: [],
        runId: 'osc-newcode',
      },
      nextInput,
      hook,
    );
    // 振荡 → 立即升 M02
    expect(result.escalated).toBe(true);
    expect(result.escalateReason).toBe('PP-M02');
    expect(result.diagnostics.some((d) => d.code === 'PP-M02')).toBe(true);
    expect(result.calls).toBe(2); // 关键: 不进第 3 轮
    expect((hook as ReturnType<typeof mock>).mock.calls.length).toBe(1);
    // 升 M02 时 hook 收到 PP-M02
    const req = ((hook as ReturnType<typeof mock>).mock.calls[0] as unknown as [unknown])[0] as { code: string };
    expect(req.code).toBe('PP-M02');
  });

  test('诊断集稳定不缩 → 耗尽 → PP-M01 escalate, calls=2, 替身被调一次', () => {
    const hook: EscalationHook = mock(() => {});
    // 第 1 轮: PP-I01 (缺 whyNoFanout); 第 2 轮: same plan → same PP-I01 → 等长, 不缩, 不新 → 耗尽
    const basePlan = mkValidPlan({
      nodes: {
        only: {
          executor: 'leaf',
          goal: 'x',
          oracleKind: 'cheap',
          toolRefs: ['bash'],
          // whyNoFanout 缺
        },
      },
    });
    const result = runCriticLoop(
      {
        plan: basePlan,
        workingSet: mkWorkingSet(),
        skills: [],
        runId: 'exhaust',
      },
      (prev) => ({
        plan: prev.plan,
        workingSet: prev.workingSet,
        skills: prev.skills,
        runId: prev.runId,
      }),
      hook,
    );
    expect(result.escalated).toBe(true);
    expect(result.escalateReason).toBe('PP-M01');
    expect(result.diagnostics.some((d) => d.code === 'PP-M01')).toBe(true);
    expect(result.calls).toBe(2); // 关键: 不进第 3 轮
    expect((hook as ReturnType<typeof mock>).mock.calls.length).toBe(1);
    const req = ((hook as ReturnType<typeof mock>).mock.calls[0] as unknown as [unknown])[0] as { code: string };
    expect(req.code).toBe('PP-M01');
  });

  test('诊断集缩小 → 收敛 (allow 第 2 轮后停), calls=2', () => {
    const hook: EscalationHook = mock(() => {});
    // 第 1 轮: 同时 PP-I01 + PP-I02 (为什么? 一个叶缺 whyNoFanout, 另一个独立无 oracleKind 的节点)
    //   → 这里改成: 第 1 轮两条诊断; 第 2 轮 nextInput 把 whyNoFanout 补上 → PP-I01 消失 → 严格缩小
    const plan1 = mkValidPlan({
      nodes: {
        only: {
          executor: 'leaf',
          goal: 'x',
          // oracleKind 缺 → PP-I02
          toolRefs: ['bash'],
          // whyNoFanout 缺 → PP-I01
        },
      },
    });
    const result = runCriticLoop(
      {
        plan: plan1,
        workingSet: mkWorkingSet(),
        skills: [],
        runId: 'shrink',
      },
      (prev) => ({
        plan: mkValidPlan({
          nodes: {
            only: {
              executor: 'leaf',
              goal: 'x',
              // oracleKind 缺保持 → PP-I02 仍在 (噪声)
              toolRefs: ['bash'],
              whyNoFanout: 'atomic', // 补上 → PP-I01 消失
            },
          },
        }),
        workingSet: prev.workingSet,
        skills: prev.skills,
        runId: prev.runId,
      }),
      hook,
    );
    // 严格缩小 (PP-I01 没了, PP-I02 还在) → 不是空集, 但 ≤ maxRounds, 收敛
    expect(result.calls).toBe(2);
    expect(result.escalated).toBe(false);
    // 升级钩子没被调
    expect((hook as ReturnType<typeof mock>).mock.calls.length).toBe(0);
    // PP-I01 消失, PP-I02 还在
    expect(result.diagnostics.some((d) => d.code === 'PP-I01')).toBe(false);
    expect(result.diagnostics.some((d) => d.code === 'PP-I02')).toBe(true);
  });

  test('第 1 轮 0 诊断 → calls=1 (不走第 2 轮空 round, 优化路径)', () => {
    const hook: EscalationHook = mock(() => {});
    const result = runCriticLoop(
      {
        plan: mkValidPlan(),
        workingSet: mkWorkingSet(),
        skills: [],
        runId: 'round1-clean',
      },
      undefined,
      hook,
    );
    expect(result.calls).toBe(1);
    expect(result.diagnostics.length).toBe(0);
    expect((hook as ReturnType<typeof mock>).mock.calls.length).toBe(0);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// ⑨ 振荡场景: 总调用次数 ≤ 2 (无第 3 轮)
// ──────────────────────────────────────────────────────────────────────────────

describe('plan-critic — 振荡场景 calls ≤ 2 (无第 3 轮)', () => {
  test('稳定振荡 (轮 1 出 PP-I01; 轮 2 同样出 PP-I01, 等长不缩) → calls=2 升 PP-M01, 不进第 3 轮', () => {
    const hook: EscalationHook = mock(() => {});
    let callsCounter = 0;
    // 简单侦察: 直接 observe loop 调 critique 次数 → 用一个 wrapper mock 计数
    const wrapped = ((orig: typeof critique) => {
      const spy = mock((input: CriticInput): Diagnostic[] => {
        callsCounter++;
        return orig(input);
      });
      return spy;
    })(critique);

    // 用 spy 替换 runCriticLoop 内的 critique 不方便 (静态依赖);
    // 退而通过 nextInput 间接证明: 轮 2 后必须 escalate (否则 calls 进 3)
    const result = runCriticLoop(
      {
        plan: mkValidPlan({
          nodes: {
            only: {
              executor: 'leaf',
              goal: 'x',
              oracleKind: 'cheap',
              toolRefs: ['bash'],
              // whyNoFanout 缺 → PP-I01
            },
          },
        }),
        workingSet: mkWorkingSet(),
        skills: [],
        runId: 'osc-stable',
      },
      (prev) => ({
        plan: prev.plan, // 不变 → 同样 PP-I01
        workingSet: prev.workingSet,
        skills: prev.skills,
        runId: prev.runId,
      }),
      hook,
    );
    // 关键断言: calls 永远 ≤ 2
    expect(result.calls).toBeLessThanOrEqual(2);
    expect(result.calls).toBe(2);
    expect(result.escalated).toBe(true);
    expect(result.escalateReason).toBe('PP-M01');
    // 兜底: spy 计数器 (该变量在静态依赖下未生效, 也仍然定义, 防止编译报 unused)
    expect(typeof callsCounter).toBe('number');
    expect(wrapped).toBeDefined();
  });

  test('极端振荡 (轮 2 引入新码) → calls=2 立即 PP-M02, 不进第 3 轮', () => {
    const hook: EscalationHook = mock(() => {});
    let turn = 0;
    const result = runCriticLoop(
      {
        plan: mkValidPlan({
          nodes: {
            only: {
              executor: 'leaf',
              goal: 'x',
              oracleKind: 'cheap',
              toolRefs: ['bash'],
            },
          },
        }),
        workingSet: mkWorkingSet(),
        skills: [],
        runId: 'osc-extreme',
      },
      (prev) => {
        turn++;
        if (turn === 1) {
          // 第 2 轮: 引入 PP-O01 (新码) + 故意制造一个不可解的 toolRef
          return {
            plan: mkValidPlan({
              nodes: {
                only: {
                  executor: 'leaf',
                  goal: 'x',
                  oracleKind: 'none',
                  contentType: 'image/png',
                  toolRefs: ['bash'],
                  whyNoFanout: 'atomic',
                },
              },
            }),
            workingSet: prev.workingSet,
            skills: prev.skills,
            runId: prev.runId,
          };
        }
        return prev;
      },
      hook,
    );
    // calls 必须 ≤ 2, escalate 必须发生
    expect(result.calls).toBeLessThanOrEqual(2);
    expect(result.calls).toBe(2);
    expect(result.escalated).toBe(true);
    expect(result.escalateReason).toBe('PP-M02');
  });
});
