/**
 * eval-funnel —— 生成段多出来的点, 能不能活着穿过 council 的冠军择优 (owner 2026-07-27)。
 *
 * 为什么不跑整条 councilDeepPlan: 实测那条路每臂 995s, 而且 reduce/judge/graft 会各自回落到 config
 * 角色座位 (mimo/gpt-sol), mono 臂根本 mono 不了, 判官家族还成了终稿作者之一 (自判污染)。
 *
 * 这里改成**配对漏斗测试**: 复用矩阵已存盘的 36 份生成文本 (免费), 只跑 synth 那一段, 且两臂
 * 过**同一个钉死的单族 synth** —— 这样单变量只剩"喂进漏斗的 6 份候选是同族还是跨族"。
 * 配对 (同一批生成文本) 让运行间噪声大部分抵消, 代价从 ~33 分钟降到十几次调用。
 *
 * 跑: bun run scripts/eval-funnel.ts [taskId] [--reps 3] [--matrix DIR]
 */
import { readFileSync } from 'node:fs';
import { writeFileSync, mkdirSync } from 'node:fs';
import { send } from '../src/model/gateway';
import { bootstrapModelRuntime } from '../src/model/bootstrap';
import { parallel } from '../src/harness/primitives';
import { TASK_BY_ID, TASKS, PERSONAS } from './eval-tasks/diverge-tasks';
import { gradeAnswer } from './eval-tasks/grade';

/**
 * 漏斗模型钉死单族: 两臂共用, 它不是变量。刻意不用 gpt (判官族) —— 作者不能是判官。
 * 默认换掉 deepseek-v4-pro: 实测它 reasoning 与正文共用 8k 预算, 喂 6 份长候选后正文被腰斩,
 * 截断会伪装成"择优丢点"。--synth 可换族, 结论要在两个综合器下都成立才算数。
 */
const SYNTH_MAX = Number(process.env.EVAL_SYNTH_MAX_TOKENS) || 32_768; // 8000 会让话多的综合器被截 → 伪装成"择优丢点"

const argv = process.argv.slice(2);
const taskId = argv.find((a) => !a.startsWith('--')) ?? 'webhook-billing';
const task = TASK_BY_ID.get(taskId) ?? TASKS[0]!;
const repsIdx = argv.indexOf('--reps');
const REPS = repsIdx >= 0 ? Number(argv[repsIdx + 1]) : 3;
const mIdx = argv.indexOf('--matrix');
const MATRIX_DIR = (mIdx >= 0 ? argv[mIdx + 1] : '/tmp/eval-family-matrix') as string;
const sIdx = argv.indexOf('--synth');
const SYNTH_MODEL = (sIdx >= 0 ? argv[sIdx + 1] : 'kimi-coding:k3') as string;
const OUT = `/tmp/eval-funnel/${SYNTH_MODEL.replace(/[:/]/g, '_')}`;

const log = (s: string): void => void process.stderr.write(s + '\n');

interface MatrixJson {
  seeds: string[];
  cells: { persona: string; family: string; ok: boolean; hits: string[] }[];
  mono: { family: string; union: number }[];
}
const mx = JSON.parse(readFileSync(`${MATRIX_DIR}/${task.id}/matrix.json`, 'utf8')) as MatrixJson;
const textOf = (persona: string, family: string): string =>
  readFileSync(`${MATRIX_DIR}/${task.id}/gen-${persona}-${family}.md`, 'utf8');
const hitsOf = (persona: string, family: string): string[] =>
  mx.cells.find((c) => c.persona === persona && c.family === family)?.hits ?? [];

// A 臂 = 最好单族那一行 (最难打的 mono 基准); B 臂 = 跨族双射, **每个 rep 换一个偏移**,
// 免得固定挑到一个恰好偏低的分配 (上一版固定那个生成段只有 7/10, 低于 div 均值 8.2, 对 B 不公平)。
const bestFamily = mx.mono[0]!.family;
const families = mx.mono.map((m) => m.family);
const divAssignAt = (offset: number): { persona: string; family: string }[] =>
  PERSONAS.map((p, i) => ({ persona: p.id, family: families[(i + offset) % families.length]! }));
const monoAssign = PERSONAS.map((p) => ({ persona: p.id, family: bestFamily }));

const unionOf = (asg: { persona: string; family: string }[]): Set<string> => {
  const u = new Set<string>();
  for (const a of asg) for (const h of hitsOf(a.persona, a.family)) u.add(h);
  return u;
};

