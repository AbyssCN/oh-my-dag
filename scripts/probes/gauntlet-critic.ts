/**
 * scripts/probes/gauntlet-critic —— **P3 的那个 critic 盲比**(plan §3 P3,`:106-111`)。
 *
 * ## 它和 `gauntlet-round.ts` 的分工(别再混淆一次)
 *
 * `gauntlet-round.ts` 是**确定性排版指标**:零模型调用、可复跑,量的是起始列/空行/重复串。
 * 它**不是** plan 说的 P3 —— plan 要的是:**全新上下文 critic 盲比**(剥标签 / 随机顺序 /
 * 打平算参照物赢),critic 只回「谁赢 + 最大的一个缺口,一句话,**必须带一个可测量的数**」,
 * **每轮进账本**。这份脚本就是那个东西。两者都要有:前者管"数会不会变",后者管"人看着谁好"。
 *
 * ## 四要素(动手前写死,照 `large-repo-e2e-probe.ts` 的形)
 *
 * - **假设**:同一场景的五家真帧摆在一起、抹掉产品名之后,一个**没有本程上下文**的模型
 *   能挑出赢家并说出一个带数的缺口 —— 而那个缺口是我们自己的确定性指标**量不到**的维度。
 * - **单一变量**:一轮只动**一处**实装,然后**重采那一格的帧**再跑同一条命令。
 *   帧库里其它家的帧是静态证据,不随轮次变。
 * - **成败信号**:退出码 0 = 这一轮问出了合格判词(赢家 + 缺口 + 一个**数字**);
 *   非零 = 判词不合格(没数 / 赢家不在候选里 / 剥标签失效),**那一轮不进名次**。
 * - **下一步收什么数据**:每轮把「件/轮/谁赢/缺口原文/带的那个数/帧路径/种子/座位」
 *   写进 `docs/bars/gauntlet-p3-账本.md`。判词说得对不对由下一轮的读数回答,不由我表态。
 *
 * ## 剥标签能剥到哪里 —— **写在前面,别让读的人以为它是全盲**
 *
 * 逐字抹掉的是**产品名/厂商名/模型名**(`FAMILY_TOKENS`,抹完还残留就退非零)。
 * **抹不掉的是字形本身**:omd 首屏那五行 `██` 点阵拼出的就是产品名,
 * openclaw/opencode 的向导文案也带自己的措辞习惯。⇒ 这是**半盲**不是全盲。
 * 所以每轮额外问 critic 一句「你能猜出哪帧是谁吗」,**把泄露量出来记账**
 * (`leakGuess`),而不是嘴上说"已剥标签"。
 *
 * ## 打平算参照物赢(plan:108)
 *
 * critic 说 `tie: true` ⇒ **我们输**。这条不是谦虚:打平时判"我们赢"会让循环立刻停,
 * 而停止条件里"赢了"是要**明确赢**的。
 *
 * ## 用法
 *
 *   bun run scripts/probes/gauntlet-critic.ts --selftest        # 零模型调用: 剥标签/裁决/判词校验
 *   bun run scripts/probes/gauntlet-critic.ts --piece 6         # 跑第 6 件(每个场景一次真调用)
 *   bun run scripts/probes/gauntlet-critic.ts --piece 2 --round 2 --seed 7
 *   bun run scripts/probes/gauntlet-critic.ts --piece 6 --dry   # 只打印会发出去的 prompt
 *
 * 退出码:0 全部合格 · 1 有判词不合格或剥标签失效 · 2 这一件没有可比的帧(照实记,不冒充)。
 */
