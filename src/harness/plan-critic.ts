/**
 * src/harness/plan-critic —— ConductorPlan 编译期静态闸 (S1 / 片 3 主体)。
 *
 * 契约源: docs/plan/2026-08-24-conductor-s1-五闸与清单-执行契约.md C-3 + 同名 SDD §5/§6。
 *          片 4 增量: docs/plan/2026-08-27-conductorS3-retry域与verdict幂等-执行契约.md §D-8。
 *
 * 设计要点:
 * - 纯 STATIC (零 LLM, 集合成员 + 字段存在性, 误拒率按定义为 0)。
 * - 16 诊断码 (PP-T01/T02/T03 · PP-O01/O02 · PP-S01/S02/S03 · PP-V01 · PP-I01/I02 ·
 *   PP-M01/M02 · PP-B01/B02/B03) + 1 不变量闸 (INV-12 bypass/skipGate 一律拒)。
 * - PP-O02 (#244 契约 C-1): 写文件节点而全图无 command 验证步且节点本身 oracleKind 缺
 *   或声明 'none' → error。逐写节点诊断, 'none' 不是逃生门 (无判据)。
 * - PP-B01/B02/B03 (片 4, S3 §D-8): 预算判定闸三码互不代偿 —— 节点缺 budgetBasis /
 *   estimatedBy 空串 / Σ costUsdCeiling > 注入 run 级上限。PP-B03 仅在调用方注入了
 *   runCeilingUsd 时才判, 未注入 = 零回归 (与 S1「critique 只判字段存在性」一致)。
 * - 输入 = ConductorPlan + inventory working-set + skill manifests(+ prose ban 信息)
 *   + node 的 natural 工具池 + runId + 可选 runCeilingUsd(片 4 PP-B03 注入上限);输出 = Diagnostic[]。
 * - 抑制走 plan.suppressions[];suppressible:false 的码抑制无效 (PP-S02 hard-coded
 *   suppressible:false; PP-I01 hard-coded suppressible:true; 其余默认 false)。
 * - 轮回路: runCriticLoop 自管 ≤2 轮, 收敛 = 诊断集缩小;新码 = PP-M02;耗尽 = PP-M01;
 *   任一 M 码 → escalate (调 escalateFn) + **停 plan, 不许第 3 轮**。调用计数暴露为
 *   loop 返回值 .calls, 供测试断言 ≤2。
 * - escalateFn 默认接 src/mcp/owner-inbox.openFork (禁 defer 禁擅断, 升 owner)。
 *
 * INV-13 装配期扫 checks[] 自动追加 PostLeafGate 节点的判定也在此实装:对每个
 * manifest.checks[*] 的 name, 扫 plan.nodes 找一条 executor='command' 且 command 含该
 * name 的节点视为对应 PostLeafGate;找不到 → PP-S01。PostLeafGate 节点的「命令串包含
 * 脚本名」是当前 PlanSchema 下唯一可断言的判定 (PlanNode 无独立 skill_check_ref 字段,
 * 由片 5 装配期另立, 此处先用保守的子串匹配)。
 */
import { resolve as resolveQuery, type ResolveResult as InvResolveResult } from './inventory/resolve';
import type { InventoryEntry } from './inventory/inventory';
import type { SkillManifest, ProseBanHit } from './skill-manifest';
import {
  SUPPORTED_SCHEMA_VERSIONS,
  isSupportedSchemaVersion,
  type ConductorPlan,
} from './conductor-plan';

// ─── 诊断形状 (S1 契约 §3.3) ─────────────────────────────────────────────────

/** 16 PP-* 诊断码的字面联合 (字面量锁定, 改一处核所有消费者)。
 *  片 4 增量: PP-B01 · PP-B02 · PP-B03 —— 预算判定闸三码 (S3 §D-8)。 */
export type DiagnosticCode =
  | 'PP-T01' | 'PP-T02' | 'PP-T03'
  | 'PP-O01' | 'PP-O02'
  | 'PP-S01' | 'PP-S02' | 'PP-S03'
  | 'PP-V01'
  | 'PP-I01' | 'PP-I02'
  | 'PP-M01' | 'PP-M02'
  | 'PP-B01' | 'PP-B02' | 'PP-B03'
  /** INV-12: plan 携带 bypass/skipGate 一律拒 (不属 16 码, 独立闸)。 */
  | 'INV-12';

/** 严重度: 12 码全部为 hard error (打回/停 plan/escalate);没有 warning。 */
export type DiagnosticSeverity = 'error';

