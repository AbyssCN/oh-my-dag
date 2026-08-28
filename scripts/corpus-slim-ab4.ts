/**
 * scripts/corpus-slim-ab4 —— 脊柱语料瘦身 **E-3**:生产同款语料 + 四臂 + 两把分开的尺子。
 *
 * ## 为什么推翻前三跑的设计(owner 2026-08-28 指出)
 *
 * 生产的脊柱语料是**混合**的:`fanout.ts:360` 的 `head = stablePrefix + groundTruth`
 * (外部爬取),每轮 second-pass 再 `+=` 追加两条腿的产物 —— web 腿抓 URL,
 * **仓内腿 `research/repo-probe.ts:155` 的 `repoProbe` 用确定性 ugrep 取 `path:line` 命中**。
 *
 * 而前三跑:E-2a 用**纯外部**文档(任何仓内路径按定义都是编的 → 尺子必坏),
 * E-2b/E-2c 用**纯仓内 docs**(路径直接躺在正文里 → 测的是"模型复述路径的能力",
 * 而生产里那些路径是 repoProbe 喂进来的,根本不需要模型记)。
 * **两个极端都不是生产的形状,测的问题和生产要答的问题不是同一个。**
 *
 * 还有一个框架错误:前三跑把问题框成**二选一**(全文 vs 索引),于是
 * 「渐进式披露」从一开始就不在候选集里。本跑把它加回来。
 *
 * ## 四臂(单变量 = 脊柱四发的 prompt 头,其余逐字节相同)
 *
 * | 臂 | 头部构成 |
 * |---|---|
 * | A 全文 | corpus 全文(= 今天 main 的行为,基线) |
 * | B 裸索引 | 标题骨架 + URL |
 * | C 索引+真清单 | B + `renderRepoHits(repoProbe(...))` —— **路径真值由 ugrep 保证,模型没机会编** |
 * | D C+确定性展开 | C + 被冠军/候选**点名过**的 section 全文 |
 *
 * ## 确定性展开为什么不是工具循环(D-6 那条在案裁决)
 *
 * `repo-probe.ts` 头注逐字写着:「**刻意不是工具循环**:给 leaf 一个 grep 工具意味着
 * "查几次、查什么"由模型自由裁量,那正是 D-6 判过的下限流失。模型出上限(缺什么),
 * 代码出下限(实际取到什么)」。
 *
 * 所以 D 臂**不给模型任何取用面**。展开哪几段由 `expandNamedSections` 这个纯函数定:
 * 扫 championsDigest 文本,凡是 corpus 的 section 标题在里面**出现过**的,就展开那一段全文,
 * 按出现顺序取,总量封顶。模型不参与"要不要拉"这个决策 —— 它甚至不知道有这回事。
 *
 * ## 两把分开的尺子(前三跑把两类引用压成一个数,那是第二层尺子问题)
 *
 * research 产物有两类引用,判据本来就不同:
 * - **仓内落点** → `existsSync` 逐条核验:`repoRealPaths` / `repoFakePaths`;
 * - **外部引用** → URL 在 corpus 里出现过 = 真引用,没出现 = 编造:`urlReal` / `urlFake`。
 *
 * ## 预先声明的判据(E-3;程序算,不事后改)
 *
 * 某臂**可以取代全文** ⟺ 三条同时成立(n=3 取中位数):
 *   ① 仓内真路径数 ≥ 全文臂 × 0.7;
 *   ② 编造总数(仓内假路径 + 假 URL)≤ 全文臂;
 *   ③ 脊柱 prompt token 降幅 ≥ 0.5。
 *
 * ⚠ 仍然量不到的:生产 `--deep` 的语料规模(~20 万 token)与真实爬取的杂质。本跑的外部腿
 * 是仓内留档的外部资料,不是现抓的。
 *
 * 跑法:`bun run scripts/corpus-slim-ab4.ts [tag]`(4 臂 × 6 发 + 1 发盲评)。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { callModel } from '../src/model';
import { repoProbe, renderRepoHits } from '../src/harness/research/repo-probe';

const VERDICT = { minRealPathRatio: 0.7, minPromptTokenCut: 0.5 } as const;

const ROOT = '/home/nick/repos/oh-my-dag';
const REASON_SEAT = 'minimax-cn:MiniMax-M3';
const BLIND_JUDGE_SEAT = 'openai-codex:gpt-5.6-sol';

/** 外部腿:仓内留档的**外部**资料(与生产的 groundTruth 对位,不含本仓路径)。 */
const EXTERNAL_FILES = [
  'docs/reference/loop-engineering/NOTES.md',
  'docs/reference/loop-engineering/openai-running-agents.md',
  'docs/reference/loop-engineering/demystifying-evals.md',
];

