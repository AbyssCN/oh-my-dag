/**
 * src/harness/memory/staleness —— 代码锚的**零 LLM 陈旧闸** (L2, 2026-08-28)。
 *
 * ## 它解决的问题
 *
 * `omd.pattern` 的 `source_event_id` 指向 session 或 run,**不指向代码**。而库里那 81 条
 * pattern 满是「leaf 档位判据」「executor 该怎么派」这类主张 —— 它们的真值取决于代码,
 * 代码天天变,今天没有任何机制知道哪条已经烂了。读侧只能靠人一条条读。
 *
 * 这一层把它做成机械判据:主张携带 `evidence: [{path, sha}]`,读的时候重算一次 sha 比对。
 * 零模型调用,零 token,毫秒级。
 *
 * ## 为什么是**降权**不是**删**
 *
 * OpenWiki 敢直接标 stale 并重写,是因为它的 claim 是「auth 在 login.py 第 40 行」这种
 * **位置性**断言 —— 文件一改,断言就可能不成立。omd 的 pattern 是**方法论**断言:
 * 「大内容进 prompt 不进工具环」不会因为 `executor-dag.ts` 改了一行就失效。
 * 所以证据变化在这里只是**该复核的信号**,不是判词。把它做成删除会开始误杀真教训。
 *
 * ## 四种状态互不折叠 (仓规坑① NULL ≠ 0 ≠ 不适用)
 *
 * | 状态 | 含义 | 为什么不能折进别的 |
 * |---|---|---|
 * | `unanchored` | 这条 fact 没有 evidence 字段 | 「没锚」≠「锚着且没变」。既有 81 条全是这个 —— 折进 fresh 会让陈旧闸看起来 100% 绿 |
 * | `anchored-fresh` | 全部 anchor 的 sha 对得上 | — |
 * | `anchored-stale` | 至少一个 anchor 的文件在, 但 sha 变了 | 唯一真的"该复核" |
 * | `anchored-missing` | 至少一个 anchor 读不到, 且没有 stale 的 | 换仓根 / worktree / 文件被删都会读不到。**那不是"证据变了"** —— 折进 stale 会让换一次 checkout 就全库告警 |
 *
 * 混合时的优先级: `stale` > `missing` > `fresh` —— 有一个真变了就以它为准。
 *
 * @module
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { MemoryHit } from './types';

/** 单个 anchor 的判词。 */
export type EvidenceVerdict = 'fresh' | 'stale' | 'missing';

/** 一条 fact 的整体判词 (四态, 见模块头注的表)。 */
export type FactStaleness = 'unanchored' | 'anchored-fresh' | 'anchored-stale' | 'anchored-missing';

export interface EvidenceCheck {
  path: string;
  /** 写入当时记下的指纹。 */
  expected: string;
  /** 这一刻重算的指纹; 读不到文件 = `null` (**不是空串**)。 */
  actual: string | null;
  /** `actual === null` 时读不到的**原因原文**; 读到了 = `null`。见 `fingerprintFile` 的注。 */
  why: string | null;
  verdict: EvidenceVerdict;
}

export interface StalenessReport {
  staleness: FactStaleness;
  /** 逐个 anchor 的明细; `unanchored` 时是空数组。 */
  checks: EvidenceCheck[];
}

/**
 * 文件内容指纹 —— sha256 前 16 hex。读不到 (不存在/权限/是目录) 返 `null`。
 *
 * ⚠ 口径与 `continuity/checkpoint-manager.ts:610` 的 `hashArtifact` **逐字相同**,但刻意
 * **不 import 它**: 那个模块是 DAG run 的 resume 存档管理器, 从记忆层反向依赖它会把
 * `CheckpointManager` 和它那份 28k 行的 continuity 类型拖进记忆层的图里。三行的重复
 * 换一条正确的依赖方向, 划算。改口径时两边一起改 —— 本文件的测试钉了具体位数。
 */
export interface FingerprintResult {
  /** sha256 前 16 hex; 读不到 = `null`。 */
  sha: string | null;
  /** 读不到的原因原文 (ENOENT / EACCES / EISDIR …); 读到了 = `null`。 */
  why: string | null;
}

/**
 * 文件内容指纹 + **读不到时的理由**。
 *
 * 理由这一列不是装饰: 「文件被删了」「换了 worktree 所以不在这个根下」「权限不够」在读侧都表现为
 * 拿不到指纹, 而处置完全不同。塌成一个裸 `null` 之后就永远分不开了 (仓规坑① NULL≠0≠不适用),
 * 而且那个 `catch` 会变成一个**吞证据**的 catch (仓规坑②)。所以理由跟着返回值走, 不进日志 ——
 * 这条路每次 recall 每个 anchor 都跑一遍, 记日志只会把真信号淹掉。
 */
