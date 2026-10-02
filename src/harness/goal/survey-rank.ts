/**
 * goal/survey-rank —— **勘察包第 8 段: Jev 给候选源文件打分, 前 5 个连大纲交给 conductor** (2026-10-02)。
 *
 * ## 它补的洞
 * conductor 派活前中位 23 步读仓。勘察包前七段里只有影响包含源码, 且只按 goal 里的**标识符**找;
 * 中文 goal 里标识符很少, 要改的文件常不在包里。离线回测 (`runs/2026-10-02-jev-survey-rank/result.md`,
 * code80 仓内源文件 ≥ 6 的 26 题): 今天的包覆盖要改文件 0.596 (严格) / 0.782 (宽松), Jev top-5 覆盖 0.881,
 * 两者并起来 +0.337 / +0.192; Jev 第一名命中 0.65, 词法排序 0.19。
 *
 * ## 为什么用 Jev 不用 LLM
 * 「这个文件要不要改」是封闭的事实题, 答案事后能对 gold.patch 核 —— Jev 擅长的那一类
 * (`docs/plan/2026-10-02-jev-接入方案.md` §0.2)。一题 100 个候选 = 5 发, 并发后 ~0.3 s, ~$0.0002。
 *
 * ## 边界 (模型外结构)
 *  · 默认关 (`OMD_SURVEY_RANK=1` 才开): 单变量臂, 关着时所有 prompt 逐字节同旧。
 *  · 永不抛 (④ 告知层): 无 key / Jev 挂 / 候选为空 → `text: ''` + `why` 原文, 点火照跑 (§静默坑 2)。
 *  · 候选 > 100 时按 goal 词 × idf 预筛到 100 —— 与回测同一条逻辑, 在线读数才能对上离线读数。
 *  · 是线索不是判词: header 明写「仅供参考」; conductor 仍自己决定读什么。
 *  · 读数进 `LoopLedger.surveyRank`。三态: 整格缺席 = 没开; 在场 `scored: 0` = 开了没打成 (`why` 在场)。
 *
 * ## 反向自检 (survey-rank.test.ts)
 *  把排序方向反过来 → 「最高分排第一」红; 把开关改成恒开 → 「关着时不调 Jev」红;
 *  把预筛删掉 → 「> 100 个候选只问 100 个」红。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { askJev, type JevAskInput, type JevAskResult, type JevQuestion } from '../../model/jev-client';
import { logger } from '../logger';

export const SURVEY_RANK_HEADER =
  '===== Jev 打分最高的源文件 (分数 0–2, 2 = 完成目标需要改它; 仅供参考, 读不读你自己定) =====';
const SOURCE_EXT = /\.(py|ts|tsx|js|jsx|go|rs|java|rb)$/;
const SKIP_DIR = new Set(['.git', 'node_modules', 'venv', '.venv', 'site-packages', 'dist', 'build', '__pycache__', 'vendor', 'target', '.omd']);
const BATCH = 20;
const MAX_CANDIDATES = 100;
const TOP_K = 5;
const OUTLINE_CHARS = 600;
const SCORE_CRITERIA = ['No: unrelated to the goal', 'Related, but no edit is needed', 'Yes: this file must be edited'];

export interface SurveyRankFacts {
  candidates: number;
  prefiltered: boolean;
  requests: number;
  /** 拿到分数的文件数。0 = 开了没打成 (why 在场), 不是「全都不相关」(§静默坑 1)。 */
  scored: number;
  /** 进文本的文件, 带分, 按分降序。 */
  top: Array<{ path: string; score: number }>;
  ms: number;
  inputTokens: number;
  chars: number;
  why?: string;
}

export interface SurveyRank {
  text: string;
  facts: SurveyRankFacts;
}

export function surveyRankEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.OMD_SURVEY_RANK?.trim() === '1';
}

function listSourceFiles(root: string, dir = root, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!SKIP_DIR.has(e.name)) listSourceFiles(root, join(dir, e.name), out);
    } else if (SOURCE_EXT.test(e.name)) out.push(relative(root, join(dir, e.name)));
  }
  return out;
}

/** goal 词 × idf 的命中分 —— 只用于候选 > 100 时预筛, 也用作同分时的破平序。 */
function lexicalOrder(root: string, files: string[], goal: string): string[] {
  const terms = [...new Set((goal.match(/[A-Za-z_][A-Za-z0-9_]{2,}/g) ?? []).map((t) => t.toLowerCase()))];
  const texts = files.map((f) => `${readFileSync(join(root, f), 'utf8').toLowerCase()}\n${f.toLowerCase()}`);
  const df = terms.map((t) => texts.filter((x) => x.includes(t)).length);
  const score = (i: number): number =>
    terms.reduce((s, t, k) => {
      const d = df[k] ?? 0;
      return d === 0 ? s : s + ((texts[i] ?? '').split(t).length - 1) * Math.log((files.length + 1) / d);
    }, 0);
  return files
    .map((path, i) => ({ path, s: score(i) }))
    .sort((a, b) => b.s - a.s || a.path.localeCompare(b.path))
    .map((x) => x.path);
}

