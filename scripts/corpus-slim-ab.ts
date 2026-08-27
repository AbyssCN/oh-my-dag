/**
 * scripts/corpus-slim-ab —— 脊柱语料瘦身的 A/B 实验装置(单变量,离线重放)。
 *
 * ## 它在量什么
 *
 * 分支 `worktree-bridge-cse_01Es39YTKecoZkJFtPyx7LjL` 提议把 `research/fanout` 里
 * post-reduce 脊柱四发(synth / judge / fusion / graft)的 prompt 从**全文语料**换成
 * **语料索引**(标题行 + 去重 URL + 规模)。那份改动只有成本/延迟一侧的读数,
 * **质量一侧一次都没量过** —— 而它是个删信息的改动。本脚本补上缺的那一半。
 *
 * ## 四要素(动手前钉死,不许事后改)
 *
 * - **单一变量**:脊柱四发 prompt 的头部 = 全文 vs 索引。其余逐字节相同 ——
 *   同语料、同 championsDigest、同座位、同 framing/criteria 文本、同调用顺序。
 * - **对照基线**:全文臂(= 今天 main 的行为)。
 * - **预先声明的判据**(下面 `VERDICT` 常量,程序自己算,不靠事后读感觉):
 *   · 保留瘦身 ⟺ 质量不劣 ∧ 成本显著降。
 *   · 质量不劣 = 机械引用留存率 ≥ 0.7 **且** 盲评没判它更差。
 *   · 成本显著降 = 脊柱四发的 prompt token 降幅 ≥ 50%。
 *   · 任一不满足 → 结论是"不该照原样合",具体走哪条由 owner 裁。
 * - **两侧都写**:不塌与塌都进报告,不塌也要写清它没覆盖什么。
 *
 * ## 三条刻意的简化(会写进报告,别让读的人以为这是全流水线读数)
 *
 * 1. **championsDigest 是确定性构造的**(从语料切三段),不是模型综合出来的。
 *    脊柱四发的输入 = corpus + championsDigest,变量只在前一半,所以后一半真不真
 *    不影响单变量性;确定性构造换来完全可复现 + 省一发钱。
 * 2. **两臂都跑便宜座**(生产脊柱跑的是慢推理座)。**延迟的绝对值不能外推**到慢座,
 *    方向可以(prompt 长 → 延迟高)。token 差是结构性的,与座位无关。
 * 3. **语料规模小于生产**(生产 `--deep` 实测 ~20 万 token)。信息删减的效应是按比例的,
 *    但"大语料下才出现的丢失"这一格本实验**量不到**,报告里明写。
 *
 * 跑法:`bun run scripts/corpus-slim-ab.ts`(约 12 发真调用)。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { callModel } from '../src/model';

// ── 预先声明的判据(§四要素;程序算,不事后改)────────────────────────────────
const VERDICT = {
  /** 机械引用留存率下限:瘦身臂最终方案里的真实模块名 + URL 数 ÷ 全文臂的同一读数。 */
  minReferenceRetention: 0.7,
  /** 脊柱四发 prompt token 的最小降幅。 */
  minPromptTokenCut: 0.5,
} as const;

const ROOT = '/home/nick/repos/oh-my-dag';
const REASON_SEAT = 'minimax-cn:MiniMax-M3';
/** 盲评换家族 —— 同族自审会复用同一盲点。 */
const BLIND_JUDGE_SEAT = 'openai-codex:gpt-5.6-sol';

/** 语料 = 固定文件、固定顺序(确定性;换文件就是换实验)。 */
const CORPUS_FILES = [
  'docs/reference/loop-engineering/NOTES.md',
  'docs/reference/loop-engineering/openai-running-agents.md',
  'docs/reference/loop-engineering/demystifying-evals.md',
  'docs/reference/design-review-distill-2026-08-11/DISTILL-CORPUS.md',
];

/**
 * 逐字复制自分支 `worktree-bridge-cse_01Es39…` 的 `buildCorpusIndex`。
 * **刻意复制而不是 import** —— 实验装置不该要求先把被测改动合进生产。
 */
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

