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
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { classifyCommand } from './hooks/dangerous-cmd';
import { awaitDeath, awaitExitBounded, readAllBounded, spawnWithPipes } from './proc/await-exit';
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
  // ① 构建 / 类型 / 测试闸 (bunx 2026-08-09 补: `bun --cwd D x tsc` 形态下 bun 把 x 当
  //    script 名报 "Script not found" —— 正道是直接写 bunx, 死形态由 ②.4 拒得可教)
  'bun', 'node', 'tsc', 'npx', 'bunx',
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
 * **语言包** (D5a, 2026-08-25) —— 给 `allowlistForRoot` 用的扩展表。
 *
 * 加包 = 加 marker 文件 + bins 两条成对加; 加 marker 单独加 bins 不算开包, 改包表必须改在**这里**,
 * 不在别处再抄第二份 (D-3: 编译期闸与运行期闸共用本表的 union, 二表分离必漂)。
 *
 * **探测** = 锚仓根下 `existsSync(marker)`, **零解析、零网络**: monorepo 子目录不在本表视线内
 * (D5a 未决, 待 E2 实测); 同仓多 marker 自动去重并集 (e.g. `pyproject.toml` + `uv.lock` 同在,
 * 不会让 `pytest` 进两次)。
 *
 * **边界**(D-4): 只收验证/构建类只读向 bin —— pip / cargo-install / npm i 这类改环境的命令**不在
 * 本表**, 要装依赖走 agent bash 的黑名单闸那条路, 那里本就允许。危险模式表 / git 只读子命令闸
 * / shell 元字符拦逐字不动, 语言包扩展不松动既有闸。
 */
export type LanguagePack = {
  /** 根下存在的 marker 文件名 —— 命中即启用本包。 */
  readonly marker: string;
  /** 验证/构建类只读向 bin。 */
  readonly bins: readonly string[];
};

export const LANGUAGE_PACKS: readonly LanguagePack[] = [
  // python —— 三 marker 任一即开包 (pyproject.toml 是现代, uv.lock 是 uv 系, requirements.txt 是经典 pip)
  { marker: 'pyproject.toml', bins: ['python3', 'python', 'uv', 'pytest'] },
  { marker: 'uv.lock', bins: ['python3', 'python', 'uv', 'pytest'] },
  { marker: 'requirements.txt', bins: ['python3', 'python', 'uv', 'pytest'] },
  // go —— go.mod 是事实标准; gofmt 与 go 配对
  { marker: 'go.mod', bins: ['go', 'gofmt'] },
  // rust —— Cargo.toml 是事实标准
  { marker: 'Cargo.toml', bins: ['cargo'] },
];

/**
 * **base ∪ 已启用包** —— 给定执行根, 返回该仓的命令白名单 (含 base 全部成员, 顺序与 base 一致;
 * 启用包的 bins 按包声明顺序追加)。
 *
 * 无 marker → 返回 base 的副本 (顺序不变), 与 `DEFAULT_COMMAND_ALLOWLIST` 集合相等 (INV-2,
 * JS 仓逐字节同基线)。每次调用都**新造一份数组** (与 command leaf 那条「无 memo 缓存」同源 ——
 * MCP 长驻, 缓存会跨 run)。返回值可直接交 `createCommandLeafRunner({ allowlist })`, 无需再 `[...arr]`。
 *
 * `root` 与 spawn 时的 `cwd` **必须**一致: 装配期接线见 D-2 (src/mcp/assemble.ts 两处 +
 * src/harness/agent-leaf.ts:2182 的 `createCommandLeafRunner` 调用), 由各调用点把各自的 cwd/root
 * 传进来, 这里不替它猜。
 */
export function allowlistForRoot(root: string): string[] {
  const out: string[] = [...DEFAULT_COMMAND_ALLOWLIST];
  for (const pack of LANGUAGE_PACKS) {
    if (existsSync(join(root, pack.marker))) {
      for (const bin of pack.bins) {
        if (!out.includes(bin)) out.push(bin);
      }
    }
  }
  return out;
}

/**
 * 允许的 git 子命令 (只读)。放行 bin 'git' 不等于放行改仓库状态 ——
 * `git checkout .` 抹掉 DAG 刚写的文件、`git commit`/`git add` 越权代 owner 提交, 一律拒。
 */
