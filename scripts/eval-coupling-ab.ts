#!/usr/bin/env bun
/**
 * eval-coupling-ab —— **并行 fan-out vs 顺序单 owner** 的三臂实验(2026-08-07)。
 *
 * ## 它在验一条外部发现
 *
 * `mshumer/Claude-of-Duty` README:六个 agent 各管一个目录跑三轮,分数 +0.46 而毁帧缺陷
 * **60 → 66(涨了)**;换成一个 owner 顺着做一遍,+1.00,缺陷 66 → 26。
 * 给的机制解释是「色调映射/天空/间接光本来是一个耦合系统,隔离的 agent 一直在破坏彼此的前提」。
 *
 * 这条**不能照单收**(n=1,领域是物理耦合的渲染管线),也**不能忽略**(omd 的核心就是并行 DAG)。
 * 所以把它变成本仓的一次最小实验。
 *
 * ## 单一变量 = 拓扑,只有拓扑
 *
 * 三臂共用:同一份 fixture · 同一批需求原文 · 同一个座位 · 同一份硬约束 · 同一个 oracle。
 * 只有图的形状不同:
 *   **P** 三个节点无依赖  —— 今天 omd 的默认(真并行,同时改同一个文件)
 *   **C** 三个节点串成链  —— 只改顺序,每个节点**仍然只看得见自己那条需求**
 *   **S** 一个节点拿三条  —— 顺序 + 单 owner + 全上下文(Shumer 那一臂)
 *
 * **plan 是手写的,不请 conductor。** 拓扑是被测变量,不能让它由一次 LLM 采样决定
 * (`eval-executor-ab` 那条「plan 只跑一次三臂共用」同一个理由,这里更进一步)。
 *
 * ## 为什么必须是三臂而不是两臂
 *
 * Shumer 那条发现把**两个变量**混在一起:顺序化 与 单 owner 看得见全部上下文。
 * 两臂比出来的差,归给哪一个都说得通。
 *   P → C 的差 = **顺序**本身值多少(上下文没变)
 *   C → S 的差 = **单 owner / 全上下文**再加多少
 * 少了 C,这个实验就回答不了「到底是拓扑还是预算」。
 *
 * ## 预先声明的判据(动手前写死,事后不许改)
 *
 * 主信号 = **交叉缺陷 `crossFail`**(X/ 用例:三条需求的接缝)。假说的预测很具体:
 * 并行若真的输,应该**主要输在交叉格**上 —— 各人把自己那条做对了,合起来对不上。
 *
 *   ① `P.crossFail` 显著高于 `C.crossFail`  → 「隔离的 agent 破坏彼此前提」在本仓**成立**;
 *   ② 三臂 `crossFail` 都是 0                → 这批需求**不够耦合**,量的是尺子。
 *                                              加难度重来,**不许**读成「并行没问题」;
 *   ③ P 在两格上一起输                        → 机制不是耦合,是别的。假说**没被证实**,
 *                                              别硬往耦合上解释;
 *   ④ S 赢 C 但 out token 明显更高            → 那是**预算**不是拓扑。
 *
 * **两侧都要写进报告** —— 不塌是「并行默认成立」的证据,塌是「该给耦合关注点单 owner」的证据,
 * 两者都值钱。
 *
 * ## 三态
 *
 * 跑不起来的一轮(`runnable:false`)**不进任何分母**,单列。一个没跑成的臂印成「缺陷 0」
 * 就是本仓 S-23 那条:分子恒零而分母正常,印出一个漂亮的 0。
 *
 * 跑:
 *   bun run scripts/eval-coupling-ab.ts [--reps 2] [--seat provider:model] [--arms P,C,S]
 *
 * ⚠ 座位**先探再跑**(P-2:别从日志倒推):`bun run scripts/omd-seat-probe.ts`。
 */
import '../src/harness/script-bootstrap';
import { $ } from 'bun';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createAgentLeafRunner } from '../src/harness/agent-leaf';
import { createCommandLeafRunner, DEFAULT_COMMAND_ALLOWLIST } from '../src/harness/command-leaf';
import type { ConductorPlan } from '../src/harness/conductor-plan';
import { runExecutorDagWithPlan, type runExecutorDag } from '../src/harness/executor-dag';
import type { ExecutorDagResult } from '../src/harness/executor-dag-types';
import { bootstrapModelRuntime } from '../src/model/bootstrap';
import { onTruncation } from '../src/model/truncation';
import {
  BRIEF,
  REQUIREMENTS,
  createCoupledFixture,
  scoreCoupled,
  type CoupledFixture,
} from '../src/eval/tasks/coupled-layout';
import { cacheEcon, checkConstraints, constraintsBlock, toolMetrics } from '../src/eval/oracles/executor-capability';

const argv = process.argv.slice(2);
const flag = (name: string, dflt: string): string => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1]! : dflt;
};
const REPS = Number(flag('reps', '2'));
const SEAT = flag('seat', 'xiaomi-token-plan-ams:mimo-v2.5-pro');
const WANT = flag('arms', 'P,C,S').split(',').map((s) => s.trim());
const OUT = '/tmp/eval-coupling-ab';
const log = (s: string): void => void process.stderr.write(s + '\n');

