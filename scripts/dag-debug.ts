#!/usr/bin/env bun
/**
 * scripts/dag-debug —— oh-my-dag 并发多假设根因调查(investigate × DAG; 派活专用)。
 *
 * 把 investigate 的根因纪律用 DAG 引擎扇成并发多假设验证: 复现拿 red(裸 shell)→ codegraph
 * 能力探测锁范围 → map 扇 N 假设(一假设一 agent verify-leaf, skeptic 证伪)→ judge 收敛根因。
 * **无根因不修 · 默认只提议不改文件 · 三振全证伪停升 owner**(SDD §3)。
 *
 * 编排走单一真理源 runDebug(src/harness/debug); 预构造 plan 直执(零 conductor LLM, 同 dag-deepen)。
 * SDD: docs/plan/2026-07-22-dag-debug.md。issue #9。
 *
 *   bun run scripts/dag-debug.ts "<失败描述>" [--repro "<复现命令>"] [--oracle-cmd "<红转绿复验>"]
 *                                [--rounds N=3] [--hypotheses K=5] [--model M] [--out path]
 *   --repro:     复现命令(裸 shell 跑, 期望 red; 省略则据症状 + 范围推断)。
 *   --oracle-cmd: 红→绿复验命令(v1 仅记录, 实装修复走 gated 模式 future)。
 *   --model:     叶模型(默认 OMD_LEAF_MODEL → deepseek:deepseek-v4-flash)。
 */
import '../src/harness/script-bootstrap';
import { runDebug } from '../src/harness/debug/run-debug';
import { runExecutorDagWithPlan } from '../src/harness/executor-dag';
import { createAgentLeafRunner } from '../src/harness/agent-leaf';
import { bootstrapModelRuntime } from '../src/model/bootstrap';
import { $ } from 'bun';
import { resolve } from 'node:path';

const USAGE =
  'usage: bun run scripts/dag-debug.ts "<失败描述>" [--repro "<cmd>"] [--oracle-cmd "<cmd>"] [--rounds N=3] [--hypotheses K=5] [--model M] [--out path]';

// ---- args ----
const BOOL = new Set(['help']);
const flags: Record<string, string> = {};
const positionals: string[] = [];
const av = process.argv.slice(2);
for (let i = 0; i < av.length; i++) {
  const a = av[i]!;
  if (a.startsWith('--')) {
    const key = a.slice(2);
    if (BOOL.has(key)) flags[key] = 'true';
    else flags[key] = av[++i] ?? '';
  } else positionals.push(a);
}
if (flags.help) {
  console.log(USAGE);
  process.exit(0);
}
function numFlag(name: string, min: number, def: number): number {
  const v = flags[name];
  if (v === undefined) return def;
  const n = Number(v);
  return Number.isFinite(n) && n >= min ? Math.floor(n) : def;
}

const failure = positionals.join(' ').trim();
if (!failure) {
  console.error(`[dag-debug] 缺失败描述。\n${USAGE}`);
  process.exit(1);
}
const rounds = numFlag('rounds', 1, 3);
const maxHypotheses = numFlag('hypotheses', 1, 5);

const repoRoot = resolve(process.cwd());
$.cwd(repoRoot);

bootstrapModelRuntime();
const model = flags.model ?? process.env.OMD_LEAF_MODEL ?? 'deepseek:deepseek-v4-flash';
process.stderr.write(`[dag-debug] leaf=${model} · rounds≤${rounds} · 假设≤${maxHypotheses} · 预构造 plan 直执\n`);

// ---- 编排走单一真理源 runDebug (裸 shell 复现/探测 + DAG 假设扇出 + 三振纪律) ----
const result = await runDebug({
  failure,
  reproCmd: flags.repro || undefined,
  cwd: repoRoot,
  maxRounds: rounds,
  maxHypotheses,
  dagConfig: {
    conductorModel: model, // 预构造路径不触 conductor; 仅类型必填
    leafModel: model,
    agentLeafModel: model,
    maxFanout: maxHypotheses,
    warmThenFanout: true,
    // verify-leaf / scope_lock 带工具读真码(goal 已钉只读纪律; 本脚本不 commit 不改码)。
    agentRunner: createAgentLeafRunner({ cwd: repoRoot }),
  },
  _runDag: runExecutorDagWithPlan,
});

// ---- 报告落盘 + terse stdout ----
const tmpDir = (process.env.TMPDIR ?? '').trim().replace(/\/+$/, '') || '/tmp';
const outPath = flags.out || `${tmpDir}/omd-debug-${process.pid}.md`;
await Bun.write(outPath, result.reportMarkdown);

if (result.status === 'root-cause') {
  console.log(`✅ 根因确认(${result.rounds} 轮)→ ${outPath}  (finding≠ground truth, 调用方终裁 · 无根因不修)`);
  console.log(result.rootCause?.split('\n').slice(0, 6).join('\n') ?? '');
} else {
  console.log(`⚠️ 三振无根因,升 owner(${result.rounds} 轮)→ ${outPath}`);
  console.log(`已排除 ${result.ruledOut.length} 组假设; 下一步: 换角度重扇 / 埋点观察 / 升 owner。`);
}
if (flags['oracle-cmd']) {
  console.log(`📐 oracle 复验命令已记录(--oracle-cmd),实装修复走 gated 模式确认红→绿(v1 未自动实装)。`);
}
