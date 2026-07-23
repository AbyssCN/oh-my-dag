/**
 * sandboxed-leaf —— **subprocess-per-leaf under bwrap** 的父侧 runner (2026-07-23, eval 真隔离)。
 *
 * agent-leaf 的 sandboxRoot 路径委托到这里: 每次 leaf 调用 spawn 一个 `bwrap [binds] bun run leaf-worker.ts`
 * 子进程 (cwd=worktree, 主 repo 物理不可见)。worker 在 jail 内跑 in-process agent-leaf, 结果经 worktree 内
 * 文件回传。这样 pi 的**所有**命令通道 (bash / 模型幻觉的 shell / 未来工具) + `git show` oracle 泄漏被一次性
 * 封死 —— 不逐工具打地鼠 (记忆 dag-engine-write-reliability: 模型用 `shell` 绕过单工具沙箱)。
 */
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { logger } from '../../logger';
import type { AgentLeafInput, AgentLeafResult, AgentLeafRunner } from '../leaf-runners';
import type { AgentLeafRunnerOpts } from '../agent-leaf';
import { bwrapArgs, defaultRoBinds } from './bwrap';

/** worker 在 worktree 内的相对路径 (worktree = HEAD checkout, 含此文件 —— 故改动须提交)。 */
const WORKER_REL = 'src/harness/leaf-worker.ts';

let seq = 0;

/** JSON 安全的 opts 子集 (剔除函数/工具对象/cwd/sandboxRoot —— worker 侧自定或不需)。 */
function serializableOpts(opts: AgentLeafRunnerOpts): Record<string, unknown> {
  const { onEvent: _o, customTools: _c, cwd: _cwd, sandboxRoot: _s, driftDetector, ...rest } = opts;
  // driftDetector 可为对象 (JSON 安全) 或 false; 函数无 → 只在是对象/false 时透传。
  const dd = typeof driftDetector === 'object' || driftDetector === false ? { driftDetector } : {};
  return { ...rest, ...dd };
}

/**
 * 造 subprocess-bwrap 隔离 leaf runner。opts.sandboxRoot 必设 (= worktree 绝对根)。
 * 每次调用 spawn 一次性 bwrap 子进程; leafTimeoutMs 超时杀进程。
 */
export function createSandboxedLeafRunner(opts: AgentLeafRunnerOpts): AgentLeafRunner {
  const root = resolve(opts.sandboxRoot!);
  const roBinds = defaultRoBinds(root);
  const optsJson = serializableOpts(opts);
  const timeoutMs = opts.leafTimeoutMs ?? 240_000;

  return async (input: AgentLeafInput): Promise<AgentLeafResult> => {
    const id = `${process.pid}-${++seq}`;
    const payloadRel = `.omd-leaf-payload-${id}.json`;
    const resultRel = `.omd-leaf-result-${id}.json`;
    const payloadAbs = join(root, payloadRel);
    const resultAbs = join(root, resultRel);
    writeFileSync(payloadAbs, JSON.stringify({ opts: optsJson, input }));

    // bwrap [binds] bun run <worker> <payloadRel> <resultRel> —— 相对路径, cwd=worktree (bwrap --chdir)。
    const argv = ['bwrap', ...bwrapArgs(root, roBinds), 'bun', 'run', WORKER_REL, payloadRel, resultRel];
    const proc = Bun.spawn(argv, { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' });
    // 超时 = leaf 硬上界 + 30s buffer (worker 内部还有自己的 leafTimeoutMs/心跳闸兜底)。
    const killer = setTimeout(() => proc.kill(9), timeoutMs + 30_000);
    let killed = false;
    try {
      const [, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      clearTimeout(killer);
      killed = proc.killed;
      let parsed: { ok: boolean; result?: AgentLeafResult; error?: string } | null = null;
      try {
        parsed = JSON.parse(readFileSync(resultAbs, 'utf8'));
      } catch {
        parsed = null;
      }
      if (parsed?.ok && parsed.result) return parsed.result;
      // worker 没产出结果 (崩溃/超时被杀/bwrap 起不来) → 响亮抛 (executor-dag failedFromThrow 接住,
      // 别静默降级成 empty-done 假成功)。
      const why = parsed?.error ?? (killed ? `子进程超时被杀 (${timeoutMs / 1000}s)` : `bwrap 子进程无结果 (exit ${code})`);
      logger.error({ root, code, killed, stderr: stderr.slice(-600) }, '[omd/sandboxed-leaf] worker 失败');
      throw new Error(`[sandboxed-leaf] ${why} — stderr 尾: ${stderr.slice(-400)}`);
    } finally {
      rmSync(payloadAbs, { force: true });
      rmSync(resultAbs, { force: true });
    }
  };
}