/**
 * Diagnostic —— 闸判词的统一形状。
 *  - code: 诊断码 (PP-* 或 INV-12)。
 *  - severity: error (12 码全 error)。
 *  - check: 人类可读的短名 (如 'tool_unresolved'), 错误行用 `<code> <check>: <evidence>`。
 *  - node_id: 违例节点 (bypass/skipGate 在 plan 顶层时 = '<plan>')。
 *  - evidence: 证据行 (PP-T02 列全部候选全限定 id; 其余单值或简短描述)。
 *  - remediation: 必填, 一行字面, 让 conductor 打回后能一次改对。
 *  - round: 1..maxCriticRounds, 标识此诊断来自哪一轮。
 *  - suppressible: false ⇒ plan.suppressions 抑制无效 (硬闸);true ⇒ 可抑制。
 */
export interface Diagnostic {
  readonly code: DiagnosticCode;
  readonly severity: DiagnosticSeverity;
  readonly check: string;
  readonly node_id: string;
  readonly evidence: readonly string[];
  readonly remediation: string;
  readonly round: number;
  readonly suppressible: boolean;
}

// ─── Skill 装载元信息 (含 INV-15 分支 b 启发式命中) ─────────────────────────

/** critic 消费的 skill 形态 = 已校验的 manifest + 装载分支配套信息。 */
export interface SkillWithLoadInfo {
  readonly manifest: SkillManifest;
  /** skill-manifest.loadSkillManifest 返的 kind (重导出字面)。 */
  readonly loadKind: 'loaded' | 'ban';
  /** kind='ban' 时附带的命中坐标 (供 PP-S03 evidence 用);loaded 时省略。 */
  readonly proseBanHits?: readonly ProseBanHit[];
}

// ─── Critic 输入 ────────────────────────────────────────────────────────────

/**
 * 单轮 critic 的判定输入。runCriticLoop 在每轮以此装配调用 critic。
 *  - plan: 已经 zod 解析过的 ConductorPlan (含顶层/节点级新字段)。
 *  - round: 1-based, 当前轮号。
 *  - previousDiagnostics: 上一轮的诊断 (PP-M01/M02 收敛判定用;首轮 undefined)。
 *  - workingSet: inventory 工作集快照 (PP-T01/T02 解析)。
 *  - skills: 已装载的 skill 列表 + 装载分支 (PP-S01/S02/S03 全部消费)。
 *  - naturalPool: leaf 的 natural 工具池 (PP-S02 提权判定的对照集;省略 = 跳过 PP-S02)。
 *  - runId: 升级时写 owner-inbox 用的 run 身份 (escalate 阶段使用)。
 *  - runCeilingUsd: 片 4 PP-B03 注入 —— run 级 costUsdCeiling 上限;省略 = 不判 PP-B03
 *    (零回归;单位由 SDD §11 owner 待决 #15 在调用方一侧定死, 此闸本身不认识单位)。
 */
export interface CriticInput {
  readonly plan: ConductorPlan;
  readonly round: number;
  readonly previousDiagnostics?: readonly Diagnostic[];
  readonly workingSet: ReadonlyArray<InventoryEntry>;
  readonly skills: ReadonlyArray<SkillWithLoadInfo>;
  readonly naturalPool?: readonly string[];
  readonly runId: string;
  readonly runCeilingUsd?: number;
}

// ─── 升级通路 ────────────────────────────────────────────────────────────────

/**
 * 升级请求 (PP-M01 / PP-M02 → owner 决策队列)。
 * 默认实装 = 写 owner-inbox.openFork (禁 defer 禁擅断);测试可注入替身断言。
 */
export interface EscalationRequest {
  readonly code: 'PP-M01' | 'PP-M02';
  readonly runId: string;
  readonly round: number;
  /** 触发升级的诊断 (含 PP-M01/PP-M02 自身 + 残存诊断)。 */
  readonly diagnostics: readonly Diagnostic[];
  /** 人类可读的升级理由。 */
  readonly reason: string;
}

export type EscalationHook = (req: EscalationRequest) => void;

// ─── 主循环结果 ──────────────────────────────────────────────────────────────

export interface CriticLoopResult {
  /** 最终留下的诊断 (可能空 = 全绿)。 */
  readonly diagnostics: readonly Diagnostic[];
  /** critic 实际被调用的次数 (硬上限 = maxCriticRounds);测试断言 ≤2。 */
  readonly calls: number;
  /** 是否升级到 owner (任一 M 码触发后为 true, 此后 stop, 无第 3 轮)。 */
  readonly escalated: boolean;
  /** 升级触发码;未升级时省略。 */
  readonly escalateReason?: 'PP-M01' | 'PP-M02';
  /** 轮数上限常量, 暴露给消费者 (含 §1.5 契约)。 */
  readonly maxCriticRounds: number;
}

