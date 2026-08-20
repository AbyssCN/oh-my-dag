/**
 * scripts/probes/h3-anchored-standard-ab —— #184 H3 flash 档 leaf 工具面时序 A/B (owner 2026-08-20)。
 *
 * ## 假设
 *
 * 被测座位 (默认 minimax-cn:MiniMax-M3, 经 --model 可换) 的 leaf **开局只给极简工具面 (read/write/edit/bash)**,
 * **首 tool call 后**经 `withToolFaceEscalation` 自动放成全工具面 —— 能在 pass-rate 不降的前提下
 * 降 token (因为 schema 越短, prompt 越小; cache-friendly 越长, 命中段越大)。
 *
 * ## 四要素 (跑前钉死, 事后不许改)
 *
 * - **单一变量** = 工具面**时序**: A=开局全量 / B=开局最小+首调后放全量。
 *   座位 · 任务集 · keepRecentTokens · hashlineEdit · thinkingLevel · prompt 档 · disciplineCore /
 *   toolRouting · 工具**集合**本身 —— 全同。
 *   B 的"放开"走 agent-leaf 既有 `withToolFaceEscalation` (agent-leaf.ts L562), 不是另起炉灶。
 *
 *   注: flash 不在 `DEFAULT_MINIMAL_TOOLFACE_SEATS` 里, 所以**生产里它本就拿全工具面**;
 *   B 臂经 `opts.minimalToolFaceSeats: [MODEL_ID]` 把它塞进名单 = 等价于"用生产
 *   同一条路, 只是名单多塞一个 flash"。A 臂不传该 opts = 走默认名单 = 全工具面从开局。
 *
 * - **对照基线** = H1 `bare` 档 (#182) 同座位同任务集 (D-2) —— **本实验不引 H1 读数**, 只 A↔B;
 *   拿 H1 (conductor prompt bare) 对账的留后置切片, 此脚本只测工具面时序这一格。
 *
 * - **成败信号 (写死, 无容差)**: pass-rate(B) ≥ pass-rate(A) **AND** raw-token(B) < raw-token(A)
 *   → 成立; 否则撤。
 *
 * - **两侧读数都记**: pass-rate · token 原始/折价 (cacheHit 段) · 工具调用次数 · 墙钟 · 不成立也写。
 *
 * ## 失败关闸 (跑前钉死, 不可绕过)
 *
 * 0 不是读数。本探针:
 *   ① 起跑前先发一次最小 `callModel` 探活 (maxTokens=5) —— 不通立刻**非零退出 + 把 provider
 *      原文错误 (状态码 + body) 原样打到 stderr**, 不汇总、不判词。
 *   ② 单臂跑后任一行 rawIn=0 ∧ rawOut=0、或错误串含 HTTP 4xx/5xx / 余额 / 超时 / 连接失败
 *      → 立刻**非零退出 + 原始错误到 stderr**, 不汇总、不判词。
 *   ③ 单一变量断言失败 → **非零退出 + 列出哪一项不同**。
 *   ④ 严格比较 (B ≥ A 不带容差, B < A 严格小于), 任何不达 → 判**撤**。
 *
 * ## 已知边界
 *
 * - 单 rep 量级: 4 次 leaf (2 臂 × 2 任务-实例) × 每叶 ~5-15 工具调用 → 大概 5-15 min,
 *   烧被测座位那本账。`--reps N` 翻倍; `--task` 暂只接 `debug-planted` (改 fixture 会漂判据)。
 *
 * 跑: bun --env-file=.env run scripts/probes/h3-anchored-standard-ab.ts [--reps 1] [--out .omd/eval/h3-anchored-ab]
 */
import '../../src/harness/script-bootstrap';
import { mkdirSync, writeFileSync } from 'node:fs';
import { $ } from 'bun';
import { bootstrapModelRuntime } from '../../src/model/bootstrap';
import { createAgentLeafRunner, DEFAULT_MINIMAL_TOOLFACE_SEATS } from '../../src/harness/agent-leaf';
import {
  createDebugFixture,
  inspectDiff,
  PLANTED_BUGS,
  type DebugFixture,
} from '../../src/eval/tasks/debug-planted';
import { callModel, ModelError } from '../../src/model/index';

