#!/usr/bin/env bun
/**
 * scripts/dag-build —— oh-my-dag 并行建代码 + 自愈 + 内嵌 review 管线 (派活专用)。
 *
 * 不只是重构: 任何**可分解 + 可验证**的代码工作 (build N 个同构模块 / 照契约填实现 / 跨切面改造 / 重构)。
 * 引擎 = executor-dag: conductor (pro) 把 goal 分解成 DAG → executor:agent 节点经 createAgentLeafRunner
 * (read/edit/write/bash + LSP diagnostics + hashline 行锚定 + DISCIPLINE_CORE 承重纪律) **真改文件** →
 * 层内并行 (原子产物不重叠, 冲突走依赖串行) + executor:command 节点经 createCommandLeafRunner (DAG 内 tsc 自验)。
 *
 * 管线: DAG 自验 → 自愈 fix-loop 到绿 → 绿后门控 review → 回调用方 (P0/P1 file:line)。
 *   ① 自愈 (--heal N=1): oracle (tsc[+test]) 红 → 派 fix-DAG 喂错误摘要 → 重验, 最多 N 轮 (build 自己迭代到绿)。
 *   ② 绿后 review: **只审绿** (红→先修, 审红 findings churn) + 风险门控 (≥2 src.ts 或敏感区) → 走共享 runReview。
 *      --review 强开 / --no-review 关 / --review-gate G2|G3 (显式 override)。
 *      gate 自动: schema/migration/sql (sql|schema|migration) → G3 (+contract 维度, 抓 SQL↔TS 不一致等); 其余敏感区 → G2。
 *   ③ 回调用方最小化: 只打 P0/P1 抬头行 (file:line), 全文落 /tmp; findings≠真理不阻断 (exit 看 oracle), 调用方终裁。
 *
 * 可靠性来自模型之外: ① --context 契约作 groundTruth 冻结前缀; ② agent leaf 自验 (tsc/test 绿才算完);
 *   ③ 驱动末端确定性 oracle 闸 (tsc[+--test]) + 自愈; ④ 不自动 commit (调用方审 diff 才提交)。
 *
 * token/cache: 整条 build→自愈→review 同一进程跑完 (省冷 cache miss); review 只绿后+门控 (省 token)。
 *
 *   bun run scripts/dag-build.ts "<build goal>" [--context "<契约>" | --context-file <path>]
 *        [--conductor-model ds:pro] [--agent-model ds:flash] [--leaf-model ds:flash]
 *        [--test] [--max-fanout 8] [--allow-dirty] [--heal N=1] [--review|--no-review] [--review-gate G2|G3]
 *   默认: conductor=OMD_CONDUCTOR_MODEL→ds-pro, agent leaf=OMD_LEAF_MODEL→ds-flash, oracle=tsc
 *   (--test 加 bun test), --heal 1, review 自动门控。
 *   ⚠️ fleet 会改工作树 → 默认要求 git 干净 (--allow-dirty 跳过)。跑完审 diff 再 commit, 脚本不自动提交。
 */
import '../src/harness/script-bootstrap';
import { runExecutorDag } from '../src/harness/executor-dag';
import { createAgentLeafRunner } from '../src/harness/agent-leaf';
import { createCommandLeafRunner } from '../src/harness/command-leaf';
import { runReview, type ReviewGate } from '../src/harness/review';
import { classifyOracle } from '../src/harness/build/oracle-classify';
import { CheckpointManager } from '../src/harness/continuity/checkpoint-manager';
import { haltJudge, judgeVerdictSchema, type LeafState } from '../src/harness/continuity/halt-judge';
import { callModel } from '../src/model';
import { bootstrapModelRuntime } from '../src/model/bootstrap';
import { $ } from 'bun';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const USAGE =
  'usage: bun run scripts/dag-build.ts "<build goal>" [--cwd <目标仓路径>] [--oracle-cmd "<验证命令>"] [--context "<契约>"|--context-file p] [--conductor-model M] [--agent-model M] [--agent-thinking off|low|medium|high|xhigh] [--leaf-model M] [--leaf-ponytail] [--test | --test-glob "<files>"] [--max-fanout 8] [--allow-dirty] [--heal N=1] [--review|--no-review] [--review-gate G2|G3] [--resume <runId>] [--no-judge] [--judge-cap N=2]';

