#!/usr/bin/env bun
/**
 * jargon-scan —— 把「写作铁律」的禁词表从散文变成一条命令(纯函数 + 薄 CLI,零模型调用)。
 *
 * ## 它治的是什么
 *
 * 全局写作铁律列了一张「绝对禁止(无场景例外)」的词表,而强制力一直是零。
 * 2026-08-24 第一次量:`src/` `scripts/` `test/` `docs/` 里 **落盘 613 处 / 272 文件**,
 * 其余 21 个词合计约 240 处。**规则写了几个月,词一个没少。**
 *
 * ⇒ 这个脚本只做一件事:把它们**逐处指出来**(文件 + 行号 + 原句 + 换成什么)。
 * 改由人或执行体做,它不改代码 —— 换词要看上下文,机械替换会把「数据落盘」和
 * 「落盘策略」换成一样的东西。
 *
 * ## 两类命中,风险不同,分开印
 *
 * - `comment` —— 注释 / Markdown。改了不影响运行,是大头。
 * - `string` —— **字符串字面量**:判词、日志、prompt 原文。**有测试在断言它们**,
 *   改一处可能连带改测试 —— 所以它单独一档,不许跟注释混在一批里改。
 *
 * ## 刻意不扫的
 *
 * - 单字词 `搞` / `整` / `弄`:会撞上「整数」「调整」「弄清」,误报率高到没人会看。
 *   ⚠ 这不是说它们可以用 —— 是说**这条命令管不了它们**,别把"扫不到"读成"合规"。
 * - **词表自身所在的文件**(`--exclude-list` 里那几个):`.claude/CLAUDE.md` 之类必须
 *   逐字引用禁词才能禁它们。把它们算进来 = 让这条闸永远红。
 * - 仓库副本(`.claude/worktrees/` `.omd/`):同一份代码算 7 遍(2026-08-24 实测,
 *   第一次量就栽在这上面: 落盘"3005 处"其实是 613 处 × 副本)。
 *
 * ## 跑法
 *
 *   bun run scripts/jargon-scan.ts              # 全表, 人读
 *   bun run scripts/jargon-scan.ts --json       # 机读(派工分片用)
 *   bun run scripts/jargon-scan.ts --kind string  # 只看字符串字面量那一档
 *
 * 退出码: 0 = 零命中 · 1 = 有命中。
 */
import ts from 'typescript';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** 禁词 → 换成什么(本义动词)。来源:全局写作铁律的替换表。 */
export const JARGON: Readonly<Record<string, string>> = {
  落盘: '写入磁盘 / 存盘',
  压实: '落实',
  拉通: '沟通清楚',
  拉齐: '统一口径',
  打通: '连接',
  闭环: '收尾 / 形成回路(按本义拆开写)',
  收口: '收尾',
  抓手: '着力点',
  赋能: '支持',
  沉淀: '积累 / 沉积(按本义)',
  打法: '做法',
  组合拳: '一组配套做法',
  击穿: '穿透 / 突破上限(按本义)',
  引爆: '触发',
  撬动: '带动',
  卡位: '占住位置',
  造势: '造声势',
  借势: '借力',
  心智: '认知 / 印象',
  体感: '主观感受',
  搞定: '完成',
  妥了: '完成',
};

/** 仓库副本 + 依赖,一律不进 —— 同一份代码算 7 遍(2026-08-24 实测栽过)。 */
const SKIP_DIRS = new Set(['node_modules', '.git', '.omd', '.claude', 'dist', 'coverage']);

/**
 * 必须逐字引用禁词的文件。算进来 = 这条闸永远红。
 *
 * ⚠ 判据是「**这些字是散文还是数据**」, 不是「这个文件重不重要」:
 * `false-completion.ts` 的正则里有「搞定」, 因为那是**被检测的目标词** —— 谎报完成的人
 * 会写「全部搞定」。2026-08-24 的清扫真的把它换成了「完成」, 于是那道闸从此认不出这一整类;
 * `D-4 谎报完成闸 > 词形变体也命中` 当场红才拦住(已还原)。同理 `harness-prompts.ts`
 * 是发给模型的提示词原文。
 */
