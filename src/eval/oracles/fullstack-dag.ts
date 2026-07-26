/**
 * fullstack-dag —— **全栈 DAG 端到端 eval** (2026-07-26 owner: "给出一个真正的大规模的 dag,
 * 有多变, 前端后端还有 ui 审核的完整测试")。
 *
 * 与另外两个 eval 的分工:
 *   conductor-modelmix   量"图画得对不对"     (纯 TS 重建任务, 不碰 UI)
 *   agent-leaf-prompt    量"一片叶子干得好不好" (固定图, 只变 prompt 档)
 *   **本件**              量"整条链路合起来能不能交付一个前后端 + 像素证据都齐的东西"
 *
 * 所以这里**不固定图** —— 让 conductor 真分解, 因为要测的正是它会不会画出:
 *   契约节点 → 前后端两簇并行 → render command → attach_media 审查 → 二次审查升档。
 *
 * 量什么 (客观优先, 每一项都不靠 LLM 裁判):
 *   pass          三份契约测试 + whole-project tsc 全绿 (0/1)
 *   shots         真落盘且非空的 PNG 数 —— **UI 证据链有没有真的走通**, 而不是"有个节点自称截了图"
 *   mediaNodes    attach_media 节点数; mediaUpgraded = 其中吃到强档多模态池的数
 *   parallelWidth 图的最大层宽 —— 前后端到底并没并起来 (串成一条线也能过闸, 但那是画错了)
 *   depth/orphans 图形状 (同 scorer 的三量)
 *
 * INV: 串行 · worktree 隔离 + 泄漏护栏 · 报中位 + spread · 网格带噪声地板对照格。
 *
 * 消费:
 *   bun run $FUSANG_HOME/scripts/xihe-tournament.ts src/eval/oracles/fullstack-dag.ts \
 *     [--r 2] [--conductors openai-codex:gpt-5.6-sol,kimi-coding:k3] [--leaf mimo:mimo-v2.5-pro]
 */
