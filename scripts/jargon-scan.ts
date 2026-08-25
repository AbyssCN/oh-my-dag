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
 * - **决定了不扫的那几处**(台账 / 已发表文章 / 滚动交接稿):见 {@link SKIP_PREFIXES},
 *   理由逐条写在那里。⚠ 「不扫」≠「合规」—— 那是"为什么不值得扫", 不是"这些词是对的"。
 *
 * ## 跑法
 *
 *   bun run scripts/jargon-scan.ts              # 全表, 人读
 *   bun run scripts/jargon-scan.ts --json       # 机读(派工分片用)
 *   bun run scripts/jargon-scan.ts --kind string  # 只看字符串字面量那一档
 *   bun run scripts/jargon-scan.ts --files a.ts b.ts  # 只扫写集文件(leaf 检查用)
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
 * **决定了不扫的范围**(owner 裁,2026-08-24)。理由逐条写在这里,不写在调用行上 ——
 * 写在调用行上,下一个人跑裸命令会看见一堆命中,把「已决定不扫」读成「还没扫的欠账」。
 *
 * ⚠ 「不扫」不等于「合规」。这里记的是**为什么不值得扫**,不是「这些用词是对的」。
 */
export const SKIP_PREFIXES: ReadonlyArray<{ prefix: string; why: string }> = [
  {
    prefix: 'docs/plan/',
    why: '带日期的台账, 里面逐字引用了 commit message —— 而 commit 改不了。改文档只会让两边漂, 且它是历史记录不是活文档。该做的是以后写的用对词, 不是回头改旧账。',
  },
  {
    prefix: 'docs/articles/',
    why: '已发表的文章。改了就和外面流传的版本对不上, 而其中一处还是系列标题。',
  },
];

/** 单个文件的同类决定(不成前缀的)。 */
const SKIP_FILES: ReadonlyArray<{ file: string; why: string }> = [
  {
    file: 'docs/session/_NEXT.md',
    why: '滚动交接文件, 每次 session 收尾都重写 —— 扫它等于扫一份马上会被覆盖的稿子。',
  },
];

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
  // SDD s1 切片 1: --files 入口的测试, 落盘/抓手/收口 都是夹具字面量, 同 `jargon-scan.test.ts` 口径。
  'scripts/jargon-scan.files.test.ts',
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
  return out.filter((f) => !isJargonExempt(f)).sort();
}

/**
 * 这份文件该不该被禁用词闸问。
 *
 * **单一实现**: 全树扫(`collectFiles`)与**写入那一刻**的边界闸
 * (`agent-tools.ts` 的 `requireNoJargon`)共用它。分两处各写一遍的话,
 * 豁免语义会各长各的 —— 那正是本仓要杀的形态。
 *
 * 判据是三张已裁的表, 一张都不新增:
 *   - `EXCLUDE_FILES`: 必须逐字引用禁用词的文件(禁用词表自身、谎报完成闸的目标词表)
 *   - `SKIP_PREFIXES`: 台账与已发表文章(逐字引用了改不了的 commit message)
 *   - `SKIP_FILES`: 滚动交接稿
 *
 * ⚠ 与 `scanFiles` 的分野: 那个入口**刻意不应用**豁免(调用方是引擎, 文件由它自己挑,
 * 喂错了该响亮地红而不是被静默吞掉)。这里是「自己走文件树 / 自己判要不要拦」的场合。
 */
export function isJargonExempt(file: string): boolean {
  return (
    EXCLUDE_FILES.includes(file) ||
    SKIP_PREFIXES.some((s) => file.startsWith(s.prefix)) ||
    SKIP_FILES.some((s) => s.file === file)
  );
}

export function scanTree(roots: readonly string[]): JargonHit[] {
  return collectFiles(roots).flatMap((f) => scanJargon(readFileSync(f, 'utf8'), f));
}

/**
 * 只扫给定的若干文件 —— 给 leaf 检查用(写集局部入口)。**不**应用 `EXCLUDE_FILES`
 * 与 `SKIP_PREFIXES`:调用方是引擎,文件由它自己挑;若引擎把禁词表自身喂进来,
 * 那是引擎的 bug,不该用静默吞的方式掩盖。
 */
export function scanFiles(files: readonly string[]): JargonHit[] {
  return files.flatMap((f) => scanJargon(readFileSync(f, 'utf8'), f));
}

if (import.meta.main) {
  const argv = process.argv;
  const kindArg = argv.includes('--kind') ? argv[argv.indexOf('--kind') + 1] : undefined;
  // `--skip <前缀>`(可重复)—— 给「这一趟不扫台账」这类分批用。
  // ⚠ 它只改**这次看哪些**, 不改判据: 跳过的那些没被判合规, 只是没被问。
  const skips = argv.flatMap((a, i) => (a === '--skip' ? [argv[i + 1] ?? ''] : []));
  // `--files <f1> <f2> ...`: 只扫这些文件,给 leaf 检查用(写集局部入口)。
  // 它**不**应用 EXCLUDE_FILES 与 SKIP_PREFIXES —— 调用方是引擎,文件由它挑。
  // 文件列表到下一个 `--` flag 即止。
  const filesArgIdx = argv.indexOf('--files');
  const afterFiles = filesArgIdx >= 0 ? argv.slice(filesArgIdx + 1) : [];
  const fileArgs: string[] = [];
  for (const a of afterFiles) {
    if (a.startsWith('--')) break;
    fileArgs.push(a);
  }
  let hits: JargonHit[];
  if (fileArgs.length > 0) hits = scanFiles(fileArgs);
  else {
    const roots = ['src', 'scripts', 'test', 'docs'];
    hits = scanTree(roots);
  }
  if (kindArg) hits = hits.filter((h) => h.kind === kindArg);
  if (skips.length > 0) hits = hits.filter((h) => !skips.some((s) => s && h.file.startsWith(s)));
  if (argv.includes('--json')) {
    console.log(JSON.stringify(hits, null, 1));
  } else {
    const byWord = new Map<string, number>();
    for (const h of hits) byWord.set(h.word, (byWord.get(h.word) ?? 0) + 1);
    for (const h of hits) console.log(`${h.file}:${h.line} [${h.kind}] ${h.word} → ${JARGON[h.word]}\n    ${h.text}`);
    console.log(`\n合计 ${hits.length} 处 / ${new Set(hits.map((h) => h.file)).size} 文件`);
    console.log([...byWord].sort((a, b) => b[1] - a[1]).map(([w, n]) => `${w}=${n}`).join(' '));
    // 命中里有测试文件时给修法提示 —— 两次生产击杀 (run 1bd174a7 / 8a95ce84) 都是 leaf 给
    // 扫描器/引擎写测试夹具时用了禁词字面。惯例只写在注释里 leaf 看不见, 写进失败输出才看得见。
    if (hits.some((h) => /\.test\.tsx?$/.test(h.file))) {
      console.log(`提示: 测试夹具需要禁词字面时用拼接构造 (如 const W = ['落','盘'].join('')), 静态扫描只认源码字面串。`);
    }
  }
  process.exit(hits.length > 0 ? 1 : 0);
}
