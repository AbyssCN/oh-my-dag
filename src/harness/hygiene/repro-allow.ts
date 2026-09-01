/**
 * src/harness/hygiene/repro-allow —— 分诊产出的 `reproCmd` 白名单闸 (契约 D-3 / INV-5)。
 *
 * 分诊叶由非 SOTA 执行体 (M3) 跑, 它给的 `reproCmd` 会被证伪节点**真执行**。
 * 于是这条闸不是礼貌检查, 是边界: fail-closed —— 不在白名单里的一律拒, 拒了不许重试
 * (重试不会让白名单变宽, 换一条合法命令或升 owner 改白名单)。
 *
 * 两道判据, **顺序是判据不是风格**:
 *   ① 前缀 ∈ 白名单 —— 先判这个, 于是 `rm -rf x` 的拒因是「白名单」而不是别的;
 *   ② 无 shell 元字符 —— `ugrep ... > out.txt` 前缀合法但会写盘, 拒因是「重定向」。
 * 顺序倒过来, GWT-5 头两条的 reason 会互换, 人看到的拒因就不是真正的那一条。
 */

/**
 * 允许的命令前缀 (只读)。**逐条都要说得出为什么是只读的** ——
 * 加一条之前先问它有没有写盘的开关 (如 `sed -i`, 所以只放 `sed -n`)。
 */
export const REPRO_ALLOW_PREFIXES = [
  'ugrep ',
  'grep ',
  'rg ',
  'bfs ',
  'bun test ',
  'bunx tsc --noEmit',
  'git log',
  'git show',
  'git grep',
  'git diff',
  'wc ',
  'cat ',
  'head ',
  'tail ',
  'sed -n ',
  'ls ',
] as const;

/**
 * 禁止的 shell 元字符 —— 有任何一个就拒。
 * 这里**不做精细解析**: 分辨「这个 `|` 是管道给只读命令还是管道给 tee」需要一个 shell 解析器,
 * 而一个解析错误就是一次写盘。宽的拒绝规则代价是偶尔多出一张票, 窄的代价是改坏仓库。
 */
export const REPRO_FORBIDDEN_CHARS = ['>', '<', '|', ';', '&', '$', '`', '\n'] as const;

/** 元字符 → 人读拒因 (GWT-5 逐字要求头两条含「白名单」/「重定向」)。 */
function forbiddenReason(ch: string): string {
  if (ch === '>' || ch === '<') return '重定向';
  if (ch === '|') return '管道';
  if (ch === ';' || ch === '&') return '命令串接';
  return '命令替换';
}

/** 单条命令 → 放行 / 拒 (带拒因原文, 拒因要让人知道该改哪里)。 */
export function reproAllowed(cmd: string): { ok: true } | { ok: false; reason: string } {
  const trimmed = cmd.trim();
  if (!trimmed) return { ok: false, reason: 'reproCmd 为空 — 白名单要求一条真的只读命令' };
  const prefix = REPRO_ALLOW_PREFIXES.find((p) => trimmed.startsWith(p));
  if (!prefix) {
    return {
      ok: false,
      reason: `不在白名单: "${trimmed.split(/\s+/)[0]}" — 合法前缀 = ${REPRO_ALLOW_PREFIXES.join(' · ')}`,
    };
  }
  const bad = REPRO_FORBIDDEN_CHARS.find((ch) => trimmed.includes(ch));
  if (bad) {
    return { ok: false, reason: `含 shell 元字符 "${bad}" (${forbiddenReason(bad)}) — 只读命令不需要它` };
  }
  return { ok: true };
}
