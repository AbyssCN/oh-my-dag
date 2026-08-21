/**
 * dangerous-cmd —— omd 的不可逆命令分类器 (纯函数, fail-closed 安全闸的判断核)。
 *
 * 来源 + 校正: 忠实移植 omd dev-harness 的 `.claude/hooks/dangerous-cmd-guard.sh` (久经考验, 零误报史)
 * 的 SQL+rm 模式, 再补 CLAUDE.md §安全底线的「不可逆物理破坏」git 组 —— 因为 omd 是**弱模型 + 自主**
 * 执行体, 风险高于 omd-监督场景, fail-closed 把不可逆操作挡在执行前是承重护栏 (SDD §11.2 tool_call 行)。
 *
 * 设计 (GP-5 约束方案空间): 每条模式带 label+reason, 测试与契约都显式可读; 命中即 dangerous。
 * 整个闸经 OmdHookConfig 可关 (null 逃生; "硬约束配 null 逃生", SDD §11.2)。
 * 边界: 这是**语法层**正则黑名单 (accidental, 忠实移植), 不做语义判断 (那是 verifier/HITL 的活)。
 */

export interface DangerousPattern {
  /** 模式标识 (审计/测试用)。 */
  label: string;
  /** 命中时给 agent 的拦截理由。 */
  reason: string;
  /** 匹配正则 (大小写不敏感)。给了 `match` 时它只当形状文档, 判定以 `match` 为准。 */
  re: RegExp;
  /**
   * 可选谓词 —— 判据需要**一张可读的名单**时用它 (如 `rm-rf-source-dir` 的易失目录白名单)。
   * 给了则 `classifyCommand` 用它代替 `re.test`: 把名单编进正则没人看得懂,
   * 而看不懂的闸没人敢改, 最后要么被绕过要么被关掉。
   */
  match?: (command: string) => boolean;
}

/**
 * **易失目录** —— 递归删它们是每天都在跑的正当清理,`rm-rf-source-dir` 放行这些。
 *
 * 这张表是那条闸的**假阳性阀门**:少一个名字就多一类被误拦的正当命令,而误拦的代价不是
 * "多问一次",是**有人把整条闸关掉**。加名字往这里加,别去放宽正则。
 */
export const EPHEMERAL_DIRS: readonly string[] = [
  'node_modules', 'dist', 'build', 'out', 'coverage', 'target',
  '.next', '.nuxt', '.turbo', '.cache', '.parcel-cache', '.pytest_cache',
  '__pycache__', '.venv', 'venv', 'tmp', 'temp', '.tmp',
];

/** `rm -rf <target>` 的形状(flag 任意序,双 lookahead 保证 r+f 都在,同 `rm-rf-root`)。 */
const RM_RF_TARGET = /rm\s+-(?=[a-z]*r)(?=[a-z]*f)[a-z]+\s+(\S+)/i;

/**
 * 递归 rm ∧ 目标**不在**易失名单里 ∧ 不在 `/tmp` 下 ∧ 不是根/家目录(那几个归 `rm-rf-root`)。
 *
 * 写成**谓词函数**而不是塞进正则:易失名单要能被读、被审、被加,编进正则就没人看得懂,
 * 而看不懂的闸没人敢改,最后要么绕过要么关掉。
 */
export function isRecursiveRmOfSourceDir(command: string): boolean {
  const m = RM_RF_TARGET.exec(command);
  if (!m) return false;
  const raw = m[1]!;
  if (/^\/tmp(\/|$)/.test(raw)) return false; // 约定的临时区, 放行
  const cleaned = raw.replace(/\/\*$/, '').replace(/\/+$/, '');
  // 根 / 家目录归 `rm-rf-root` —— 两条闸报同一件事会让判词打架。
  if (/^(\/|~|\$HOME)$/.test(cleaned)) return false;
  const last = cleaned.split('/').filter(Boolean).pop() ?? '';
  return !EPHEMERAL_DIRS.includes(last);
}