// ── CLI ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const opt = (n: string): string | undefined => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const REPS = Math.max(1, Number(opt('reps') ?? '1'));
const OUT = opt('out') ?? '.omd/eval/h3-anchored-ab';
const TASK_ID = opt('task') ?? 'debug-planted';
/**
 * 被测座位。**owner 2026-08-21 改前提**: 原为 `deepseek:deepseek-v4-flash`(票面的「flash 档」),
 * 而该账户余额耗尽(实测 402 Insufficient Balance)—— 两臂在 1.1s 内同根塌, 没进 leaf 循环,
 * 那一跑**不是读数, 是 402**。owner 裁「改票面座位为 M3」, 于是被测座位改成生产 leaf/agent 座。
 *
 * ⚠ **旧设定下的任何读数就此作废**: 基线不在同一条件上, 两边的数不可互相搬用。
 * ⚠ 单一变量仍成立(已核): `DEFAULT_MINIMAL_TOOLFACE_SEATS = ['deepseek-v4-pro']`
 *   (`agent-leaf.ts:535`)**不含** `MiniMax-M3` → A 臂照旧"开局全工具面", B 臂靠 opts 塞名单。
 *   名单按 **modelId** 匹配(`agent-leaf.ts:1122`), 所以塞的是 `MiniMax-M3` 不是整条坐标。
 */
const MODEL = opt('model') ?? 'minimax-cn:MiniMax-M3';
/** 名单按 modelId 匹配 —— 从坐标里取冒号后那半。 */
const MODEL_ID = MODEL.slice(MODEL.indexOf(':') + 1);
const log = (s: string): void => void process.stderr.write(s + '\n');

// ── 严死闸 ──────────────────────────────────────────────────────────────────
/** 非零退出 + 把 provider 原文错误打到 stderr, **不**输出汇总表/判词/rows.json。 */
function die(label: string, raw: string): never {
  process.stderr.write(`\n[H3 AB · ${label}] 非零退出\n`);
  process.stderr.write(raw.endsWith('\n') ? raw : raw + '\n');
  process.exit(1);
}

/** 把任何抛错还原成"原文" + HTTP 状态 (有的话) + 业务码 (有的话) —— 不吃 (仓规 §坑-2)。 */
function describeErr(e: unknown): { status?: number; providerCode?: string; raw: string } {
  if (e instanceof ModelError) {
    return {
      ...(e.status !== undefined ? { status: e.status } : {}),
      ...(e.providerCode !== undefined ? { providerCode: e.providerCode } : {}),
      raw: `[ModelError kind=${e.kind}] ${e.message}`,
    };
  }
  if (e instanceof Error) {
    return { raw: `[${e.name}] ${e.message}` };
  }
  return { raw: String(e) };
}

// ── 单一变量 ────────────────────────────────────────────────────────────────
interface ArmConfig {
  /** 输出 + 报告里印的名字。 */
  name: string;
  /** 一句话说清这一臂动了什么。 */
  note: string;
  /** 同座位同任务集同 keepRecentTokens 同 hashlineEdit —— 只有这俩是变量。 */
  minimalToolFaceSeats?: readonly string[];
}
/**
 * 共同 opts (硬编码, 两臂共享) —— hashlineEdit 关 (仓规: 弱模型改文件错位/腐烂, 但这是对照
 * 不开 hashline 避免引入第二变量; MINIMAL_TOOLFACE_TOOLS 不含 hashline 工具对, 工具**集合**
 * 在两臂的"放开后"一致)。thinkingLevel=xhigh (钉死避开通道缺省差)。
 */
const BASE_OPTS = {
  thinkingLevel: 'xhigh' as const,
  hashlineEdit: false,
};
const ARMS: ArmConfig[] = [
  {
    name: 'A-standard',
    note: `${MODEL_ID} 走默认 minimalToolFaceSeats = 它不在内 (名单只有 deepseek-v4-pro) → 全工具面从开局`,
  },
  {
    name: 'B-anchored',
    note: `opts.minimalToolFaceSeats = [${MODEL_ID}] → 极简面开局, 首 tool call 后放全量`,
    minimalToolFaceSeats: [MODEL_ID],
  },
];

