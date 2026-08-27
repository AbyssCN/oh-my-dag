/**
 * scripts/corpus-slim-ab2 —— 脊柱语料瘦身 A/B 的**第二把尺子**(E-2b)。
 *
 * ## 为什么有第二跑:第一跑量的是尺子,不是被测物
 *
 * 第一跑(`scripts/corpus-slim-ab.ts`,读数存 `runs/corpus-slim-ab.json`)预先声明的质量
 * 判据是「最终方案里的真实模块名 + URL 计数留存率 ≥ 0.7」。结果 10 → 0,判"不通过"。
 * 但逐条核验之后:全文臂那 10 个模块引用里**只有 2 个在仓里真实存在**,其余 8 个是编造的
 * (`src/leaf/runner.ts` / `src/oracle/router.ts` / `src/harness/xihe-safety/…` 都不存在)。
 * 换句话说那把尺子量的是**幻觉产量**,不是 grounding —— 引用越多分越高,而编造也算引用。
 * 成因也清楚:第一跑的语料是外部文档(OpenAI / NIST / evals),里面**根本没有本仓路径**,
 * 于是任何本仓路径按定义都是编造的。**尺子与语料不匹配。**
 *
 * 第一跑的成本侧读数仍然有效(prompt token 削 78.6%),质量侧作废。本跑只换**仪器**,
 * 被测变量一字不动。
 *
 * ## 这一跑改了三件事(都是仪器,不是变量)
 *
 * 1. **语料换成含真实仓内路径的**(docs/plan + docs/architecture),于是"引用真不真"
 *    可以用 `existsSync` 机械核验,而不是靠数量代理。
 * 2. **质量尺换成两个方向相反的数**:`realPaths`(引用且真实存在)与 `fakePaths`(引用但不存在)。
 *    多编造会让第二个数涨 —— 第一跑那把尺子做不到这件事。
 * 3. **盲评从二选一改成结构化计数**,两臂各自出 grounded 断言数与无依据断言数,可比。
 *
 * ## 预先声明的判据(E-2b;程序算,不事后改)
 *
 * 保留瘦身 ⟺ 三条同时成立:
 *   ① 真实路径引用留存 ≥ 0.7(瘦身臂 realPaths ÷ 全文臂 realPaths);
 *   ② 编造不增加(瘦身臂 fakePaths ≤ 全文臂 fakePaths);
 *   ③ 脊柱 prompt token 降幅 ≥ 0.5。
 * 任一不成立 → 不支持照原样合,具体走哪条由 owner 裁。
 *
 * ⚠ 仍然量不到的一格(与第一跑相同):语料规模 ~15 万字符,生产 `--deep` 实测 ~20 万 token。
 * 「只有在大语料下才出现的信息丢失」本实验**看不见**,报告里必须写着。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { callModel } from '../src/model';

const VERDICT = { minRealPathRetention: 0.7, minPromptTokenCut: 0.5 } as const;

const ROOT = '/home/nick/repos/oh-my-dag';
const REASON_SEAT = 'minimax-cn:MiniMax-M3';
const BLIND_JUDGE_SEAT = 'openai-codex:gpt-5.6-sol';

/** 语料换成**含真实仓内路径**的文档(固定顺序,确定性)。 */
const CORPUS_FILES = [
  'docs/plan/2026-08-25-自修环阶梯与空转路由-sdd.md',
  'docs/plan/2026-08-25-阶梯S2-档2重派-执行契约.md',
  'docs/plan/2026-08-27-阶梯S3-轮表判据diff与M槽位-执行契约.md',
  'docs/plan/2026-08-28-accept基线赦免在直通档恒失效-执行契约.md',
  'docs/architecture/seams.md',
  'docs/silent-failures.md',
];