export const GIT_READONLY_SUBCOMMANDS: readonly string[] = [
  'status', 'diff', 'log', 'show', 'ls-files', 'ls-tree', 'rev-parse', 'blame', 'describe', 'shortlog', 'cat-file', 'grep',
  // merge-base: 纯只读 (odb 祖先查询)。缺席实测代价 = S5 图 N0a ancestry 硬闸被拦,
  // 白烧一轮 LLM 修复轮 (NOTES 2026-08-10 样本 G, run 96fc81e2)。
  'merge-base',
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
  bunx: 'scoped_write',
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
  /**
   * 注入式 spawn (测试替身)。默认 `defaultSpawn` —— Bun.spawn 捕获 stdout/stderr/exit。
   *
   * `timedOut` / `signal` 是**可选**的 (H5, 2026-08-19): 老替身只返三元组, 缺席时按
   * 「量过且没发生」补 `false` / `null` —— 把它们改成必填会让一批既有替身在类型层红,
   * 而那批测试关心的根本不是子进程记账面。
   */
  spawn?: (
    command: string,
    cwd: string,
    timeoutMs?: number,
  ) => Promise<{ stdout: string; stderr: string; exitCode: number | null; timedOut?: boolean; signal?: string | null }>;
  /**
   * 注入 `Bun.spawn` **本身**(不是整条采集)—— 只给 `defaultSpawn` 用,给了 `spawn` 时它不生效。
   *
   * 两个口子分野明确:`spawn` 换掉"跑一条命令拿三元组"这件事(旧的、给不关心子进程层的测试用);
   * `spawnRaw` 换掉"起子进程"这一步,于是**子进程记账失效的那四张脸能被确定性地注入** ——
   * 它们在真机上是 1/26 的东西,靠跑全量验不了。见 `command-leaf-subproc-faces.test.ts`。
   */
  spawnRaw?: () => BoundedProc;
}

/** `defaultSpawn` 需要的那一小块 `Bun.Subprocess` 面(注入面就是它,不多不少)。 */
type BoundedProc = {
  stdout: ReadableStream<Uint8Array> | undefined;
  stderr: ReadableStream<Uint8Array> | undefined;
  exited: Promise<number>;
  pid: number;
  kill: (sig?: number | NodeJS.Signals) => void;
};

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

/**
 * **三处等待全部有界** (2026-08-14 晚)。此前是裸的 `Bun.spawn` + `new Response(...).text()`
 * + `proc.exited` —— 与当天为测试补界的那个模式**逐字相同**,而生产这一份当天没动。
 *
 * 代价是实测到的:G4 判别力探针走的正是这条路,26 次全量里 1 次 spawn 抛错 →
 * `acceptance-gate.ts:241` catch → `fail_open`,**闸静默失效**。
 * 更坏的一面是挂死那张脸:界不在这里时,外层那道超时哨会把它兑成 `exitCode 124`,
 * 于是一次记账缺陷伪装成"命令超时",在探针里还会被读成"判据有判别力"(假绿)。
 *
 * ⚠ 内层预算 = 外层 `timeoutMs`,而外层哨兵**多给 5s**(见 createCommandLeafRunner)——
 * 两道界撞在同一个时刻会让谁先响成为运气。内层先响才有分辨力:它分得开
 * 「进程还活着 = 真慢」与「进程已经没了 = 退出事件丢了」,而外层只会印一个 124。
 */
/**
 * 命中即摘的凭证键判据 —— **大小写不敏感的子串**, 不是全等表。
 *
 * 为什么是子串: 真实世界的键名是 `AWS_SECRET_ACCESS_KEY` / `GITHUB_TOKEN` / `DATABASE_PASSWORD`
 * 这种复合词, 列全等表等于每来一个 provider 补一次表, 而漏的那次没有任何声音。
 */
const CREDENTIAL_KEY_RE = /(KEY|SECRET|TOKEN|PASSWORD)/i;

/**
 * 选择性摘掉凭证类环境变量, **返副本** (H5-3, 2026-08-19)。
 *
 * 三条边界写死在这里, 因为每一条都是一种"看起来做了"的假实现:
 *  · **选择性**, 不是清空 —— 整个清空会连 `PATH`/`HOME` 一起端走, 于是命令根本跑不起来,
 *    而"跑不起来"和"凭证摘干净了"在读数上长得一样。
 *  · **返副本**, 不许原地删 —— 原地删会把 engine 自己的 `process.env` 一起改掉,
 *    下一个要用 key 的调用点就在别处莫名其妙地失败。
 *  · **只作用于用户命令这一路** —— 不许全局挂钩 `Bun.spawn`。engine 自己起子进程要带全 env。
 */