import { readFileSync, existsSync, appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { callModel } from '../../src/model/index';
import { bootstrapModelRuntime } from '../../src/model/bootstrap';

const REFS = 'docs/bars/refs';
export const LEDGER = 'docs/bars/gauntlet-p3-账本.md';
/** 我方那一家 —— 判词落到它身上才叫"我们的缺口"。 */
export const OURS = 'omd';

/** P3 的六件(plan `:95-104`,**按 owner 痛点排序,不许重排**)。 */
export interface Piece {
  id: number;
  name: string;
  /** 可比的场景 = 双方都有真帧的场景。空 = 这一件没有可比的帧。 */
  scenes: string[];
  /** 参与比较的家(该场景真有帧的)。 */
  families: string[];
  /** 没有可比帧时的原因(照采集纪律:采不到就写采不到)。 */
  blocked?: string;
}
export const PIECES: Piece[] = [
  {
    id: 1,
    name: '问答/审批弹窗',
    scenes: [],
    families: [],
    blocked:
      '竞品那一侧采不到:审批/问答弹窗要真跑一次工具调用才出现,而四家在沙箱 HOME 里没有凭证(openclaw 停在向导、hermes 网关未起)。' +
      'rpiv 是**代码本体**不是可跑的 TUI(pi extension),拆包读源可以,采帧不行。⇒ 记采不到,不拿描述冒充帧。',
  },
  { id: 2, name: 'settings 全流程', scenes: ['07-settings'], families: ['omd', 'pi', 'opencode', 'openclaw', 'hermes'] },
  { id: 3, name: '对话主屏(消息流/工具行/流式)', scenes: ['08-streaming', '09-long-scroll'], families: ['omd', 'pi', 'opencode'] },
  {
    id: 4,
    name: '散雾图 C/B',
    scenes: [],
    families: [],
    blocked: '四家都没有"雾场/前沿"这类视图 ⇒ 没有外部参照物可比。盲比无从做起(拿一张我们自己的帧问"谁赢"是自问自答)。',
  },
  {
    id: 5,
    name: 'DAG 三画法',
    scenes: [],
    families: [],
    blocked: '同上:四家都没有 DAG 画布。⇒ 这一件的判据只能是自家的 `DG-*` PTY 闸(已全绿),不是 gauntlet。',
  },
  { id: 6, name: '底栏三行 + 欢迎屏', scenes: ['01-empty', '04-narrow-80'], families: ['omd', 'pi', 'opencode', 'openclaw', 'hermes'] },
];

/**
 * 要抹掉的产品名/厂商名/模型名。
 *
 * ⚠ 这张表是**量出来的不是想出来的**:对五家 × 各场景帧逐个 `ugrep -i` 数过命中。
 * 加一家或加一个场景之后**必须重跑 `--selftest`** —— 它会把残留数打出来,非 0 退非零。
 *
 * ⚠⚠ **抹完仍然不是全盲,而且这不是理论顾虑 —— 实测被读出来了。**
 * 第一跑 critic 的判词里出现「Hermes Research」「Pi v0.84.1」,而那两串在文本层已被抹成 ‹抹›:
 * 它读的是**点阵字形**(hermes 的欢迎屏用 `██╗` 拼出自己的名字,opencode 同理)。
 * ⇒ 本脚本的定性是**半盲**:文本层的标签抹掉,字形层抹不掉(要抹就得改画面本身 = 改了被评的东西)。
 * 应对是**量它**不是嘴上说没有:每轮问一句 `leakGuess` 记账,并且**同一场景跑两个种子**,
 * 判词随顺序翻转就当场作废(见 `--pairs`)。
 */
export const FAMILY_TOKENS = [
  'oh my dag',
  'oh-my-dag',
  'omd',
  'opencode',
  'openclaw',
  'hermes',
  'pi-coding-agent',
  'pi-coding',
  'earendil',
  'juicesharp',
  'nous',
  'claude',
  'anthropic',
  'deepseek',
  'kimi',
  'openai',
  'gpt-',
  'glm-',
  'moonshot',
  'gemini',
  // 各家的自称/版本号 —— 都是**看着帧加进来的**(openclaw 的向导自称 Crestodian;
  // pi 首行印 `pi v0.84.1`;opencode 右下角印 `1.18.15`)。
  'crestodian',
  'v0.84.1',
  '0.84.1',
  '1.18.15',
];

/** 需要词边界的短 token —— `pi` 直接替换会打到 `pipeline`/`api`/`opción` 这类正常词上。 */
export const WORD_TOKENS = ['pi'];

const NEUTRAL = '‹抹›';

/** 抹掉产品名。返回抹后的文本 + 命中数(命中数进账本,便于事后核"到底抹了什么")。 */
export function scrubFamilyLabels(
  text: string,
  tokens: readonly string[] = FAMILY_TOKENS,
  wordTokens: readonly string[] = WORD_TOKENS,
): { text: string; hits: number } {
  let out = text;
  let hits = 0;
  const bump = (): string => {
    hits++;
    return NEUTRAL;
  };
  for (const tok of tokens) out = out.replace(new RegExp(tok.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), bump);
  for (const tok of wordTokens) out = out.replace(new RegExp(`\\b${tok}\\b`, 'gi'), bump);
  return { text: out, hits };
}

/** 抹完还残留的产品名 —— **应当恒为空**。非空 = 剥标签失效,这一轮作废。 */
export function residualLabels(
  text: string,
  tokens: readonly string[] = FAMILY_TOKENS,
  wordTokens: readonly string[] = WORD_TOKENS,
): string[] {
  const low = text.toLowerCase();
  return [...tokens.filter((t) => low.includes(t.toLowerCase())), ...wordTokens.filter((t) => new RegExp(`\\b${t}\\b`, 'i').test(low))];
}

/** mulberry32 —— 种子可复现的洗牌(种子进账本 ⇒ 同一轮可以原样重放)。 */
export function shuffleWithSeed<T>(items: readonly T[], seed: number): T[] {
  let s = seed >>> 0;
  const rnd = (): number => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const ai = a[i] as T;
    a[i] = a[j] as T;
    a[j] = ai;
  }
  return a;
}

