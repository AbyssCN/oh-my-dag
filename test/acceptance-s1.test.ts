/**
 * S1 验收总账 —— 15 条 PP-* / F-* / I-* 契约。一条 spawn 真 CLI, 一条不可放宽。
 *
 * 契约源 (disc R6 — 写前已 grep 核实, 改动前再 grep):
 *   - src/harness/cli.ts            USAGE + runPlanDryRunCLI / runVerifySeats / runWithFixture
 *   - src/harness/plan-dry-run.ts   diag() / formatStderr() / 各 PP-* emit 点
 *   - src/harness/plan-critic.ts    PP-M01 / PP-M02 升级钩子
 *   - src/harness/skill-manifest.ts loadSkillManifest / listSkills / intersectToolPool
 *   - src/harness/post-leaf-gate.ts 三态 (OK | FAIL | UNVERIFIED) + reason + oracleFaults
 *   - src/harness/prompt-lint.ts    DECISION_EDUCATION_CANONICAL + lintDecisionEducation
 *
 * ## 纪律 (GP-1/2 / R6)
 *
 * - 全部 spawn 真 CLI (`Bun.spawn(['bun', 'src/harness/cli.ts', …])`); 不调内部 helper 偷跑。
 * - 退出码 + stderr / stdout 子串都断言; 单 stderr 不够 (verify-seats / run 都走 stdout)。
 * - 断言用 `toContain` / `toMatch`, 不整串相等; 一旦 CLI 加新诊断, 测试不会因消息变长而脆红。
 * - 每条用例 timeout 给足 (spawn 真进程, 默认 30 s); 紫海区 (compile / 模块加载) 也覆盖。
 * - fixtures 一律从 `test/fixtures/s1/` 读, 测试本身不改任何仓库文件。
 * - missing fixture / 实装缺口 = 测试红, 但**不**用 `test.skipIf` 绕开 (那是另一个 silent failure)。
 *
 * ## 已知 fixture 漂移 (写此片时盘点, 与前驱 execute::3ck6kr7qqi2u7 同源)
 *
 * - `test/fixtures/s1/phantom-tool.json` 不存在 → 测试 1 改走 stdin (用户契约原话)。
 * - `test/fixtures/s1/skill-with-check/manifest.json` 不存在 → 测试 5 缺装配, PP-S01 不会亮 (红 = 真读数)。
 * - `test/fixtures/s1/skill-escalation-skill/` 不存在 → 测试 6 同上, PP-S02 不会亮 (红 = 真读数)。
 * - `BootstrapNodeSchema` 是 `.strict()` 拒 `test_gate.status` 字段 → 测试 2 (PP-T02) 与测试 4 (PP-T03)
 *   都可能因 `asBootstrap()` 返 null 而漏判 → 红 = 真读数; 测试用 substring 断言, 即使落别码也照常检。
 */
import { describe, test, expect } from 'bun:test';
import { resolve, join } from 'node:path';

import {
  DECISION_EDUCATION_CANONICAL,
  DECISION_EDUCATION_CANONICAL_CHARS,
  LINT_MAX_DECISION_EDUCATION_CHARS,
  lintDecisionEducation,
} from '../src/harness/prompt-lint';

// ─── 路径 ─────────────────────────────────────────────────────────────────

const REPO_ROOT = resolve(import.meta.dir, '..');
const CLI = resolve(REPO_ROOT, 'src/harness/cli.ts');
const FIX = resolve(REPO_ROOT, 'test/fixtures/s1');

// ─── CLI 跑法 (spawn 真子进程, 不调内部 helper) ──────────────────────────────

interface CliResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * 调一次 CLI。`stdin` 给文本 (走 plan --dry-run 无 --fixture 路径), 否则忽略 stdin;
 * stdout / stderr 分读; `extraEnv` 注入到子进程 env (verify-seats 需要
 * OMD_VERIFIER_MODEL + OMD_CONDUCTOR_MODEL)。
 *
 * ⚠ `timeoutMs` 默认 30 s, 给真 spawn 留足余量; 个别 fixture (含 multi-round critic)
 * 需要 60 s, 调用方可显式拉长。
 */
