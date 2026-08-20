/**
 * fanoutqa-2arm —— **公开 benchmark 上的 v4-flash vs MiniMax-M3**(inproc 单发档)。
 *
 * ## 为什么要它(owner 2026-08-14 问的正是这个)
 *
 * 此前两臂的对比全跑在**本仓自造的 10 题** (`worker-quality.ts`) 上。那套题的 easy 端已经实测饱和
 * (基线 deepseek-v4-flash 100%/100%),而「在自己搓的尺子上迭代,迭代的是尺子」正是本仓
 * `fanoutqa/README.md` 开头记着的教训。所以换一把**外部的、有排行榜可比的**尺子再量一次。
 *
 * ## 判分是官方的,不是我重写的
 *
 * `fanoutqa.eval.string.answer_in_text` + `fanoutqa.norm.normalize`(ftfy + spaCy 词形还原 +
 * 数字归一 + 去标点)**原样调用**,经 `scripts/probes/fanoutqa-score.py`。
 * 刻意不碰 BLEURT / GPT-judge 两个指标:前者要 TF + 几百 MB checkpoint, 后者要 OpenAI key 且是判官
 * (判官噪声会污染读数 —— 那正是本仓选 FanOutQA 而不选 FRAMES 的理由)。
 * 留下的 loose/strict accuracy 就是排行榜上那两个确定性指标。
 *
 * ## ⚠ 这把尺子的量程(先量过再用)
 *
 * 拿**金标答案自己当预测**喂官方判分器: loose **0.94** / strict **0.725** —— 不是 1.0。
 * 官方 `str_answer` 把 dict 序列化后再做词边界匹配, 本身有损。**0.94 是天花板不是满分**,
 * 谁也到不了 1.0。两臂同受此偏差 ⇒ 臂间差仍然可读, 但绝对值别拿去和"100%"比。
 * 负控制: 空串 0.0 · 无关文本 0.0(尺子会红, 不是恒绿)。
 *
 * ## 四要素
 *
 * - **单一变量** = 模型坐标。题目(同 40 题, 同 seed)· prompt(仓内冻结的 `fanoutTaskText`,
 *   逐字共用)· maxTokens · 判分器 全同。
 * - **对照基线** = `deepseek:deepseek-v4-flash`(现役 inproc leaf 座), 同一次跑量出来。
 * - **噪声地板** = 每个模型各带一个 `·control` 臂(同配置重跑一遍)。长答案任务方差大,
 *   没有地板就读不出"差 3 个点"到底算不算差。
 * - **成败信号**(跑前钉死): M3 的 loose 若落在 v4-flash 的 ±(噪声地板) 内 = 两臂无差;
 *   低出地板 = M3 在多跳事实回忆上确实弱; 高出地板 = 反之。三种都写进报告。
 *
 * ## ⚠ think 剥离在这里是**公平性要求**, 不是修 bug
 *
 * 判分是**子串命中**: M3 的 `<think>` 段里会列一堆候选实体, 不剥就等于让它把草稿纸也交上去,
 * 命中率虚高。所以两臂都过同一个 `stripThink`(v4-flash 不带 think ⇒ 幂等无影响),
 * 并**同时记录剥前剥后两个分数**, 让这件事在读数上看得见而不是我嘴上保证。
 *
 * 跑: MINIMAX_CN_API_KEY=$MINIMAX_API_KEY bun --env-file=.env run scripts/probes/fanoutqa-2arm.ts [--n 40]
 */
import '../../src/harness/script-bootstrap';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { bootstrapModelRuntime } from '../../src/model/bootstrap';
import { send } from '../../src/model/gateway';
import { fanoutTaskText } from '../../src/eval/tasks/fanoutqa/task-text';
import { stripThink } from './strip-think';

