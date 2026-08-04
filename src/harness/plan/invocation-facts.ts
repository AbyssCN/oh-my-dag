/**
 * plan/invocation-facts —— **谁会自动执行这个产物**:确定性结构事实采集(R3 前置,2026-08-03)。
 *
 * ## 它是哪一格
 *
 * 与 `static-lint` 同族 —— Fowler 2×2 里的 **computational feedforward**:跑之前、确定性、
 * 毫秒级、只报不拦、拿不准就不报。区别在于 static-lint 判的是「这张图注定失败」,
 * 这里答的是「碰这个文件的后果会不会离开我们能回滚的范围」。
 *
 * ## 为什么是这一条事实(有实验背书,不是拍脑袋)
 *
 * 2026-08-03 三臂 eval(`scripts/eval-blocking-classify.ts`)量到:
 * 模型判「可逆 vs 不可逆」在**表象与真值相反**的岔口上漏标 25–33%,失败模式高度一致 ——
 * 它停在「这次改动落在哪」,不追一步「它的执行会不会离开树」。典型判词:
 *
 * > 这只是工作树中的默认参数修改,**尚未实际发送邮件**,选错可直接回滚重算。
 *
 * 补上一条结构事实后 **0%**,而且 **`weak` 臂(只给结构关系)与 `on` 臂(完整因果链)完全一致** ——
 * **模型不需要因果链,只需要知道"谁会执行它"**,剩下的它自己推得出来。
 * 这把工程面从"静态分析调用图"降到 **grep 级**,省下一个量级。
 *
 * ## ⚠ 结构性看不见的那一半 —— 靠声明,不靠假装
 *
 * **生产 crontab / 外部调度器 / deploy hook 不在仓里**,任何仓内扫描器都**看不到**它们。
 * 装作扫得到就是造假。所以这里分两个来源,且**在输出里分得开**:
 *
 * - `scanned` —— 真扫出来的(package scripts · CI workflow · 仓内 cron 文件)。
 * - `declared` —— owner 在 `.omd/config.json` 的 `invokedBy` 段里声明的。
 *   先例是同一份文件里的 `declaredPlans`:它存在的理由正是"持仓 auto-probe 探不到,只能声明"。
 *
 * ## 三条纪律(照 static-lint,踩过的坑不重踩)
 *
 * 1. **空 ≠ 没扫。** `sources` 如实列出**实际查过哪几处**。"扫了三处没找到"与"没扫"是两件事,
 *    而后者绝不能被读成前者(同本仓 `NULL ≠ 0 ≠ 不适用` 那条)。
 * 2. **不猜。** 注释掉的 cron 行、模板里的占位路径、拿不准的匹配 —— 一律不报。
 *    静态检查一旦开始猜就变成了第三个 judge,而且是个没证据的。
 * 3. **只报不拦。** 出口是喂给判断的证据,不是闸。
 *
 * ## ⚠ 已知边界:**只认逐字出现的路径,不追传递可达**(2026-08-03 dogfood 挖出来的)
 *
 * 在本仓实跑:`scripts/dag-research.ts` → 正确报出 `package.json:scripts.dag-research` +
 * `.github/workflows/dag-research.yml`;而 `src/mcp/server.ts` → **报"未发现"**,
 * 尽管它确实会被执行 —— 它是经 `cli.ts` 间接到达的,没有任何调度配置逐字提到它。
 *
 * **这个粒度是刻意的,但它是不是对的粒度,今天没有读数。** 要追传递可达就得走 import 图,
 * 而那正是弱事实臂实验证明**判断本身不需要**的那一层静态分析 ——
 * ⚠ 但那个实验的语料**全是直接命名的场景**,所以它答不了"间接可达要不要算"。
 *
 * → **下一个该量的**:语料补几条"改动落在被间接调用的文件上"的岔口,
 * 看只给直接命名的事实够不够。够 → 这个粒度就是对的;不够 → 那个差就是 import 图的价格。
 * **在量之前别去建它** —— 那正是本仓「用实验决定要不要建」那条。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { ConductorPlan } from '../conductor-plan';
import { declaredOutput } from './static-lint';
import { reachableFrom } from './import-reach';

/** 一条「谁会执行它」的结构事实。 */
export interface Invoker {
  kind: 'package-script' | 'ci-workflow' | 'repo-cron' | 'declared' | 'import-chain';
  /** 在哪找到的 —— 人与模型都要能顺着它去核。 */
  where: string;
}

