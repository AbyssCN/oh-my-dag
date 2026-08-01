/**
 * src/harness/command-leaf —— 双模 leaf 之外的**第三类: 确定性命令叶子**(the owner 锁方案 A)。
 *
 * inproc leaf = 单发 callModel(LLM, 生成/判断)。
 * agent  leaf = 带工具子 agent(LLM, 改文件)。
 * command leaf = **这里** —— 直接跑一条 CLI(`codegraph trace X Y` / 扫描器…)**零 LLM** 捕获 stdout。
 *
 * 给"方法论 + 一堆确定性工具"型能力(codegraph / piolium)用: conductor 选命令 → 并行命令叶子干 →
 * 只 conductor + synthesis 烧 LLM。比 agent leaf 包 LLM 跑命令便宜得多, 且确定性可缓存友好。
 *
 * 安全 (GP-5 fail-closed, 因命令串来自 conductor 模型, 不可信):
 *  ① classifyCommand 拦危险命令 (rm -rf / git force / find -delete / DROP …, 复用 V2-HOOK 闸)。
 *  ② allowlist 命令首 token 白名单 (空白名单 = 全拒, 必须显式给如 ['codegraph'])。
 *  ②.5 shell 元字符拦 (防 `;` `|` `$()` 注入)。
 *  ②.6 git 子命令只读闸 (放行 bin 'git' 不等于放行 `git checkout .` / `git commit`)。
 *  ③ 超时 kill。
 *
 * **边界诚实说明**: 白名单是「防手滑 + 挡明显危险」的护栏, 不是对抗性沙箱 —— 'bun'/'node'/'npx'
 * 一旦在表内就等价于任意代码执行 (验证叶跑 `bun test` 是本职, 拿不掉)。command leaf 的真实边界是
 * cwd 锚 + 超时 + 危险模式表; 需要强隔离的是 agent leaf (那边有 bwrap jail)。
 */
import { classifyCommand } from './hooks/dangerous-cmd';
import { logger } from '../logger';
import type { ModelUsage } from '../model/types';

// 类型单一真理源 = leaf-runners.ts (executor-dag 只认接口形状, 不 import 实现) — 这里 re-export 保旧调用面。
export type { CommandLeafInput, CommandLeafResult, CommandLeafRunner } from './leaf-runners';
import type { CommandLeafInput, CommandLeafResult, CommandLeafRunner } from './leaf-runners';

/**
 * DAG 执行器的缺省命令白名单 —— **单一真源** (此前 ['bun','tsc','npx'] 字面量散在 4 处调用点)。
 * 判据: 一个「确定性验证叶」要能① 跑闸 ② 看见自己的产物 ③ 搜代码 ④ 调项目自有确定性工具。
 * 单一用途的 runner (cg-retrieve / sast-scan) 不吃这张表, 继续给最小白名单 —— fail-closed 不放宽。
 *
 * 不收的东西与理由: 写类 (rm/mv/cp/mkdir/chmod) —— 验证叶不该改文件系统, 要写就该是 agent leaf;
 * 网络类 (curl/wget) —— 防外泄与不确定性; env/printenv —— 输出会进模型上下文, 等于把 key 喂出去;
 * sed/awk —— `-i` 就地改文件, 收益不抵风险; npm/pnpm/yarn —— publish/install 是外向且改依赖树。
 */
export const DEFAULT_COMMAND_ALLOWLIST: readonly string[] = [
  // ① 构建 / 类型 / 测试闸
  'bun', 'node', 'tsc', 'npx',
  // ② 只读检视 —— 验证叶要能证实自己的产物真存在、非空、内容对
  'ls', 'cat', 'head', 'tail', 'wc', 'stat', 'file', 'du', 'pwd', 'realpath', 'basename', 'dirname', 'diff',
  // ③ 搜索
  'grep', 'rg', 'ugrep', 'find', 'bfs', 'fd',
  // ④ 结构化读取
  'jq',
  // ⑤ 项目自有确定性工具 —— 注意 `omd`/`oh-my-dag` **不在**表内 (2026-07-31 the owner 裁: 摘掉)。
  //    理由不是"它危险", 是**它根本不是 leaf 该有的工具**: command leaf 的定义是「零 LLM 跑一条
  //    确定性 CLI」, 而 `omd dag-run` 起的是一整张图 —— 烧 LLM、写文件、再生 leaf。放在这张表里,
  //    一个 conductor 就能让自己的 leaf 递归起图, 深度无上限、成本无上限、留痕挂不到父 trace 上。
  //    要嵌套图应走引擎自己的接口 (有深度/预算/父子 trace), 不是借道命令闸。
  'codegraph', 'semgrep',
  // ⑥ 版本控制 —— 仅只读子命令 (见 GIT_READONLY_SUBCOMMANDS)
  'git',
  // ⑦ 回显 (探针 / 占位输出)
  'echo',
];

