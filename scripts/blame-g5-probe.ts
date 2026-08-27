#!/usr/bin/env bun
/**
 * 切片 G-5 反向自检 (SDD 2026-08-10-blame-scoped-node-retry, G-5): 构造「只有草稿错、勘察正确」
 * 的已知样本 —— 若勘察节点发生重跑 → 闸红; 并执行 G-1/G-2/G-4 的可执行判:
 *   G-1 被责备节点 (draft) 重跑、闭包外节点 100% 指纹复用 (台账 reuseHits 可读);
 *   G-2 打回反馈文本只出现在 draft 的重跑 prompt 里, 勘察/调研节点 prompt 与基线逐字节相同;
 *   G-4 draft 在毒集内 → 不得被复用 (即使轮 2 补丁与轮 1 逐字节相同);
 *   G-5 勘察节点 survey 必须被复用 (∈ reusedNodes) 且只跑过一次 —— 重跑即闸红。
 *
 * 走真实引擎路径: runExecutorDagWithPlan (预构造 plan → executePlan 直执) + fake generate/verifier
 * (沙箱无 provider key, 不能真打 LLM)。唯一 harness 参数: HARNESS_LEAF_DELAY_MS = 每 leaf 固定 10ms
 * 模拟延迟 (两端同参, 只让墙钟可读; 比值由引擎调度结构决定, 非换算)。
 *
 * 图 (10 节点): survey → survey2 → survey3 → survey4 (勘察链, **全部正确**) → draft (错, 被点名)
 *   → polish → report; research (独立根) · audit1 → audit2 (独立分支)。7 层 —— 闭包
 *   {draft, polish, report} 深度 3 层 / 基线 7 层 → 重跑墙钟比预期 ≈ 0.5 (比值按调度深度,
 *   不是节点数; 层数不够深比值会被固定开销顶破 0.6 闸 —— 本图 7 层为闸留了余量)。
 * 两场景:
 *   A 打回带 ```blame 围栏点名 draft, 轮 2 补丁 = draft 逐字节相同 → 闭包 {draft,polish,report}
 *     重跑, 闭包外 7 节点走 D-21 指纹复用 (零 LLM);
 *   D 整轮基线 (无 verifier) → 10 节点全跑, 墙钟 = 本环境「整轮」。
 *
 * ★ prompt 逐字节判定的成立条件: A8 信任围栏 (fenceUntrusted) 的 runNonce 是每次 executePlan
 * 现生成的, 带上游的节点 prompt 跨调用必然差一个 nonce → 根节点 (无上游) 做**字面**逐字节比较;
 * 带上游节点做**抹 nonce 后**逐字节比较 (normalizeNonce —— 除安全 nonce 外零差异, 这是
 * 唯一允许的归一化, 其余字节必须原样相等)。A 轮 2 对复用节点根本不重建 prompt (零 LLM) ——
 * 逐字节同的最强可执行形式 = A 轮 1 实跑 prompt 与 D 基线实跑 prompt 比较 + 该节点 ∈ reusedNodes。
 *
 * 输出: 断言表 + JSON (blameSize / closureSize / reuseHits / 整轮基线墙钟 / 重跑墙钟 / 比值)。
 * 退出码: 任一断言失败或比值 > 0.6 → 1。
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

const plan = (nodes: ConductorPlan['nodes']): ConductorPlan => ({ name: 'g5-blame-graph', nodes });

// ── 图: 勘察链 survey→survey4 (全部正确, 无依赖根 survey 的 prompt 无 A8 围栏 → 可字面逐字节
//    比较) → draft (唯一错) → 下游; 独立 research / audit 分支 (闭包外, 必须复用) ──
const G5_NODES: ConductorPlan['nodes'] = {
  survey: { goal: '勘察仓内事实与用户反馈, 输出勘察结论供草稿引用' },
  survey2: { goal: '整理勘察原始记录', depends_on: ['survey'] },
  survey3: { goal: '交叉核对数据口径', depends_on: ['survey2'] },
  survey4: { goal: '汇总结论供草稿引用', depends_on: ['survey3'] },
  research: { goal: '调研竞品基线' },
  audit1: { goal: '核对历史口径' },
  audit2: { goal: '产出口径说明', depends_on: ['audit1'] },
  draft: { goal: '草稿', depends_on: ['survey4'] },
  polish: { goal: '打磨', depends_on: ['draft'] },
  report: { goal: '终稿', depends_on: ['polish'] },
};
const G5_TOTAL = Object.keys(G5_NODES).length; // 10
/** 闭包外节点 (G-1/G-2 判定面): 必须 100% 指纹复用、prompt 与基线逐字节相同 (根节点字面, 带上游抹 nonce)。 */
const NON_CLOSURE = ['survey', 'survey2', 'survey3', 'survey4', 'research', 'audit1', 'audit2'];
/** 闭包节点 (G-1/G-2 判定面): 必须重跑。 */
const CLOSURE = ['draft', 'polish', 'report'];
const DRAFT_REASON = '草稿验收段判卷命令不合格';
const BLAME_FENCE_DRAFT =
  `草稿段验收不合格。\n\`\`\`blame\n[{"node": "draft", "reason": "${DRAFT_REASON}"}]\n\`\`\`\n`;
