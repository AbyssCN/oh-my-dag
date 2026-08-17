/**
 * src/tui/render/statusbar —— **底栏三行的渲染面**(切片②,v5 第一节样张 + 第四节算法)。
 *
 * 三行:① 工作区+座位+ctx+会话花费+5h 窗口 · ② in/out/cache + 各 provider 额度 + ssh · ③ 帮助。
 * 顶栏没了(v5:信息下沉 —— 眼睛在输入框附近,状态离输入框越近越容易被看见)。
 *
 * ## segment 模型(照 Oh My Posh 的分段思想,不抄实现)
 *
 * 每段自己决定显不显示:**没数据就不画**,不画 0、不画空占位。
 * powerline 箭头不搬(要 Nerd Font,字形闸判 unsafe);段间用 ` │ ` 分隔。
 *
 * ## 三条不许违反的(v5 原话)
 *
 * 1. **订阅与计费分开画** —— 订阅制不折算美元(折算是编的);
 * 2. **拿不到就写「未知」** —— 不画 0%,0% 会被读成"还没用";
 * 3. **本地估算要标注** —— 「本地 N+」与官方读数在屏上分得开。
 */
import type { ContextPressure } from '../../harness/chat/usage';
import { BORDER } from '../design/tokens';
import type { WindowSummary } from '../usage/ledger';
import { humanTokens } from './pressure';

/** 一个 provider 怎么画额度:订阅制画本地计数,按量制画窗口花费。 */
export type BillingMode = 'subscription' | 'token';

/**
 * 默认 billing 归类(v5 第四节那张表)。`.omd/config.json` 的 `declaredPlans` 可覆盖:
 * kind === 'token' → token,其余(request/session/flat)→ subscription。
 */
export const DEFAULT_BILLING: Readonly<Record<string, BillingMode>> = {
  'kimi-coding': 'subscription',
  'opencode-go': 'subscription',
  anthropic: 'subscription',
  deepseek: 'token',
  mimo: 'token',
  vllm: 'token',
};

export interface WorkspaceInfo {
  /** 仓名(目录名)。 */
  repo: string;
  /** 分支;detached 时给短 SHA。`null` = 不是 git 仓(段不画)。 */
  branch: string | null;
  /** 脏文件数(`git status --porcelain` 行数)。0 = 干净(不画 +N)。 */
  dirty: number;
  /** worktree 名;主工作树 = `null`(段不画)。 */
  worktree: string | null;
}

export interface StatusBarInput {
  ws: WorkspaceInfo | null;
  /** 座位坐标(`connection.url` 去掉协议头)。 */
  seat: string;
  pressure: ContextPressure | null;
  /** 本进程合计(「会话」格)。`null` = 还没跑过一轮(不画,不是 $0)。 */
  session: { costUsd: number; unpriced: boolean; calls: number } | null;
  /** 5h 滚动窗口。`null` 或 calls=0 = 窗口里没有记录(段不画)。 */
  win: WindowSummary | null;
}

/** 行①的段间分隔符。接线层拼「活仪表」时也要用它 —— 两处各写一遍必漂。 */
export const FOOTER_SEP = ` ${BORDER.v} `;

/** `$0.83` / `$12.4`;未计价的调用在场时 → `$…+`(后缀 + = 下界,不冒充真值;`≥` 是未量字形不能用)。 */
export function fmtUsd(costUsd: number, unpriced: boolean): string {
  const n = costUsd < 10 ? costUsd.toFixed(2) : costUsd.toFixed(1);
  return `$${n}${unpriced ? '+' : ''}`;
}

/**
 * ★ **底栏只有一行**(2026-08-09,owner 定方向后重写)。
 *
 * ## 为什么从两行减到一行,而且减的是**词元**不是类别
 *
 * P3 gauntlet 盲比里 `08-streaming` 连两轮判我方输,6 跑里 **5 跑**指的是同一条:
 * 「底栏两行塞了 8–12 组指标,没有视觉分组」。同一把尺子量竞品(`08-streaming` 帧):
 * **omd 2 行 / 25 词元 · pi 1 行 / 7 · opencode 1 行 / 6** —— 我们是 3.5–4 倍。
 *
 * owner 裁决:**"按建议来;测不到的那种取消,只保留有效信息。"**
 * 于是删掉三类,**一个类别都没少**(模型 · 上下文 · 花费 · 会话仍全在,rubric V4 不掉分):
 *
 * | 删的 | 依据 |
 * |---|---|
 * | `kimi-coding 本地3+ 额度未知` | **测不到就不画**(`AGENTS.md §4` 第一条"无源恒缺席")—— 订阅制额度没有官方端点, 画一句"未知"占 2 个词元却不能拿它做任何决定 |
 * | `ctx … 窗口未知` 那一档 | 同上:窗口拿不到时**整段不画**, 不画一个自己说"不知道"的段 |
 * | 绝对 cache token 数 | 与命中率重复(率才是能拿来做决定的那个);同屏两个数说一件事 |
 * | 会话花费与 5h 花费**相同**时的第二个 | 信息量决定占位 —— 两个 `$0.00` 说的是同一件事;不同才画两个 |
 * | provider 逐项拆分(单 provider 时) | 与座位坐标重复(`kimi-coding:k3` 已在左边);**≥2 个** provider 才有拆分的价值 |
 *
 * ⚠ `in/out` 换成 `↑↓`(U+2191/2193,**都在字形白名单里量过 = 1 列**);
 * 缓存那格**不能用 `⇄`** —— 它不在白名单(实测"未在表里"), 用汉字「缓存」。
 *
 * 形如:`oh-my-dag main+86 │ kimi-coding:k3 │ ctx 1% │ $0.00 10次 │ ↑111k ↓2.5k 缓存59%`
 */