/**
 * 允许的 git 子命令 (只读)。放行 bin 'git' 不等于放行改仓库状态 ——
 * `git checkout .` 抹掉 DAG 刚写的文件、`git commit`/`git add` 越权代 owner 提交, 一律拒。
 */
export const GIT_READONLY_SUBCOMMANDS: readonly string[] = [
  'status', 'diff', 'log', 'show', 'ls-files', 'ls-tree', 'rev-parse', 'blame', 'describe', 'shortlog', 'cat-file', 'grep',
];

/**
 * **风险分级** (2026-07-31, R1 · 承 Loop Engineering §9.4)。判据逐字照抄那一条:
 *
 * > 风险等级不是由「这个操作技术上难不难」决定, 而是由「**做错了之后的代价和可逆性**」决定。
 *
 * 为什么值得单立一张表, 而不是继续用白名单的二元判断: 本文件头部第 18-20 行那段「诚实边界」
 * (白名单是护栏不是沙箱; `bun`/`node`/`npx` 在表内就等价于任意代码执行) 说的正是二元判断的
 * 失真处 —— `cat` 与 `bun` 同在名单里、同样"放行", 而两者做错了的代价差着数量级。散文形态的
 * 边界说明没有消费者; 分级有。
 *
 * ⚠ **这是分级, 不是闸**。闸只有一个 (`commandBlockReason`), 分级不参与放行决定 —— R1 刻意
 * 只报不拦 (承自主度阶梯的 report-only 级: 先量真实跑的活里各级占多少, 再谈要不要按级设关卡)。
 * 两者的一致性由 `command-risk-tier.test.ts` 钉住, 而不是靠这里再抄一遍闸的逻辑 (抄一份早晚先漂)。
 */
export type CommandRiskTier =
  /** 读取文件 / 查询 / 检索。可逆性无限。 */
  | 'read_only'
  /** 在契约范围内写 (跑项目自己的代码 → build 产物 / 快照 / 缓存)。git 可回滚。 */
  | 'scoped_write'
  /** 做错了不可撤回 (对外发送 / 删数据 / 装依赖 / 付费 API)。**今天这一级是空的** —— 见下。 */
  | 'approval_required'
  /** 不允许自动执行 (改闸本身 / 改判卷标准 / push / 部署)。 */
  | 'never';

/** 由轻到重 —— 一条 `&&` 链取链上最重的一级。 */
export const RISK_TIER_ORDER: Readonly<Record<CommandRiskTier, number>> = {
  read_only: 0,
  scoped_write: 1,
  approval_required: 2,
  never: 3,
};

/**
 * 每个白名单 bin 的风险级。**加 bin 必须加级**, 否则 `command-risk-tier.test.ts` 红。
 *
 * 登记表当场读出来的一条事实值得记进设计: **`approval_required` 这一级今天一个成员都没有。**
 * 也就是说 omd 现在只有"随便做"和"一律不许"两档, 中间那档 (要问一下才能做) 在执行面**不存在** ——
 * 这正是 §9.7 误区二 (所有工具调用套用同一套权限逻辑) 的样子, 只不过我们是靠不收危险命令
 * 来回避它的。要不要补中间那档, 由 R1 的读数决定, 不在这里预先造一个没有消费者的关卡。
 */