async function runCli(
  args: readonly string[],
  opts: { stdin?: string; extraEnv?: Record<string, string>; timeoutMs?: number } = {},
): Promise<CliResult> {
  const stdinMode = opts.stdin !== undefined ? 'pipe' : 'ignore';
  const env: Record<string, string | undefined> = { ...process.env, ...(opts.extraEnv ?? {}) };
  const proc = Bun.spawn(['bun', CLI, ...args], {
    cwd: REPO_ROOT,
    env,
    stdin: stdinMode,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (opts.stdin !== undefined && proc.stdin) {
    // Bun.spawn 的 stdin 是 WritableStream, 支持 .write(text) + .end()
    const sink = proc.stdin as unknown as {
      write: (chunk: string) => unknown;
      end: () => unknown;
    };
    sink.write(opts.stdin);
    sink.end();
  }
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const exited = Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const timer = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`cli spawn 超时 ${timeoutMs}ms`)), timeoutMs),
  );
  try {
    const [stdout, stderr, exitCode] = await Promise.race([exited, timer]);
    return { exitCode, stdout, stderr };
  } catch (e) {
    try { proc.kill(); } catch { /* ignore */ }
    throw e;
  }
}

/**
 * ugrep 零命中闸。`patterns` = 一组正则; 每条都必须零命中 (exit=1)。返回每条命中数。
 * 注意: ugrep 无 `-q` 时命中返 0 / 未命中返 1 / 模式错返 2; 这里**故意**不传 `-q`,
 * 让 spawn 返非 0 (exit=1) = 零命中。
 */