export interface InvocationFacts {
  path: string;
  invokers: Invoker[];
  /**
   * **实际查过哪几处**。`invokers` 为空时读者靠它区分"扫了没找到"与"根本没扫" ——
   * 这两件事对判断的含义相反,而空数组本身分不开。
   */
  sources: string[];
}

/** 注释行(`#` 开头)不算 —— 注释掉的 cron 行是"不猜"那条纪律的头号考题。 */
const isCommented = (line: string): boolean => /^\s*#/.test(line);

/** 读文件, 读不到返回 null (读不到 ≠ 内容为空 —— 前者该从 sources 里缺席)。 */
function readOrNull(p: string): string | null {
  try {
    return statSync(p).isFile() ? readFileSync(p, 'utf8') : null;
  } catch {
    return null;
  }
}

/** `package.json` 的 scripts 里逐字出现该路径 → 它会被 `bun run <script>` 执行。 */
function fromPackageScripts(cwd: string, path: string, sources: string[]): Invoker[] {
  const raw = readOrNull(join(cwd, 'package.json'));
  if (raw === null) return [];
  sources.push('package.json:scripts');
  try {
    const scripts = (JSON.parse(raw) as { scripts?: Record<string, string> }).scripts ?? {};
    return Object.entries(scripts)
      .filter(([, body]) => body.includes(path))
      .map(([name]) => ({ kind: 'package-script' as const, where: `package.json:scripts.${name}` }));
  } catch {
    return []; // package.json 坏了不是本模块该管的事, 但也别假装扫过
  }
}

/** `.github/workflows/*.yml` 里逐字出现该路径 → CI 会执行它。 */
function fromCiWorkflows(cwd: string, path: string, sources: string[]): Invoker[] {
  const dir = join(cwd, '.github', 'workflows');
  if (!existsSync(dir)) return [];
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));
  } catch {
    return [];
  }
  sources.push(`.github/workflows/ (${files.length} 个)`);
  const hits: Invoker[] = [];
  for (const f of files) {
    const body = readOrNull(join(dir, f));
    if (body === null) continue;
    for (const line of body.split('\n')) {
      if (isCommented(line) || !line.includes(path)) continue;
      hits.push({ kind: 'ci-workflow', where: `.github/workflows/${f}` });
      break; // 一个文件报一次就够 —— 报几次不改变结论, 只是噪声
    }
  }
  return hits;
}

/** 仓内 cron 文件(`crontab` / `*.cron`)。⚠ **生产 crontab 不在仓里**, 那一半走 declared。 */
function fromRepoCron(cwd: string, path: string, sources: string[]): Invoker[] {
  const candidates = ['crontab', 'Crontab', 'deploy/crontab', 'ops/crontab'];
  const hits: Invoker[] = [];
  for (const rel of candidates) {
    const body = readOrNull(join(cwd, rel));
    if (body === null) continue;
    sources.push(rel);
    for (const line of body.split('\n')) {
      if (isCommented(line) || !line.includes(path)) continue;
      hits.push({ kind: 'repo-cron', where: rel });
      break;
    }
  }
  return hits;
}

/**
 * owner 声明的调用方 —— **扫描器结构性看不到的那一半**(生产 crontab / 外部调度器 / deploy hook)。
 * 形状: `.omd/config.json` 的 `invokedBy: { "<路径前缀>": "<一句话说明谁执行它>" }`。
 * 先例见同一份文件里的 `declaredPlans`(持仓探不到, 只能声明)。
 */