const truncs: string[] = [];
onTruncation((i) => {
  truncs.push(`${i.model} out=${i.out}`);
  log(`  ⚠ 截断 ${i.model} out=${i.out}`);
});

// ── 三张手写的图 ─────────────────────────────────────────────────────────────
/** 一个节点的 goal:共同背景 + 硬约束 + 它负责的那些需求。**不提别的节点。** */
const goalFor = (reqs: readonly (typeof REQUIREMENTS)[number][]): string =>
  [
    BRIEF,
    '',
    '## 你负责的需求',
    '',
    ...reqs.map((r) => `### ${r.id} ${r.title}\n\n${r.body}`),
    constraintsBlock(),
  ].join('\n');

interface Arm {
  name: string;
  note: string;
  plan: (seat: string) => ConductorPlan;
}

const ARMS: readonly Arm[] = [
  {
    name: 'P-parallel',
    note: '三节点无依赖 —— 真并行, 三个 agent 同时改同一个文件 (omd 今天的默认)',
    plan: (seat) => ({
      name: 'coupled-layout-parallel',
      nodes: Object.fromEntries(
        REQUIREMENTS.map((r) => [
          r.id.toLowerCase(),
          { executor: 'agent' as const, model: seat, goal: goalFor([r]) },
        ]),
      ),
    }),
  },
  {
    name: 'C-chain',
    note: '三节点串成链 —— 只改顺序; 每个节点**仍然只看得见自己那条需求**',
    plan: (seat) => ({
      name: 'coupled-layout-chain',
      nodes: Object.fromEntries(
        REQUIREMENTS.map((r, i) => [
          r.id.toLowerCase(),
          {
            executor: 'agent' as const,
            model: seat,
            goal: goalFor([r]),
            ...(i > 0 ? { depends_on: [REQUIREMENTS[i - 1]!.id.toLowerCase()] } : {}),
          },
        ]),
      ),
    }),
  },
  {
    name: 'S-single',
    note: '单节点拿三条需求 —— 顺序 + 单 owner + 全上下文 (Shumer 那一臂)',
    plan: (seat) => ({
      name: 'coupled-layout-single',
      nodes: { all: { executor: 'agent' as const, model: seat, goal: goalFor(REQUIREMENTS) } },
    }),
  },
];

/** DAG 接线。三臂逐字相同 —— 任何一处不同都会变成第二个变量。 */
function dagCfg(root: string): Parameters<typeof runExecutorDag>[1] {
  return {
    conductorModel: SEAT, // 预构造路径用不上; 仅 verifier 升级重规划时才碰
    leafModel: SEAT,
    agentLeafModel: SEAT,
    agentRunner: createAgentLeafRunner({ cwd: root, hashlineEdit: true, sandboxRoot: root }),
    commandRunner: createCommandLeafRunner({ allowlist: [...DEFAULT_COMMAND_ALLOWLIST], cwd: root, timeoutMs: 600_000 }),
    maxFanout: 3,
    // 三臂统一关掉暖跑: 开着会把 P 臂的第一个节点先单独跑一遍, 那就不是"真并行"了。
    // C 臂靠 depends_on 串行, 与这个开关无关 —— 所以统一置 false 不会给任何一臂特权。
    warmThenFanout: false,
  } as Parameters<typeof runExecutorDag>[1];
}

interface Row {
  arm: string;
  rep: number;
  /** false = 这一轮的 oracle 跑不起来 → **不进任何分母**。 */
  runnable: boolean;
  tscClean: boolean;
  singleFail?: number;
  crossFail?: number;
  violations: string[];
  emptyHanded: number;
  leavesOut: number;
  effectiveInput: number;
  wallSec: number;
  insertions: number;
  deletions: number;
  failedNames: string[];
}

bootstrapModelRuntime();
mkdirSync(OUT, { recursive: true });
const rows: Row[] = [];
const arms = ARMS.filter((a) => WANT.some((w) => a.name.startsWith(w)));
log(`座位 ${SEAT} · 臂 ${arms.map((a) => a.name).join(',')} · reps ${REPS}`);

