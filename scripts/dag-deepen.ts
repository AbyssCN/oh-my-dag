#!/usr/bin/env bun
/**
 * scripts/dag-deepen —— oh-my-dag 架构加深候选扫描 (Matt Pocock improve-codebase-architecture
 * 的引擎化: fleet 并发扫描, 非单 agent 巡游)。
 *
 * 管线: ① 热点发现 (确定性零 LLM: git log 触碰频率 → 目录聚簇 top K; 或用户点名 scope) →
 * ② 预构造 plan (每热点 1 个 agent 扫描叶 + synthesis 依赖全部) 经 runExecutorDagWithPlan
 * **跳过 conductor LLM** 直执 (D-7 预构造入口 dogfood — 图形状代码定, 不劳模型规划) →
 * ③ synthesis 跨热点去重 (N 处手搓同逻辑 = 1 个 shared-util 候选, 全局赢面) + leverage 排名 →
 * ④ HTML 报告 (Tailwind+Mermaid CDN, 一卡一候选) 落 $TMPDIR + terse stdout。
 *
 * 词汇 = review/design-vocab DESIGN_VOCAB (shallow module / deletion test / leverage / locality,
 * 与 dag-slim / codebase-design 同源不漂移)。扫描叶只读探查 — 本脚本**永不改码、永不自动 PR**;
 * 候选是 /grill 的输入, 不是结论。
 *
 *   bun run scripts/dag-deepen.ts [<scope-path>] [--commits N=200] [--hotspots K=6]
 *                                 [--model M] [--out path]
 *   <scope-path> 点名方向 (如 "src/harness/plan") → 只扫它, 跳过全仓热点排名。
 *   --model: 叶模型 (默认 OMD_LEAF_MODEL → deepseek:deepseek-v4-flash)。
 */
import '../src/harness/script-bootstrap';
import { computeHotspots } from '../src/harness/arch/hotspots';
import { buildDeepenPlan, SYNTH_NODE_ID } from '../src/harness/arch/deepen-plan';
import { renderDeepenReport } from '../src/harness/arch/deepen-report';
import { runExecutorDagWithPlan } from '../src/harness/executor-dag';
import { createAgentLeafRunner } from '../src/harness/agent-leaf';
import { bootstrapModelRuntime } from '../src/model/bootstrap';
import { $ } from 'bun';
import { resolve } from 'node:path';

const USAGE =
  'usage: bun run scripts/dag-deepen.ts [<scope-path>] [--commits N=200] [--hotspots K=6] [--model M] [--out path]';

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

/** 数字旗标校验: 缺省→默认; 非整数或 <min→报错退出 (防 NaN 透传, 同 dag-research)。 */
function numFlag(name: string, min: number, dflt: number): number {
  const v = flags[name];
  if (v === undefined || v === '') return dflt;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min) {
    console.error(`[dag-deepen] --${name} 需 >=${min} 的整数 (得到 "${v}")`);
    process.exit(1);
  }
  return n;
}
const commits = numFlag('commits', 1, 200);
const topK = numFlag('hotspots', 1, 6);
const scope = positionals.join(' ').trim().replace(/\/+$/, '') || undefined;

// ---- ① 热点发现 (确定性, 零 LLM) ----
const repoRoot = resolve(process.cwd());
$.cwd(repoRoot);
const gitLog = await $`git log --oneline --name-only -n ${commits}`.nothrow().text();
if (!gitLog.trim()) {
  console.error('[dag-deepen] git log 为空 (不是 git 仓库, 或零 commit)。热点发现无从谈起。');
  process.exit(1);
}
const hotspots = computeHotspots(gitLog, { topK, scope });
if (hotspots.length === 0) {
  console.error(`[dag-deepen] 近 ${commits} commit 无代码文件触碰记录 → 无热点可扫。试加大 --commits。`);
  process.exit(1);
}
process.stderr.write(`[dag-deepen] 热点 ${hotspots.length} 个 (近 ${commits} commit${scope ? ` · scope=${scope}` : ''}):\n`);
for (const h of hotspots) process.stderr.write(`  - ${h.dir} (触碰 ${h.touches} · ${h.files.length} 文件)\n`);

