/**
 * eval-executor-ab —— **executor 编码能力 A/B**: 钉死 mimo 吃 cache vs 跨族发散 (owner 2026-07-28)。
 *
 * 与 council 那套 eval 的根本差别: **代码有 oracle**。不请判官, 编译器 + 测试 + git diff 就是判决,
 * 可复现、零成本、不会放水。所以这里测的是硬指标, 不是"看起来好不好":
 *   编码能力   → tsc 零错 + 过测比例 (firstShot / final)
 *   debug 能力 → 种下的语义 bug 能否定位修复 (debug-planted fixture, tsc 照样过, 只有测试红)
 *   指令遵循   → SPEC 里写死的硬约束 + 确定性判据 (改测试 / 加依赖 / @ts-ignore / skip 测试)
 *   工具调用   → 每 leaf 调用次数 · **空手 leaf** (说干完了却一个文件没碰) · 失败/停摆
 *   产出质量   → 改动行数 + 无关文件数 (同样修好, 改 12 行 > 改 300 行)
 *   经济学     → **cache 命中率**: 换族 = 换前缀 = 缓存全 miss, 省下的模型差价可能不够赔 input 全价
 *
 * 单变量设计的关键一手: **plan 只跑一次, 三臂共用**。conductor 的分解质量方差极大 (前一轮 council eval
 * 实测同题重跑摆动 ±2 点), 若每臂各自规划, 量到的一半是规划运气。这里用 runExecutorDagWithPlan 注入
 * 同一张图, 只改**节点座位** —— 引擎第 738 行 `n.model ?? …` 就是这个接缝, 无需改引擎。
 *
 * 跑: bun run scripts/eval-executor-ab.ts [--reps 2] [--task debug|medium]
 */
import '../src/harness/script-bootstrap';
import { writeFileSync, mkdirSync } from 'node:fs';
import { $ } from 'bun';
import { runExecutorDag, runExecutorDagWithPlan } from '../src/harness/dag/engine';
import type { ExecutorDagResult } from '../src/harness/dag/types';
import type { ConductorPlan } from '../src/harness/conductor-plan';
import { createAgentLeafRunner } from '../src/harness/agent-leaf';
import { createCommandLeafRunner, DEFAULT_COMMAND_ALLOWLIST } from '../src/harness/command-leaf';
import { bootstrapModelRuntime } from '../src/model/bootstrap';
import { modelFamily } from '../src/model/channels';
import { rotateFamilies } from '../src/model/family-rotate';
import { onTruncation } from '../src/model/truncation';
import { createDebugFixture, inspectDiff, type DebugFixture } from '../src/eval/tasks/debug-planted';
import { createDistantBugFixture, wholeSuite } from '../src/eval/tasks/hard';
import {
  checkConstraints,
  constraintsBlock,
  cacheEcon,
  toolMetrics,
  type CapabilityRow,
} from '../src/eval/oracles/executor-capability';

const SOL = 'openai-codex:gpt-5.6-sol'; // conductor (两臂同一个, 且 plan 共用 → 完全不是变量)
const MIMO_PRO = 'xiaomi-token-plan-ams:mimo-v2.5-pro';
const MIMO = 'xiaomi-token-plan-ams:mimo-v2.5';
const KIMI = 'kimi-coding:k3';
/**
 * **能真正驱动 agent leaf 的座位池** (2026-07-28 实测收窄):
 * pi agent session 与我们自己的 gateway 是**两套栈** —— 全部 opencode-go 座位在 agent leaf 里
 * 返回 0-token empty-done (沙箱内外皆然, 换 kimi-coding 同族立刻正常), `deepseek:*` 同样空。
 * 所以工具循环这条线上今天只有: mimo 两档 + kimi-coding + gpt-codex。
 * → "用 go 的便宜模型跑代码"在栈修好前是空中楼阁, 这条比 eval 结论本身更要紧。
 */
const AGENT_CAPABLE_POOL = [MIMO_PRO, KIMI, MIMO];

interface Arm {
  name: string;
  note: string;
  /** 给定节点序 → 每个节点的模型座位。 */
  seats: (nodeIds: string[]) => Record<string, string>;
}
const ARMS: Arm[] = [
  {
    name: 'A-mimo-sticky',
    note: 'agent/inproc 全走 mimo 订阅 —— 前缀不变, 吃满 prompt cache',
    seats: (ids) => Object.fromEntries(ids.map((id) => [id, MIMO_PRO])),
  },
  {
    name: 'B-kimi-sticky',
    note: '全走 kimi-coding 单座 —— 换家族但同样粘死, 隔离"家族差"与"发散"两件事',
    seats: (ids) => Object.fromEntries(ids.map((id) => [id, KIMI])),
  },
  {
    name: 'C-diverse',
    note: '逐节点轮 mimo-pro/kimi/mimo —— 发散最大, 但每换一族缓存全 miss',
    seats: (ids) => {
      const models = rotateFamilies(AGENT_CAPABLE_POOL, ids.length);
      return Object.fromEntries(ids.map((id, i) => [id, models[i] ?? AGENT_CAPABLE_POOL[0]!]));
    },
  },
];