/**
 * **单一变量断言** —— 跑前必过。两臂**只能**在 `minimalToolFaceSeats` 上不同, 其余字段全同。
 *
 * 这是把 SDD §4「核验单一变量」机械化:
 *   · 臂级字段 ⊆ {name, note, minimalToolFaceSeats} —— 出现别的键 → 死 (那意味着除了工具面时序还动了别的)
 *   · 两臂 name/note **值**不同是允许的 (报告标签) —— 但 BASE_OPTS 共享 (经闭包进 once()), 不会漂
 *   · `keepRecentTokens` 不在 opts 里出现 = 走 agent-leaf 装配期硬钉的 20000 默认值, 两臂同源
 *   · fixture (PLANTED_BUGS) 是模块常量, 两臂经同一 once() 取同一 fx
 *
 * 任一项违规 → die。
 */
function assertSingleVariable(): void {
  const allowedArmKeys = new Set(['name', 'note', 'minimalToolFaceSeats']);
  for (const arm of ARMS) {
    for (const k of Object.keys(arm)) {
      if (!allowedArmKeys.has(k)) {
        die('单一变量断言', `臂 ${arm.name} 多了未知键 '${k}' —— 应只允许 name/note/minimalToolFaceSeats`);
      }
    }
  }
  // 显式语义: A 不传 → 走默认 minimalToolFaceSeats (被测座位不在内 → 全工具面开局);
  // B 显式传 [MODEL_ID] → 极简开局, 首调后放全。两臂确实**只**在这一个键上不同。
  if ('minimalToolFaceSeats' in ARMS[0]!) {
    die('单一变量断言', 'A 臂不该显式带 minimalToolFaceSeats —— 该走默认名单 = 全工具面');
  }
  if (!ARMS[1]!.minimalToolFaceSeats || ARMS[1]!.minimalToolFaceSeats[0] !== MODEL_ID) {
    die('单一变量断言', `B 臂必须显式带 minimalToolFaceSeats=[${MODEL_ID}] —— 这是被测变量`);
  }
  // ★ A 臂的语义**依赖**被测座位不在默认名单里。座位可经 --model 换 (owner 2026-08-21 换过一次),
  //   而换到一个**本就在**默认名单里的座位时, A 臂会跟 B 臂一样极简开局 —— 两臂等价, 实验静默失效
  //   (读数照出, 只是量的是同一件事)。所以这条必须是闸, 不能靠"记得别那么配"。
  if (DEFAULT_MINIMAL_TOOLFACE_SEATS.includes(MODEL_ID)) {
    die(
      '单一变量断言',
      `被测座位 ${MODEL_ID} 本就在 DEFAULT_MINIMAL_TOOLFACE_SEATS 里 → A 臂也会极简开局, 两臂等价 = 没有对照。` +
        `换一个不在名单里的座位 (当前名单: ${DEFAULT_MINIMAL_TOOLFACE_SEATS.join(', ')})。`,
    );
  }
  // BASE_OPTS / fixture / keepRecentTokens 全是单一真源 (常量), 不需要运行时断言 —— 改 BASE_OPTS 会同时动两臂, 不可能单边漂。
}

// ── 一行的形状 ─────────────────────────────────────────────────────────────
interface Row {
  arm: string;
  rep: number;
  /** task id (debug-planted: 哪个 bug 在 fix) —— 两臂取同一 fx, 此值必同。 */
  task: string;
  /** pass = oracle 全绿 ∧ tsc 干净 ∧ 测试文件没被改。 */
  pass: boolean;
  /** 原始 token (provider 报的 in / out, 不扣 cache)。 */
  rawIn: number;
  rawOut: number;
  /** 折价 token: cacheHit 段按 ~5% 价计后的 in, out 恒全价 (OUTPUT 不进 cache)。 */
  discountedIn: number;
  /** 命中 prompt-cache 的 token 数。null = provider 没报 (不是 0, 不是"没命中")。 */
  cacheHit: number | null;
  toolCalls: number;
  filesTouched: number;
  noopWrites: number;
  stalled: boolean;
  spinFused: boolean;
  wallMs: number;
  diffLines: number;
  testsModified: number;
  strayFiles: number;
  textTail: string;
  error?: string;
}

// ── 折价计算 ───────────────────────────────────────────────────────────────
// deepseek 官方价 (2026-08 末次确认): cache hit $0.014/M, miss $0.28/M, output $0.42/M。
// 我们不在这脚本里报美元, 只报**折价后 input token** (cacheHit 段按 ~5% 价计, miss 段按 100%)。
// 这是个**相对量**, 两臂同口径, 足够判"谁更省", 不需要精确到分。
const CACHE_HIT_RATIO = 0.05;
function discounted(rawIn: number, cacheHit: number | null): number {
  if (cacheHit == null || cacheHit === 0) return rawIn;
  const hit = Math.min(cacheHit, rawIn);
  const miss = Math.max(0, rawIn - hit);
  return Math.round(miss + hit * CACHE_HIT_RATIO);
}