// ---- 模型运行时 (缺 API key → 明确报错不崩溃) ----
const providers = bootstrapModelRuntime();
if (providers.length === 0) {
  console.error(
    '[dag-deepen] 未注册任何模型 provider — .env 里没配 API key (如 DEEPSEEK_API_KEY)。\n' +
      '热点发现已完成 (见上方 stderr), 但并发扫描需要模型。配好 key 再跑。',
  );
  process.exit(1);
}
const model = flags.model ?? process.env.OMD_LEAF_MODEL ?? 'deepseek:deepseek-v4-flash';
process.stderr.write(`[dag-deepen] leaf=${model} · 预构造 plan 直执 (零 conductor LLM)\n`);

// ---- ② 预构造 plan → runExecutorDagWithPlan (D-7 入口, 跳过 conductor) ----
const plan = buildDeepenPlan(hotspots);
const res = await runExecutorDagWithPlan(plan, {
  conductorModel: model, // 预构造路径不触 conductor; 仅类型必填
  leafModel: model,
  agentLeafModel: model,
  maxFanout: hotspots.length,
  warmThenFanout: true,
  // 扫描叶带工具读真文件 (goal 已钉只读纪律; 本脚本不 commit 不改码)。
  agentRunner: createAgentLeafRunner({ cwd: repoRoot }),
});

const leafStatuses = Object.values(res.results)
  .filter((r) => r.id !== SYNTH_NODE_ID)
  .map((r) => ({ id: r.id, status: r.status }));
const failed = leafStatuses.filter((l) => l.status === 'failed');
const synth = res.results[SYNTH_NODE_ID];
const synthMarkdown = synth && synth.status === 'done' ? synth.output : '';
if (!synthMarkdown) {
  console.error(`[dag-deepen] synthesis 叶${synth ? '失败' : '缺失'} — 无综合结果可报告。各扫描叶: ${leafStatuses.map((l) => `${l.id}=${l.status}`).join(' ')}`);
  process.exit(1);
}

// ---- ④ HTML 报告 → $TMPDIR (fallback /tmp) + terse stdout ----
const tmpDir = (process.env.TMPDIR ?? '').trim().replace(/\/+$/, '') || '/tmp';
const outPath = flags.out || `${tmpDir}/omd-deepen-${Date.now()}.html`;
const html = renderDeepenReport({
  scopeLabel: scope ?? 'repo-wide',
  commits,
  hotspots,
  synthMarkdown,
  leafStatuses,
});
await Bun.write(outPath, html);

const candidateCount = (synthMarkdown.match(/^##\s+/gm) ?? []).length;
console.log(`✅ dag-deepen 完成: ${hotspots.length} 热点并发扫描 → ${candidateCount} 个加深候选`);
if (failed.length) console.log(`⚠ ${failed.length} 个扫描叶失败 (${failed.map((f) => f.id).join(', ')}) — 候选清单不完整`);
console.log(`   leaf 用量: in ${res.usage.leavesIn} · out ${res.usage.leavesOut} · cacheHit ${res.usage.leavesCacheHit}`);
console.log(`📄 报告: ${outPath}`);

// 尽力打开浏览器 (失败静默 — headless/无 xdg-open 属正常)。
try {
  Bun.spawn(['xdg-open', outPath], { stdout: 'ignore', stderr: 'ignore' }).unref();
} catch {
  /* 无 xdg-open → 忽略 */
}

// ---- ⑤ 出口仪式: 候选是输入不是结论 ----
console.log('\n下一步: 对选中的候选先跑 /grill (对抗逼问契约面) 再动手重构 — dag-deepen 只出候选, 永不自动改码/PR。');