const BOOL = new Set(['test', 'allow-dirty', 'review', 'no-review', 'no-judge', 'leaf-ponytail', 'help']);
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
const goal = positionals.join(' ').trim();
if (!goal) {
  console.error(USAGE);
  process.exit(1);
}
const context = flags['context-file'] ? readFileSync(flags['context-file'], 'utf8') : (flags.context ?? '');

// 目标仓支持: dag-build 可服务任意仓库, 不只本 repo。
// targetCwd = --cwd 显式 > OMD_CALLER_CWD (薄包装注入调用方 cwd) > process.cwd() (自用)。
// fleet 改文件 / git 闸 / oracle / leaf runner 全部锚到 targetCwd; conductor/模型运行时仍在本 repo (deps/.env)。
const targetCwd = resolve(flags.cwd || process.env.OMD_CALLER_CWD || process.cwd());
if (targetCwd !== process.cwd()) process.stderr.write(`[dag-build] 目标仓: ${targetCwd}\n`);

// ---- 安全: fleet 会改工作树 → 默认要求 git 干净 (跑完只看本次 diff, 不混既有改动) ----
$.cwd(targetCwd);
const dirty = (await $`git status --porcelain`.nothrow().text()).trim();
if (dirty && !flags['allow-dirty']) {
  console.error('[dag-build] git 工作树不干净 → 拒跑 (fleet 改文件会和既有改动混)。先 commit/stash, 或 --allow-dirty 强跑:\n' + dirty.split('\n').slice(0, 10).join('\n'));
  process.exit(1);
}
const headBefore = (await $`git rev-parse HEAD`.nothrow().text()).trim();

// 派活关联键: 本次 build 的 trace session id (= executor-dag run sessionId)。可追溯 (HEAD+时戳)。
// 初次 build + 自愈 fix-DAG 共用同一个 → 整次派活 (含 heal) 可按 session 归因。
const dispatchId = `xb-${headBefore.slice(0, 8)}-${Date.now().toString(36)}`;

bootstrapModelRuntime();
// conductor 模型: 显式 --conductor-model > OMD_CONDUCTOR_MODEL (.env) > ds-pro (分解质量优先)。
const conductorModel = flags['conductor-model'] ?? process.env.OMD_CONDUCTOR_MODEL ?? 'deepseek:deepseek-v4-pro';
// agent leaf (带工具改文件) / inproc leaf: 显式 flag > OMD_LEAF_MODEL (.env) > ds-flash。
const agentLeafModel = flags['agent-model'] ?? process.env.OMD_LEAF_MODEL ?? 'deepseek:deepseek-v4-flash';
const leafModel = flags['leaf-model'] ?? process.env.OMD_LEAF_MODEL ?? 'deepseek:deepseek-v4-flash';
process.stderr.write(`[dag-build] conductor=${conductorModel}\n`);

// agent leaf thinking 档 (--agent-thinking, 默认不传 = agent-leaf 内部默认 'xhigh')。
// 实测: 有的 agent 模型思考开会把 thinkingBudget 打到接近无界, 吃光 leaf 预算超时零落盘 —— 那类模型传 'off';
// 靠思考的 agent 模型 (deepseek 系) 不传此 flag 保持默认。校验枚举, 非法值 fail-fast。
const AGENT_THINKING_LEVELS = new Set(['off', 'low', 'medium', 'high', 'xhigh']);
const agentThinking = flags['agent-thinking'];
if (agentThinking !== undefined && !AGENT_THINKING_LEVELS.has(agentThinking)) {
  console.error(`[dag-build] --agent-thinking 非法值 '${agentThinking}' (允许: off/low/medium/high/xhigh)`);
  process.exit(1);
}

