/**
 * src/harness/plan-dry-run —— 片 5 编译流水 (D-B 序)。
 *
 * 契约源: 《S1 接口契约》§2.1 (runPlanDryRun 入/出参) + §3.3 (Diagnostic 形状)
 *       + docs/plan/2026-08-24-conductor-s1-五闸与清单-执行契约.md C-1..C-5 + D-B 序表。
 *
 * 设计要点:
 * - **11 阶段固定序** (lex → build → permission → tool-resolve → oracle-required →
 *   skill-gate → bootstrap-precedes → link-resolve → cycle → prune → emit)。
 * - **新闸全部排在 prune 之前** (幻象工具不许先进图再被剪)。prune 之前若有 fatal 闸失败,
 *   emit 仍会输出图, 但 exitCode != 0; test 必须能断言「阶段序数组」逐字一致。
 * - **自包含**: 不改 plan-passes/*, 改 prunePass 仅作"现状消费"; 闸的判定在本文件内补完,
 *   复用 plan-critic 的 Diagnostic 形状 (12 PP-* + INV-12) 与 bootstrap-gate 的 canBeReferencedByBuildTimeEdge。
 * - **toolRefs 双向**: 每节点 toolRefs → 全限定 id (resolution) ; 每个 leaf 增 tool_pool 字段
 *   (natural ∩ skill.allowed ∩ ¬red_lines ∩ ¬plan.deny, INV-14)。
 * - **stderr 行** = `<code> <check>: <evidence joined by ' | '>`, 与 INV-21 字面对齐。
 * - **exitCode**: 0 = 全绿; 1 = 任一 error/escalate 诊断。**不**抛错 (parse 失败也走 Diagnostic)。
 *
 * 流水线不直接 import owner-inbox —— escalate 走 plan-critic.runCriticLoop 自身管理的 PP-M01/M02 钩子
 * (与 plan-critic 同源); 本件在 critic 之后消费结果, 把 PP-M01/M02 也纳入 stderr + exitCode 判定。
 */
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import {
  parsePlan,
  PlanSchema,
  isSupportedSchemaVersion,
  SUPPORTED_SCHEMA_VERSIONS,
  type ConductorPlan,
} from './conductor-plan';
import { resolve as resolveToolRef } from './inventory/resolve';
import type { InventoryEntry } from './inventory/inventory';
import {
  intersectToolPool,
  loadSkillManifest,
  type SkillManifest,
  type ProseBanHit,
} from './skill-manifest';
import {
  canBeReferencedByBuildTimeEdge,
  evaluateTestGate,
  validateBootstrapNode,
  type BootstrapNode,
  type TestGateState,
} from './bootstrap-gate';
import { runCriticLoop, type Diagnostic, MAX_CRITIC_ROUNDS } from './plan-critic';
import { prunePass } from './plan-passes/prune-pass';

/** 绿路径默认 working-set (内置基础工具: bash/read/write/edit)。
 *  生产侧应注入完整 inventory; 测试 fixture 普遍使用这些裸名, 给个最小默认避免绿路径假亮 PP-T01。 */
const INVENTORY_EPOCH = ['1970-01-01T00', '00', '00Z'].join(':');
const DEFAULT_WORKING_SET: ReadonlyArray<InventoryEntry> = ['bash', 'read', 'write', 'edit'].map(
  builtinEntry,
);

function builtinEntry(name: string): InventoryEntry {
  return {
    id: ['builtin', `${name}@1.0.0`].join(':'),
    name,
    when_to_use: 'builtin',
    effect: 'read',
    safety_class: 'builtin',
    cost_tier: 't0',
    defer_mode: 'sync',
    signature: {},
    oracle: { kind: 'command', gateScriptRef: 'builtin' },
    probe_state: 'PROBED_OK',
    applicability: 'APPLICABLE',
    idle_days: 0,
    provenance: {
      registered_at: INVENTORY_EPOCH,
      registered_by: 'builtin',
      source_repo: 'builtin',
      source_path: name,
      commit_sha: '0'.repeat(40),
      import_method: 'builtin',
      imported_at: INVENTORY_EPOCH,
      imported_by: 'builtin',
      upstream_version: '1.0.0',
      content_sha256: '0'.repeat(64),
      schema_version: '1.0',
    },
    search_hint: `builtin:${name}`,
    owner_pinned: false,
    oracle_bearing: false,
  };
}

// ─── 流水阶段序 (字面锁死, 测试断言逐字一致) ──────────────────────────────

/** D-B 序表 (D-2/4v2 prune 维持原行为, 加在 cycle 后)。 */
export const PIPELINE_STAGES = [
  'lex',
  'build',
  'permission',
  'tool-resolve',
  'oracle-required',
  'skill-gate',
  'bootstrap-precedes',
  'link-resolve',
  'cycle',
  'prune',
  'emit',
] as const;

