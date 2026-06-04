/**
 * src/valar/command-leaf —— 双模 leaf 之外的**第三类: 确定性命令叶子**(the owner 锁方案 A)。
 *
 * inproc leaf = 单发 callModel(LLM, 生成/判断)。
 * agent  leaf = 带工具子 agent(LLM, 改文件)。
 * command leaf = **这里** —— 直接跑一条 CLI(`codegraph trace X Y` / 扫描器…)**零 LLM** 捕获 stdout。
 *
 * 给"方法论 + 一堆确定性工具"型能力(codegraph / piolium)用: conductor 选命令 → 并行命令叶子干 →
 * 只 conductor + synthesis 烧 LLM。比 agent leaf 包 LLM 跑命令便宜得多, 且确定性可缓存友好。
 *
 * 安全 (GP-5 fail-closed, 因命令串来自 conductor 模型, 不可信):
 *  ① classifyCommand 拦危险命令 (rm -rf / git force / DROP …, 复用 V2-HOOK 闸)。
 *  ② allowlist 命令首 token 白名单 (空白名单 = 全拒, 必须显式给如 ['codegraph'])。
 *  ③ 超时 kill。
 */
import { classifyCommand } from './hooks/dangerous-cmd';
import { logger } from '../logger';
import type { ModelUsage } from '../model/types';

export interface CommandLeafInput {
  /** 要跑的 CLI 命令串 (conductor 产出, 经闸+白名单校验)。 */
  command: string;
}
export interface CommandLeafResult {
  text: string;
  usage: ModelUsage;
  exitCode: number;
}
/** 注入点: executor-dag 的 command-kind 节点经此跑(默认 createCommandLeafRunner; 测试传 fake)。 */
export type CommandLeafRunner = (input: CommandLeafInput) => Promise<CommandLeafResult>;

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

/** 命令首 token (路径取 basename) — 用于白名单匹配。 */
function commandBin(command: string): string {
  const first = command.trim().split(/\s+/)[0] ?? '';
  const slash = first.lastIndexOf('/');
  return slash >= 0 ? first.slice(slash + 1) : first;
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
    // memoize 命中 (确定性只读命令 → 同 run 内同命令同输出)。
    if (cache?.has(command)) return cache.get(command)!;
    // ① fail-closed: 危险命令拦 (复用 V2-HOOK 闸)。
    const verdict = classifyCommand(command);
    if (verdict.dangerous) {
      logger.warn({ command, label: verdict.label }, '[valar/command-leaf] 危险命令拦截 (fail-closed)');
      return { text: `[blocked dangerous: ${verdict.reason ?? verdict.label}]`, usage: { in: 0, out: 0 }, exitCode: -1 };
    }
    // ② 白名单 (GP-5): 首 token 必须在 allowlist。
    const bin = commandBin(command);
    if (!allowlist.includes(bin)) {
      logger.warn({ command, bin, allowlist }, '[valar/command-leaf] 命令不在白名单, 拒绝');
      return { text: `[blocked not-allowed: '${bin}' ∉ allowlist]`, usage: { in: 0, out: 0 }, exitCode: -1 };
    }
    // ②.5 shell 元字符拦 (sec-audit 揪出的 CRITICAL): 白名单只查首 token, 整串喂 sh -c → 经
    // ; | & $() ` 换行 < > () 可在合法 bin 后注入任意命令。拒绝这些元字符 (引号/空格/路径字符仍允许)。
    if (/[;&|`$<>(){}\n\r\\]/.test(command)) {
      logger.warn({ command }, '[valar/command-leaf] 命令含 shell 元字符, 拒绝 (防注入)');
      return { text: '[blocked shell-metachar: ; & | ` $ < > ( ) \\ newline not allowed]', usage: { in: 0, out: 0 }, exitCode: -1 };
    }
    // ③ 跑 + 超时 (Promise.race: 超时返 exitCode 124, 不悬挂 leaf)。
    const { stdout, stderr, exitCode } = await Promise.race([
      spawn(command, cwd),
      new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve) =>
        setTimeout(() => resolve({ stdout: '', stderr: `[timeout ${timeoutMs}ms]`, exitCode: 124 }), timeoutMs),
      ),
    ]);
    const result: CommandLeafResult = { text: (stdout || stderr).trim(), usage: { in: 0, out: 0 }, exitCode };
    // 只缓存成功 (exitCode 0); 失败/超时不缓存 (下次重试)。block 路径在上方已 return, 不入此。
    if (cache && exitCode === 0) cache.set(command, result);
    return result;
  };
}
