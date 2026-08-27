#!/usr/bin/env bun
/**
 * 切片5 G-6 真跑验证 (2026-08-10): 带责备集的打回场景实测 —— 重跑墙钟 / 闭包占比 / 复用命中数。
 *
 * 走真实引擎路径: runExecutorDagWithPlan (预构造 plan → executePlan 直执, 与 G-21/blame 测试同一
 * 接缝) + fake generate/verifier (沙箱无 provider key, 不能真打 LLM —— 缩尺场景, 见报告"与全尺基线
 * 的差距"节)。唯一 harness 参数: HARNESS_LEAF_DELAY_MS = 每 leaf 固定 10ms 模拟延迟 (两端同参,
 * 只让墙钟可读; 比值由引擎调度结构决定, 非换算)。
 *
 * 图 (11 节点, SDD 词汇加长): survey1→survey2→survey3→survey4 ─┐
 *   research1→research2 · audit1→audit2 (独立分支)           ├→ draft(错) → polish → report
 * 7 层。四场景:
 *   A 不塌: 判词带 ```blame 围栏点名 draft → 闭包 {draft,polish,report} = 3/11, 闭包外 8 节点 100% 复用
 *   B fail-open: 散文打回 (INV-1) + 逐字节相同补丁 → 无闭包语义, 全图 11 节点 D-21 复用
 *   C 塌 (O-1 机理的引擎层复演): 散文打回 + 反馈 append 到共享祖先 survey1 (旧路径形态) →
 *     祖先子树指纹传递打翻 → 7 节点重跑, 仅 4 复用 ≈ 整轮代价
 *   D 整轮基线 (harness 尺): verifier 首轮即过 → 11 节点全跑, 墙钟 = 本环境"整轮"
 *
 * 输出: 表 + JSON。不修改 src/**。
 */
import { registerProvider } from '../src/model/providers';
import { runExecutorDagWithPlan } from '../src/harness/dag/engine';
import type { ConductorPlan } from '../src/harness/conductor-plan';
import type { ExecutorDagConfig, GenerateFn, ExecutorDagResult } from '../src/harness/dag/types';

const HARNESS_LEAF_DELAY_MS = 10;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const contentText = (c: unknown): string =>
  typeof c === 'string'
    ? (c ?? '')
    : Array.isArray(c)
      ? (c as Array<{ type?: string; text?: string }>)
          .map((p) => (p.type === 'text' ? p.text ?? '' : ''))
          .join('\n')
      : '';
/** 从 buildLeafPrompt 产出的 user prompt 里解析节点 id (`[omd leaf: <id>]` 行)。 */
const leafId = (prompt: string): string => /\[omd leaf: ([^\]]+)\]/.exec(prompt)?.[1] ?? '?';

const plan = (nodes: ConductorPlan['nodes']): ConductorPlan => ({ name: 'g6-blame-graph', nodes });

// ── 图: survey 链 (勘察根 → 4 层) + 独立 research/audit 分支 + 被责备 draft 及其下游 ──
const G6_NODES: ConductorPlan['nodes'] = {
  survey1: { goal: '勘察仓内事实与用户反馈' },
  survey2: { goal: '整理勘察原始记录', depends_on: ['survey1'] },
  survey3: { goal: '交叉核对数据口径', depends_on: ['survey2'] },
  survey4: { goal: '汇总结论供草稿引用', depends_on: ['survey3'] },
  research1: { goal: '调研竞品基线' },
  research2: { goal: '产出调研摘要', depends_on: ['research1'] },
  audit1: { goal: '核对历史口径' },
  audit2: { goal: '产出口径说明', depends_on: ['audit1'] },
  draft: { goal: '草稿', depends_on: ['survey4'] },
  polish: { goal: '打磨', depends_on: ['draft'] },
  report: { goal: '终稿', depends_on: ['polish'] },
};
const G6_TOTAL = Object.keys(G6_NODES).length; // 11

const BLAME_FENCE_DRAFT =
  '草稿段验收不合格。\n```blame\n[{"node": "draft", "reason": "草稿验收段判卷命令不合格"}]\n```\n';
