/**
 * src/wright/mcp/sandbox —— ctx_execute 子进程沙箱 (Contract D74 轴 B, MR-INV-8)。
 *
 * 模型写代码 → Bun.spawn 隔离子进程跑 → **只 stdout 进 context** (大数据嚼完只回结果)。
 * 沙箱 = 子进程边界 (非 isolated-vm; 单人信任模型够)。runner 注入 → 纯逻辑可测不 spawn。
 */

export type ExecLang = 'ts' | 'js' | 'py';

export interface ExecOutcome {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type ExecRunner = (code: string, lang: ExecLang, signal?: AbortSignal) => Promise<ExecOutcome>;

/** 默认: bun -e (ts/js) / python3 -c (py)。code 作单 argv, 无 shell 转义。 */
export function defaultExecRunner(): ExecRunner {
  return async (code, lang, signal) => {
    const cmd = lang === 'py' ? ['python3', '-c', code] : ['bun', '-e', code];
    const proc = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'pipe', signal });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    return { stdout, stderr, exitCode };
  };
}

/** 跑代码, 返 stdout (失败 → 含 stderr 的错误文本)。 */
export async function ctxExecute(
  code: string,
  lang: ExecLang,
  opts: { runner?: ExecRunner; signal?: AbortSignal } = {},
): Promise<string> {
  const runner = opts.runner ?? defaultExecRunner();
  const r = await runner(code, lang, opts.signal);
  if (r.exitCode !== 0) {
    return `[exit ${r.exitCode}]\n${r.stderr.slice(0, 2000) || r.stdout.slice(0, 2000)}`;
  }
  return r.stdout;
}