function fromDeclared(cwd: string, path: string, sources: string[]): Invoker[] {
  const raw = readOrNull(join(cwd, '.omd', 'config.json'));
  if (raw === null) return [];
  sources.push('.omd/config.json:invokedBy');
  try {
    const decl = (JSON.parse(raw) as { invokedBy?: Record<string, string> }).invokedBy ?? {};
    return Object.entries(decl)
      .filter(([prefix]) => path === prefix || path.startsWith(prefix))
      .map(([prefix, note]) => ({ kind: 'declared' as const, where: `.omd/config.json:invokedBy["${prefix}"] — ${note}` }));
  } catch {
    return [];
  }
}

/** 调度配置里**逐字出现过的**脚本路径 —— 反向查的起点。 */
const SCRIPT_PATH_TOKEN = /[\w./-]+\.(?:ts|js|sh|py)/g;

/**
 * ⚠ **必须带上来源种类, 不许抹平成"调度配置"** (2026-08-03, 实测教训)。
 *
 * 第一版把四处来源的命中合并成一个字符串列表, 于是渲染出来只剩「出现在调度配置里」。
 * `indirect` 档实测: 拿到了 import 链的 `edit-mailer-default-sender` **仍然 0/3** ——
 * 因为「调度配置」既可能是 CI 的测试任务 (人不在场也无所谓), 也可能是生产 crontab,
 * 而模型读成前者**完全合理**。件本来知道这个区别 (它是在哪个文件里找到的), 是收集时丢了。
 *
 * 这是又一次「把两件不同的事压成一件」—— 同 `NULL ≠ 0`、`vacuity-only vs skipped`、
 * `无此行 vs 库不可读`。**证据的价值全在分辨率上, 抹平一档就等于没给。**
 */
function schedulerNamedPaths(cwd: string): { path: string; via: string }[] {
  const texts: { body: string; via: string }[] = [];
  const pkg = readOrNull(join(cwd, 'package.json'));
  if (pkg !== null) {
    try {
      texts.push({
        body: Object.values((JSON.parse(pkg) as { scripts?: Record<string, string> }).scripts ?? {}).join('\n'),
        via: 'package.json 的 scripts (由开发者手动 `bun run` 触发)',
      });
    } catch { /* 坏 JSON 不是这里该管的 */ }
  }
  const wf = join(cwd, '.github', 'workflows');
  if (existsSync(wf)) {
    try {
      for (const f of readdirSync(wf).filter((x) => x.endsWith('.yml') || x.endsWith('.yaml'))) {
        const b = readOrNull(join(wf, f));
        if (b !== null) texts.push({ body: b.split('\n').filter((l) => !isCommented(l)).join('\n'), via: `CI workflow .github/workflows/${f}` });
      }
    } catch { /* 同上 */ }
  }
  for (const rel of ['crontab', 'Crontab', 'deploy/crontab', 'ops/crontab']) {
    const b = readOrNull(join(cwd, rel));
    if (b !== null) texts.push({ body: b.split('\n').filter((l) => !isCommented(l)).join('\n'), via: `仓内 cron 文件 ${rel} (按表自动执行)` });
  }
  const cfg = readOrNull(join(cwd, '.omd', 'config.json'));
  if (cfg !== null) {
    try {
      const d = (JSON.parse(cfg) as { invokedBy?: Record<string, string> }).invokedBy ?? {};
      for (const [k, note] of Object.entries(d)) texts.push({ body: k, via: `owner 声明的外部调度器 — ${note}` });
    } catch { /* 同上 */ }
  }
  const out = new Map<string, string>();
  for (const t of texts) for (const m of t.body.match(SCRIPT_PATH_TOKEN) ?? []) if (!out.has(m)) out.set(m, t.via);
  return [...out].map(([path, via]) => ({ path, via }));
}