const QUESTION = '给 agent harness 设计一套"执行体空转时的有界路由"机制:怎么检测、怎么分档干预、每档判成判败的信号是什么。';

const FRAMINGS = [
  { key: 'mechanism', framing: '以机制为骨架:检测面、干预面、判据面各自的接缝在哪,谁负责什么。' },
  { key: 'failure', framing: '以失效模式为骨架:先枚举它会怎么坏,再让每条设计都对应一种坏法。' },
];

const CRITERIA = [
  { key: 'grounded', criterion: '有没有引用真实来源与具体做法(而不是泛泛而谈)' },
  { key: 'falsifiable', criterion: '判成/判败信号是否可机械判定(而不是散文式描述)' },
];

interface Call { stage: string; promptChars: number; usageIn: number; usageOut: number; ms: number; text: string }

async function runArm(armName: 'full' | 'slim', corpus: string, head: string, championsDigest: string): Promise<Call[]> {
  const calls: Call[] = [];
  const call = async (stage: string, prompt: string): Promise<string> => {
    const t0 = Date.now();
    const r = await callModel({ model: REASON_SEAT, messages: [{ role: 'user', content: prompt }] });
    calls.push({ stage, promptChars: prompt.length, usageIn: r.usage.in, usageOut: r.usage.out, ms: Date.now() - t0, text: r.text ?? '' });
    console.error(`  [${armName}] ${stage} — ${Date.now() - t0}ms, in=${r.usage.in}`);
    return r.text ?? '';
  };

  // Stage 3: synth ×2(与生产同 prompt 骨架)
  const cands: { key: string; text: string }[] = [];
  for (const fr of FRAMINGS) {
    const text = await call(
      `synth:${fr.key}`,
      `${head}\n\n各镜头冠军:\n${championsDigest}\n\n<framing>${fr.framing}</framing>\n\n按此 framing 综合成一份完整方案 (具体到模块/文件/接点, 用真实模块名)。`,
    );
    cands.push({ key: fr.key, text });
  }
  const candDigest = cands.map((c) => `## 候选[${c.key}]\n${c.text}`).join('\n\n');

  // Stage 4: judge ×2
  const crits: string[] = [];
  for (const j of CRITERIA) {
    const text = await call(
      `judge:${j.key}`,
      `${head}\n\n${candDigest}\n\n你是评判维度【${j.criterion}】的 judge。按此维度评 ${cands.length} 个候选: 各自强弱 + 哪个最优 + 该嫁接谁的哪段。只从你这个维度评。`,
    );
    crits.push(`## 维度[${j.key}]\n${text}`);
  }
  const critDigest = crits.join('\n\n');

  // Stage 4.5: fusion
  const fusion = await call(
    'fusion',
    `${head}\n\n${candDigest}\n\nK-judge panel 多维评判:\n${critDigest}\n\n把上面的评判融合成结构化分析: 共识点、分歧点、各候选独有的洞察、覆盖缺口、最终该怎么嫁接。`,
  );

  // Stage 5: graft(终审 —— 质量读数取这一发)
  await call(
    'graft',
    `${head}\n\n${candDigest}\n\nK-judge panel 多维评判:\n${critDigest}\n\nFusion 融合分析 (结构化):\n${fusion}\n\n你是首席架构师。据 panel 多维评判 + fusion 融合分析**合成唯一最终方案**: 选最强骨架, 嫁接共识与独特洞察, 显式消解矛盾点、补齐覆盖缺口与盲点。直接给最终方案, 不要元评论。`,
  );

  void corpus;
  return calls;
}

