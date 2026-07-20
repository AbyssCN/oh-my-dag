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
 *  ① classifyCommand 拦危险命令 (rm -rf / git force / DROP …, 复用 V2-HOOK 闸)。
 *  ② allowlist 命令首 token 白名单 (空白名单 = 全拒, 必须显式给如 ['codegraph'])。
 *  ③ 超时 kill。
 */
import { classifyCommand } from './hooks/dangerous-cmd';
import { logger } from '../logger';
import type { ModelUsage } from '../model/types';

// 类型单一真理源 = leaf-runners.ts (executor-dag 只认接口形状, 不 import 实现) — 这里 re-export 保旧调用面。
export type { CommandLeafInput, CommandLeafResult, CommandLeafRunner } from './leaf-runners';
import type { CommandLeafInput, CommandLeafResult, CommandLeafRunner } from './leaf-runners';

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

  /** 单环三闸 (fail-closed): 危险命令 / 白名单 / shell 元字符。过闸返 null, 拒返 blocked 结果。 */
  const gateLink = (link: string): CommandLeafResult | null => {
    // ① fail-closed: 危险命令拦 (复用 V2-HOOK 闸)。
    const verdict = classifyCommand(link);
    if (verdict.dangerous) {
      logger.warn({ command: link, label: verdict.label }, '[omd/command-leaf] 危险命令拦截 (fail-closed)');
      return { text: `[blocked dangerous: ${verdict.reason ?? verdict.label}]`, usage: { in: 0, out: 0 }, exitCode: -1 };
    }
    // ② 白名单 (GP-5): 首 token 必须在 allowlist。
    const bin = commandBin(link);
    if (!allowlist.includes(bin)) {
      logger.warn({ command: link, bin, allowlist }, '[omd/command-leaf] 命令不在白名单, 拒绝');
      return { text: `[blocked not-allowed: '${bin}' ∉ allowlist]`, usage: { in: 0, out: 0 }, exitCode: -1 };
    }
    // ②.5 shell 元字符拦 (sec-audit 揪出的 CRITICAL): 白名单只查首 token, 整串喂 sh -c → 经
    // ; | & $() ` 换行 < > () 可在合法 bin 后注入任意命令。拒绝这些元字符 (引号/空格/路径字符仍允许)。
    // && 已在上游拆链 → 环内残留的单 & 仍在此被拒 (背景执行/注入不放行)。
    if (/[;&|`$<>(){}\n\r\\]/.test(link)) {
      logger.warn({ command: link }, '[omd/command-leaf] 命令含 shell 元字符, 拒绝 (防注入)');
      return { text: '[blocked shell-metachar: ; & | ` $ < > ( ) \\ newline not allowed]', usage: { in: 0, out: 0 }, exitCode: -1 };
    }
    return null;
  };

  return async ({ command }) => {
    // memoize 命中 (确定性只读命令 → 同 run 内同命令同输出)。键 = 原始整串。
    if (cache?.has(command)) return cache.get(command)!;
    // && 链拆分 (2026-07-20 修: 兑现 conductor prompt 契约 "可 && 链验证步, 每环独立过闸" — 此前
    // 无拆链实现, 含 && 的命令被元字符闸整串误杀)。先拆后闸: 每环独立 spawn, 无 sh 级注入面。
    const links = command.split('&&').map((s) => s.trim());
    if (links.some((l) => !l)) {
      return { text: '[blocked empty link in && chain]', usage: { in: 0, out: 0 }, exitCode: -1 };
    }
    // 全链先过闸再执行 (fail-closed: 任一环非法 → 整链不跑, 防"合法头环已执行、恶意尾环才被拒"的部分执行)。
    for (const link of links) {
      const blocked = gateLink(link);
      if (blocked) return blocked;
    }
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
