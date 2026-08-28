/**
 * scripts/corpus-slim-e6 —— **E-6**:真 champions + 无位置偏置的判据。前五轮的地基重做。
 *
 * ## 前五轮为什么全部作废(owner 2026-08-28 指出,核实属实)
 *
 * 生产管线是:**gen(L×V 变体)→ reduce(每镜头合成冠军)→ 脊柱四发吃 corpus + championsDigest**。
 * `lensChampions` 才是「语料被消化后的产物」—— 脊柱之所以能不要全文,正是因为冠军替它读过了。
 *
 * 而我前五轮的 `championsDigest` 是**伪造**的:`corpus.slice()` 切三段原文,4000 字符一段,
 * **零模型综合、零消化**。后果**有方向**:
 * - 生产的瘦身臂 = 索引 + **真冠军(已消化全文)** → 其实什么都没丢;
 * - 我的瘦身臂 = 索引 + **三段随便切的原文** → 拿掉 corpus 就等于什么都没了。
 *
 * **五轮实验系统性地低估了瘦身臂,而低估的方向正好是我五轮结论的方向。**
 * 塌掉的:所有跨臂的质量比较。站得住的:成本读数(结构性)+ 仪器教训。
 *
 * ## 这一轮修的三处
 *
 * **① 真 champions,一次生成、全部臂与全部跑共享。**
 * 真跑 gen(L×V)+ reduce(L),把 `lensChampions` 存盘复用。
 * 这样保真度对了,而且单变量比前五轮**更干净** —— 四臂拿到的冠军逐字节相同。
 *
 * **② 判据改成「每臂独立打分」,从构造上消灭位置偏置。**
 * 前五轮的盲评是把 N 份方案并排给 judge 排序 —— 实测:**排最后展示的臂六跑六次垫底**,
 * 倒序重判后 `fabricated` 计数变化 **3–6 倍**(43→8 · 52→28 · 40→7),计数不可用。
 * 本轮改成 **faithfulness 形态**(借 RAG 评测那一族的判据,不自己发明):
 * **一次只给 judge 一份方案 + 全部 context,问「这份里有几条断言能被 context 支持、几条不能」。**
 * 没有并排,就没有顺序可偏置;得到的是**绝对分**而不是相对排名。
 *
 * **③ 三项判据一次全出,写进脚本输出格式。**
 * 上一轮我只比了假路径那一列就下结论,而真路径与削幅两项其实都指向相反方向。
 * 这条不靠人自觉 —— 输出里三项并排,判据函数一次算完。
 *
 * ## 四臂(单变量 = 脊柱四发的 prompt 头;冠军三臂逐字节相同)
 *
 * | 臂 | 头部 |
 * |---|---|
 * | A 全文 | corpus 全文(今天的生产行为,基线) |
 * | B 裸索引 | 标题骨架 + URL |
 * | C 索引+真清单 | B + repoProbe 命中(原文) |
 * | D 索引+真清单+蒸馏 | C,但整读文件蒸到 6000(E-5 留下的未决格) |
 *
 * ⚠ **B 必须在场**:它是被伪造冠军伤得最重的那一臂,重做的意义有一半在它身上。
 *
 * ## 预先声明的判据(E-6;n=3 中位数;程序算,不事后改)
 *
 * 某臂**可取代全文** ⟺ 三条同时成立:
 *   ① `faithfulness`(supported ÷ (supported+unsupported))**不低于全文臂 − 0.05**;
 *   ② 假路径(`existsSync` 判)**≤ 全文臂**;
 *   ③ 脊柱 prompt token 削幅 **≥ 0.5**。
 * **用绝对数比,不用比值** —— 前五轮的 125%/175%/117% 全是「分母自己在抖」造出来的假信号。
 *
 * ⚠ 仍然量不到:生产 `--deep` 的真实规模与现抓语料的杂质;冠军只生成一次(单样本)。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { callModel } from '../src/model';
import { repoProbe, renderRepoHits } from '../src/harness/research/repo-probe';
import { createModelSourceDistiller } from '../src/harness/web/distill-source';

const VERDICT = { faithfulnessDrop: 0.05, minPromptTokenCut: 0.5 } as const;
const ROOT = '/home/nick/repos/oh-my-dag';
const LENS_SEAT = 'minimax-cn:MiniMax-M3';
const REASON_SEAT = 'minimax-cn:MiniMax-M3';
const JUDGE_SEAT = 'openai-codex:gpt-5.6-sol';
const CHAMPIONS_CACHE = join(ROOT, 'runs/e6-champions.json');

const EXTERNAL_FILES = [
  'docs/reference/loop-engineering/NOTES.md',
  'docs/reference/loop-engineering/openai-running-agents.md',
  'docs/reference/loop-engineering/demystifying-evals.md',
];
const REPO_QUERIES = ['buildSelfCheckFollowUp', 'SelfRepairLedger', 'spinRouteEnvEnabled', 'strategyForRound', 'maxSelfRepair', 'memory_recall'];
const QUESTION = '在 omd 这个仓里,给自修环再加一档 R3(记忆召回):它该挂在哪个接缝上、注入什么、判成判败的信号是什么。要点名真实的文件与函数。';

/** 三个镜头 × 两个 sub-angle —— 形状照生产(persona + sub-angle),规模压到可负担。 */
const LENSES = [
  { key: 'seam', persona: '你是这个代码仓的架构师,只关心接缝在哪、谁调谁、改动会波及什么。', angles: ['已有哪些注入面可以挂 R3,各自的调用时机', '挂错接缝会怎样'] },
  { key: 'signal', persona: '你是判据设计者,只关心什么信号可机械判定、什么只能靠人判。', angles: ['R3 的判成判败信号该怎么定', '哪些信号是虚的'] },
  { key: 'failure', persona: '你是可靠性工程师,只关心它会怎么静默失效。', angles: ['R3 的静默失效形态', '每种失效该由哪道闸接住'] },
];

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

