#!/usr/bin/env bun
/**
 * eval-prefix-recoverable —— **跨兄弟前缀缓存能回收多少** (2026-08-03)。
 *
 * ## 它回答哪一位
 *
 * live 实测 cacheHit 83.8%, 而那 83.8% **全是 leaf 内工具循环的** (同一个 leaf 第 2..N 轮吃自己
 * 前面那段)。剩下 16% 的未命中**恰恰就是每个 leaf 的首次调用** —— 也就是跨兄弟共享前缀要打的
 * 那一population。所以"未命中只占 16% 所以不值得"是个错误的读法: 16% 就是靶子的全部。
 *
 * 真正决定值不值的是另一个数: **一个 leaf 的首次 prompt 里, 有多大比例与兄弟逐字相同却排在
 * 分叉点之下**。今天 `buildLeafPrompt` 的分叉点是第二行 `[omd leaf: <id>]`, 它之下的
 * 「上游输出」与「尾部纪律段」对同构兄弟是逐字相同的, 却一个字都进不了共享缓存。
 *
 * ## 为什么是脚本而不是引擎里的埋点
 *
 * 这个数**完全由已经存盘的东西决定** (子节点的 deps + 各自的产出全文), 不需要在每次调用的
 * 热路径上加任何东西。先量后改, 而且量法本身零风险。
 *
 * ## 判据 (给下一个 session)
 *
 * 回收率 = 可回收字符 / 未命中字符。一次跑一个数, **按图形状分开看**:
 *   - 同构兄弟 (deps 逐字相同) 越多、共同上游产出越大 → 回收率越高
 *   - 全是无上游的平铺扇出 → 可回收的只有尾部纪律段那 ~97 token, 回收率贴近 0
 * 攒够几种形状再决定要不要动 `buildLeafPrompt` 的顺序。**别拿一次跑的一种形状下普适结论**
 * (2026-08-03 我就是这么错的一次)。
 *
 * 跑: bun run scripts/eval-prefix-recoverable.ts <runDir | .omd/continuity 下的 runId> [...]
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** 尾部纪律段 —— `buildLeafPrompt` 末尾那段, 全仓逐字相同却排在最后。 */
const TAIL_CHARS = 386;

interface Child {
  id: string;
  deps: string[];
  /** 该节点产出全文的长度 (作为它给下游的上游输出体量)。 */
  outLen: number;
}

function loadRun(dir: string): { runId: string; children: Child[] } | null {
  const dagPath = join(dir, '_dag.json');
  if (!existsSync(dagPath)) return null;
  const dag = JSON.parse(readFileSync(dagPath, 'utf-8')) as {
    runId?: string;
    runtimeNodes?: { id: string; deps?: string[] }[];
  };
  const nodes = dag.runtimeNodes ?? [];
  if (!nodes.length) return null;
  const outLen = new Map<string, number>();
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json') || f.startsWith('_')) continue;
    try {
      const j = JSON.parse(readFileSync(join(dir, f), 'utf-8')) as { nodeId?: string; outputText?: string };
      if (j.nodeId) outLen.set(j.nodeId, (j.outputText ?? '').length);
    } catch {
      /* 坏 checkpoint 不该让整份报告挂掉 */
    }
  }
  return {
    runId: dag.runId ?? dir,
    children: nodes.map((n) => ({ id: n.id, deps: n.deps ?? [], outLen: outLen.get(n.id) ?? 0 })),
  };
}

/**
 * 可回收字符 = Σ_组 (组内成员数 − 1) × (该组共享的上游输出 + 尾部纪律段)。
 *
 * 「组」= deps **逐字相同**的兄弟集合 —— 只有它们的上游输出块才是逐字一致的。
 * 减 1 是因为第一个成员总要付一次全价 (它负责把缓存写进去)。
 */
function recoverable(children: Child[]): {
  groups: { deps: string; members: number; sharedChars: number; recover: number }[];
  total: number;
} {
  const byDeps = new Map<string, Child[]>();
  const outOf = new Map(children.map((c) => [c.id, c.outLen]));
  for (const c of children) {
    const k = JSON.stringify(c.deps);
    byDeps.set(k, [...(byDeps.get(k) ?? []), c]);
  }
  const groups = [...byDeps.entries()].map(([deps, members]) => {
    const depChars = (JSON.parse(deps) as string[]).reduce((s, d) => s + (outOf.get(d) ?? 0), 0);
    const sharedChars = depChars + TAIL_CHARS;
    return { deps, members: members.length, sharedChars, recover: Math.max(0, members.length - 1) * sharedChars };
  });
  return { groups, total: groups.reduce((s, g) => s + g.recover, 0) };
}

const args = process.argv.slice(2);
const roots = args.length ? args : [join(process.cwd(), '.omd', 'continuity')];
const dirs: string[] = [];
for (const r of roots) {
  if (!existsSync(r)) continue;
  if (existsSync(join(r, '_dag.json'))) dirs.push(r);
  else for (const d of readdirSync(r)) if (statSync(join(r, d)).isDirectory()) dirs.push(join(r, d));
}
if (!dirs.length) {
  console.error('没有找到带 _dag.json 的 run 目录');
  process.exit(1);
}

const rows: Record<string, string | number>[] = [];
for (const d of dirs) {
  const run = loadRun(d);
  if (!run) continue;
  const { groups, total } = recoverable(run.children);
  const biggest = [...groups].sort((a, b) => b.recover - a.recover)[0];
  rows.push({
    run: run.runId.slice(0, 8),
    子节点: run.children.length,
    同构组: groups.length,
    最大组: biggest?.members ?? 0,
    可回收字符: total,
    '≈token': Math.round(total / 4),
    最大组共享: biggest?.sharedChars ?? 0,
  });
}
console.table(rows);
console.log(
  '读法: 可回收 = Σ (同构兄弟数−1) × (共同上游产出 + 尾部纪律段 386 字符)。' +
    '\n     它与"未命中 token"相比才是回收率 —— 未命中数从 `.omd/dag-runs.db` 的 leavesIn−leavesCacheHit 取。' +
    '\n     ⚠ 平铺扇出 (兄弟全无上游) 的可回收量贴近 0, 那是图形状使然, 不是这条路不成立。',
);
