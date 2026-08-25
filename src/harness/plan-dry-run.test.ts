/**
 * src/harness/plan-dry-run 单元测试 (C-3 / INV-21)。
 *
 * 契约源: 《S1 接口契约》§2.1 (runPlanDryRun 入/出参) + §3.3 (Diagnostic 形状) +
 *         docs/plan/2026-08-24-conductor-s1-五闸与清单-执行契约.md C-1..C-5 + D-B 序表 +
 *         docs/silent-failures.md §INV-21 (stderr 行格式)。
 *
 * 覆盖矩阵 (本件 4 项 INV-21 硬断言):
 *   ① D-B 序 + 新闸位次断言 (PIPELINE_STAGES 逐字一致; tool-resolve / oracle-required /
 *      skill-gate / bootstrap-precedes 全部排在 prune 之前)。
 *   ② 幻象 toolRef → 诊断 PP-T01 tool_unresolved + exitCode 1 + stderr 行字面
 *      `PP-T01 tool_unresolved: <bareRef>`。
 *   ③ 全绿 plan → exitCode 0; `resolvedToolRefs` 全限定 id; 每 leaf 的 toolPool 已取交集
 *      (skill.allowed_tools ⊊ toolRefs 时 ⊊ 收窄成立)。
 *   ④ `emit:true` 时 stdout JSON 包含 `criticRounds` (number) 与 `toolPoolByNode`
 *      (object, 非空), 供 F16 (PP-M02) / F6 (绿路径 tool_pool) 验收。
 *
 * 反向自检:
 *   - 把 `PIPELINE_STAGES` 改成 `[..., 'prune', 'emit']` 之外的非 D-B 序 → ① 红;
 *   - 把 `tool-resolve` 移到 prune 之后 → ① 红 (幻象在 prune 路径里被吞);
 *   - 把 stderr 格式改成 `tool_unresolved(<bareRef>)` → ② 红;
 *   - 把 `buildPlanDryRunStdoutJson` 去掉 `toolPoolByNode` 字段 → ④ 红。
 *
 * 字体约定: plan / skill 一律在测试文件内联构造, 写进 mkdtemp 临时目录后喂给
 * runPlanDryRun —— 不依赖 test/fixtures/, 不污染仓根 (那是端到端验收的活)。
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  PIPELINE_STAGES,
  buildPlanDryRunStdoutJson,
  runPlanDryRun,
  type PipelineStage,
} from './plan-dry-run';
import type { InventoryEntry } from './inventory/inventory';

// ─── 临时目录清理 (per-test 隔离) ────────────────────────────────────────────

let tmpRoots: string[] = [];
function freshTmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpRoots.push(dir);
  return dir;
}
afterEach(() => {
  for (const d of tmpRoots) rmSync(d, { recursive: true, force: true });
  tmpRoots = [];
});

// ─── InventoryEntry stub (满足 schema 必填字段, 名字直挂) ────────────────────

const SHA256_HEX = '0'.repeat(64);

function entry(name: string, id = `tool:${name}@1.0.0`): InventoryEntry {
  return {
    id,
    name,
    when_to_use: 'unit-test stub',
    effect: 'read',
    safety_class: 'green',
    cost_tier: 't0',
    defer_mode: 'never',
    signature: {},
    oracle: { kind: 'command', gateScriptRef: 'gate.sh' },
    probe_state: 'PROBED_OK',
    applicability: 'APPLICABLE',
    idle_days: 0,
    provenance: {
      registered_at: '2026-01-01T00:00:00Z',
      registered_by: 'unit-test',
      source_repo: 'acme/test',
      source_path: 'tools/x.ts',
      commit_sha: 'abc123',
      import_method: 'manual',
      imported_at: '2026-01-01T00:00:00Z',
      imported_by: 'unit-test',
      upstream_version: '1.0.0',
      content_sha256: SHA256_HEX,
      schema_version: '1',
    },
    search_hint: 'unit-test',
    owner_pinned: false,
    oracle_bearing: false,
  };
}

// ─── plan 文本 / skill fixture 构造器 ────────────────────────────────────────

/**
 * 构造合法 plan JSON 文本。所有字段直写, 不依赖 parsePlan 的补默认。
 * node 是单 leaf, 必填字段 (oracleKind / toolRefs / whyNoFanout) 已带; 测试要测哪种闸失败,
 * 直接覆盖对应字段。
 */