/**
 * 每个调度入口的可达闭包 —— **按 cwd 记忆**。走图要读文件, 而一张图上每个节点都会问一次,
 * 不缓存就是把同一次 BFS 跑 N 遍。
 */
const reachCache = new Map<string, { entry: string; via: string; reach: Set<string> }[]>();

function entryReachSets(cwd: string): { entry: string; via: string; reach: Set<string> }[] {
  const hit = reachCache.get(cwd);
  if (hit) return hit;
  const sets = schedulerNamedPaths(cwd)
    .filter((e) => e.path.endsWith('.ts')) // 只有 TS 走得了 import 图; sh/py 不在这张图上
    .map((e) => ({ entry: e.path, via: e.via, reach: reachableFrom([join(cwd, e.path)]) }));
  reachCache.set(cwd, sets);
  return sets;
}

/**
 * **间接可达**: 目标自己没被逐字提到, 但某个被逐字提到的调度入口**经 import 图到得了它**。
 *
 * 为什么必须有这一层(有读数, 不是想当然): `indirect` 档实验里, 只给直接命名事实的 `weak` 臂
 * 在间接红线上**漏标 100%**(0/3, 0/3), 而给完整链的 `on` 臂 100% 修好 ——
 * **信息是够用的, 缺的就是这一跳**。
 *
 * ⚠ 只报**一跳到直接命名点**这件事本身, 不解释后果 —— 渲染出来的句子会进模型输入,
 * 掺结论就是把答案写进去 (闸: `invocation-facts.test.ts`)。
 */
function fromImportChain(cwd: string, path: string, sources: string[]): Invoker[] {
  const sets = entryReachSets(cwd);
  if (sets.length === 0) return [];
  sources.push(`import 图 (${sets.length} 个调度入口)`);
  const abs = join(cwd, path);
  return sets
    .filter((s) => s.reach.has(abs))
    .map((s) => ({
      kind: 'import-chain' as const,
      // **带上那个入口的来源种类** —— "CI 测试任务"与"生产 cron"对后果的含义完全不同, 抹平就等于没给。
      where: `被 ${s.entry} 经 import 到达, 而 ${s.entry} 出现在 ${s.via}`,
    }));
}

/** 采一个路径的全部结构事实。**纯读, 零 LLM。** */
export function invocationFactsFor(cwd: string, path: string): InvocationFacts {
  const sources: string[] = [];
  const direct = [
    ...fromPackageScripts(cwd, path, sources),
    ...fromCiWorkflows(cwd, path, sources),
    ...fromRepoCron(cwd, path, sources),
    ...fromDeclared(cwd, path, sources),
  ];
  // 直接命中就不必走图 —— 省一次 BFS, 且直接证据本来就更强。
  const invokers = direct.length > 0 ? direct : [...direct, ...fromImportChain(cwd, path, sources)];
  return { path, invokers, sources };
}

/**
 * 渲染成喂给判断的一句话。**措辞刻意只陈述结构关系, 不下结论** ——
 * eval 实测(`blocking-forks.test.ts` 的防泄题闸)证明结论词会把标签直接写进输入,
 * 那样量到的是"我提示得够不够明显"而不是"证据管不管用"。
 *
 * 空结果**如实说"查过哪几处"**, 不说"它不会被自动执行" —— 后者是个我们没资格下的断言。
 */
export function renderInvocationFacts(f: InvocationFacts): string {
  if (f.invokers.length === 0) {
    return f.sources.length === 0
      ? `\`${f.path}\`: 未能查询任何调用来源。`
      : `\`${f.path}\`: 在 ${f.sources.join(' · ')} 中未发现自动调用它的配置。`;
  }
  // ⚠ 截断: 这句会进下一轮 conductor 的 prompt。一个被十几处 import 的公共模块会列出十几条链,
  // 而**多列几条不改变结论, 只把真信号淹掉**(同 observations「压成能归组统计的东西」那条)。
  // 3 条足够让人顺着去核, 剩下的报个数。
  const CAP = 3;
  const shown = f.invokers.slice(0, CAP).map((i) => i.where).join(' · ');
  const rest = f.invokers.length - CAP;
  return `\`${f.path}\` 出现在: ${shown}${rest > 0 ? ` (另有 ${rest} 处同类)` : ''}。`;
}