type Arm = 'A-full' | 'B-index' | 'C-index+repo' | 'D-index+repo+distill6000';
interface Call { stage: string; usageIn: number; ms: number; text: string }

const call = async (model: string, stage: string, prompt: string, sink: Call[]): Promise<string> => {
  const t0 = Date.now();
  const r = await callModel({ model, messages: [{ role: 'user', content: prompt }] });
  sink.push({ stage, usageIn: r.usage.in, ms: Date.now() - t0, text: r.text ?? '' });
  console.error(`  ${stage} — ${Date.now() - t0}ms, in=${r.usage.in}`);
  return r.text ?? '';
};

/** 真 gen + reduce(生产 Stage 1-2 的形状)。一次生成,存盘复用。 */
async function realChampions(corpus: string): Promise<{ key: string; text: string }[]> {
  if (existsSync(CHAMPIONS_CACHE)) {
    const cached = JSON.parse(readFileSync(CHAMPIONS_CACHE, 'utf8')) as { key: string; text: string }[];
    console.error(`真 champions 复用缓存 (${cached.length} 个镜头, 共 ${cached.reduce((a, c) => a + c.text.length, 0)} 字符)`);
    return cached;
  }
  const sink: Call[] = [];
  const champions: { key: string; text: string }[] = [];
  for (const lens of LENSES) {
    // Stage 1 gen: 每 sub-angle 一发 (corpus + persona + angle)
    const variants: string[] = [];
    for (const angle of lens.angles) {
      variants.push(await call(LENS_SEAT, `gen:${lens.key}:${angle.slice(0, 8)}`,
        `${corpus}\n\n<persona>${lens.persona}</persona>\n\n研究问题: ${QUESTION}\n\n本 leaf 的具体 sub-angle: ${angle}\n\n用 ground-truth 里的真实模块名推理 (禁造)。结构化、具体、可落地、只答这个 sub-angle。`, sink));
    }
    // Stage 2 reduce: 该镜头的首席 judge 合成冠军
    const body = variants.map((v, i) => `### sub-angle ${i + 1}\n${v}`).join('\n\n');
    const text = await call(LENS_SEAT, `reduce:${lens.key}`,
      `${corpus}\n\n镜头[${lens.key}] 的 ${variants.length} 个 sub-angle 产出:\n${body}\n\n你是该镜头的首席 judge。合成这镜头的**冠军答案**: 取最强骨架 + 嫁接各 sub-angle 的最佳碎片, 去冗余去弱点。直接给冠军答案。`, sink);
    champions.push({ key: lens.key, text });
  }
  mkdirSync(join(ROOT, 'runs'), { recursive: true });
  writeFileSync(CHAMPIONS_CACHE, JSON.stringify(champions, null, 2));
  console.error(`真 champions 生成完毕并存盘 (${sink.length} 发, 共 ${champions.reduce((a, c) => a + c.text.length, 0)} 字符)`);
  return champions;
}