for (let rep = 0; rep < REPS; rep++) {
  for (const arm of arms) {
    log(`\n═══ coupled-layout · ${arm.name} · rep${rep} ═══`);
    let fx: CoupledFixture | undefined;
    const t0 = Date.now();
    try {
      fx = await createCoupledFixture();
      const res: ExecutorDagResult = await runExecutorDagWithPlan(arm.plan(SEAT), dagCfg(fx.root));
      const score = await scoreCoupled(fx.root, fx.testPath);
      const diff = await $`git diff --numstat`.cwd(fx.root).quiet().nothrow();
      let ins = 0;
      let del = 0;
      for (const l of diff.stdout.toString().trim().split('\n').filter(Boolean)) {
        const [a, d] = l.split('\t');
        ins += Number(a) || 0;
        del += Number(d) || 0;
      }
      // diff 原文是事后唯一凭据 (worktree 跑完即毁)。
      const patch = await $`git diff`.cwd(fx.root).quiet().nothrow();
      writeFileSync(`${OUT}/${arm.name}-rep${rep}.patch`, patch.stdout.toString());
      const tools = toolMetrics(res);
      const econ = cacheEcon(res);
      rows.push({
        arm: arm.name,
        rep,
        runnable: score.runnable,
        tscClean: score.tscClean,
        singleFail: score.singleFail,
        crossFail: score.crossFail,
        violations: await checkConstraints(fx.root),
        emptyHanded: tools.emptyHanded,
        leavesOut: econ.leavesOut,
        effectiveInput: econ.effectiveInput,
        wallSec: (Date.now() - t0) / 1000,
        insertions: ins,
        deletions: del,
        failedNames: score.failedNames,
      });
      const r = rows[rows.length - 1]!;
      log(
        r.runnable
          ? `  → tsc ${r.tscClean ? '绿' : '红'} · 交叉缺陷 ${r.crossFail} · 单需求缺陷 ${r.singleFail} · 违规 ${r.violations.length} · 空手leaf ${r.emptyHanded} · out ${r.leavesOut} · +${r.insertions}/-${r.deletions} · ${r.wallSec.toFixed(0)}s`
          : `  → ⚠ oracle 跑不起来 (不进分母)。尾巴: ${(score.raw ?? '').slice(-300)}`,
      );
    } catch (e) {
      // fail-open 可以吞异常, 不许吞证据。
      log(`  ✖ ${arm.name} rep${rep}: ${(e as Error).message.slice(0, 300)}`);
    } finally {
      await fx?.cleanup();
    }
  }
}

// ── 报告 ─────────────────────────────────────────────────────────────────────
const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const lines = ['\n════════ 并行 vs 顺序 (coupled-layout · oracle 判决, 无判官) ════════', `座位 ${SEAT} · reps ${REPS}`, ''];
for (const arm of arms) lines.push(`${arm.name}: ${arm.note}`);
lines.push('');
for (const arm of arms) {
  const all = rows.filter((r) => r.arm === arm.name);
  const ok = all.filter((r) => r.runnable);
  const dead = all.length - ok.length;
  if (!ok.length) {
    lines.push(`${arm.name.padEnd(12)} 无可用轮次 (跑了 ${all.length}, 全部 oracle 起不来) —— **不是 0 缺陷**`);
    continue;
  }
  lines.push(
    [
      `${arm.name.padEnd(12)}`,
      `交叉缺陷 ${mean(ok.map((r) => r.crossFail!)).toFixed(2)}`,
      `单需求缺陷 ${mean(ok.map((r) => r.singleFail!)).toFixed(2)}`,
      `tsc绿 ${ok.filter((r) => r.tscClean).length}/${ok.length}`,
      `违规 ${ok.reduce((s, r) => s + r.violations.length, 0)}`,
      `空手leaf ${ok.reduce((s, r) => s + r.emptyHanded, 0)}`,
      `out ${Math.round(mean(ok.map((r) => r.leavesOut)))}`,
      `有效in ${Math.round(mean(ok.map((r) => r.effectiveInput)))}`,
      `改动 +${Math.round(mean(ok.map((r) => r.insertions)))}/-${Math.round(mean(ok.map((r) => r.deletions)))}`,
      `墙钟 ${mean(ok.map((r) => r.wallSec)).toFixed(0)}s`,
      dead ? `⚠ 另有 ${dead} 轮 oracle 起不来 (不进分母)` : '',
    ]
      .filter(Boolean)
      .join(' · '),
  );
  const names = [...new Set(ok.flatMap((r) => r.failedNames))];
  if (names.length) lines.push(`  ↳ 红过的用例: ${names.slice(0, 6).join(' | ')}`);
}
lines.push(
  '',
  '读法 (判据是**跑之前**写死的, 见本文件头):',
  '  ① P 的交叉缺陷显著高于 C  → 「隔离的 agent 破坏彼此前提」在本仓成立;',
  '  ② 三臂交叉缺陷都是 0      → 这批需求不够耦合, **量的是尺子**, 加难度重来,',
  '                             不许读成「并行没问题」;',
  '  ③ P 两格一起输            → 机制不是耦合是别的, 假说没被证实;',
  '  ④ S 赢 C 但 out 明显更高  → 是预算不是拓扑。',
  '  P→C 的差 = 顺序本身值多少; C→S 的差 = 单 owner/全上下文再加多少。',
  '',
  truncs.length ? `全程截断 ${truncs.length} 次 → ${[...new Set(truncs)].join(' | ')}` : '全程无截断',
);
const report = lines.join('\n');
process.stdout.write(report + '\n');
writeFileSync(`${OUT}/report.md`, report);
writeFileSync(`${OUT}/rows.json`, JSON.stringify(rows, null, 2));
log(`  → 写入 ${OUT}/`);