// ── 凭据探活 (起跑前) ────────────────────────────────────────────────────────
/**
 * 发一次最小 `callModel` 探活 —— 不通就立刻非零退出并打原文, **不**进入主体。
 *
 * 凭据/余额不足属于「没量到」, 不是「假设不成立」(SDD §2 钉死)。
 * maxRetries=0 —— 探活不需要退避重试, 立刻出真错误。
 */
async function preflightCredentials(model: string): Promise<void> {
  process.stderr.write(`[H3 AB · 凭据探活] ${model} …\n`);
  try {
    const r = await callModel({
      model,
      maxTokens: 5,
      maxRetries: 0,
      messages: [{ role: 'user', content: 'ping' }],
    });
    const u = r.usage;
    if (!u || (u.in === 0 && u.out === 0)) {
      die(
        '凭据探活',
        `provider 通了但 usage 为 0 (in=${u?.in ?? '?'} out=${u?.out ?? '?'}) — 凭据或响应异常`,
      );
    }
    process.stderr.write(
      `[H3 AB · 凭据探活] OK — in=${u.in} out=${u.out} (探活消耗计入账本, 与生产同形态)\n`,
    );
  } catch (e) {
    const d = describeErr(e);
    /**
     * ★ `truncation` **不是凭据问题, 是探活自己设计得太紧**(2026-08-21 实测)。
     *
     * 本探活发 `maxTokens: 5`。推理档模型(实测 `minimax-cn:MiniMax-M3`)会把这 5 个 token
     * 全用在 reasoning 上, 于是返回空内容 → `ModelError kind=truncation`。
     * 而**这条错误恰恰证明凭据是通的** —— 请求到达了模型、模型回了话, 只是被预算截断。
     *
     * 把它判死会得到与 402 一模一样的出口(非零退出 + 不产读数), 而两者性质相反:
     * 402 = 真的没量到; truncation = 量到了、只是探活的尺子太短。**压成一种就再也分不开**
     * (本仓 `NULL ≠ 0 ≠ 不适用` 同族)。所以这里放行, 并把它打出来留证。
     */
    if (e instanceof ModelError && e.kind === 'truncation') {
      process.stderr.write(
        `[H3 AB · 凭据探活] OK(truncation)— ${model} 把 maxTokens=5 全用在 reasoning 上, 返回空内容。` +
          `请求已到达模型 = 凭据通; 这不是余额/鉴权问题, 放行。原文: ${d.raw}\n`,
      );
      return;
    }
    die('凭据探活', `model=${model}\n${d.raw}${d.status ? `  http_status=${d.status}` : ''}${d.providerCode ? `  provider_code=${d.providerCode}` : ''}`);
  }
}

// ── 行级失败分类 (判别"是否真读数") ──────────────────────────────────────────
/**
 * 分类行级错误: 'infra' = 基础设施层没量到 (HTTP/余额/超时/连接/0-token/empty-done);
 * 'task-fail' = 量到了, 模型没干对活 (pass=false 是真读数); null = 行 OK。
 *
 * SDD §1 钉死: 任一臂出现 HTTP 4xx/5xx、鉴权、余额、超时、连接失败、token=0、未触达 leaf → 非零退出。
 */
function classifyRowError(row: Row): 'infra' | null {
  // (1) token=0 不是读数 —— 不论有没有 error 串
  if (row.rawIn === 0 && row.rawOut === 0) return 'infra';
  // (2) 错误串里的基础设施信号
  if (row.error) {
    const e = row.error;
    if (/\b[45]\d\d\b/.test(e)) return 'infra'; // HTTP 4xx/5xx
    if (/insufficient|quota|balance/i.test(e)) return 'infra'; // 余额/配额
    if (/timeout|timed[- ]?out|econn|connection[- ]?refused|network|reset|socket hang up/i.test(e)) return 'infra';
    if (/unauthorized|forbidden|invalid api ?key|authentication/i.test(e)) return 'infra'; // 鉴权
    if (/0-token|empty-done/i.test(e)) return 'infra'; // 0-token empty-done (agent-leaf 抛)
  }
  // (3) 没报错但也没真触达 leaf (既无 tool 也无文本且 token 也极小) —— 兜底, 不放过
  if (row.toolCalls === 0 && row.textTail === '' && row.rawIn + row.rawOut < 50) return 'infra';
  return null;
}

