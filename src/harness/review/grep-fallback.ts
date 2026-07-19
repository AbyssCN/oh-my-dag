/**
 * src/harness/review/grep-fallback —— ugrep → grep 兜底扫描的**共享 helper** (verify.ts / omd-debt 同用)。
 *
 * 全程 argv 数组直 spawn, **零 shell**: pattern/roots 不经 sh -c 字符串拼接 →
 * 含空格/引号/`$(…)` 的路径既不会 word-split 也不会命令替换 (注入面归零)。
 * 退出码语义显性: 0=有命中, 1=无命中 (ok, 空文本), 其余=真错误 (ok:false + stderr) —— 不再用
 * nothrow 把"目录不存在"吞成"零命中"。
 */

export interface GrepRun {
  /** stdout (按 maxLines 截断)。无命中 → ''。 */
  text: string;
  /** 扫描本身是否健康 (有/无命中都算 ok; 工具报错/目录不存在 → false)。 */
  ok: boolean;
  /** ok=false 时的 stderr 摘要。 */
  error?: string;
}

export interface GrepFallbackOpts {
  /** ugrep 专属 flags (如 --no-heading)。省略 = grepFlags。 */
  ugrepFlags?: string[];
  /** grep flags (两个工具通用的放这)。 */
  grepFlags?: string[];
  /** 工作目录 (roots 的相对基准)。 */
  cwd?: string;
  /** stdout 行数上限 (防爆 prompt)。省略 = 不截。 */
  maxLines?: number;
}

async function runOne(
  tool: string,
  flags: string[],
  pattern: string,
  roots: string[],
  cwd: string | undefined,
): Promise<{ code: number; out: string; err: string } | null> {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([tool, ...flags, pattern, ...roots], {
      ...(cwd ? { cwd } : {}),
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
  } catch {
    return null; // 工具不存在 (ENOENT) → 调用方换下一个
  }
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout as ReadableStream).text(),
    new Response(proc.stderr as ReadableStream).text(),
    proc.exited,
  ]);
  return { code, out, err };
}

/**
 * ugrep 优先、grep 兜底跑一次递归扫描。pattern/roots 全 argv 传参 (零 shell)。
 * ugrep 不存在 → 静默换 grep; grep 也不存在 → ok:false。
 */
export async function grepWithFallback(
  pattern: string,
  roots: string[],
  opts: GrepFallbackOpts = {},
): Promise<GrepRun> {
  const grepFlags = opts.grepFlags ?? ['-rnE'];
  const attempts: Array<[string, string[]]> = [
    ['ugrep', opts.ugrepFlags ?? grepFlags],
    ['grep', grepFlags],
  ];
  let lastErr = 'ugrep/grep 均不可用';
  for (const [tool, flags] of attempts) {
    const r = await runOne(tool, flags, pattern, roots, opts.cwd);
    if (r === null) continue; // 工具不存在 → 下一个
    if (r.code === 0 || r.code === 1) {
      let text = r.out;
      if (opts.maxLines !== undefined) text = text.split('\n').slice(0, opts.maxLines).join('\n');
      return { text, ok: true };
    }
    lastErr = r.err.trim() || `${tool} exit=${r.code}`;
    // 真错误 (exit>1): ugrep 挂时仍试 grep (兼容 flags 差异), grep 也挂才报。
  }
  return { text: '', ok: false, error: lastErr };
}