const PROSE = '草稿输出不合格 (纯散文, 不指认节点)。';
const ANCESTOR_FEEDBACK = '\n\n---\n[verifier 反馈] 用户明说主因是价格, 请重点核实价格敏感度。';

/** fake generate: REPLAN-PATCH → 轮 2 补丁; leaf 按 id 记调用序 + prompt 全文。 */
function makeGenerate(round2Patch: Record<string, unknown>) {
  const calls: string[] = [];
  const promptLog: Array<{ id: string; prompt: string }> = [];
  const generate: GenerateFn = async (req) => {
    const sysC = req.messages.find((m) => m.role === 'system')?.content;
    const sys = typeof sysC === 'string' ? sysC : '';
    if (sys.includes('REPLAN-PATCH')) {
      return { text: JSON.stringify({ patch: round2Patch }), usage: { in: 5, out: 5 } };
    }
    const prompt = contentText(req.messages.find((m) => m.role === 'user')?.content);
    const id = leafId(prompt);
    calls.push(id);
    promptLog.push({ id, prompt });
    await sleep(HARNESS_LEAF_DELAY_MS);
    return { text: `out:${id}`, usage: { in: 1, out: 1 } };
  };
  return { generate, calls, promptLog };
}

/** verifier: 首轮 fail (reason 可带责备围栏) → 次轮 pass。 */
const makeVerifier = (reason: string): NonNullable<ExecutorDagConfig['verifier']> => {
  let n = 0;
  return async () => {
    n++;
    return n === 1
      ? { pass: false, reason, usage: { in: 1, out: 1 } }
      : { pass: true, reason: 'ok', usage: { in: 1, out: 1 } };
  };
};

const escConfig = (generate: GenerateFn, verifier?: NonNullable<ExecutorDagConfig['verifier']>): ExecutorDagConfig => ({
  conductorModel: 'test:conductor',
  leafModel: 'test:leaf',
  generate,
  agentTemplates: new Map(),
  ...(verifier ? { verifier, conductorEscalationModel: 'blamex:strong' } : {}),
});

/** 轮 2 补丁: draft 与轮 1 逐字节相同 (未补丁节点由 S3.6 原样保留 → 指纹复用)。 */
const SAME_DRAFT_PATCH = { draft: { goal: '草稿', depends_on: ['survey4'] } };
/** 塌场景补丁: 反馈 append 到共享祖先 survey1 (旧路径形态, 即 O-1 的 A.goal 变化)。 */
const ANCESTOR_PATCH = { survey1: { goal: '勘察仓内事实与用户反馈' + ANCESTOR_FEEDBACK, depends_on: [] } };

type Reading = {
  scenario: string;
  wallMs: number;
  leafCalls: number;
  callCounts: Record<string, number>;
  reusedNodes: string[];
  blameSize: number;
  closureSize: number;
  reuseHits: number;
  rerunWallMs: number;
  verifierPass: boolean;
};

async function runScenario(
  scenario: string,
  round2Patch: Record<string, unknown>,
  verifier: NonNullable<ExecutorDagConfig['verifier']> | undefined,
  label: string,
): Promise<Reading> {
  const { generate, calls } = makeGenerate(round2Patch);
  const t0 = performance.now();
  const r = await runExecutorDagWithPlan(plan(G6_NODES), escConfig(generate, verifier));
  const wallMs = performance.now() - t0;
  const counts: Record<string, number> = {};
  for (const c of calls) counts[c] = (counts[c] ?? 0) + 1;
  return {
    scenario: label,
    wallMs: Math.round(wallMs * 10) / 10,
    leafCalls: calls.length,
    callCounts: counts,
    reusedNodes: [...(r.reusedNodes ?? [])].sort(),
    blameSize: r.blameRetry?.blameSize ?? -1,
    closureSize: r.blameRetry?.closureSize ?? -1,
    reuseHits: r.blameRetry?.reuseHits ?? -1,
    rerunWallMs: r.blameRetry?.rerunWallMs ?? -1,
    verifierPass: r.verification?.pass ?? false,
  };
}