/**
 * 不可逆命令黑名单。改这张表 = 改 omd 的物理破坏底线 (the owner 同意点对应物)。
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
    // 2026-08-14 收紧: 旧 `/truncate\s+/` 打中**任何搜索这个词的命令** —— 2026-08-13 夜实测
    // 误拦 3 次 (`rg TRUNCATE src/`、`grep -e TRUNCATE …`), leaf 撞墙重试白烧轮次。
    // 只认两种真形态: ① 显式 SQL `truncate table …`; ② 语句/引号/管道边界起始的
    // `truncate <参数>` (psql -c "TRUNCATE users"、GNU `truncate -s 0 f` —— 与旧行为同拦)。
    // 判据 (测试钉死): `psql -c "TRUNCATE TABLE users"` 仍拦 ∧ `rg TRUNCATE src/` 放行。
    reason: 'TRUNCATE 清空表数据不可逆',
    re: /truncate\s+table\b|(^|[;"'`(|&])\s*truncate\s+\S/i,
  },
  {
    label: 'sql-delete-unscoped',
    // Codex G2: 加 `$` 堵裸 `DELETE FROM t` (无 ; 无 WHERE = 全表删除)。
    // 不加 `m` flag (omd override Codex): `m` 会让 `$` 命中多行 scoped delete 的首行末 → 误杀
    // `DELETE FROM t\nWHERE id=5`。无 `m` 的 `$` 只匹配真串尾, 既堵裸删又不误杀多行 scoped。
    reason: 'DELETE FROM 无安全 WHERE (裸命令 / ; / 1=1/true) = 全表删除',
    re: /delete\s+from\s+\w+\s*(;|$|where\s+(1\s*=\s*1|true))/i,
  },
  {
    label: 'supabase-db-reset',
    // Codex G2: 去 `--linked` 限定 —— 本地 `supabase db reset` 在 NAS 同样毁 omd db。
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
  {
    label: 'rm-rf-source-dir',
    // 2026-08-21, run e2d204b7 的节点 s4: 一个 leaf 在隔离 worktree 里把整个 `src/` 删了
    // (867 文件 / 253564 行)。而 `rm-rf-root` 只认 `/` `~` `/*` `$HOME` —— 实测 `rm -rf src`
    // 与 `rm -rf $HOME/repos` **全部放行**。这正是「黑名单挡写法不挡能力」那句话的活样本。
    //
    // ⚠ 判据刻意**不是**"任何递归 rm": `rm -rf node_modules` / `dist` / `.next` 是每天都在跑的
    // 正当清理, 拦它们就是造假 major —— **而假 major 的代价是有人把整条闸关掉** (S-45 买过一次)。
    // 所以判据 = 递归 rm ∧ 目标**不在易失名单里**。易失名单显式列在下方 EPHEMERAL_DIRS,
    // 加名字要往那张表里加 —— 显式表比"碰巧不匹配"可审得多。
    //
    // ⚠ 这条**堵不严**, 如实写在这: `find -delete` 由上一条管, 而
    // `python3 -c 'shutil.rmtree(...)'` / `node -e fs.rmSync` / `> file` 一条都拦不住。
    // 真正的边界是 jail 的 worktree, 不是这张表 —— 这条只把最常见、代价最大的那个写法堵上。
    reason: 'rm -rf 递归删除源码目录不可逆 (易失目录如 node_modules/dist 不在此列)',
    re: RM_RF_TARGET,
    match: isRecursiveRmOfSourceDir,
  },
  {
    label: 'find-delete',
    // command-leaf 白名单收了 find/bfs/fd (验证叶要能找产物), 而 `-delete` 是它们自带的递归删除,
    // 不经 rm 因此绕开 rm-rf-root。`-exec rm` 的 `\;` 已被 command-leaf 元字符闸挡, 这里补全另一半。
    reason: 'find/bfs/fd -delete 或 -exec rm 递归删除文件不可逆',
    re: /\b(find|bfs|fd)\b[^\n]*(\s-delete\b|-exec\s+rm\b)/i,
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
    if (p.match ? p.match(command) : p.re.test(command)) {
      return { dangerous: true, label: p.label, reason: p.reason };
    }
  }
  return { dangerous: false };
}
