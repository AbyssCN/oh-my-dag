/**
 * src/harness/session/noun-gate —— 零 LLM 确定性名词闸(从 memory-hub 移植)。
 *
 * 检测摘要/校验输出中编造的名词(hallucinated identifiers/files）。
 * 已知集三来源并集:
 *   ① material 归一化 token
 *   ② git ls-files 路径段 + stem(目录名/文件名/无扩展名)
 *   ③ 按需 `git grep -F` 查仓内文件内容(D-1,补「材料与文件树都缺」漏的那一跳)
 * 候选 = 文件名模式(带扩展名)/ snake_case / camelCase / PascalCase / UPPER_SNAKE。
 * 跳过绝对路径与 URL(防编造而非防外部引用）。
 * 匹配 = 归一化(lowercase + 去非字母数字)后精确 token 相等,非 substring。
 *
 * novel > maxNovel → fail + 错误清单
 * 0 < novel ≤ maxNovel → pass + `<!-- UNGROUNDED: ... -->` 注释(审计信号）
 *
 * 消费者:
 *   W1 session/writer → 硬闸(fail 重写 1 次 → 降级管线)
 *   executor-dag setNounGate() 注入接缝 → 注释 only,不阻塞(可选接线）
 *
 * @module
 */

import { spawnSync } from 'node:child_process';

// ─── Public types ───────────────────────────────────────────────────────────

export interface NounGateInput {
  /** 待检测文本(summary / validation 输出）。 */
  text: string;
  /** 源材料文本,提取已知名词集。 */
  material?: string;
  /** 项目根目录,用于 git ls-files 提取路径片段(同时也是按需 git grep 的工作目录)。 */
  repoRoot?: string;
  /** novel 容差上限,默认 3。 */
  maxNovel?: number;
  /** 是否注入注释标签,默认 true。 */
  annotate?: boolean;
}

export interface NounGateResult {
  /** novel ≤ maxNovel → pass。 */
  pass: boolean;
  /** 编造名词列表(去重）。 */
  novelNouns: string[];
  /** annotate=true 且 novel>0 时注入 <!-- UNGROUNDED/FAIL: ... --> 注释。 */
  annotatedText?: string;
  /**
   * 本次实际查过的来源清单(供 writer 错误信息原样回显,避免写「材料与文件树均未出现」
   * 这种与判法不符的措辞 —— 2026-08-22 S-49)。
   * 仅在 !pass 或 novel>0 时填充,避免给「全绿」调用方加无意义负担。
   */
  sourcesChecked?: string[];
  /**
   * ③ 仓内内容 grep 单次超时/失败时累计的条目(noun + 失败原因),
   * fail-open 但留证 —— 「这条是没查成,不是查过没命中」(D-3)。
   */
  contentLookupsFailed?: Array<{ noun: string; reason: string }>;
}

// ─── Constants ──────────────────────────────────────────────────────────────

/**
 * 按需 `git grep` 候选数封顶值(D-2)。
 *
 * 病态输入(一大段代码贴进 checkpoint)会让候选膨胀成上百个,
 * 把闸变成全仓 N 次扫描,失去「在 LLM 蒸馏这条本就慢的路径上」该有的边际成本。
 *
 * 40 = 与 SDD 预验(D-1c)的最坏情况一致(`git grep -q -F` 单次 24–51ms × 40 ≈ 2 秒);
 * 真实 checkpoint 9 段加起来远不到这个数。
 *
 * 超出封顶部分的候选走老路(只查 ①②),与「没建仓内符号索引」的边际成本曲线一致 —— 不为
 * 防御单个恶意/病态输入陪葬所有正常 checkpoint 的延迟。
 */
export const MAX_GREP_CANDIDATES = 40;

/** ③ 单次 `git grep` 调用的超时(S-49 不愿锁死,但防止触发整条 LLM 蒸馏卡住的阈值)。 */
const CONTENT_GREP_TIMEOUT_MS = 5_000;

// ─── Known set construction ─────────────────────────────────────────────────

/**
 * 从 `git ls-files` 提取路径片段已知集:
 * - 每个路径段(目录名 / 文件名,含扩展)
 * - 无扩展名 stem(如 `agent-leaf` 从 `agent-leaf.ts`)
 *
 * 不读文件内容。git 不可用或超时 → 返回空集(fail-open）。
 */