export const COMMAND_RISK_TIER: Readonly<Record<string, CommandRiskTier>> = {
  // ① 构建 / 类型 / 测试闸 —— 跑的是项目自己的代码, 会写 (产物 / 快照 / node_modules 缓存)。
  //    它们同时是"等价于任意代码执行"的那一组, 所以是本表里最重的一档, 而不是因为"跑测试听起来无害"就归只读。
  bun: 'scoped_write',
  node: 'scoped_write',
  tsc: 'scoped_write',
  npx: 'scoped_write',
  // ⑤ 项目自有工具。`omd`/`oh-my-dag` 已从白名单摘除 (它们的风险是**整张图的风险**, 不是一条 CLI 的),
  //    故本表也不再登记 —— 未登记 = `never`, 与闸同向。
  codegraph: 'read_only',
  semgrep: 'read_only',
  // ② 只读检视
  ls: 'read_only', cat: 'read_only', head: 'read_only', tail: 'read_only', wc: 'read_only',
  stat: 'read_only', file: 'read_only', du: 'read_only', pwd: 'read_only', realpath: 'read_only',
  basename: 'read_only', dirname: 'read_only', diff: 'read_only',
  // ③ 搜索
  grep: 'read_only', rg: 'read_only', ugrep: 'read_only', find: 'read_only', bfs: 'read_only', fd: 'read_only',
  // ④ 结构化读取
  jq: 'read_only',
  // ⑥ 版本控制 —— 只读子命令由闸保证 (GIT_READONLY_SUBCOMMANDS), 故这里是 read_only;
  //    写类子命令根本过不了闸, 不需要在本表里再表达一次。
  git: 'read_only',
  // ⑦ 回显
  echo: 'read_only',
};

/**
 * 一条命令串的风险级 = `&&` 链上最重的一级。**未登记的 bin 一律 `never`** —— 与白名单闸同向 fail-closed。
 *
 * 不调 `commandBlockReason`: 那个函数会 `logger.warn`, 而本函数的主要调用方是**事后读数**
 * (读留痕库里已经跑过的命令), 在读数时刷一屏"命令被拒"的告警是纯噪声。一致性走测试不走调用。
 *
 * ⚠ **已知失真: `&&` 拆链不认引号** (2026-07-31 live 实测撞到)。一条
 * `node -e "… a && b …"` 里引号内的 `&&` 会被当成链分隔符, 于是后半截的首 token 不是登记过的
 * bin → 整条被判 `never`, 而它真实的 bin 是 `node` (`scoped_write`)。
 *
 * **为什么不修**: 拆链规则是**跟着闸走的**(`commandBlockReason` 同款), 而闸那边这个"过度拆分"
 * 是安全方向 —— 多拆只会多拒, 不会漏放。在这里另写一套认引号的拆法, 就是本文件反复警告的
 * "抄一份早晚先漂", 而漂的后果比这点读数失真严重得多。
 * 且**这类命令本来就都过不了闸**(引号里带 `&&` 的必然也带 `( ) $` 等元字符), 所以失真只影响
 * 读数板上的归类, 不影响任何放行决定 —— 读数板已用 `[闸已拒]` 标出这一格。
 */
export function commandRiskTier(command: string): CommandRiskTier {
  let worst: CommandRiskTier = 'read_only';
  for (const link of command.split('&&')) {
    const bin = commandBin(link.trim());
    const tier = COMMAND_RISK_TIER[bin] ?? 'never';
    if (RISK_TIER_ORDER[tier] > RISK_TIER_ORDER[worst]) worst = tier;
  }
  return worst;
}