const argv = process.argv.slice(2);
const repsIdx = argv.indexOf('--reps');
const REPS = repsIdx >= 0 ? Number(argv[repsIdx + 1]) : 2;
const HARD = argv.includes('--hard'); // H2 共享根因陷阱 + H3 全量 oracle (简单档三臂全满分, 无区分度)
const OUT = HARD ? '/tmp/eval-executor-ab-hard' : '/tmp/eval-executor-ab';
const log = (s: string): void => void process.stderr.write(s + '\n');

const truncs: string[] = [];
onTruncation((i) => {
  truncs.push(`${i.model} out=${i.out}`);
  log(`  ⚠ 截断 ${i.model} out=${i.out}`);
});

/** 把每个节点的模型钉成该臂的座位 (深拷贝, 免得三臂互相污染同一张 plan)。 */
function planWithSeats(plan: ConductorPlan, arm: Arm): ConductorPlan {
  const cloned = JSON.parse(JSON.stringify(plan)) as ConductorPlan;
  const ids = Object.keys(cloned.nodes);
  const seats = arm.seats(ids);
  for (const id of ids) {
    const n = cloned.nodes[id] as { model?: string };
    if (seats[id]) n.model = seats[id];
  }
  return cloned;
}

/** DAG 接线: worktree root 经 agent/command runner 传入 (与 conductor-modelmix 同一套), sandboxRoot 防写穿。 */
function dagCfg(root: string, fallbackLeaf: string): Parameters<typeof runExecutorDag>[1] {
  return {
    conductorModel: SOL,
    leafModel: fallbackLeaf, // 有 n.model 时被覆盖, 仅兜底
    agentLeafModel: fallbackLeaf,
    agentRunner: createAgentLeafRunner({ cwd: root, hashlineEdit: true, sandboxRoot: root }),
    commandRunner: createCommandLeafRunner({ allowlist: [...DEFAULT_COMMAND_ALLOWLIST], cwd: root, timeoutMs: 600_000 }),
    maxFanout: 6,
    warmThenFanout: true,
  } as Parameters<typeof runExecutorDag>[1];
}

async function oracle(root: string, testPath: string): Promise<{ tscClean: boolean; pass: number }> {
  const tsc = await $`npx tsc --noEmit -p tsconfig.json`.cwd(root).quiet().nothrow();
  const t = await $`bun test ${testPath}`.cwd(root).quiet().nothrow();
  const out = t.stdout.toString() + t.stderr.toString();
  const pass = Number(/(\d+) pass/.exec(out)?.[1] ?? 0);
  const fail = Number(/(\d+) fail/.exec(out)?.[1] ?? 0);
  return { tscClean: tsc.exitCode === 0, pass: pass + fail ? pass / (pass + fail) : 0 };
}

bootstrapModelRuntime();
mkdirSync(OUT, { recursive: true });
const rows: CapabilityRow[] = [];
const TEST_PATH = 'src/model/family-rotate.test.ts';

// ── 1) plan 只跑一次, 三臂共用 (剔除 conductor 方差) ─────────────────────────
log('═══ 建 debug fixture + 规划 (plan 三臂共用) ═══');
const planFx = await createDebugFixture();
const task = `${planFx.spec}\n${constraintsBlock()}`;
let sharedPlan: ConductorPlan;
try {
  const warm = await runExecutorDag(task, dagCfg(planFx.root, MIMO_PRO));
  sharedPlan = warm.plan;
  log(`  plan: ${Object.keys(sharedPlan.nodes).length} 节点 (取自暖跑, 三臂共用)`);
} catch (e) {
  await planFx.cleanup();
  throw new Error(`取 plan 失败: ${(e as Error).message}`);
}
await planFx.cleanup();