/**
 * 一张图上「要改的文件里, 哪些会被自动执行」—— 出口是**观察**, 不是闸。
 *
 * 为什么值得进环: 观察者的产出会进**下一轮重展开的 prompt**(环唯一的信息通道), 而
 * 三臂 eval 实测正是这条事实把漏标从 25–33% 降到 0%。也就是说这不是"多报一句",
 * 是把模型缺的那一块补上 —— 而且它**只要结构关系**, 不需要因果链。
 *
 * ⚠ 只报**真扫到调用方**的。"未发现"不进观察 —— 那会让每张图都挂一串噪声,
 * 而噪声会把真信号淹掉(同 static-lint「拿不准一律不报」)。
 */
/**
 * t4 (交接 18 §六.1): `invokedBy` 声明的**空泛性 lint** —— 链的第三跳 (部署关系) 靠声明承载,
 * 「声明写得糊链就断」此前没有任何闸。确定性判据 (fail-open, 出观察不拦):
 *   空泛 = note 去空白后 <8 字, **或**不含任何执行机制信号词 (cron/CI/workflow/bun/npm/手动/每/
 *   定时/schedule/systemd/launchd/deploy)。机制词表是启发式下限 —— 它拦的是「会被执行」这类
 *   零信息声明, 不是文风闸。
 */
export function lintInvokerDeclarations(cwd: string): { prefix: string; note: string; problem: string }[] {
  const raw = readOrNull(join(cwd, '.omd', 'config.json'));
  if (raw === null) return [];
  let decl: Record<string, string>;
  try {
    decl = (JSON.parse(raw) as { invokedBy?: Record<string, string> }).invokedBy ?? {};
  } catch {
    return [];
  }
  const MECHANISM = /(cron|\bCI\b|workflow|bun |npm |pnpm |手动|每|定时|schedule|systemd|launchd|deploy|action)/i;
  const out: { prefix: string; note: string; problem: string }[] = [];
  for (const [prefix, note] of Object.entries(decl)) {
    const t = (note ?? '').trim();
    if (t.length < 8) out.push({ prefix, note: t, problem: `声明过短 (${t.length} 字) — 承载不了"谁在何时执行"` });
    else if (!MECHANISM.test(t)) out.push({ prefix, note: t, problem: '声明不含执行机制信号 (cron/CI/手动/定时/…) — 第三跳糊了链就断' });
  }
  return out;
}

export function scheduledArtifactFindings(
  plan: ConductorPlan,
  cwd: string,
): { kind: 'scheduled-artifact'; nodes: string[]; message: string }[] {
  const out: { kind: 'scheduled-artifact'; nodes: string[]; message: string }[] = [];
  // t4: 空泛声明 lint 搭同一趟观察者车 (每 plan 一次, 不按节点重复)。
  for (const bad of lintInvokerDeclarations(cwd)) {
    out.push({
      kind: 'scheduled-artifact',
      nodes: [],
      message: `⚠ invokedBy["${bad.prefix}"] 声明质量: ${bad.problem} (原文: "${bad.note}")`,
    });
  }
  for (const [id, node] of Object.entries(plan.nodes)) {
    const path = declaredOutput(node);
    if (!path) continue;
    const f = invocationFactsFor(cwd, path);
    if (f.invokers.length === 0) continue;
    out.push({
      kind: 'scheduled-artifact',
      nodes: [id],
      message:
        `节点 "${id}" 要改的 ${renderInvocationFacts(f)} ` +
        `也就是说这次改动的效果会**在下一次那个调用发生时生效**, 而不是停在工作树里。` +
        `如果这一步的选择错了, 想清楚它到那时还收不收得回来。`,
    });
  }
  return out;
}
