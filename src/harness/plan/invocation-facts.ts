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

function schedulerNamedPaths(cwd: string): string[] {
  const texts: string[] = [];
  const pkg = readOrNull(join(cwd, 'package.json'));
  if (pkg !== null) {
    try {
      texts.push(Object.values((JSON.parse(pkg) as { scripts?: Record<string, string> }).scripts ?? {}).join('\n'));
    } catch { /* 坏 JSON 不是这里该管的 */ }
  }
  const wf = join(cwd, '.github', 'workflows');
  if (existsSync(wf)) {
    try {
      for (const f of readdirSync(wf).filter((x) => x.endsWith('.yml') || x.endsWith('.yaml'))) {
        const b = readOrNull(join(wf, f));
        if (b !== null) texts.push(b.split('\n').filter((l) => !isCommented(l)).join('\n'));
      }
    } catch { /* 同上 */ }
  }
  for (const rel of ['crontab', 'Crontab', 'deploy/crontab', 'ops/crontab']) {
    const b = readOrNull(join(cwd, rel));
    if (b !== null) texts.push(b.split('\n').filter((l) => !isCommented(l)).join('\n'));
  }
  const cfg = readOrNull(join(cwd, '.omd', 'config.json'));
  if (cfg !== null) {
    try {
      texts.push(Object.keys((JSON.parse(cfg) as { invokedBy?: Record<string, string> }).invokedBy ?? {}).join('\n'));
    } catch { /* 同上 */ }
  }
  const out = new Set<string>();
  for (const t of texts) for (const m of t.match(SCRIPT_PATH_TOKEN) ?? []) out.add(m);
  return [...out];
}

/**
 * 每个调度入口的可达闭包 —— **按 cwd 记忆**。走图要读文件, 而一张图上每个节点都会问一次,
 * 不缓存就是把同一次 BFS 跑 N 遍。
 */
const reachCache = new Map<string, { entry: string; reach: Set<string> }[]>();

function entryReachSets(cwd: string): { entry: string; reach: Set<string> }[] {
  const hit = reachCache.get(cwd);
  if (hit) return hit;
  const sets = schedulerNamedPaths(cwd)
    .filter((p) => p.endsWith('.ts')) // 只有 TS 走得了 import 图; sh/py 不在这张图上
    .map((entry) => ({ entry, reach: reachableFrom([join(cwd, entry)]) }));
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
    .map((s) => ({ kind: 'import-chain' as const, where: `被 ${s.entry} 经 import 到达, 而 ${s.entry} 出现在调度配置里` }));
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
export function scheduledArtifactFindings(
  plan: ConductorPlan,
  cwd: string,
): { kind: 'scheduled-artifact'; nodes: string[]; message: string }[] {
  const out: { kind: 'scheduled-artifact'; nodes: string[]; message: string }[] = [];
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