const argv = process.argv.slice(2);
const opt = (n: string): string | undefined => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const N = Math.max(1, Number(opt('n') ?? '40'));
const SEED = Number(opt('seed') ?? '20260814');
const OUT = opt('out') ?? '.omd/eval/fanoutqa-2arm';
/**
 * 首跑设 8192, 结果 M3 反复撞顶 —— 而它的 `<think>` 也计 output, 于是**思考挤掉正文预算**,
 * 答案被截断 ⇒ 命中率低 ⇒ 读成"能力差"。那是尺子的毛病不是模型的:两家官方上限
 * (M3 131,072 · v4-flash 384,000, 见 model-caps) 都远大于 8192。抬到 32,768 让截断退出变量表,
 * 并把 `truncated` 显式记进每一行 —— 剩下的截断要看得见, 不许它躲在分数里。
 */
const MAX_TOKENS = Math.max(1024, Number(opt('max-tokens') ?? '32768'));
const log = (s: string): void => void process.stderr.write(s + '\n');

interface DevQuestion {
  id: string;
  question: string;
  answer: unknown;
}

/** 确定性抽样 —— 同 seed 同题, 否则两臂根本不在同一批题上, 对比作废。 */
function sample<T>(xs: readonly T[], n: number, seed: number): T[] {
  let s = seed >>> 0;
  const rnd = (): number => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const idx = [...xs.keys()];
  for (let i = idx.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [idx[i], idx[j]] = [idx[j]!, idx[i]!];
  }
  return idx.slice(0, n).map((i) => xs[i]!);
}

/**
 * 通道(2026-08-14 owner 指出首跑不公平后加):
 *   `gateway` 走我们的 pi 通道 —— M3 在这条路上正文混 `<think>` 且 **thinking mode 设不了**,
 *            那不是它的最佳状态, 拿它跟 v4-flash 比是拿"接错线的 M3"比。
 *   `direct-*` 直连各家官方端点, 两边都用**各自的最佳/默认思考档**:
 *            M3 显式 `thinking:{type:'adaptive'}`(该端点省略即 adaptive, 显式写死免得默认漂);
 *            v4-flash 不传思考参数 —— deepseek 官网口径「支持 non-thinking 与 thinking(默认)」,
 *            默认即思考档, 与 M3 的 adaptive 对齐。
 * 单变量因此是**模型**, 不再夹带"谁被接错线"。
 */
type Transport = 'gateway' | 'direct-minimax' | 'direct-deepseek';
interface Arm {
  name: string;
  model: string;
  transport: Transport;
}
const ARMS: Arm[] = [
  { name: 'v4-flash', model: 'deepseek-v4-flash', transport: 'direct-deepseek' },
  { name: 'v4-flash·control', model: 'deepseek-v4-flash', transport: 'direct-deepseek' },
  { name: 'm3', model: 'MiniMax-M3', transport: 'direct-minimax' },
  { name: 'm3·control', model: 'MiniMax-M3', transport: 'direct-minimax' },
];

interface AnswerRow {
  arm: string;
  model: string;
  id: string;
  /** 剥掉 <think> 之后的正文 —— 判分用这个。 */
  answer: string;
  /** 未剥的原文 —— 同时判一次, 让"剥离带来多少虚高"看得见。 */
  answerRaw: string;
  hadThink: boolean;
  unclosed: boolean;
  outTokens: number;
  /** 撞到 maxTokens 上限(正文可能被砍) —— 与"答不出来"是两回事, 分开记。 */
  truncated: boolean;
  /** `<think>` 段占原文的字符比 —— M3 把多少产出花在了思考上, 这是它的真实成本。 */
  thinkRatio: number;
  latencyMs: number;
  error?: string;
}

/**
 * 一次调用。直连档**不经我们的 gateway** —— 因为要测的正是"接对线之后的 M3"。
 * 两家都用 OpenAI 兼容的 chat completions 形状, 只有端点/鉴权/思考参数不同。
 */