export function scrubCredentialEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) if (!CREDENTIAL_KEY_RE.test(k)) out[k] = v;
  return out;
}

/** {@link disposeCommandLeafChild} 收的那一小块子进程面 (与 {@link BoundedProc} 同源, 多一个可选的摘听钩子)。 */
export interface CommandLeafChild {
  exited: Promise<number>;
  pid: number;
  kill: (sig?: number | NodeJS.Signals) => void;
  /** 有就调 (Bun.Subprocess 实测**没有**这个; Node 的 ChildProcess 有)。 */
  removeAllListeners?: () => void;
}

/**
 * 把一个命令叶子的子进程**完全停稳**才返回 (H5-2, 2026-08-19)。
 *
 * 协议顺序是判据的一部分:**发信号 → 等真实退出 → 摘监听器 → 才返回**。
 * 少任何一步都会留下同一个外部可观测的中间态:*属主已经回来了, 而进程还标着 running*。
 * 那个中间态最坏的地方不是资源没回收, 是**下一步会照着一个假的"已停"往下走**。
 *
 * 「真实退出」按 `awaitDeath` 的口径 —— 先等记账 (`exited`), 记账丢了就按 pid 直接观测,
 * 必要时内核补刀。**不拿"我发了 SIGTERM"当"它死了"**:那是推断不是观测。
 */
export async function disposeCommandLeafChild(
  child: CommandLeafChild,
  reason: 'timeout' | 'cancel' | 'error',
  opts: { signal?: NodeJS.Signals; graceMs?: number; waitMs?: number } = {},
): Promise<void> {
  const what = `停稳命令叶子子进程 (${reason})`;
  try {
    child.kill(opts.signal ?? 'SIGTERM');
  } catch {
    // 已经死了 / 句柄失效 —— 下面按 pid 实测判, 不靠这一刀的返回值。
    logger.debug({ pid: child.pid, reason }, '[omd/command-leaf] kill 抛了 (多半已退出), 转按 pid 实测');
  }
  // ⚠ 等退出事件的窗口**要短**: `awaitDeath` 是先等事件、超时之后才按 pid 实测。给它 60s 的话,
  // 「pid 早就没了但退出事件永不来」这张脸会让停稳整整卡一分钟 —— 而那件事一秒就能问清楚。
  await awaitDeath(child, what, opts.waitMs ?? 1_000, opts.graceMs ?? 3_000);
  child.removeAllListeners?.(); // 摘听必须在**真死之后**: 早摘等于把退出事件自己丢掉
}

/** 两条等待各自的读预算宽限 (超时那条路 kill 之后还要能把残余读完)。 */
const DRAIN_GRACE_MS = 3_000;
/** kill 之后收残余的短窗口 —— 真进程死了管道立刻 EOF, 这里不该按预算等。 */
const POST_KILL_DRAIN_MS = 500;

