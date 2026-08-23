#!/usr/bin/env bun
/**
 * verifier 校准实验 · **两臂跑手**(2026-08-23)
 *
 * 单一变量:**只换判卷标准那一段 prompt**。
 *   A 臂 = 现行「结构同构」—— 从任务里抽出所有明确要求, 逐条对照结果。
 *   B 臂 = 「动作覆盖」—— 任务要求的**动作**有没有真发生, 以引擎记录为首要证据。
 * 座位、材料面(`summarizeResults` 原样)、语料、判卷 JSON 形状,四样全部冻住。
 *
 * 成败信号(**动手前写死**):B 要赢 = **假红率降 且 假绿率不升**。
 * 只降假红 = 判官变松, 不算赢。
 *
 * 用法:
 *   `bun run scripts/verifier-calibration-run.ts --model openai-codex:gpt-5.6-sol`
 *   `bun run scripts/verifier-calibration-run.ts --dry`   只打印将要跑什么, 不调模型
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { send } from '../src/model/gateway';

const ROOT = join(import.meta.dir, '..');
const DIR = join(ROOT, 'docs/plan/verifier-calibration');
const argv = process.argv;
const arg = (k: string, d?: string): string | undefined => {
  const i = argv.indexOf(k);
  return i > 0 ? argv[i + 1] : d;
};
const DRY = argv.includes('--dry');
const MODEL = arg('--model', 'openai-codex:gpt-5.6-sol')!;

interface Fixture { id: string; task: string; summary: string }
interface Label { id: string; truth: 'pass' | 'fail'; confidence: string; why: string }

const fixtures: Fixture[] = JSON.parse(readFileSync(join(DIR, 'fixtures.json'), 'utf8'));
const labels: Label[] = JSON.parse(readFileSync(join(DIR, 'labels.json'), 'utf8')).labels;
const byId = new Map(fixtures.map((f) => [f.id, f]));

/**
 * 消融(B 计划的那一半):删掉某节点的**输出正文**, 保留 `### <id> [done]` 与引擎记录行。
 * ⇒ 「声称完成而无任何交付叙述」。**保留头与引擎记录**是刻意的 —— 只抽掉自述那一段,
 * 于是它考的是「判官会不会因为没有交付叙述就放行」, 而不是「能不能看出节点 failed」。
 */