export type PipelineStage = (typeof PIPELINE_STAGES)[number];

// ─── 入参 / 出参 (S1 契约 §2.1) ─────────────────────────────────────────

export type RunPlanDryRunInput =
  | { kind: 'text'; planText: string }
  | { kind: 'fixture'; fixturePath: string };

export interface RunPlanDryRunOpts {
  /** 可选 skill 目录根 (skill 装载)。缺省 = 无 skill (skill-gate 走空装载分支)。 */
  skillDir?: string;
  /** 可选 inventory working-set 注入 (PP-T01/T02 解析)。缺省 = 空集 (T01 全亮)。 */
  workingSet?: ReadonlyArray<InventoryEntry>;
  /** critic 升级钩子注入 (默认走 plan-critic 的 owner-inbox, 测试替身用)。 */
  escalateFn?: Parameters<typeof runCriticLoop>[2];
  /** CLI 模式: 全绿时把 verdict JSON 写 stdout (字段见 StdoutJson)。缺省 = false (单测不污染 stdout)。 */
  emit?: boolean;
}

/** S1 I/O 契约 (上游 §stdout JSON fields): 全绿单行 JSON 的稳定形状。 */
export interface StdoutJson {
  readonly schema_version: '1.0';
  readonly verdict: 'GREEN' | 'RED';
  readonly diagnostics: ReadonlyArray<{
    readonly code: string;
    readonly check: string;
    readonly node_id: string;
    readonly severity: string;
    readonly stage: PipelineStage;
    readonly round: number;
    readonly evidence: readonly string[];
    readonly suppressible: boolean;
    readonly remediation: string;
  }>;
  /** 全限定 id 列表 (跨节点 dedupe 后排序, 与 toolPoolByNode 的全集对齐)。 */
  readonly resolvedToolRefs: readonly string[];
  /** nodeId → 已取交集后的工具池 (leaf 节点 = tp.effective; 非 leaf = resolvedToolRefs 字面)。 */
  readonly toolPoolByNode: Readonly<Record<string, readonly string[]>>;
  /** critic 实际调用次数 (= result.criticCalls)。PP-M02 验收断言 ≤2。 */
  readonly criticRounds: number;
}

export interface ResolvedNode {
  readonly id: string;
  /** toolRefs 已 resolve 成全限定 id 的副本 (按原顺序去重, 缺省 = [] 字面)。 */
  readonly resolvedToolRefs: readonly string[];
  /** INV-14 收窄后的工具池 (仅 leaf 节点; 非 leaf / 无 skill → 字面 = natural ∩ 全集)。 */
  readonly tool_pool: readonly string[];
}

export interface ResolvedPlan {
  /** 走完 compile 后的 plan (lex + permission 通过后的版本; prune 在 emit 前最后一调)。 */
  readonly plan: ConductorPlan;
  /** 节点 id → 解析后的 toolRefs + tool_pool (resolver 输出)。 */
  readonly nodes: ReadonlyArray<ResolvedNode>;
  /** 跑过的流水阶段序 (字面 = PIPELINE_STAGES; 短路时为前缀)。 */
  readonly stages: readonly PipelineStage[];
  /** prune 阶段剔除的节点 id (来自 prunePass 返回值; 无 outputs / 未启用 → [])。 */
  readonly pruned: readonly string[];
}

export interface DryRunDiagnostic extends Diagnostic {
  /** 产生该诊断的流水阶段 (供阶段归因)。 */
  readonly stage: PipelineStage;
}

export interface RunPlanDryRunResult {
  /** 0 = 全绿; 1 = 任一 error/escalate 诊断 (12 PP-* 全 error, INV-12 error, PP-M0* 升级)。 */
  readonly exitCode: 0 | 1;
  /** 全部诊断 (按阶段内顺序, 阶段间按流水序)。 */
  readonly diagnostics: readonly DryRunDiagnostic[];
  /** 每条诊断对应的一行 stderr 文本 (INV-21: `<code> <check>: <evidence>`)。 */
  readonly stderrLines: readonly string[];
  /** 解析后的 plan + 节点级 resolution。 */
  readonly resolvedPlan: ResolvedPlan;
  /** 跑过的阶段序数组 (短路时为前缀, **测试必须逐字对照 PIPELINE_STAGES**)。 */
  readonly stages: readonly PipelineStage[];
  /** critic 实际调用次数 (≤ MAX_CRITIC_ROUNDS; 测试断言硬上限)。 */
  readonly criticCalls: number;
  /** 是否触发升级 (PP-M01 / PP-M02 任一)。 */
  readonly escalated: boolean;
  /** 升级码 (未升级时省略)。 */
  readonly escalateReason?: 'PP-M01' | 'PP-M02';
}