async function runArm(arm: Arm, head: string, championsDigest: string): Promise<Call[]> {
  const calls: Call[] = [];
  const cands: { key: string; text: string }[] = [];
  for (const fr of FRAMINGS) {
    cands.push({ key: fr.key, text: await call(REASON_SEAT, `[${arm}] synth:${fr.key}`, `${head}\n\n各镜头冠军:\n${championsDigest}\n\n<framing>${fr.framing}</framing>\n\n问题: ${QUESTION}\n\n按此 framing 综合成一份完整方案 (具体到模块/文件/接点, 用真实模块名)。`, calls) });
  }
  const candDigest = cands.map((c) => `## 候选[${c.key}]\n${c.text}`).join('\n\n');
  const crits: string[] = [];
  for (const j of CRITERIA) {
    crits.push(`## 维度[${j.key}]\n${await call(REASON_SEAT, `[${arm}] judge:${j.key}`, `${head}\n\n${candDigest}\n\n你是评判维度【${j.criterion}】的 judge。按此维度评 ${cands.length} 个候选。`, calls)}`);
  }
  const critDigest = crits.join('\n\n');
  const fusion = await call(REASON_SEAT, `[${arm}] fusion`, `${head}\n\n${candDigest}\n\nK-judge panel:\n${critDigest}\n\n融合成结构化分析: 共识、分歧、独有洞察、覆盖缺口、怎么嫁接。`, calls);
  await call(REASON_SEAT, `[${arm}] graft`, `${head}\n\n${candDigest}\n\nK-judge panel:\n${critDigest}\n\nFusion:\n${fusion}\n\n你是首席架构师。合成**唯一最终方案**: 选最强骨架, 嫁接共识与独特洞察, 消解矛盾、补齐缺口。直接给方案, 不要元评论。`, calls);
  return calls;
}

/** 机械尺:仓内路径逐条 existsSync。三项一次全出,不许只挑一列。 */
function paths(text: string): { real: number; fake: number; fakeList: string[] } {
  const cited = [...new Set(text.match(/\b(?:src|scripts|docs|test)\/[\w./-]+\.\w+/g) ?? [])];
  const fake = cited.filter((p) => !existsSync(join(ROOT, p)));
  return { real: cited.length - fake.length, fake: fake.length, fakeList: fake.slice(0, 6) };
}

/**
 * faithfulness 判据(借 RAG 评测那一族,不自己发明)。
 * **一次只判一份方案** —— 没有并排就没有位置可偏置,得到绝对分而不是排名。
 */
async function faithfulness(plan: string, context: string): Promise<{ supported: number; unsupported: number; examples: string[] } | { error: string }> {
  try {
    const r = await callModel({
      model: JUDGE_SEAT,
      messages: [{
        role: 'user',
        content:
          `下面是【参考材料】和【一份方案】。逐条检查方案里的**具体断言**(点名文件/函数/机制/数字的那些,` +
          `不算纯设计主张),判断它能不能被参考材料支持。\n\n=== 参考材料 ===\n${context}\n\n=== 方案 ===\n${plan}\n\n` +
          `只输出 JSON: {"supported":<整数>,"unsupported":<整数>,"unsupportedExamples":["<最多3条>"]}`,
      }],
    });
    const m = (r.text ?? '').match(/\{[\s\S]*\}/);
    if (!m) return { error: 'no-json' };
    const j = JSON.parse(m[0]) as { supported: number; unsupported: number; unsupportedExamples?: string[] };
    return { supported: Number(j.supported), unsupported: Number(j.unsupported), examples: j.unsupportedExamples ?? [] };
  } catch (e) {
    return { error: String(e).slice(0, 200) };
  }
}