/** 仓内腿:交给确定性检索的字面串(模型出上限的那一半在本实验里由问题固定)。 */
const REPO_QUERIES = [
  'buildSelfCheckFollowUp',
  'SelfRepairLedger',
  'spinRouteEnvEnabled',
  'strategyForRound',
  'maxSelfRepair',
  'memory_recall',
];

const QUESTION = '在 omd 这个仓里,给自修环再加一档 R3(记忆召回):它该挂在哪个接缝上、注入什么、判成判败的信号是什么。要点名真实的文件与函数。';

const FRAMINGS = [
  { key: 'seam', framing: '以接缝为骨架:先定它挂在哪个已有接缝上,再定它注入什么。' },
  { key: 'failure', framing: '以失效模式为骨架:先枚举它会怎么静默失效,再让每条设计对应一种坏法。' },
];
const CRITERIA = [
  { key: 'grounded', criterion: '点名的文件/函数是不是语料里真实存在的' },
  { key: 'falsifiable', criterion: '判成/判败信号是否可机械判定' },
];

/** 索引(逐字复制自被测分支)。 */
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

/**
 * D 臂的**确定性展开**:凡是 corpus 的 section 标题在 `named` 文本里出现过,就展开那一段全文。
 * 纯函数,零模型参与 —— 展开哪几段由代码定(D-6:模型出上限,代码出下限)。
 */
