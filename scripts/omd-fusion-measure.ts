/**
 * scripts/omd-fusion-measure —— SDD v2 S6/D-9 节点融合的**测量闸**(零 LLM 确定性扫描)。
 *
 * 契约(SDD 2026-07-25 D-9):节点融合动手前先量「相邻单消费者轻节点对」在 dag-runs/checkpoint
 * 历史里的真实出现频率;低于门槛永久砍。本脚本即该测量,可随历史积累重跑。
 *
 * ── 立项门槛(预注册,先于看数字写死;改门槛须附理由入 SDD)──
 *   立项 ⟺ fusable pairs ≥ 20(绝对量,工程成本回本线:checkpoint 粒度/dagGeneration 兼容/
 *          事件词表/融合 prompt 四项已知成本)∧ fusable pairs / 真实 run 节点总数 ≥ 15%。
 *
 * ── fusable 判据(D-9 = TFFInfer can_fuse 同构:同设备→同模型)──
 *   边 A→B 记为 fusable pair ⟺
 *   ① B 是 A 的唯一消费者(A 出度 = 1)
 *   ② 双方 executor 皆 inproc(agent/command/map/primitive 不融:工具/CLI/展开语义不可并)
 *   ③ 双方非改文件(checkpoint outputPaths 全空;plan 有 output_type 时非 file/git)
 *   ④ 同模型:双方 checkpoint.model 相等;任一未知按「潜在同」计(D-22 链亲和会给单消费者
 *      同档链 stamp 同模型)但单列 modelUnknown 供审
 *   ⑤ 双方轻:tokenUsage.out < 800 ∧ durationMs < 90s(重节点融了反而伤 checkpoint 粒度)
 *
 * 用法: bun scripts/omd-fusion-measure.ts [repoRoot ...]   (缺省 = cwd)
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const PAIR_ABS_GATE = 20;
const PAIR_RATIO_GATE = 0.15;
const LIGHT_OUT_TOKENS = 800;
const LIGHT_DURATION_MS = 90_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface Cp {
  leafKind?: string;
  status?: string;
  model?: string;
  outputPaths?: string[];
  tokenUsage?: { in: number; out: number } | null;
  durationMs?: number;
}
interface DagMeta {
  runId: string;
  nodeIds: string[];
  deps: Record<string, string[]>;
  plan?: { nodes: Record<string, { executor?: string; output_type?: string; kind?: string }> };
}

interface RunStats {
  runId: string;
  nodes: number;
  edges: number;
  singleConsumerEdges: number;
  fusablePairs: number;
  modelUnknownPairs: number;
  rejects: Record<string, number>;
}

function measureRun(dir: string): RunStats | null {
  const metaPath = join(dir, '_dag.json');
  if (!existsSync(metaPath)) return null;
  const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as DagMeta;
  const cps = new Map<string, Cp>();
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json') || f === '_dag.json' || f === 'prune.json' || f === 'dedup.json' || f === 'stamp.json') continue;
    try {
      const cp = JSON.parse(readFileSync(join(dir, f), 'utf8')) as Cp & { nodeId?: string };
      if (cp.nodeId) cps.set(cp.nodeId, cp);
    } catch {
      /* 坏 checkpoint 跳过 */
    }
  }
  const outDeg = new Map<string, number>();
  const edges: Array<[string, string]> = [];
  for (const [b, ds] of Object.entries(meta.deps ?? {})) {
    for (const a of ds) {
      if (!(meta.deps && a in meta.deps)) continue; // 幻象 dep
      edges.push([a, b]);
      outDeg.set(a, (outDeg.get(a) ?? 0) + 1);
    }
  }
  const planNode = (id: string): { executor?: string; output_type?: string; kind?: string } =>
    meta.plan?.nodes?.[id] ?? {};
  // executor 判定: checkpoint leafKind 优先 (真值), 回退 plan 声明, 再回退 'inproc' (leaf 缺省)。
  const kindOf = (id: string): string => {
    const cp = cps.get(id);
    if (cp?.leafKind) return cp.leafKind;
    const n = planNode(id);
    if (n.kind === 'primitive') return 'primitive';
    return n.executor === 'leaf' ? 'inproc' : (n.executor ?? 'inproc');
  };
  const writesFiles = (id: string): boolean => {
    const cp = cps.get(id);
    if (cp?.outputPaths?.length) return true;
    const t = planNode(id).output_type;
    return t === 'file' || t === 'git';
  };
  const isLight = (id: string): boolean => {
    const cp = cps.get(id);
    if (!cp) return true; // 无 checkpoint (未跑到) → 不因缺数据否掉形状统计
    const out = cp.tokenUsage?.out ?? 0;
    const dur = cp.durationMs ?? 0;
    return out < LIGHT_OUT_TOKENS && dur < LIGHT_DURATION_MS;
  };

  const stats: RunStats = {
    runId: meta.runId,
    nodes: (meta.nodeIds ?? []).length,
    edges: edges.length,
    singleConsumerEdges: 0,
    fusablePairs: 0,
    modelUnknownPairs: 0,
    rejects: {},
  };
  const reject = (why: string): void => {
    stats.rejects[why] = (stats.rejects[why] ?? 0) + 1;
  };
  for (const [a, b] of edges) {
    if ((outDeg.get(a) ?? 0) !== 1) {
      reject('multi-consumer');
      continue;
    }
    stats.singleConsumerEdges++;
    if (kindOf(a) !== 'inproc' || kindOf(b) !== 'inproc') {
      reject('non-inproc');
      continue;
    }
    if (writesFiles(a) || writesFiles(b)) {
      reject('writes-files');
      continue;
    }
    const ma = cps.get(a)?.model;
    const mb = cps.get(b)?.model;
    if (ma && mb && ma !== mb) {
      reject('model-diff');
      continue;
    }
    if (!isLight(a) || !isLight(b)) {
      reject('heavy');
      continue;
    }
    stats.fusablePairs++;
    if (!ma || !mb) stats.modelUnknownPairs++;
  }
  return stats;
}

