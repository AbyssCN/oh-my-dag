/**
 * arch/aposd-signals —— APoSD 确定性设计信号 (零 LLM)。dag-deepen 管线的预扫件。
 *
 * 蒸馏自 Ousterhout《软件设计的哲学》里两条**可机器观察**的复杂度症状
 * (标准全文与处置表: docs/reference/aposd-engineering-standard.md):
 *  - computeCoChange: 跨目录文件对反复在同一 commit 出现 = 「两个模块总是同步修改」——
 *    信息泄露/变化放大的教科书判据。输入 = 与 hotspots.ts 同一份注入式 git log 文本。
 *  - scanPassThrough: 透传方法 (原封转发同参调用、不承担任何逻辑) = 浅模块最硬的可检形态。
 *
 * 定位 = **advisory 线索**, 不是裁决: 按闸阶梯 (oracle > hook > checklist > prose) 这两个
 * 检测器今天站 checklist 位 —— 喂给 deepen 扫描叶当核实起点, 不阻塞任何执行路径。
 * 升级到阻塞位须凭事故证据 (真的因它漏了什么), 投机加硬正是闸阶梯明文禁止的。
 * 两个检测器都是纯函数 (注入输入, 不自己跑 git / 不读盘) —— 可测性同 hotspots.ts。
 */
import { CODE_FILE_RE, COMMIT_HEADER_RE, moduleDir } from './hotspots';

// ── 信号一: 跨目录同步修改 (co-change) ────────────────────────────────────────

/** 一对跨目录、反复同 commit 出现的文件 (a < b 字典序, 稳定可测)。 */
export interface CoChangePair {
  a: string;
  b: string;
  /** 同 commit 共现次数 (≥ minCount 才成为信号)。 */
  count: number;
}

export interface CoChangeOptions {
  /** 共现次数门槛 (默认 3 — 两次可能是巧合, 三次是模式)。 */
  minCount?: number;
  /** 返回的信号对上限, 按 count 降序 (默认 12)。 */
  topK?: number;
  /**
   * 单 commit 纳入配对的代码文件数上限 (默认 12)。超过 = 扫荡式改动 (批量重命名/全仓格式化),
   * 对"这两个文件耦合"没有信息量, 只会按 O(n²) 灌噪声 —— 整个 commit 跳过。
   */
  maxCommitFiles?: number;
  /** 文件纳入谓词 (默认 CODE_FILE_RE, 同热点口径)。 */
  include?: (path: string) => boolean;
}

/**
 * 从 `git log --oneline --name-only` 原始输出找跨目录 co-change 对。
 * 同目录共现刻意不算 (同簇一起改 = 正常内聚); 只有**跨目录簇**反复同步 = 「一份知识被切进
 * 两个模块」的嫌疑, 值得 deepen 扫描叶去核实边界是不是划错了。
 */