// task = goal + 契约 (conductor + 所有 leaf 都见, 作 groundTruth)
const task = [
  goal,
  context ? `===== 契约 / 上下文 (groundTruth, 严格遵守) =====\n${context}` : '',
].filter(Boolean).join('\n\n');

process.stderr.write(`[dag-build] conductor=${conductorModel} agent-leaf=${agentLeafModel}${agentThinking ? ` thinking=${agentThinking}` : ''} (fleet 写文件)...\n`);

// build 前脏文件基线 (judge 输入域): --allow-dirty 时树上有无关 WIP, judge 的 changedFiles
// 必须只含本次 build 增量, 否则把别人的脏文件裁成 "违反不改其他文件"。
const preBuildDirty = new Set(
  (await $`git status --porcelain`.nothrow().text())
    .split('\n')
    .map((l) => (l.slice(3).split(' -> ').pop() ?? '').trim())
    .filter(Boolean),
);

// W2 continuity (SDD C4): 节点 checkpoint 落盘; --resume <runId> 跳已绿节点。
const repoRoot = targetCwd;
const continuityManager = new CheckpointManager(repoRoot);
const continuityRunId = flags.resume || `build-${dispatchId}`;
process.stderr.write(`[dag-build] continuity runId=${continuityRunId}${flags.resume ? ' (resume: 跳已绿节点)' : ''}\n`);

// oracle 命令可覆盖: 默认 tsc; 非 ts 项目 (如 Astro) 传 --oracle-cmd "npx astro check"。
// 单一定义: 外层 oracle 闸与图内 oracle 复跑节点过滤器 (issue #2) 必须字节一致。
const oracleCmd = flags['oracle-cmd'] || 'bun run tsc --noEmit';

// DAG 配置 (初次 build + 自愈 fix-DAG 复用同一套)
const dagConfig = {
  // issue #2: conductor 规划出与 oracle 等价的 command 节点会被 command-leaf 元字符闸误拒 → 执行前确定性过滤。
  oracleCmd,
  continuity: { manager: continuityManager, runId: continuityRunId, resume: !!flags.resume, repoRoot },
  conductorModel,
  leafModel,
  agentLeafModel,
  // 注入派活关联键 → 本次 build 全部 conductor+leaf trace 归 session=dispatchId。
  sessionId: dispatchId,
  maxFanout: flags['max-fanout'] ? Number(flags['max-fanout']) : 8,
  // 暖发错峰: 首 leaf 先行写共享前奏 cache (纪律核/工具 schema 跨 leaf 字节稳定),
  // 其余再放 pool → 治并发 thundering herd。单节点图自动短路不生效。
  warmThenFanout: true,
  // --leaf-ponytail: leaf 注入反过度工程倾向降代码量 (构建相位; 质量靠 oracle/review 兜底)。默认 off。
  leafPonytail: flags['leaf-ponytail'] === 'true',
  // 能改文件的 agent leaf (hashline 行锚定治弱模型 edit 腐烂)
  agentRunner: createAgentLeafRunner({
    cwd: targetCwd,
    hashlineEdit: true,
    ...(agentThinking ? { thinkingLevel: agentThinking as 'off' | 'low' | 'medium' | 'high' | 'xhigh' } : {}),
  }),
  // 确定性 command leaf: 让 conductor 在 DAG 内插 typecheck/test 节点能真跑 (中途自验 → 收敛更快)。
  // 白名单 = 验证类命令首 token (bun run tsc / bun test / tsc / npx tsc); 元字符/危险命令 fail-closed 拦。
  commandRunner: createCommandLeafRunner({ allowlist: ['bun', 'tsc', 'npx'], cwd: targetCwd, timeoutMs: 180_000 }),
  // leaf 冻结前缀 = 契约 (让每个 leaf 都见 groundTruth)。
  ...(context ? { leafSystemPrefix: context } : {}),
};