async function call(arm: Arm, prompt: string): Promise<{ text: string; out: number }> {
  if (arm.transport === 'gateway') {
    const r = await send({ model: arm.model, messages: [{ role: 'user', content: prompt }], maxTokens: MAX_TOKENS });
    return { text: r.text ?? '', out: r.usage?.out ?? 0 };
  }
  const isMM = arm.transport === 'direct-minimax';
  const url = isMM ? 'https://api.minimaxi.com/v1/text/chatcompletion_v2' : 'https://api.deepseek.com/chat/completions';
  const key = isMM
    ? (process.env.MINIMAX_CN_API_KEY ?? process.env.MINIMAX_API_KEY)
    : process.env.DEEPSEEK_API_KEY;
  if (!key) throw new Error(`${arm.transport}: 缺 API key`);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: arm.model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: MAX_TOKENS,
      // M3 显式 adaptive; deepseek 不传 —— 其官方缺省即 thinking 档, 两边都在"开思考"的状态下比。
      ...(isMM ? { thinking: { type: 'adaptive' } } : {}),
    }),
  });
  const j = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
    usage?: { completion_tokens?: number; total_tokens?: number; prompt_tokens?: number };
    base_resp?: { status_code?: number; status_msg?: string };
    error?: { message?: string };
  };
  if (j.error?.message) throw new Error(`${arm.transport}: ${j.error.message}`);
  if (j.base_resp && j.base_resp.status_code !== 0) throw new Error(`${arm.transport}: ${j.base_resp.status_msg}`);
  const u = j.usage ?? {};
  return {
    text: j.choices?.[0]?.message?.content ?? '',
    out: u.completion_tokens ?? Math.max(0, (u.total_tokens ?? 0) - (u.prompt_tokens ?? 0)),
  };
}

bootstrapModelRuntime();
mkdirSync(OUT, { recursive: true });
const dev = JSON.parse(
  readFileSync(join(import.meta.dir, '..', '..', 'src', 'eval', 'tasks', 'fanoutqa', 'data', 'fanout-final-dev.json'), 'utf8'),
) as DevQuestion[];
const qs = sample(dev, N, SEED);
log(`FanOutQA closed-book: ${ARMS.length} 臂 × ${qs.length} 题 = ${ARMS.length * qs.length} 次调用 (seed ${SEED})`);
writeFileSync(`${OUT}/questions.json`, JSON.stringify(qs, null, 2));

const jobs: { arm: Arm; q: DevQuestion }[] = [];
for (const arm of ARMS) for (const q of qs) jobs.push({ arm, q });

const rows: AnswerRow[] = [];
const CONC = 4;
let cursor = 0;
await Promise.all(
  Array.from({ length: CONC }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= jobs.length) return;
      const { arm, q } = jobs[i]!;
      const t0 = Date.now();
      try {
        const r = await call(arm, fanoutTaskText(q.question));
        const raw = r.text;
        const s = stripThink(raw);
        rows.push({
          arm: arm.name,
          model: arm.model,
          id: q.id,
          answer: s.body,
          answerRaw: raw,
          hadThink: s.hadThink,
          unclosed: s.unclosed,
          outTokens: r.out,
          truncated: r.out >= MAX_TOKENS - 64,
          thinkRatio: raw.length ? 1 - s.body.length / raw.length : 0,
          latencyMs: Date.now() - t0,
        });
      } catch (e) {
        rows.push({
          arm: arm.name,
          model: arm.model,
          id: q.id,
          answer: '',
          answerRaw: '',
          hadThink: false,
          unclosed: false,
          outTokens: 0,
          truncated: false,
          thinkRatio: 0,
          latencyMs: Date.now() - t0,
          error: e instanceof Error ? e.message.slice(0, 200) : String(e),
        });
      }
      if (rows.length % 20 === 0) log(`  ${rows.length}/${jobs.length}`);
    }
  }),
);

writeFileSync(`${OUT}/answers.json`, JSON.stringify(rows, null, 2));
const errs = rows.filter((r) => r.error);
log(`\n写入 ${OUT}/answers.json (${rows.length} 行, 出错 ${errs.length})`);
if (errs.length) log(`  错误样本: ${[...new Set(errs.map((e) => e.error))].slice(0, 3).join(' · ')}`);
log(`判分: /tmp/fq-venv/bin/python scripts/probes/fanoutqa-score.py ${OUT}`);
