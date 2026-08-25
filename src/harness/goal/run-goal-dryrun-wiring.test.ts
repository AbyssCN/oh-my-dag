/**
 * src/harness/goal/run-goal-dryrun-wiring.test.ts ——
 * D3 sddPath 点火空跑闸 (切片 2): run-goal 平铺图编译块与 dryRunSddIgnition 同源接线 + sddPath 禁回落。
 *
 * SDD: docs/plan/2026-08-25-d3-sdd-ignition-dryrun.md
 *
 * 反向自检 (同 seam-catalog.test.ts / sdd-ignition-check.test.ts 惯例): 每条分支配**已知
 * 违规样本**, 断言它触发; 证伪方式写在各 test 注释里 —— 把闸拆掉, 该条当场绿→红, 证明
 * 它不是恒绿的纸闸。
 *
 * ★ 两条断言逐条对应的闸:
 *   ① 同源接线 (结构绊线式): 平铺图编译块的判定**走 dryRunSddIgnition**, 不在 run-goal 里
 *      另抄一份 —— 抄一份必漂, 漂的后果是「点火闸放行、worker 里照样回落」(恰是 D3 要消灭
 *      的病)。证伪: 把 dryRunSddIgnition 换回 inline parseBreakdown/compileBreakdown →
 *      本条结构绊线即红。
 *   ② sddPath + O-6 判虚 → fail-fast, 不落 v1 (INV-D3-4): 与 sdd-direct.test.ts 里「响亮
 *      回落 v1」那条**行为相反** —— INV-D3-4 owner 2026-08-25 裁: 「v1 回落是要避免的结局,
 *      不是要预告的结局」; sddPath 触发 O-6 探针判虚 (verify 实装前已绿) 时, run 终态 fail,
 *      原因含 `o6-vacuous-verify` 原文 (让 owner 改契约或换 verify 后可重跑), 而非回落 v1
 *      conductor 铺图 (那样会重写已完成的实装, 静默失效的真凶之一)。
 *
 * 闸缺席时 (本测试不在): run-goal 仍以旧 v1 回落行为跑 O-6 判虚 (非 sddPath 入口照旧, 见 SDD
 * 非目标)。本文件只钉 sddPath 入路的禁回落。
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGoal, type RunGoalConfig } from './run-goal';
import type { AcceptanceSpec, GoalClassification } from './classify-acceptance';
import type { ConductorPlan } from '../conductor-plan';
import type { ExecutorDagConfig, ExecutorDagResult } from '../dag/types';

/** 同 sdd-direct.test.ts / run-goal-o6-resume.test.ts 的合法最小 SDD (单切片零依赖无波形)。 */
const SDD_OK_FLAT = [
  '# dryrun wiring 契约',
  '## 契约 (Contracts)',
  '- G-1 占位',
  '## 分解 (Breakdown)',
  '| 切片 | 写集 | 依赖 | verify |',
  '|---|---|---|---|',
  '| 1 dryrun wiring fixture | src/a.ts + test | — | bun test src/a.test.ts |',
].join('\n');

/** 用于 O-6 vacuous fixture 的 verify 命令: 让 commandRunner 把它答成 0 (探针得 0)。 */
const VERIFY_VACUOUS = 'bun test src/a.test.ts';

const tmpSdd = (text: string): string => {
  const p = join(mkdtempSync(join(tmpdir(), 'omd-dryrun-wire-')), 'x.md');
  writeFileSync(p, text);
  return p;
};

const ACC: AcceptanceSpec = { kind: 'executable', command: 'bun test', expectExit: 0 };
const cls = async (): Promise<GoalClassification> => ({ tier: 'complex', acceptance: ACC });

