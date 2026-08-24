/**
 * src/harness/session/final-spawn —— omd 会话**收尾存档**的派发(#212)。
 *
 * 退出是一条会话最后一次存档机会,错过就只剩上一次跨档那份。难点是时机:
 *   - 同步等 → 退出要卡几秒(蒸馏要打一次模型),不能接受;
 *   - 进程内 fire-and-forget → 活不过 `process.exit`,等于没存。
 * 所以走 **detached 子进程**,与 Claude Code 那条 hook 同一个办法。
 *
 * 与 hook 那条的差别只有来源参数:这里传 `--omd-session <id>`(从 ChatStore 读条目),
 * 而不是 `--transcript <file>`。蒸馏器仍是同一个。
 *
 * @module
 */
import { spawn } from 'node:child_process';
import { openSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from '../logger';
import { sessionDirOf } from './continuity-hook';
import { sessionsRootFor } from '../chat/session-store';

/** 引擎锚 = 本仓根,**不随 cwd**(TUI 可以在任何 repo 里起)。 */
function engineRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
}

/**
 * 派发参数(纯函数 —— detached 子进程本身测不了,能断言的只有"派了什么")。
 * `OMD_CONTINUITY_MECHANICAL=1` → 追加 `--mechanical`,让端到端闸跑成确定性。
 */
export function finalWriterArgv(sessionId: string, cwd: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const argv = [
    'run',
    join(engineRoot(), 'scripts/session-writer.ts'),
    '--omd-session',
    sessionId,
    '--cwd',
    cwd,
    '--final',
  ];
  if (env.OMD_CONTINUITY_MECHANICAL === '1') argv.push('--mechanical');
  return argv;
}

/**
 * 派一次收尾蒸馏。**全程 fail-open**:派不出去只记一行 warn —— 退出路径上抛异常
 * 会把"退不出去"变成用户可见的故障,而少一份交接只是少一份交接。
 */
export function spawnFinalCheckpoint(sessionId: string, cwd: string, env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    if (!sessionId) return false;
    const contDir = sessionDirOf(sessionId, cwd);
    mkdirSync(contDir, { recursive: true });
    const logFd = openSync(join(contDir, 'writer.log'), 'a');
    spawn('bun', finalWriterArgv(sessionId, cwd, env), {
      cwd,
      detached: true,
      stdio: ['ignore', logFd, logFd],
      // ⚠ 会话根由**父进程**算好传下去。子进程 import script-bootstrap 会把 OMD_DATA_HOME
      // 置成 ~/.omd, 同一个 repoRoot 算出来是另一个目录 —— TUI 的会话它一条都找不到,
      // 而症状只是一句"会话不存在"。这一行就是那条跨进程口径。
      // 取绝对: `sessionsRootFor` 在 OMD_DATA_HOME 下会回一个**相对**路径(`.omd/chat`),
      // 相对路径跨进程传就是按对方 cwd 解 —— 那是另一个目录。
      env: { ...process.env, OMD_CHAT_ROOT: resolve(cwd, sessionsRootFor(cwd)) },
    }).unref();
    return true;
  } catch (err) {
    logger.warn(
      { sessionId, err: err instanceof Error ? err.message : String(err) },
      '[session-continuity] 收尾存档派发失败 (已吞, 不影响退出)',
    );
    return false;
  }
}