async function main(): Promise<void> {
  const groundTruth = EXTERNAL_FILES.map((f) => `# ${f}\n\n${readFileSync(join(ROOT, f), 'utf8')}`).join('\n\n');
  const probe = repoProbe(REPO_QUERIES, { cwd: ROOT });
  const repoBlockFull = renderRepoHits(probe);
  const corpus = `${groundTruth}\n\n<second-pass-corpus round="2">\n${repoBlockFull}\n</second-pass-corpus>`;

  const champions = await realChampions(corpus);
  const championsDigest = champions.map((c) => `## 镜头冠军[${c.key}]\n${c.text}`).join('\n\n');

  // D 臂:行级命中原文保留,整读文件蒸到 6000
  const hitsOnly = renderRepoHits({ hits: probe.hits, files: [] });
  const distiller = createModelSourceDistiller({ maxChars: 6000 });
  const parts: string[] = [];
  for (const f of probe.files) {
    try {
      const r = await distiller({ body: f.text, title: f.path, url: `repo://${f.path}`, question: QUESTION });
      parts.push(`<repo-file-distilled path="${f.path}" orig="${f.text.length}" extract="${r.extract.length}">\n${r.extract}\n</repo-file-distilled>`);
    } catch {
      parts.push(`<repo-file path="${f.path}">\n${f.text}\n</repo-file>`); // 增益非链路: 失败退回全文
    }
  }
  const block6000 = `${hitsOnly}\n${parts.join('\n')}`;

  const index = buildCorpusIndex(corpus);
  const heads: Record<Arm, string> = {
    'A-full': corpus,
    'B-index': index,
    'C-index+repo': `${index}\n\n${repoBlockFull}`,
    'D-index+repo+distill6000': `${index}\n\n${block6000}`,
  };
  console.error(`语料 ${corpus.length} · 冠军 ${championsDigest.length} · 头部: ` +
    (Object.keys(heads) as Arm[]).map((a) => `${a}=${heads[a].length}`).join(' · '));

  const results: Record<string, { calls: Call[]; final: string }> = {};
  for (const arm of Object.keys(heads) as Arm[]) {
    console.error(`\n=== ${arm} ===`);
    const calls = await runArm(arm, heads[arm], championsDigest);
    results[arm] = { calls, final: calls[calls.length - 1]!.text };
  }

  const tag = process.argv[2] ? `-${process.argv[2]}` : '';
  const sumIn = (cs: Call[]): number => cs.reduce((a, c) => a + c.usageIn, 0);
  const baseIn = sumIn(results['A-full']!.calls);
  mkdirSync(join(ROOT, 'runs'), { recursive: true });
  for (const arm of Object.keys(heads) as Arm[]) writeFileSync(join(ROOT, `runs/e6${tag}-${arm}.md`), results[arm]!.final);

  // faithfulness 的 context = 与生产脊柱同源的全部材料 (corpus + 冠军)
  const ctx = `${corpus}\n\n${championsDigest}`;
  const arms: Record<string, unknown> = {};
  for (const arm of Object.keys(heads) as Arm[]) {
    const p = paths(results[arm]!.final);
    const f = await faithfulness(results[arm]!.final, ctx);
    const tokens = sumIn(results[arm]!.calls);
    const score = 'error' in f ? null : f.supported + f.unsupported === 0 ? null : f.supported / (f.supported + f.unsupported);
    arms[arm] = { headChars: heads[arm].length, spinePromptTokens: tokens, promptTokenCut: 1 - tokens / baseIn, paths: p, faithfulness: f, faithfulnessScore: score };
    console.error(`  [faith] ${arm}: ${JSON.stringify(f).slice(0, 120)}`);
  }

  const baseFaith = (arms['A-full'] as { faithfulnessScore: number | null }).faithfulnessScore;
  const baseFake = (arms['A-full'] as { paths: { fake: number } }).paths.fake;
  const out = {
    at: new Date().toISOString(), experiment: 'E-6',
    seats: { lens: LENS_SEAT, spine: REASON_SEAT, judge: JUDGE_SEAT },
    corpus: { chars: corpus.length, championsChars: championsDigest.length, repoHits: probe.hits.length, repoFiles: probe.files.length },
    verdictThresholds: VERDICT, arms,
    verdicts: Object.fromEntries((Object.keys(heads) as Arm[]).map((a) => {
      const v = arms[a] as { faithfulnessScore: number | null; paths: { fake: number }; promptTokenCut: number };
      return [a, {
        faithfulnessOk: baseFaith !== null && v.faithfulnessScore !== null ? v.faithfulnessScore >= baseFaith - VERDICT.faithfulnessDrop : null,
        fakePathsOk: v.paths.fake <= baseFake,
        costCutOk: v.promptTokenCut >= VERDICT.minPromptTokenCut,
      }];
    })),
  };
  writeFileSync(join(ROOT, `runs/e6${tag}.json`), JSON.stringify(out, null, 2));

  console.error('\n读数 (三项一次全出):');
  for (const arm of Object.keys(heads) as Arm[]) {
    const v = arms[arm] as { spinePromptTokens: number; promptTokenCut: number; paths: { real: number; fake: number }; faithfulnessScore: number | null };
    console.error(`  ${arm.padEnd(26)} token ${String(v.spinePromptTokens).padStart(7)} (削 ${(v.promptTokenCut * 100).toFixed(1)}%) · 真路径 ${v.paths.real} · 假路径 ${v.paths.fake} · faith ${v.faithfulnessScore === null ? 'n/a' : v.faithfulnessScore.toFixed(2)}`);
  }
}

await main();