const roots = process.argv.slice(2).length ? process.argv.slice(2) : [process.cwd()];
const all: RunStats[] = [];
for (const root of roots) {
  const contDir = join(root, '.omd', 'continuity');
  if (!existsSync(contDir)) continue;
  for (const run of readdirSync(contDir)) {
    if (!UUID_RE.test(run)) continue; // 测试残留 (run1 等) 不入样本
    const s = measureRun(join(contDir, run));
    if (s) all.push(s);
  }
}

const sum = (f: (s: RunStats) => number): number => all.reduce((acc, s) => acc + f(s), 0);
const totalNodes = sum((s) => s.nodes);
const totalPairs = sum((s) => s.fusablePairs);
const ratio = totalNodes > 0 ? totalPairs / totalNodes : 0;
const verdict =
  totalPairs >= PAIR_ABS_GATE && ratio >= PAIR_RATIO_GATE
    ? '立项 (双门槛皆过)'
    : `不立项 (门槛: pairs≥${PAIR_ABS_GATE} ∧ ratio≥${PAIR_RATIO_GATE}; 实测 pairs=${totalPairs}, ratio=${(ratio * 100).toFixed(1)}%)`;

console.log('── S6/D-9 节点融合测量 (相邻单消费者轻节点对) ──');
for (const s of all) {
  console.log(
    `${s.runId.slice(0, 8)}  nodes=${String(s.nodes).padStart(2)}  edges=${String(s.edges).padStart(2)}  ` +
      `singleConsumer=${String(s.singleConsumerEdges).padStart(2)}  fusable=${s.fusablePairs}` +
      (Object.keys(s.rejects).length ? `  rejects=${JSON.stringify(s.rejects)}` : ''),
  );
}
console.log(`\n合计: runs=${all.length} nodes=${totalNodes} edges=${sum((s) => s.edges)} ` +
  `singleConsumer=${sum((s) => s.singleConsumerEdges)} fusable=${totalPairs} (model 未知 ${sum((s) => s.modelUnknownPairs)})`);
console.log(`fusable/nodes = ${(ratio * 100).toFixed(1)}%`);
console.log(`\n裁决: ${verdict}`);
