/**
 * src/harness/session/noun-gate —— 零 LLM 确定性名词闸(从 memory-hub 移植)。
 *
 * 检测摘要/校验输出中编造的名词(hallucinated identifiers/files）。
 * 已知集 = material 归一化 token ∪ git ls-files 路径片段(目录名/文件名/无扩展名,不读文件内容）。
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
  /** 项目根目录,用于 git ls-files 提取路径片段。 */
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
}

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

  // 1. 文件名模式:字母或数字开头,含扩展名(1-6 字母)。
  //    起点用 [A-Za-z0-9] 而非 [A-Za-z]:否则数字前缀文件名(如 session log
  //    `2026-07-06-w603-...md`)被截成字母起点的后缀 `w603-...md`,normalizeNoun
  //    去连字符后与已知集里的全段(带日期前缀)不等 → 误报 novel(连字符文件名分词误伤)。
  const fileRe = /[A-Za-z0-9][A-Za-z0-9_-]*\.[a-z]{1,6}/g;
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

  return [...candidates];
}

// ─── Normalisation ──────────────────────────────────────────────────────────

/**
 * 归一化候选名词:lowercase + 去非字母数字。
 * 确保 `memoryUpdate` ≡ `memory_update` 等价。
 */
function normalizeNoun(noun: string): string {
  return noun.toLowerCase().replace(/[^a-z0-9]/g, '');
}

// ─── Core gate ──────────────────────────────────────────────────────────────

/**
 * 执行 noun-gate 检查。
 *
 * 步骤:
 *   1. 构建已知集(material token ∪ repo 路径片段)
 *   2. 从 text 提取候选名词
 *   3. 归一化比对,收集 novel 名词
 *   4. 按容差判定 pass / fail,可选注入注释标签
 */
export function checkNouns(input: NounGateInput): NounGateResult {
  const { text, material, repoRoot, maxNovel = 3, annotate = true } = input;

  // 1. 构建已知 token 集(已归一化)
  const known = new Set<string>();

  if (material) {
    for (const t of extractTokens(material)) known.add(t);
  }

  if (repoRoot) {
    for (const t of getRepoPathTokens(repoRoot)) {
      known.add(normalizeNoun(t));
    }
  }

  // 2. 提取候选名词
  const candidates = extractCandidateNouns(text);

  // 3. 比对,收集 novel(原样 / lowercase / 归一化 任一命中即 grounded)
  const novelNouns: string[] = [];
  for (const noun of candidates) {
    const norm = normalizeNoun(noun);
    if (norm.length <= 1) continue; // 单字母噪音过滤
    if (!known.has(noun) && !known.has(noun.toLowerCase()) && !known.has(norm)) {
      novelNouns.push(noun);
    }
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

  return { pass, novelNouns: uniqueNovel, annotatedText };
}
