/**
 * harness/dag/blame-attribution —— **闸红归因**(#145 提议 5 Phase B1,2026-08-17)。
 *
 * ## 它要回答的那一个问题
 *
 * 闸红了,红的判词是一坨 tsc/vitest 输出。提议 5 的返修环想做的是
 * 「**把错误原文回喂写它的那个 leaf**」—— 而那要求先答得出:**这一行诊断是谁写的文件?**
 *
 * 两边的料都已经有了,这里只是把它们 join 起来:
 *   · 诊断行里点名的路径 → `blamePathCandidates`(已有,且**已核过盘上确实是文件**)
 *   · 谁写了哪些文件     → 每个节点的 `filesTouched`(已有)
 *
 * ## ⚠ 本模块**只观测,不路由**——这一版是尺子,不是闸
 *
 * 它存在的**全部目的**是先量一个数,再决定 B2/B3 那个形状成不成立。
 * 因为 `failure-trace.ts` 里已经有一条对这个方向不利的实测:
 *
 * > 真失败 63 份里 27 份(43%)认得出路径;分类差别很大 ——
 * > `empty-artifact` 71% · `failed` 50% · **`assert-failed` 只有 1/7(14%)**
 *
 * 而 `assert-failed` **恰恰就是闸红这一格**。14% 的可达率下,定向返修是修不动的。
 *
 * ⚠ 但那个 14% 有两个已知的口径问题,所以它**不能直接拿来否掉 B2**:
 *   ① 它量在 **800 字 summary** 上,不是全文(`outputText` 那条通道是后来才有的);
 *   ② n = 7。
 * tsc 的输出几乎每一行都带文件名 —— 先验上 14% 极可能是"量了被截断的头"的产物。
 * **这正是必须重量一次的理由,也正是本模块不直接接进返修环的理由**:
 * 拿一个口径存疑的旧数去否掉一个方向,和拿它去支持一个方向,是同一种错。
 *
 * ## 三个桶,不是两个(NULL ≠ 0 ≠ 不适用)
 *
 * | 桶 | 含义 | 它对 B2 说明什么 |
 * |---|---|---|
 * | `byWriter` | 这行点名的文件,本跑里有节点写过 | **定向返修够得着的那部分** |
 * | `foreign`  | 点名了盘上真实存在的文件,但**本跑没人写过它** | 够不着 —— 病根在本跑之外(既有代码 / 别的轮) |
 * | `pathless` | 没点名任何盘上真实存在的文件 | 多是汇总行(`Found 58 errors.`),无害噪声 |
 *
 * 把 `foreign` 和 `pathless` 合成一个 "unattributed" 就废了这把尺子:
 * 前者说"这个形状不成立",后者说"这行本来就不用归因"—— **结论相反**。
 */
import { blamePathCandidates } from '../failure-trace';
import type { LeafResult } from './types';

/** 一个写者名下的诊断行。 */
export interface WriterBlame {
  nodeId: string;
  /** 点名了该写者产物的诊断行原文(保持出现序)。 */
  lines: string[];
}

export interface BlameAttribution {
  byWriter: WriterBlame[];
  /** 点名了真实文件、但本跑没有写者认领 —— **B2 够不着的那部分**。 */
  foreign: string[];
  /** 没点名任何真实文件(汇总行 / 空行已滤)。 */
  pathless: string[];
  /** 分母:参与归因的非空行总数。 */
  linesTotal: number;
}

/** 上限:一坨 5000 行的 vitest 输出没必要逐行 stat,前 N 行足够定形状。 */
const MAX_LINES = 400;

/**
 * 诊断文本 → 三桶。**纯判断 + 一次 stat**,零模型、零启发式。
 *
 * `results` 给的是本跑全部节点(用它们的 `filesTouched` 建反查表);`root` 是相对路径的根。
 *
 * ⚠ 路径匹配用**子串包含**而不是解析诊断格式:tsc / vitest / eslint 的行格式各不相同,
 * 而"这一行里出现了那个路径"对三家都成立。代价是**可能少认**(写者报的路径与诊断里
 * 那一份写法不同时),而少认只会让命中率**偏低** —— 对一把用来决定"要不要做 B2"的尺子,
 * 偏保守是对的方向:它不会把一个不成立的形状量成成立的。
 */
export function attributeBlame(
  text: string,
  results: Readonly<Record<string, LeafResult>>,
  opts: { root: string; statFile?: (p: string) => boolean },
): BlameAttribution {
  // 反查表: 写者路径 → nodeId。同一文件多个写者时**记先出现的那个** ——
  // 这一版不解决多写者归属(那是 serializeWriteRaces 的战场), 只求别把行丢了。
  const owner = new Map<string, string>();
  for (const r of Object.values(results)) {
    for (const p of r.filesTouched ?? []) {
      const rel = p.startsWith(`${opts.root}/`) ? p.slice(opts.root.length + 1) : p;
      if (!owner.has(rel)) owner.set(rel, r.id);
    }
  }

  const byWriter = new Map<string, string[]>();
  const foreign: string[] = [];
  const pathless: string[] = [];
  let linesTotal = 0;

  for (const raw of text.split('\n').slice(0, MAX_LINES)) {
    const line = raw.trimEnd();
    if (!line.trim()) continue; // 空行不进分母 —— 它既不是命中也不是漏
    linesTotal++;
    let hit: string | undefined;
    for (const [p, nodeId] of owner) {
      if (line.includes(p)) {
        hit = nodeId;
        break;
      }
    }
    if (hit) {
      const arr = byWriter.get(hit) ?? [];
      arr.push(line);
      byWriter.set(hit, arr);
      continue;
    }
    // 没命中写者 → 再问一次「这行到底有没有点名一个真实文件」。
    // 这一问才分得开 foreign(够不着)与 pathless(不用归因), 而那两者结论相反。
    const named = blamePathCandidates(line, {
      root: opts.root,
      limit: 1,
      ...(opts.statFile ? { statFile: opts.statFile } : {}),
    });
    (named.length > 0 ? foreign : pathless).push(line);
  }

  return {
    byWriter: [...byWriter].map(([nodeId, lines]) => ({ nodeId, lines })),
    foreign,
    pathless,
    linesTotal,
  };
}

/**
 * 读数一行(进日志与 observations)。**三个数分开印** —— 合并成一个"命中率"就废了这把尺子,
 * 因为 `foreign` 高与 `pathless` 高说明的是相反的事(见文件头那张表)。
 */
export function renderAttribution(a: BlameAttribution): string {
  const owned = a.byWriter.reduce((n, w) => n + w.lines.length, 0);
  const pct = (n: number): string => (a.linesTotal ? `${((n / a.linesTotal) * 100).toFixed(0)}%` : '—');
  return (
    `闸红归因 (只观测): ${a.linesTotal} 行 → ` +
    `写者认领 ${owned} (${pct(owned)}, ${a.byWriter.length} 个节点) · ` +
    `本跑外文件 ${a.foreign.length} (${pct(a.foreign.length)}) · ` +
    `无路径 ${a.pathless.length} (${pct(a.pathless.length)})`
  );
}