/** D-3 反馈锚 (engine.ts 冻结格式): 只允许出现在 draft 的轮 2 prompt 里。 */
const ANCHOR_MARK = `[verifier 打回 · 第 1 轮]`;

/**
 * 抹掉 A8 信任围栏里每次 executePlan 现生成的 runNonce (8 位十六进制)。
 * 只归一化围栏标记本身 —— 这是跨 executePlan 调用 prompt 的唯一允许差异; 其余字节必须原样相等。
 */
const normalizeNonce = (prompt: string): string =>
  prompt
    .replace(/(<untrusted src="[^"]+" )[0-9a-f]{8}(>)/g, '$1NONCE$2')
    .replace(/(<\/untrusted )[0-9a-f]{8}(>)/g, '$1NONCE$2');

/** fake generate: REPLAN-PATCH → 轮 2 补丁; leaf 按 id 记调用序 + prompt 全文 (跨轮/跨场景字节比较用)。 */
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

/** verifier: 首轮 fail (reason 带责备围栏) → 次轮 pass。 */
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

/** 轮 2 补丁: draft 与轮 1 逐字节相同 (G-4 的关键: 指纹未变也因毒集不得复用; 未补丁节点由 S3.6 原样保留)。 */
const SAME_DRAFT_PATCH = { draft: { goal: '草稿', depends_on: ['survey4'] } };

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
  /** 节点 id → 按调用序的 prompt 全文 (轮 1 = [0], 轮 2 = [1]; 复用节点只有 [0])。 */
  prompts: Record<string, string[]>;
};

async function runScenario(
  scenario: string,
  round2Patch: Record<string, unknown>,
  verifier: NonNullable<ExecutorDagConfig['verifier']> | undefined,
  label: string,
): Promise<Reading> {
  const { generate, calls, promptLog } = makeGenerate(round2Patch);
  const t0 = performance.now();
  const r: ExecutorDagResult = await runExecutorDagWithPlan(plan(G5_NODES), escConfig(generate, verifier));
  const wallMs = performance.now() - t0;
  const counts: Record<string, number> = {};
  for (const c of calls) counts[c] = (counts[c] ?? 0) + 1;
  const prompts: Record<string, string[]> = {};
  for (const p of promptLog) (prompts[p.id] ??= []).push(p.prompt);
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
    prompts,
  };
}