const defaultSpawn = async (command: string, cwd: string, timeoutMs = 60_000, spawnRaw?: () => BoundedProc) => {
  const what = `跑命令 \`${command.slice(0, 60)}\``;
  const proc = spawnWithPipes(
    spawnRaw ??
      // ⚠ **必须显式传 env**: bun 1.3.14 实测「不传 env = 子进程 env 为空」(不是继承父进程)。
      // 于是"凭证摘掉了"曾经是白捡的 —— 连 PATH 都没了。现在是选择性 scrub, 见 scrubCredentialEnv。
      (() =>
        Bun.spawn(['sh', '-c', command], {
          cwd,
          stdout: 'pipe',
          stderr: 'pipe',
          env: scrubCredentialEnv(process.env) as Record<string, string>,
        }) as BoundedProc),
    ['stdout', 'stderr'],
    what,
  );
  // 两条等待各自留够宽限 (超时那条路要在 kill 之后还能把残余读完), 超时判据由下面的 race 出。
  let pipesErr: unknown;
  let exitErr: unknown;
  // **退出事件在超时那一刻到没到** —— 这一位是「真超时」与「记账丢了」的分水岭, 见下方 race 后的分派。
  let exitSettled = false;
  const pipesP = readAllBounded([proc.stdout!, proc.stderr!], what, timeoutMs + DRAIN_GRACE_MS).then(
    (v) => v,
    (e: unknown) => {
      pipesErr = e;
      return null;
    },
  );
  const exitP = awaitExitBounded(proc, what, timeoutMs + DRAIN_GRACE_MS).then(
    (v) => {
      exitSettled = true;
      return v;
    },
    (e: unknown) => {
      exitSettled = true;
      exitErr = e;
      return null;
    },
  );
  const TIMEOUT = Symbol('timeout');
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<typeof TIMEOUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMEOUT), timeoutMs);
    (timer as unknown as { unref?: () => void }).unref?.();
  });
  const raced = await Promise.race([Promise.all([pipesP, exitP]), deadline]);
  clearTimeout(timer);

  if (raced === TIMEOUT) {
    // ── 分水岭: **超时那一刻进程退了没有** ────────────────────────────────────────
    // 这两件事的下一步相反, 所以判据必须分得开 (与 await-exit.ts 那条「进程还在 = 正常长跑,
    // 进程没了而事件仍没落定 = 记账丢了」同源):
    //   · 退出事件**早就到了**, 而管道还没 EOF ⇒ 管道被运行时丢了 ⇒ **抛**, 本次读数无效, 重跑;
    //   · 到点了还没退 ⇒ **真超时** ⇒ 停稳它, 如实回报三字段 (不抛 —— 抛了调用方只剩一个异常,
    //     分不出「命令跑太久」与「记账丢了」, 而这正是这道闸要留住的分辨力)。
    if (exitSettled) {
      throw new Error(
        `${what}: 子进程的退出事件已经到了, 而管道 ${timeoutMs}ms 还没到 EOF ⇒ 管道被运行时丢了 (bun ${Bun.version}),` +
          ' 本次读数无效, 重跑。**不是**命令跑太久 —— 别兑成一个退出码。',
      );
    }
    await disposeCommandLeafChild(proc, 'timeout');
    // 进程已经停稳 ⇒ 真管道立刻 EOF, 短窗口就够。**不再等满整个读预算**: 注入的假管道
    // 根本不会 EOF, 那样等于让每条超时用例都替一个已死进程把预算耗光。
    const after = <T>(p: Promise<T>): Promise<T | null> =>
      Promise.race([p, Bun.sleep(POST_KILL_DRAIN_MS).then(() => null)]);
    const [pipes, code] = await Promise.all([after(pipesP), after(exitP)]);
    if (exitErr !== undefined) throw exitErr; // 记账层自己的具名判词优先
    if (!exitSettled) {
      // 停稳之后 (dispose 已按 pid 确认它没了) 退出事件仍然没来 —— 这是记账缺陷的另一张脸,
      // 不是"命令跑太久"。同样响亮抛, 不许编一个退出码替它圆场。
      throw new Error(
        `${what}: 子进程已停稳 (pid ${proc.pid}) 而退出事件始终没来 ⇒ 运行时的子进程记账缺陷` +
          ` (bun ${Bun.version}: 退出事件丢了), 本次读数无效, 重跑。`,
      );
    }
    return {
      stdout: pipes?.[0] ?? '',
      stderr: pipes?.[1] ?? '',
      // `code` 是替身/运行时自己给的退出值, 不是我们编的; 有原生字段时 observeExit 只信原生。
      ...observeExit(proc, code ?? null),
      timedOut: true,
    };
  }
  // 非超时路: 记账层自己出的错照旧响亮抛 (「本次读数无效, 重跑」的判词比编一个退出码有用)。
  if (pipesErr !== undefined) throw pipesErr;
  if (exitErr !== undefined) throw exitErr;
  const [pipes, code] = raced as [string[] | null, number | null];
  // readAllBounded 逐条对应输入流, 两条进两条出; 拿不到就是它抛, 走不到这里。
  return { stdout: pipes![0]!, stderr: pipes![1]!, ...observeExit(proc, code), timedOut: false };
};

/**
 * 从**内核观测**读退出事实, 而不是从 `exited` 折出来的那个数推断 (H5-1)。
 *
 * bun 把信号致死折成 `128+n` 交给 `proc.exited` (SIGTERM → 143), 而 `Bun.Subprocess` 同时提供
 * `exitCode`(信号致死时为 `null`)与 `signalCode`。折出来的 143 会让「死于信号」和「自己退 143」
 * 变成同一个数, 所以**有原生字段就只信原生字段**;注入的替身没有这两个字段时, 才回落到折出来的码
 * (那是替身自己声明的退出值, 不是我们编的)。
 */
