/**
 * src/harness/shell-writes —— 从一条 shell 命令里认出**它可能写了哪些文件**(2026-08-05)。
 *
 * ## 为什么需要它
 *
 * 产物闸的必要条件是「真碰了文件」,而 `filesTouched` 只认**受控写工具**(write/edit/hashline)。
 * agent 用 bash 写(heredoc / 重定向 / `sed -i`)时那一位是空的,闸于是判 `empty-artifact` 失败。
 * 两次真跑两次中招,第一次还连累下游四个复核节点全 skip —— **活是干完了的**。
 *
 * 闸里本来就有一条救援,但它要求节点声明了 `output_path`;conductor 不给就彻底隐形。
 * 本件补的是**候选来源**:既然引擎现在记了 bash 命令原文,就从命令里把写目标认出来。
 *
 * ## ⚠ 它只产**候选**,不产结论
 *
 * 认出来的路径**必须再磁盘核实**(文件在 + 在本节点执行窗口内被改过)才允许救回 ——
 * 与既有 `output_path` 救援**同一条安全性质**:没有盘上证据就不救。
 * 那条性质是这道闸的全部价值(它拦的是 empty-done:自报完成、零改动),放宽它等于把闸拆了。
 *
 * ## 判据刻意窄(窄是设计)
 *
 * 认得出:`> f` / `>> f`(含 `1>` `2>` `&>`)· `tee [-a] f` · `sed -i … f` · `cp/mv … dst` ·
 * `touch f` · **脚本内部的写**(`open(f,'w')` / `Path(f).write_text` / `writeFileSync(f` /
 * `Bun.write(f`,2026-08-05 补)。**认不出**:`git apply`、`patch`、`> "$OUT"` 这类展开后
 * 才知道的目标、目录级 `rsync`。
 * 漏认的后果只是**照旧判失败**(与补这条之前一样,不产生新盲点);而多认一个的后果是
 * 可能救回一个本该失败的节点 —— 所以宁可漏。
 */

import { statSync } from 'node:fs';

/** 明显不是产物的写目标(认出来也直接丢)。 */
const NOT_ARTIFACT = /^\/dev\/|^\/proc\/|^\/sys\/|^-$/;

/** 去掉包裹的引号(`'f'` / `"f"` / `` `f` `` → `f`)。 */
function unquote(tok: string): string {
  const t = tok.trim();
  if (
    t.length >= 2 &&
    ((t[0] === "'" && t.endsWith("'")) || (t[0] === '"' && t.endsWith('"')) || (t[0] === '`' && t.endsWith('`')))
  ) {
    return t.slice(1, -1);
  }
  return t;
}

/**
 * 脚本内部的**写调用** → 第一个捕获组是路径字面量。
 *
 * 判据挂在**写指示器**上,不挂在"引号里像路径"上 —— `open(f)`(只读)刻意不匹配:
 * 模式串必须含 `w`/`a`/`x`,`'r'` / `'rb'` / `'r+'` 一个都进不来。
 */