export function fingerprintFile(absPath: string): FingerprintResult {
  try {
    return { sha: createHash('sha256').update(readFileSync(absPath)).digest('hex').slice(0, 16), why: null };
  } catch (err) {
    return { sha: null, why: err instanceof Error ? err.message : String(err) };
  }
}

/** 只要指纹不要理由的便捷面。要分辨"为什么读不到"用 {@link fingerprintFile}。 */
export function fileFingerprint(absPath: string): string | null {
  return fingerprintFile(absPath).sha;
}

/** fact 上可能有的 evidence 列 (schema 是 optional, 老行没有这一列)。 */
interface MaybeAnchored {
  evidence?: readonly { path: string; sha: string }[];
}

/**
 * 判一条 fact 的陈旧度。**纯读**:只读文件, 不写库、不改 fact。
 *
 * @param root 仓根绝对路径 —— anchor 的 path 是仓相对的, 在这里拼成绝对路径。
 */
export function checkStaleness(fact: unknown, root: string): StalenessReport {
  const anchors = (fact as MaybeAnchored)?.evidence;
  if (!anchors || anchors.length === 0) return { staleness: 'unanchored', checks: [] };

  const checks: EvidenceCheck[] = anchors.map((a) => {
    // 绝对路径在写侧就被 schema 拒了; 真出现说明是旁路写入 —— 当 missing 而不是拿它去读盘
    // (拿绝对路径读别人机器上的文件, 判出来的"fresh"没有意义)。
    const { sha: actual, why } = isAbsolute(a.path)
      ? { sha: null, why: '绝对路径不可移植 — 旁路写入, 拒判' }
      : fingerprintFile(join(root, a.path));
    const verdict: EvidenceVerdict = actual === null ? 'missing' : actual === a.sha ? 'fresh' : 'stale';
    return { path: a.path, expected: a.sha, actual, why, verdict };
  });

  if (checks.some((c) => c.verdict === 'stale')) return { staleness: 'anchored-stale', checks };
  if (checks.some((c) => c.verdict === 'missing')) return { staleness: 'anchored-missing', checks };
  return { staleness: 'anchored-fresh', checks };
}

/**
 * 读侧降权系数。**只降 `anchored-stale`** ——
 *   - `unanchored` 不降: 库里 81/81 条 pattern 都没锚, 降它等于把整个召回面压平, 什么信息都没有;
 *   - `anchored-missing` 不降: 换一次 worktree 就全体 missing, 降它等于惩罚换目录;
 *   - `anchored-fresh` 不升: 升 fresh 与降 stale 在排序上等价, 但升会让"有锚"本身变成排名优势,
 *     诱导写手乱挂锚换排名。只罚不奖, 方向是对的那边。
 *
 * 0.5 = 让一条陈旧命中大约掉到相邻两条之后, 而不是掉出结果集。**它仍然会被看见**,
 * 只是带着标签 —— 判据是"提醒复核", 不是"当它不存在"。
 */
export const STALE_RANK_FACTOR = 0.5;

export interface AnnotatedHit extends MemoryHit {
  staleness: FactStaleness;
  checks: EvidenceCheck[];
  /** 降权后的排序分 (`rrf` 原值不动 —— 原始读数不许被覆盖)。 */
  rankScore: number;
}

/**
 * 给一批召回命中标上陈旧度并按降权后的分重排。
 *
 * `rrf` 保持原值:那是检索器的读数,降权是读侧策略。两者塌成一个数之后,
 * "它排低是因为检索器不喜欢它"和"它排低是因为证据变了"就永远分不开了。
 */
export function annotateStaleness(hits: readonly MemoryHit[], root: string): AnnotatedHit[] {
  return hits
    .map((h) => {
      const r = checkStaleness(h.fact, root);
      return {
        ...h,
        staleness: r.staleness,
        checks: r.checks,
        rankScore: r.staleness === 'anchored-stale' ? h.rrf * STALE_RANK_FACTOR : h.rrf,
      };
    })
    .sort((a, b) => b.rankScore - a.rankScore);
}

/** 读侧标签 (给模型看的一行前缀)。`unanchored` 返空串 —— 不给多数派加噪声。 */
export function stalenessLabel(s: FactStaleness): string {
  switch (s) {
    case 'anchored-stale':
      return ' ⚠证据已变';
    case 'anchored-missing':
      return ' ?证据读不到';
    case 'anchored-fresh':
      return ' ✓证据未变';
    case 'unanchored':
      return '';
  }
}