function observeExit(proc: BoundedProc, folded: number | null): { exitCode: number | null; signal: string | null } {
  const native = proc as unknown as { exitCode?: number | null; signalCode?: string | null };
  const signal = native.signalCode ?? null;
  if (signal !== null) return { exitCode: null, signal }; // 死于信号 ⇒ 没有主动退出码, 不许折 128+n
  const exitCode = native.exitCode !== undefined ? native.exitCode : folded;
  return { exitCode, signal: null };
}

/** git 的「带值全局 flag」—— 取子命令时必须连它的值一起跳过, 否则 `git -C /repo status` 会把 /repo 当子命令。 */
const GIT_VALUE_FLAGS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env']);

/**
 * **git 写操作闸 (单段版)** —— 一条已拆好的命令链, 是非只读 git 就返判词, 否则 null。
 *
 * ## 为什么是**白名单**而不是黑名单 (#239, 2026-08-23)
 *
 * 实账: run `5ec238df` 的 agent 节点跑 `git checkout HEAD -- <files>` 当 stash 用, 抹掉了
 * 本跑刚写的四个文件的实装, 整跑作废。那条路当时走的是黑名单 (`judgeCommand`), 而黑名单
 * 实测**认识 `reset --hard`, 不认识 `checkout` / `restore`** —— 三者对「抹掉本跑还没提交的
 * 写入」完全等效。黑名单必然如此: 它要穷举危险, 而危险的写法不止一种; 白名单穷举的是
 * **安全**, 而安全的写法是有限的、可枚举的。
 *
 * ⚠ 这个判词是**两条路共用的那一份**: command leaf 的 `commandBlockReason` ②.6 与 agent leaf
 * 的 bash 都返回它逐字相同的串。别在任何一侧另写一句 —— 两份判词必然随时间漂成两个意思
 * (S-39)。回归网见 `git-write-gate.test.ts`。
 */
export function gitWriteBlockReasonForLink(link: string): string | null {
  if (commandBin(link) !== 'git') return null;
  const sub = gitSubcommand(link);
  if (sub && GIT_READONLY_SUBCOMMANDS.includes(sub)) return null;
  return `[blocked git-write: '${sub ?? '(none)'}' ∉ 只读子命令 ${GIT_READONLY_SUBCOMMANDS.join('/')}]`;
}

/**
 * **git 写操作闸 (整串版)** —— 自己按 shell 分隔符拆段, 任一段命中就返判词。
 *
 * command leaf 那条路进闸前命令已经拆过链、且元字符闸保证单链里没有 `; | &`, 所以它用单段版。
 * agent leaf 的 bash **收的是整串**且不过元字符闸 —— `ls && git checkout .` 的首 token 是 `ls`,
 * 只看首 token 就等于没闸。拆法与同文件那道凭证闸逐字相同 (`agent-tools.ts:812` 的 `[;&|]+|\n`):
 * 同一条命令串上两道闸拆法不一致本身就是缺陷。
 */