async function main() {
  registerProvider('blamex', { baseUrl: 'http://127.0.0.1:9', apiKey: 'test-key', api: 'openai-compatible' });

  const A = await runScenario('A', SAME_DRAFT_PATCH, makeVerifier(BLAME_FENCE_DRAFT), 'A 仅草稿错 (blame 围栏点名 draft)');
  const D = await runScenario('D', {}, undefined, 'D 整轮基线 (无打回)');

  const ratio = A.rerunWallMs / D.wallMs;

  // ── 断言 (G-1/G-2/G-4/G-5) ────────────────────────────────────────────────
  const asserts: Array<{ name: string; pass: boolean; detail: string }> = [];
  const ok = (name: string, pass: boolean, detail: string) => asserts.push({ name, pass, detail });

  // G-1: 被责备节点及其下游闭包重跑, 闭包外 100% 复用。
  ok(
    'G-1 闭包节点全部重跑 (callCount=2)',
    CLOSURE.every((id) => (A.callCounts[id] ?? 0) === 2),
    `calls ${CLOSURE.map((id) => `${id}=${A.callCounts[id] ?? 0}`).join(' ')}`,
  );
  ok(
    'G-1 闭包外节点全部复用 (callCount=1 且 ∈ reusedNodes)',
    NON_CLOSURE.every((id) => (A.callCounts[id] ?? 0) === 1 && A.reusedNodes.includes(id)),
    `calls ${NON_CLOSURE.map((id) => `${id}=${A.callCounts[id] ?? 0}`).join(' ')}; reusedNodes=[${A.reusedNodes.join(',')}]`,
  );
  ok('G-1 台账 reuseHits = 闭包外节点数', A.reuseHits === NON_CLOSURE.length, `reuseHits=${A.reuseHits}, 期望 ${NON_CLOSURE.length}`);

  // G-2: 打回反馈只出现在 draft 的轮 2 prompt; 其余节点 (含勘察) prompt 逐字节相同。
  const draftP1 = A.prompts.draft?.[0] ?? '';
  const draftP2 = A.prompts.draft?.[1] ?? '';
  ok(
    'G-2 反馈只进 draft 的轮 2 prompt',
    draftP2.includes(ANCHOR_MARK) && draftP2.includes(DRAFT_REASON) && !draftP1.includes(ANCHOR_MARK) &&
      Object.entries(A.prompts).every(([id, ps]) => id === 'draft' || ps.every((p) => !p.includes(ANCHOR_MARK))),
    `draft 轮2 含锚=${draftP2.includes(ANCHOR_MARK)}, 轮1 含锚=${draftP1.includes(ANCHOR_MARK)}`,
  );
  ok(
    'G-2 勘察/调研节点 prompt 与整轮基线逐字节相同',
    NON_CLOSURE.every((id) => normalizeNonce(A.prompts[id]?.[0] ?? '') === normalizeNonce(D.prompts[id]?.[0] ?? '')),
    NON_CLOSURE.map((id) => `${id}:${normalizeNonce(A.prompts[id]?.[0] ?? '') === normalizeNonce(D.prompts[id]?.[0] ?? '') ? '同' : '异'}`).join(' '),
  );
  ok(
    'G-2 草稿节点 prompt 轮间确实变化 (锚生效)',
    draftP2 !== draftP1,
    `轮2 长度=${draftP2.length}, 轮1 长度=${draftP1.length}`,
  );

  // G-4: blame 节点在毒集内 → 即使补丁逐字节相同也不得复用。
  ok(
    'G-4 draft/polish/report 不在 reusedNodes (毒集生效)',
    CLOSURE.every((id) => !A.reusedNodes.includes(id)),
    `reusedNodes=[${A.reusedNodes.join(',')}]`,
  );

  // G-5 反向自检: 勘察节点 survey 必须复用 (只跑过一次, 零轮 2 调用) —— 重跑即闸红。
  ok(
    'G-5 勘察节点 survey 复用且只跑一次 (重跑即闸红)',
    A.reusedNodes.includes('survey') && (A.callCounts.survey ?? 0) === 1,
    `survey calls=${A.callCounts.survey ?? 0}, ∈reusedNodes=${A.reusedNodes.includes('survey')}`,
  );

  // 比值闸: 重跑墙钟 / 整轮基线 ≤ 0.6。
  ok('比值闸 重跑墙钟/整轮 ≤ 0.6', ratio <= 0.6, `${A.rerunWallMs}ms/${D.wallMs}ms=${ratio.toFixed(3)}`);

  const allPass = asserts.every((a) => a.pass) && A.verifierPass;

  // ── 输出: 断言表 + 机器可读 JSON ──────────────────────────────────────────
  console.log(`G-5 反向自检 (图 ${G5_TOTAL} 节点 / 闭包 ${CLOSURE.length}, harness 每 leaf 延迟 ${HARNESS_LEAF_DELAY_MS}ms)`);
  console.log('┌──────────────────────────────────────────┬──────┬──────────────────────────────────────────┐');
  console.log('│ 断言                                      │ 结果 │ 详情                                     │');
  console.log('├──────────────────────────────────────────┼──────┼──────────────────────────────────────────┤');
  for (const a of asserts) {
    console.log(
      `│ ${a.name.padEnd(40)} │ ${a.pass ? 'PASS' : 'FAIL'} │ ${a.detail.slice(0, 40).padEnd(40)} │`,
    );
  }
  console.log('└──────────────────────────────────────────┴──────┴──────────────────────────────────────────┘');
  console.log(`退出: ${allPass ? '0 (全部断言成立 + 比值 ≤ 0.6)' : '1 (有断言失败或比值超闸)'}`);

  console.log('\nJSON:');
  console.log(
    JSON.stringify(
      {
        graph: { total: G5_TOTAL, closure: CLOSURE, nonClosure: NON_CLOSURE },
        retry: {
          blameSize: A.blameSize,
          closureSize: A.closureSize,
          reuseHits: A.reuseHits,
          rerunWallMs: A.rerunWallMs,
          verifierPass: A.verifierPass,
        },
        baseline: { fullRoundWallMs: D.wallMs, leafCalls: D.leafCalls },
        ratio: { retryOverFullRound: Math.round(ratio * 1000) / 1000, gate: 0.6 },
        assertions: asserts.map((a) => ({ name: a.name, pass: a.pass, detail: a.detail })),
        reusedNodes: A.reusedNodes,
        callCounts: A.callCounts,
        allPass,
      },
      null,
      2,
    ),
  );

  process.exit(allPass ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
