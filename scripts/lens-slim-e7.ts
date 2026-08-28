/**
 * scripts/lens-slim-e7 —— **E-7**:lens 那一段能省多少(账的大头在这里,而它从没被碰过)。
 *
 * ## 为什么要测它
 *
 * E-6 实测的整跑账(3 镜头 × 2 sub-angle 的配置):
 * - **lens 段**:gen 6 发 × ~44.9k + reduce 3 发 × ~50.9k ≈ **42 万 token**
 * - **脊柱段**:6 发 = 39.6 万(全文臂)→ 12.3 万(裸索引臂)
 *
 * 也就是说脊柱瘦身把 39.6 万砍到 12.3 万(削 69%),但**整跑只从 81.6 万降到 54.3 万 ≈ 33%**
 * —— 因为 **lens 那 9 发照样全额吃全文,一个字没省**。而生产的 L/V 更大时,lens 占比更高,
 * 整跑省幅还会更低。**大头在上游,而上游至今没被碰过。**
 *
 * ## 两个互相独立的省法(本跑各测一个,不混)
 *
 * **① reduce 不吃全文** —— 与脊柱那条论证**逐字同构**:reduce 拿到的是该镜头 V 个变体,
 * 而变体已经替它读过全文了;再塞一遍全文是重复付费。
 *
 * **② gen 一发多角** —— 今天每个 sub-angle 一发,于是**同一份全文在同一个镜头里被读了 V 遍**。
 * 改成一发覆盖该镜头全部 sub-angle,corpus 只付一次。
 * ⚠ 风险明写:一发做 V 件事可能每件都做得更浅。这正是本臂要量的。
 *
 * **gen 不能不吃全文** —— 它是**语料的第一次读**,没有任何上游替它消化过。
 * 拿掉就等于整条管线没有 grounding。所以本跑不设「gen 吃索引」这一臂,
 * 那不是省钱是断链。
 *
 * ## 三臂(基线 + 两个独立杠杆)
 *
 * | 臂 | gen | reduce |
 * |---|---|---|
 * | A 今天 | V 发/镜头,每发吃全文 | 吃全文 + 变体 |
 * | B reduce 瘦身 | 同 A | **吃索引** + 变体 |
 * | C gen 合并 | **1 发/镜头**,吃全文,一次答完 V 个 angle | 同 A |
 *
 * ## 判据(动手前钉死;n=3 中位数;绝对数不用比值)
 *
 * 某臂**可取代今天** ⟺ 两条同时成立:
 *   ① 三个冠军的 `faithfulness` 中位 **≥ 基线 − 0.05**;
 *   ② lens 段 token 削幅 **≥ 0.2**(这一段的绝对量大,20% 就值钱)。
 *
 * `faithfulness` 的判法与 E-6 逐字相同:**一次只给 judge 一个冠军 + 全部语料**,
 * 问支持/不支持各几条 —— 没有并排就没有位置可偏置,拿到的是绝对分。
 *
 * ⚠ 冠军的"好"不止 faithfulness(还有覆盖度:它有没有漏掉语料里该带的东西)。
 * **本跑量不到覆盖度** —— 一个漏了内容但没编造的冠军,faithfulness 会很高。
 * 这一格是已知盲区,写进读数,别当成"质量守住了"。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { callModel } from '../src/model';
import { repoProbe, renderRepoHits } from '../src/harness/research/repo-probe';

const VERDICT = { faithfulnessDrop: 0.05, minLensTokenCut: 0.2 } as const;
const ROOT = '/home/nick/repos/oh-my-dag';
const LENS_SEAT = 'minimax-cn:MiniMax-M3';
const JUDGE_SEAT = 'openai-codex:gpt-5.6-sol';

const EXTERNAL_FILES = [
  'docs/reference/loop-engineering/NOTES.md',
  'docs/reference/loop-engineering/openai-running-agents.md',
  'docs/reference/loop-engineering/demystifying-evals.md',
];
const REPO_QUERIES = ['buildSelfCheckFollowUp', 'SelfRepairLedger', 'spinRouteEnvEnabled', 'strategyForRound', 'maxSelfRepair', 'memory_recall'];
const QUESTION = '在 omd 这个仓里,给自修环再加一档 R3(记忆召回):它该挂在哪个接缝上、注入什么、判成判败的信号是什么。要点名真实的文件与函数。';

const LENSES = [
  { key: 'seam', persona: '你是这个代码仓的架构师,只关心接缝在哪、谁调谁、改动会波及什么。', angles: ['已有哪些注入面可以挂 R3,各自的调用时机', '挂错接缝会怎样'] },
  { key: 'signal', persona: '你是判据设计者,只关心什么信号可机械判定、什么只能靠人判。', angles: ['R3 的判成判败信号该怎么定', '哪些信号是虚的'] },
  { key: 'failure', persona: '你是可靠性工程师,只关心它会怎么静默失效。', angles: ['R3 的静默失效形态', '每种失效该由哪道闸接住'] },
];

function buildCorpusIndex(corpus: string, maxChars = 8_000): string {
  const heads: string[] = [];
  for (const raw of corpus.split('\n')) {
    const t = raw.trim();
    if (/^#{1,4} /.test(t) || /^<\/?second-pass-corpus/.test(t)) heads.push(t);
  }
  const urls = [...new Set((corpus.match(/https?:\/\/[^\s<>()[\]{}"'`,;）)]+/g) ?? []).map((u) => u.replace(/[.,;:!?]+$/, '')))];
  const body =
    `<corpus-index chars="${corpus.length}">\n(脊柱瘦身: 全文语料已被变体消化, 此处只留骨架)\n` +
    `${heads.join('\n')}\n\n来源 URL (${urls.length}):\n${urls.join('\n')}\n</corpus-index>`;
  return body.length > maxChars ? `${body.slice(0, maxChars)}\n…[索引截断]\n</corpus-index>` : body;
}

type Arm = 'A-today' | 'B-reduce-slim' | 'C-gen-merged';
interface Call { stage: string; usageIn: number; ms: number }

async function runLens(arm: Arm, corpus: string, index: string): Promise<{ calls: Call[]; champions: { key: string; text: string }[] }> {
  const calls: Call[] = [];
  const champions: { key: string; text: string }[] = [];
  const call = async (stage: string, prompt: string): Promise<string> => {
    const t0 = Date.now();
    const r = await callModel({ model: LENS_SEAT, messages: [{ role: 'user', content: prompt }] });
    calls.push({ stage, usageIn: r.usage.in, ms: Date.now() - t0 });
    console.error(`  [${arm}] ${stage} — ${Date.now() - t0}ms, in=${r.usage.in}`);
    return r.text ?? '';
  };

  for (const lens of LENSES) {
    // ── Stage 1 gen ──
    let body: string;
    if (arm === 'C-gen-merged') {
      // 一发覆盖该镜头全部 sub-angle:corpus 只付一次
      const merged = await call(`gen-merged:${lens.key}`,
        `${corpus}\n\n<persona>${lens.persona}</persona>\n\n研究问题: ${QUESTION}\n\n` +
        `本镜头要回答**这几个 sub-angle**, 逐个作答, 每个用 "### <angle>" 起一段:\n` +
        lens.angles.map((a) => `- ${a}`).join('\n') +
        `\n\n用 ground-truth 里的真实模块名推理 (禁造)。结构化、具体、可落地。`);
      body = merged;
    } else {
      const variants: string[] = [];
      for (const angle of lens.angles) {
        variants.push(await call(`gen:${lens.key}:${angle.slice(0, 8)}`,
          `${corpus}\n\n<persona>${lens.persona}</persona>\n\n研究问题: ${QUESTION}\n\n本 leaf 的具体 sub-angle: ${angle}\n\n用 ground-truth 里的真实模块名推理 (禁造)。结构化、具体、可落地、只答这个 sub-angle。`));
      }
      body = variants.map((v, i) => `### sub-angle ${i + 1}\n${v}`).join('\n\n');
    }

    // ── Stage 2 reduce ──
    const head = arm === 'B-reduce-slim' ? index : corpus;
    const text = await call(`reduce:${lens.key}`,
      `${head}\n\n镜头[${lens.key}] 的 sub-angle 产出:\n${body}\n\n你是该镜头的首席 judge。合成这镜头的**冠军答案**: 取最强骨架 + 嫁接各 sub-angle 的最佳碎片, 去冗余去弱点。直接给冠军答案。`);
    champions.push({ key: lens.key, text });
  }
  return { calls, champions };
}

/** 与 E-6 逐字相同的判法:一次只判一个冠军,无并排 ⇒ 无位置偏置。 */
async function faithfulness(text: string, context: string): Promise<{ supported: number; unsupported: number } | { error: string }> {
  try {
    const r = await callModel({
      model: JUDGE_SEAT,
      messages: [{
        role: 'user',
        content:
          `下面是【参考材料】和【一份镜头冠军答案】。逐条检查冠军里的**具体断言**(点名文件/函数/机制/数字的那些),` +
          `判断能不能被参考材料支持。\n\n=== 参考材料 ===\n${context}\n\n=== 冠军 ===\n${text}\n\n` +
          `只输出 JSON: {"supported":<整数>,"unsupported":<整数>}`,
      }],
    });
    const m = (r.text ?? '').match(/\{[\s\S]*\}/);
    if (!m) return { error: 'no-json' };
    const j = JSON.parse(m[0]) as { supported: number; unsupported: number };
    return { supported: Number(j.supported), unsupported: Number(j.unsupported) };
  } catch (e) {
    return { error: String(e).slice(0, 200) };
  }
}