// ── 2) 每臂 × 每轮: 新 fixture (干净种 bug) → 注入 plan → 打分 ────────────────
for (let rep = 0; rep < REPS; rep++) {
  for (const arm of ARMS) {
    log(`\n═══ debug-planted · ${arm.name} · rep${rep} ═══`);
    let fx: DebugFixture | undefined;
    const t0 = Date.now();
    try {
      // 硬档: 因在 channels 的后缀剥离, 症状同时落在 family-rotate 与 channels ——
      // 在症状处打特例能弄绿 scoped 测试但根因还在, 只有全量 oracle 戳得穿。
      fx = (HARD ? await createDistantBugFixture() : await createDebugFixture()) as DebugFixture;
      const res: ExecutorDagResult = await runExecutorDagWithPlan(planWithSeats(sharedPlan, arm), dagCfg(fx.root, MIMO));
      // 硬档判决 = 全量 1151 测试 + tsc (局部弄绿当场现形); 简单档只跑 scoped。
      const { tscClean, pass } = HARD
        ? await (async () => {
            const s2 = await wholeSuite(fx!.root);
            if (!s2.tscClean) log(`  tsc 红: ${s2.tscErrors.join(' | ').slice(0, 300) || '(无 TS 错误行 — 可能是命令本身失败)'}`);
            return { tscClean: s2.tscClean, pass: s2.green ? 1 : s2.pass / Math.max(1, s2.pass + s2.fail) };
          })()
        : await oracle(fx.root, TEST_PATH);
      const diff = await inspectDiff(fx);
      // 存 diff 原文: 事后复盘唯一凭据 (worktree 跑完即毁)。B 臂出现过 +1/-0 —— 全量测试绿但
      // 改法是"另加一条规则"而非恢复通用规则, 没有原文就永远查不出这种"过测但没真修"。
      const patch = await $`git diff`.cwd(fx.root).quiet().nothrow();
      writeFileSync(`${OUT}/${arm.name}-rep${rep}.patch`, patch.stdout.toString());
      const fam = new Map<string, number>();
      for (const l of Object.values(res.results)) if (l.model) fam.set(modelFamily(l.model), (fam.get(modelFamily(l.model)) ?? 0) + 1);
      rows.push({
        arm: arm.name,
        task: 'debug-planted',
        rep,
        tscClean,
        pass,
        violations: await checkConstraints(fx.root),
        tools: toolMetrics(res),
        cache: cacheEcon(res),
        wallSec: (Date.now() - t0) / 1000,
        insertions: diff.insertions,
        deletions: diff.deletions,
        strayFiles: diff.strayFiles,
        families: [...fam.entries()].map(([f, c]) => `${f}:${c}`).join(' '),
      });
      const r = rows[rows.length - 1]!;
      log(
        `  → tsc ${r.tscClean ? '绿' : '红'} · 过测 ${(r.pass * 100).toFixed(0)}% · 违规 ${r.violations.length} · 空手 leaf ${r.tools.emptyHanded}/${r.tools.agentLeaves} · cache ${(r.cache.hitRate * 100).toFixed(0)}% · +${r.insertions}/-${r.deletions} 行 · ${r.wallSec.toFixed(0)}s`,
      );
    } catch (e) {
      log(`  ✖ ${(e as Error).message.slice(0, 160)}`);
    } finally {
      await fx?.cleanup();
    }
  }
}

// ── 3) 报告 ─────────────────────────────────────────────────────────────────
const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const lines = ['\n════════ executor 能力 A/B (debug-planted · oracle 判决, 无判官) ════════'];
for (const arm of ARMS) lines.push(`${arm.name}: ${arm.note}`);
lines.push('');
for (const arm of ARMS) {
  const rs = rows.filter((r) => r.arm === arm.name);
  if (!rs.length) {
    lines.push(`${arm.name.padEnd(15)} 无有效结果`);
    continue;
  }
  lines.push(
    [
      `${arm.name.padEnd(15)}`,
      `修复率 ${((rs.filter((r) => r.pass === 1 && r.tscClean).length / rs.length) * 100).toFixed(0)}%`,
      `过测均 ${(mean(rs.map((r) => r.pass)) * 100).toFixed(0)}%`,
      `违规 ${rs.reduce((s, r) => s + r.violations.length, 0)}`,
      `空手leaf ${rs.reduce((s, r) => s + r.tools.emptyHanded, 0)}`,
      `工具/leaf ${mean(rs.map((r) => r.tools.callsPerLeaf)).toFixed(1)}`,
      `cache命中 ${(mean(rs.map((r) => r.cache.hitRate)) * 100).toFixed(0)}%`,
      `有效in ${Math.round(mean(rs.map((r) => r.cache.effectiveInput)))}`,
      `out ${Math.round(mean(rs.map((r) => r.cache.leavesOut)))}`,
      `改动 +${Math.round(mean(rs.map((r) => r.insertions)))}/-${Math.round(mean(rs.map((r) => r.deletions)))}`,
      `墙钟 ${mean(rs.map((r) => r.wallSec)).toFixed(0)}s`,
    ].join(' · '),
  );
  const v = [...new Set(rs.flatMap((r) => r.violations))];
  if (v.length) lines.push(`  ↳ 违反的约束: ${v.join(', ')}`);
  const stray = [...new Set(rs.flatMap((r) => r.strayFiles))];
  if (stray.length) lines.push(`  ↳ 动了无关文件: ${stray.slice(0, 6).join(', ')}`);
}
lines.push(
  '',
  '读法: 修复率/过测 = 能力; 违规 = 指令遵循; 空手leaf = 工具调用真伪; 改动行数 = 精准度;',
  '      cache命中 + 有效in = 经济学 —— C 臂若质量没赢 A, 但有效 input 明显更高, 那"发散"就是纯亏。',
  truncs.length ? `全程截断 ${truncs.length} 次 → ${[...new Set(truncs)].join(' | ')}` : '全程无截断 (顶已抬够)',
);
const report = lines.join('\n');
process.stdout.write(report + '\n');
writeFileSync(`${OUT}/report.md`, report);
writeFileSync(`${OUT}/rows.json`, JSON.stringify(rows, null, 2));
log(`  → 落盘 ${OUT}/`);