function getRepoPathTokens(repoRoot: string): Set<string> {
  const tokens = new Set<string>();
  try {
    const proc = spawnSync('git', ['ls-files'], {
      cwd: repoRoot,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10_000,
    });
    if (proc.status !== 0 || proc.error) return tokens;

    for (const line of proc.stdout.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      // 路径按 / 分割,收集每段作为目录/文件名
      const segments = trimmed.split('/');
      for (const seg of segments) {
        if (!seg) continue;
        tokens.add(seg); // 原始段(如 `agent-leaf.ts`)
        // stem:去掉最后一个扩展名
        const dot = seg.lastIndexOf('.');
        if (dot > 0) {
          tokens.add(seg.slice(0, dot)); // 如 `agent-leaf`
        }
      }
    }
  } catch {
    // fail-open:任何异常(git 未安装、权限、超时)不阻断
  }
  return tokens;
}

/**
 * 单次按需 `git grep -F` 查仓内文件内容(来源 ③,D-1)。
 *
 * **为什么是 grep 不是预建索引**:候选只是个位数;建全仓符号表要读全部文件
 * (≈ git ls-files + cat 每个工作树文件),而每次只需回答「这几个词在不在」。
 * `git grep` 用的是索引,常数时间进入,built-in 的不去工作树就地匹配。
 *
 * 用 `--cached`:搜索 index 而非工作树。理由:判据问的是「有没有编造」,commit 进 git
 * 就是真;D-1b 明说「受版本控制的文件里出现过」就算 —— 与「我本地这份 worktree 上还活
 * 动着」是两件事,后者会因 `git checkout` 状态多出噪声。
 *
 * 返回值:
 *   true  = 命中 ≥1 个文件 → 候选 grounded,不再判 novel
 *   false = 调用成功但未命中 → 真的没有
 *   null  = 调用本身失败(git 缺失 / 非 git 目录 / 超时)→ fail-open,留给上游决定
 *
 * **不许吞证据**:失败时把 stderr/stdout 信号原样回传,writer/调用方能看见「这条是没查成
 * 不是查过没命中」(D-3 · INV-10)。
 */
function checkCandidateInRepoContent(
  repoRoot: string,
  candidate: string,
): { hit: boolean; failed: { noun: string; reason: string } | null } {
  const proc = spawnSync('git', ['grep', '--cached', '-q', '-F', '--', candidate], {
    cwd: repoRoot,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: CONTENT_GREP_TIMEOUT_MS,
  });
  if (proc.error) {
    return { hit: false, failed: { noun: candidate, reason: `git grep error: ${proc.error.message}` } };
  }
  if (proc.status === 0) return { hit: true, failed: null };
  if (proc.status === 1) return { hit: false, failed: null };
  // status 2 = git 自身出错(非 git 目录 / 索引损坏等); 取 stderr 第一行作为线索。
  const stderr = (proc.stderr || '').split('\n').find((l) => l.trim().length > 0) || `git exit ${proc.status}`;
  return { hit: false, failed: { noun: candidate, reason: stderr.slice(0, 160) } };
}

/**
 * 从 material 文本提取已知 token 集(标识符保持完整,不拆 _ . -)。
 * 按 /[^a-zA-Z0-9_.\-]+/ 分割(下划线/点/连字符留在 token 内),每个 token 存
 * 原样 + lowercase + 归一化三个版本 → `memory_update` 能 ground `memoryUpdate`。
 */
function extractTokens(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const t of text.split(/[^a-zA-Z0-9_.\-]+/)) {
    if (t.length === 0) continue;
    tokens.add(t);
    tokens.add(t.toLowerCase());
    tokens.add(normalizeNoun(t));
  }
  return tokens;
}

// ─── Candidate extraction ───────────────────────────────────────────────────

/**
 * 从 text 提取候选名词,按以下模式:
 *   - 文件名模式(带扩展名,如 `foo.ts` `my-file.jsx`)
 *   - camelCase / PascalCase
 *   - UPPER_SNAKE_CASE
 *   - snake_case
 *
 * 跳过绝对路径(/...、X:\...)和 URL(http://、https://)。
 * 返回去重列表。
 */