function synthPrompt(asg: { persona: string; family: string }[]): string {
  const blocks = asg
    .map((a, i) => `### 候选 ${i + 1} [${a.persona}]\n${textOf(a.persona, a.family)}`)
    .join('\n\n');
  const ask =
    task.kind === 'council'
      ? '综合成**一份**方案 + 一份关键考量清单: 以最好的那份为骨架, 把其它候选里独有的、真正重要的点嫁接进来。宁可多留一条真问题, 不要为了简洁丢点。'
      : '综合成**一份**缺陷清单: 合并重复项, 保留每一条真缺陷 (含只有个别候选提到的), 每条写: 缺陷 + 为什么出问题 + 怎么改。';
  return `下面是同一个问题的 ${asg.length} 份独立作答 (不同视角)。

问题:
---
${task.brief}
---

${blocks}

${ask}`;
}

bootstrapModelRuntime();
mkdirSync(`${OUT}/${task.id}`, { recursive: true });

const armName = { mono: `A-mono(${bestFamily})`, div: 'B-div' };
const rows: {
  arm: string;
  rep: number;
  genUnion: number;
  finalHits: number;
  kept: number;
  lost: string[];
  outTok: number;
  truncated: boolean;
}[] = [];

const jobs = (['mono', 'div'] as const).flatMap((kind) =>
  Array.from({ length: REPS }, (_, rep) => async () => {
    // div 每 rep 换偏移 → 平均掉"恰好挑到哪个双射"的运气; mono 每 rep 是同一批输入, 只有 synth 采样在变。
    const asg = kind === 'mono' ? monoAssign : divAssignAt(rep);
    const name = armName[kind];
    const genU = unionOf(asg);
    try {
      const r = await send({
        model: SYNTH_MODEL,
        messages: [{ role: 'user', content: synthPrompt(asg) }],
        temperature: 0.3,
        topP: 0.85,
        maxTokens: SYNTH_MAX,
        meta: { role: 'eval-funnel-synth' },
      });
      const final = r.text.trim();
      if (!final) throw new Error('空终稿');
      // out 打满预算 = 正文很可能被腰斩; 截断会伪装成"择优丢点", 必须标出来单独看。
      const truncated = r.usage.out >= SYNTH_MAX - 8;
      writeFileSync(`${OUT}/${task.id}/${name}-rep${rep}.md`, final);
      const g = await gradeAnswer(task, final);
      const lost = [...genU].filter((h) => !g.hits.has(h));
      rows.push({
        arm: name,
        rep,
        genUnion: genU.size,
        finalHits: g.hits.size,
        kept: [...genU].filter((h) => g.hits.has(h)).length,
        lost,
        outTok: r.usage.out,
        truncated,
      });
      log(
        `  ${name.padEnd(18)} rep${rep} 生成段并集 ${genU.size} → 终稿 ${g.hits.size} (留住 ${[...genU].filter((h) => g.hits.has(h)).length}/${genU.size})${truncated ? ' ⚠截断' : ''}`,
      );
    } catch (e) {
      log(`  ${name.padEnd(18)} rep${rep} FAIL ${(e as Error).message.slice(0, 140)}`);
    }
  }),
);
await parallel(jobs, { concurrency: 3 });

const N = task.seeds.length;
const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const byArm = (a: string): typeof rows => rows.filter((r) => r.arm === a);
const out = [
  `\n──────── 漏斗配对测试 ${task.id} (金标 ${N}) · synth 钉死 ${SYNTH_MODEL} · ${REPS} 重复 ────────`,
  ...Object.values(armName).map((nm) => {
    const rs = byArm(nm);
    if (!rs.length) return `${nm.padEnd(18)} 全失败`;
    const genMean = mean(rs.map((r) => r.genUnion));
    const keepPct = (mean(rs.map((r) => r.kept)) / Math.max(genMean, 1)) * 100;
    const trunc = rs.filter((r) => r.truncated).length;
    return `${nm.padEnd(18)} 生成段均 ${genMean.toFixed(1)}/${N} → 终稿均值 ${mean(rs.map((r) => r.finalHits)).toFixed(1)}/${N} (${rs.map((r) => r.finalHits).join(',')}) · 留存 ${keepPct.toFixed(0)}% · out-tok 均 ${Math.round(mean(rs.map((r) => r.outTok)))}${trunc ? ` · ⚠${trunc}/${rs.length} 截断` : ''}`;
  }),
  `Δ 终稿覆盖 (B-div − A-mono) = ${(mean(byArm(armName.div).map((r) => r.finalHits)) - mean(byArm(armName.mono).map((r) => r.finalHits))).toFixed(1)} 点`,
  `注: 生成段并集是漏斗输入上限; 留存 <100% = 综合段丢掉的点 (截断行需单独看, 那是预算问题不是择优问题)。`,
  ...Object.values(armName).flatMap((nm) => {
    const rs = byArm(nm);
    const lostAll = [...new Set(rs.flatMap((r) => r.lost))];
    return lostAll.length ? [`  ${nm} 丢掉过: ${lostAll.join(', ')}`] : [`  ${nm} 无丢失`];
  }),
].join('\n');
process.stdout.write(out + '\n');
writeFileSync(`${OUT}/${task.id}/report.md`, out);
log(`  → 落盘 ${OUT}/${task.id}/`);