function expandNamedSections(corpus: string, named: string, maxChars = 30_000): string {
  const lines = corpus.split('\n');
  const sections: { title: string; body: string[] }[] = [];
  for (const l of lines) {
    if (/^#{1,4} /.test(l.trim())) sections.push({ title: l.trim(), body: [l] });
    else if (sections.length > 0) sections[sections.length - 1]!.body.push(l);
  }
  const picked: string[] = [];
  let used = 0;
  for (const s of sections) {
    const key = s.title.replace(/^#+\s*/, '').trim();
    if (key.length < 6 || !named.includes(key)) continue;
    const text = s.body.join('\n');
    if (used + text.length > maxChars) break;
    picked.push(text);
    used += text.length;
  }
  return picked.length === 0
    ? '<corpus-expanded count="0">(冠军/候选没有点名任何 section, 无可展开)</corpus-expanded>'
    : `<corpus-expanded count="${picked.length}" chars="${used}">\n${picked.join('\n\n')}\n</corpus-expanded>`;
}

type Arm = 'A-full' | 'B-index' | 'C-index+repo' | 'D-index+repo+expand';
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

/** 尺子①仓内落点 + 尺子②外部引用,**分开量**。 */
function measure(text: string, corpus: string): {
  repoReal: number; repoFake: number; urlReal: number; urlFake: number; fakeExamples: string[];
} {
  const paths = [...new Set(text.match(/\b(?:src|scripts|docs|test)\/[\w./-]+\.\w+/g) ?? [])];
  const repoReal = paths.filter((p) => existsSync(join(ROOT, p)));
  const repoFake = paths.filter((p) => !existsSync(join(ROOT, p)));
  const urls = [...new Set((text.match(/https?:\/\/[^\s<>()[\]{}"'`,;）)]+/g) ?? []).map((u) => u.replace(/[.,;:!?]+$/, '')))];
  const urlReal = urls.filter((u) => corpus.includes(u));
  const urlFake = urls.filter((u) => !corpus.includes(u));
  return {
    repoReal: repoReal.length, repoFake: repoFake.length,
    urlReal: urlReal.length, urlFake: urlFake.length,
    fakeExamples: [...repoFake.slice(0, 5), ...urlFake.slice(0, 3)],
  };
}

async function main(): Promise<void> {
  // ── 生产同款语料:外部 groundTruth + repoProbe 的确定性仓内命中 ──────────────
  const groundTruth = EXTERNAL_FILES.map((f) => `# ${f}\n\n${readFileSync(join(ROOT, f), 'utf8')}`).join('\n\n');
  const probe = repoProbe(REPO_QUERIES, { cwd: ROOT });
  const repoBlock = renderRepoHits(probe);
  const corpus = `${groundTruth}\n\n<second-pass-corpus round="2">\n${repoBlock}\n</second-pass-corpus>`;
  console.error(`语料 ${corpus.length} 字符 (外部 ${groundTruth.length} + 仓内命中 ${repoBlock.length}; hits=${probe.hits.length} files=${probe.files.length})`);

  const third = Math.floor(corpus.length / 3);
  const championsDigest = [0, 1, 2].map((i) => `## 镜头冠军[lens${i + 1}]\n${corpus.slice(i * third, i * third + 4000)}`).join('\n\n');

  const index = buildCorpusIndex(corpus);
  const heads: Record<Arm, string> = {
    'A-full': corpus,
    'B-index': index,
    'C-index+repo': `${index}\n\n${repoBlock}`,
    'D-index+repo+expand': `${index}\n\n${repoBlock}\n\n${expandNamedSections(corpus, championsDigest)}`,
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

  const arms = Object.fromEntries(
    (Object.keys(heads) as Arm[]).map((arm) => {
      const m = measure(results[arm]!.final, corpus);
      const tokens = sumIn(results[arm]!.calls);
      return [arm, {
        headChars: heads[arm].length, spinePromptTokens: tokens,
        spineMs: results[arm]!.calls.reduce((a, c) => a + c.ms, 0),
        measure: m,
        realPathRatio: mBase.repoReal === 0 ? 1 : m.repoReal / mBase.repoReal,
        fabricationTotal: m.repoFake + m.urlFake,
        promptTokenCut: 1 - tokens / baseIn,
      }];
    }),
  );

  const blind = await callModel({
    model: BLIND_JUDGE_SEAT,
    messages: [{
      role: 'user',
      content:
        `同一个问题的四份最终方案,由同一模型在四种上下文条件下产出。你不知道哪份是什么条件,别猜。\n\n问题: ${QUESTION}\n\n` +
        (Object.keys(heads) as Arm[]).map((a, i) => `=== 方案 ${'ABCD'[i]} ===\n${results[a]!.final}`).join('\n\n') +
        `\n\n逐份数,不要总评:每份里 ① 有语料依据的具体断言几条 ② 无依据/看起来编造的几条 ③ 最后给一个从好到坏的排序。`,
    }],
    responseSchema: z.object({
      counts: z.array(z.object({ plan: z.enum(['A', 'B', 'C', 'D']), grounded: z.number(), fabricated: z.number() })),
      ranking: z.array(z.enum(['A', 'B', 'C', 'D'])),
      why: z.string(),
    }),
  });

  const verdictOf = (a: Arm): Record<string, boolean> => ({
    realPathsKept: arms[a]!.realPathRatio >= VERDICT.minRealPathRatio,
    fabricationNotWorse: arms[a]!.fabricationTotal <= (mBase.repoFake + mBase.urlFake),
    costCutEnough: arms[a]!.promptTokenCut >= VERDICT.minPromptTokenCut,
  });

  const tag = process.argv[2] ? `-${process.argv[2]}` : '';
  const out = {
    at: new Date().toISOString(), experiment: 'E-3',
    seats: { spine: REASON_SEAT, blindJudge: BLIND_JUDGE_SEAT },
    corpus: { chars: corpus.length, externalChars: groundTruth.length, repoBlockChars: repoBlock.length, repoHits: probe.hits.length, repoFiles: probe.files.length },
    verdictThresholds: VERDICT, arms,
    verdicts: Object.fromEntries((Object.keys(heads) as Arm[]).map((a) => [a, verdictOf(a)])),
    blindJudge: blind.parsed,
  };
  mkdirSync(join(ROOT, 'runs'), { recursive: true });
  writeFileSync(join(ROOT, `runs/corpus-slim-ab4${tag}.json`), JSON.stringify(out, null, 2));
  for (const arm of Object.keys(heads) as Arm[]) {
    writeFileSync(join(ROOT, `runs/corpus-slim-ab4${tag}-${arm}.md`), results[arm]!.final);
  }
  console.error('\n读数:');
  for (const arm of Object.keys(heads) as Arm[]) {
    const a = arms[arm]!;
    console.error(
      `  ${arm.padEnd(20)} token ${String(a.spinePromptTokens).padStart(7)} (削 ${(a.promptTokenCut * 100).toFixed(1)}%) · ` +
        `真路径 ${a.measure.repoReal} (比 ${(a.realPathRatio * 100).toFixed(0)}%) · 假路径 ${a.measure.repoFake} · ` +
        `真URL ${a.measure.urlReal} 假URL ${a.measure.urlFake} · 判据 ${JSON.stringify(verdictOf(arm))}`,
    );
  }
  console.error(`  盲评排序: ${(blind.parsed as { ranking?: string[] })?.ranking?.join(' > ')}`);
}

await main();