function extractCandidateNouns(text: string): string[] {
  const candidates = new Set<string>();

  // 只跳绝对路径与 URL(防编造非防外部引用;相对路径段保留 ——
  // 其片段会被 git ls-files 已知集 ground,编造的相对路径反而该被抓)。
  function isInsidePathOrUrl(idx: number): boolean {
    // 回溯到本 token 的空白起点,看整个 token 的形状。
    let start = idx;
    while (start > 0 && !/\s/.test(text[start - 1]!)) start--;
    const token = text.slice(start, idx + 40);
    return token.startsWith('/') || token.includes('://');
  }

  // 1. 文件名模式:字母或数字开头 + **已知扩展名** + 词边界。
  //
  //    起点用 [A-Za-z0-9] 而非 [A-Za-z]:否则数字前缀文件名(如 session log
  //    `2026-07-06-w603-...md`)被截成字母起点的后缀 `w603-...md`,normalizeNoun
  //    去连字符后与已知集里的全段(带日期前缀)不等 → 误报 novel(连字符文件名分词误伤)。
  //
  //    ⚠ 扩展名原先写的是 `[a-z]{1,6}`,**两个方向都错**(2026-08-21,交接被抹两次之后查出来):
  //
  //    ① **截断**:任何属性名 ≥7 个小写字母的 `对象.属性` 会被砍成 6 个字符当文件名抽走 ——
  //       `first.message` → `first.messag` · `omd_runs.converged` → `omd_runs.conver` ·
  //       `continuity.repoRoot` → `continuity.repo`。截出来的串在材料与文件树里**必然**找不到,
  //       于是**必然**判成编造。这是一个按构造产生假阳性的判据。
  //    ② **误分类**:`proc.pid` / `parsed.error` / `verdict.reason` 是属性访问,不是文件名,
  //       而这条正则分不出它们和 `foo.ts`。本闸问的是「有没有编造**文件**」,那就只该认文件。
  //
  //    实际后果:一份手写的完整 checkpoint 被机械降级版覆盖了两次(降级版 §1–§9 全是「(无)」)。
  //    **闸误伤的代价不是漏判,是把真东西删了。**
  //
  //    改成已知扩展名白名单 + `\b` 收尾:不截断(整个扩展名要么匹配要么不匹配),
  //    也不再把属性访问当文件。新扩展名要加就往这张表里加 —— 显式表比 `{1,6}` 这种
  //    "碰巧长度对得上"的判据可审得多。
  const fileRe =
    /[A-Za-z0-9][A-Za-z0-9_-]*\.(?:ts|tsx|js|jsx|mjs|cjs|json|jsonl|md|mdx|py|go|rs|rb|java|kt|swift|c|h|cpp|hpp|cs|php|sh|bash|zsh|fish|sql|ya?ml|toml|ini|cfg|conf|env|txt|csv|tsv|html?|css|scss|less|svg|png|jpe?g|gif|webp|pdf|lock|log|db|sqlite3?|zip|tar|gz)\b/g;
  let m: RegExpExecArray | null;
  while ((m = fileRe.exec(text)) !== null) {
    if (!isInsidePathOrUrl(m.index)) {
      candidates.add(m[0]);
    }
  }

  // 2. camelCase / PascalCase(带 \b 词边界 —— 防 `getUserData` 又派生子串 `UserData` 双计)
  const camelRe = /\b[a-z]+[A-Z][a-zA-Z0-9]*\b/g;
  while ((m = camelRe.exec(text)) !== null) {
    if (!isInsidePathOrUrl(m.index)) candidates.add(m[0]);
  }
  const pascalRe = /\b[A-Z][a-z]+[A-Z][a-zA-Z0-9]*\b/g;
  while ((m = pascalRe.exec(text)) !== null) {
    if (!isInsidePathOrUrl(m.index)) candidates.add(m[0]);
  }

  // 3. UPPER_SNAKE_CASE
  const upperSnakeRe = /\b[A-Z][A-Z0-9]+(?:_[A-Z0-9]+)+\b/g;
  while ((m = upperSnakeRe.exec(text)) !== null) {
    candidates.add(m[0]);
  }

  // 4. snake_case(纯小写下划线连接)
  const snakeRe = /\b[a-z]+(?:_[a-z]+)+\b/g;
  while ((m = snakeRe.exec(text)) !== null) {
    candidates.add(m[0]);
  }

  // 保留插入顺序:封顶 40 时按出现顺序截,后到的进老路,顺序稳定 → 测试能断言具体哪一批被查。
  return [...candidates];
}

/**
 * 判一个候选符不符合「文件名模式」,只对这类候选用 D-4 后缀段匹配。
 * 形状 = `<stem>.<ext>`,ext 是已知扩展名白名单,且只含一个点 / 不含 _ 与大写字母
 *   → 排除 camelCase / snake_case / UPPER_SNAKE(那些走精确归一化比对即可)。
 *
 * 这里复用 `extractCandidateNouns` 的同一份扩展名白名单,语义保持一致 —— 同一个名词是
 * 「文件名」还是「符号」,只看它在 text 里长什么样,与 ① 命中与否无关。
 */