const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '').replace(/\x1b\][^\x07]*\x07/g, '');

export function frameText(fam: string, scene: string): string | null {
  const p = join(REFS, fam, `${scene}.txt`);
  if (!existsSync(p)) return null;
  return strip(readFileSync(p, 'utf-8')).replace(/[ \t]+$/gm, '');
}

export const GapSchema = z.object({
  /** 落在哪一帧 —— **单个大写字母**。 */
  label: z.string(),
  /** 一句话(形容词退回;句子里必须出现那个数)。 */
  gap: z.string(),
  metricName: z.string(),
  metricValue: z.number(),
  metricUnit: z.string(),
});
export type Gap = z.infer<typeof GapSchema>;

/**
 * ⚠ **`gaps` 是逐帧的,不是只给最差那一张 —— 这是轮 1 之后改的,理由是读数逼出来的。**
 *
 * 轮 1 的判词结构是「一个 winner + 一个最大缺口」(照 plan:108 的字面)。三次有效判词里
 * 那个"最大缺口"**全部落在 hermes 身上**(它首屏连着 4 行一样的 `error: gateway exited`)。
 * 于是这一轮**对我方没有任何可修项** —— 循环拿不到输入就转不动。
 * ⇒ 改成**每一帧各自一条缺口**:critic 仍然不知道哪张是我们的(盲比不变),
 * 而我们每轮都读得到自己那一条。plan 的「一句话 + 一个可测量的数」逐条仍然要求。
 */
export const VerdictSchema = z.object({
  /** 赢家的字母标签。 */
  winner: z.string(),
  /** 分不出高下 —— **打平算参照物赢**(我们输)。 */
  tie: z.boolean(),
  /** 逐帧缺口(每一张都要有;赢家那张也要 —— "赢家没缺口"是句空话)。 */
  gaps: z.array(GapSchema).min(1),
  /** 剥标签泄露探针:猜得出哪帧是谁吗(不影响评分,只进账本)。类型放宽 —— 实测它会回对象。 */
  leakGuess: z.unknown(),
});
export type Verdict = z.infer<typeof VerdictSchema>;

/**
 * 手工解析判词 —— **不用 `callModel` 的 `responseSchema`**,理由是实测的:
 *
 * `responseSchema` 会让 `pi-transport.ts:514` 发 `response_format: {type:'json_object'}`,
 * 而 `opencode-go:glm-5.2` 在 JSON 模式下**把 JSON 截在收尾处**:同一条 prompt
 * 不带 schema 时回一份完整 JSON(实测 out=1021,`finishReason='stop'`),
 * 带 schema 时三次重试全部 `invalid JSON: Unexpected EOF`。
 * ⇒ 这里自己剥围栏 + 自己用同一个 zod schema 校验:**校验一个字没少,只是换了谁来做**。
 */
export function parseVerdictText(text: string): { ok: true; v: Verdict } | { ok: false; why: string } {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const body = fenced?.[1] ?? text;
  const first = body.indexOf('{');
  const last = body.lastIndexOf('}');
  if (first === -1 || last <= first) return { ok: false, why: '回复里找不到 JSON 对象' };
  let obj: unknown;
  try {
    obj = JSON.parse(body.slice(first, last + 1));
  } catch (e) {
    return { ok: false, why: `JSON 解析失败:${(e as Error).message}` };
  }
  const p = VerdictSchema.safeParse(obj);
  if (!p.success) return { ok: false, why: `字段不合规:${p.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}` };
  return { ok: true, v: p.data };
}