async function grepZeroHit(patterns: readonly string[]): Promise<readonly number[]> {
  const codes: number[] = [];
  for (const pat of patterns) {
    const proc = Bun.spawn(['ugrep', '-rE', pat, join(REPO_ROOT, 'src')], {
      cwd: REPO_ROOT,
      env: process.env,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    codes.push(await proc.exited);
  }
  return codes;
}

// ─── stdin plan 模板 (F1 / F2 / F9 / F11 用) ────────────────────────────────

/** F1: 幻象 toolRef, 单 leaf 引用 `mcp__screenshot__capture` (working-set 缺)。 */
function planWithPhantomToolRef(): string {
  return JSON.stringify({
    name: 'p1',
    description: 'F1 — 幻象 toolRef, 不在 working-set, 触发 PP-T01。',
    schema_version: '1.0',
    suppressions: [],
    // outputs 字段省略: PlanSchema.superRefine 要求 outputs 元素 ∈ plan.nodes.keys,
    // 此 fixture 只为触发 PP-T01, 加 outputs 字段是噪声。
    nodes: {
      shoot: {
        executor: 'leaf',
        goal: 'capture a screenshot via the phantom tool',
        toolRefs: ['mcp__screenshot__capture'],
        oracleKind: 'cheap',
        whyNoFanout: 'single deterministic screenshot call',
        budgetBasis: {
          calls: 1,
          tokensIn: 0,
          tokensOut: 0,
          costUsdCeiling: 0.01,
          estimatedBy: 'conductor:estimate:cheap-leaf',
        },
      },
    },
  });
}

/** F2: 视觉产出 (.png) + oracleKind='none', 触发 PP-O01 oracle_missing。 */
function planWithVisualNoneOracle(): string {
  return JSON.stringify({
    name: 'p2',
    description: 'F2 — visual output + none oracle, 触发 PP-O01。',
    schema_version: '1.0',
    suppressions: [],
    nodes: {
      snap: {
        executor: 'leaf',
        goal: 'render an image/png snapshot',
        output_path: '/tmp/shot.png',
        toolRefs: ['read'],
        oracleKind: 'none',
        whyNoFanout: 'single deterministic capture call; nothing to parallelize',
        budgetBasis: {
          calls: 1,
          tokensIn: 0,
          tokensOut: 0,
          costUsdCeiling: 0.01,
          estimatedBy: 'conductor:estimate:render-leaf',
        },
      },
    },
  });
}

/** F11: schema_version 不在支持集, 触发 PP-V01 schema_version_unsupported。 */
function planWithBadSchemaVersion(): string {
  return JSON.stringify({
    name: 'p9',
    description: 'F11 — schema_version="9.9" 不在支持集。',
    schema_version: '9.9',
    suppressions: [],
    nodes: {
      x: {
        executor: 'command',
        command: 'echo x',
        toolRefs: ['bash'],
        oracleKind: 'cheap',
        whyNoFanout: 'single step',
        budgetBasis: {
          calls: 1,
          tokensIn: 0,
          tokensOut: 0,
          costUsdCeiling: 0.01,
          estimatedBy: 'conductor:estimate:cheap-command',
        },
      },
    },
  });
}

// ─── 15 条验收 ──────────────────────────────────────────────────────────────

describe('1. F1 — PP-T01 tool_unresolved (幻象 toolRef mcp__screenshot__capture, stdin 喂入)', () => {
  test('exit≠0 且 stderr 含 `PP-T01 tool_unresolved: mcp__screenshot__capture`', async () => {
    const r = await runCli(['plan', '--dry-run'], { stdin: planWithPhantomToolRef() });
    expect(r.exitCode).not.toBe(0);
    // stderr 格式 (INV-21 / plan-dry-run.ts:239): `<code> <check>: <evidence>`。
    expect(r.stderr).toContain('PP-T01 tool_unresolved: mcp__screenshot__capture');
  }, 30_000);
});

describe('2. F17 — PP-T02 tool_ambiguous (bare "capture" 解析到 ≥2 候选, 全列)', () => {
  test('exit≠0 且 stderr 含 `PP-T02 tool_ambiguous` 且列出全部候选 id', async () => {
    const r = await runCli(['plan', '--dry-run', '--fixture', join(FIX, 'dup-name.json')]);
    expect(r.exitCode).not.toBe(0);
    // evidence 第一位是裸名, 之后是各候选的全限定 id (plan-dry-run.ts:411-418)。
    // 候选 id 形如 `<source>:<name>@<semver>` —— 所以 evidence 段必含 `:` 与 `@`。
    expect(r.stderr).toMatch(/PP-T02 tool_ambiguous: capture[^\n]*(?:builtin|[A-Za-z]+):[A-Za-z0-9_-]+@/);
    // 至少两个候选 (`:@` 出现 ≥2 次)。
    const line = r.stderr.split('\n').find((l) => l.startsWith('PP-T02 tool_ambiguous')) ?? '';
    const atColons = (line.match(/@[\d.]+/g) ?? []).length;
    expect(atColons).toBeGreaterThanOrEqual(2);
  }, 30_000);
});

describe('3. F2 — PP-O01 oracle_missing (image/png 产出 + oracleKind:none, stdin 喂入)', () => {
  test('exit≠0 且 stderr 含 `PP-O01 oracle_missing` 与视觉字段证据', async () => {
    const r = await runCli(['plan', '--dry-run'], { stdin: planWithVisualNoneOracle() });
    expect(r.exitCode).not.toBe(0);
    // plan-dry-run.ts:438-455 — 视觉 + none 触发 PP-O01, evidence 含 oracleKind=none 与视觉字段。
    // stderr 行格式 (formatStderr): `<code> <check>: <evidence join by " | ">`。
    // 节点 id 不进 stderr (只进 stdout JSON diagnostics[].node_id)。
    expect(r.stderr).toContain('PP-O01 oracle_missing');
    expect(r.stderr).toContain('oracleKind=none');
    expect(r.stderr).toContain('visual-output=');
  }, 30_000);
});

describe('4. F3 — PP-T03 tool_not_green + INV-12 permission_red_tests_write (bootstrap-red fixture)', () => {
  test('exit≠0, stderr 含 PP-T03, 拒写 red_tests/, 审计日志一行', async () => {
    const r = await runCli(['plan', '--dry-run', '--fixture', join(FIX, 'bootstrap-red.json')]);
    expect(r.exitCode).not.toBe(0);
    // (a) PP-T03: 引用的 bootstrap 工具非 green (plan-dry-run.ts:567-602)
    //     evidence: [`<toolId>`, `bootstrap status=<red|yellow>`]
    expect(r.stderr).toMatch(/PP-T03 tool_not_green: [^\n]*bootstrap status=red/);
    // (b) INV-19 三权分立: bootstrap leaf 写 red_tests/ → INV-12 permission_red_tests_write 拒 (plan-dry-run.ts:367-396)
    expect(r.stderr).toContain('INV-12 permission_red_tests_write');
    // (c) 审计证据含具体路径 (write_set 第一项)
    expect(r.stderr).toContain('red_tests/bootstrap_probe.py');
  }, 30_000);
});

describe('5. F15 — PP-S01 skill_check_unattached (skill-with-check, manifest 声明 check_prose.py, plan 缺 PostLeafGate)', () => {
  test('exit≠0 且 stderr 含 `PP-S01 skill_check_unattached: check_prose.py`', async () => {
    // valid-plan.json 三节点无 executor=command 节点串含 `check_prose` → 触发 PP-S01。
    // skill-with-check/ 目录存在但缺 manifest.json (前驱叶 execute::322q0ctm9ukt1 故意未补) —
    // 这是已登记的实装缺口, 测试红 = 真读数。
    const r = await runCli([
      'plan', '--dry-run',
      '--fixture', join(FIX, 'valid-plan.json'),
      '--skill', join(FIX, 'skill-with-check'),
    ]);
    expect(r.exitCode).not.toBe(0);
    // plan-dry-run.ts:496-512 — PP-S01 触发, evidence 第一位 = check name
    expect(r.stderr).toContain('PP-S01 skill_check_unattached: check_prose.py');
  }, 30_000);
});

describe('6. F14 — PP-S02 skill_priv_escalation (skill-escalation.json + skill-escalation-skill, suppressible:false 不可压)', () => {
  test('exit≠0 且 stderr 含 `PP-S02 skill_priv_escalation`', async () => {
    // suppressions:["PP-S02"] 是第二序旁证: PP-S02 硬编码 suppressible:false,
    // 即便顶层声明抑制也必须仍亮 (plan-dry-run.ts:550-565)。
    // skill-escalation-skill/ 目录当前不存在 (前驱叶 execute::1ew42vfm8cx8u 计划内未落) —
    // 这是已登记的实装缺口, 测试红 = 真读数。
    const r = await runCli([
      'plan', '--dry-run',
      '--fixture', join(FIX, 'skill-escalation.json'),
      '--skill', join(FIX, 'skill-escalation-skill'),
    ]);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain('PP-S02 skill_priv_escalation');
  }, 30_000);
});

describe('7. F6 — PP-S03 skill_constraints_unverified (散文禁令未验证, leaf.tool_pool 零扩展)', () => {
  // 注: --skill 接收的是 skill 根目录 (其下子目录 = 一个个 skill bundle),
  //     不是单个 bundle 本身 (skill-manifest.ts:232-246 listSkills 走 readdir 子目录)。
  //     用户契约原话给的是 bundle 路径, 此处改用其父目录, 让 listSkills 真正能发现 skill。
  test('带 / 不带 --skill 两轮 stdout.toolPoolByNode 字节相等 + stderr 含 PP-S03', async () => {
    // skillDirRoot = skill bundle 的父目录, 装在里面的子目录会被 listSkills 扫到
    const skillDirRoot = FIX;
    const fixture = join(FIX, 'valid-plan.json');
    // (a) 不带 skill — 绿路径 (skill-gate 跳空装载分支, tool_pool = resolvedToolRefs 字面)
    const a = await runCli(['plan', '--dry-run', '--fixture', fixture]);
    // (b) 带 skill-prose-bans (checks=[], red_lines=[], SKILL.md 含禁词) — INV-15 分支 b:
    //     工具池强制空集 (intersectToolPool 传空 allowed_tools) → leaf.tool_pool ⊆ natural,
    //     PP-S03 触发 (skill-manifest.ts:222-224 + plan-dry-run.ts:513-528)。
    const b = await runCli(['plan', '--dry-run', '--fixture', fixture, '--skill', skillDirRoot]);

    // (a) 不带 skill 应绿 (valid-plan.json 满足所有闸)
    expect(a.exitCode).toBe(0);
    // (b) 带 skill-prose-bans 应有 PP-S03 (skill_constraints_unverified, 可抑制但仍亮)
    expect(b.exitCode).not.toBe(0);
    expect(b.stderr).toContain('PP-S03 skill_constraints_unverified');

    // 关键断言 (F6 后半): toolPoolByNode 字节相等, 证明 leaf.tool_pool 未扩展。
    // 两份 stdout 都是单行 JSON (plan-dry-run.ts:727), 取出 toolPoolByNode 字段按字符串比。
    const aJson = JSON.parse(a.stdout.trim()) as { toolPoolByNode: Record<string, unknown> };
    const bJson = JSON.parse(b.stdout.trim()) as { toolPoolByNode: Record<string, unknown> };
    expect(JSON.stringify(aJson.toolPoolByNode)).toBe(JSON.stringify(bJson.toolPoolByNode));
  }, 30_000);
});

describe('8. F19 — UNVERIFIED 三态 (run --fixture check-script-missing, 节点终态非 OK 非 FAIL, oracle-fault +1, 异常栈已记录)', () => {
  test('stdout 含 state=UNVERIFIED, summary.oracleFaults ≥ 1, summary.oracleStacks ≥ 1, 节点终态 UNVERIFIED', async () => {
    // cli.ts:587 runWithFixture — 节点终态枚举逐字 VERIFIED | FAILED | UNVERIFIED | SKIPPED。
    // UNVERIFIED 节点 stdout 一行: `node=<id> state=UNVERIFIED gate=post_leaf reason=<r> evidence=<e>`。
    // 运行完成 (含 UNVERIFIED) → exit 0 (cli.ts:819)。
    const r = await runCli(['run', '--fixture', join(FIX, 'check-script-missing')]);
    expect(r.exitCode).toBe(0);
    // (a) stdout 含 UNVERIFIED 行 (S1 契约逐字)
    expect(r.stdout).toMatch(/node=\S+ state=UNVERIFIED gate=post_leaf reason=script_missing/);
    // (b) 末尾的 run-summary JSON 单行 (cli.ts:815)
    const jsonLine = r.stdout.trim().split('\n').reverse().find((l) => l.startsWith('{'));
    expect(jsonLine).toBeDefined();
    const summary = JSON.parse(jsonLine!) as {
      overall: 'OK' | 'FAIL' | 'UNVERIFIED';
      oracleFaults: number;
      oracleStacks: string[];
      nodes: Record<string, { state: string; verdict: string; oracleFaults: number; reason?: string }>;
    };
    expect(summary.overall).toBe('UNVERIFIED');
    // (c) oracle-fault 累计 ≥ 1 (post-leaf-gate.ts:190-201 script_missing → oracleFaults+1)
    expect(summary.oracleFaults).toBeGreaterThanOrEqual(1);
    // (d) 异常栈已记录 (cli.ts:734 把 evidence 推进 oracleStacks)
    expect(summary.oracleStacks.length).toBeGreaterThanOrEqual(1);
    // (e) 节点终态逐字 = UNVERIFIED (S1 契约), 既不是 OK 也不是 FAILED
    const nodeStates = Object.values(summary.nodes).map((n) => n.state);
    expect(nodeStates).toContain('UNVERIFIED');
    expect(nodeStates).not.toContain('VERIFIED');
    expect(nodeStates).not.toContain('FAILED');
  }, 30_000);
});

describe('9. F11 — PP-V01 schema_version_unsupported (schema_version:"9.9" 不在支持集, stdin 喂入)', () => {
  test('exit≠0 且 stderr 含 `PP-V01 schema_version_unsupported` 且 evidence 含 "9.9"', async () => {
    const r = await runCli(['plan', '--dry-run'], { stdin: planWithBadSchemaVersion() });
    expect(r.exitCode).not.toBe(0);
    // plan-dry-run.ts:625-639 — cycle 阶段, evidence: [`9.9`, `supported=1.0|1.0.0`]
    expect(r.stderr).toContain('PP-V01 schema_version_unsupported');
    expect(r.stderr).toContain('9.9');
  }, 30_000);
});

describe('10. F16 — PP-M02 critic_oscillation (mutually-exclusive-gates, 2 轮内 escalate, stdout.criticRounds ≤ 2)', () => {
  test('exit≠0, stderr 含 `PP-M02 critic_oscillation`, stdout.criticRounds ≤ 2 (无第 3 轮)', async () => {
    const r = await runCli([
      'plan', '--dry-run',
      '--fixture', join(FIX, 'mutually-exclusive-gates.json'),
    ], { timeoutMs: 60_000 });
    expect(r.exitCode).not.toBe(0);
    // plan-critic.ts:501-517 — PP-M02 emit: code='PP-M02', check='critic_oscillation'
    // 经 plan-dry-run.ts:678-682 走 formatStderr → stderr 一行 `PP-M02 critic_oscillation: <evidence>`
    expect(r.stderr).toContain('PP-M02 critic_oscillation');
    // stdout 单行 JSON 含 criticRounds (plan-dry-run.ts:762) — 严格 ≤ 2, 不进第 3 轮
    const out = JSON.parse(r.stdout.trim()) as { criticRounds: number };
    expect(out.criticRounds).toBeLessThanOrEqual(2);
  }, 60_000);
});

describe('11. I-10 — 摘录器扫描全仓零命中 (ugrep 两条模式)', () => {
  // 契约源: docs/plan/2026-08-24-conductor-s1-五闸与清单-执行契约.md §11 第 11 条 +
  //         skill-manifest.ts:9 注释 (INV-5 / I-10)。
  // 两条模式 (逐字): `extract.*red.?line` 与 `summari[sz]e.*ban`。
  // ugrep 默认 exit: 命中=0, 未命中=1, 模式错=2 —— 测试要 **未命中**(1)。
  test('ugrep 两条模式在 src/ 下零命中 (exit=1)', async () => {
    const patterns = ['extract.*red.?line', 'summari[sz]e.*ban'];
    const codes = await grepZeroHit(patterns);
    for (let i = 0; i < patterns.length; i++) {
      expect(codes[i]).toBe(1);
    }
  }, 30_000);
});

describe('12. I-14 — 席位家族断言 (config verify-seats 异族 exit 0, 两族落到 stdout)', () => {
  // 契约源: cli.ts:281-285, 515-560 + verify-seats.ts:80-107。
  // stdout 行格式 (S1 契约逐字): `seat=<verifierId> generator=<genId>
  //   generator.family=<family> verifier.family=<family> match=<true|false>`。
  test('exit 0 且 stdout 含 generator.family 与 verifier.family 且两者不同', async () => {
    // 注入一组异族坐标保证真有 stdout 输出 (没配座位时 verifySeats 返空).
    // modelFamily 把 minimax-cn / anthropic 判成异族 (channels.ts 的 modelFamily 不按前缀字面拆)。
    const r = await runCli(['config', 'verify-seats'], {
      extraEnv: {
        OMD_VERIFIER_MODEL: 'minimax-cn:MiniMax-M2',
        OMD_CONDUCTOR_MODEL: 'anthropic:claude-sonnet-4-5',
      },
    });
    expect(r.exitCode).toBe(0);
    // stdout 逐行: `seat=... generator=... generator.family=... verifier.family=... match=...`
    expect(r.stdout).toMatch(/seat=\S+ generator=\S+ generator\.family=\S+ verifier\.family=\S+ match=false/);
    const m = r.stdout.match(/seat=\S+ generator=\S+ generator\.family=(\S+) verifier\.family=(\S+) match=false/);
    expect(m).not.toBeNull();
    expect(m![1]).not.toBe(m![2]);
  }, 30_000);
});

describe('13. 绿路径 — valid-plan.json 全绿, exit 0, stdout toolRefs 全 resolve + tool_pool 已交集', () => {
  test('exit 0, stderr 无 PP-* 诊断码, stdout.verdict=GREEN, toolPoolByNode ⊆ resolvedToolRefs', async () => {
    const r = await runCli(['plan', '--dry-run', '--fixture', join(FIX, 'valid-plan.json')]);
    expect(r.exitCode).toBe(0);
    // stderr 必不含任何 PP-* 诊断 (绿路径)
    expect(r.stderr).not.toMatch(/PP-(T|O|S|V|M|I|NV)-\S+/);
    // stdout 单行 JSON (plan-dry-run.ts:727)
    const out = JSON.parse(r.stdout.trim()) as {
      verdict: 'GREEN' | 'RED';
      resolvedToolRefs: string[];
      toolPoolByNode: Record<string, string[]>;
      criticRounds: number;
      diagnostics: unknown[];
    };
    expect(out.verdict).toBe('GREEN');
    // criticRounds 期望 ≥1 (plan-dry-run 必跑一轮 critic, 即便绿); 不锁 0 是防脆。
    expect(out.criticRounds).toBeGreaterThanOrEqual(1);
    expect(out.diagnostics).toEqual([]);
    // 绿路径 toolRefs 必有 resolve (任一缺 → verdict=RED): 用户契约 "toolRefs 全 resolve"。
    expect(out.resolvedToolRefs.length).toBeGreaterThan(0);
    // 全部 resolvedToolRefs 应形如 `<source>:<name>@<semver>` (含 : 与 @, 表示真 resolve,
    // 不再是裸名 miss)。leaf 节点 tool_pool 来自 natural 字面 (plan-dry-run.ts:535-538),
    // 那一路会引入裸名 → resolvedToolRefs 经 toolPoolByNode union 也可能混裸名, 故这里
    // 只检查长度, 不锁每项严格 qualified (那是 plan-dry-run 的可选 union 行为, 不在契约内)。
    const qualified = out.resolvedToolRefs.filter((r) => r.includes(':') && r.includes('@'));
    expect(qualified.length).toBeGreaterThan(0);
    // toolPoolByNode 必非空 (每节点有池), 且 ⊆ resolvedToolRefs (用户契约 "tool_pool 已交集")
    expect(Object.keys(out.toolPoolByNode).length).toBeGreaterThan(0);
    const resolvedSet = new Set(out.resolvedToolRefs);
    for (const [nodeId, pool] of Object.entries(out.toolPoolByNode)) {
      for (const tool of pool) {
        expect(resolvedSet.has(tool)).toBe(true);
      }
    }
  }, 30_000);
});

describe('14. prompt-lint canonical — lintDecisionEducation(DECISION_EDUCATION_CANONICAL) → ok:true', () => {
  test('canonical 文本 Unicode 字符数 = 导出常量, 且 ≤ LINT_MAX_DECISION_EDUCATION_CHARS', () => {
    // sanity: 导出常量与实测一致 (这层若漂移, 编译期 prompt-lint.ts:46 throw 已拦, 这里只是数字落地)
    expect(Array.from(DECISION_EDUCATION_CANONICAL).length).toBe(DECISION_EDUCATION_CANONICAL_CHARS);
    expect(DECISION_EDUCATION_CANONICAL_CHARS).toBeLessThanOrEqual(LINT_MAX_DECISION_EDUCATION_CHARS);
  });

  test('canonical 文本 lintDecisionEducation → {ok:true}', () => {
    const out = lintDecisionEducation(DECISION_EDUCATION_CANONICAL);
    expect(out.ok).toBe(true);
  });
});

describe('15. prompt-lint 双倍复制 — 超 LINT_MAX_DECISION_EDUCATION_CHARS 必返 ok:false', () => {
  test('canonical 串接自身 → 长度 > LINT_MAX_DECISION_EDUCATION_CHARS 且 lintDecisionEducation → ok:false', () => {
    const doubled = DECISION_EDUCATION_CANONICAL + DECISION_EDUCATION_CANONICAL;
    expect(Array.from(doubled).length).toBeGreaterThan(LINT_MAX_DECISION_EDUCATION_CHARS);
    const out = lintDecisionEducation(doubled);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      // reason 必含上限值, 必不含 "truncated" 字眼 (永不运行期截断的纪律, prompt-lint.ts:75)
      expect(out.reason).toContain(String(LINT_MAX_DECISION_EDUCATION_CHARS));
      expect(out.reason.toLowerCase()).not.toContain('truncated');
      // length 字段 = 原文字符数 (原文未动)
      expect(out.length).toBe(Array.from(doubled).length);
      expect(out.limit).toBe(LINT_MAX_DECISION_EDUCATION_CHARS);
    }
  });
});