async function main() {
  registerProvider('blamex', { baseUrl: 'http://127.0.0.1:9', apiKey: 'test-key', api: 'openai-compatible' });

  const A = await runScenario('A', SAME_DRAFT_PATCH, makeVerifier(BLAME_FENCE_DRAFT), 'A 不塌 (blame 围栏点名 draft)');
  const B = await runScenario('B', SAME_DRAFT_PATCH, makeVerifier(PROSE), 'B fail-open (散文打回, INV-1)');
  const C = await runScenario('C', ANCESTOR_PATCH, makeVerifier(PROSE), 'C 塌 (O-1 祖先翻转, 旧路径复演)');
  const D = await runScenario('D', {}, undefined, 'D 整轮基线 (harness 尺, 无打回)');

  const closureRatio = A.closureSize / G6_TOTAL;
  const wallRatioA = A.rerunWallMs / D.wallMs;
  const wallRatioC = C.rerunWallMs / D.wallMs;
  const callRatioA = (A.leafCalls - D.leafCalls) / D.leafCalls;

  const lines: string[] = [];
  lines.push(`G-6 实测 (图 ${G6_TOTAL} 节点 / 7 层, harness 每 leaf 延迟 ${HARNESS_LEAF_DELAY_MS}ms)`);
  lines.push('┌────────────┬──────────┬───────────┬────────────┬──────────────┬──────────────┐');
  lines.push('│ 场景        │ 墙钟(ms) │ leaf 调用 │ blameSize  │ closureSize  │ reuseHits    │');
  lines.push('├────────────┼──────────┼───────────┼────────────┼──────────────┼──────────────┤');
  const row = (r: Reading) =>
    `│ ${r.scenario.padEnd(10)} │ ${String(r.wallMs).padStart(8)} │ ${String(r.leafCalls).padStart(9)} │ ${String(r.blameSize).padStart(10)} │ ${String(r.closureSize).padStart(12)} │ ${String(r.reuseHits).padStart(12)} │`;
  lines.push(row(A));
  lines.push(row(B));
  lines.push(row(C));
  lines.push(row(D));
  lines.push('└────────────┴──────────┴───────────┴────────────┴──────────────┴──────────────┘');
  lines.push('');
  lines.push(`关键比值 (同 harness 同延迟, 非换算):`);
  lines.push(`  A 闭包占比        = ${A.closureSize}/${G6_TOTAL} = ${(closureRatio * 100).toFixed(1)}%`);
  lines.push(`  A 重跑墙钟/整轮   = ${A.rerunWallMs}ms / ${D.wallMs}ms = ${(wallRatioA * 100).toFixed(1)}%  (G-6 判据 ≤60%)`);
  lines.push(`  C 重跑墙钟/整轮   = ${C.rerunWallMs}ms / ${D.wallMs}ms = ${(wallRatioC * 100).toFixed(1)}%  (塌: ≈整轮)`);
  lines.push(`  A 重跑 LLM 调用  = ${A.leafCalls - D.leafCalls} 次增量 / ${D.leafCalls} 次整轮 = ${(callRatioA * 100).toFixed(1)}%`);
  lines.push(`  A 复用命中        = ${A.reuseHits} (闭包外 ${G6_TOTAL - A.closureSize} 节点全部命中)`);
  lines.push(`  C 复用命中        = ${C.reuseHits} (祖先翻转后只剩独立分支)`);
  lines.push(`  B (INV-1) 复用    = ${B.reuseHits} / ${G6_TOTAL} (无闭包语义, 纯 D-21 指纹)`);
  lines.push('');
  lines.push('每场景调用序 (按节点):');
  for (const r of [A, B, C, D]) {
    lines.push(`  ${r.scenario.padEnd(32)} ${Object.entries(r.callCounts).map(([k, v]) => `${k}=${v}`).join(' ')}`);
  }
  lines.push(`  A reusedNodes = [${A.reusedNodes.join(', ')}]`);
  lines.push(`  C reusedNodes = [${C.reusedNodes.join(', ')}]`);
  console.log(lines.join('\n'));

  console.log('\nJSON:');
  console.log(
    JSON.stringify(
      { A, B, C, D, G6_TOTAL, closureRatio, wallRatioA, wallRatioC, callRatioA },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