/**
 * 判词校验 —— 分**致命 / 软伤**两档。
 *
 * ⚠ 分两档是**读数逼出来的**:轮3 有一跑因为**别家**某条缺口没带数字被整跑判废,
 * 于是连"谁赢"这个本来好用的读数一起被扔了(那一格因此"没有多数")。
 * 一跑要给的就两样:① 谁赢(进名次)② **我方**的缺口(下一轮修什么)。
 * 别家缺口的成色不影响这两样 ⇒ 降为软伤:记进账本,但不作废这一跑。
 */
export function checkVerdict(v: Verdict, labels: readonly string[], oursLabel: string): string[] {
  return [...fatalVerdictFaults(v, labels, oursLabel), ...softVerdictFaults(v, labels, oursLabel)];
}

/** **致命**:赢家不明 / 我方缺口拿不到或没带数 —— 这一跑不进名次。 */
export function fatalVerdictFaults(v: Verdict, labels: readonly string[], oursLabel: string): string[] {
  const bad: string[] = [];
  if (!labels.includes(v.winner)) bad.push(`winner '${v.winner}' 不在候选 ${labels.join('/')} 里`);
  const ours = v.gaps.find((g) => g.label === oursLabel);
  if (!ours) bad.push(`缺口里没有我方那一帧(${oursLabel})`);
  else if (!/\d/.test(ours.gap)) bad.push('我方缺口句里没有任何数字(plan:108 要求"必须带一个可测量的数")');
  else if (!Number.isFinite(ours.metricValue)) bad.push('我方缺口的 metricValue 不是有限数');
  return bad;
}

/** **软伤**:别家缺口的成色。记账不作废。 */
export function softVerdictFaults(v: Verdict, labels: readonly string[], oursLabel: string): string[] {
  const soft: string[] = [];
  for (const g of v.gaps) {
    if (g.label === oursLabel) continue;
    if (!labels.includes(g.label)) soft.push(`(软)gap.label '${g.label.slice(0, 24)}' 不在候选里`);
    else if (!/\d/.test(g.gap)) soft.push(`(软)${g.label} 的缺口句没带数`);
  }
  return soft;
}

/** 打平算参照物赢:tie ⇒ 赢家不是我们(记成 `打平→参照物`)。 */
export function resolveWinner(v: Verdict, labelToFam: Record<string, string>): { family: string; tie: boolean } {
  if (v.tie) {
    const others = Object.values(labelToFam).filter((f) => f !== OURS);
    return { family: others[0] ? '打平→参照物' : '打平', tie: true };
  }
  return { family: labelToFam[v.winner] ?? `?${v.winner}`, tie: false };
}

const SYS = [
  '你是终端 UI 的评审。下面是**同一个场景**在若干个不同 CLI agent 里采到的**真实终端帧**(xterm 重放成网格)。',
  '产品名/厂商名/模型名已被抹成 ‹抹›。你的任务不是猜品牌,是判排版与信息呈现。',
  '',
  '回这几件事:',
  '1. `winner`:哪一帧最好 —— **只写单个大写字母**(如 "C")。分不出高下就 `tie: true`。',
  '2. `gaps`:**每一帧各给一条**最大的缺口(包括赢家那一帧)。每条:',
  '   - `label`:**只写单个大写字母**,不要写句子。',
  '   - `gap`:一句话,说这一帧缺什么。**句子里必须出现那个数字本身。**',
  '   - `metricName` / `metricValue`(数) / `metricUnit`:可测量的量 —— 对齐列数 / 溢出字符数 /',
  '     同屏重复的串数 / 同一语义用了几种颜色 / 连续空行数 / 层级数 / 一屏看到几条信息……',
  '     形容词("清晰""干净""美观""现代")一律不算,会被退回。',
  '3. `leakGuess`:一句话 —— 你能不能猜出每一帧是哪个产品(能就写出来)。',
  '   这只是让我们量"抹标签有没有失效",**不影响评分**。',
  '',
  '只输出 JSON:{"winner":"C","tie":false,"gaps":[{"label":"A","gap":"…4 行…","metricName":"…","metricValue":4,"metricUnit":"行"}],"leakGuess":"…"}',
].join('\n');

export function buildPrompt(scene: string, entries: readonly { label: string; text: string }[]): string {
  const parts = [`场景:${scene}(同一终端尺寸,同一采集路径)`, ''];
  for (const e of entries) {
    parts.push(`===== 帧 ${e.label} =====`, '```', e.text, '```', '');
  }
  return parts.join('\n');
}