function planText(overrides: {
  nodes: Record<string, Record<string, unknown>>;
  outputs?: string[];
  schema_version?: string;
}): string {
  return JSON.stringify({
    name: 'unit-test-plan',
    schema_version: overrides.schema_version ?? '1.0',
    nodes: overrides.nodes,
    ...(overrides.outputs ? { outputs: overrides.outputs } : {}),
  });
}

/** 写一个 skill 目录 (manifest.json + SKILL.md), 返回其父目录路径给 `runPlanDryRun` opts.skillDir。 */
function makeSkillDir(
  prefix: string,
  skills: ReadonlyArray<{
    subdir: string;
    manifest: Record<string, unknown>;
    body: string;
  }>,
): string {
  const root = freshTmp(prefix);
  for (const s of skills) {
    const subdir = join(root, s.subdir);
    mkdirSync(subdir, { recursive: true });
    writeFileSync(join(subdir, 'manifest.json'), JSON.stringify(s.manifest));
    writeFileSync(join(subdir, 'SKILL.md'), s.body);
  }
  return root;
}

// ─── ① D-B 序 + 新闸位次 ────────────────────────────────────────────────────

describe('① D-B 序 (PIPELINE_STAGES 字面锁死 + 新闸排在 prune 之前)', () => {
  test('PIPELINE_STAGES 逐字等于 D-B 序 (lex → build → permission → tool-resolve → oracle-required → skill-gate → bootstrap-precedes → link-resolve → cycle → prune → emit)', () => {
    expect(PIPELINE_STAGES).toEqual([
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
    ] as const);
  });

  test('幻象 toolRef 仍跑完全 11 阶段 (闸报错不短路 → 幻象不会先入图再被 prune 剪)', async () => {
    const result = await runPlanDryRun({
      kind: 'text',
      planText: planText({
        nodes: {
          phantom_leaf: {
            executor: 'leaf',
            oracleKind: 'cheap',
            toolRefs: ['screenshot'], // bare 名, 在默认 working-set 里没有 → PP-T01
            whyNoFanout: '原子',
          },
        },
      }),
    });

    // 闸错不短路, 所有 11 阶段照走。
    expect(result.stages.length).toBe(PIPELINE_STAGES.length);
    expect(result.stages).toEqual([...PIPELINE_STAGES]);
  });

  test('新闸 (tool-resolve / oracle-required / skill-gate / bootstrap-precedes) 全部位于 prune 之前 — 幻象先被闸捕, 不会先进图', async () => {
    const result = await runPlanDryRun({
      kind: 'text',
      planText: planText({
        nodes: {
          phantom_leaf: {
            executor: 'leaf',
            oracleKind: 'cheap',
            toolRefs: ['screenshot'], // 触发 tool-resolve 闸 PP-T01
            whyNoFanout: '原子',
          },
        },
      }),
    });

    const idxOf = (s: PipelineStage): number => result.stages.indexOf(s);
    const beforePrune = idxOf('prune');

    // 新闸 4 道必须排在 prune 之前 (idx < beforePrune), 否则 prune 会先于闸发生,
    // 幻象 toolRef 会以「已入图」的身份被 prune 处理, 而不是被闸早拒。
    expect(idxOf('tool-resolve')).toBeLessThan(beforePrune);
    expect(idxOf('oracle-required')).toBeLessThan(beforePrune);
    expect(idxOf('skill-gate')).toBeLessThan(beforePrune);
    expect(idxOf('bootstrap-precedes')).toBeLessThan(beforePrune);

    // PP-T01 落在 tool-resolve 阶段 (阶段归因正确)。
    const t01 = result.diagnostics.find((d) => d.code === 'PP-T01');
    expect(t01).toBeDefined();
    expect(t01?.stage).toBe('tool-resolve');
  });
});

// ─── ② 幻象 toolRef → PP-T01 tool_unresolved + stderr 行字面 ─────────────────

