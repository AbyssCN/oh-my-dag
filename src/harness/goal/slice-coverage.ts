/**
 * S-46 缺片闸 —— 分解表的每一片写集是否**真的有产出**。
 *
 * ## 它补的是哪个洞(与 write-set.ts 严格正交,别合并)
 *
 * `write-set.ts` 判的是「**改了没声明的**」→ orphan。本模块判的是反过来那半:
 * 「**声明了没改的**」→ 缺片。两轴都绿才算「做了、且只做了该做的」。
 *
 * 立它的现场(2026-08-21 P2 那跑,`docs/plan/2026-08-21-夜间汇总.md` §5):
 * 分解表 4 片,盘上只有切片 1 的 2 文件 / 293 行,切片 2/3/4 **一个字都没做**。
 * 而引擎的判词里**一个字都看不出来** —— 冻结判据绿 · 写穿核验 consistent · 终态 `done` ·
 * 写集对账无越界(它只看改了的那些文件,没改的那些它根本不在输入里)。
 * 判据判的是「它做的那部分对不对」,不是「它做了没做全」。
 *
 * ## 五态,不是两态
 *
 * `produced`(声明全命中)/ `partial`(命中一部分)/ `missing`(零命中,**红**)/
 * `reused`(#242 resume 复用:判据已绿零重做,零 diff 是**它该有的样子**)/
 * 空片集 → `verdict:'no-breakdown'`(判不了,**不是绿**)。
 *
 * `partial` 刻意**不红**,同 write-set 的 `ambiguous`:一片声明三个文件而只落两个,
 * 合法成因太多(表里写宽了 / 那个文件本轮无需改)。把它判红会造假 major,
 * 而**假 major 的代价是有人把整条闸关掉** —— S-45 收窄时买过一次的教训。
 * 真正没有合法解释的只有「这一片零产出」。
 *
 * `reused` 是 NULL≠0 纪律在这条闸上的形态:resume 复用的切片零新写与漏做的切片零新写
 * 在 diff 上不可分,分辨靠**调用方声明**(run-goal 的 O-6 探针知道哪些片是复用的),
 * 不靠猜。把复用片从报告里抹掉是另一种抹平 —— 「没产出因为复用」必须印出来。
 *
 * @module
 */
import { globToRegExp } from '../writeset/write-set';
import type { SddSlice } from './sdd-direct';

export type SliceCoverageKind = 'produced' | 'partial' | 'missing' | 'reused';

export interface SliceCoverage {
  readonly id: number;
  readonly name: string;
  readonly kind: SliceCoverageKind;
  /** 分解表声明的写集原文(glob 未展开)。 */
  readonly declared: readonly string[];
  /** 声明项里**有 diff 命中**的那些(不是命中的文件名 —— 一个 glob 可命中多个)。 */
  readonly hit: readonly string[];
}

export interface SliceCoverageReport {
  /** `no-breakdown` = 没有切片可判(判不了 ≠ 零缺片,NULL≠0)。 */
  readonly verdict: 'no-breakdown' | 'reconciled';
  /** 红 = 存在零产出的片。`partial` 不红(有产出)。 */
  readonly red: boolean;
  /** 零产出的片号(INV-1 可定位证据:逐片点名)。 */
  readonly missing: readonly number[];
  /** 部分产出的片号(告警不红)。 */
  readonly partial: readonly number[];
  /** resume 复用的片号(#242:判据已绿零重做,零 diff 合法不红)。 */
  readonly reused: readonly number[];
  readonly slices: readonly SliceCoverage[];
}

/**
 * @param slices    分解表切片(`parseBreakdown` 的产物;它保证每片写集非空,故本模块不为空写集
 *                  写分支 —— 一个打不着的分支就是一条永远绿的闸)。
 * @param diffFiles 跑后工作树改动,仓相对路径。与 `attributeWriteSet` **同一份输入**,
 *                  别各收各的:两轴读的必须是同一个盘,否则两个判词能互相矛盾而没人看得出来。
 * @param reused    #242 resume 复用的片号(调用方声明 —— run-goal 的 O-6 探针裁的「verify 当前
 *                  已绿」那批)。这些片零 diff 是复用的定义而不是缺片;省略 = 空集,行为逐字节不变。
 */
export function coverSlices(
  slices: readonly SddSlice[],
  diffFiles: readonly string[],
  reused?: ReadonlySet<number>,
): SliceCoverageReport {
  if (slices.length === 0) return { verdict: 'no-breakdown', red: false, missing: [], partial: [], reused: [], slices: [] };
  const covered: SliceCoverage[] = slices.map((s) => {
    // 声明项按 glob 语义匹配(写集列允许 `src/x/**`),复用 write-set.ts 那一份实现 ——
    // 第二份 glob 实现意味着两轴对同一条路径可以判出不同结果。
    const hit = s.writeSet.filter((decl) => {
      const re = globToRegExp(decl);
      return diffFiles.some((f) => f === decl || re.test(f));
    });
    // 复用片即使有 diff 命中也判 reused —— 命中来自 owner 人工修绿那类图外改动,
    // 不是本轮实装的产出(实装节点已降为 command 重验,由构造零写)。hit 原样记录当证据。
    const kind: SliceCoverageKind = reused?.has(s.id)
      ? 'reused'
      : hit.length === 0 ? 'missing' : hit.length === s.writeSet.length ? 'produced' : 'partial';
    return { id: s.id, name: s.name, kind, declared: s.writeSet, hit };
  });
  const missing = covered.filter((c) => c.kind === 'missing').map((c) => c.id);
  return {
    verdict: 'reconciled',
    red: missing.length > 0,
    missing,
    partial: covered.filter((c) => c.kind === 'partial').map((c) => c.id),
    reused: covered.filter((c) => c.kind === 'reused').map((c) => c.id),
    slices: covered,
  };
}

/** 一行人可读摘要(挂 goal 引擎 summary 行;红时点名缺哪几片,INV-1 不吞证据)。 */
export function describeSliceCoverage(r: SliceCoverageReport): string {
  if (r.verdict === 'no-breakdown') return '无分解表';
  const done = r.slices.length - r.missing.length - r.partial.length - r.reused.length;
  const tail =
    (r.partial.length ? ` · 部分产出 ${r.partial.length} [片 ${r.partial.join(', ')}]` : '') +
    (r.reused.length ? ` · 复用 ${r.reused.length} [片 ${r.reused.join(', ')}]` : '');
  if (r.red) return `缺片 ${r.missing.length}/${r.slices.length} [片 ${r.missing.join(', ')}]${tail}`;
  return `${done}/${r.slices.length} 片有产出${tail}`;
}