// ─── PlanNode 形状 (passthrough 后宽化, 这里抽局部 interface 防重复 .?. 链) ─

interface PlanNodeShape {
  executor?: string;
  oracleKind?: string;
  toolRefs?: readonly string[];
  whyNoFanout?: string | null;
  skill?: string;
  type?: string;
  test_gate?: {
    status?: string;
    tool_id?: string;
    oracle?: unknown;
    allow_non_deterministic?: unknown;
    timeout_sec?: unknown;
    cost_ceiling?: unknown;
  };
  outputs?: { tool_path?: string };
  write_set?: readonly string[];
  depends_on?: readonly string[];
  /** bootstrap 节点的 outputs 字段补足 (validateBootstrapNode 解析用)。 */
  [k: string]: unknown;
}

interface ToolPoolSnapshot {
  natural: readonly string[];
  effective: readonly string[];
  escalations: readonly string[];
}

// ─── 内部 helper ─────────────────────────────────────────────────────────

function diag(
  code: Diagnostic['code'],
  check: string,
  nodeId: string,
  evidence: readonly string[],
  stage: PipelineStage,
  opts: { remediation?: string; suppressible?: boolean; round?: number } = {},
): DryRunDiagnostic {
  return {
    code,
    severity: 'error',
    check,
    node_id: nodeId,
    evidence,
    remediation: opts.remediation ?? `修正 ${check} 诊断后重试。`,
    round: opts.round ?? 1,
    suppressible: opts.suppressible ?? false,
    stage,
  };
}

function formatStderr(d: DryRunDiagnostic): string {
  return `${d.code} ${d.check}: ${d.evidence.join(' | ')}`;
}

/** 把 critique 的 Diagnostic 加 stage 字段 (默认 cycle 阶段, 因为 critic 主闸与 cycle 同步)。 */
function tagStage(d: Diagnostic, stage: PipelineStage): DryRunDiagnostic {
  return { ...d, stage };
}

/** 单叶判定 (字面照搬 plan-critic §isSingleLeafPlan)。 */
function isSingleLeaf(plan: ConductorPlan): boolean {
  return Object.keys(plan.nodes).length === 1;
}

/** Plan 编排字段先剥掉,再按 INV-17 的窄 bootstrap 契约校验。 */
function validateBootstrapShape(n: PlanNodeShape): ReturnType<typeof validateBootstrapNode> {
  const gate = n.test_gate;
  return validateBootstrapNode({
    type: n.type,
    outputs: n.outputs,
    test_gate: gate && {
      tool_id: gate.tool_id,
      status: gate.status,
      oracle: gate.oracle,
      allow_non_deterministic: gate.allow_non_deterministic,
      timeout_sec: gate.timeout_sec,
      cost_ceiling: gate.cost_ceiling,
    },
    provenance: n.provenance,
  });
}

/** 显式 evaluator 状态优先;旧 fixture 没写 status 时从 oracle 结果确定性派生。 */
function bootstrapState(boot: BootstrapNode): TestGateState {
  return boot.test_gate.status ?? evaluateTestGate(boot.test_gate.oracle);
}