export const EXCLUDE_FILES = [
  'scripts/jargon-scan.ts',
  'scripts/jargon-scan.test.ts',
  'src/harness/harness-prompts.ts',
  'src/harness/plan/false-completion.ts',
  // 上一条的**测试侧**: `distill.test.ts:315` 那一行 `['大功告成', '全部搞定', …]` 是喂给
  // `detectCompletionClaims` 的夹具词。实装侧排除了而测试侧没排, 下一次清扫照样会把它改掉,
  // 那时闸仍然绿(测试自己的输入变了), **比上次更难发现**。两侧要一起排。
  'src/harness/review/distill.test.ts',
];

export interface JargonHit {
  file: string;
  line: number;
  word: string;
  /** `comment` = 注释/Markdown · `string` = 字符串字面量(可能被测试断言)。 */
  kind: 'comment' | 'string';
  /** 命中所在整行(裁到 160 字),给人一眼看懂该换成什么。 */
  text: string;
}

/** 一份 `.ts` 里,每个禁词出现处落在字符串字面量里的**行号**集合。 */
function stringLiteralLines(source: string, fileName: string): Set<number> {
  const src = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const lines = new Set<number>();
  const walk = (n: ts.Node): void => {
    if (ts.isStringLiteralLike(n) || ts.isTemplateExpression(n)) {
      const t = n.getText();
      if (Object.keys(JARGON).some((w) => t.includes(w))) {
        const start = src.getLineAndCharacterOfPosition(n.getStart()).line;
        const end = src.getLineAndCharacterOfPosition(n.getEnd()).line;
        for (let i = start; i <= end; i++) lines.add(i + 1);
      }
    }
    ts.forEachChild(n, walk);
  };
  walk(src);
  return lines;
}

/** 扫一份文件。**纯函数**(调用方读盘)—— 判别力可以拿手写样本注入验。 */
export function scanJargon(source: string, fileName: string): JargonHit[] {
  const isTs = fileName.endsWith('.ts');
  const strLines = isTs ? stringLiteralLines(source, fileName) : new Set<number>();
  const hits: JargonHit[] = [];
  source.split('\n').forEach((text, i) => {
    for (const word of Object.keys(JARGON)) {
      if (!text.includes(word)) continue;
      hits.push({
        file: fileName,
        line: i + 1,
        word,
        kind: strLines.has(i + 1) ? 'string' : 'comment',
        text: text.trim().slice(0, 160),
      });
    }
  });
  return hits;
}

export function collectFiles(roots: readonly string[]): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (SKIP_DIRS.has(name)) continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith('.ts') || name.endsWith('.md')) out.push(p);
    }
  };
  for (const r of roots) walk(r);
  return out.filter((f) => !EXCLUDE_FILES.includes(f)).sort();
}

export function scanTree(roots: readonly string[]): JargonHit[] {
  return collectFiles(roots).flatMap((f) => scanJargon(readFileSync(f, 'utf8'), f));
}

if (import.meta.main) {
  const kindArg = process.argv.includes('--kind') ? process.argv[process.argv.indexOf('--kind') + 1] : undefined;
  // `--skip <前缀>`(可重复)—— 给「这一趟不扫台账」这类分批用。
  // ⚠ 它只改**这次看哪些**, 不改判据: 跳过的那些没被判合规, 只是没被问。
  const skips = process.argv.flatMap((a, i) => (a === '--skip' ? [process.argv[i + 1] ?? ''] : []));
  const roots = ['src', 'scripts', 'test', 'docs'];
  let hits = scanTree(roots);
  if (kindArg) hits = hits.filter((h) => h.kind === kindArg);
  if (skips.length > 0) hits = hits.filter((h) => !skips.some((s) => s && h.file.startsWith(s)));
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(hits, null, 1));
  } else {
    const byWord = new Map<string, number>();
    for (const h of hits) byWord.set(h.word, (byWord.get(h.word) ?? 0) + 1);
    for (const h of hits) console.log(`${h.file}:${h.line} [${h.kind}] ${h.word} → ${JARGON[h.word]}\n    ${h.text}`);
    console.log(`\n合计 ${hits.length} 处 / ${new Set(hits.map((h) => h.file)).size} 文件`);
    console.log([...byWord].sort((a, b) => b[1] - a[1]).map(([w, n]) => `${w}=${n}`).join(' '));
  }
  process.exit(hits.length > 0 ? 1 : 0);
}