// ── 一次 arm × rep ─────────────────────────────────────────────────────────
async function once(arm: ArmConfig, rep: number): Promise<Row> {
  const t0 = Date.now();
  const base = {
    arm: arm.name,
    rep,
    task: PLANTED_BUGS[0]?.id || TASK_ID, // 种哪个用哪个, taskId 在 try 内用 fx.bugs 重写
    pass: false,
    rawIn: 0,
    rawOut: 0,
    discountedIn: 0,
    cacheHit: null as number | null,
    toolCalls: 0,
    filesTouched: 0,
    noopWrites: 0,
    stalled: false,
    spinFused: false,
    wallMs: 0,
    diffLines: 0,
    testsModified: 0,
    strayFiles: 0,
    textTail: '',
  };
  let fx: DebugFixture | undefined;
  try {
    // 创工作树 (常见 sandbox 拒写 .git/worktrees/ → 这里抛 ShellError, 落到 catch)
    fx = await createDebugFixture();
    base.task = fx.bugs.map((b) => b.id).join('+') || base.task;
    // ★ 同一根 opts, 只差 minimalToolFaceSeats 这一个键 (B 加, A 不加)
    const run = createAgentLeafRunner({
      ...BASE_OPTS,
      /**
       * ★ **必须给 `cwd`**(2026-08-21 实测教训)。省略 → leaf 落在 `process.cwd()` = **主仓**,
       * 而种了 bug 的 fixture 在 `fx.root`(临时目录)。三个后果, 每个都静默:
       *   ① leaf 在主仓里找那个 bug —— 它不在那儿, 找不到;
       *   ② oracle 查的是 `fx.root`(下面两行), 那里没人动过 → **`pass` 恒为 false**,
       *      而这个 false 一点信息量都没有(不是"模型没修好", 是"根本没让它修对地方");
       *   ③ leaf 拿 bash 在主仓跑全量 `bun test`(~100s/次), 十分钟零 API 调用就卡在这里,
       *      顺带往生产账本灌合成记录。
       * 上一跑(pid 2109861)就是这么废掉的 —— 它"在跑", 只是跑错了地方。
       */
      cwd: fx.root,
      // MINIMAL_TOOLFACE_TOOLS (read/write/edit/bash) 经 hashlineEdit=false 后, 两臂都不
      // 注入 hashline 工具对 → 工具**集合**真的对得上: B 拿到这 4 件后扩成全, A 从一开始就拿到全。
      ...(arm.minimalToolFaceSeats ? { minimalToolFaceSeats: arm.minimalToolFaceSeats } : {}),
    });
    const r = await run({ prompt: fx.spec, model: MODEL });

    // oracle: scoped test (种了哪个就只看那一个文件) + whole-project tsc
    const tsc = await $`npx tsc --noEmit -p tsconfig.json`.cwd(fx.root).quiet().nothrow();
    const t = await $`bun test ${fx.testPaths.join(' ')}`.cwd(fx.root).quiet().nothrow();
    const tOut = t.stdout.toString() + t.stderr.toString();
    const passNum = Number(/(\d+) pass/.exec(tOut)?.[1] ?? 0);
    const failNum = Number(/(\d+) fail/.exec(tOut)?.[1] ?? 0);
    const testsGreen = failNum === 0 && passNum > 0;
    const tscClean = tsc.exitCode === 0;

    // 反作弊 + 精准度
    const diff = await inspectDiff(fx);
    const testsModified = diff.testsModified.length;
    const oraclePass = testsGreen && tscClean && testsModified === 0;

    const noop = (r.writeEffects ?? []).filter((w) => w.noop).length;
    const cacheHit = r.usage?.cacheHit ?? null;
    const rawIn = r.usage?.in ?? 0;
    const rawOut = r.usage?.out ?? 0;

    return {
      ...base,
      pass: oraclePass,
      rawIn,
      rawOut,
      discountedIn: discounted(rawIn, cacheHit),
      cacheHit,
      toolCalls: r.toolCalls ?? 0,
      filesTouched: (r.filesTouched ?? []).length,
      noopWrites: noop,
      stalled: r.stalled === true,
      spinFused: r.spinFused != null,
      wallMs: Date.now() - t0,
      diffLines: diff.insertions + diff.deletions,
      testsModified,
      strayFiles: diff.strayFiles.length,
      textTail: (r.text ?? '').slice(-300),
    };
  } catch (e) {
    // 塌了也是读数 —— 原文进 row, 不吞 (仓规 §坑-2)
    const d = describeErr(e);
    return {
      ...base,
      wallMs: Date.now() - t0,
      textTail: '',
      error: `${d.raw}${d.status ? `  http_status=${d.status}` : ''}${d.providerCode ? `  provider_code=${d.providerCode}` : ''}`.slice(0, 500),
    };
  } finally {
    if (fx) await fx.cleanup().catch(() => {}); // 工作树清理幂等, 失败也不吞; fx 可能从未赋值 (fixture 创失败)
  }
}