export function computeCoChange(gitLog: string, opts: CoChangeOptions = {}): CoChangePair[] {
  const minCount = opts.minCount ?? 3;
  const topK = opts.topK ?? 12;
  const maxCommitFiles = opts.maxCommitFiles ?? 12;
  const include = opts.include ?? ((p: string) => CODE_FILE_RE.test(p));

  // 按 commit 切段 (抬头行 = 段界), 段内收纳入谓词过滤后的文件路径。
  const commits: string[][] = [];
  let cur: string[] = [];
  for (const raw of gitLog.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (COMMIT_HEADER_RE.test(line)) {
      if (cur.length) commits.push(cur);
      cur = [];
      continue;
    }
    const path = line.includes(' -> ') ? (line.split(' -> ').pop() ?? line) : line;
    if (include(path)) cur.push(path);
  }
  if (cur.length) commits.push(cur);

  const counts = new Map<string, number>();
  for (const files of commits) {
    const uniq = [...new Set(files)].sort();
    if (uniq.length < 2 || uniq.length > maxCommitFiles) continue;
    for (let i = 0; i < uniq.length; i++) {
      for (let j = i + 1; j < uniq.length; j++) {
        const a = uniq[i]!;
        const b = uniq[j]!;
        if (moduleDir(a) === moduleDir(b)) continue;
        // pair key 分隔符用 NUL 转义: 路径里能出现空格, 出现不了 NUL — 拆回时不歧义。
        const key = `${a}\u0000${b}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
  }

  return [...counts.entries()]
    .filter(([, count]) => count >= minCount)
    .map(([key, count]) => {
      const [a, b] = key.split('\u0000') as [string, string];
      return { a, b, count };
    })
    .sort((x, y) => y.count - x.count || `${x.a}\u0000${x.b}`.localeCompare(`${y.a}\u0000${y.b}`))
    .slice(0, topK);
}

// ── 信号二: 透传方法 (pass-through) ──────────────────────────────────────────

/** 一处疑似透传: `name(args...)` 的整个函数体 = 原封转发同参给 `callee`。 */
export interface PassThroughFinding {
  /** 包装方的函数/方法名。 */
  name: string;
  /** 被转发的调用目标 (含属性链, 如 `this.inner.doIt`)。 */
  callee: string;
  /** 构造起始行 (1-based)。 */
  line: number;
}

/** 会被 `(\w+)\s*\(` 误捕为"函数名"的语言关键字 (`catch (e) { return f(e) }` 是合法惯用法, 不是透传)。 */
const NON_FN_KEYWORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'constructor', 'super', 'new', 'typeof', 'do', 'else', 'await',
]);

/**
 * 函数声明/方法形态: `name(params) { return callee(args); }` (可带修饰词/泛型/返回类型注解)。
 * 参数与实参串用 `[^()]*` —— 含嵌套括号的复杂签名匹配不到, 属刻意保守 (advisory 宁漏勿误)。
 */
const FN_RE =
  /(?:^|[^.\w$])(?:(?:export|async|public|private|protected|static|override)\s+)*(?:function\s+)?([A-Za-z_$][\w$]*)\s*(?:<[^<>]*>)?\(([^()]*)\)\s*(?::\s*[^{;=()]+)?\s*\{\s*return\s+(?:await\s+)?([\w$]+(?:\.[\w$]+)*)\s*\(([^()]*)\)\s*;?\s*\}/g;

/** 箭头形态: `const name = (params) => callee(args)` (表达式体或 `{ return ... }` 块体)。 */
const ARROW_RE =
  /(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?\(([^()]*)\)\s*=>\s*(?:\{\s*return\s+)?(?:await\s+)?([\w$]+(?:\.[\w$]+)*)\s*\(([^()]*)\)\s*;?\s*\}?/g;

/** 参数串 → 参数名序列; 含解构/嵌套等复杂形态解析不了 → null (整条不判, 保守)。 */
function paramNames(src: string): string[] | null {
  const trimmed = src.trim();
  if (!trimmed) return [];
  const names: string[] = [];
  for (const part of trimmed.split(',')) {
    // 剥默认值与类型注解, 只留名字 (顺序: 先斩 `=` 再斩 `:`, 与源码书写顺序一致)。
    const bare = part.split('=')[0]!.split(':')[0]!.trim();
    const m = bare.match(/^(\.\.\.)?([A-Za-z_$][\w$]*)\??$/);
    if (!m) return null;
    names.push(`${m[1] ?? ''}${m[2]}`);
  }
  return names;
}

/** 实参串 → 实参序列; 任何一项不是裸标识符/裸 spread → null (有加工 = 不是透传)。 */
function argNames(src: string): string[] | null {
  const trimmed = src.trim();
  if (!trimmed) return [];
  const names: string[] = [];
  for (const part of trimmed.split(',')) {
    const m = part.trim().match(/^(\.\.\.)?([A-Za-z_$][\w$]*)$/);
    if (!m) return null;
    names.push(`${m[1] ?? ''}${m[2]}`);
  }
  return names;
}

/**
 * 扫一份 TS/JS 源文本找透传方法: 参数被**原样、同序、无加工**转发, 函数体再无其它逻辑。
 * 0 参委托 (`toString() { return this.inner.toString() }`) 刻意不报 —— facade/委托惯用法
 * 太常见, 报了会把 advisory 信号淹成噪声; 判据是"≥1 个被原样转发的参数"。
 */
export function scanPassThrough(source: string): PassThroughFinding[] {
  const findings: PassThroughFinding[] = [];
  const seen = new Set<string>();
  for (const re of [FN_RE, ARROW_RE]) {
    re.lastIndex = 0;
    for (const m of source.matchAll(re)) {
      const [, name, paramsSrc, callee, argsSrc] = m as unknown as [string, string, string, string, string];
      if (NON_FN_KEYWORDS.has(name)) continue;
      const params = paramNames(paramsSrc);
      const args = argNames(argsSrc);
      if (!params || !args) continue;
      if (params.length === 0) continue;
      if (params.length !== args.length) continue;
      if (!params.every((p, i) => p === args[i])) continue;
      // 行号锚到名字本身 (FN_RE 前导会多吃一个字符, 撞上换行会偏一行)。
      const nameOffset = Math.max(0, m[0].indexOf(name));
      const line = source.slice(0, (m.index ?? 0) + nameOffset).split('\n').length;
      const key = `${name}\u0000${line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      findings.push({ name, callee, line });
    }
  }
  return findings.sort((x, y) => x.line - y.line);
}
