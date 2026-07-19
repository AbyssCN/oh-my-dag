/**
 * src/harness/slim/local-plan —— dag-slim 局部遍的 diff 切分 + ConductorPlan 预构造 (纯件, 零 IO)。
 *
 * 程序化建 plan (非 conductor LLM 规划): 每个改动文件一个 inproc leaf (并发) + 一个 synth
 * 汇总节点 (depends_on 全部 leaf), 经 PlanSchema 校验后交 runExecutorDagWithPlan (D-7 预构造
 * 入口, 下游执行机器与 conductor 路径完全一致)。
 *
 * diff hunk 走节点 args.diff 而非 goal — executor-dag 对 goal 有"写文件意图"启发式
 * (中文动词+文件后缀), 原始 diff 内容可能误触把 leaf 判成 file-producer; args 只渲染不被扫描。
 */
import { PlanSchema, type ConductorPlan } from '../conductor-plan';
import { buildLocalPrompt, SYNTH_GOAL } from './prompts';

export interface DiffChunk {
  /** 改动文件路径 (b/ 侧; 删除文件退回 diff --git 头解析)。 */
  file: string;
  /** 该文件的完整 diff 段 (含 diff --git 头)。 */
  chunk: string;
}

/** 局部遍 synth 汇总节点的固定 id (结果提取用)。 */
export const SYNTH_NODE_ID = 'synth';

// ponytail: 单 chunk 60k 字符截断护 leaf context (超限多为产物/lockfile), 需全量时用 --paths 缩窄 diff
const MAX_CHUNK_CHARS = 60_000;

/** unified diff → per-file 段 (按 `diff --git` 边界切)。非 diff 文本 → []。 */
export function splitDiffByFile(diff: string): DiffChunk[] {
  return diff
    .split(/^(?=diff --git )/m)
    .filter((part) => part.startsWith('diff --git '))
    .map((part) => {
      const head = part.match(/^diff --git a\/.+? b\/(.+)$/m)?.[1];
      const plus = part.match(/^\+\+\+ b\/(.+)$/m)?.[1];
      return { file: head ?? plus ?? '(unknown)', chunk: part.trimEnd() };
    });
}

/** 文件路径 → 节点 id 片段 (PlanSchema 的 node key 任意, slug 只为可读)。 */
function slugFile(file: string): string {
  return file.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(-40);
}

/**
 * 预构造局部遍 plan: N 个 per-file inproc leaf + synth (depends_on 全部)。
 * 经 PlanSchema.parse 校验 (弱模型不可信原则同源 — 程序造的也过同一道闸)。
 */
export function buildLocalPlan(chunks: DiffChunk[]): ConductorPlan {
  if (chunks.length === 0) throw new Error('dag-slim: 空 chunk 列表, 无从建局部遍 plan');
  const nodes: Record<string, unknown> = {};
  const ids = chunks.map((c, i) => `chunk-${i + 1}-${slugFile(c.file)}`);
  chunks.forEach((c, i) => {
    const truncated =
      c.chunk.length > MAX_CHUNK_CHARS
        ? `${c.chunk.slice(0, MAX_CHUNK_CHARS)}\n[... dag-slim 截断: 原 ${c.chunk.length} 字符 ...]`
        : c.chunk;
    nodes[ids[i]!] = {
      executor: 'leaf',
      goal: buildLocalPrompt(c.file),
      args: { file: c.file, diff: truncated },
      output_type: 'none',
    };
  });
  nodes[SYNTH_NODE_ID] = { executor: 'leaf', goal: SYNTH_GOAL, depends_on: ids };
  return PlanSchema.parse({
    name: 'dag-slim-local',
    description: 'dag-slim 局部遍: per-file 过度工程审查并发 fan-out + synth 去重汇总',
    nodes,
  });
}