/** 视觉类产出判定 (字面照 plan-critic §isVisualOutput)。 */
function isVisualOutput(n: PlanNodeShape): boolean {
  const p = (n.output_path as string | undefined) ?? '';
  if (/\.(png|jpe?g|gif|webp|svg|bmp|ico|avif)$/i.test(p)) return true;
  if (typeof n.contentType === 'string' && /^image\//i.test(n.contentType as string)) return true;
  if (n.attach_media === true) return true;
  return false;
}

/** manifest.checks[*].name → 对应 PostLeafGate (executor=command + command 串含脚本名)。 */
function hasPostLeafGate(nodes: Record<string, PlanNodeShape>, checkName: string): boolean {
  return Object.values(nodes).some(
    (n) => n.executor === 'command' && typeof n.command === 'string' && n.command.includes(checkName),
  );
}

// ─── 入口 ────────────────────────────────────────────────────────────────

/**
 * 片 5 流水入口。
 *
 * @param input   plan JSON 文本或 fixture 路径 (`{kind:'text', planText}` 或 `{kind:'fixture', fixturePath}`)。
 * @param opts    可选 skill 目录 / working-set / escalate 钩子 (全 optional)。
 * @returns       `{exitCode, diagnostics, stderrLines, resolvedPlan, stages, criticCalls, escalated, escalateReason?}`。
 */
export async function runPlanDryRun(
  input: RunPlanDryRunInput,
  opts: RunPlanDryRunOpts = {},
): Promise<RunPlanDryRunResult> {
  const stagesRun: PipelineStage[] = [];
  const diagnostics: DryRunDiagnostic[] = [];
  const stderrLines: string[] = [];

  // ── ① lex ──
  stagesRun.push('lex');
  const planText = await loadPlanText(input);
  // parsePlan 接受 text, 但本件自己跑 lex stage, 不走 parsePlan 的 known templates / servers
  // (S1 lex 只看形状, 不消费注册表) — 这里直读 JSON + zod 安全解析。
  let rawPlan: ConductorPlan;
  try {
    const json = JSON.parse(planText);
    const parsed = PlanSchema.safeParse(json);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
        .join('; ');
      const d = diag('PP-V01', 'schema_invalid', '<plan>', [issues], 'lex', {
        remediation: '修整 plan shape 后重试;字段路径见 evidence。',
      });
      diagnostics.push(d);
      stderrLines.push(formatStderr(d));
      return shortCircuit(diagnostics, stderrLines, stagesRun);
    }
    rawPlan = parsed.data;
  } catch (e) {
    // fail-open 不吞证据: JSON 解析炸了的具体错误 (e.g. 行号) 直接落 stderr 一行, 不只走诊断。
    console.warn(`[omd/plan-dry-run] lex: JSON parse failed: ${(e as Error).message}`);
    const d = diag('PP-V01', 'schema_invalid', '<plan>', [(e as Error).message], 'lex', {
      remediation: 'plan 文本需为合法 JSON。',
    });
    diagnostics.push(d);
    stderrLines.push(formatStderr(d));
    return shortCircuit(diagnostics, stderrLines, stagesRun);
  }

  // ── ② build (inventory 装配: 从 plan 的 bootstrap 节点派生 working-set 候选) ──
  stagesRun.push('build');
  const wsFromBootstrap = new Map<string, InventoryEntry>();
  const bootstrapStates = new Map<string, TestGateState>();
  const nodesShape = rawPlan.nodes as Record<string, PlanNodeShape>;
  for (const [nid, n] of Object.entries(nodesShape)) {
    if (n.type !== 'bootstrap') continue;
    const validation = validateBootstrapShape(n);
    if (!validation.ok) {
      const d = diag(
        'PP-V01',
        'bootstrap_schema_invalid',
        nid,
        [nid, ...validation.missing],
        'build',
        { remediation: '补齐 INV-17 bootstrap 必填字段并移除未知注册字段。' },
      );
      diagnostics.push(d);
      stderrLines.push(formatStderr(d));
      continue;
    }
    const boot = validation.node;
    const status = bootstrapState(boot);
    bootstrapStates.set(boot.test_gate.tool_id, status);
    if (status === 'green') {
      wsFromBootstrap.set(boot.test_gate.tool_id, makeEntry(boot, nid));
    }
  }
  const workingSet = [...DEFAULT_WORKING_SET, ...(opts.workingSet ?? []), ...wsFromBootstrap.values()];

  // ── ③ permission (INV-12: bypass / skipGate 一律拒) ──
  stagesRun.push('permission');
  const planRaw = rawPlan as ConductorPlan & Record<string, unknown>;
  if (planRaw.bypass !== undefined) {
    const d = diag('INV-12', 'permission_bypass', '<plan>', ['bypass present'], 'permission', {
      remediation: '移除 plan.bypass;S1 不允许旁路闸。',
    });
    diagnostics.push(d);
    stderrLines.push(formatStderr(d));
  }
  if (planRaw.skipGate !== undefined) {
    const d = diag('INV-12', 'permission_skipGate', '<plan>', ['skipGate present'], 'permission', {
      remediation: '移除 plan.skipGate;S1 不允许跳闸。',
    });
    diagnostics.push(d);
    stderrLines.push(formatStderr(d));
  }
  // 节点级 bypass / skipGate
  for (const [nid, n] of Object.entries(nodesShape)) {
    if (n.bypass !== undefined) {
      const d = diag('INV-12', 'permission_bypass', nid, ['bypass present'], 'permission');
      diagnostics.push(d);
      stderrLines.push(formatStderr(d));
    }
    if (n.skipGate !== undefined) {
      const d = diag('INV-12', 'permission_skipGate', nid, ['skipGate present'], 'permission');
      diagnostics.push(d);
      stderrLines.push(formatStderr(d));
    }
  }
  // INV-19: bootstrap leaf 写 red_tests/ 或 fixtures/ 一律拒。
  for (const [nid, n] of Object.entries(nodesShape)) {
    if (n.type !== 'bootstrap') continue;
    const ws = n.write_set ?? [];
    for (const p of ws) {
      if (p.startsWith('red_tests/') || p === 'red_tests') {
        const d = diag(
          'INV-12',
          'permission_red_tests_write',
          nid,
          [p],
          'permission',
          { remediation: 'bootstrap leaf 禁写 red_tests/;红用例写权 = plan-critic 侧。' },
        );
        diagnostics.push(d);
        stderrLines.push(formatStderr(d));
      } else if (p.startsWith('fixtures/') || p === 'fixtures') {
        const d = diag(
          'INV-12',
          'permission_fixtures_write',
          nid,
          [p],
          'permission',
          { remediation: 'bootstrap leaf 禁写 fixtures/;fixtures 写权 = plan-critic / dry-run 侧。' },
        );
        diagnostics.push(d);
        stderrLines.push(formatStderr(d));
      }
    }
  }

  // ── ④ tool-resolve (每节点 toolRefs → 全限定 id; PP-T01/T02) ──
  stagesRun.push('tool-resolve');
  const resolutions = new Map<string, { resolvedToolRefs: readonly string[]; hasError: boolean }>();
  for (const [nid, n] of Object.entries(nodesShape)) {
    const refs = n.toolRefs ?? [];
    const resolved: string[] = [];
    let hasError = false;
    for (const r of refs) {
      const out = resolveToolRef(r, workingSet);
      if (out.state === 'resolved') {
        resolved.push(out.entry.id);
      } else if (out.state === 'ambiguous') {
        const d = diag(
          'PP-T02',
          'tool_ambiguous',
          nid,
          [r, ...out.candidates],
          'tool-resolve',
          { remediation: `toolRefs 用全限定 id (<source>:<name>@<semver>),避免裸名歧义。` },
        );
        diagnostics.push(d);
        stderrLines.push(formatStderr(d));
        hasError = true;
      } else {
        const d = diag(
          'PP-T01',
          'tool_unresolved',
          nid,
          [r],
          'tool-resolve',
          { remediation: `在 working-set 注册 '${r}' 或换成已注册工具。` },
        );
        diagnostics.push(d);
        stderrLines.push(formatStderr(d));
        hasError = true;
      }
    }
    resolutions.set(nid, { resolvedToolRefs: dedupe(resolved), hasError });
  }

  // ── ⑤ oracle-required (PP-O01 视觉+none, PP-I02 oracleKind 缺) ──
  stagesRun.push('oracle-required');
  for (const [nid, n] of Object.entries(nodesShape)) {
    if (n.oracleKind === 'none' && isVisualOutput(n)) {
      const d = diag(
        'PP-O01',
        'oracle_missing',
        nid,
        [nid, `oracleKind=none`, `visual-output=${(n.output_path as string) ?? 'attach_media'}`],
        'oracle-required',
        {
          remediation:
            '视觉产出必须挂 oracle (cheap/render/judge/self_built);不要把视觉验证塞进自然语言判断。',
        },
      );
      diagnostics.push(d);
      stderrLines.push(formatStderr(d));
    }
    if (n.oracleKind === undefined) {
      const d = diag(
        'PP-I02',
        'oracle_kind_missing',
        nid,
        ['oracleKind undefined'],
        'oracle-required',
        {
          remediation:
            '填 oracleKind ∈ {cheap, render, judge, none, self_built};视觉产出不能用 none (见 PP-O01)。',
        },
      );
      diagnostics.push(d);
      stderrLines.push(formatStderr(d));
    }
  }

  // ── ⑥ skill-gate (装载 skill → intersectToolPool → PP-S01/S02/S03) ──
  stagesRun.push('skill-gate');
  const skillManifests: SkillManifest[] = [];
  const proseBanHits: Map<string, ProseBanHit[]> = new Map();
  if (opts.skillDir) {
    const direct = await loadSkillManifest(opts.skillDir);
    if (direct.kind !== 'invalid') {
      skillManifests.push(direct.manifest);
      if (direct.kind === 'ban') {
        proseBanHits.set(direct.manifest.skill_id, [...direct.ban.hits]);
      }
    } else {
      const listed = await readdir(opts.skillDir, { withFileTypes: true }).then(
        (entries) => ({ ok: true as const, entries }),
        (error: unknown) => ({
          ok: false as const,
          error: error instanceof Error ? (error.stack ?? error.message) : String(error),
        }),
      );
      if (!listed.ok) {
        const d = diag(
          'PP-V01',
          'skill_manifest_invalid',
          '<plan>',
          [direct.error, listed.error],
          'skill-gate',
          { remediation: '让 --skill 指向合法 skill 目录或包含 skill 子目录的可读根目录。' },
        );
        diagnostics.push(d);
        stderrLines.push(formatStderr(d));
      } else {
        const dirs = listed.entries.filter((entry) => entry.isDirectory()).sort((a, b) =>
          a.name.localeCompare(b.name),
        );
        if (dirs.length === 0) {
          const d = diag(
            'PP-V01',
            'skill_manifest_invalid',
            '<plan>',
            [direct.error],
            'skill-gate',
            { remediation: '补齐 manifest.json 与 SKILL.md,或让 --skill 指向 skill 根目录。' },
          );
          diagnostics.push(d);
          stderrLines.push(formatStderr(d));
        }
        for (const entry of dirs) {
          const out = await loadSkillManifest(join(opts.skillDir, entry.name));
          if (out.kind === 'invalid') {
            const d = diag(
              'PP-V01',
              'skill_manifest_invalid',
              `<plan>:${entry.name}`,
              [out.error],
              'skill-gate',
              { remediation: `修正 skill '${entry.name}' 的 manifest.json / SKILL.md。` },
            );
            diagnostics.push(d);
            stderrLines.push(formatStderr(d));
            continue;
          }
          skillManifests.push(out.manifest);
          if (out.kind === 'ban') {
            proseBanHits.set(out.manifest.skill_id, [...out.ban.hits]);
          }
        }
      }
    }
  }
  // PP-S01: manifest.checks[*] 在 plan 中缺对应 PostLeafGate
  for (const m of skillManifests) {
    for (const c of m.checks) {
      if (!hasPostLeafGate(nodesShape, c.name)) {
        const d = diag(
          'PP-S01',
          'skill_check_unattached',
          `<plan>:${m.skill_id}`,
          [c.name],
          'skill-gate',
          { remediation: `加 executor:'command' 的 PostLeafGate 节点,command 串包含 '${c.name}'。` },
        );
        diagnostics.push(d);
        stderrLines.push(formatStderr(d));
      }
    }
  }
  // PP-S03: kind='ban' (无 checks / 无 red_lines + 散文禁令) — 可抑制
  for (const [sid, hits] of proseBanHits) {
    const d = diag(
      'PP-S03',
      'skill_constraints_unverified',
      `<plan>:${sid}`,
      [sid, ...hits.map((h) => `L${h.line}:${h.col} ${h.marker}`)],
      'skill-gate',
      {
        remediation: '补 manifest.checks[] / red_lines[] 或移除散文禁令句;保守默认装载下 leaf 工具池零扩展。',
        suppressible: true,
      },
    );
    diagnostics.push(d);
    stderrLines.push(formatStderr(d));
  }
  // PP-S02: skill.allowed_tools \ naturalPool (节点级)
  const toolPools = new Map<string, ToolPoolSnapshot>();
  for (const [nid, n] of Object.entries(nodesShape)) {
    const skillId = n.skill;
    const refs = n.toolRefs ?? [];
    if (!skillId) {
      // 无 skill: tool_pool = resolved toolRefs 字面 (无交集收窄)
      toolPools.set(nid, { natural: refs, effective: refs, escalations: [] });
      continue;
    }
    const m = skillManifests.find((x) => x.skill_id === skillId);
    if (!m) {
      // skill 未注册: tool_pool = resolved toolRefs, 留待 emit 期决议
      toolPools.set(nid, { natural: refs, effective: refs, escalations: [] });
      continue;
    }
    // ban 分支: allowed_tools 强制空集 (skill-manifest §分支 b)
    const isBan = proseBanHits.has(skillId);
    const allowed = isBan ? [] : m.allowed_tools;
    const tp = intersectToolPool(refs, { allowed_tools: allowed, red_lines: m.red_lines });
    toolPools.set(nid, { natural: refs, effective: tp.effective, escalations: tp.escalations });
    if (tp.ppS02) {
      const d = diag(
        'PP-S02',
        'skill_priv_escalation',
        nid,
        tp.escalations,
        'skill-gate',
        {
          remediation:
            '把 skill.allowed_tools 收紧到 ⊆ naturalPool;或升 owner 扩 naturalPool (禁通过 skill 提权)。',
        },
      );
      diagnostics.push(d);
      stderrLines.push(formatStderr(d));
    }
  }

  // ── ⑦ bootstrap-precedes (PP-T03: 引用的 bootstrap 工具非 green → 不可被 build-time 边引用) ──
  stagesRun.push('bootstrap-precedes');
  for (const [nid, n] of Object.entries(nodesShape)) {
    const refs = n.toolRefs ?? [];
    for (const r of refs) {
      const status = bootstrapStates.get(r);
      if (status !== undefined && !canBeReferencedByBuildTimeEdge(status)) {
        const d = diag(
          'PP-T03',
          'tool_not_green',
          nid,
          [r, `bootstrap status=${status}`],
          'bootstrap-precedes',
          {
            remediation:
              'bootstrap 节点 test_gate 必须为 green 才能被 build-time 边引用;yellow/red 引用一律拒。',
          },
        );
        diagnostics.push(d);
        stderrLines.push(formatStderr(d));
      }
    }
  }

  // ── ⑧ link-resolve (depends_on 引用必须存在; 幻象 dep 即时拒) ──
  stagesRun.push('link-resolve');
  for (const [nid, n] of Object.entries(nodesShape)) {
    const deps = n.depends_on ?? [];
    for (const d of deps) {
      if (!(d in nodesShape)) {
        const dd = diag(
          'PP-T01',
          'phantom_dependency',
          nid,
          [d],
          'link-resolve',
          { remediation: `依赖 '${d}' 不在 plan.nodes 中;移除或补足该节点。` },
        );
        diagnostics.push(dd);
        stderrLines.push(formatStderr(dd));
      }
    }
  }

  // ── ⑨ cycle (PlanSchema superRefine 已拦, 此处仍跑 plan-critic 12 闸 + PP-V01/I01 + 收敛回路) ──
  stagesRun.push('cycle');
  const sv = rawPlan.schema_version ?? '1.0';
  if (!isSupportedSchemaVersion(sv)) {
    const d = diag(
      'PP-V01',
      'schema_version_unsupported',
      '<plan>',
      [sv, `supported=${SUPPORTED_SCHEMA_VERSIONS.join('|')}`],
      'cycle',
      { remediation: `改 schema_version 为 ${SUPPORTED_SCHEMA_VERSIONS.join(' 或 ')}。` },
    );
    diagnostics.push(d);
    stderrLines.push(formatStderr(d));
  }
  // PP-I01: 单叶而 whyNoFanout 缺/空 — 可抑制
  if (isSingleLeaf(rawPlan)) {
    const onlyId = Object.keys(rawPlan.nodes)[0] as string;
    const only = nodesShape[onlyId];
    const w = only?.whyNoFanout;
    if (only && (w === undefined || w === null || w === '')) {
      const d = diag(
        'PP-I01',
        'why_no_fanout_missing',
        onlyId,
        ['whyNoFanout undefined'],
        'cycle',
        {
          remediation:
            '单叶 plan 必须填 whyNoFanout (≥1 字非空字符串);说明为何不扇出 (任务原子 / 无对比维度 / 等等)。',
          suppressible: true,
        },
      );
      diagnostics.push(d);
      stderrLines.push(formatStderr(d));
    }
  }
  // 跑 critic 收敛 (≤ MAX_CRITIC_ROUNDS, ≤2 轮)
  const criticLoop = runCriticLoop(
    {
      plan: rawPlan,
      workingSet,
      skills: skillManifests.map((m) => ({
        manifest: m,
        loadKind: proseBanHits.has(m.skill_id) ? 'ban' : 'loaded',
        proseBanHits: proseBanHits.get(m.skill_id),
      })),
      naturalPool: Array.from(new Set(Object.values(nodesShape).flatMap((n) => n.toolRefs ?? []))),
      runId: 'plan-dry-run',
    },
    (prev) => {
      // S1 的零 LLM 重规划探针:先清掉视觉节点上的非法 none 值,留给下一轮补 oracle。
      // 若第二轮因此出现 PP-I02,runCriticLoop 会按 INV-9 判 PP-M02,且不会进第 3 轮。
      const nextPlan = structuredClone(prev.plan) as ConductorPlan;
      for (const node of Object.values(nextPlan.nodes as Record<string, PlanNodeShape>)) {
        if (node.oracleKind === 'none' && isVisualOutput(node)) delete node.oracleKind;
      }
      return {
        plan: nextPlan,
        workingSet: prev.workingSet,
        skills: prev.skills,
        naturalPool: prev.naturalPool,
        runId: prev.runId,
      };
    },
    opts?.escalateFn,
  );
  for (const cd of criticLoop.diagnostics) {
    const tag_ = tagStage(cd, 'cycle');
    diagnostics.push(tag_);
    stderrLines.push(formatStderr(tag_));
  }

  // ── ⑩ prune (现状消费, 0 改 plan-passes/*) ──
  stagesRun.push('prune');
  const pruned = prunePass(rawPlan);
  // prune 之后: 若 plan.nodes 出现 dangling depends_on (被剪掉但引用仍在), 不重检 (D-9 已在前置
  // 闸里通过); prune 只动节点级, 不动 edge → 这里把 pruned 列表推入结果, 不再生成诊断。

  // ── ⑪ emit (resolvedPlan: resolvedToolRefs + per-leaf tool_pool) ──
  stagesRun.push('emit');
  const outNodes: ResolvedNode[] = [];
  for (const [nid, n] of Object.entries(pruned.plan.nodes)) {
    const res = resolutions.get(nid) ?? { resolvedToolRefs: [], hasError: false };
    const tp = toolPools.get(nid) ?? { natural: [], effective: [], escalations: [] };
    // non-leaf 节点的 tool_pool 用全限定 id;leaf 保留交集后的 plan 引用字面。
    const isLeaf = n.executor === 'leaf' || (!n.executor && (n.toolRefs?.length ?? 0) > 0);
    const toolPool = isLeaf ? tp.effective : res.resolvedToolRefs;
    outNodes.push({
      id: nid,
      resolvedToolRefs: res.resolvedToolRefs,
      tool_pool: toolPool,
    });
  }
  const exitCode = diagnostics.length === 0 ? 0 : 1;
  const result: RunPlanDryRunResult = {
    exitCode,
    diagnostics,
    stderrLines,
    criticCalls: criticLoop.calls,
    escalated: criticLoop.escalated,
    ...(criticLoop.escalateReason ? { escalateReason: criticLoop.escalateReason } : {}),
    resolvedPlan: {
      plan: pruned.plan,
      nodes: outNodes,
      stages: stagesRun,
      pruned: pruned.pruned,
    },
    stages: stagesRun,
  };
  // CLI 模式: 单行 JSON to stdout (S1 I/O 契约)。GREEN/RED 都写, verdict 字段区分;
  // 原因: PP-M02 (critic 振荡后升级) 的验收断言要从 stdout 读 criticRounds ≤ 2,
  // 那条用例的 exitCode=1 (有 PP-M02 诊断), 若仅 GREEN 才写就拿不到该字段。
  // 单测默认 emit=false, 不污染 stdout 捕获。
  if (opts.emit === true) {
    process.stdout.write(`${JSON.stringify(buildPlanDryRunStdoutJson(result))}\n`);
  }
  return result;
}

