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
 * 认出来的路径**必须再落盘核实**(文件在 + 在本节点执行窗口内被改过)才允许救回 ——
 * 与既有 `output_path` 救援**同一条安全性质**:没有盘上证据就不救。
 * 那条性质是这道闸的全部价值(它拦的是 empty-done:自报完成、零改动),放宽它等于把闸拆了。
 *
 * ## 判据刻意窄(窄是设计)
 *
 * 认得出:`> f` / `>> f`(含 `1>` `2>` `&>`)· `tee [-a] f` · `sed -i … f` · `cp/mv … dst` ·
 * `touch f`。**认不出**:`python3 - <<PY … open('f','w')`、`git apply`、`patch`、任意脚本内部的写。
 * 漏认的后果只是**照旧判失败**(与补这条之前一样,不产生新盲点);而多认一个的后果是
 * 可能救回一个本该失败的节点 —— 所以宁可漏。
 */

/** 明显不是产物的写目标(认出来也直接丢)。 */
const NOT_ARTIFACT = /^\/dev\/|^\/proc\/|^\/sys\/|^-$/;

/** 去掉包裹的引号(`'f'` / `"f"` → `f`)。 */
function unquote(tok: string): string {
  const t = tok.trim();
  if (t.length >= 2 && ((t[0] === "'" && t.endsWith("'")) || (t[0] === '"' && t.endsWith('"')))) {
    return t.slice(1, -1);
  }
  return t;
}

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
 * **明写的判据边界** —— 认不出这些,写在这里免得有人以为它管:
 *
 * 1. **脚本内部的写**(`python3 - <<PY … open(f,'w')` / `bun -e "…writeFileSync…"`)。
 *    这是 agent 最常用的写法之一,也是这条通道最大的漏口。
 * 2. **`git apply` / `patch` / 各类打补丁**:目标在补丁内容里,不在命令行上。
 * 3. **`>` 后面带变量或通配**(`> "$OUT"` / `> out/*.md`):展开后才知道,这里不猜。
 * 4. **目录级操作**(`rsync -a src/ dst/`):认出来也是目录不是产物文件。
 */
export const SHELL_WRITE_BLIND_SPOTS = [
  'inline-script-writes',
  'patch-application',
  'expanded-or-globbed-targets',
  'directory-level-copies',
] as const;