export interface CommandLeafRunnerOpts {
  /** 允许的命令首 token 白名单 (GP-5)。空 = 全拒 (必须显式给, 如 ['codegraph'])。 */
  allowlist: string[];
  /** 超时 ms。默认 60000。 */
  timeoutMs?: number;
  /** cwd。默认 process.cwd()。 */
  cwd?: string;
  /** 注入式 spawn (测试替身)。默认 Bun.spawn 捕获 stdout/stderr/exit。 */
  spawn?: (command: string, cwd: string) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

/**
 * **没有 memo 缓存 —— 这是量出来的决定, 不是遗漏** (2026-08-01)。
 *
 * 这里原本有一个 per-runner 的确定性 memoize (相同命令串直接返上次结果, 只缓存 `exitCode===0`)。
 * 它的安全论证有两环, **两环都是假的**:
 *
 * ① 「新调用 = 新 runner = 新缓存」—— 只在每次现建 runner 的接线点成立。MCP 是长驻进程,
 *    `assemble` 装配期建一次 → 缓存跨了这台 daemon 上的所有 run(live 实测: 两个 runId 之间
 *    改掉盘上文件, 第二跑仍返回旧值)。
 * ② 「单 run 内输入文件不变 → 无 staleness」—— 而这台引擎的本职就是**让 agent 节点改文件**。
 *    live 实测: 同一张图里 `cat f` → agent 写 f → `cat f`(同一命令串)读回的是**写之前**的内容。
 *
 * 收益侧则是空的: 留痕库 `.omd/dag-runs.db` 全量 12 次真实 run / 25 个 command 节点,
 * **同一 run 内重复命令串 = 0** —— 它一次都没有机会命中。而且它连设计时说的主场景都覆盖不了:
 * 「兄弟节点跑同一条命令」是**同层并发**的, 缓存只在命令返回后写入, 两个都 miss。
 * conductor prompt 还反向推着走(「把验证尾巴收成一个 command 节点」), 即不该有重复。
 *
 * 于是: 零命中 × 两条会给出**错误绿灯**的路径。删掉, 不留旋钮 ——
 * 「要么给生产者, 要么删掉, 中间态最坏」。代价是重复命令真的重跑一遍, 而这正是引擎
 * 自己的偏好(`executor-dag` 那条: command 节点刻意不落绿 checkpoint,「重跑一遍比跳过一个闸安全」)。
 * 反向自检见 `command-leaf-cache-scope.test.ts` —— 谁再加缓存, 那几条会红。
 */

const defaultSpawn = async (command: string, cwd: string) => {
  const proc = Bun.spawn(['sh', '-c', command], { cwd, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
};

/** git 的「带值全局 flag」—— 取子命令时必须连它的值一起跳过, 否则 `git -C /repo status` 会把 /repo 当子命令。 */
const GIT_VALUE_FLAGS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env']);

/** 从 git 命令串里定位子命令 (跳过全局 flag 及其值)。找不到 → undefined (裸 git)。 */
function gitSubcommand(link: string): string | undefined {
  const toks = link.trim().split(/\s+/).slice(1);
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]!;
    if (GIT_VALUE_FLAGS.has(t)) {
      i++; // 连值跳过
      continue;
    }
    if (t.startsWith('-')) continue; // 布尔 flag / --foo=bar 形
    return t;
  }
  return undefined;
}

/**
 * **凭证文件路径拒**(2026-07-31)。白名单为什么当初不收 `env`/`printenv`, 原话是
 * 「输出会进模型上下文, 等于把 key 喂出去」—— 而 `cat .env` 从**同一个洞**把**同样的东西**
 * 喂出去, 只是换了个 bin。这条判据此前只落在 bin 上, 没落在它读的东西上, 是个漏项:
 * 本仓根 `.env` 里今天就有 6 个 provider key + 一个 OAuth token, 一条 `cat .env` 就全进 prompt、
 * 进留痕库、再随 trace 进 Langfuse。
 *
 * 判据 = **basename**, 不是全串匹配: 拒的是「这个文件」, 不是「这种写法」, 所以 `./.env`、
 * `../../.env`、`~/.pi/agent/auth.json` 走同一条规则。`.env.example` 一类样例文件显式放行 ——
 * 它们本来就是给人读的, 拒了只会让验证叶白挂。
 *
 * ⚠ **边界诚实**(同本文件头 18-20 行): 这是护栏不是沙箱。`grep -r KEY .` 递归扫到 `.env` 仍会
 * 打印内容, `bun -e` 更是等价任意代码执行 —— 这条闸挡的是「模型顺手 cat 一下配置」这类**手滑**,
 * 不是对抗性外泄。真隔离在 agent leaf 的 bwrap jail。别把它当安全边界宣传。
 */
export const SECRET_BASENAMES: readonly RegExp[] = [
  /^\.env(\..+)?$/, // .env / .env.local / .env.production
  /^(secrets|credentials|auth)\.json$/, // omd 凭证落点 / pi auth.json
  /^\.credentials\.json$/, // claude code
  /^id_(rsa|dsa|ecdsa|ed25519)$/, // ssh 私钥 —— N3 实测那条链的第一环 (钥匙 → NAS → 39 个容器的 root)
  /\.(pem|p12|pfx)$/, // 证书/私钥容器
];
/** 样例/模板不算凭证 —— 它们生来就是给人读的。 */
export const SECRET_BASENAME_EXEMPT = /^\.env\.(example|sample|template)$/;

/** 命令串里若引用了凭证文件, 返回那个 token(供拒因显示); 否则 null。 */
export function secretPathInCommand(command: string): string | null {
  for (const raw of command.trim().split(/\s+/).slice(1)) {
    const token = raw.replace(/^["']|["']$/g, '');
    if (!token || token.startsWith('-')) continue;
    const base = token.slice(token.lastIndexOf('/') + 1);
    if (SECRET_BASENAME_EXEMPT.test(base)) continue;
    if (SECRET_BASENAMES.some((re) => re.test(base))) return token;
  }
  return null;
}

/** 命令首 token (路径取 basename) — 用于白名单匹配。 */
function commandBin(command: string): string {
  const first = command.trim().split(/\s+/)[0] ?? '';
  const slash = first.lastIndexOf('/');
  return slash >= 0 ? first.slice(slash + 1) : first;
}

/**
 * **闸的单一真源** (2026-07-29 抽出): 一条命令串过不过 fail-closed 闸。
 * 过 → null; 不过 → 一行 `[blocked …]` 原因 (直接当 leaf 输出用)。
 *
 * 抽出的理由不是复用好看, 是**别处需要"这条命令跑不跑得起来"这个判断而又不能真跑它** ——
 * D-I 的验收命令要在规划期就判定可跑 (`goal/acceptance.ts`)。判据若各写一份, 早晚一份先漂:
 * 规划期说能跑、执行期被拒 = 「假红」(合法验证步被闸拦下, 看起来像测试失败)。
 *
 * 含 `&&` 链拆分 (2026-07-20 修: 兑现 conductor prompt 契约 "可 && 链验证步, 每环独立过闸")。
 * **全链先过闸再执行**是 fail-closed 的要点: 防"合法头环已执行、恶意尾环才被拒"的部分执行。
 */
export function commandBlockReason(command: string, allowlist: readonly string[]): string | null {
  const links = command.split('&&').map((s) => s.trim());
  if (links.some((l) => !l)) return '[blocked empty link in && chain]';
  for (const link of links) {
    // ① fail-closed: 危险命令拦 (复用 V2-HOOK 闸)。
    const verdict = classifyCommand(link);
    if (verdict.dangerous) {
      logger.warn({ command: link, label: verdict.label }, '[omd/command-leaf] 危险命令拦截 (fail-closed)');
      return `[blocked dangerous: ${verdict.reason ?? verdict.label}]`;
    }
    // ② 白名单 (GP-5): 首 token 必须在 allowlist。
    const bin = commandBin(link);
    if (!allowlist.includes(bin)) {
      logger.warn({ command: link, bin, allowlist }, '[omd/command-leaf] 命令不在白名单, 拒绝');
      return `[blocked not-allowed: '${bin}' ∉ allowlist]`;
    }
    // ②.5 shell 元字符拦 (sec-audit 揪出的 CRITICAL): 白名单只查首 token, 整串喂 sh -c → 经
    // ; | & $() ` 换行 < > () 可在合法 bin 后注入任意命令。拒绝这些元字符 (引号/空格/路径字符仍允许)。
    // && 已在上方拆链 → 环内残留的单 & 仍在此被拒 (背景执行/注入不放行)。
    if (/[;&|`$<>(){}\n\r\\]/.test(link)) {
      logger.warn({ command: link }, '[omd/command-leaf] 命令含 shell 元字符, 拒绝 (防注入)');
      return '[blocked shell-metachar: ; & | ` $ < > ( ) \\ newline not allowed]';
    }
    // ②.6 git 子命令只读闸: bin 在白名单只说明「可以调 git」, 改仓库状态的子命令仍拒
    // (`git checkout .` 会抹掉 DAG 刚写的文件; `git commit` 越权代 owner 提交)。
    if (bin === 'git') {
      const sub = gitSubcommand(link);
      if (!sub || !GIT_READONLY_SUBCOMMANDS.includes(sub)) {
        logger.warn({ command: link, sub }, '[omd/command-leaf] git 子命令非只读, 拒绝');
        return `[blocked git-write: '${sub ?? '(none)'}' ∉ 只读子命令 ${GIT_READONLY_SUBCOMMANDS.join('/')}]`;
      }
    }
    // ③ 凭证文件拒 (见 SECRET_BASENAMES): 白名单管「哪个 bin」, 这条管「读的是什么」。
    //    放行 `cat` 不等于放行 `cat .env` —— 后者与被刻意排除的 `printenv` 是同一件事。
    const secret = secretPathInCommand(link);
    if (secret) {
      logger.warn({ command: link, path: secret }, '[omd/command-leaf] 命令读凭证文件, 拒绝');
      return `[blocked secret-file: '${secret}' 是凭证文件, 读出来会进模型上下文]`;
    }
  }
  return null;
}

/**
 * 造一个确定性命令叶子 runner。每次跑一条命令, fail-closed 闸 + 白名单 + 超时, 捕获 stdout。
 */
export function createCommandLeafRunner(opts: CommandLeafRunnerOpts): CommandLeafRunner {
  const allowlist = opts.allowlist;
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const cwd = opts.cwd ?? process.cwd();
  const spawn = opts.spawn ?? defaultSpawn;

  // **每次调用都真跑** —— 不缓存的判据见上方 CommandLeafRunnerOpts 下的那段注。
  return async ({ command }) => {
    // 先拆后闸: 每环独立 spawn, 无 sh 级注入面 (判据见 commandBlockReason)。
    const blocked = commandBlockReason(command, allowlist);
    if (blocked) return { text: blocked, usage: { in: 0, out: 0 }, exitCode: -1 };
    const links = command.split('&&').map((s) => s.trim());
    // ③ 顺序执行, 首败即停 (shell && 语义); 每环独立超时 (Promise.race: 超时返 exitCode 124, 不悬挂 leaf)。
    const outParts: string[] = [];
    let exitCode = 0;
    for (const link of links) {
      const { stdout, stderr, exitCode: code } = await Promise.race([
        spawn(link, cwd),
        new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve) =>
          setTimeout(() => resolve({ stdout: '', stderr: `[timeout ${timeoutMs}ms]`, exitCode: 124 }), timeoutMs),
        ),
      ]);
      // **两条流都要**, 不是二选一 (2026-08-01, verifier 校准逼出来的)。
      //
      // 原本是 `(stdout || stderr)` —— stdout 非空就把 stderr 整个扔掉。而这条闸最该跑的那个命令
      // 正好踩中: `bun test` 把版本横幅写 stdout、把 **`5 pass / 0 fail` 汇总写 stderr**。
      // 于是一个验证节点的全文输出只有 `bun test v1.3.14`, 通过/失败数**从没进过** DAG、下游、
      // verifier 或留痕库 —— 退出码 0 照给, 一切看起来正常。conductor prompt 偏偏还教它
      // 「把验证尾巴收成一个 `bun run tsc --noEmit && bun test` 节点」, 即最推荐的用法丢得最干净。
      // 失败时更糟: 失败详情也在 stderr, 于是"红了"这件事只剩一个退出码, 说不出红在哪。
      //
      // 怎么发现的: verifier 判一条"真做到了"的 fixture 不过, 判词说「输出只有 planned 日志,
      // 没有测试数量与通过/失败汇总」—— 它是对的, 是台架把证据吃了。**这正是这道闸的用处**。
      const part = [stdout.trim(), stderr.trim()].filter(Boolean).join('\n');
      if (part) outParts.push(part);
      exitCode = code;
      if (exitCode !== 0) break; // && 语义: 前环失败, 后环不跑
    }
    return { text: outParts.join('\n'), usage: { in: 0, out: 0 }, exitCode };
  };
}
