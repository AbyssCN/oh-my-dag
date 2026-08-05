/**
 * no-graph-baseline —— **臂可见文本**的唯一切法(2026-08-05)。
 *
 * ## 它治的是一条活着的泄题通道
 *
 * `*-task.md` 里混着两种东西:给**臂**看的题面,和给**人**看的夹具注记
 * (答案清单在哪个文件、参考答案的 commit hash、防泄题登记)。而 harness 是整份读进去当 prompt 的,
 * 于是注记**逐字进了臂的视野**。三份题面都中招,其中 f1 那条最难看 ——
 * 它把参考答案的 40 位 git 对象 id 连同「**不许给臂看**」这句话一起交给了臂。
 *
 * 记忆里记着实测后果:有跑真的去 `cat` 了被点名的清单文件。
 * 「跨对互读答案」那条通道 2026-08-04 已堵(答案移出仓树),**这条是同一形态的另一条** ——
 * 只堵一条等于没堵。
 *
 * ## 机制:哨兵行以下不进 prompt
 *
 * 注记仍然留在同一个文件里(人读题面时就该看见它们),但**排在哨兵之后**,
 * 由本函数切掉。为什么不是"另开一个 notes 文件":两份文件会漂,而题面与它的防泄题登记漂开
 * 恰恰是最坏的一种 —— 登记还在,题面已经换了。
 *
 * ⚠ **臂与闸共用这一个函数**。各写一份切法,就会出现"闸查的是切过的、臂拿到的是没切的",
 * 而那正是这条通道第一次逃掉的方式。
 */
import { readFileSync } from 'node:fs';

/** 哨兵行:它**以及它之后**的所有内容都不进臂可见文本。 */
export const HARNESS_NOTE_SENTINEL = '<!-- harness-only:以下为夹具注记, 不进臂可见文本 -->';

/** 切出臂可见部分(哨兵之前)。没有哨兵 = 整份都给臂 —— 老题面照常工作。 */
export function armVisibleTaskText(raw: string): string {
  const at = raw.indexOf(HARNESS_NOTE_SENTINEL);
  return (at >= 0 ? raw.slice(0, at) : raw).trimEnd();
}

/** 从盘上读一份题面并切好。harness 与闸都走这里。 */
export function readArmVisibleTask(path: string): string {
  return armVisibleTaskText(readFileSync(path, 'utf8'));
}

/**
 * 泄题词表 —— 臂可见文本里**出现即判泄**。
 *
 * 词表刻意窄且具体(评分件名 / 40 位 git 对象 id / 「不许给臂看」这类自指注记),
 * 不做语义判断:这是闸不是判官,宁可漏一个也别在题面上误伤正常措辞。
 */
export const LEAK_PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: 'scoring-artifact', re: /\b[a-z0-9]+-(checklist|registry)\b/i },
  { name: 'git-object-id', re: /\b[0-9a-f]{40}\b/ },
  { name: 'self-referential-note', re: /不许给臂看|臂不可见|参考答案/ },
];