function ablate(summary: string): string {
  // ⚠ 削**正文最长**的那个 `[done]` 节点, 不是第一个。
  //   2026-08-23 dry-run 两次翻车才看对结构: 第一个 `[done]` 常是 `accept`(7 行 command 节点),
  //   而交付叙述在 agent 节点(实测 190 行, 回显了整份契约)。削错节点 ⇒ 正文还在 ⇒
  //   真值标 fail 是错的。**第三次没再猜, 去 print 了一份真 summary。**
  const lines = summary.split('\n');
  // ⚠ 节点边界只认**完整的节点头模式** `### <id> [状态]` —— 不能用 `### ` 打头。
  //   节点正文里回显了整份契约, **契约自己的 markdown 标题也是 `### `**(实测一份 201 行的
  //   summary 里有 11 个 `### `, 只有 2 个是节点头)。这是这个函数第三次因为「对结构做假设
  //   而不是去量」而写错 —— 前两次: 按空行分块 · 削了第一个 [done](那是 accept)。
  const NODE_HEAD = /^### \S+ \[(done|failed|skipped)\]/;
  const heads: number[] = [];
  lines.forEach((l, i) => {
    if (NODE_HEAD.test(l)) heads.push(i);
  });
  let target = -1;
  let best = -1;
  for (let k = 0; k < heads.length; k++) {
    const start = heads[k]!;
    if (!/^### \S+ \[done\]/.test(lines[start]!)) continue;
    const end = heads[k + 1] ?? lines.length;
    if (end - start > best) {
      best = end - start;
      target = k;
    }
  }
  if (target < 0) return summary;
  const start = heads[target]!;
  const end = heads[target + 1] ?? lines.length;
  const body = lines.slice(start, end);
  // 保留引擎给的那几行, 只抽掉执行体的自述正文。
  const kept = body.filter(
    (l, i) =>
      i === 0 ||
      l.startsWith('$ ') ||
      l.startsWith('exit ') ||
      l.startsWith('artifact: ') ||
      l.startsWith('merged_from: ') ||
      l.startsWith('引擎记录') ||
      /^- (命令退出码|执行命令|写入文件|读取文件|命令输出尾)/.test(l),
  );
  return [...lines.slice(0, start), ...kept, ...lines.slice(end)].join('\n');
}

/** 两臂唯一的差别就是这一段。其余 prompt 逐字同生产。 */
const CRITERION_A =
  '判定**必须先做一步**: 从原始任务里抽出所有**明确要求** —— 步数、字数/篇幅、必须覆盖的子部分、必须标注的东西、格式、约束、应产出的体裁 (设计/分析/清单, 而非假装执行)。**逐条**对照结果。';
const CRITERION_B =
  '判定**必须先做一步**: 从原始任务里抽出它要求**发生的动作** —— 改哪些文件、跑哪些命令、产出哪些东西。然后**逐个动作**问: 卷面上有没有它真发生过的证据?\n' +
  '**证据的优先序**: 引擎记录(`执行命令` / `exit N` / `写入文件` / `命令输出尾`)> 产物状态行(`artifact:`)> 执行体自述。\n' +
  '⚠ **要求的措辞没被逐字复述, 不是缺陷** —— 只要那个动作发生过且有证据。反过来, **复述了措辞而没有动作发生的证据, 就是缺陷**。';

function buildPrompt(task: string, summary: string, criterion: string): string {
  return `你是一个**跨模型校验者**, 审一个多步任务的执行结果是否真正满足任务。你的职责是**攻击结果、找出它没满足任务的地方**, 而不是盖章放行 —— 默认怀疑, 证据不足时判不通过。

${criterion}

不通过 (pass=false) 的判据 (任一命中即不过):
1. 任一明确要求未满足 (即使整体看起来不错) —— reason 点名缺了哪条。
2. **高风险接缝** (契约边界 / 状态机 / 法定数字 / 安全) 即使"看起来对"也要质疑其正确性; 无法确证正确 → 不过。
3. 结果是**捏造的数据 / 假执行确认** (凭空编输入、"已发送/已录入" 这类没真做却声称做了的) → 不过。
4. 计划有节点失败导致结果不完整 → 不过。

证据来源: 本卷面里所有「引擎记录」段落的「执行命令」「exit N」「写入文件」「读取文件」行都是引擎观测值, **优于**本节点自述。
- 引擎记录里已有的命令与退出码, **不必**再要求执行体复述 (那是冗余; 真值在卷面上)。
- 执行体自述与引擎记录**冲突** ⇒ **以引擎记录为准, 且判不通过**。

原始任务:
---
${task}
---

执行结果:
---
${summary}
---

输出 JSON 两字段:
- pass (bool): 这是裁决。
- reason (string): pass=false 时**必填** —— 缺哪条 / 哪里不可信 + 该怎么修 (机制级)。pass=true 时一句话说明已覆盖。`;
}

interface Row { id: string; truth: string; confidence: string; arm: 'A' | 'B'; pass: boolean | null; reason: string; tokensIn: number; tokensOut: number }

const cases = labels.map((l) => {
  const base = l.id.startsWith('abl:') ? l.id.slice(4) : l.id;
  const f = byId.get(base);
  if (!f) throw new Error(`语料缺失: ${base} (先跑 verifier-calibration-extract.ts)`);
  return { label: l, task: f.task, summary: l.id.startsWith('abl:') ? ablate(f.summary) : f.summary };
});

console.log(`语料 ${cases.length} 条 · 座位 ${MODEL} · 两臂 = ${cases.length * 2} 次调用`);
const truthCount = { pass: cases.filter((c) => c.label.truth === 'pass').length, fail: cases.filter((c) => c.label.truth === 'fail').length };
console.log(`真值分布: pass ${truthCount.pass} · fail ${truthCount.fail}`);
if (DRY) {
  for (const c of cases) console.log(`  ${c.label.id.padEnd(22)} truth=${c.label.truth.padEnd(5)} ${c.label.confidence.padEnd(8)} summary ${c.summary.length}B`);
  process.exit(0);
}

const rows: Row[] = [];
for (const c of cases) {
  for (const [arm, criterion] of [['A', CRITERION_A], ['B', CRITERION_B]] as const) {
    const prompt = buildPrompt(c.task, c.summary, criterion);
    let pass: boolean | null = null;
    let reason = '';
    let usage = { in: 0, out: 0 };
    try {
      const r = await send({
        model: MODEL,
        messages: [{ role: 'user', content: prompt }],
        thinkingLevel: 'xhigh',
        meta: { role: 'verifier-calibration' },
      });
      const text = r.text ?? '';
      usage = { in: r.usage?.in ?? 0, out: r.usage?.out ?? 0 };
      const m = /\{[\s\S]*"pass"[\s\S]*\}/.exec(text);
      if (m) {
        const j = JSON.parse(m[0]) as { pass?: boolean; reason?: string };
        pass = j.pass ?? null;
        reason = j.reason ?? '';
      } else {
        reason = `[解析不出 JSON] ${text.slice(0, 300)}`;
      }
    } catch (e) {
      // fail-open 但**留证据**: 调用挂了记成 null, 不编一个 pass 出来 (NULL ≠ 0)。
      reason = `[调用失败] ${(e as Error).message.slice(0, 200)}`;
    }
    rows.push({ id: c.label.id, truth: c.label.truth, confidence: c.label.confidence, arm, pass, reason, tokensIn: usage.in, tokensOut: usage.out });
    const mark = pass === null ? '?' : pass ? 'pass' : 'fail';
    const wrong = pass !== null && (pass ? c.label.truth === 'fail' : c.label.truth === 'pass');
    console.log(`  ${c.label.id.padEnd(22)} ${arm}  判=${mark.padEnd(4)} 真=${c.label.truth.padEnd(4)} ${wrong ? '✗ 判错' : ''}`);
  }
}

writeFileSync(join(DIR, 'results.json'), JSON.stringify(rows, null, 1));

const score = (arm: 'A' | 'B', only?: (r: Row) => boolean) => {
  const rs = rows.filter((r) => r.arm === arm && (!only || only(r)));
  const falseRed = rs.filter((r) => r.truth === 'pass' && r.pass === false).length;
  const falseGreen = rs.filter((r) => r.truth === 'fail' && r.pass === true).length;
  const nulls = rs.filter((r) => r.pass === null).length;
  return { n: rs.length, falseRed, falseGreen, nulls };
};

const fmt = (s: ReturnType<typeof score>) => `n=${s.n} 假红=${s.falseRed} 假绿=${s.falseGreen}${s.nulls ? ` (未取到判决 ${s.nulls})` : ''}`;
console.log('\n── 全集 ──');
console.log(`A (结构同构): ${fmt(score('A'))}`);
console.log(`B (动作覆盖): ${fmt(score('B'))}`);
console.log('── 非消融子集(真样本) ──');
const real = (r: Row) => r.confidence !== 'ablated';
console.log(`A: ${fmt(score('A', real))}`);
console.log(`B: ${fmt(score('B', real))}`);
console.log(`\n写入 ${join(DIR, 'results.json')}`);