/**
 * uuid 缩到前 8 位 —— **omd 自己生成的分支名会把整条底栏挤出屏幕**。
 *
 * 隔离档 run 的分支是 `omd/run/<uuid>`,worktree 目录名同为 `<uuid>`,于是同一个 36 位 id
 * 画两遍:`oh-my-dag omd/run/<36> wt:<36>` = **94 列**,加分隔符占满 100 列的终端 ——
 * 座位 / `ctx` / 花费 / token 四段全在屏外。实测(2026-08-14,worktree 里跑 L3 PTY):
 * `SB-1` `SB-2` `SB-5` 三条同时红,而它们要守的东西一个都没坏。
 *
 * 只缩 uuid 不做通用宽度预算:人读 uuid 只用前 8 位(`git` 同口径),而通用截断会把
 * "画不下"这件事**藏起来** —— 那是另一族问题,要的是别的解法。
 */
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const shortenIds = (s: string): string => s.replace(UUID_RE, (m) => m.slice(0, 8));

export function formatStatusLine(i: StatusBarInput, o: StatusBarOpts = {}): string {
  const segs: string[] = [];
  if (i.ws) {
    // `repo branch+dirty` —— 原来是 `repo · branch +2`, 三个词元变两个, 信息一样。
    const parts = [i.ws.repo];
    const branch = i.ws.branch === null ? null : shortenIds(i.ws.branch);
    if (branch !== null) parts.push(`${branch}${i.ws.dirty > 0 ? `+${i.ws.dirty}` : ''}`);
    // worktree 名已经在分支里 ⇒ 不画第二遍(omd 隔离档:分支 `omd/run/<id>`, worktree 目录名同为 `<id>`)。
    // 名字不同的 worktree 照画 —— 那时 `wt:` 才带新信息。
    const wt = i.ws.worktree === null ? null : shortenIds(i.ws.worktree);
    if (wt !== null && !(branch ?? '').includes(wt)) parts.push(`wt:${wt}`);
    segs.push(parts.join(' '));
  }
  if (i.seat) segs.push(i.seat);
  // 上下文:**只画百分比**;窗口拿不到(ratio === null)⇒ 整段不画(无源恒缺席)。
  if (i.pressure && i.pressure.usedTokens > 0 && i.pressure.ratio !== null) {
    segs.push(`ctx ${Math.round(i.pressure.ratio * 100)}%`);
  }
  // 花费:会话与 5h 相同 ⇒ 只画一个。不同才画两个(信息量决定占位)。
  const sess = i.session && i.session.calls > 0 ? fmtUsd(i.session.costUsd, i.session.unpriced) : null;
  const winCost = i.win && i.win.calls > 0 ? fmtUsd(i.win.costUsd, i.win.unpriced) : null;
  const calls = i.win && i.win.calls > 0 ? `${i.win.calls}x` : null;
  if (sess !== null && winCost !== null && sess !== winCost) {
    // 两个数不同 ⇒ 都要, 但压成**一个词元** `$会话/$5h`(带标签写要多花 2 个词元, 而 12 是硬上限;
    // 标签在 `/settings` 里有全称)。相同就只画一个。
    segs.push(`${sess}/${winCost}${calls ? ` ${calls}` : ''}`);
  } else if (winCost !== null) {
    segs.push(`${winCost}${calls ? ` ${calls}` : ''}`);
  } else if (sess !== null) {
    segs.push(sess);
  }
  // token:`↑in ↓out cacheNN%`。绝对 cache 数与命中率重复 ⇒ 只留率。
  if (i.win && i.win.calls > 0) {
    const w = i.win;
    const cache = w.in > 0 && w.cacheHit > 0 ? ` cache${Math.round((w.cacheHit / w.in) * 100)}%` : '';
    segs.push(`↑${humanTokens(w.in)} ↓${humanTokens(w.out)}${cache}`);
  }
  // provider 拆分:**≥2 个**才画, 且只画按量计价的那些(订阅制没有能测的数)。
  if (i.win && i.win.byProvider.length >= 2) {
    const billing = o.billing ?? DEFAULT_BILLING;
    const priced = i.win.byProvider.filter((p) => (billing[p.provider] ?? 'token') !== 'subscription');
    if (priced.length >= 2) segs.push(priced.map((p) => `${p.provider} ${fmtUsd(p.costUsd, p.unpriced)}`).join(' '));
  }
  const tail = [o.ssh ? `ssh ${o.ssh}` : null, o.tmux ? 'tmux' : null].filter(Boolean);
  if (tail.length > 0) segs.push(tail.join(' '));
  return segs.join(FOOTER_SEP);
}

