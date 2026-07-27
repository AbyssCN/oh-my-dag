/**
 * executor 能力读数 (owner 2026-07-28) —— 把"指令遵循 / 工具调用 / 改动质量"变成**确定性数字**。
 *
 * 这套 eval 与 council 那套的根本差别: **代码有 oracle**。council 要请判官 (还得防自判污染、量判官噪声),
 * 而这里编译器、测试、git diff 就是judge —— 判决可复现、零成本、不会放水。
 * 所以能测的东西也更硬: 不是"看起来好不好", 是"过没过、改了几行、有没有违规"。
 */
import { $ } from 'bun';
import type { ExecutorDagResult, LeafResult } from '../../harness/executor-dag-types';

// ── 指令遵循: 把散文约束变成可判的谓词 ────────────────────────────────────────
/**
 * 一条**植入 prompt 的硬约束** + 它的确定性判据。
 * 关键设计: 约束必须写进 SPEC (模型看得见), 判据必须不靠模型 (grep/git/AST)。
 * 违规 = 模型看见了规则却没遵守 —— 这正是"指令遵循"要量的东西。
 */
export interface Constraint {
  id: string;
  /** 写进 SPEC 给模型看的原话。 */
  instruction: string;
  /** 在 workdir 上跑, 返回 true = **违规**。 */
  violated: (root: string) => Promise<boolean>;
}

const gitDiffFiles = async (root: string): Promise<string[]> => {
  const r = await $`git diff --name-only`.cwd(root).quiet().nothrow();
  return r.stdout.toString().trim().split('\n').filter(Boolean);
};

/** 通用约束集: 每条都是真实项目里常给、且常被无视的那类。 */
export const STANDARD_CONSTRAINTS: readonly Constraint[] = [
  {
    id: 'no-new-deps',
    instruction: '不要新增任何 npm 依赖 —— package.json 的 dependencies/devDependencies 必须逐字不变。',
    violated: async (root) => (await gitDiffFiles(root)).includes('package.json'),
  },
  {
    id: 'no-test-edit',
    instruction: '不要修改任何 *.test.ts —— 测试是契约, 让它变绿的唯一办法是改实现。',
    violated: async (root) => (await gitDiffFiles(root)).some((f) => f.endsWith('.test.ts')),
  },
  {
    id: 'no-ts-ignore',
    instruction: '不要用 @ts-ignore / @ts-expect-error / as any 绕过类型 —— 类型错要真修。',
    violated: async (root) => {
      const r = await $`git diff -U0`.cwd(root).quiet().nothrow();
      const added = r.stdout
        .toString()
        .split('\n')
        .filter((l) => l.startsWith('+') && !l.startsWith('+++'));
      return added.some((l) => /@ts-ignore|@ts-expect-error|as any\b/.test(l));
    },
  },
  {
    id: 'no-skip-test',
    instruction: '不要 skip/only 任何测试用例 (it.skip / describe.skip / .only)。',
    violated: async (root) => {
      const r = await $`git diff -U0`.cwd(root).quiet().nothrow();
      const added = r.stdout
        .toString()
        .split('\n')
        .filter((l) => l.startsWith('+') && !l.startsWith('+++'));
      return added.some((l) => /\b(it|test|describe)\.(skip|only)\b/.test(l));
    },
  },
];

/** 跑一遍约束, 回违规 id 列表 (空 = 全遵守)。 */
export async function checkConstraints(
  root: string,
  constraints: readonly Constraint[] = STANDARD_CONSTRAINTS,
): Promise<string[]> {
  const out: string[] = [];
  for (const c of constraints) {
    try {
      if (await c.violated(root)) out.push(c.id);
    } catch {
      /* 判据自身出错不算违规 (fail-open, 不冤枉模型) */
    }
  }
  return out;
}

/** 把约束拼成 SPEC 尾巴 —— 模型必须看得见规则, 违规才算"没遵守"而不是"没被告知"。 */
export function constraintsBlock(constraints: readonly Constraint[] = STANDARD_CONSTRAINTS): string {
  return ['\n## 硬约束 (违反任意一条即判不合格)', ...constraints.map((c, i) => `${i + 1}. ${c.instruction}`)].join('\n');
}

// ── 工具调用效率 ──────────────────────────────────────────────────────────────
export interface ToolMetrics {
  /** agent leaf 数。 */
  agentLeaves: number;
  /** 工具调用总次数。 */
  toolCalls: number;
  /** 每个 agent leaf 平均调用次数 —— 高 = 绕路/反复试探。 */
  callsPerLeaf: number;
  /** 声称触碰的文件数。 */
  filesTouched: number;
  /**
   * **空手 leaf**: 跑完 status=done 却一个文件都没碰的 agent leaf。
   * 这是最能说明问题的一个数 —— 模型以为自己干完了, 实际什么都没写 (工具调用失败被它忽略了)。
   */
  emptyHanded: number;
  /** 失败/停摆 leaf 数。 */
  failed: number;
  stalled: number;
}

export function toolMetrics(res: ExecutorDagResult): ToolMetrics {
  const leaves = Object.values(res.results).filter((l: LeafResult) => l.kind === 'agent');
  const toolCalls = leaves.reduce((s, l) => s + (l.toolCalls ?? 0), 0);
  const filesTouched = leaves.reduce((s, l) => s + (l.filesTouched?.length ?? 0), 0);
  return {
    agentLeaves: leaves.length,
    toolCalls,
    callsPerLeaf: leaves.length ? toolCalls / leaves.length : 0,
    filesTouched,
    emptyHanded: leaves.filter((l) => l.status === 'done' && !(l.filesTouched?.length ?? 0)).length,
    failed: Object.values(res.results).filter((l) => l.status === 'failed').length,
    stalled: Object.values(res.results).filter((l) => l.stalled).length,
  };
}

// ── cache 经济学 ──────────────────────────────────────────────────────────────
export interface CacheEcon {
  leavesIn: number;
  leavesOut: number;
  cacheHit: number;
  /** 命中率 = cacheHit / leavesIn。**这是"钉一个模型"相对"多族发散"的核心经济学变量**:
   *  换族 = 换前缀 = 缓存全 miss, 省下的模型差价可能还不够赔进去的 input 全价。 */
  hitRate: number;
  /** 折算 input 成本份额 (命中段按 ~10% 计) —— 相对值, 用于两臂比较。 */
  effectiveInput: number;
}

export function cacheEcon(res: ExecutorDagResult): CacheEcon {
  const { leavesIn, leavesOut, leavesCacheHit } = res.usage;
  return {
    leavesIn,
    leavesOut,
    cacheHit: leavesCacheHit,
    hitRate: leavesIn ? leavesCacheHit / leavesIn : 0,
    effectiveInput: leavesIn - leavesCacheHit * 0.9,
  };
}

/** 一次 run 的完整能力读数。 */
export interface CapabilityRow {
  arm: string;
  task: string;
  rep: number;
  /** tsc 是否零错。 */
  tscClean: boolean;
  /** 过测比例 0..1。 */
  pass: number;
  violations: string[];
  tools: ToolMetrics;
  cache: CacheEcon;
  wallSec: number;
  /** 改动面 (行) —— 同样修好, 改 12 行比改 300 行强。 */
  insertions: number;
  deletions: number;
  strayFiles: string[];
  families: string;
}