// ─── 常量 ────────────────────────────────────────────────────────────────────

/** 轮数上限 (S1 契约 §6 / SDD §5 F16 / D6 #1 已决)。 */
export const MAX_CRITIC_ROUNDS = 2;

/** 默认 schema_version (plan.schema_version 缺省时视作此值)。 */
const DEFAULT_SCHEMA_VERSION = '1.0';

// ─── 内部 helper ─────────────────────────────────────────────────────────────

/** PlanNode 在 passthrough 下类型被宽化;此处抽成局部 shape 防重复 .?. 链。 */
interface PlanNodeShape {
  executor?: string;
  oracleKind?: string;
  toolRefs?: readonly string[];
  whyNoFanout?: string | null;
  type?: string;
  test_gate?: { status?: string; tool_id?: string };
  outputs?: { tool_path?: string };
  output_type?: string;
  output_path?: string;
  contentType?: string;
  attach_media?: boolean;
  command?: string;
  skill?: string;
  bypass?: unknown;
  skipGate?: unknown;
  /** 片 4 PP-B01/B02 消费: 节点级预算声明 (zod 形状见 conductor-plan.ts:341)。 */
  budgetBasis?: {
    calls?: number;
    tokensIn?: number;
    tokensOut?: number;
    costUsdCeiling?: number;
    estimatedBy?: string;
  };
}

/** 诊断抑制: 仅当 plan.suppressions 包含该 code 且 diagnostic.suppressible=true 时过滤。 */
function applySuppressions(
  diagnostics: readonly Diagnostic[],
  suppressions: readonly string[] | undefined,
): Diagnostic[] {
  if (!suppressions || suppressions.length === 0) return [...diagnostics];
  const supSet = new Set(suppressions);
  return diagnostics.filter((d) => !(supSet.has(d.code) && d.suppressible));
}

/** 单叶判定: 单节点图 = 全图只有一个节点,不论 executor 是什么。 */
function isSingleLeafPlan(plan: ConductorPlan): boolean {
  return Object.keys(plan.nodes).length === 1;
}

/** 文件输出是否为视觉类 (image/*);以 output_path 后缀判定,辅以 attach_media=true。
 *  SDD §5 F2 字面: image/png 产出 + oracleKind:"none" → PP-O01。 */