interface RoundArgs {
  piece: Piece;
  round: number;
  seed: number;
  coord: string;
  dry: boolean;
}

interface Pass {
  seed: number;
  order: string[];
  labels: string[];
  labelToFam: Record<string, string>;
  hits: number;
  v?: Verdict;
  bad: string[];
  /** 软伤(别家缺口没带数之类)—— 记账不作废。 */
  soft?: string[];
  winner: string;
  tie: boolean;
  /** 我方那一帧的字母。 */
  oursLabel: string;
  /** 我方那一条缺口(循环下一轮要修的就是它)。 */
  oursGap?: Gap;
  model: string;
  tokens: string;
  err?: string;
}

const gapNum = (g: Gap): string => `${g.metricName}=${g.metricValue}${g.metricUnit}`;

/** 一场景 × 一个种子 = 一次全新上下文的真调用。 */
async function judgeOnce(a: RoundArgs, scene: string, seed: number): Promise<Pass> {
  const fams = a.piece.families.filter((f) => frameText(f, scene) !== null);
  const order = shuffleWithSeed(fams, seed);
  const labels = order.map((_, i) => String.fromCharCode(65 + i));
  const labelToFam: Record<string, string> = {};
  let hits = 0;
  const entries = order.map((fam, i) => {
    const s = scrubFamilyLabels(frameText(fam, scene) as string);
    hits += s.hits;
    const label = labels[i] as string;
    labelToFam[label] = fam;
    return { label, text: s.text };
  });
  const oursLabel = labels[order.indexOf(OURS)] ?? '?';
  const base: Pass = { seed, order, labels, labelToFam, hits, bad: [], winner: '—', tie: false, oursLabel, model: a.coord, tokens: '—' };

  const residual = [...new Set(entries.flatMap((e) => residualLabels(e.text)))];
  if (residual.length) return { ...base, bad: [`剥标签失效:残留 ${residual.join(',')}`], err: '剥标签失效' };

  const user = buildPrompt(scene, entries);
  if (a.dry) {
    console.log(SYS + '\n\n' + user);
    return { ...base, err: 'dry' };
  }

  // ⚠ `maxTokens` 不能小:这些座位把**推理 token 也算进 out**(实测一句 40 字的 JSON 花 415 out)。
  const ask = async (extra?: string): Promise<{ text: string; model: string; tokens: string } | { err: string }> => {
    try {
      const res = await callModel({
        model: a.coord,
        messages: [
          { role: 'system', content: SYS },
          { role: 'user', content: extra ? `${user}\n\n${extra}` : user },
        ],
        maxTokens: 8000,
      });
      return { text: res.text, model: res.model, tokens: `${res.usage.in}in/${res.usage.out}out` };
    } catch (e) {
      return { err: `调用失败:${(e as Error).message.slice(0, 120)}` };
    }
  };

  let r = await ask();
  if ('err' in r) return { ...base, bad: [r.err], err: '调用失败' };
  let p = parseVerdictText(r.text);
  let tokens = r.tokens;
  // 实测 4 跑里 1 跑回的是"散文 + JSON 混着" ⇒ 给**一次**纠正机会(它是格式问题不是判断问题)。
  // ⚠ 纠正也是**全新上下文**,不把上一次的回复喂回去 —— 否则等于让它给自己的答案背书。
  if (!p.ok) {
    const r2 = await ask('⚠ 上一次的回复不是合法 JSON。**只输出那一个 JSON 对象**,前后不要任何文字、不要围栏。');
    if (!('err' in r2)) {
      tokens = `${tokens}+${r2.tokens}`;
      const p2 = parseVerdictText(r2.text);
      if (p2.ok) p = p2;
    }
  }
  const res = { model: 'model' in r ? r.model : a.coord };
  if (!p.ok) return { ...base, model: res.model, tokens, bad: [`判词解析失败(含一次纠正):${p.why}`], err: '解析失败' };

  const v = p.v;
  const bad = fatalVerdictFaults(v, labels, base.oursLabel);
  const soft = softVerdictFaults(v, labels, base.oursLabel);
  const won = resolveWinner(v, labelToFam);
  return {
    ...base,
    v,
    bad,
    winner: won.tie ? '打平→参照物' : won.family,
    tie: won.tie,
    oursGap: v.gaps.find((g) => g.label === base.oursLabel),
    soft,
    model: res.model,
    tokens,
  };
}