const FILE_EXT_WHITELIST_FOR_SUFFIX = new Set(
  // 与上面 fileRe 完全对齐;改一边记得改这边。
  ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'json', 'jsonl', 'md', 'mdx', 'py', 'go', 'rs', 'rb', 'java', 'kt', 'swift',
    'c', 'h', 'cpp', 'hpp', 'cs', 'php', 'sh', 'bash', 'zsh', 'fish', 'sql', 'yml', 'yaml', 'toml', 'ini', 'cfg',
    'conf', 'env', 'txt', 'csv', 'tsv', 'html', 'htm', 'css', 'scss', 'less', 'svg', 'png', 'jpg', 'jpeg', 'gif',
    'webp', 'pdf', 'lock', 'log', 'db', 'sqlite', 'sqlite3', 'zip', 'tar', 'gz'],
);

function isFilenameShape(noun: string): boolean {
  // 不含 _ 与大写字母 → 排除 snake_case / camelCase / PascalCase。
  if (/[_A-Z]/.test(noun)) return false;
  const dot = noun.lastIndexOf('.');
  if (dot <= 0 || dot === noun.length - 1) return false;
  return FILE_EXT_WHITELIST_FOR_SUFFIX.has(noun.slice(dot + 1));
}

// ─── Normalisation ──────────────────────────────────────────────────────────

/**
 * 归一化候选名词:lowercase + 去非字母数字。
 * 确保 `memoryUpdate` ≡ `memory_update` 等价。
 */
function normalizeNoun(noun: string): string {
  return noun.toLowerCase().replace(/[^a-z0-9]/g, '');
}

// ─── D-4 文件名简称后缀段匹配 ────────────────────────────────────────────────

/**
 * 对一个「文件名形状」的候选,在 ② 已知路径段里找是否有一段以 `-<stem>` 结尾。
 *
 * 例:`next-session.md`(stem = `next-session`)在已知集里有
 *   `2026-08-22-next-session.md` → basename 以 `-next-session` 收尾,grouned。
 *
 * INV-8:`-` 前缀是必需的,只准 ground `foo-session`,不许 ground `xsession`。
 * 实现关键:**在原文上做 endsWith,不归一化** —— 归一化会把 `-` 删掉,失去分隔符信息
 * (`xsession` 归一化后仍然是 `xsession`,归一化后看不出「前面是连字符还是别的字母」,
 * 没法挡掉)。保留原 `-` 做分隔符,直接比对 lowercase 后的 basename,以 `-` 分割。
 *
 * **只在 ①③ 都未命中时**作为最后一道兜底 —— 不会与 ③ 抢功,也不会把 `session`(无前缀)
 * 误 ground 成 `xsession`。
 */
function matchesBySuffixStem(knownPathSegments: Set<string>, candidate: string): boolean {
  // candidate stem:`next-session.md` → `next-session`
  const dot = candidate.lastIndexOf('.');
  if (dot <= 0) return false;
  const stem = candidate.slice(0, dot); // `next-session`
  if (stem.length === 0) return false;

  const expected = `-${stem.toLowerCase()}`; // `-next-session`
  for (const seg of knownPathSegments) {
    // 取 basename(最后一段 /-separated),lowercase 后看是否以 `-<stem>` 收尾。
    const slash = seg.lastIndexOf('/');
    const basename = slash >= 0 ? seg.slice(slash + 1) : seg;
    if (basename.toLowerCase().endsWith(expected)) return true;
  }
  return false;
}

// ─── Core gate ──────────────────────────────────────────────────────────────

/**
 * 执行 noun-gate 检查。
 *
 * 步骤:
 *   1. 构建已知集(① material token ∪ ② repo 路径段 + ③ 按需 git grep 仓内内容)
 *   2. 从 text 提取候选名词
 *   3. 归一化比对,收集 novel 名词;每个未在 ①②③ 命中的再走 D-4 简称后缀兜底
 *   4. 按容差判定 pass / fail,可选注入注释标签
 *
 * C-1 INV-1..5 / C-2 INV-6..8 / C-3 INV-9..10 全部在此函数集中体现。
 */