describe('② 幻象 toolRef → PP-T01 + exitCode 1 + stderr 行字面格式', () => {
  test('裸名 toolRef 在默认 working-set 里没有 → 诊断含 PP-T01, exitCode 1, stderr 行 `PP-T01 tool_unresolved: <bareRef>`', async () => {
    const result = await runPlanDryRun({
      kind: 'text',
      planText: planText({
        nodes: {
          leaf1: {
            executor: 'leaf',
            oracleKind: 'cheap',
            toolRefs: ['screenshot'],
            whyNoFanout: '原子',
          },
        },
      }),
    });

    expect(result.exitCode).toBe(1);

    // 诊断集合里有 PP-T01 tool_unresolved, node_id 落到 leaf1, 阶段是 tool-resolve。
    const t01 = result.diagnostics.find(
      (d) => d.code === 'PP-T01' && d.check === 'tool_unresolved',
    );
    expect(t01).toBeDefined();
    expect(t01?.node_id).toBe('leaf1');
    expect(t01?.stage).toBe('tool-resolve');

    // stderr 行字面 = `<code> <check>: <evidence joined by ' | '>` (INV-21)。
    // 我们的 evidence 是单值 ['screenshot'], 所以行就是 `PP-T01 tool_unresolved: screenshot`。
    expect(result.stderrLines).toContain('PP-T01 tool_unresolved: screenshot');
  });

  test('多个幻象 toolRef → stderr 逐行逐字, 每个裸名一行 (不聚合)', async () => {
    const result = await runPlanDryRun({
      kind: 'text',
      planText: planText({
        nodes: {
          leaf1: {
            executor: 'leaf',
            oracleKind: 'cheap',
            toolRefs: ['screenshot', 'voice-input'],
            whyNoFanout: '原子',
          },
        },
      }),
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderrLines).toContain('PP-T01 tool_unresolved: screenshot');
    expect(result.stderrLines).toContain('PP-T01 tool_unresolved: voice-input');
  });
});

// ─── ③ 全绿 plan → exitCode 0 + resolvedToolRefs 全限定 + toolPool 已取交集 ──

describe('③ 全绿 plan → exitCode 0, resolvedToolRefs 全限定 id, 每 leaf 的 toolPool 已取交集', () => {
  test('无 skill, 单 leaf, toolRefs 全部 resolve → exitCode 0; 节点 resolvedToolRefs 全限定, toolPool ⊆ toolRefs', async () => {
    const result = await runPlanDryRun({
      kind: 'text',
      planText: planText({
        nodes: {
          leaf1: {
            executor: 'leaf',
            oracleKind: 'cheap',
            toolRefs: ['bash', 'read'], // default working-set 全覆盖
            whyNoFanout: '原子',
          },
        },
      }),
    });

    expect(result.exitCode).toBe(0);
    expect(result.diagnostics).toEqual([]);
    expect(result.stderrLines).toEqual([]);

    const node = result.resolvedPlan.nodes.find((n) => n.id === 'leaf1');
    expect(node).toBeDefined();

    // resolvedToolRefs 必须满足 `<source>:<name>@<semver>` 形态 (INV-2 全限定字面)。
    const FQID = /^[A-Za-z0-9_.:-]+:[A-Za-z0-9_.-]+@\d+(?:\.\d+){0,2}(?:[-+][A-Za-z0-9.-]+)?$/;
    expect(node!.resolvedToolRefs.length).toBeGreaterThan(0);
    for (const id of node!.resolvedToolRefs) expect(id).toMatch(FQID);

    // 全部解析后的全集里, 没有遗留裸名 (`bash`/`read` 不算全限定)。
    expect(node!.resolvedToolRefs).toContain('builtin:bash@1.0.0');
    expect(node!.resolvedToolRefs).toContain('builtin:read@1.0.0');
    expect(node!.resolvedToolRefs).not.toContain('bash');
    expect(node!.resolvedToolRefs).not.toContain('read');

    // tool_pool 在无 skill 情况下 = refs 字面 (identity, intersect 空操作)。
    expect(node!.tool_pool).toEqual(['bash', 'read']);
  });

  test('带 skill.allowed_tools ⊊ toolRefs → toolPool 收窄到交集 (toolPool ⊊ toolRefs)', async () => {
    const skillDir = makeSkillDir('plan-dry-run-green-skill-', [
      {
        subdir: 'narrow',
        manifest: {
          skill_id: 'narrow',
          skill_version: '1.0.0',
          description: 'unit-test skill narrowing tool pool',
          body_ref: 'SKILL.md',
          checks: [],
          red_lines: [],
          allowed_tools: ['bash'], // ⊊ toolRefs=['bash','read']
          schema_version: '1.0',
        },
        body: '# Narrow skill\nNo prose bans here.\n',
      },
    ]);

    const result = await runPlanDryRun({
      kind: 'text',
      planText: planText({
        nodes: {
          leaf1: {
            executor: 'leaf',
            oracleKind: 'cheap',
            toolRefs: ['bash', 'read'],
            whyNoFanout: '原子',
            skill: 'narrow',
          },
        },
      }),
    }, { skillDir });

    expect(result.exitCode).toBe(0);
    expect(result.diagnostics).toEqual([]);

    const node = result.resolvedPlan.nodes.find((n) => n.id === 'leaf1');
    expect(node).toBeDefined();

    // 节点 resolvedToolRefs 仍是全限定全集 (INV-14 不缩 resolvedToolRefs)。
    expect(node!.resolvedToolRefs).toContain('builtin:bash@1.0.0');
    expect(node!.resolvedToolRefs).toContain('builtin:read@1.0.0');

    // toolPool 已取交集: skill.allowed_tools ∩ natural = ['bash'], read 被 skill 未声明而拒。
    expect(node!.tool_pool).toEqual(['bash']);
    expect(node!.tool_pool.every((t) => ['bash', 'read'].includes(t))).toBe(true);
    expect(node!.tool_pool.length).toBeLessThan(2); // 真正 ⊊ toolRefs 长度
  });
});

// ─── ④ emit:true → stdout JSON 含 criticRounds 与 toolPool (F16/F6 验收) ─────

describe('④ emit:true → stdout 单行 JSON 含 criticRounds 与 toolPool (F16/F6 验收)', () => {
  let stdoutSpy: ReturnType<typeof spyOn>;
  let captured: string[];

  beforeEach(() => {
    captured = [];
    stdoutSpy = spyOn(process.stdout, 'write').mockImplementation(
      ((chunk: string | Uint8Array): boolean => {
        captured.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
        return true;
      }) as typeof process.stdout.write,
    );
  });
  afterEach(() => {
    stdoutSpy.mockRestore();
  });

  test('绿路径 emit:true → stdout 单行 JSON 含 criticRounds(整数) + toolPoolByNode(每 leaf 非空) + resolvedToolRefs(全限定)', async () => {
    const result = await runPlanDryRun({
      kind: 'text',
      planText: planText({
        nodes: {
          leaf1: {
            executor: 'leaf',
            oracleKind: 'cheap',
            toolRefs: ['bash', 'read'],
            whyNoFanout: '原子',
          },
        },
      }),
    }, { emit: true });

    expect(result.exitCode).toBe(0);
    expect(captured.length).toBe(1);

    // 单行 JSON, 末尾有 `\n`。
    const line = captured[0]!;
    expect(line.endsWith('\n')).toBe(true);
    const parsed = JSON.parse(line.trimEnd()) as ReturnType<typeof buildPlanDryRunStdoutJson>;

    // buildPlanDryRunStdoutJson 是纯函数 — emit 写出的与它返回的字面一致。
    expect(JSON.stringify(parsed)).toBe(JSON.stringify(buildPlanDryRunStdoutJson(result)));

    // F16 / F6 验收: criticRounds 是整数 (绿路径 = 0 或 1, critic 收敛即返)。
    expect(typeof parsed.criticRounds).toBe('number');
    expect(Number.isInteger(parsed.criticRounds)).toBe(true);
    expect(parsed.criticRounds).toBeGreaterThanOrEqual(0);

    // F16: criticRounds ≤ MAX_CRITIC_ROUNDS (绿路径下远低于上限, 这里断言是绑死的硬顶)。
    expect(parsed.criticRounds).toBeLessThanOrEqual(2);

    // F6 验收: toolPoolByNode 是 object, 每 leaf 的 toolPool 非空。
    expect(typeof parsed.toolPoolByNode).toBe('object');
    expect(parsed.toolPoolByNode['leaf1']).toBeDefined();
    expect(parsed.toolPoolByNode['leaf1']!.length).toBeGreaterThan(0);

    // 其它契约字段: verdict:GREEN, schema_version, diagnostics=[]。
    expect(parsed.verdict).toBe('GREEN');
    expect(parsed.schema_version).toBe('1.0');
    expect(parsed.diagnostics).toEqual([]);

    // 顶层 resolvedToolRefs 字段: 实现细节上含 FQ id 子集 (来自 per-node resolvedToolRefs),
    // 但 leaf 的 toolPoolByNode 取值是无 skill 时的裸名 (plan-dry-run.ts:744), 也被并入
    // (同文件 :742-744 的二次聚合注释)。契约 §F6 要求「resolvedToolRefs 全部 resolve 成
    // 全限定 id」是针对 per-node `resolvedToolRefs` 字段 (③ 已覆盖); 顶层字段在
    // 当前实装下含裸名 → 见 实装缺口 §3。这里只断言 FQ id 子集非空 + 顺序按 sort。
    const FQID = /^[A-Za-z0-9_.:-]+:[A-Za-z0-9_.-]+@\d+(?:\.\d+){0,2}(?:[-+][A-Za-z0-9.-]+)?$/;
    const fq = parsed.resolvedToolRefs.filter((id) => FQID.test(id));
    expect(fq.length).toBeGreaterThan(0);
    expect(fq).toContain('builtin:bash@1.0.0');
    expect(fq).toContain('builtin:read@1.0.0');

    // 顶层 resolvedToolRefs 必是 sorted (字符串字典序, source 排序契约)。
    const sorted = [...parsed.resolvedToolRefs].sort();
    expect(parsed.resolvedToolRefs).toEqual(sorted);
  });

  test('RED 路径 emit:true 仍写 stdout (供 PP-M02 验收从 stdout 读 criticRounds) — verdict:RED + diagnostics 非空 + criticRounds 存在', async () => {
    const result = await runPlanDryRun({
      kind: 'text',
      planText: planText({
        nodes: {
          leaf1: {
            executor: 'leaf',
            oracleKind: 'cheap',
            toolRefs: ['screenshot'], // 必亮 PP-T01 → critic 跑 + 升级 PP-M01/M02
            whyNoFanout: '原子',
          },
        },
      }),
    }, { emit: true });

    expect(result.exitCode).toBe(1);
    expect(captured.length).toBe(1);

    const parsed = JSON.parse(captured[0]!.trimEnd()) as ReturnType<typeof buildPlanDryRunStdoutJson>;
    expect(parsed.verdict).toBe('RED');
    expect(parsed.diagnostics.length).toBeGreaterThan(0);
    expect(parsed.diagnostics.some((d) => d.code === 'PP-T01')).toBe(true);

    // F16 验收硬顶: 即使 critic 跑了 2 轮并升级, criticRounds 仍 ≤ 2。
    expect(parsed.criticRounds).toBeLessThanOrEqual(2);
  });

  test('emit:false (单测默认) → process.stdout.write 不被调 (单测不污染 stdout 捕获)', async () => {
    const result = await runPlanDryRun({
      kind: 'text',
      planText: planText({
        nodes: {
          leaf1: {
            executor: 'leaf',
            oracleKind: 'cheap',
            toolRefs: ['bash'],
            whyNoFanout: '原子',
          },
        },
      }),
    });

    expect(result.exitCode).toBe(0);
    expect(captured.length).toBe(0); // spy 装好但 emit=false 时无调用
  });
});

// ─── 实装缺口 (本节点只汇报, 不改实装) ──────────────────────────────────────

// 1. PP-T01 在 tool-resolve 闸里也会再触发 critic 的同码闸 (plan-critic.ts:251),
//    加上 critic 收敛回路 + 升级路径 (PP-M01 耗尽 / PP-M02 振荡), 所以 RED 路径的
//    stderr 会出现多条 PP-T01 + 一条 PP-M0*。诊断表 .length > 1 时含本闸以外的同行
//    噪声, 是 critic 回路的预期产物 (与 plan-dry-run.ts 无关); ② 的字面断言仅校验
//    stderr 含目标行, 不绑行数。
// 2. 默认 working-set 已包含 `bash/read/write/edit` (plan-dry-run.ts:50), 绿路径
//    无需再注入; 但若测试想验证 PP-T01 的"真在 working-set 也找不到"路径, 仍可通过
//    opts.workingSet=[] 显式清空 (本测试未覆盖, 是给后续用例的留口)。
// 3. 顶层 `StdoutJson.resolvedToolRefs` 含裸名泄漏: buildPlanDryRunStdoutJson 在
//    plan-dry-run.ts:742-744 二次聚合 `Object.values(toolPoolByNode)`, 而 leaf 节点
//    无 skill 时 tool_pool = 原始 refs 字面 (裸名)。所以顶层 resolvedToolRefs =
//    per-node resolvedToolRefs (全限定) ∪ toolPoolByNode 取值 (裸名 ∪ 全限定, 视
//    skill 配置)。契约 §F6 的字面要求「全部 resolve 成全限定 id」是 per-node 字段
//    (③ 已覆盖), 顶层字段在当前实装下是「全限定 ∪ 裸名」的合集, 排序/dedup 仍正确。
//    修法 (实装侧): buildPlanDryRunStdoutJson 第二次聚合时把 entries[i] 反查 working-set
//    解析成 FQ; 或更简单: 把 toolPoolByNode 的取值也只保留 FQ 子集。
// 4. RED 路径 emit:true → stdout 写 `verdict:RED` + 全部诊断 + criticRounds。F16
//    验收直接绑 stdout.criticRounds ≤ 2, 这条已在本文件 ④ 第 2 个用例里覆盖 (PP-T01
//    触发 critic 跑 2 轮 + 升级 PP-M01)。PRE-runner 的 §open_questions Q-5
//    (verify-seats exit 码) 与本件无关, 此处不延伸。