const INLINE_SCRIPT_WRITES: readonly RegExp[] = [
  // python: open(<path>, <含 w/a/x 的模式>) —— 覆盖 'w' 'wb' 'a' 'x' 'w+' 等
  /\bopen\(\s*("[^"]+"|'[^']+')\s*,\s*(?:mode\s*=\s*)?("[^"]*[wax][^"]*"|'[^']*[wax][^']*')/g,
  // python: Path(<path>).write_text(...) / .write_bytes(...)
  /\bPath\(\s*("[^"]+"|'[^']+')\s*\)\s*\.\s*write_(?:text|bytes)\b/g,
  // node/bun: writeFileSync / appendFileSync / writeFile / appendFile / createWriteStream
  /\b(?:writeFileSync|appendFileSync|writeFile|appendFile|createWriteStream)\(\s*("[^"]+"|'[^']+'|`[^`]+`)/g,
  // bun: Bun.write(<path>, …)
  /\bBun\.write\(\s*("[^"]+"|'[^']+'|`[^`]+`)/g,
];

/** 看起来像个路径的 token(排除选项、变量展开、通配)。 */
function plausiblePath(tok: string): boolean {
  const t = unquote(tok);
  if (!t || t.startsWith('-') || t.includes('$') || t.includes('*') || t.includes('?')) return false;
  return !NOT_ARTIFACT.test(t);
}

/**
 * 一条命令 → 它**可能**写到的路径(去重;不保证存在,也不保证真被写过)。
 *
 * 逐段拆(`;` `&&` `||` `|` 与换行),每段独立认 —— `cat a | tee b` 里只有 `b` 是写目标。
 */
export function shellWriteTargets(command: string): string[] {
  const out = new Set<string>();

  // ⑥ **脚本内部的写**(2026-08-05 补;此前是 SHELL_WRITE_BLIND_SPOTS 里最大的那个漏口)。
  //
  // `python3 - <<PY … open('docs/x.md','w') … PY` 是 agent 最常用的写法之一, 而它的写目标
  // 在脚本体里, 不在任何 shell 写位置上 —— 于是产物闸认不出、照旧判 empty-artifact。那不是
  // 判词问题 (判词 dd301df 已改准), 是**真误杀**。
  //
  // ⚠ **整条命令一起扫, 不进下面的分段循环**: heredoc 体里有换行和 `|`, 分段器会把它切碎。
  // ⚠ **安全性质与 ①~⑤ 逐字相同, 一个字没放宽**: 这里产的仍然只是候选, 调用方 (executor-dag
  //   救援②) 仍要求 ① 文件真在盘上 ② mtime 落在本节点执行窗口内。候选来源仍是**本 leaf 自己
  //   命令里出现的路径**, 并发扇出下不互相认领那条约束没动。
  // ⚠ **只认带写指示器的字面量, 不认"引号里所有像路径的东西"**: 后者会把脚本**读**的路径也
  //   变成候选, 而并发下另一个 leaf 恰好写过它就会被认领 —— 那正是这道闸唯一要拦的东西
  //   (empty-done: 自报完成、零改动)。宁可漏, 不可多认。
  for (const re of INLINE_SCRIPT_WRITES) {
    for (const m of command.matchAll(re)) {
      const p = unquote(m[1]!);
      if (plausiblePath(p)) out.add(p);
    }
  }

  for (const rawSeg of command.split(/\n|;|&&|\|\||\|/)) {
    const seg = rawSeg.trim();
    if (!seg) continue;

    // ① 重定向: `> f` / `>> f` / `1> f` / `2>> f` / `&> f`。**不认 `<`**(那是读)。
    for (const m of seg.matchAll(/(?:^|\s)(?:[0-9]|&)?>{1,2}\s*("[^"]+"|'[^']+'|[^\s;|&]+)/g)) {
      const p = unquote(m[1]!);
      if (plausiblePath(p)) out.add(p);
    }

    const tokens = seg.split(/\s+/).filter(Boolean);
    const bin = tokens[0] ?? '';

    // ② tee [-a] f…  —— 管道尾巴上的写
    if (bin === 'tee') {
      for (const t of tokens.slice(1)) if (plausiblePath(t)) out.add(unquote(t));
    }
    // ③ sed -i … f  —— 原地改; 只有带 -i 才是写
    if (bin === 'sed' && tokens.some((t) => t === '-i' || t.startsWith('-i'))) {
      const last = tokens[tokens.length - 1];
      if (last && plausiblePath(last)) out.add(unquote(last));
    }
    // ④ cp / mv / install: 目标是**最后一个** token
    if (bin === 'cp' || bin === 'mv' || bin === 'install') {
      const last = tokens[tokens.length - 1];
      if (last && plausiblePath(last) && tokens.length >= 3) out.add(unquote(last));
    }
    // ⑤ touch f…
    if (bin === 'touch') {
      for (const t of tokens.slice(1)) if (plausiblePath(t)) out.add(unquote(t));
    }
  }
  return [...out];
}

/**
 * **mtime 与 `Date.now()` 不是同一个钟**的容差(2026-08-05 实测:写完立刻 `stat`,mtime 比写
 * 之前取的时刻还小 **3.58ms**)。严格 `>=` 会把一次刚发生的写判成"窗口外" —— 第一版就是这么
 * 写的,闸当场抓到。取 2s:远大于时钟偏斜,又远小于任何 leaf 的执行时长,所以"一小时前就
 * 存在的文件"仍然核不过。
 */
export const MTIME_SKEW_TOLERANCE_MS = 2_000;

/**
 * 一组命令 → 其中**经盘上核实**的写目标(2026-08-06 抽出)。
 *
 * 核实 = ① 认出来的路径在盘上是个文件 ② 它的 mtime 落在 `[startedAt - 容差, ∞)` 内。
 * 两条缺一不可 —— 少了 ②,一个一小时前就存在的文件会被当成"本节点写的"。
 *
 * ## 为什么抽成一处
 *
 * 这段判据有**两个**消费者,而它们要的东西不同:
 *   · 产物闸的救援②(`executor-dag`)—— 用它**放行**一个 `filesTouched` 为空的节点;
 *   · ⑧.6 运行时写竞争的推断口径 —— 只用它**看见**,不改变任何判定。
 * 两处各写一份必漂,而漂的方向恰恰最坏:救援那条的安全性质(没有盘上证据就不救)
 * 一旦与可见性那条各自演化,就没人说得清某次放行到底核过什么。
 *
 * ⚠ 它产的是**推断**不是事实:`a && b > x` 里 `a` 失败时 `x` 并没有被写,而同窗口另一个
 *   节点写了它就会被认领。调用方必须知道自己拿到的是哪一档证据 —— 这也是 ⑧.6 把严格与
 *   推断分成两套数的原因。
 *
 * @param root 相对路径的解析根(绝对路径原样)。
 * @param startedAt 本节点起跑时刻(ms);容差在函数内部扣。
 * @returns 核实通过的路径,**保持候选原样**(相对的仍是相对的)—— 解析根由调用方掌握。
 */
export function verifiedShellWriteTargets(
  commands: readonly string[],
  opts: { root: string; startedAt: number; statFile?: (p: string) => { isFile: boolean; mtimeMs: number } | null },
): string[] {
  const since = startedAt(opts);
  const stat = opts.statFile ?? defaultStat;
  const out: string[] = [];
  for (const cand of [...new Set(commands.flatMap(shellWriteTargets))]) {
    const abs = cand.startsWith('/') ? cand : `${opts.root}/${cand}`;
    const st = stat(abs);
    // 不在盘上 / 读不到 = 没证据 = 不算。**这条不吞证据**: 没核过的候选不会静默消失 ——
    // 调用方手里仍有命令原文, 判词列得出跑过哪些命令 (同救援② 那条 catch 的注)。
    if (st?.isFile && st.mtimeMs >= since) out.push(cand);
  }
  return out;
}
function startedAt(o: { startedAt: number }): number {
  return o.startedAt - MTIME_SKEW_TOLERANCE_MS;
}
function defaultStat(p: string): { isFile: boolean; mtimeMs: number } | null {
  try {
    const st = statSync(p);
    return { isFile: st.isFile(), mtimeMs: st.mtimeMs };
  } catch {
    return null;
  }
}

/**
 * **明写的判据边界** —— 认不出这些,写在这里免得有人以为它管:
 *
 * 1. **`git apply` / `patch` / 各类打补丁**:目标在补丁内容里,不在命令行上。
 * 2. **`>` 后面带变量或通配**(`> "$OUT"` / `> out/*.md`):展开后才知道,这里不猜。
 * 3. **目录级操作**(`rsync -a src/ dst/`):认出来也是目录不是产物文件。
 * 4. **认不出的脚本写法**:上面 `INLINE_SCRIPT_WRITES` 只列了四种最常用的调用
 *    (`open(…,'w')` / `Path().write_text` / `writeFileSync` / `Bun.write`)。
 *    `shutil.copy` / `os.rename` / `subprocess` 再起一层 shell 之类仍然认不出 ——
 *    **这条边界是收窄了不是消失了**:漏认照旧判失败,不产生新盲点。
 *
 * ⚠ 曾经的第 1 条「脚本内部的写」**已在 2026-08-05 收窄**(见 `INLINE_SCRIPT_WRITES`)。
 *   它此前是这条通道最大的漏口 —— agent 最常用的写法之一,写完了却被判 empty-artifact。
 */
export const SHELL_WRITE_BLIND_SPOTS = [
  'patch-application',
  'expanded-or-globbed-targets',
  'directory-level-copies',
  'uncovered-script-write-calls',
] as const;