export function checkNouns(input: NounGateInput): NounGateResult {
  const { text, material, repoRoot, maxNovel = 3, annotate = true } = input;

  // 1. 构建已知 token 集(已归一化)
  const known = new Set<string>();
  /** ② 路径段原始形态,供 D-4 后缀匹配 —— 与归一化比对是两条独立通路。 */
  const knownPathSegments = new Set<string>();
  /** 实际查过的来源 —— 仅在出错或 novel>0 时回填,writer 用它更新错误信息。 */
  const sourcesChecked: string[] = [];

  if (material) {
    for (const t of extractTokens(material)) known.add(t);
    sourcesChecked.push('material');
  }

  if (repoRoot) {
    sourcesChecked.push('repo-file-tree');
    for (const t of getRepoPathTokens(repoRoot)) {
      knownPathSegments.add(t); // 保留原始形态给 D-4 用
      known.add(normalizeNoun(t));
    }
  }

  // 2. 提取候选名词 —— 保留顺序,封顶只看前 40
  const allCandidates = extractCandidateNouns(text);
  const grepCandidates = allCandidates.slice(0, MAX_GREP_CANDIDATES);
  const overflowCandidates = allCandidates.slice(MAX_GREP_CANDIDATES);

  /** ③ 仓内内容 grep 失败累计(fail-open 但必须留证,D-3 · S-49 坑②)。 */
  const contentLookupsFailed: Array<{ noun: string; reason: string }> = [];

  /**
   * 单个候选在三来源 + D-4 上的命中状态。
   *
   * 命中优先级:① material → ② repo path(归一化已知集)→ ③ git grep 仓内内容 → D-4 后缀。
   * 任一命中即 grounded,不再降级。
   *
   * **D-3 关键**:③ 调用 `failed`(git 缺失 / 非 git 目录 / 超时)时,候选项**不判 novel** —
   * 这是 fail-open,跟 `getRepoPathTokens` 同语义。所以失败分流到一个明确的非-novel
   * 返回值,而不是被「没有命中」二次降级成 novel(否则会把工具坏掉读成答案没有)。
   * 同时 `failed` 进 `contentLookupsFailed`,留证给判词看 —— 「这条是没查成」(INV-10)。
   */
  function isCandidateKnown(candidate: string, allowGrepLookup: boolean): 'grounded' | 'novel' {
    const norm = normalizeNoun(candidate);
    if (norm.length <= 1) return 'grounded'; // 单字母噪音过滤

    // ① material:原样 / lowercase / 归一化任一命中即 grounded
    if (known.has(candidate) || known.has(candidate.toLowerCase()) || known.has(norm)) return 'grounded';

    // ③ 仓内内容(只在 ①② 都未中且允许查证时跑)
    if (allowGrepLookup && repoRoot) {
      const result = checkCandidateInRepoContent(repoRoot, candidate);
      if (result.failed) {
        contentLookupsFailed.push(result.failed);
        return 'grounded'; // D-3:工具坏 → 不判 novel
      }
      if (result.hit) return 'grounded';
    }

    // D-4 文件名简称后缀段匹配 —— 只对文件名形状的候选生效
    if (isFilenameShape(candidate) && matchesBySuffixStem(knownPathSegments, candidate)) return 'grounded';

    return 'novel';
  }

  // 3. 比对,收集 novel
  const novelNouns: string[] = [];

  if (repoRoot && grepCandidates.length > 0) {
    sourcesChecked.push('repo-file-contents');
  }

  for (const candidate of grepCandidates) {
    if (isCandidateKnown(candidate, true) === 'novel') novelNouns.push(candidate);
  }
  // 封顶外的候选走老路 —— 不再调 git grep(避免病态输入把闸变成全仓 N 次扫描)。
  for (const candidate of overflowCandidates) {
    if (isCandidateKnown(candidate, false) === 'novel') novelNouns.push(candidate);
  }

  // 去重
  const uniqueNovel = [...new Set(novelNouns)];
  const pass = uniqueNovel.length <= maxNovel;

  // 4. 注释标签
  let annotatedText: string | undefined;
  if (annotate && uniqueNovel.length > 0) {
    const tag = pass ? 'UNGROUNDED' : 'FAIL NOUN-GATE';
    annotatedText = `${text}\n<!-- ${tag}: ${uniqueNovel.join(', ')} -->`;
  }

  const needsDiagnostics = !pass || uniqueNovel.length > 0 || contentLookupsFailed.length > 0;
  // sourcesChecked 始终回填(只要本次有任何源头被使用) —— 失败信息诚实是契约硬条,
  // 即便全绿也允许调用方预渲染一份「本次查过哪几个」给 audit log;C-3 INV-9。
  const result: NounGateResult = {
    pass,
    novelNouns: uniqueNovel,
    annotatedText,
    sourcesChecked: sourcesChecked.length > 0 ? [...sourcesChecked] : undefined,
    contentLookupsFailed: contentLookupsFailed.length > 0 ? contentLookupsFailed : undefined,
  };
  return result;
}