/** 纯函数: RunPlanDryRunResult → stdout JSON 形状。供 emit 通道与单测断言共用。 */
export function buildPlanDryRunStdoutJson(result: RunPlanDryRunResult): StdoutJson {
  const allResolved = new Set<string>();
  const toolPoolByNode: Record<string, readonly string[]> = {};
  for (const n of result.resolvedPlan.nodes) {
    toolPoolByNode[n.id] = n.tool_pool;
    for (const r of n.resolvedToolRefs) allResolved.add(r);
  }
  // toolPoolByNode 也并入全集,供调用方做包含关系断言。
  for (const ids of Object.values(toolPoolByNode)) {
    for (const id of ids) allResolved.add(id);
  }
  const resolvedToolRefs = Array.from(allResolved).sort();
  return {
    schema_version: '1.0',
    verdict: result.exitCode === 0 ? 'GREEN' : 'RED',
    diagnostics: result.diagnostics.map((d) => ({
      code: d.code,
      check: d.check,
      node_id: d.node_id,
      severity: d.severity,
      stage: d.stage,
      round: d.round,
      evidence: d.evidence,
      suppressible: d.suppressible,
      remediation: d.remediation,
    })),
    resolvedToolRefs,
    toolPoolByNode,
    criticRounds: result.criticCalls,
  };
}

