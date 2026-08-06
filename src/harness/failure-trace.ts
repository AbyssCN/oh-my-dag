/**
 * src/harness/failure-trace —— **失败节点留下什么痕**(2026-08-06)。
 *
 * ## 它补的洞
 *
 * 失败 checkpoint(issue #4)此前只留 `summary = output.slice(0, 800)`,**没有全文**
 * (盘上实测:150 份非绿 checkpoint,带 `outputText` 的 **0** 份;701 份绿的带 662 份)。
 * 于是事后想问"这次失败该归咎哪个文件 / 哪个节点写的它",手里只有一段被砍过的头。
 *
 * ## ⚠ 动手前量到的两件事,把原本的修法改了形状
 *
 * ① **不是"太短",是"砍错了一头"。** 盘上 63 份真失败(去掉 dep-skip / gate-rejected
 *    这两类本来就没输出的),撞到 800 上限的只有 **2** 份 —— 提高上限只对这 2 份有意义。
 *    而那 2 份恰恰是**全部**丢失诊断信息的那 2 份:它们是 `a && b && c` 链,前两段成功的
 *    刷屏占满了 800 字,真正失败的那一段在**尾巴上**被切掉。
 *    ⇒ 所以这里给的是 {@link failureExcerpt}(**头 + 尾**),不是"把 800 调大"。
 *
 * ② **失败命令自己几乎不写文件。** 拿 `shellWriteTargets` 跑盘上 42 条能取回原文的失败
 *    command 命令:认出写目标 **0** 条 —— 失败的 command 节点压倒性地是**验收命令**
 *    (`grep -q` / `bun test` / `tsc --noEmit` / `git status`),验收命令按定义不写盘。
 *    ⇒ 所以「认出的路径」这一位**不能**取自命令原文的写目标(那一位恒空),
 *      只能取自**失败输出里点名的路径**({@link blamePathCandidates})—— 两者是两件事。
 *    ⚠ 同条件阳性对照拿不到:盘上绿的 command checkpoint 是 **0** 份(`executor-dag`
 *      刻意不给 command 落绿 checkpoint)。所以上面那个 0 只支持"这批失败命令里没有写命令",
 *      不支持"这条通道在生产上有产出"。
 *
 * ## ⚠ 它只进可见性,不参与任何判定
 *
 * 与 `DagNodeResult.writeCandidates` **同一条纪律**:节点成败、产物闸、judge 一律不看它。
 * 这里产的是**推断**(输出里出现一个路径 ≠ 那个路径就是病因),拿它去改判定等于把
 * 一段字符串匹配升格成裁决依据。
 */

import { statSync } from 'node:fs';

/** 失败摘要的默认预算:头 240 + 尾 560 = 800,与改动前 `slice(0, 800)` 同量级(读数板宽度不变)。 */
const HEAD_BUDGET = 240;
const TAIL_BUDGET = 560;

/**
 * 失败输出 → **头 + 尾**摘要(总量 ≈ head + tail,中间省略处留一行标记带省略字数)。
 *
 * 为什么两头都要而不是只要尾:头一段说的是**在跑什么**(命令回显 / 第一条错),
 * 尾一段说的是**判了什么**(退出码、最后一条断言)。只留尾会丢掉"这是哪条命令"的锚。
 *
 * ⚠ `text.length <= head + tail` 时**原样返回** —— 盘上 63 份真失败里 61 份走这条路,
 *   它们的 summary 必须与改动前逐字相同,否则这次改动会把历史读数搅浑。
 */
export function failureExcerpt(text: string, opts?: { head?: number; tail?: number }): string {
  const head = opts?.head ?? HEAD_BUDGET;
  const tail = opts?.tail ?? TAIL_BUDGET;
  if (text.length <= head + tail) return text;
  const omitted = text.length - head - tail;
  return `${text.slice(0, head)}\n…[中间省略 ${omitted} 字, 全文见 checkpoint.outputText]…\n${text.slice(-tail)}`;
}

/** 认得出的源文件后缀(窄是设计:宁可漏认,不要把 `v1.3.14` 这种当路径)。 */
const PATH_TOKEN =
  /(?:[\w.@+-]+\/)*[\w.@+-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|html|css|scss|sh|py|sql|yaml|yml|toml|txt)\b/g;

/** 认出来也直接丢的路径:不是任何节点写的东西。 */
const NOT_BLAMEABLE = /(?:^|\/)(?:node_modules|\.git|\.omd)\//;

/**
 * 失败输出 → **它点名的、且盘上确实存在的**文件路径(去重,保持首次出现序)。
 *
 * 用途是**反查**:拿到路径之后才问得出"这一跑里是谁写的它"。所以判据是
 * ① 长得像源文件路径(后缀白名单)② `root` 下确实是个文件。
 * 核不过就丢 —— **漏认不误认**,与 `shell-writes` 那条同向:多认一个会把无关文件
 * 挂到一次失败的名下,而那正是反查最怕的噪声。
 *
 * ⚠ **不核 mtime**(与 `verifiedShellWriteTargets` 刻意不同):这里问的是"这个路径是不是
 *   仓里的真东西",不是"这个节点是不是刚写过它"。拿 mtime 卡会把 `tsc` 报错点名的
 *   **上游别人写的**文件全部滤掉 —— 而那恰恰是反查最想要的那一类。
 *
 * ⚠ 盘上实测的可达面(2026-08-06,150 份非绿 checkpoint 的 800 字 summary):
 *   真失败 63 份里 27 份(43%)认得出路径;分类差别很大 —— `empty-artifact` 71% ·
 *   `failed` 50% · **`assert-failed` 只有 1/7(14%)**。上一程"数据集答不了"的结论量的
 *   正是最窄的那一格,别把 14% 当成整条通道的可达率,也别把 43% 当成 assert-failed 的。
 *
 * @param root 相对路径的解析根(绝对路径原样)。
 * @param limit 上限(默认 20)—— 一次失败点名几十个文件时,存下来的是噪声不是线索。
 */
export function blamePathCandidates(
  text: string,
  opts: { root: string; limit?: number; statFile?: (p: string) => boolean },
): string[] {
  const limit = opts.limit ?? 20;
  const isFile = opts.statFile ?? defaultIsFile;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(PATH_TOKEN)) {
    const cand = m[0];
    if (seen.has(cand)) continue;
    seen.add(cand);
    if (NOT_BLAMEABLE.test(cand)) continue;
    const abs = cand.startsWith('/') ? cand : `${opts.root}/${cand}`;
    if (!isFile(abs)) continue;
    out.push(cand);
    if (out.length >= limit) break;
  }
  return out;
}

function defaultIsFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}