/** 机械读数:真实模块路径引用数 + URL 数 + 字数。零 LLM。 */
function mechanical(text: string): { modules: number; urls: number; chars: number } {
  const modules = new Set(text.match(/\b(?:src|scripts|docs|test)\/[\w./-]+\.\w+/g) ?? []);
  const urls = new Set(text.match(/https?:\/\/[^\s<>()[\]{}"'`,;）)]+/g) ?? []);
  return { modules: modules.size, urls: urls.size, chars: text.length };
}

async function main(): Promise<void> {
  const corpus = CORPUS_FILES.map((f) => `# ${f}\n\n${readFileSync(join(ROOT, f), 'utf8')}`).join('\n\n');
  const index = buildCorpusIndex(corpus);
  console.error(`语料 ${corpus.length} 字符 → 索引 ${index.length} 字符 (${((1 - index.length / corpus.length) * 100).toFixed(1)}% 削减)`);

  // championsDigest: 确定性构造(简化 ①)—— 从语料等分切三段,各取前 4000 字符。
  const third = Math.floor(corpus.length / 3);
  const championsDigest = [0, 1, 2]
    .map((i) => `## 镜头冠军[lens${i + 1}]\n${corpus.slice(i * third, i * third + 4000)}`)
    .join('\n\n');

  console.error('\n=== 全文臂(基线)===');
  const full = await runArm('full', corpus, corpus, championsDigest);
  console.error('\n=== 瘦身臂 ===');
  const slim = await runArm('slim', corpus, index, championsDigest);

  const spineIn = (cs: Call[]): number => cs.reduce((a, c) => a + c.usageIn, 0);
  const spineMs = (cs: Call[]): number => cs.reduce((a, c) => a + c.ms, 0);
  const fullFinal = full[full.length - 1]!.text;
  const slimFinal = slim[slim.length - 1]!.text;
  const mFull = mechanical(fullFinal);
  const mSlim = mechanical(slimFinal);

  // 盲评:换家族,顺序固定为 A=full / B=slim 但**不告诉 judge 谁是谁**。
  const blind = await callModel({
    model: BLIND_JUDGE_SEAT,
    messages: [
      {
        role: 'user',
        content:
          `下面是同一个研究问题的两份最终方案,由同一个模型在两种不同的上下文条件下产出。你不知道哪份用了什么条件,也不要猜。\n\n` +
          `问题: ${QUESTION}\n\n=== 方案 A ===\n${fullFinal}\n\n=== 方案 B ===\n${slimFinal}\n\n` +
          `只回答三件事,各一段: ① 哪份更具体、更 grounded(点出具体证据);② 哪份出现了没有依据的断言或编造的名字(逐条点名);③ 若必须二选一交付,选哪份、为什么。`,
      },
    ],
  });

  const retention = (mFull.modules + mFull.urls) === 0 ? 1 : (mSlim.modules + mSlim.urls) / (mFull.modules + mFull.urls);
  const tokenCut = 1 - spineIn(slim) / spineIn(full);

  const out = {
    at: new Date().toISOString(),
    seats: { spine: REASON_SEAT, blindJudge: BLIND_JUDGE_SEAT },
    corpusChars: corpus.length,
    indexChars: index.length,
    verdictThresholds: VERDICT,
    full: { spinePromptTokens: spineIn(full), spineMs: spineMs(full), mechanical: mFull, perCall: full.map(({ text, ...r }) => r) },
    slim: { spinePromptTokens: spineIn(slim), spineMs: spineMs(slim), mechanical: mSlim, perCall: slim.map(({ text, ...r }) => r) },
    referenceRetention: retention,
    promptTokenCut: tokenCut,
    mechanicalVerdict: {
      qualityNotWorse: retention >= VERDICT.minReferenceRetention,
      costCutEnough: tokenCut >= VERDICT.minPromptTokenCut,
    },
    blindJudgeText: blind.text ?? '',
  };
  mkdirSync(join(ROOT, 'runs'), { recursive: true });
  writeFileSync(join(ROOT, 'runs/corpus-slim-ab.json'), JSON.stringify(out, null, 2));
  writeFileSync(join(ROOT, 'runs/corpus-slim-ab-full.md'), fullFinal);
  writeFileSync(join(ROOT, 'runs/corpus-slim-ab-slim.md'), slimFinal);
  console.error(
    `\n读数: prompt token ${spineIn(full)} → ${spineIn(slim)} (削 ${(tokenCut * 100).toFixed(1)}%) · ` +
      `墙钟 ${spineMs(full)}ms → ${spineMs(slim)}ms · 引用留存 ${(retention * 100).toFixed(0)}% ` +
      `(模块 ${mFull.modules}→${mSlim.modules}, URL ${mFull.urls}→${mSlim.urls})`,
  );
}

await main();