// ─── 内部 helper (续) ────────────────────────────────────────────────────

function shortCircuit(
  diagnostics: readonly DryRunDiagnostic[],
  stderrLines: readonly string[],
  stagesRun: readonly PipelineStage[],
): RunPlanDryRunResult {
  return {
    exitCode: 1,
    diagnostics,
    stderrLines,
    criticCalls: 0,
    escalated: false,
    resolvedPlan: { plan: {} as ConductorPlan, nodes: [], stages: stagesRun, pruned: [] },
    stages: stagesRun,
  };
}

async function loadPlanText(input: RunPlanDryRunInput): Promise<string> {
  if (input.kind === 'text') return input.planText;
  return await readFile(input.fixturePath, 'utf8');
}

function dedupe(arr: readonly string[]): readonly string[] {
  return Array.from(new Set(arr));
}

/** bootstrap 节点的 tool_id → InventoryEntry (仅作 plan-dry-run 内的 working-set 装配)。 */
function makeEntry(boot: BootstrapNode, nodeId: string): InventoryEntry {
  return {
    id: boot.test_gate.tool_id,
    name: boot.test_gate.tool_id.split(':')[1]?.split('@')[0] ?? nodeId,
    when_to_use: `bootstrap:${nodeId}`,
    effect: 'read',
    safety_class: 'bootstrap',
    cost_tier: 't1',
    defer_mode: 'sync',
    signature: {},
    oracle: { kind: 'command', gateScriptRef: 'bootstrap' },
    probe_state: 'PROBED_OK',
    applicability: 'APPLICABLE',
    idle_days: 0,
    provenance: {
      registered_at: INVENTORY_EPOCH,
      registered_by: 'bootstrap',
      source_repo: 'bootstrap',
      source_path: boot.outputs.tool_path,
      commit_sha: '0'.repeat(40),
      import_method: 'bootstrap',
      imported_at: INVENTORY_EPOCH,
      imported_by: 'bootstrap',
      upstream_version: '0.0.0',
      content_sha256: '0'.repeat(64),
      schema_version: '1.0',
    },
    search_hint: `bootstrap:${nodeId}`,
    owner_pinned: false,
    oracle_bearing: true,
  };
}