/** 逐字复制自被测分支(实验装置不该要求先把被测改动合进生产)。 */
function buildCorpusIndex(corpus: string, maxChars = 8_000): string {
  const heads: string[] = [];
  for (const raw of corpus.split('\n')) {
    const t = raw.trim();
    if (/^#{1,4} /.test(t) || /^<\/?second-pass-corpus/.test(t)) heads.push(t);
  }
  const urls = [
    ...new Set((corpus.match(/https?:\/\/[^\s<>()[\]{}"'`,;）)]+/g) ?? []).map((u) => u.replace(/[.,;:!?]+$/, ''))),
  ];
  const body =
    `<corpus-index chars="${corpus.length}">\n` +
    `(脊柱瘦身: 全文语料已被镜头冠军/候选消化, 此处只留骨架; 事实与引用以冠军/候选内嵌者为准)\n` +
    `${heads.join('\n')}\n\n来源 URL (${urls.length}):\n${urls.join('\n')}\n</corpus-index>`;
  return body.length > maxChars ? `${body.slice(0, maxChars)}\n…[索引截断]\n</corpus-index>` : body;
}

/**
 * E-2c 的第三臂:索引 + **语料里出现过的仓内路径清单**。
 *
 * E-2b 的读数直接指着这一格:瘦身臂的真实路径留存只有 35%,而它并没有多编造(8 = 8)——
 * 丢的是"说得出具体落点"的能力,不是变得更爱瞎编。而索引今天的格式只留标题行 + URL,
 * **没有一格装路径**。把路径补进去体积只有几 KB,几乎不吃掉 86% 的成本收益。
 */
function buildCorpusIndexWithPaths(corpus: string, maxChars = 12_000): string {
  const base = buildCorpusIndex(corpus, maxChars - 4_000);
  const paths = [...new Set(corpus.match(/\b(?:src|scripts|docs|test)\/[\w./-]+\.\w+/g) ?? [])].sort();
  return `${base}\n<corpus-paths count="${paths.length}">\n${paths.join('\n')}\n</corpus-paths>`;
}

const QUESTION = '在 omd 这个仓里,给自修环再加一档 R3(记忆召回):它该在哪个接缝上挂、注入什么、判成判败的信号是什么。要点名真实的文件与函数。';

const FRAMINGS = [
  { key: 'seam', framing: '以接缝为骨架:先定它挂在哪个已有接缝上,再定它注入什么。' },
  { key: 'failure', framing: '以失效模式为骨架:先枚举它会怎么静默失效,再让每条设计对应一种坏法。' },
];
const CRITERIA = [
  { key: 'grounded', criterion: '点名的文件/函数是不是语料里真实存在的(而不是听起来像的)' },
  { key: 'falsifiable', criterion: '判成/判败信号是否可机械判定' },
];

interface Call { stage: string; usageIn: number; usageOut: number; ms: number; text: string }

async function runArm(arm: 'full' | 'slim' | 'slim+paths', head: string, championsDigest: string): Promise<Call[]> {
  const calls: Call[] = [];
  const call = async (stage: string, prompt: string): Promise<string> => {
    const t0 = Date.now();
    const r = await callModel({ model: REASON_SEAT, messages: [{ role: 'user', content: prompt }] });
    calls.push({ stage, usageIn: r.usage.in, usageOut: r.usage.out, ms: Date.now() - t0, text: r.text ?? '' });
    console.error(`  [${arm}] ${stage} — ${Date.now() - t0}ms, in=${r.usage.in}`);
    return r.text ?? '';
  };
  const cands: { key: string; text: string }[] = [];
  for (const fr of FRAMINGS) {
    cands.push({
      key: fr.key,
      text: await call(`synth:${fr.key}`, `${head}\n\n各镜头冠军:\n${championsDigest}\n\n<framing>${fr.framing}</framing>\n\n问题: ${QUESTION}\n\n按此 framing 综合成一份完整方案 (具体到模块/文件/接点, 用真实模块名)。`),
    });
  }
  const candDigest = cands.map((c) => `## 候选[${c.key}]\n${c.text}`).join('\n\n');
  const crits: string[] = [];
  for (const j of CRITERIA) {
    crits.push(`## 维度[${j.key}]\n${await call(`judge:${j.key}`, `${head}\n\n${candDigest}\n\n你是评判维度【${j.criterion}】的 judge。按此维度评 ${cands.length} 个候选: 各自强弱 + 哪个最优 + 该嫁接谁的哪段。只从你这个维度评。`)}`);
  }
  const critDigest = crits.join('\n\n');
  const fusion = await call('fusion', `${head}\n\n${candDigest}\n\nK-judge panel 多维评判:\n${critDigest}\n\n把上面的评判融合成结构化分析: 共识点、分歧点、各候选独有的洞察、覆盖缺口、最终该怎么嫁接。`);
  await call('graft', `${head}\n\n${candDigest}\n\nK-judge panel 多维评判:\n${critDigest}\n\nFusion 融合分析 (结构化):\n${fusion}\n\n你是首席架构师。据 panel 多维评判 + fusion 融合分析**合成唯一最终方案**: 选最强骨架, 嫁接共识与独特洞察, 显式消解矛盾点、补齐覆盖缺口与盲点。直接给最终方案, 不要元评论。`);
  return calls;
}

/** 机械读数:引用的仓内路径**逐条 existsSync 核验**,真/假分两个数(方向相反)。 */
function pathTruth(text: string): { realPaths: number; fakePaths: number; real: string[]; fake: string[] } {
  const cited = [...new Set(text.match(/\b(?:src|scripts|docs|test)\/[\w./-]+\.\w+/g) ?? [])];
  const real = cited.filter((p) => existsSync(join(ROOT, p)));
  const fake = cited.filter((p) => !existsSync(join(ROOT, p)));
  return { realPaths: real.length, fakePaths: fake.length, real, fake };
}

async function main(): Promise<void> {
  const corpus = CORPUS_FILES.map((f) => `# ${f}\n\n${readFileSync(join(ROOT, f), 'utf8')}`).join('\n\n');
  const index = buildCorpusIndex(corpus);
  console.error(`语料 ${corpus.length} 字符 → 索引 ${index.length} 字符 (${((1 - index.length / corpus.length) * 100).toFixed(1)}% 削减)`);
  const third = Math.floor(corpus.length / 3);
  const championsDigest = [0, 1, 2].map((i) => `## 镜头冠军[lens${i + 1}]\n${corpus.slice(i * third, i * third + 4000)}`).join('\n\n');

  console.error('\n=== 全文臂(基线)===');
  const full = await runArm('full', corpus, championsDigest);
  console.error('\n=== 瘦身臂 ===');
  const slim = await runArm('slim', index, championsDigest);
  const indexP = buildCorpusIndexWithPaths(corpus);
  console.error(`\n=== 瘦身+路径臂 === (索引 ${indexP.length} 字符)`);
  const slimP = await runArm('slim+paths', indexP, championsDigest);

  const sumIn = (cs: Call[]): number => cs.reduce((a, c) => a + c.usageIn, 0);
  const sumMs = (cs: Call[]): number => cs.reduce((a, c) => a + c.ms, 0);
  const fullFinal = full[full.length - 1]!.text;
  const slimFinal = slim[slim.length - 1]!.text;
  const pFull = pathTruth(fullFinal);
  const pSlim = pathTruth(slimFinal);
  const slimPFinal = slimP[slimP.length - 1]!.text;
  const pSlimP = pathTruth(slimPFinal);

  const blind = await callModel({
    model: BLIND_JUDGE_SEAT,
    messages: [{
      role: 'user',
      content:
        `同一个问题的两份最终方案,由同一模型在两种上下文条件下产出。你不知道哪份是什么条件,别猜。\n\n问题: ${QUESTION}\n\n` +
        `=== 方案 A ===\n${fullFinal}\n\n=== 方案 B ===\n${slimFinal}\n\n` +
        `逐条数,不要给总评:每份里 ① 有语料依据的具体断言有几条 ② 无依据/看起来是编造的断言有几条(各举 3 个例子) ③ 若必须二选一交付选哪份。`,
      }],
    responseSchema: z.object({
      aGrounded: z.number(), aFabricated: z.number(), aFabricatedExamples: z.array(z.string()),
      bGrounded: z.number(), bFabricated: z.number(), bFabricatedExamples: z.array(z.string()),
      pick: z.enum(['A', 'B']), why: z.string(),
    }),
  });

  const retention = pFull.realPaths === 0 ? 1 : pSlim.realPaths / pFull.realPaths;
  const tokenCut = 1 - sumIn(slim) / sumIn(full);
  const out = {
    at: new Date().toISOString(), experiment: 'E-2c',
    seats: { spine: REASON_SEAT, blindJudge: BLIND_JUDGE_SEAT },
    corpusChars: corpus.length, indexChars: index.length, verdictThresholds: VERDICT,
    full: { spinePromptTokens: sumIn(full), spineMs: sumMs(full), paths: pFull, perCall: full.map(({ text, ...r }) => r) },
    slim: { spinePromptTokens: sumIn(slim), spineMs: sumMs(slim), paths: pSlim, perCall: slim.map(({ text, ...r }) => r) },
    realPathRetention: retention, promptTokenCut: tokenCut,
    verdict: {
      realPathsRetained: retention >= VERDICT.minRealPathRetention,
      fabricationNotWorse: pSlim.fakePaths <= pFull.fakePaths,
      costCutEnough: tokenCut >= VERDICT.minPromptTokenCut,
    },
    blindJudge: blind.parsed,
    slimWithPaths: {
      indexChars: indexP.length,
      spinePromptTokens: sumIn(slimP), spineMs: sumMs(slimP), paths: pSlimP,
      realPathRetention: pFull.realPaths === 0 ? 1 : pSlimP.realPaths / pFull.realPaths,
      promptTokenCut: 1 - sumIn(slimP) / sumIn(full),
      perCall: slimP.map(({ text, ...r }) => r),
    },
  };
  // 重复跑靠 argv 分文件 —— 单跑方差实测很大 (裸索引臂两跑 35% → 16%, 编造 8 → 14),
  // 0.7 那条线在 n=1 上判不了。`bun run scripts/corpus-slim-ab3.ts r2` 落 …-r2.json。
  const tag = process.argv[2] ? `-${process.argv[2]}` : '';
  mkdirSync(join(ROOT, 'runs'), { recursive: true });
  writeFileSync(join(ROOT, `runs/corpus-slim-ab3${tag}.json`), JSON.stringify(out, null, 2));
  writeFileSync(join(ROOT, 'runs/corpus-slim-ab2-full.md'), fullFinal);
  writeFileSync(join(ROOT, 'runs/corpus-slim-ab2-slim.md'), slimFinal);
  writeFileSync(join(ROOT, 'runs/corpus-slim-ab3-slimpaths.md'), slimPFinal);
  console.error(
    `\n读数: token ${sumIn(full)} → ${sumIn(slim)} (削 ${(tokenCut * 100).toFixed(1)}%) · ` +
      `真路径 ${pFull.realPaths}→${pSlim.realPaths} (留存 ${(retention * 100).toFixed(0)}%) · ` +
      `编造路径 ${pFull.fakePaths}→${pSlim.fakePaths} · 判据 ${JSON.stringify(out.verdict)}\n` +
      `第三臂(索引+路径): token 削 ${((out.slimWithPaths.promptTokenCut) * 100).toFixed(1)}% · ` +
      `真路径 ${pSlimP.realPaths} (留存 ${(out.slimWithPaths.realPathRetention * 100).toFixed(0)}%) · 编造 ${pSlimP.fakePaths}`,
  );
}

await main();
