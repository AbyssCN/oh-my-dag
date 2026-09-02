/**
 * harness/write-allow —— **节点只准写自己声明的写集**,判在**写的那一刻**(2026-08-21)。
 *
 * ## 它补的洞
 *
 * 平铺图早就把每片的写集放在节点上了(`goal/sdd-compile.ts` 的 `write_set`),但它今天
 * **只以散文进 prompt**(同文件:「写集 (只许动这些文件): …」)。而本仓的实测结论是
 * **讲道理拦不住** —— 规则写在 prompt 里,执行体照样违反。
 *
 * 现场(run `e2d204b7` 节点 s4):一个 leaf 把隔离 worktree 的整个 `src/` 删了。
 * 事后查,当天所有闸一条都没拦住它:
 *   · `write-set.ts` 是**跑后对账** —— 那时东西已经没了;
 *   · 产物闸问的是「本轮改了文件吗」—— 删也算改;
 *   · `dangerous-cmd` 当时只拦 `rm -rf /`(那半已由 `rm-rf-source-dir` 补上)。
 *
 * 本模块是**写前**那一道:`write` / `edit` 的目标不在声明写集里 → 当场拒。
 *
 * ## 边界(如实写在这,别把它读成"沙箱")
 *
 * 它只管**工具通道**。leaf 的 bash 通道绕得过去 —— `> file`、`python3 -c`、`node -e`
 * 一条都拦不住,那一侧的边界是 jail 的 worktree,不是这张表。
 * 两条各管一段,**都不是全集**,这一点在判词里也要说清,免得下一个人以为写域是密封的。
 *
 * ## 缺席 ≠ 零越界
 *
 * 没有声明写集的节点(conductor 铺图路径 / 没写 `write_set` 的 plan)→ **闸缺席,放行**。
 * 那是「没配这道闸」,不是「这个节点没越界」——本仓 NULL≠0≠不适用 那一条。
 *
 * @module
 */
import { isAbsolute, relative, resolve } from 'node:path';
import { globToRegExp } from './write-set';

export interface WriteAllowVerdict {
  allowed: boolean;
  /** 命中的那条声明(留证:凭什么放行)。`allowed:false` 时为 null。 */
  matched: string | null;
}

/**
 * 目标路径在不在声明写集里。
 *
 * @param target 写目标(绝对路径或相对 `root` 的路径)。
 * @param allow  节点声明的写集(相对仓根的路径或 glob)。**空数组 = 什么都不许写**,
 *               与 `undefined`(闸缺席)是两件事 —— 调用方负责区分,本函数不替它猜。
 * @param root   仓根 / 执行根,用来把 `target` 归一成相对路径。
 */
export function checkWriteAllowed(target: string, allow: readonly string[], root: string): WriteAllowVerdict {
  const abs = isAbsolute(target) ? target : resolve(root, target);
  const rel = relative(root, abs);
  // 根之外的目标不归本闸管 —— 那是 `requireWritable` 的沙箱边界那一条的活。
  // 两条闸报同一件事会让判词打架, 事后没人知道该改哪条 (同 rm-rf-root / rm-rf-source-dir 的分工)。
  if (rel.startsWith('..') || isAbsolute(rel)) return { allowed: true, matched: null };
  const norm = rel.split('\\').join('/');
  for (const decl of allow) {
    const d = decl.trim().split('\\').join('/').replace(/^\.\//, '');
    if (!d) continue;
    if (d === norm) return { allowed: true, matched: decl };
    // glob(`src/**/*.ts`)与"声明的是目录"(`src/harness/session` 覆盖其下全部)两种都认 ——
    // 契约里两种写法都出现过, 只认一种会造出"明明声明了却被拒"的假 major。
    if (globToRegExp(d).test(norm)) return { allowed: true, matched: decl };
    if (norm.startsWith(`${d}/`)) return { allowed: true, matched: decl };
  }
  return { allowed: false, matched: null };
}

/**
 * 拒的判词。**必须把允许的清单原样列出来** —— 只说"越界了"会让执行体反复试同一批路径,
 * 而那正是 spin 熔断吃掉的那些回合(`requireWritable` 那条早就是这么写的,同一条纪律)。
 */
export function describeWriteDenied(target: string, allow: readonly string[], tool: string): string {
  return (
    `BLOCKED 写域越界: ${tool} 的目标 ${target} 不在本节点声明的写集里。` +
    `本节点只许写: ${allow.length > 0 ? allow.join(' · ') : '(空 —— 本节点没有声明任何可写路径)'}。` +
    '要写别的文件, 说明分解表的写集列写漏了 —— 那是契约的问题, 不要绕开它。'
  );
}

/**
 * 并 `writeSet` 与 `outputPath` 成一份写域闸能认的 `allow` (P2d 子修 2, 2026-09-02)。
 *
 * 补的洞: contract-drafting 节点的 `output_path` 是绝对路径 (`config.cwd` 恒为绝对,
 * 见 `assemble.ts:417`), 而本闸的 `allow` 契约(上面 `checkWriteAllowed` 的 doc)是
 * **相对仓根**——绝对声明与相对目标比不上, 造出"明明就是这个节点该产的产物却被拒"的假 major。
 *
 * ⚠ 不在 run-goal.ts 的 prompt 字符串上修 (那是模块头「讲道理拦不住」明文点了名的反模式,
 * 只控制了模型被告知回显什么, 不控制它实际写什么) —— 归一放在这个共用的并集点, 覆盖
 * 任何未来的绝对 `output_path` 生产者, 不论是不是 conductor 自己编的。
 */
export function resolveNodeWriteAllow(
  writeSet: readonly string[] | undefined,
  outputPath: string | undefined,
  root: string,
): string[] {
  const normalizedOutput = outputPath ? (isAbsolute(outputPath) ? relative(root, outputPath) : outputPath) : undefined;
  return [...new Set([...(writeSet ?? []), ...(normalizedOutput ? [normalizedOutput] : [])])];
}
