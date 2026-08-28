/**
 * scripts/corpus-slim-ab6 —— **E-5**:单变量 = 蒸馏的压缩率(`maxChars`)。
 *
 * ## 这一跑要把两个混在一起的假设分开
 *
 * E-4 实测:repoProbe 的整读文件蒸到 2500 字符后,编造升过基线、盲评三跑排末。
 * 但那一跑**同时**变了两件事 —— 用了蒸馏,而且压到了 -79%(12,000 → 2,500)。
 * 所以有两个互斥的解释,E-4 的数据分不开:
 *
 * - **H-压缩率**:病在压得太狠。放宽 `maxChars` 编造就会降下来。
 * - **H-用错地方**:病在"给要照着干的下游一份摘要"这件事本身。放宽也救不回来。
 *
 * ## 预先声明的判别式(这是本跑的核心,动手前钉死)
 *
 * 沿压缩率轴取三点:**2500 / 6000 / 不蒸**(不蒸 = C 臂,压缩率 1.0)。
 * - 编造数**随 maxChars 单调下降**,且 6000 档 ≤ 基线 → **H-压缩率成立**,
 *   修法 = 把 `DISTILL_DEFAULT_MAX_CHARS`(今天 2500)按下游调档;
 * - 6000 档的编造**仍 > 基线** → **H-用错地方成立**,修法 = 这类下游根本不蒸,
 *   E-4 的裁决(落 C)保持不变,`maxChars` 这条路关掉不再试。
 * - 两者都不成立(非单调 / 方差吞掉差异)→ 记「本轴判不动」,不硬下结论。
 *
 * ## 四臂(单变量 = 整读文件的 maxChars,其余逐字节相同)
 *
 * | 臂 | repoBlock 里的整读文件 |
 * |---|---|
 * | A 全文 | (基线:整个语料全文进 prompt,用于算留存比) |
 * | C 不蒸 | 原文照留 —— E-3/E-4 的赢家 |
 * | D2500 | 蒸到 2500(= 今天的生产默认,E-4 的 E 臂) |
 * | D6000 | 蒸到 6000 |
 *
 * 行级 `hits` 三臂**一律逐字保留**(它们是 `path:line` 定位锚,E-3 已证它们在压编造)。
 *
 * ## 判据(与 E-3/E-4 逐字相同,不因为多一臂就放宽)
 *
 * 某臂可取代全文 ⟺ ① 真路径数 ≥ 全文 ×0.7 ② 编造总数 ≤ 全文 ③ token 削幅 ≥ 0.5。n=3 中位数。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { callModel } from '../src/model';
import { repoProbe, renderRepoHits } from '../src/harness/research/repo-probe';
import { createModelSourceDistiller } from '../src/harness/web/distill-source';

const VERDICT = { minRealPathRatio: 0.7, minPromptTokenCut: 0.5 } as const;
const ROOT = '/home/nick/repos/oh-my-dag';
const REASON_SEAT = 'minimax-cn:MiniMax-M3';
const BLIND_JUDGE_SEAT = 'openai-codex:gpt-5.6-sol';

const EXTERNAL_FILES = [
  'docs/reference/loop-engineering/NOTES.md',
  'docs/reference/loop-engineering/openai-running-agents.md',
  'docs/reference/loop-engineering/demystifying-evals.md',
];
const REPO_QUERIES = ['buildSelfCheckFollowUp', 'SelfRepairLedger', 'spinRouteEnvEnabled', 'strategyForRound', 'maxSelfRepair', 'memory_recall'];
const QUESTION = '在 omd 这个仓里,给自修环再加一档 R3(记忆召回):它该挂在哪个接缝上、注入什么、判成判败的信号是什么。要点名真实的文件与函数。';
const FRAMINGS = [
  { key: 'seam', framing: '以接缝为骨架:先定它挂在哪个已有接缝上,再定它注入什么。' },
  { key: 'failure', framing: '以失效模式为骨架:先枚举它会怎么静默失效,再让每条设计对应一种坏法。' },
];
const CRITERIA = [
  { key: 'grounded', criterion: '点名的文件/函数是不是语料里真实存在的' },
  { key: 'falsifiable', criterion: '判成/判败信号是否可机械判定' },
];

function buildCorpusIndex(corpus: string, maxChars = 8_000): string {
  const heads: string[] = [];
  for (const raw of corpus.split('\n')) {
    const t = raw.trim();
    if (/^#{1,4} /.test(t) || /^<\/?second-pass-corpus/.test(t)) heads.push(t);
  }
  const urls = [...new Set((corpus.match(/https?:\/\/[^\s<>()[\]{}"'`,;）)]+/g) ?? []).map((u) => u.replace(/[.,;:!?]+$/, '')))];
  const body =
    `<corpus-index chars="${corpus.length}">\n` +
    `(脊柱瘦身: 全文语料已被镜头冠军/候选消化, 此处只留骨架; 事实与引用以冠军/候选内嵌者为准)\n` +
    `${heads.join('\n')}\n\n来源 URL (${urls.length}):\n${urls.join('\n')}\n</corpus-index>`;
  return body.length > maxChars ? `${body.slice(0, maxChars)}\n…[索引截断]\n</corpus-index>` : body;
}

type Arm = 'A-full' | 'C-nodistill' | 'D2500' | 'D6000';
interface Call { stage: string; usageIn: number; usageOut: number; ms: number; text: string }

async function runArm(arm: Arm, head: string, championsDigest: string): Promise<Call[]> {
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
    cands.push({ key: fr.key, text: await call(`synth:${fr.key}`, `${head}\n\n各镜头冠军:\n${championsDigest}\n\n<framing>${fr.framing}</framing>\n\n问题: ${QUESTION}\n\n按此 framing 综合成一份完整方案 (具体到模块/文件/接点, 用真实模块名)。`) });
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

function measure(text: string, corpus: string): { repoReal: number; repoFake: number; urlReal: number; urlFake: number; fake: string[] } {
  const paths = [...new Set(text.match(/\b(?:src|scripts|docs|test)\/[\w./-]+\.\w+/g) ?? [])];
  const urls = [...new Set((text.match(/https?:\/\/[^\s<>()[\]{}"'`,;）)]+/g) ?? []).map((u) => u.replace(/[.,;:!?]+$/, '')))];
  const fake = paths.filter((p) => !existsSync(join(ROOT, p)));
  return {
    repoReal: paths.filter((p) => existsSync(join(ROOT, p))).length,
    repoFake: fake.length,
    urlReal: urls.filter((u) => corpus.includes(u)).length,
    urlFake: urls.filter((u) => !corpus.includes(u)).length,
    fake: fake.slice(0, 6),
  };
}

async function main(): Promise<void> {
  const groundTruth = EXTERNAL_FILES.map((f) => `# ${f}\n\n${readFileSync(join(ROOT, f), 'utf8')}`).join('\n\n');
  const probe = repoProbe(REPO_QUERIES, { cwd: ROOT });
  const repoBlockFull = renderRepoHits(probe);
  const corpus = `${groundTruth}\n\n<second-pass-corpus round="2">\n${repoBlockFull}\n</second-pass-corpus>`;

  // ── 两个蒸馏档:行级命中逐字保留, 只有整读文件按 maxChars 蒸 ──────────────────
  const hitsOnly = renderRepoHits({ hits: probe.hits, files: [] });
  async function distilledBlock(maxChars: number): Promise<string> {
    const distiller = createModelSourceDistiller({ maxChars });
    const parts: string[] = [];
    for (const f of probe.files) {
      try {
        const r = await distiller({ body: f.text, title: f.path, url: `repo://${f.path}`, question: QUESTION });
        parts.push(`<repo-file-distilled path="${f.path}" orig="${f.text.length}" extract="${r.extract.length}">\n相关性: ${r.relevance}\n${r.extract}\n</repo-file-distilled>`);
        console.error(`  [distill ${maxChars}] ${f.path} — ${f.text.length} → ${r.extract.length}`);
      } catch (err) {
        // 生产同纪律: 蒸馏是增益不是链路 —— 失败该源退回全文, 不断链。
        parts.push(`<repo-file path="${f.path}">\n${f.text}\n</repo-file>`);
        console.error(`  ⚠ [distill ${maxChars}] ${f.path} 失败 → 退回全文: ${String(err).slice(0, 100)}`);
      }
    }
    return `${hitsOnly}\n${parts.join('\n')}`;
  }
  const block2500 = await distilledBlock(2500);
  const block6000 = await distilledBlock(6000);
  console.error(`repoBlock: 不蒸 ${repoBlockFull.length} · 2500 档 ${block2500.length} · 6000 档 ${block6000.length}`);

  const third = Math.floor(corpus.length / 3);
  const championsDigest = [0, 1, 2].map((i) => `## 镜头冠军[lens${i + 1}]\n${corpus.slice(i * third, i * third + 4000)}`).join('\n\n');
  const index = buildCorpusIndex(corpus);
  const heads: Record<Arm, string> = {
    'A-full': corpus,
    'C-nodistill': `${index}\n\n${repoBlockFull}`,
    'D2500': `${index}\n\n${block2500}`,
    'D6000': `${index}\n\n${block6000}`,
  };
  for (const [k, v] of Object.entries(heads)) console.error(`  头部 ${k}: ${v.length} 字符`);

  const results: Record<string, { calls: Call[]; final: string }> = {};
  for (const arm of Object.keys(heads) as Arm[]) {
    console.error(`\n=== ${arm} ===`);
    const calls = await runArm(arm, heads[arm], championsDigest);
    results[arm] = { calls, final: calls[calls.length - 1]!.text };
  }

  const sumIn = (cs: Call[]): number => cs.reduce((a, c) => a + c.usageIn, 0);
  const baseIn = sumIn(results['A-full']!.calls);
  const mBase = measure(results['A-full']!.final, corpus);
  const arms = Object.fromEntries((Object.keys(heads) as Arm[]).map((arm) => {
    const m = measure(results[arm]!.final, corpus);
    const tokens = sumIn(results[arm]!.calls);
    return [arm, {
      headChars: heads[arm].length, spinePromptTokens: tokens,
      spineMs: results[arm]!.calls.reduce((a, c) => a + c.ms, 0), measure: m,
      realPathRatio: mBase.repoReal === 0 ? 1 : m.repoReal / mBase.repoReal,
      fabricationTotal: m.repoFake + m.urlFake,
      promptTokenCut: 1 - tokens / baseIn,
      verdict: {
        realPathsKept: (mBase.repoReal === 0 ? 1 : m.repoReal / mBase.repoReal) >= VERDICT.minRealPathRatio,
        fabricationNotWorse: m.repoFake + m.urlFake <= mBase.repoFake + mBase.urlFake,
        costCutEnough: 1 - tokens / baseIn >= VERDICT.minPromptTokenCut,
      },
    }];
  }));

  // ── 机械读数先落盘 (E-3 的教训: 贵的部分不许被便宜的一发毁掉) ────────────────
  const tag = process.argv[2] ? `-${process.argv[2]}` : '';
  mkdirSync(join(ROOT, 'runs'), { recursive: true });
  for (const arm of Object.keys(heads) as Arm[]) writeFileSync(join(ROOT, `runs/corpus-slim-ab6${tag}-${arm}.md`), results[arm]!.final);
  const out: Record<string, unknown> = {
    at: new Date().toISOString(), experiment: 'E-5',
    seats: { spine: REASON_SEAT, blindJudge: BLIND_JUDGE_SEAT, distill: 'seat:distill' },
    corpus: { chars: corpus.length, repoBlockFull: repoBlockFull.length, repoBlock2500: block2500.length, repoBlock6000: block6000.length, repoHits: probe.hits.length, repoFiles: probe.files.length },
    verdictThresholds: VERDICT, arms, blindJudge: null,
  };
  writeFileSync(join(ROOT, `runs/corpus-slim-ab6${tag}.json`), JSON.stringify(out, null, 2));
  console.error('机械读数已落盘 (盲评之前)。');

  // ── 盲评:**不用 responseSchema**, 拿原文自己 parse, 不可能再抛 (E-3 三跑全挂在校验上) ──
  try {
    const r = await callModel({
      model: BLIND_JUDGE_SEAT,
      messages: [{
        role: 'user',
        content:
          `同一个问题的四份最终方案,由同一模型在三种上下文条件下产出。你不知道哪份是什么条件,别猜。\n\n问题: ${QUESTION}\n\n` +
          (Object.keys(heads) as Arm[]).map((a, i) => `=== 方案 ${'ABCD'[i]} ===\n${results[a]!.final}`).join('\n\n') +
          `\n\n只输出一个 JSON 对象, 不要别的文字:\n` +
          `{"A":{"grounded":<整数>,"fabricated":<整数>},"B":{...},"C":{...},"D":{...},"ranking":["最好","次","再次","最差"],"why":"<两句>"}\n` +
          `grounded = 有语料依据的具体断言条数; fabricated = 无依据/看起来编造的条数。必须是整数。`,
      }],
    });
    const text = r.text ?? '';
    let parsed: unknown = null;
    try {
      const m = text.match(/\{[\s\S]*\}/);
      if (m) parsed = JSON.parse(m[0]);
    } catch { /* parse 不了就留原文 —— 这一格是增益不是链路 */ }
    out['blindJudge'] = parsed ?? { raw: text.slice(0, 2000) };
  } catch (err) {
    out['blindJudge'] = { error: String(err).slice(0, 300) };
  }
  writeFileSync(join(ROOT, `runs/corpus-slim-ab6${tag}.json`), JSON.stringify(out, null, 2));

  console.error('\n读数:');
  for (const arm of Object.keys(heads) as Arm[]) {
    const a = arms[arm] as { spinePromptTokens: number; promptTokenCut: number; measure: { repoReal: number; repoFake: number }; realPathRatio: number; verdict: Record<string, boolean> };
    console.error(`  ${arm.padEnd(24)} token ${String(a.spinePromptTokens).padStart(7)} (削 ${(a.promptTokenCut * 100).toFixed(1)}%) · 真路径 ${a.measure.repoReal} (比 ${(a.realPathRatio * 100).toFixed(0)}%) · 假路径 ${a.measure.repoFake} · ${JSON.stringify(a.verdict)}`);
  }
}

await main();