function isVisualOutput(node: PlanNodeShape): boolean {
  const p = node.output_path ?? '';
  if (/\.(png|jpe?g|gif|webp|svg|bmp|ico|avif)$/i.test(p)) return true;
  if (node.contentType && /^image\//i.test(node.contentType)) return true;
  if (node.attach_media === true) return true;
  return false;
}

/** 节点是否为「写文件节点」(会向磁盘/git 落产物): output_type ∈ {file, git} 或
 *  output_path 非空 (#244 契约 D-3 字面)。非合成器节点 (executor='command') 也算写节点
 *  —— 它可能写脚本/配置文件;但本闸只看字段, 区分由 oracleKind 决定。 */
function isWriteNode(node: PlanNodeShape): boolean {
  const ot = node.output_type;
  if (ot === 'file' || ot === 'git') return true;
  if (typeof node.output_path === 'string' && node.output_path.length > 0) return true;
  return false;
}

/** 全图是否存在任意 executor:'command' 验证节点 (#244 契约 D-3 PP-O02 的图级前提)。 */
function hasCommandVerifier(nodes: Record<string, PlanNodeShape>): boolean {
  for (const n of Object.values(nodes)) {
    if (n.executor === 'command') return true;
  }
  return false;
}

/** 节点是否为「bootstrap 节点」(本片不替 zod 立 type='bootstrap',passthrough 已允许,
 *  这里按字段出现识别;test_gate 缺失即视为非 bootstrap,不参与 PP-T03)。 */
function asBootstrapNode(node: PlanNodeShape): { toolId: string; status: string } | null {
  if (node.type !== 'bootstrap') return null;
  const toolId = node.test_gate?.tool_id ?? node.outputs?.tool_path;
  const status = node.test_gate?.status;
  if (!toolId || !status) return null;
  return { toolId, status };
}

/** 在 plan.nodes 中查找能产出某 toolId 的 bootstrap 节点;找不到返 null。 */
function findBootstrapByToolId(
  nodes: Record<string, PlanNodeShape>,
  toolId: string,
): { status: string } | null {
  for (const node of Object.values(nodes)) {
    const b = asBootstrapNode(node);
    if (b && b.toolId === toolId) return { status: b.status };
  }
  return null;
}

/** 节点是否为某 check 的对应 PostLeafGate: executor='command' + command 串包含脚本名。 */
function isPostLeafGateFor(node: PlanNodeShape, checkName: string): boolean {
  if (node.executor !== 'command') return false;
  const cmd = node.command ?? '';
  return cmd.includes(checkName);
}

// ─── 12 码 + INV-12 判定 ─────────────────────────────────────────────────────

/**
 * 核心: 单轮 critic 静态判定,产 Diagnostic[] (未经抑制)。
 * 每码独立函数;此处组装为一道流水线,顺序固定,便于读 + 测试对照。
 */
export function critique(input: CriticInput): Diagnostic[] {
  const { plan, round, workingSet, skills, naturalPool } = input;
  const out: Diagnostic[] = [];
  const nodes = plan.nodes as Record<string, PlanNodeShape>;

  // ── INV-12: 顶层字段 bypass / skipGate 一律拒 (PlanSchema passthrough 允许写入, critic 拦)
  {
    const top = plan as unknown as { bypass?: unknown; skipGate?: unknown };
    if (top.bypass !== undefined || top.skipGate !== undefined) {
      out.push({
        code: 'INV-12',
        severity: 'error',
        check: 'inv_12_no_bypass_skipGate',
        node_id: '<plan>',
        evidence: [
          top.bypass !== undefined ? `bypass=${JSON.stringify(top.bypass)}` : '',
          top.skipGate !== undefined ? `skipGate=${JSON.stringify(top.skipGate)}` : '',
        ].filter(Boolean),
        remediation: '删掉该字段;plan 不得声明 bypass/skipGate (I-13 pin_exempts_prune_only)。',
        round,
        suppressible: false,
      });
    }
  }
  for (const [nid, node] of Object.entries(nodes)) {
    if (node.bypass !== undefined || node.skipGate !== undefined) {
      out.push({
        code: 'INV-12',
        severity: 'error',
        check: 'inv_12_no_bypass_skipGate',
        node_id: nid,
        evidence: [
          node.bypass !== undefined ? `bypass=${JSON.stringify(node.bypass)}` : '',
          node.skipGate !== undefined ? `skipGate=${JSON.stringify(node.skipGate)}` : '',
        ].filter(Boolean),
        remediation: '删掉该字段;plan 不得声明 bypass/skipGate (I-13 pin_exempts_prune_only)。',
        round,
        suppressible: false,
      });
    }
  }

  // ── PP-T01 / PP-T02: toolRef 解析
  for (const [nid, node] of Object.entries(nodes)) {
    const refs = node.toolRefs ?? [];
    for (const ref of refs) {
      const r: InvResolveResult = resolveQuery(ref, workingSet);
      if (r.state === 'miss') {
        out.push({
          code: 'PP-T01',
          severity: 'error',
          check: 'tool_unresolved',
          node_id: nid,
          evidence: [ref, 'NOT_IN_WORKING_SET'],
          remediation: `把 ${ref} 加进 inventory 并 promote 到 working-set;或从 toolRefs 移除。`,
          round,
          suppressible: false,
        });
      } else if (r.state === 'ambiguous') {
        out.push({
          code: 'PP-T02',
          severity: 'error',
          check: 'tool_ambiguous',
          node_id: nid,
          evidence: [ref, ...r.candidates],
          remediation: `用全限定 id (${r.candidates.join(' | ')}) 之一替换裸名 ${ref};INV-2 禁按优先级静默选边。`,
          round,
          suppressible: false,
        });
      }
    }
  }

  // ── PP-T03: bootstrap 工具非 green 被引用
  for (const [nid, node] of Object.entries(nodes)) {
    const refs = node.toolRefs ?? [];
    for (const ref of refs) {
      const b = findBootstrapByToolId(nodes, ref);
      if (b && b.status !== 'green') {
        out.push({
          code: 'PP-T03',
          severity: 'error',
          check: 'tool_not_green',
          node_id: nid,
          evidence: [ref, `test_gate.status=${b.status}`],
          remediation: `等 ${ref} 的 bootstrap test_gate 转 green 后再引用;或换一个已 green 的工具。`,
          round,
          suppressible: false,
        });
      }
    }
  }

  // ── PP-O01: 视觉类产出 + oracleKind:'none' (INV-10)
  for (const [nid, node] of Object.entries(nodes)) {
    if (node.oracleKind === 'none' && isVisualOutput(node)) {
      out.push({
        code: 'PP-O01',
        severity: 'error',
        check: 'oracle_missing',
        node_id: nid,
        evidence: [
          `oracleKind=none`,
          `visual-output=${node.output_path ?? node.contentType ?? 'attach_media'}`,
        ],
        remediation: '视觉产出必须挂 oracle (cheap/render/judge/self_built);不要把视觉验证塞进自然语言判断。',
        round,
        suppressible: false,
      });
    }
  }

  // ── PP-O02: 写文件节点 + 全图无 command 验证 + 节点 oracleKind 缺或 'none'
  //  (#244 契约 C-1 / D-3; 活环有界拒回, 不许 'none' 当逃生门)
  if (!hasCommandVerifier(nodes)) {
    for (const [nid, node] of Object.entries(nodes)) {
      if (!isWriteNode(node)) continue;
      const ok = node.oracleKind !== undefined && node.oracleKind !== 'none';
      if (ok) continue;
      out.push({
        code: 'PP-O02',
        severity: 'error',
        check: 'writes_without_gate',
        node_id: nid,
        evidence: [
          `output_type=${node.output_type ?? '<unset>'}`,
          `output_path=${node.output_path ?? '<unset>'}`,
          `oracleKind=${node.oracleKind ?? '<unset>'}`,
          `command_verifier=none`,
        ],
        remediation:
          '加一个 executor:"command" 验证节点, 或给该节点声明 oracleKind ∈ {cheap, render, judge, self_built} (文档类交付用 judge); oracleKind:"none" 不是逃生门。',
        round,
        suppressible: false,
      });
    }
  }

  // ── PP-S01: manifest.checks[*] 在 plan 中缺对应 PostLeafGate (INV-13)
  for (const skill of skills) {
    for (const check of skill.manifest.checks) {
      const has = Object.values(nodes).some((n) => isPostLeafGateFor(n, check.name));
      if (!has) {
        out.push({
          code: 'PP-S01',
          severity: 'error',
          check: 'skill_check_unattached',
          node_id: `<plan>:${skill.manifest.skill_id}`,
          evidence: [check.name],
          remediation: `加一条 executor:'command' 的 PostLeafGate 节点,command 串包含 '${check.name}'。`,
          round,
          suppressible: false,
        });
      }
    }
  }

  // ── PP-S02: skill 提权 (skill.allowed_tools \\ naturalPool) — 不可抑制
  if (naturalPool && naturalPool.length >= 0) {
    const naturalSet = new Set(naturalPool);
    for (const skill of skills) {
      const escalations = skill.manifest.allowed_tools.filter((t) => !naturalSet.has(t));
      if (escalations.length > 0) {
        // 该提权信号挂在引用了该 skill 的节点上 (无引用则挂在 plan 顶层)
        const useNids = Object.entries(nodes)
          .filter(([, n]) => n.skill === skill.manifest.skill_id)
          .map(([id]) => id);
        const nid = useNids[0] ?? `<plan>:${skill.manifest.skill_id}`;
        out.push({
          code: 'PP-S02',
          severity: 'error',
          check: 'skill_priv_escalation',
          node_id: nid,
          evidence: [skill.manifest.skill_id, ...escalations],
          remediation: `把 skill.allowed_tools 收紧到 ⊆ naturalPool;或升 owner 扩 naturalPool (禁通过 skill 提权)。`,
          round,
          suppressible: false,
        });
      }
    }
  }

  // ── PP-S03: 散文禁令未验证 (skill-manifest kind='ban') — 可抑制 (默认 false,显式 true)
  for (const skill of skills) {
    if (skill.loadKind === 'ban') {
      const hits = skill.proseBanHits ?? [];
      out.push({
        code: 'PP-S03',
        severity: 'error',
        check: 'skill_constraints_unverified',
        node_id: `<plan>:${skill.manifest.skill_id}`,
        evidence: [
          skill.manifest.skill_id,
          ...hits.map((h) => `L${h.line}:${h.col} ${h.marker}`),
        ],
        remediation: `补 manifest.checks[] / red_lines[] (结构化闸) 或移除散文禁令句;保守默认装载下 leaf 工具池零扩展。`,
        round,
        suppressible: true,
      });
    }
  }

  // ── PP-V01: schema_version 不在支持集 (INV-7)
  const sv = plan.schema_version ?? DEFAULT_SCHEMA_VERSION;
  if (!isSupportedSchemaVersion(sv)) {
    out.push({
      code: 'PP-V01',
      severity: 'error',
      check: 'schema_version_unsupported',
      node_id: '<plan>',
      evidence: [sv, `supported=${SUPPORTED_SCHEMA_VERSIONS.join('|')}`],
      remediation: `改 schema_version 为 ${SUPPORTED_SCHEMA_VERSIONS.join(' 或 ')}。`,
      round,
      suppressible: false,
    });
  }

  // ── PP-I01: 单叶而 whyNoFanout 缺/空 — 可抑制
  if (isSingleLeafPlan(plan)) {
    const onlyId = Object.keys(plan.nodes)[0] as string;
    const only = nodes[onlyId] as PlanNodeShape | undefined;
    const w = only?.whyNoFanout;
    if (only && (w === undefined || w === null || w === '')) {
      out.push({
        code: 'PP-I01',
        severity: 'error',
        check: 'why_no_fanout_missing',
        node_id: onlyId,
        evidence: ['whyNoFanout undefined'],
        remediation: '单叶 plan 必须填 whyNoFanout (≥1 字非空字符串);说明为何不扇出 (任务原子 / 无对比维度 / 等等)。',
        round,
        suppressible: true,
      });
    }
  }

  // ── PP-I02: oracleKind 缺
  for (const [nid, node] of Object.entries(nodes)) {
    if (node.oracleKind === undefined) {
      out.push({
        code: 'PP-I02',
        severity: 'error',
        check: 'oracle_kind_missing',
        node_id: nid,
        evidence: ['oracleKind undefined'],
        remediation: '填 oracleKind ∈ {cheap, render, judge, none, self_built};视觉产出不能用 none (见 PP-O01)。',
        round,
        suppressible: false,
      });
    }
  }

  // ── PP-B01: 预算声明**一致性** (S3 §D-8a)
  //
  // 不是「每个节点都必须声明预算」的强制闸 —— 那个写法第 1 跑实测打回:
  // 仓内既有 plan 夹具没有一份声明 budgetBasis, 于是「0 诊断」「全绿 plan → exitCode 0」
  // 这类断言成批塌 (plan-dry-run 4 条 + runCriticLoop 2 条)。
  //
  // 改成一致性闸: **图里只要有任一节点声明了预算, 就要求每个节点都声明**;
  // 全图零声明 = 这份 plan 不上预算轴, 不判 (零回归)。
  // 它比强制闸更该存在 —— PP-B03 要对 Σ costUsdCeiling 求和, 而**部分声明的预算和是没有意义的数**,
  // 一致性正是让那个求和可信的前提。
  //
  // 反向自检: 把下面这行改成 `const anyDeclared = true`, plan-dry-run 与 runCriticLoop
  // 合计 6 条当场红 (即第 1 跑那 6 条)。
  const anyDeclared = Object.values(nodes).some((n) => n.budgetBasis !== undefined);
  for (const [nid, node] of Object.entries(nodes)) {
    if (!anyDeclared) break; // 全图零声明 → 不上预算轴, 一条不判
    if (node.budgetBasis === undefined) {
      out.push({
        code: 'PP-B01',
        severity: 'error',
        check: 'budget_basis_missing',
        node_id: nid,
        evidence: ['budgetBasis undefined (同图内已有别的节点声明了预算)'],
        remediation:
          '填 budgetBasis = { calls:int, tokensIn:int, tokensOut:int, costUsdCeiling:number, estimatedBy:string } (节点级预算声明, 见 schema)。' +
          '本图已有节点声明预算, 就要全部声明 —— 部分声明会让 PP-B03 的 Σ costUsdCeiling 变成没有意义的数。' +
          '若这份 plan 本就不上预算轴, 把已声明的那些一并去掉即可。',
        round,
        suppressible: false,
      });
    }
  }

  // ── PP-B02: estimatedBy 空串 (S3 §D-8 — 估算法没登记 = 这份预算不可核)
  for (const [nid, node] of Object.entries(nodes)) {
    const bb = node.budgetBasis;
    // 缺 budgetBasis 的节点归 PP-B01, 这里不重复判 (空串 vs 缺席, 仓规坑 1)
    if (bb === undefined) continue;
    if (bb.estimatedBy === '') {
      out.push({
        code: 'PP-B02',
        severity: 'error',
        check: 'budget_estimated_by_empty',
        node_id: nid,
        evidence: ['estimatedBy=""', 'estimatedBy unset → estimator not registered'],
        remediation: '填 estimatedBy 为非空字符串 (登记估算法标识;例 "owner-vouched" / "stub" / "tier-default")。',
        round,
        suppressible: false,
      });
    }
  }

  // ── PP-B03: Σ costUsdCeiling 超注入 run 级上限 (S3 §D-8 — 仅在调用方注入了 runCeilingUsd 才判)
  if (input.runCeilingUsd !== undefined) {
    let sum = 0;
    const participants: string[] = [];
    for (const [nid, node] of Object.entries(nodes)) {
      const ceil = node.budgetBasis?.costUsdCeiling;
      if (typeof ceil !== 'number' || !Number.isFinite(ceil)) continue; // 缺 / 非数 不参与 (PP-B01 另报)
      sum += ceil;
      participants.push(`${nid}:${ceil}`);
    }
    if (sum > input.runCeilingUsd) {
      out.push({
        code: 'PP-B03',
        severity: 'error',
        check: 'budget_run_ceiling_exceeded',
        node_id: '<plan>',
        evidence: [
          `sum=${sum}`,
          `ceiling=${input.runCeilingUsd}`,
          `participants=${participants.join(',')}`,
        ],
        remediation:
          'Σ costUsdCeiling 超过注入 run 级上限;减节点预算 / 删节点 / 升 owner 调上限 (单位由调用方定, 此闸不识单位)。',
        round,
        suppressible: false,
      });
    }
  }

  // 抑制按 plan.suppressions[] 应用 (PP-S02 hard false 不受影响)
  return applySuppressions(out, plan.suppressions);
}

// ─── 收敛 / 振荡 / 耗尽 ─────────────────────────────────────────────────────

/** 取诊断的 code 集合 (用于「缩小 / 新码」判定)。 */
function codesOf(diags: readonly Diagnostic[]): Set<string> {
  return new Set(diags.map((d) => d.code));
}

/**
 * 自管轮回路。≤MAX_CRITIC_ROUNDS 轮;每轮调 critique() 计 calls;收敛 = 诊断集**真缩小**
 * (旧诊断 ⊋ 新诊断, 严格);新码 = 立即 PP-M02 escalate;耗尽 = PP-M01 escalate;任一升级 → 停。
 *
 * 收敛判定细则 (字面照 SDD §5 F16):
 *   - 诊断集**缩小** = 收敛 (许下一轮, 直至 maxCriticRounds)。
 *   - 引入**新码** = 振荡, 立即 PP-M02 escalate。
 *   - 轮次用尽 = PP-M01 escalate。
 *   - 0 诊断 = 直接收敛, 0 calls (不调 critic)。该路径为优化, 不影响 calls 上限断言。
 *
 * @param input0            首轮输入 (round=1;previousDiagnostics 必空)。
 * @param nextInput         后续轮的输入装配函数 (prev → next);只在首轮非空时调用。
 * @param escalateFn        升级钩子;默认 = 通过 owner-inbox.openFork (测试可注入替身)。
 */
export function runCriticLoop(
  input0: Omit<CriticInput, 'round' | 'previousDiagnostics'>,
  nextInput?: (prev: CriticInput) => Omit<CriticInput, 'round'>,
  escalateFn: EscalationHook = defaultEscalate,
): CriticLoopResult {
  // 首轮: round=1, prev 缺省空集
  let current: CriticInput = { ...input0, round: 1, previousDiagnostics: [] };
  let lastDiagnostics: readonly Diagnostic[] = critique(current);
  let calls = 1;

  // 0 诊断 = 直接收敛 (免一次空 round 2)
  if (lastDiagnostics.length === 0) {
    return {
      diagnostics: [],
      calls,
      escalated: false,
      maxCriticRounds: MAX_CRITIC_ROUNDS,
    };
  }

  // 已达上限且非空 → PP-M01 升级, 不再调 critic (calls 不会再 +1)
  if (calls >= MAX_CRITIC_ROUNDS) {
    return finishWithEscalate(lastDiagnostics, calls, 'PP-M01', escalateFn);
  }

  // 后续轮 (round 2)
  while (calls < MAX_CRITIC_ROUNDS) {
    const baseForNext = nextInput
      ? nextInput(current)
      : { ...input0 }; // 默认: 输入不变, round / previous 由循环填
    current = {
      ...baseForNext,
      round: calls + 1,
      previousDiagnostics: lastDiagnostics,
    };
    const diags = critique(current);
    calls += 1;
    lastDiagnostics = diags;

    if (diags.length === 0) break; // 收敛

    // 新码 = 振荡 (PP-M02)
    const prevCodes = codesOf(current.previousDiagnostics ?? []);
    const newCodes = codesOf(diags).difference(prevCodes);
    if (newCodes.size > 0) {
      // 把 PP-M02 加进本次诊断再升级
      const m02: Diagnostic = {
        code: 'PP-M02',
        severity: 'error',
        check: 'critic_oscillation',
        node_id: '<plan>',
        evidence: [`new_codes=${[...newCodes].join(',')}`],
        remediation: '诊断集未收敛且引入新码 = 振荡;此 plan 升级 owner 决策, 不再 critic 自治。',
        round: current.round,
        suppressible: false,
      };
      const combined = [...diags, m02];
      return finishWithEscalate(combined, calls, 'PP-M02', escalateFn);
    }

    // 收敛? 严格 ⊋ 才算缩小 (等长 = 没缩, 走耗尽分支)
    const shrank = isStrictSubset(current.previousDiagnostics ?? [], diags);
    if (shrank) continue; // 仍可下一轮 (虽然本配置上限 = 2, 此分支不会触发;留作 N>2 时的扩展位)

    // 没缩 + 没新码 + 没收敛 = 耗尽 → PP-M01
    const m01: Diagnostic = {
      code: 'PP-M01',
      severity: 'error',
      check: 'critic_rounds_exhausted',
      node_id: '<plan>',
      evidence: [`rounds=${calls}`, `codes=${[...codesOf(diags)].join(',')}`],
      remediation: 'critic 在 maxCriticRounds 轮内未收敛;此 plan 升级 owner 决策, 不再 critic 自治。',
      round: current.round,
      suppressible: false,
    };
    const combined = [...diags, m01];
    return finishWithEscalate(combined, calls, 'PP-M01', escalateFn);
  }

  return {
    diagnostics: lastDiagnostics,
    calls,
    escalated: false,
    maxCriticRounds: MAX_CRITIC_ROUNDS,
  };
}

/** 严格缩小判定: next ⊊ prev (按 code+node_id 复合键) —— next 无新键且条数变少。
 *  ⚠ 方向别再写反 (2026-08-24 修): 「prev 全在 next 里 ∧ next 更短」两条件互斥, 恒 false,
 *  于是缩小分支从不触发、一律走 PP-M01 —— 正是「闸永远命中」形态的误杀。 */
function isStrictSubset(prev: readonly Diagnostic[], next: readonly Diagnostic[]): boolean {
  if (prev.length === 0) return false;
  const keyOf = (d: Diagnostic) => `${d.code}::${d.node_id}`;
  const prevKeys = new Set(prev.map(keyOf));
  for (const d of next) if (!prevKeys.has(keyOf(d))) return false;
  return next.length < prev.length;
}

function finishWithEscalate(
  diagnostics: readonly Diagnostic[],
  calls: number,
  code: 'PP-M01' | 'PP-M02',
  escalateFn: EscalationHook,
): CriticLoopResult {
  escalateFn({
    code,
    runId: diagnostics[0]?.node_id === '<plan>' ? '<plan>' : (diagnostics[0]?.node_id ?? '<plan>'),
    round: diagnostics[diagnostics.length - 1]?.round ?? calls,
    diagnostics,
    reason:
      code === 'PP-M01'
        ? `critic 在 ${calls} 轮内未收敛`
        : `critic 引入新码 = 振荡`,
  });
  return {
    diagnostics,
    calls,
    escalated: true,
    escalateReason: code,
    maxCriticRounds: MAX_CRITIC_ROUNDS,
  };
}

// ─── 默认升级实现: owner-inbox.openFork ─────────────────────────────────────

/**
 * 默认 escalateFn: 写 owner 决策队列 (升 owner), 禁 defer 禁擅断。
 * 失败 (owner-inbox 不可用 / IO 错) → 把错误吞入 stderr 一行 + 仍返回 (fail-open 在升级
 * 这一路**禁用**:升级失败意味着 plan 必停, 而 plan 已被本函数标记 escalated=true, 调用方
 * 见 escalated 后应停 plan;升级通路本身的失败由 stderr 暴露给运维)。
 */
export const defaultEscalate: EscalationHook = (req) => {
  // 动态 import 避免在 test 注入替身时硬绑 owner-inbox 副作用
  // (且 owner-inbox 引 bun:sqlite, 单测环境无需起 sqlite)
  // 此处仅在真升级路径用到, fail-open 留给上层;
  // 测试里通过注入替身断言。
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createOwnerInbox } = require('../mcp/owner-inbox') as typeof import('../mcp/owner-inbox');
    const inbox = createOwnerInbox({ path: ':memory:' });
    inbox.openFork({
      id: `${req.code}-${req.runId}-${req.round}`,
      runId: req.runId,
      nodeId: '<plan>',
      round: req.round,
      question: `plan-critic ${req.code}: ${req.reason}`,
      recommendation: '停 plan, 升级 owner 决策',
      assumption: '本 plan 已被 critic 判 M 码, 不再 critic 自治',
      blocking: true,
    });
    inbox.close();
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(`[plan-critic] escalate 失败: ${(e as Error).message}; 但 escalated=true 已生效, plan 应停`);
  }
};