export function gitWriteBlockReason(command: string): string | null {
  for (const seg of command.split(/[;&|]+|\n/)) {
    const s = seg.trim();
    if (!s) continue;
    const blocked = gitWriteBlockReasonForLink(s);
    if (blocked) return blocked;
  }
  return null;
}

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
    // ②.4 `bun [--cwd D] x …` 死形态拒得可教 (2026-08-09, S2 图 oracle-tsc 实测):
    //    带 --cwd 时 bun 不解析 x 别名, 把 x 当 script 名报 `Script not found "x"` ——
    //    tsc 根本没跑, 节点红却长得像类型错。判词给出改写, 让修复轮能自纠而不是瞎猜。
    if (bin === 'bun') {
      const toks = link.trim().split(/\s+/);
      const xAt = toks[1] === 'x' ? 1 : toks[1] === '--cwd' && toks[3] === 'x' ? 3 : -1;
      if (xAt > 0) {
        logger.warn({ command: link }, '[omd/command-leaf] `bun x` 形态拒绝 (--cwd 下 x 不解析) → 提示改写 bunx');
        return `[blocked bun-x-form: \`bun${xAt === 3 ? ' --cwd …' : ''} x\` 在本引擎不可用 (--cwd 下 bun 把 x 当 script 名) —— 改写为 \`bunx <tool> …\`(bunx 在白名单), 目录定位用工具自带参数 (如 tsc -p <dir>)]`;
      }
    }
    // ②.5 shell 元字符拦 (sec-audit 揪出的 CRITICAL): 白名单只查首 token, 整串喂 sh -c → 经
    // ; | & $() ` 换行 < > () 可在合法 bin 后注入任意命令。拒绝这些元字符 (引号/空格/路径字符仍允许)。
    // && 已在上方拆链 → 环内残留的单 & 仍在此被拒 (背景执行/注入不放行)。
    if (/[;&|`$<>(){}\n\r\\]/.test(link)) {
      logger.warn({ command: link }, '[omd/command-leaf] 命令含 shell 元字符, 拒绝 (防注入)');
      return '[blocked shell-metachar: ; & | ` $ < > ( ) \\ newline not allowed]';
    }
    // ②.6 git 子命令只读闸: bin 在白名单只说明「可以调 git」, 改仓库状态的子命令仍拒。
    // 判据与判词都在 `gitWriteBlockReasonForLink` 里 —— agent leaf 的 bash 调的是同一个导出
    // (#239: 此前那条路走的是黑名单, 认识 `reset --hard` 却不认识 `checkout`/`restore`)。
    const gitBlocked = gitWriteBlockReasonForLink(link);
    if (gitBlocked) {
      logger.warn({ command: link, sub: gitSubcommand(link) }, '[omd/command-leaf] git 子命令非只读, 拒绝');
      return gitBlocked;
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
  const spawn = opts.spawn ?? ((c: string, d: string, t?: number) => defaultSpawn(c, d, t, opts.spawnRaw));

  // **每次调用都真跑** —— 不缓存的判据见上方 CommandLeafRunnerOpts 下的那段注。
  return async ({ command }) => {
    // 先拆后闸: 每环独立 spawn, 无 sh 级注入面 (判据见 commandBlockReason)。
    const blocked = commandBlockReason(command, allowlist);
    // 闸拒: 三字段都是"量过且没发生" —— 没起过进程, 所以没超时也没有信号。
    if (blocked) return { text: blocked, usage: { in: 0, out: 0 }, exitCode: -1, timedOut: false, signal: null };
    const links = command.split('&&').map((s) => s.trim());
    // ③ 顺序执行, 首败即停 (shell && 语义); 每环独立超时 (Promise.race: 超时返 exitCode 124, 不悬挂 leaf)。
    const outParts: string[] = [];
    let exitCode: number | null = 0;
    // 三字段互不推断 (H5-1): 各走各的源, 逐环覆盖 —— 最后一环的事实就是这条命令串的事实。
    let timedOut = false;
    let signal: string | null = null;
    for (const link of links) {
      // ⚠ 哨兵**比内层界晚 5s**(2026-08-14 晚)。此前两者同为 timeoutMs, 而 `defaultSpawn` 内层
      //   分得开「进程还活着 = 真慢」与「进程已经没了 = 退出事件丢了」, 外层只会印一个 124。
      //   同一时刻起跑的两道界谁先响是运气 —— 让有分辨力的那道先响。
      //   哨兵留着不是冗余: 注入进来的 `opts.spawn` 是外部代码, 它挂住时只有这道拦得住。
      const {
        stdout,
        stderr,
        exitCode: code,
        timedOut: linkTimedOut,
        signal: linkSignal,
      } = await Promise.race([
        spawn(link, cwd, timeoutMs),
        new Promise<{ stdout: string; stderr: string; exitCode: number | null; timedOut?: boolean; signal?: string | null }>((resolve) => {
          const id = setTimeout(
            // 124 是**这道哨兵自己的**记号 (注入的 spawn 挂住了), 不是子进程的退出码 ——
            // 所以 timedOut 由这里如实置 true, 而不是让下游从 124 反推。
            () => resolve({ stdout: '', stderr: `[timeout ${timeoutMs}ms]`, exitCode: 124, timedOut: true, signal: null }),
            timeoutMs + 5_000,
          );
          (id as unknown as { unref?: () => void }).unref?.();
        }),
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
      // 老替身只返三元组 → 缺席按「量过且没发生」补, 不留 undefined (缺席≠false 那条口径)。
      timedOut = linkTimedOut ?? false;
      signal = linkSignal ?? null;
      if (exitCode !== 0) break; // && 语义: 前环失败 (含 null = 死于信号), 后环不跑
    }
    return { text: outParts.join('\n'), usage: { in: 0, out: 0 }, exitCode, timedOut, signal };
  };
}