/** 底栏一行的可选上下文(计价口径 / 远程环境)。 */
export interface StatusBarOpts {
  billing?: Readonly<Record<string, BillingMode>>;
  ssh?: string | null;
  tmux?: boolean;
}

/**
 * ★ **底栏词元上限 = 12**(gauntlet 判据)。
 *
 * 词元 = 去掉 `│` 之后按空白切的段数。竞品是 6–7,原来的 omd 两行合计 25。
 * 这条**不是**风格偏好:它是那 5 跑判词唯一说得出的可测量量, 所以做成会红的闸(`statusbar.test.ts`)。
 */
export const FOOTER_MAX_TOKENS = 12;

/** 数一行的词元(判据与闸共用同一个实现 —— 两处各写一遍必然漂移)。 */
export function countTokens(line: string): number {
  return line
    .split(BORDER.v)
    .flatMap((g) => g.trim().split(/\s+/))
    .filter((x) => x !== '').length;
}

/**
 * ★ **底栏活仪表**(SDD V3 切片②)—— 行①尾部追加的三格:
 * `ctx <进度> <pct>% · <n>t/s · cache <pct>%`。
 *
 * 与 {@link formatStatusLine} 同一条纪律(段模型):**没数据的格整格不画** ——
 * 不画 0、不画占位符、不留孤立分隔符(I2:NULL ≠ 0)。返回单行字符串,
 * 行数由调用方的 `StatusLine` 保证不增(I3)。
 *
 * ⚠ 进度条用 ASCII `#-`,不是 `render/bar.ts` 的 `█░`:那两个字形量过一次真终端,
 * 而这一格要在**任意**终端里与右边的百分比对齐,ASCII 是唯一不用赌的一档(I4)。
 * ⚠ 函数**不碰时钟**:`tps` 由接线层用注入的 `now()` 算好送来(I6)。
 */
const GAUGE_SEP = ' · ';
const GAUGE_WIDTH = 10;

/** 活仪表要的 usage 子集。2026-08-17 帧实测后收窄:cache% 删了 —— 窗口段已有 `cacheNN%`, 同屏两个 cache 是重复读数。 */
export interface StatusGaugeUsage {
  /** 本轮 completion token 数。 */
  completionTokens: number;
}

export interface StatusGaugeInput {
  /** `null` = 还没跑过一轮 ⇒ **整块缺席**(仪表是"这一轮的读数")。 */
  usage: StatusGaugeUsage | null;
  /** 只看 `ratio`;`null`(含窗口未知)⇒ ctx 格缺席。**本格在场时调用方要把平文 `ctx N%` 段撤下** —— 同屏两个 ctx 是重复读数(帧实测)。 */
  pressure: { ratio: number } | null;
  /** 由接线层用注入的 `now()` 算好;`null` = 无上一轮值 ⇒ t/s 格缺席。 */
  tps: number | null;
}

export function formatStatusGauge(i: StatusGaugeInput): string {
  if (i.usage === null) return '';
  const segs: string[] = [];
  if (i.pressure !== null) {
    const done = Math.min(GAUGE_WIDTH, Math.max(0, Math.round(i.pressure.ratio * GAUGE_WIDTH)));
    const bar = `${'#'.repeat(done)}${'-'.repeat(GAUGE_WIDTH - done)}`;
    segs.push(`ctx ${bar} ${Math.round(i.pressure.ratio * 100)}%`);
  }
  // `fmtUsd` 同款口径:小数只在读起来有意义的量级留 —— 0.4t/s 画成 `0t/s` 就是编的 0。
  // ≥1000 上 k 档 (帧实测 fixture 秒回画出 `92000t/s` —— 数是真的, 量级格式不能缺)。
  if (i.tps !== null) {
    const t = i.tps >= 1000 ? `${Math.round(i.tps / 1000)}k` : i.tps < 10 ? i.tps.toFixed(1) : String(Math.round(i.tps));
    segs.push(`${t}t/s`);
  }
  return segs.join(GAUGE_SEP);
}