/**
 * 一个场景 = **三次判**(三个种子 ⇒ 三套字母顺序),取**多数**。
 *
 * 为什么不止一次:剥标签是半盲(点阵字形抹不掉),而**顺序**是我唯一能真正随机的东西。
 * 实测两跑档:轮1 与轮2 的 `01-empty` 都是两跑不同赢家(`openclaw` vs `omd`)——
 * 两跑只能告诉我"不稳",给不出这一格到底算谁赢。三跑取多数既能定,又留着"没有多数"这一档:
 * **三跑三个赢家 ⇒ 不计名次**(不许拿其中一跑凑一个胜场)。
 * 打平仍然算参照物赢。
 */
async function runScene(a: RoundArgs, scene: string): Promise<{ ok: boolean; lines: string[] }> {
  const fams = a.piece.families.filter((f) => frameText(f, scene) !== null);
  if (fams.length < 2) {
    return { ok: false, lines: [`| ${a.piece.id} | ${a.round} | ${scene} | — | **帧不足**(只有 ${fams.join('/') || '零'} 有帧) | — | — |`] };
  }
  const seeds = [a.seed + scene.length * 31 + a.round, (a.seed ^ 0x5bf03635) + a.round, (a.seed ^ 0x2545f491) + a.round * 7];
  const passes: Pass[] = [];
  for (const s of seeds) passes.push(await judgeOnce(a, scene, s));
  if (a.dry) {
    for (const p of passes) console.log(`[dry] ${scene}: 顺序=${p.order.join(',')} 抹掉 ${p.hits} 处`);
    return { ok: true, lines: [] };
  }

  const winners = passes.filter((p) => p.bad.length === 0).map((p) => p.winner);
  const tally = new Map<string, number>();
  for (const w of winners) tally.set(w, (tally.get(w) ?? 0) + 1);
  const top = [...tally.entries()].sort((x, y) => y[1] - x[1])[0];
  /** 多数 = 严格过半(三跑里 ≥2)。没有多数 ⇒ 这一格不计名次。 */
  const majority = top && top[1] * 2 > passes.length ? top[0] : null;
  const framePaths = fams.map((f) => `${REFS}/${f}/${scene}.txt`).join(' · ');

  console.log(`\n--- 件${a.piece.id} 轮${a.round} · ${scene}`);
  const lines: string[] = [];
  for (const p of passes) {
    console.log(`  [种子 ${p.seed}] ${p.order.map((f, i) => `${p.labels[i]}=${f}`).join(' ')} · 抹 ${p.hits} · ${p.model} ${p.tokens}`);
    console.log(`    谁赢:${p.tie ? '打平 ⇒ 参照物赢(我们输)' : p.winner}${p.err ? ` (${p.err})` : ''}`);
    if (p.v) {
      console.log(`    我方(${p.oursLabel})那一条缺口:${p.oursGap ? `${p.oursGap.gap}  [${gapNum(p.oursGap)}]` : '(critic 没给)'}`);
      for (const g of p.v.gaps.filter((x) => x.label !== p.oursLabel))
        console.log(`      · ${p.labelToFam[g.label] ?? g.label}:${g.gap.slice(0, 90)} [${gapNum(g)}]`);
      console.log(`    泄露探针:${typeof p.v.leakGuess === 'string' ? p.v.leakGuess : JSON.stringify(p.v.leakGuess)}`);
    }
    if (p.bad.length) console.log(`    ⚠ 不合格(致命):${p.bad.join(' / ')}`);
    if (p.soft?.length) console.log(`    · 软伤(记账不作废):${p.soft.join(' / ')}`);
    lines.push(
      [
        `| ${a.piece.id} | ${a.round} | ${scene}`,
        p.tie ? '打平→参照物(我们输)' : p.winner === OURS ? '**我方**' : p.winner,
        p.oursGap ? `我方:${p.oursGap.gap.replace(/\|/g, '/')}` : `(${p.err ?? 'critic 没给我方缺口'})`,
        p.oursGap ? gapNum(p.oursGap) : '—',
        `种子 ${p.seed};${p.order.map((f, i) => `${p.labels[i]}=${f}`).join(' ')};抹 ${p.hits} 处;座位 ${p.model};${p.tokens};帧 ${framePaths}${
          p.bad.length ? `;⚠ 不合格:${p.bad.join('/')}` : ''
        }${p.soft?.length ? `;软伤 ${p.soft.join('/')}` : ''}`,
      ].join(' | ') + ' |',
    );
  }
  const spread = [...tally.entries()].map(([w, n]) => `${w}×${n}`).join(' / ') || '(无合格判词)';
  console.log(
    `  ${passes.length} 跑取多数:${majority ? `✓ ${majority}(${spread})` : `✗ 没有多数(${spread}) ⇒ 这一格不进名次`}` +
      `${winners.length < passes.length ? ` · 不合格 ${passes.length - winners.length} 跑` : ''}`,
  );
  lines.push(
    `| ${a.piece.id} | ${a.round} | ${scene} | ${majority ? `**多数 → ${majority}**` : '**没有多数 ⇒ 不计**'} | (顺序对照:同一场景 ${passes.length} 个种子 ${passes.length} 跑) | ${spread} | 种子 ${seeds.join(
      ' / ',
    )};合格 ${winners.length}/${passes.length} 跑 |`,
  );
  return { ok: majority !== null, lines };
}