const res = await runExecutorDag(task, dagConfig);

// ---- 报告: 计划 + 各节点 ----
console.log(`\n=== 图: ${res.plan.name} · ${Object.keys(res.results).length} 节点 · ${res.levels.length} 层 ===`);
res.levels.forEach((lvl, i) => console.log(`  L${i}: ${lvl.join(', ')}`));
console.log('\n=== 节点 ===');
for (const [id, r] of Object.entries(res.results)) {
  console.log(`  [${r.status}] ${id} (${r.kind}${r.model ? ' ' + r.model : ''})`);
}

// leaf cache hit-rate 观测: miss 大头 = 各 leaf 文件切片属真工作;
// 此行用于看 thundering herd / 前缀漂移类可治 miss 的趋势。
{
  const totalIn = res.usage.leavesIn || 0;
  const hit = res.usage.leavesCacheHit || 0;
  if (totalIn > 0) {
    console.log(`=== leaf 用量: in ${totalIn} · out ${res.usage.leavesOut} · cacheHit ${hit} (${((hit / totalIn) * 100).toFixed(0)}%) ===`);
  }
}

// ---- 确定性 oracle 闸 (可靠性来自模型之外): tsc [+ test] ----
export interface OracleResult {
  green: boolean;
  digest: string;
  summary: string;
  /** 结构化错误行 (classifyOracle 据此分支; 不只看 green 布尔)。 */
  tscErrs: string[];
  testFail: string[];
}
async function runOracle(): Promise<OracleResult> {
  const tsc = await $`sh -c ${oracleCmd}`.nothrow().quiet();
  const rawOut = tsc.stdout.toString() + tsc.stderr.toString();
  let tscErrs = rawOut.split('\n').filter((l) => /error TS/.test(l) && !l.includes('node_modules'));
  // 自定义 oracle 用 exit code 兜底判绿; 无 TS 行时拿 error/失败行作 digest (默认 tsc 路径行为不变)。
  if (flags['oracle-cmd'] && tsc.exitCode !== 0 && tscErrs.length === 0) {
    tscErrs = rawOut.split('\n').filter((l) => /error|fail|✘|cannot|expected/i.test(l) && !l.includes('node_modules')).slice(0, 15);
    if (tscErrs.length === 0) tscErrs = rawOut.trim().split('\n').slice(-10);
  }
  let testFail: string[] = [];
  let testRan = false;
  if (flags.test || flags['test-glob']) {
    // 范围闸: 全量套件的无关红/LIVE flake 会被算到本次 build 头上 → heal 追鬼越界改文件;
    // 派活时 oracle 必须只含本任务契约面。两档 (merge 合成):
    //   --test-glob "<files/globs 空格分隔>" = 调用方显式指定 (最准, 优先);
    //   --test (裸) = 自动 scope 到本次真改文件的目录 (porcelain 含未跟踪新文件;
    //                 diff --name-only 看不见 fleet 新建的文件)。零改动 → test 闸空过。
    let scoped = (flags['test-glob'] ?? '').split(/\s+/).filter(Boolean);
    if (!scoped.length) {
      const changed = (await $`git status --porcelain`.nothrow().text())
        .split('\n')
        .map((l) => (l.slice(3).split(' -> ').pop() ?? '').trim())
        .filter((f) => /\.(ts|tsx)$/.test(f));
      scoped = [...new Set(changed.map((f) => f.replace(/\/[^/]+$/, '')))];
    }
    if (scoped.length) {
      const t = await $`bun test ${scoped}`.nothrow().quiet();
      const out = t.stdout.toString() + t.stderr.toString();
      testRan = true;
      if (/[1-9]\d* fail/.test(out)) testFail = out.split('\n').filter((l) => /\(fail\)|error/i.test(l)).slice(0, 15);
    }
  }
  const green = tscErrs.length === 0 && testFail.length === 0;
  const digest = [
    tscErrs.length ? `tsc 错 (${tscErrs.length}):\n${tscErrs.slice(0, 15).join('\n')}` : '',
    testFail.length ? `test 失败:\n${testFail.join('\n')}` : '',
  ].filter(Boolean).join('\n\n');
  const summary = `tsc ${tscErrs.length === 0 ? '✅' : '❌' + tscErrs.length + '错'}${testRan ? ` · test ${testFail.length === 0 ? '✅' : '❌'}` : ''}`;
  return { green, digest, summary, tscErrs, testFail };
}

