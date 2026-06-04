/**
 * dangerous-cmd —— wright 的不可逆命令分类器 (纯函数, fail-closed 安全闸的判断核)。
 *
 * 来源 + 校正: 忠实移植 Wright dev-harness 的 `.claude/hooks/dangerous-cmd-guard.sh` (久经考验, 零误报史)
 * 的 SQL+rm 模式, 再补 CLAUDE.md §安全底线的「不可逆物理破坏」git 组 —— 因为 wright 是**弱模型 + 自主**
 * 执行体, 风险高于 Wright-监督场景, fail-closed 把不可逆操作挡在执行前是承重护栏 (SDD §11.2 tool_call 行)。
 *
 * 设计 (GP-5 约束方案空间): 每条模式带 label+reason, 测试与契约都显式可读; 命中即 dangerous。
 * 整个闸经 WrightHookConfig 可关 (null 逃生; "硬约束配 null 逃生", SDD §11.2)。
 * 边界: 这是**语法层**正则黑名单 (accidental, 忠实移植), 不做语义判断 (那是 verifier/HITL 的活)。
 */

export interface DangerousPattern {
  /** 模式标识 (审计/测试用)。 */
  label: string;
  /** 命中时给 agent 的拦截理由。 */
  reason: string;
  /** 匹配正则 (大小写不敏感)。 */
  re: RegExp;
}

/**
 * 不可逆命令黑名单。改这张表 = 改 wright 的物理破坏底线 (the owner 同意点对应物)。
 * 顺序无关 (任一命中即拦); label 唯一。
 */
export const DANGEROUS_PATTERNS: readonly DangerousPattern[] = [
  // --- SQL 破坏 (忠实移植 dangerous-cmd-guard.sh) ---
  {
    label: 'sql-drop',
    reason: 'DROP TABLE/DATABASE/SCHEMA/COLUMN 不可逆删除结构',
    re: /drop\s+(table|database|schema|column)/i,
  },
  {
    label: 'sql-truncate',
    reason: 'TRUNCATE 清空表数据不可逆',
    re: /truncate\s+/i,
  },
  {
    label: 'sql-delete-unscoped',
    // Codex G2: 加 `$` 堵裸 `DELETE FROM t` (无 ; 无 WHERE = 全表删除)。
    // 不加 `m` flag (Wright override Codex): `m` 会让 `$` 命中多行 scoped delete 的首行末 → 误杀
    // `DELETE FROM t\nWHERE id=5`。无 `m` 的 `$` 只匹配真串尾, 既堵裸删又不误杀多行 scoped。
    reason: 'DELETE FROM 无安全 WHERE (裸命令 / ; / 1=1/true) = 全表删除',
    re: /delete\s+from\s+\w+\s*(;|$|where\s+(1\s*=\s*1|true))/i,
  },
  {
    label: 'supabase-db-reset',
    // Codex G2: 去 `--linked` 限定 —— 本地 `supabase db reset` 在 NAS 同样毁 xihe db。
    reason: 'supabase db reset 重置 db (本地/远端都不可逆)',
    re: /supabase\s+db\s+reset/i,
  },
  // --- 文件系统破坏 ---
  {
    label: 'rm-rf-root',
    // Codex G2: 双 lookahead 断言 r+f 都在 (任意序), 堵 `rm -fr /` flag 顺序绕过。
    reason: 'rm -rf/-fr 作用于根/家目录 = 灾难性删除',
    re: /rm\s+-(?=[a-z]*r)(?=[a-z]*f)[a-z]+\s+(\/|~|\/\*|\$HOME)(\s|$)/i,
  },
  // --- git 不可逆 (CLAUDE.md §安全底线 hard line) ---
  {
    label: 'git-force-push',
    // Codex G2: 加 `-f\b` 分支堵短 flag `git push -f` (极常见绕过)。\b 防 -fe 类误匹配。
    reason: 'git push -f/--force[-with-lease] 覆写已 push 历史不可逆',
    re: /git\s+push\b.*(-f\b|--force(-with-lease)?\b)/i,
  },
  {
    label: 'git-reset-hard',
    reason: 'git reset --hard 丢弃工作区/已提交改动不可逆',
    re: /git\s+reset\s+--hard\b/i,
  },
  {
    label: 'git-clean-force',
    // Codex G2: 双 lookahead 断言 f+d 都在 (任意序), 堵 `git clean -df` flag 顺序绕过。
    reason: 'git clean -fd[x]/-df 删除未跟踪文件不可逆',
    re: /git\s+clean\s+-(?=[a-z]*f)(?=[a-z]*d)[a-z]+/i,
  },
];

export interface CommandVerdict {
  dangerous: boolean;
  /** 命中的模式 label (dangerous=true 时)。 */
  label?: string;
  /** 拦截理由 (dangerous=true 时)。 */
  reason?: string;
}

/**
 * 判一条 shell 命令是否不可逆危险。空/非串 → 放行 (无可判内容)。
 * 命中第一条模式即返 (label+reason 供拦截信息)。
 */
export function classifyCommand(command: string | undefined | null): CommandVerdict {
  if (!command || typeof command !== 'string') return { dangerous: false };
  for (const p of DANGEROUS_PATTERNS) {
    if (p.re.test(command)) {
      return { dangerous: true, label: p.label, reason: p.reason };
    }
  }
  return { dangerous: false };
}