function ledgerHeader(): string {
  return [
    '# P3 gauntlet 账本 —— **critic 盲比**逐件逐轮(plan §3 P3 `:106-111`)',
    '',
    '> 生成:`bun run scripts/probes/gauntlet-critic.ts --piece <n> [--round <k>]`(**每行由脚本自己追加**,不手写)。',
    '> 与 `gauntlet-round-1.md` 的分工:那份是**确定性排版指标**(零模型调用);这份是 plan 要的**盲比**。',
    '>',
    '> **剥标签是半盲**:产品名/厂商名/模型名逐字抹掉(残留即作废),但**字形抹不掉**',
    '> —— 我方首屏那五行点阵拼出的就是产品名。所以每轮问一句 `leakGuess` 把泄露量出来记账。',
    '> **打平算参照物赢。**',
    '',
    '| 件 | 轮 | 场景 | 谁赢 | 最大的一个缺口(critic 原文) | 带的那个数 | 盲比记录 |',
    '|---|---|---|---|---|---|---|',
  ].join('\n');
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const flag = (n: string): string | undefined => {
    const i = argv.indexOf(n);
    return i === -1 ? undefined : argv[i + 1];
  };
  if (argv.includes('--selftest')) {
    selftest();
    return;
  }
  const pid = Number(flag('--piece') ?? '0');
  const piece = PIECES.find((p) => p.id === pid);
  if (!piece) {
    console.error(`用法:--piece <${PIECES.map((p) => p.id).join('|')}>  (件表见文件头 / plan §3 P3)`);
    process.exit(1);
  }
  if (piece.blocked || piece.scenes.length === 0) {
    // ⚠ **"没有可比的帧"也要进账本**:plan P4 的 verify 是「停住没赢的件按原样报告」——
    //   只在终端打一句、账本里当它不存在,读账本的人会以为这一件没跑过。
    const reason = piece.blocked ?? '未登记原因';
    console.log(`件${piece.id}「${piece.name}」**没有可比的帧**:\n  ${reason}`);
    if (!existsSync(LEDGER)) writeFileSync(LEDGER, ledgerHeader() + '\n');
    appendFileSync(LEDGER, `| ${piece.id} | — | (无可比场景) | **不比** | ${reason.replace(/\|/g, '/')} | — | 采集纪律:采不到就记采不到,不拿描述冒充帧 |\n`);
    process.exit(2);
  }
  const round = Number(flag('--round') ?? '1');
  const seed = Number(flag('--seed') ?? '20260808');
  /**
   * critic 座位默认 `kimi-coding:k3` —— **单变量实测出来的,不是拍的**。
   *
   * 件6 轮3 同一批种子、同一批帧,只换座位:
   * · `opencode-go:glm-5.2` → 两格**都没有多数**(01-empty: omd×1/opencode×1 + 1 跑不合格;
   *   04-narrow-80: opencode×1/pi×1/omd×1),而且 4 跑里 1 跑回的 JSON 不合法;
   * · `kimi-coding:k3` → 两格**都有干净多数**(opencode×2/omd×1 · omd×3),judgment 也彼此一致
   *   (6 跑里 5 跑把我方缺口指成同一件事)。
   * ⇒ "没有多数"当时量的是**判官**,不是画面。换座位之后这个读数才开始有信息。
   * ⚠ 它比 glm 慢很多(一跑 1–3 分钟),要快可以 `--coord opencode-go:glm-5.2`,但读数按上面那条打折。
   */
  const coord = flag('--coord') ?? 'kimi-coding:k3';
  const dry = argv.includes('--dry');

  if (!dry) bootstrapModelRuntime();
  // ⚠ `--dry` 一个字节都不许写进磁盘 —— 第一版在这里建了账本表头, 于是一次 dry 跑出来的
  // 空账本看起来像"跑过了"。dry 的用途是**看会发出去什么**, 不是产读数。
  if (!dry && !existsSync(LEDGER)) writeFileSync(LEDGER, ledgerHeader() + '\n');

  const lines: string[] = [];
  let allOk = true;
  for (const scene of piece.scenes) {
    const r = await runScene({ piece, round, seed, coord, dry }, scene);
    allOk = allOk && r.ok;
    lines.push(...r.lines);
  }
  if (dry) {
    console.log(`\n[dry] 没有写盘(账本会追加 ${lines.length} 行 → ${LEDGER})`);
  } else {
    appendFileSync(LEDGER, lines.join('\n') + '\n');
    console.log(`\n账本已追加 ${lines.length} 行 → ${LEDGER}`);
  }
  process.exit(allOk ? 0 : 1);
}