// ---- 自愈: oracle 红 → 派 fix-DAG 喂错误 → 重验, 最多 healRounds 轮 (build 自己迭代到绿) ----
// heal 循环本就是 build 的图外 fixpoint (轮=fix-DAG, judge=oracle, 注入错误重规划, maxHeal 有界)。
// classifyOracle = 该 fixpoint 的分支谓词: 不再"任何红都盲愈", 而是按 oracle 结构化结果
// 选一条预定义后继 (closed-set + fail-closed)。
const maxHeal = Math.max(0, Number(flags.heal ?? '1') || 0);
process.stderr.write('\n[dag-build] oracle 闸...\n');
let oracle = await runOracle();
let healed = 0;
let branch = classifyOracle(oracle, null);
// healable + 预算未尽 → 烧一轮; hard_fail/stuck → 提前止损 (省掉烧不动的轮)。
while (branch === 'healable' && healed < maxHeal) {
  healed++;
  const prevDigest = oracle.digest;
  process.stderr.write(`[dag-build] oracle 红(healable) → 自愈 ${healed}/${maxHeal} (派 fix-DAG)...\n`);
  const fixTask = `修复以下验证错误。只改必要文件让 tsc/test 转绿, 不加新功能, 不改契约语义。\n\n===== 错误 =====\n${oracle.digest}${context ? `\n\n===== 契约 (groundTruth) =====\n${context}` : ''}`;
  await runExecutorDag(fixTask, dagConfig);
  oracle = await runOracle();
  branch = classifyOracle(oracle, { digest: prevDigest });
}
// ---- W2 停机闸栈 (SDD C6): oracle 绿后 goal judge 残差闸 (默认开, --no-judge 关) ----
// 治 "fleet 字面化过 oracle": tsc/test 绿 ≠ 目标达成。judge (ds-flash, temp 0) 读结构化快照
// (goal/oracle/changedFiles/leaf 状态, 非 transcript), not-ok → 注入缺口 reason 派一轮 fix-DAG,
// 有界 (judge-cap, 默认 2)。judge 挂 → degraded 按绿放行 (宁误放不活锁, oracle 是主闸)。
// L1 只看干活 leaf (inproc/agent) —— command 节点的对错由外部 oracle 裁, 失败是噪声。
let judgeUsed = 0;
let judgeNote = '';
// judge 的终裁停机 reason (null = judge 未跑/未截停)。失败类 reason 即使 tsc 平凡绿也非成功。
let judgeStopReason: string | null = null;
const judgeCap = Math.max(0, Number(flags['judge-cap'] ?? '2') || 0);
if (!flags['no-judge'] && judgeCap > 0 && oracle.green) {
  // responseSchema 走 callModel 的 INV-3 校验+纠错重试 (裸 JSON.parse 遇 flash 包裹/截断必 degraded)。
  const judgeGen = async (req: { messages: { role: 'system' | 'user'; content: string }[]; model: string; thinkingLevel?: string }) => {
    const r = await callModel({ model: req.model, messages: req.messages, temperature: 0, maxTokens: 800, responseSchema: judgeVerdictSchema });
    return { text: JSON.stringify(r.parsed), usage: r.usage };
  };
  let lastLeafStates: LeafState[] = Object.values(res.results)
    .filter((r) => r.kind !== 'command')
    .map((r) => ({ id: r.id, status: r.status, kind: r.kind }));
  while (oracle.green) {
    // 本次 build 增量 = 当前脏文件 − build 前基线 (porcelain 含未跟踪新文件)。
    const changedNow = (await $`git status --porcelain`.nothrow().text())
      .split('\n')
      .map((l) => (l.slice(3).split(' -> ').pop() ?? '').trim())
      .filter((f) => f && !preBuildDirty.has(f));
    const verdict = await haltJudge(
      { leafStates: lastLeafStates, healed, healCap: maxHeal },
      { goal, oracleSummary: `${oracle.summary}\n${oracle.digest.slice(0, 600)}`.trim(), changedFiles: changedNow.slice(0, 50), leafStates: lastLeafStates, healed },
      { generate: judgeGen as never, judgeUsed, judgeCap, noJudge: false },
    );
    if (verdict.kind === 'stop') {
      judgeStopReason = verdict.reason;
      judgeNote = ` · ⚖ judge: ${verdict.reason}${verdict.evidence ? ` — ${verdict.evidence.slice(0, 200)}` : ''}`;
      break;
    }
    judgeUsed++;
    process.stderr.write(`[dag-build] ⚖ judge not-ok (${judgeUsed}/${judgeCap}) → 派 fix-DAG 注入 judge 缺口...\n`);
    const judgeTask = `目标尚未完全达成 (judge 裁定)。只补齐下述缺口, 不加新功能, 不改契约语义。\n\n===== 目标 =====\n${goal}\n\n===== judge 缺口 =====\n${verdict.reason}${context ? `\n\n===== 契约 (groundTruth) =====\n${context}` : ''}`;
    const fixRes = await runExecutorDag(judgeTask, dagConfig);
    lastLeafStates = Object.values(fixRes.results)
      .filter((r) => r.kind !== 'command')
      .map((r) => ({ id: r.id, status: r.status, kind: r.kind }));
    oracle = await runOracle();
    if (!oracle.green) {
      judgeNote = ' · ⚖ judge fix 后 oracle 转红 (交调用方)';
      break;
    }
  }
}