// ── 主流程 ──────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  // (1) 起跑前必过 —— 单一变量断言
  assertSingleVariable();

  // (2) 模型运行时 + 凭据探活
  bootstrapModelRuntime();
  await preflightCredentials(MODEL);

  mkdirSync(OUT, { recursive: true });

  // (3) 跑两臂
  const rows: Row[] = [];
  for (const arm of ARMS) {
    for (let rep = 1; rep <= REPS; rep++) {
      log(`▶ ${arm.name} rep${rep} …`);
      const row = await once(arm, rep);
      rows.push(row);
      const cls = classifyRowError(row);
      log(
        `  ${row.pass ? 'PASS' : 'FAIL'} ` +
          `in=${row.rawIn} out=${row.rawOut} hit=${row.cacheHit ?? 'null'} ` +
          `disc=${row.discountedIn} tools=${row.toolCalls} files=${row.filesTouched} ` +
          `${(row.wallMs / 1000).toFixed(1)}s` +
          (row.error ? `  ERR ${row.error}` : '') +
          (cls ? `  [${cls}]` : ''),
      );
      // 增量落盘, 跑挂了下次能从 rows.json 接 (仓规 §空跑可恢复)
      writeFileSync(`${OUT}/rows.json`, JSON.stringify(rows, null, 2));

      // (4) 关闸: 任一行被判 infra → 非零退出, 不汇总
      if (cls) {
        die(
          `臂 ${arm.name} rep${rep} 基础设施层未量到`,
          `task=${row.task} raw_in=${row.rawIn} raw_out=${row.rawOut} tool_calls=${row.toolCalls}\n` +
            `error: ${row.error ?? '(无 error 串, 但 rawIn=0 ∧ rawOut=0)'}`,
        );
      }
    }
  }

  // (5) 汇总 (只在所有行都过了基础设施闸后才允许)
  const armRows = (name: string): Row[] => rows.filter((r) => r.arm === name);
  const passRate = (xs: Row[]): number => (xs.length ? xs.filter((r) => r.pass).length / xs.length : 0);
  const avg = (xs: Row[], f: (r: Row) => number): number => (xs.length ? xs.reduce((a, r) => a + f(r), 0) / xs.length : 0);

  let md = `# #184 H3 anchored-standard A/B (flash 档 leaf 工具面时序)\n\n`;
  md += `座位: \`${MODEL}\` · 任务集: \`${TASK_ID}\` · reps=${REPS} · 工作树隔离\n`;
  md += `单一变量: 工具面时序 (A=开局全 / B=开局最小+首调后放全)。其余全同, 见脚本头四要素段。\n\n`;
  md += `## 摘要 (按契约段钉死的成败信号, 严格比较, 无容差)\n\n`;
  md += `| 臂 | 题次 | pass-rate | 平均 raw-in | 平均 raw-out | 平均 cacheHit | 平均折价 in | 平均工具调用 | 平均墙钟 |\n`;
  md += `|---|---|---|---|---|---|---|---|---|\n`;
  for (const arm of ARMS) {
    const xs = armRows(arm.name);
    md +=
      `| ${arm.name} | ${xs.length} | ${(passRate(xs) * 100).toFixed(0)}% | ` +
      `${avg(xs, (r) => r.rawIn).toFixed(0)} | ${avg(xs, (r) => r.rawOut).toFixed(0)} | ` +
      `${avg(xs, (r) => r.cacheHit ?? 0).toFixed(0)} | ${avg(xs, (r) => r.discountedIn).toFixed(0)} | ` +
      `${avg(xs, (r) => r.toolCalls).toFixed(1)} | ${(avg(xs, (r) => r.wallMs) / 1000).toFixed(1)}s |\n`;
  }
  const a = armRows('A-standard');
  const b = armRows('B-anchored');
  const pa = passRate(a);
  const pb = passRate(b);
  const rawA = avg(a, (r) => r.rawIn);
  const rawB = avg(b, (r) => r.rawIn);
  const discA = avg(a, (r) => r.discountedIn);
  const discB = avg(b, (r) => r.discountedIn);
  // 严格比较, 不带容差 (SDD §3 钉死)
  const passOk = pb >= pa;
  const rawOk = rawB < rawA;
  const verdict =
    passOk && rawOk ? '**成立** (B 不损 pass-rate 且省 token)'
      : !passOk ? '**撤** (pass-rate 降 → D-3 整条撤, 不留"再调调看")'
      : '**撤** (pass-rate 没降但 token 也没省 → 假设不成立)';
  md += `\n判词 (按契约段钉死的成败信号, 严格 B ≥ A ∧ B < A):\n\n`;
  md += `- A pass-rate ${(pa * 100).toFixed(0)}% vs B pass-rate ${(pb * 100).toFixed(0)}% → ${passOk ? 'B ≥ A ✓' : '**B < A**'} (无容差)\n`;
  md += `- A raw-in ${rawA.toFixed(0)} vs B raw-in ${rawB.toFixed(0)} → ${rawOk ? 'B < A ✓ (省)' : 'B ≥ A (没省)'}\n`;
  md += `- A 折价-in ${discA.toFixed(0)} vs B 折价-in ${discB.toFixed(0)} → ${discB < discA ? 'B < A ✓ (扣 cache 后)' : 'B ≥ A (扣 cache 也没省)'}\n`;
  md += `- ${verdict}\n`;

  md += `\n## 逐行 (原始行: rows.json)\n\n`;
  md += `| 臂 | rep | task | pass | raw in/out | cacheHit | 折价 in | 工具调 | 文件 | diff 行 | wall |\n`;
  md += `|---|---|---|---|---|---|---|---|---|---|---|\n`;
  for (const r of rows) {
    md +=
      `| ${r.arm} | ${r.rep} | ${r.task} | ${r.pass ? '✓' : '✗'} | ` +
      `${r.rawIn}/${r.rawOut} | ${r.cacheHit ?? 'null'} | ${r.discountedIn} | ` +
      `${r.toolCalls} | ${r.filesTouched} | ${r.diffLines} | ${(r.wallMs / 1000).toFixed(1)}s` +
      (r.error ? ` | **ERR** ${r.error.slice(0, 80)}` : '') +
      ` |\n`;
  }
  const errs = rows.filter((r) => r.error);
  if (errs.length) {
    md += `\n### 调用失败 (${errs.length}/${rows.length}) — **这些不是读数, 而是"模型没干对活"或"非基础设施错", 一律按 fail 计入**\n\n`;
    const grouped = new Map<string, number>();
    for (const e of errs) {
      const k = e.error?.slice(0, 100) ?? '?';
      grouped.set(k, (grouped.get(k) ?? 0) + 1);
    }
    for (const [k, n] of grouped) md += `- ×${n} ${k}\n`;
  }
  md += `\n## 真源 (零产物禁止)\n\n`;
  md += `原始行: \`${OUT}/rows.json\` · 报告: \`${OUT}/report.md\`\n`;
  md += `脚本: \`scripts/probes/h3-anchored-standard-ab.ts\` · SDD: \`docs/plan/2026-08-20-issue-184-h3-anchored-standard-ab-sdd.md\`\n`;

  writeFileSync(`${OUT}/report.md`, md);
  writeFileSync(`${OUT}/rows.json`, JSON.stringify(rows, null, 2));
  log(`\n→ 落盘 ${OUT}/ (${rows.length} 行, ${ARMS.length} 臂 × ${REPS} reps)`);
  log(md);
}

main().catch((e) => {
  // main 之外抛的 (assertSingleVariable / preflight / 跑挂了的非行级错) —— 原文打 stderr, 非零退出
  const d = describeErr(e);
  process.stderr.write(`\n[H3 AB · 未捕获] 非零退出\n${d.raw}\n`);
  process.exit(1);
});