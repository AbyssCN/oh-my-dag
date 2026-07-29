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
  // ⑤ 项目自有确定性工具
  'codegraph', 'semgrep', 'omd', 'oh-my-dag',
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

export interface CommandLeafRunnerOpts {
  /** 允许的命令首 token 白名单 (GP-5)。空 = 全拒 (必须显式给, 如 ['codegraph'])。 */
  allowlist: string[];
  /** 超时 ms。默认 60000。 */
  timeoutMs?: number;
  /** cwd。默认 process.cwd()。 */
  cwd?: string;
  /** 注入式 spawn (测试替身)。默认 Bun.spawn 捕获 stdout/stderr/exit。 */
  spawn?: (command: string, cwd: string) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
  /**
   * per-runner 确定性 memoize: 同一 runner 生命周期内 (一次 DAG run / 一次 cg-audit) 相同命令直接返缓存,
   * 不重跑 CLI (省 wall-clock + CPU; 零 LLM 不变)。**安全 scope**: command-leaf 只读 (无写), 单 run 内
   * 输入文件不变 → 无 staleness; 新调用 = 新 runner = 新缓存。只缓存 exitCode===0 (失败重试)。默认 true。
   */
  memoize?: boolean;
}

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
  // per-runner 确定性 memoize (默认开)。键 = 命令串 (cwd 在 runner 内固定)。
  const memoize = opts.memoize !== false;
  const cache = memoize ? new Map<string, CommandLeafResult>() : null;

  return async ({ command }) => {
    // memoize 命中 (确定性只读命令 → 同 run 内同命令同输出)。键 = 原始整串。
    if (cache?.has(command)) return cache.get(command)!;
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
      const part = (stdout || stderr).trim();
      if (part) outParts.push(part);
      exitCode = code;
      if (exitCode !== 0) break; // && 语义: 前环失败, 后环不跑
    }
    const result: CommandLeafResult = { text: outParts.join('\n'), usage: { in: 0, out: 0 }, exitCode };
    // 只缓存成功 (exitCode 0); 失败/超时不缓存 (下次重试)。block 路径在上方已 return, 不入此。
    if (cache && exitCode === 0) cache.set(command, result);
    return result;
  };
}