// judge 失败类停机 (leaf 挂 hard_fail / 目标不可达 / 预算耗尽) → 即使 content-blind 的 tsc 平凡绿也非成功。
// 治 "fleet 空跑过内容盲 oracle = 假绿坑派活方" (实证: N leaf 全 empty-done, tsc 因空仓平凡绿,
// judge 正确报 hard_fail)。degraded = judge 自身挂, 按设计让位 oracle 主闸 (不列入失败集, 保留 fail-soft 语义)。
const JUDGE_FAIL_REASONS = new Set(['hard_fail', 'judge_impossible', 'cap_exhausted']);
const judgeHardFail = judgeStopReason !== null && JUDGE_FAIL_REASONS.has(judgeStopReason);
const buildOk = oracle.green && !judgeHardFail;

// 分支语义 → 人类可读 (审计 + 报告)。
const branchNote =
  branch === 'green' ? '' :
  branch === 'hard_fail' ? ' · ⛔ hard_fail (编译器/配置级错, fix-DAG 改文件无从下手 → 提前 escalate, 省剩余 heal 轮)' :
  branch === 'stuck' ? ` · 🔁 stuck (自愈 ${healed} 轮零进展, digest 不变 → 提前止损)` :
  healed >= maxHeal ? ` · ⏏ heal 预算耗尽 (${maxHeal} 轮仍红 → 交调用方)` : '';
const verdictTok = buildOk ? '✅ 绿' : judgeHardFail ? '❌ 失败 (judge 截停; tsc 绿是内容盲假象)' : '❌ 红';
console.log(`\n=== oracle: ${verdictTok}${healed ? ` (自愈 ${healed} 轮)` : ''} · ${oracle.summary}${branchNote}${judgeNote} ===`);
if (!oracle.green) console.log(oracle.digest.split('\n').slice(0, 15).map((l) => '  ' + l).join('\n'));