/**
 * `--selftest` —— **零模型调用**地证明三件事,并且**每条都当场证伪过**(方式写在旁边)。
 */
function selftest(): void {
  let bad = 0;
  const say = (ok: boolean, msg: string): void => {
    console.log(`${ok ? '✓' : '✗'} ${msg}`);
    if (!ok) bad++;
  };

  // ① 全部帧抹完不许残留产品名。证伪:把 'omd' 从 FAMILY_TOKENS 去掉 → 这条当场红。
  for (const p of PIECES)
    for (const scene of p.scenes)
      for (const fam of p.families) {
        const t = frameText(fam, scene);
        if (t === null) continue;
        const s = scrubFamilyLabels(t);
        const res = residualLabels(s.text);
        say(res.length === 0, `剥标签 ${fam}/${scene}:抹 ${s.hits} 处,残留 ${res.length ? res.join(',') : '0'}`);
      }

  // ② 打平算参照物赢。证伪:把 resolveWinner 里的 tie 分支删掉 → 这条红。
  const gA: Gap = { label: 'A', gap: '3 列没对齐', metricName: '对齐列数', metricValue: 3, metricUnit: '列' };
  const gB: Gap = { label: 'B', gap: '2 行溢出', metricName: '溢出行数', metricValue: 2, metricUnit: '行' };
  const tieV: Verdict = { winner: 'A', tie: true, gaps: [gA, gB], leakGuess: '' };
  say(resolveWinner(tieV, { A: OURS, B: 'pi' }).family !== OURS, '打平时赢家不是我方');

  // ③ 判词校验四条。每条的证伪方式写在旁边(都是删掉 checkVerdict 里对应那一行 → 当场红)。
  say(checkVerdict({ ...tieV, gaps: [{ ...gA, gap: '看起来更干净' }, gB] }, ['A', 'B'], 'A').length > 0, '没带数的缺口句被拒');
  say(checkVerdict({ ...tieV, winner: 'F' }, ['A', 'B'], 'A').length > 0, '赢家不在候选里被拒');
  say(checkVerdict({ ...tieV, gaps: [gB] }, ['A', 'B'], 'A').length > 0, '缺口里没有我方那一帧 → 被拒(这一轮没有可修项)');
  say(checkVerdict({ ...tieV, gaps: [{ ...gA, label: '帧 A 有问题' }, gB] }, ['A', 'B'], 'A').length > 0, 'gap.label 写成句子被拒');
  say(checkVerdict(tieV, ['A', 'B'], 'A').length === 0, '合格判词通过(反向:它必须能通过,否则闸恒红也没用)');

  // ④ 洗牌可复现(种子进账本才有意义)。
  const a = shuffleWithSeed(['x', 'y', 'z', 'w'], 42).join('');
  const b = shuffleWithSeed(['x', 'y', 'z', 'w'], 42).join('');
  say(a === b, `同种子同顺序(${a})`);
  say(shuffleWithSeed(['x', 'y', 'z', 'w'], 43).join('') !== a || true, '不同种子可不同(不作硬判据 —— 四元素有 1/24 概率撞上)');

  console.log(bad === 0 ? '\nselftest 全过' : `\nselftest ${bad} 条红`);
  process.exit(bad === 0 ? 0 : 1);
}

if (import.meta.main) {
  void main();
}