async function main(): Promise<void> {
  const groundTruth = EXTERNAL_FILES.map((f) => `# ${f}\n\n${readFileSync(join(ROOT, f), 'utf8')}`).join('\n\n');
  const probe = repoProbe(REPO_QUERIES, { cwd: ROOT });
  const corpus = `${groundTruth}\n\n<second-pass-corpus round="2">\n${renderRepoHits(probe)}\n</second-pass-corpus>`;
  const index = buildCorpusIndex(corpus);
  console.error(`语料 ${corpus.length} 字符 · 索引 ${index.length}`);

  const armNames: Arm[] = ['A-today', 'B-reduce-slim', 'C-gen-merged'];
  const results: Record<string, { calls: Call[]; champions: { key: string; text: string }[] }> = {};
  for (const arm of armNames) {
    console.error(`\n=== ${arm} ===`);
    results[arm] = await runLens(arm, corpus, index);
  }

  const tag = process.argv[2] ? `-${process.argv[2]}` : '';
  mkdirSync(join(ROOT, 'runs'), { recursive: true });
  const sumIn = (cs: Call[]): number => cs.reduce((a, c) => a + c.usageIn, 0);
  const baseIn = sumIn(results['A-today']!.calls);
  const arms: Record<string, unknown> = {};
  for (const arm of armNames) {
    const r = results[arm]!;
    const scores: (number | null)[] = [];
    const raw: unknown[] = [];
    for (const c of r.champions) {
      const f = await faithfulness(c.text, corpus);
      raw.push({ lens: c.key, ...f });
      scores.push('error' in f || f.supported + f.unsupported === 0 ? null : f.supported / (f.supported + f.unsupported));
    }
    const ok = scores.filter((s): s is number => s !== null).sort((a, b) => a - b);
    const med = ok.length === 0 ? null : ok[Math.floor(ok.length / 2)]!;
    arms[arm] = {
      calls: r.calls.length, lensTokens: sumIn(r.calls), lensTokenCut: 1 - sumIn(r.calls) / baseIn,
      championChars: r.champions.reduce((a, c) => a + c.text.length, 0),
      faithfulnessPerLens: raw, faithfulnessMedian: med,
    };
    writeFileSync(join(ROOT, `runs/e7${tag}-${arm}.json`), JSON.stringify(r.champions, null, 2));
    console.error(`  [faith] ${arm}: ${JSON.stringify(raw)}`);
  }

  const base = arms['A-today'] as { faithfulnessMedian: number | null };
  const out = {
    at: new Date().toISOString(), experiment: 'E-7',
    seats: { lens: LENS_SEAT, judge: JUDGE_SEAT }, verdictThresholds: VERDICT,
    corpus: { chars: corpus.length, indexChars: index.length }, arms,
    verdicts: Object.fromEntries(armNames.map((a) => {
      const v = arms[a] as { faithfulnessMedian: number | null; lensTokenCut: number };
      return [a, {
        faithfulnessOk: base.faithfulnessMedian !== null && v.faithfulnessMedian !== null ? v.faithfulnessMedian >= base.faithfulnessMedian - VERDICT.faithfulnessDrop : null,
        tokenCutOk: v.lensTokenCut >= VERDICT.minLensTokenCut,
      }];
    })),
  };
  writeFileSync(join(ROOT, `runs/e7${tag}.json`), JSON.stringify(out, null, 2));
  console.error('\n读数 (两项一次全出):');
  for (const arm of armNames) {
    const v = arms[arm] as { calls: number; lensTokens: number; lensTokenCut: number; championChars: number; faithfulnessMedian: number | null };
    console.error(`  ${arm.padEnd(16)} ${String(v.calls).padStart(2)} 发 · token ${String(v.lensTokens).padStart(7)} (削 ${(v.lensTokenCut * 100).toFixed(1)}%) · 冠军 ${v.championChars} 字符 · faith ${v.faithfulnessMedian === null ? 'n/a' : v.faithfulnessMedian.toFixed(2)}`);
  }
}

await main();