export function fileOutline(root: string, path: string): string {
  const lines = readFileSync(join(root, path), 'utf8').split('\n');
  const sigs = lines.filter((l) => /^\s*(export |async |pub |public |private )?(def|class|function|func|fn|interface|type|const [A-Z])\b/.test(l));
  return [...lines.slice(0, 8), '…', ...sigs].join('\n').slice(0, OUTLINE_CHARS);
}

export interface SurveyRankOpts {
  /** 测试注入; 缺省 = 真 Jev。 */
  ask?: (input: JevAskInput) => Promise<JevAskResult>;
  env?: NodeJS.ProcessEnv;
}

/** 永不抛。开关由调用方先问 {@link surveyRankEnabled} —— 关着时不该走到这里 (不读盘、不发请求)。 */
export async function buildSurveyRank(goal: string, root: string, opts: SurveyRankOpts = {}): Promise<SurveyRank> {
  const started = Date.now();
  const facts: SurveyRankFacts = { candidates: 0, prefiltered: false, requests: 0, scored: 0, top: [], ms: 0, inputTokens: 0, chars: 0 };
  const done = (why?: string): SurveyRank => {
    facts.ms = Date.now() - started;
    if (why) facts.why = why;
    return { text: '', facts };
  };
  try {
    const all = listSourceFiles(root);
    if (all.length === 0) return done('仓内没有源文件');
    const order = lexicalOrder(root, all, goal);
    facts.prefiltered = all.length > MAX_CANDIDATES;
    const cand = facts.prefiltered ? order.slice(0, MAX_CANDIDATES) : all;
    facts.candidates = cand.length;

    const ask = opts.ask ?? askJev;
    const outlines = new Map(cand.map((p) => [p, fileOutline(root, p)]));
    const batches: string[][] = [];
    for (let i = 0; i < cand.length; i += BATCH) batches.push(cand.slice(i, i + BATCH));
    const results = await Promise.all(
      batches.map((batch) => {
        const files: Record<string, { path: string; outline: string }> = {};
        const questions: Record<string, JevQuestion> = {};
        batch.forEach((p, i) => {
          files[`f${i}`] = { path: p, outline: outlines.get(p) ?? '' };
          questions[`f${i}`] = {
            type: 'score',
            instructions: `To complete the goal, does the file ${p} (state.files.f${i}) need to be edited?`,
            criteria: SCORE_CRITERIA,
          };
        });
        return ask({ state: { goal, files }, questions, ...(opts.env ? { env: opts.env } : {}) }).then((r) => ({ r, batch }));
      }),
    );
    facts.requests = batches.length;

    const scores = new Map<string, number>();
    const whys: string[] = [];
    for (const { r, batch } of results) {
      if (!r.ok) {
        whys.push(`${r.why}${r.detail ? `: ${r.detail}` : ''}`);
        continue;
      }
      facts.inputTokens += r.inputTokens ?? 0;
      batch.forEach((p, i) => {
        const s = r.answers[`f${i}`]?.score;
        if (typeof s === 'number') scores.set(p, s);
      });
    }
    facts.scored = scores.size;
    if (scores.size === 0) return done(`Jev 没打出分: ${[...new Set(whys)].join('; ')}`);

    // 同分按词法序破平 (与回测同), 不按路径字母序 —— 免得塞进一个与 Jev 无关的排序
    const lexPos = new Map(order.map((p, i) => [p, i]));
    const top = [...scores.entries()]
      .sort((a, b) => b[1] - a[1] || (lexPos.get(a[0]) ?? 1e9) - (lexPos.get(b[0]) ?? 1e9))
      .slice(0, TOP_K)
      .map(([path, score]) => ({ path, score: Number(score.toFixed(2)) }));
    facts.top = top;
    if (whys.length > 0) facts.why = `部分批次失败 (${whys.length}/${batches.length}): ${[...new Set(whys)].join('; ')}`;

    const body = top.map((t, i) => `${i + 1}. ${t.path} (${t.score.toFixed(2)})\n${outlines.get(t.path) ?? ''}`).join('\n\n');
    const text = `${SURVEY_RANK_HEADER}\n${body}`;
    facts.chars = text.length;
    facts.ms = Date.now() - started;
    return { text, facts };
  } catch (e) {
    logger.warn({ root, err: String(e).slice(0, 200) }, '[survey-rank] 第 8 段算不出来 → 这趟没有这一段 (照跑)');
    return done(`异常: ${String(e).slice(0, 200)}`);
  }
}
