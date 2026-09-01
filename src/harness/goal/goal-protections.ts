/**
 * src/harness/goal/goal-protections —— 从 goal 文本里**机械**提「受保护路径」
 * (SDD D4.2 切片 1 / INV-1)。
 *
 * ## 为什么是机械提取、不做语义理解
 *
 * 2026-09-01 bench solve 全量扫出过两例「题面明文禁止改测试文件, solve 修复轮照样改之
 * 达标」的作弊 (`0a426641` / `407c7415`), prompt 拦不住是本仓已证结论。
 * 散文级的禁令理解拦不住的部分, 防作弊闸还会兜底; 这一层只负责**有路径形态**
 * 的禁令,做成机械闸的入口。
 *
 * ## 提取规则 (D-1: 纯函数 / fail-open / 同句形态)
 *
 * - 命中四档中文禁令动词之一: `不许改动` · `禁止修改` · `不得改动` · `不许改动`。
 * - 同一行内反引号包裹的字符串**全部**视为受保护路径 (bench 题面正是这种形:
 *   `⚠ **不许改动测试文件 \`src/eval/tasks/blocking-forks.test.ts\`**`)。
 * - 无任何命中 → `[]`,与今日逐字节同。
 * - 去重,按文本中首次出现顺序返回。
 */
const FORBIDDEN_VERBS = ['不许改动', '禁止修改', '不得改动', '不许改动'] as const;

/** 一行里有没有任一禁令动词 (子串包含, 大小写敏感按仓默认)。 */
function lineMentionsForbiddenVerb(line: string): boolean {
  for (const v of FORBIDDEN_VERBS) {
    if (line.includes(v)) return true;
  }
  return false;
}

/** 一行里所有反引号包的内容,按出现顺序。 */
function extractBacktickPaths(line: string): string[] {
  const re = /`([^`]+)`/g;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) out.push(m[1]!);
  return out;
}

/**
 * 从 goal 文本里机械提取「不许动」+ 同句反引号路径。
 *
 * @param goalText 完整 goal 文本 (题面 + 任何前缀说明)。
 * @returns 受保护路径数组,首次出现顺序,已去重;无命中返 `[]`。
 */
export function extractProtectedPaths(goalText: string): string[] {
  if (!goalText) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of goalText.split('\n')) {
    if (!lineMentionsForbiddenVerb(line)) continue;
    for (const p of extractBacktickPaths(line)) {
      if (seen.has(p)) continue;
      seen.add(p);
      out.push(p);
    }
  }
  return out;
}