describe('D3 切片 2 — ① dryRunSddIgnition 与 run-goal 平铺图编译块同源接线 (INV-D3-1)', () => {
  test('★ 结构绊线: run-goal.ts 顶部 import dryRunSddIgnition (单真源, 不另抄一份)', () => {
    // SDD INV-D3-1: 「fatal / fallback 的判定逻辑只能存在一份」。证伪: 把 import 拿掉或换回
    // 内联 parseBreakdown + compileBreakdown 各自 try/catch (抄一份的入口) → 本条当场红。
    //
    // 这里用结构绊线式的**字面量断言** (同 seam-catalog.test.ts 那条 `expect(seams).toHaveLength(8)`):
    // 改源 = 改这一行的依赖, 红得有人能拿来定位。
    const src = readFileSync(join(import.meta.dir, 'run-goal.ts'), 'utf8');
    expect(src).toMatch(/from ['"]\.\/sdd-ignition-check['"]/);
    expect(src).toMatch(/\bdryRunSddIgnition\b/);
  });

  test('★ 结构绊线: 平铺图编译块**不**再有 inline 的 `compileBreakdown(` 套 try/catch (抄一份的入口)', () => {
    // 反向自检 (2026-08-25): S1 之前 run-goal 的平铺图编译块自己 try { parseBreakdown + compileBreakdown };
    // 那正是抄一份的入口 —— 闸里闸外两份判定, 必漂。S2 之后: 编译块的 fatal/fallback 判定统一
    // 来自 `dryRunSddIgnition`; 后续 plan 装配的 try/catch 只兜 O-6 探针 (INV-D3-5: 属 run-goal
    // 领地) 与运行时异常, 不再承担 fatal/fallback 判定职责。
    //
    // 证伪: 把 dryRunSddIgnition 拿掉, 还原 `try { parseBreakdown(sdd.text); compileBreakdown(...) }`
    // 套法 → 本条结构绊线全部红 (dryRunSddIgnition 缺席 + ignition.kind != 'ok' 判缺席 +
    // bail-fail-fast 缺席)。
    const src = readFileSync(join(import.meta.dir, 'run-goal.ts'), 'utf8');
    const lines = src.split('\n');
    // 平铺图编译块 (含 O-6 探针) 的行号范围 —— 与源码同源, 改范围 = 改这条测试。
    const startLine = src.indexOf('// ── 内环 v2 切片 5');
    const endLine = src.indexOf('// ── D-1 (SDD cairness-distill)');
    expect(startLine).toBeGreaterThan(0);
    expect(endLine).toBeGreaterThan(startLine);
    const startIdx = src.indexOf('// ── 内环 v2 切片 5');
    const endIdx = src.indexOf('// ── D-1 (SDD cairness-distill)');
    const block = src.slice(startIdx, endIdx);
    // dryRunSddIgnition 必须在平铺图编译块里被调至少一次 (同源接线的最小证据)
    expect(block).toMatch(/dryRunSddIgnition\(/);
    // ignition.kind 必须判 != 'ok' (fail-fast 的**判定**来自同一份闸, 不是从 inline try/catch
    // 抓异常推出来的——那是抄一份的入口)。
    expect(block).toMatch(/ignition\.kind\s*!==?\s*['"]ok['"]/);
    // 非 ok 时必须**fail-fast**(return bail), 而不是继续往下走——否则闸就成"软提示"了。
    expect(block).toMatch(/return\s+bail\s*\(/);
    // 必须**早于** compileBreakdown 出现 (按源码行序): 闸先判, 后编译; 不许反过来。
    const ignitionPos = block.indexOf('dryRunSddIgnition(');
    const compilePos = block.indexOf('compileBreakdown(');
    expect(ignitionPos).toBeGreaterThan(-1);
    expect(compilePos).toBeGreaterThan(-1);
    expect(ignitionPos).toBeLessThan(compilePos);
  });
});

describe('D3 切片 2 — ② sddPath + O-6 探针判虚 → fail-fast (INV-D3-4, 不落 v1)', () => {
  test('★ sddPath 直通 + verify 实装前已绿 (O-6 判虚) → run 终态 fail 且原因含 o6-vacuous-verify 原文', async () => {
    // 活体样本: run 1e9e2b66 S2 verify 实装前已绿 → 回落 v1 慢铺图 → 重写已完成的实装。
    // INV-D3-4 裁: 「v1 回落是要避免的结局, 不是要预告的结局」—— sddPath 触发 O-6 判虚必须
    // fail-fast 终态, 原因原文进回执 (让 owner 改契约或换 verify 后重跑), 不再落 v1 conductor 铺图。
    //
    // fixture = SDD_OK_FLAT (合法最小, dryRunSddIgnition 应返 ok) + commandRunner 把
    // VERIFY_VACUOUS 答成 0 (探针得 0 → 已绿 → 非 resume 路径必抛 o6-vacuous-verify)。
    //
    // 既有平铺图编译块的 try/catch 会把 o6-vacuous-verify 当 fallback 落 v1 ——
    // sdd-direct.test.ts 「响亮回落 v1」那条就是这个旧行为。S2 之后该条被替换为:
    // **fail-fast 终态**, plan 不展开 (seenPlans 空), 终态 outcome=not-converged,
    // stages 里能看到 o6-vacuous-verify 原文。
    //
    // 证伪: 把 run-goal 平铺图编译块里 dryRunSddIgnition != ok 那条分支的 `return bail(...)`
    // 改成「设 flatFallback = reason; 走原 v1 回落逻辑」 → 本条 seenPlans.length 红转 1,
    // summary 红转「直通v2回落」。
    const seenPlans: ConductorPlan[] = [];
    const probed: string[] = [];
    const config: RunGoalConfig = {
      cwd: mkdtempSync(join(tmpdir(), 'omd-dryrun-wire-cwd-')),
      dag: {
        conductorModel: 'c:m',
        leafModel: 'l:m',
        commandRunner: (async ({ command }: { command: string }) => {
          probed.push(command);
          return {
            text: '',
            usage: { in: 0, out: 0 },
            timedOut: false,
            signal: null,
            // 切片 verify 答 0 (已绿) —— 非 resume 路径, 探针必抛 o6-vacuous-verify
            exitCode: command === VERIFY_VACUOUS ? 0 : 1,
          };
        }) as never,
      } as unknown as ExecutorDagConfig,
      _classify: cls,
      _runDag: (async (plan: ConductorPlan): Promise<ExecutorDagResult> => {
        seenPlans.push(plan);
        return {
          plan,
          results: {},
          sessionId: 'dryrun-wiring-test',
          levels: [],
          usage: { conductor: { in: 0, out: 0 }, leavesIn: 0, leavesOut: 0, leavesCacheHit: 0 },
          reusedNodes: [],
        };
      }) as never,
      sddPath: tmpSdd(SDD_OK_FLAT),
    };
    const r = await runGoal('dryrun wiring sddPath O-6 vacuous → fail-fast', config);

    // ① 探针真探过 (闸没被跳过 —— 这是 fail-fast 的前提, 没探就 bail 是「闸缺席」伪造失败)。
    expect(probed).toContain(VERIFY_VACUOUS);

    // ② 零 _runDag 调用: fail-fast 早于图展开, 不开 v1 conductor 铺图。
    expect(seenPlans.length).toBe(0);

    // ③ 终态 fail (sddPath 禁回落 v1 的承诺)。具体 outcome 不钉死 (后续迭代可能扩 enum),
    // 但 status 必须不是 done。
    expect(r.stages.some((s) => s.status === 'failed')).toBe(true);

    // ④ 原因原文进回执/stages —— owner 拿它改契约或换 verify。
    const allText = JSON.stringify(r);
    expect(allText).toContain('o6-vacuous-verify');
    // 不许把 o6-vacuous-verify 写成「直通v2回落」糊弄过去 (那恰是 INV-D3-4 要消灭的病)。
    expect(r.stages.some((s) => s.summary.includes('直通v2回落'))).toBe(false);
  });
});