import { $ } from 'bun';
import { existsSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { runExecutorDag } from '../../harness/executor-dag';
import type { ExecutorDagResult } from '../../harness/executor-dag';
import { createAgentLeafRunner } from '../../harness/agent-leaf';
import { createCommandLeafRunner, DEFAULT_COMMAND_ALLOWLIST } from '../../harness/command-leaf';
import { extractMediaRefs } from '../../harness/leaf-media';
import { resolveConfiguredPools } from '../../model/role-models';
import { createFullstackFixture, PLANTED_DEFECTS } from '../tasks/fullstack';

interface FsConfig { conductorModel: string; leafModel: string }
interface Candidate<C> { label: string; config: C }
interface TournamentSpec<C> {
  name: string;
  seed(): Candidate<C>[];
  measure(c: Candidate<C>): Promise<{ score: number; detail?: unknown }>;
  direction?: 'max' | 'min';
  concurrency?: number;
  maxRounds?: number;
}

const DEFAULT_CONDUCTORS = ['openai-codex:gpt-5.6-sol', 'kimi-coding:k3'];
const DEFAULT_LEAF = 'mimo:mimo-v2.5-pro';

async function dirtyRealFiles(): Promise<Set<string>> {
  const out = await $`git status --porcelain`.nothrow().quiet();
  return new Set(
    out.stdout.toString().split('\n')
      .map((l) => (l.slice(3).split(' -> ').pop() ?? '').trim())
      .filter((p) => p && !p.startsWith('.omd/')),
  );
}

/** 图的层宽/深度 (同 scorer.graphShape 的判据; 这里另算是因为要连 attach_media 一起统计)。 */
function shapeOf(results: ExecutorDagResult['results']): { depth: number; maxWidth: number; orphans: number } {
  const ids = Object.keys(results);
  if (!ids.length) return { depth: 0, maxWidth: 0, orphans: 0 };
  const idSet = new Set(ids);
  const deps = (id: string) => (results[id]?.deps ?? []).filter((d) => idSet.has(d));
  const level = new Map<string, number>();
  for (let i = 0; i < ids.length; i++) {
    let changed = false;
    for (const id of ids) {
      const want = deps(id).reduce((m, d) => Math.max(m, (level.get(d) ?? 0) + 1), 0);
      if (want !== (level.get(id) ?? 0)) { level.set(id, want); changed = true; }
    }
    if (!changed) break;
  }
  const per = new Map<number, number>();
  for (const id of ids) per.set(level.get(id) ?? 0, (per.get(level.get(id) ?? 0) ?? 0) + 1);
  const consumed = new Set(ids.flatMap(deps));
  return {
    depth: Math.max(...[...level.values()], 0) + 1,
    maxWidth: Math.max(...per.values()),
    orphans: ids.filter((id) => !consumed.has(id) && results[id]?.kind !== 'command').length,
  };
}

/**
 * 从所有节点输出里捞图片路径, 只数**真存在且非空**的 —— 这是 UI 证据链的客观判据。
 * 「有个节点自称截了图」不算数: 引擎里 empty-done 的老病就是这么来的。
 */
function realShots(results: ExecutorDagResult['results'], root: string): number {
  const refs = new Set<string>();
  for (const r of Object.values(results)) {
    for (const ref of extractMediaRefs(r.output ?? '')) {
      if (!/^https?:/i.test(ref)) refs.add(isAbsolute(ref) ? ref : join(root, ref));
    }
  }
  let n = 0;
  for (const p of refs) {
    try { if (existsSync(p) && statSync(p).size > 0) n++; } catch { /* 不存在即不算 */ }
  }
  return n;
}

/**
 * 崩坏召回: 所有 attach_media 节点的输出合起来, 提到了几个**我们亲手种的**缺陷 (0..4)。
 * 关键词匹配是代理指标不是完美 oracle —— 但这四个缺陷无歧义, 看见了几乎不会不说、
 * 没看见也编不出来。哪一条恒为 0 就说明那一类缺陷视觉模型压根看不见, 比总分更有信息。
 */
function defectsCaught(texts: string[]): { total: number; byId: Record<string, number> } {
  const blob = texts.join('\n').toLowerCase();
  const byId: Record<string, number> = {};
  let total = 0;
  for (const d of PLANTED_DEFECTS) {
    const hit = d.hints.some((h) => blob.includes(h.toLowerCase())) ? 1 : 0;
    byId[d.id] = hit;
    total += hit;
  }
  return { total, byId };
}

interface FsRun {
  pass: number;
  shots: number;
  defects: number;
  defectsById: Record<string, number>;
  mediaNodes: number;
  mediaUpgraded: number;
  nodeCount: number;
  depth: number;
  maxWidth: number;
  orphans: number;
  tokens: number;
  wallSec: number;
}

async function measureOnce(cfg: FsConfig, leafTimeoutMs: number): Promise<FsRun> {
  const before = await dirtyRealFiles();
  const fx = await createFullstackFixture();
  const t0 = Date.now();
  try {
    const agentRunner = createAgentLeafRunner({ cwd: fx.root, hashlineEdit: true, leafTimeoutMs, sandboxRoot: fx.root });
    const commandRunner = createCommandLeafRunner({
      allowlist: [...DEFAULT_COMMAND_ALLOWLIST], cwd: fx.root, timeoutMs: 600_000,
    });
    const res = await runExecutorDag(fx.spec, {
      conductorModel: cfg.conductorModel,
      leafModel: cfg.leafModel,
      agentLeafModel: cfg.leafModel,
      agentRunner,
      commandRunner,
      maxFanout: 6,
      warmThenFanout: true,
      oracleCmd: fx.oracleCmd,
      leafSystemPrefix: fx.spec,
    } as Parameters<typeof runExecutorDag>[1]);

    const leaked = [...(await dirtyRealFiles())].filter((p) => !before.has(p));
    if (leaked.length) {
      throw new Error(
        `[eval 泄漏] 改了 worktree 外的真源码: ${leaked.join(', ')} — 废读数。\n` +
          `若你在 eval 运行期间编辑了本仓, 这是**误报**: 护栏拿 git status 前后比对, 分不清 leaf 逃逸与人手编辑。\n` +
          `纪律: eval 跑起来之后别碰工作树 (.omd/ 除外, 它不在比对范围内)。`,
      );
    }

    // 客观闸: 在 worktree 里真跑一次 oracle (不信任图内节点的自述)。
    const gate = await $`sh -c ${fx.oracleCmd}`.cwd(fx.root).nothrow().quiet();
    const shape = shapeOf(res.results);
    // attach_media 节点从 **plan** 读 (res.plan 是执行用的那张图, 已过 stamp), 不靠猜模型名。
    // upgraded = 落在配置的强档多模态池里的那些 —— 直接验"二次审查升档"规则有没有生效。
    const strongMm = new Set(resolveConfiguredPools().multimodalStrong ?? []);
    const mediaIds = Object.entries(res.plan.nodes)
      .filter(([, n]) => (n as { attach_media?: boolean }).attach_media === true)
      .map(([id]) => id);
    const upgraded = mediaIds.filter((id) => {
      const m = res.results[id]?.model ?? (res.plan.nodes[id] as { model?: string }).model;
      return m ? strongMm.has(m) : false;
    });
    const dc = defectsCaught(mediaIds.map((id) => res.results[id]?.output ?? ''));
    return {
      pass: gate.exitCode === 0 ? 1 : 0,
      shots: realShots(res.results, fx.root),
      defects: dc.total,
      defectsById: dc.byId,
      mediaNodes: mediaIds.length,
      mediaUpgraded: upgraded.length,
      nodeCount: Object.keys(res.results).length,
      depth: shape.depth,
      maxWidth: shape.maxWidth,
      orphans: shape.orphans,
      tokens: res.usage.leavesIn + res.usage.leavesOut + res.usage.conductor.in + res.usage.conductor.out,
      wallSec: Math.round((Date.now() - t0) / 1000),
    };
  } finally {
    await fx.cleanup();
  }
}

const median = (xs: number[]): number => {
  const a = [...xs].sort((x, y) => x - y);
  const m = a.length >> 1;
  return a.length % 2 ? a[m]! : (a[m - 1]! + a[m]!) / 2;
};

export default function fullstackDagSpec(opts: Record<string, string> = {}): TournamentSpec<FsConfig> {
  // R 默认 2: 一次全栈 run 是几十分钟, R=3 起步就是半天。要读噪声地板靠对照格, 不靠堆 R。
  const R = Math.max(1, Number.parseInt(opts.r ?? '2', 10) || 2);
  const leafTimeoutMs = opts.leafTimeout ? Math.max(0, Number.parseInt(opts.leafTimeout, 10) || 0) : 1_800_000;
  const conductors = (opts.conductors ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const leafModel = opts.leaf?.trim() || DEFAULT_LEAF;
  const useConductors = conductors.length ? conductors : DEFAULT_CONDUCTORS;

  const grid: Candidate<FsConfig>[] = [
    ...useConductors.map((conductorModel) => ({
      label: `${conductorModel} / ${leafModel}`,
      config: { conductorModel, leafModel },
    })),
    // 噪声地板对照格 (同 agent-leaf-prompt): 复制第一格再跑一遍, 差值即本轮不可读的下限。
    { label: `${useConductors[0]} / ${leafModel} ·control`, config: { conductorModel: useConductors[0]!, leafModel } },
  ];

  return {
    name: 'fullstack-dag',
    seed: () => grid,
    async measure(c) {
      const runs: FsRun[] = [];
      for (let i = 0; i < R; i++) runs.push(await measureOnce(c.config, leafTimeoutMs));
      const med = (f: (r: FsRun) => number) => median(runs.map(f));
      return {
        score: med((r) => r.pass),
        detail: {
          runs: R,
          pass: +med((r) => r.pass).toFixed(2),
          shots: +med((r) => r.shots).toFixed(1), // UI 证据链真走通了没有
          defectsCaught: +med((r) => r.defects).toFixed(1), // 种下的 4 个崩坏抓到几个
          // 逐缺陷命中率: 某一条恒 0 = 那类缺陷视觉模型看不见, 比总分更有信息
          defectRate: Object.fromEntries(
            PLANTED_DEFECTS.map((d) => [d.id, +(runs.reduce((s2, r) => s2 + (r.defectsById[d.id] ?? 0), 0) / R).toFixed(2)]),
          ),
          nodeCount: +med((r) => r.nodeCount).toFixed(1),
          depth: +med((r) => r.depth).toFixed(1),
          maxWidth: +med((r) => r.maxWidth).toFixed(1), // 前后端并没并起来
          orphans: +med((r) => r.orphans).toFixed(1),
          mediaNodes: +med((r) => r.mediaNodes).toFixed(1), // conductor 画出几个看图节点
          mediaUpgraded: +med((r) => r.mediaUpgraded).toFixed(1), // 其中几个吃到强档多模态池
          tokens: Math.round(med((r) => r.tokens)),
          wallSec: Math.round(med((r) => r.wallSec)),
          spread: { pass: runs.map((r) => r.pass), shots: runs.map((r) => r.shots), width: runs.map((r) => r.maxWidth) },
        },
      };
    },
    direction: 'max',
    concurrency: 1,
    maxRounds: 1,
  };
}