// ---- 改动捕获 (intent-to-add 让新文件进 diff, 非破坏性; 不 stage 内容) ----
await $`git add -N .`.nothrow().quiet();
const diff = await $`git diff`.nothrow().text();
const changedFiles = (await $`git diff --name-only`.nothrow().text()).trim();
const diffStat = (await $`git diff --stat`.nothrow().text()).trim();
console.log(`\n=== 本次改动 ===\n${diffStat || '(无)'}`);

// ---- 绿后风险门控 review: 只审绿代码 (红→先修, 审红 findings churn) + 触 src 逻辑/敏感区才审 (省 token) ----
const SENSITIVE = /(\/model\/|sql\/|schema|security|auth|pii|gateway|migration)/;
// 自动升 G3 (+contract 维度): schema/migration/sql —— contract 违反在这些区 = 数据层灾难 (SQL↔TS 不一致等)。
const G3_AUTO = /(sql\/|schema|migration)/i;
const srcFiles = changedFiles.split('\n').filter((f) => /^src\/.*\.ts$/.test(f) && !/\.test\.ts$/.test(f));
const reviewWorthy = srcFiles.length >= 2 || SENSITIVE.test(changedFiles);
const doReview = buildOk && !flags['no-review'] && (flags.review === 'true' || reviewWorthy) && diff.trim().length > 0;
// gate: 显式 --review-gate override; 否则 schema/sql 自动 G3, 其余 G2。
const autoGate: ReviewGate = G3_AUTO.test(changedFiles) ? 'G3' : 'G2';

let reviewLine = '审 git diff, 满意才 commit —— 脚本不自动提交。';
if (!buildOk && !flags['no-review']) {
  reviewLine = judgeHardFail
    ? `review 跳过 (judge 截停 ${judgeStopReason} → 产物未达成, 审无意义)。`
    : 'review 跳过 (oracle 红 → 先修绿; 审红代码 findings 会 churn)。';
} else if (buildOk && !doReview && !flags['no-review']) {
  reviewLine = `review 跳过 (trivial: ${srcFiles.length} src.ts 无敏感区; --review 强开)。审 git diff 即可。`;
}
if (doReview) {
  const reviewGate = (flags['review-gate'] as ReviewGate) ?? autoGate;
  process.stderr.write(`[dag-build] 绿 + ≥2src/敏感区 → 内嵌 dag-review (${reviewGate}${flags['review-gate'] ? '' : reviewGate === 'G3' ? ' 自动:schema/sql' : ' 自动'})...\n`);
  const scope = `dag-build 改动文件:\n${changedFiles}`;
  const { findings, outPath } = await runReview({ diff, scope, gate: reviewGate, cwd: targetCwd });
  console.log(`\n=== 内嵌对抗审查 [${reviewGate}] → ${outPath} (finding≠真理, 调用方终裁) ===`);
  for (const f of findings) {
    const tag = f.hasRealSignal ? '含file:line' : f.likelySlop ? '⚠️疑似slop' : '';
    // 只回 P0/P1 抬头行 → 省调用方 token; 全文在 outPath, 按需精读点名 file:line
    const heads = f.text.split('\n').filter((l) => /\bP0\b|\bP1\b/.test(l)).slice(0, 8);
    console.log(`  [${f.dimension}] ${tag}${heads.length ? '\n' + heads.map((h) => '    ' + h.trim()).join('\n') : ' (无 P0/P1)'}`);
  }
  reviewLine = `review 完 → 全文 ${outPath}。只精读 review 点名的 file:line (省 token), 满意才 commit。`;
}

console.log(`\n=== 下一步 (调用方) ===`);
const statusLine = buildOk
  ? '绿'
  : judgeHardFail
    ? `judge 截停 (${judgeStopReason}) → 产物未达成, 调用方接手 (tsc 绿是内容盲假象, 别当成功)`
    : '红 → --heal N 自愈或调用方接手';
console.log(`  HEAD was ${headBefore.slice(0, 8)}。oracle ${statusLine}。${reviewLine}`);
process.exitCode = buildOk ? 0 : 1;
