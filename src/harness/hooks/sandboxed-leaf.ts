/**
 * sandboxed-leaf —— **subprocess-per-leaf under bwrap** 的父侧 runner (2026-07-23, eval 真隔离)。
 *
 * agent-leaf 的 sandboxRoot 路径委托到这里: 每次 leaf 调用 spawn 一个 `bwrap [binds] bun run leaf-worker.ts`
 * 子进程 (cwd=worktree, 主 repo 物理不可见)。worker 在 jail 内跑 in-process agent-leaf, 结果经 worktree 内
 * 文件回传。这样 pi 的**所有**命令通道 (bash / 模型幻觉的 shell / 未来工具) + `git show` oracle 泄漏被一次性
 * 封死 —— 不逐工具打地鼠 (记忆 dag-engine-write-reliability: 模型用 `shell` 绕过单工具沙箱)。
 */
import { existsSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { logger } from '../../logger';
import type { AgentLeafInput, AgentLeafResult, AgentLeafRunner } from '../leaf-runners';
import type { AgentLeafRunnerOpts } from '../agent-leaf';
import type { AnyOmdTool } from '../agent-tools';
import { bwrapArgs, defaultRoBinds, makePiAgentCopy, resolveGitBinds, type GitBinds } from './bwrap';

/** worker 在 worktree 内的相对路径 (eval 档: worktree = omd 自己的 HEAD checkout, 含此文件)。 */
const WORKER_REL = 'src/harness/leaf-worker.ts';

/**
 * **worker 到底从哪儿取** (2026-07-31, 一次 live 撞出来的 P0)。
 *
 * 原设计只有 {@link WORKER_REL} 一条路, 注释写着「worktree = HEAD checkout, 含此文件」——
 * 那句话对 **eval** 成立 (那里的 worktree 就是 omd 自己的 checkout), 但 R2 (D-Y①) 把这个 jail
 * 接到了 `dag_goal` 上, 而那里的 worktree 是**用户仓**的 checkout, 里面根本没有 omd 的源码。
 *
 * 后果不是"少了点隔离", 是**隔离档下 agent leaf 一个都起不来**:
 * `error: Module not found "src/harness/leaf-worker.ts"` × 每个 leaf。
 * 2026-07-31 的 live 上 9 个节点全灭, 产物一份没写 —— 而单元测试与 bwrap 容器性探针**全绿**,
 * 因为它们测的是 jail 关不关得住, 不是 worker 找不找得到。
 * (这是本轮第三次撞见同一形态: **隔离动了, 消费面没跟上**。)
 *
 * 两档分开选, 而不是一律绑 omd 源码进 jail —— 后者会**破坏 eval 的隔离**:
 * eval 要的正是"主 repo 物理不可见"(防 `git show` 当 oracle), 无条件绑回去等于把它拆了。
 *   · worktree 里有 worker → 用它 (eval 档, 零额外挂载, 隔离性质不变)
 *   · 没有 → 把 omd 安装目录**只读**挂进 jail 并用绝对路径 (goal 档: 被隔离的是用户仓,
 *     omd 自己的源码本来就不是被保护的对象)
 */
function resolveWorker(root: string): { argvPath: string; extraRoBinds: string[] } {
  if (existsSync(join(root, WORKER_REL))) return { argvPath: WORKER_REL, extraRoBinds: [] };
  // 从本文件往上找 package.json = omd 安装根 (src/harness/hooks → …/oh-my-dag)。
  let dir = import.meta.dir;
  for (let i = 0; i < 6 && !existsSync(join(dir, 'package.json')); i++) dir = dirname(dir);
  const abs = join(dir, WORKER_REL);
  if (!existsSync(abs)) {
    // fail-closed 且**在造 runner 的时候就响**: 让它到第一个 leaf 才炸, 代价是先烧掉一整轮
    // conductor 规划 (live 上就是这么烧的)。
    throw new Error(
      `[sandboxed-leaf] 找不到 leaf-worker: worktree (${join(root, WORKER_REL)}) 与 omd 安装目录 (${abs}) 都没有。` +
        '隔离档起不来 —— 与其在第一个 leaf 上失败, 不如现在就说。',
    );
  }
  // node_modules 一并挂: goal 档下 worktree 里的是**用户仓的**依赖, worker 要的是 omd 的。
  return { argvPath: abs, extraRoBinds: [dir] };
}

let seq = 0;

/** JSON 安全的 opts 子集 (剔除函数/cwd/sandboxRoot —— worker 侧自定或不需)。customTools 走 D-6 risk-tier 闸:
 *  `sandboxSafe === true` 的 decl 过线 (execute 是函数, JSON.stringify 过线时剥落 → worker 侧重水化成
 *  文件桥代理, 真执行在父进程, 见 serveToolBridge); 未声明/false → 剥除 + warn 列名 (不再静默一刀剥)。
 *  零保留 → 不落 customTools 键 (与零 ext 基线逐字节一致)。 */
export function serializableOpts(opts: AgentLeafRunnerOpts): Record<string, unknown> {
  const { onEvent: _o, cwd: _cwd, sandboxRoot: _s, driftDetector, customTools, ...rest } = opts;
  // driftDetector 可为对象 (JSON 安全) 或 false; 函数无 → 只在是对象/false 时透传。
  const dd = typeof driftDetector === 'object' || driftDetector === false ? { driftDetector } : {};
  const kept = (customTools ?? []).filter((t) => t.sandboxSafe === true);
  const dropped = (customTools ?? []).filter((t) => t.sandboxSafe !== true);
  if (dropped.length > 0) {
    const names = dropped.map((t) => t.name);
    logger.warn({ tools: names }, `[omd/sandboxed-leaf] 非 sandboxSafe 扩展工具不进隔离叶 (已剥除): ${names.join(', ')}`);
  }
  return { ...rest, ...dd, ...(kept.length > 0 ? { customTools: kept } : {}) };
}

/**
 * D-9 工具桥父侧: 轮询 worktree 里的 `${prefix}-req-N.json` (worker 写 tmp+rename, 文件出现即完整),
 * 用**本进程原有 customTools 实例**执行 —— ext 工具的 execute 闭包走的是宿主既有的 host IPC 代理
 * (ext-tools.ts), host 仍按 cwd 跨 run/跨叶共享, 这里与 worker 都不 loadExtension、不新起 host。
 * 结果写 `${prefix}-res-N.json` (同样 tmp+rename)。返回停止函数; 残留桥文件由调用方 finally 清。
 * 轮询而非 fs.watch: 与 payload/result 同一文件通道形态, 50ms 对一次工具调用的延迟预算无感,
 * 也不赌 bwrap jail 内外 inotify 的跨命名空间语义。
 */
function serveToolBridge(root: string, prefix: string, tools: ReadonlyMap<string, AnyOmdTool>): () => void {
  const reqHead = `${prefix}-req-`;
  const timer = setInterval(() => {
    let pending: string[];
    try {
      pending = readdirSync(root).filter((f) => f.startsWith(reqHead) && f.endsWith('.json'));
    } catch {
      return; // root 读不到 → 本 tick 跳过 (下一个 tick 再试; 子进程退出后由 finally 停表)
    }
    for (const f of pending) {
      let req: { name: string; id: string; params: unknown };
      try {
        req = JSON.parse(readFileSync(join(root, f), 'utf8'));
        rmSync(join(root, f), { force: true }); // 先取走: 下一个 tick 不再重复拾取同一请求
      } catch {
        continue; // 已被上一 tick 取走 / 读不到 → 跳过
      }
      void (async () => {
        const n = f.slice(reqHead.length, -'.json'.length);
        const resTmp = join(root, `${prefix}-res-${n}.json.tmp`);
        const resAbs = join(root, `${prefix}-res-${n}.json`);
        let body: string;
        try {
          const tool = tools.get(req.name);
          if (!tool) throw new Error(`父进程没有名为 "${req.name}" 的保留工具 (D-9 闸两侧不一致)`);
          const result = await tool.execute(req.id, req.params);
          body = JSON.stringify({ ok: true, result });
        } catch (err) {
          body = JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) });
        }
        writeFileSync(resTmp, body);
        renameSync(resTmp, resAbs);
      })().catch((err) => logger.warn({ err: (err as Error).message, prefix }, '[omd/sandboxed-leaf] 工具桥写响应失败'));
    }
  }, 50);
  return () => clearInterval(timer);
}

/**
 * 造 subprocess-bwrap 隔离 leaf runner。opts.sandboxRoot 必设 (= worktree 绝对根)。
 * 每次调用 spawn 一次性 bwrap 子进程; leafTimeoutMs 超时杀进程。
 */
export function createSandboxedLeafRunner(opts: AgentLeafRunnerOpts): AgentLeafRunner {
  const root = resolve(opts.sandboxRoot!);
  // 造 runner 的时候就把 worker 找定 —— 找不到当场响, 不留到第一个 leaf (见 resolveWorker)。
  const { argvPath: workerPath, extraRoBinds } = resolveWorker(root);
  const roBinds = [...defaultRoBinds(root), ...extraRoBinds];
  // git 元数据 (opts.sandboxGit 显式要才挂; 见该字段的注 —— eval 档不要, 生产隔离档要)。
  // 解析在**造 runner 的时候**做一次: 每 leaf 一次 `git rev-parse` 是白花的钱, 而这棵树的
  // gitdir 在一个 run 里不会变。要了却解析不出 (root 不是 git 树 / 没有 git) → 响亮说一次:
  // 静默无 git 正是这次要修的那个症状 (叶子自己撞上去, 撞完还不知道为什么)。
  let gitBinds: GitBinds | null = null;
  if (opts.sandboxGit) {
    gitBinds = resolveGitBinds(root);
    if (!gitBinds) logger.warn({ root }, '[omd/sandboxed-leaf] 要求挂 git 元数据但解析不出 (不是 git 树?) — jail 里仍无 git');
  }
  const optsJson = serializableOpts(opts);
  // 与 agent-leaf 的默认同源 (2026-08-01 一起从 240s 提到 1h): 这里若还留 240s,
  // 隔离档的叶子会被父进程在 4.5 分钟处杀掉, 而 in-process 档能跑 1 小时 —— 同一个叶子两个寿命。
  const timeoutMs = opts.leafTimeoutMs ?? 3_600_000;
  // D-9 执行端: 保留的 sandboxSafe 工具在 worker 侧只是 decl (execute 过不了 JSON 边界),
  // 真调用经文件桥回到**这里的原有实例** (与 serializableOpts 同一张 `sandboxSafe === true` 判据)。
  // 零保留工具 → 不开桥、payload 不落 toolBridge 键 —— 与零 ext 基线逐字节一致。
  const bridgeTools = new Map((opts.customTools ?? []).filter((t) => t.sandboxSafe === true).map((t) => [t.name, t] as const));

  return async (input: AgentLeafInput): Promise<AgentLeafResult> => {
    const id = `${process.pid}-${++seq}`;
    const payloadRel = `.omd-leaf-payload-${id}.json`;
    const resultRel = `.omd-leaf-result-${id}.json`;
    const payloadAbs = join(root, payloadRel);
    const resultAbs = join(root, resultRel);
    const bridgePrefix = bridgeTools.size > 0 ? `.omd-leaf-tool-${id}` : null;
    writeFileSync(payloadAbs, JSON.stringify({ opts: optsJson, input, ...(bridgePrefix ? { toolBridge: { prefix: bridgePrefix } } : {}) }));

    // pi agent dir 即弃 rw 副本 (每 leaf 一份, 防并发写共享态; 见 makePiAgentCopy ⚠ OAuth 注)。
    const piAgentCopy = makePiAgentCopy();
    // bwrap [binds] bun run <worker> <payloadRel> <resultRel> —— 相对路径, cwd=worktree (bwrap --chdir)。
    const argv = [
      'bwrap',
      ...bwrapArgs(root, roBinds, { ...(piAgentCopy ? { piAgentCopy } : {}), ...(gitBinds ? { gitBinds } : {}) }),
      'bun',
      'run',
      workerPath,
      payloadRel,
      resultRel,
    ];
    const proc = Bun.spawn(argv, { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' });
    // 桥与进程同寿: spawn 之后才开表 (早开空转), finally 里停 (worker 死了不再喂响应)。
    const stopBridge = bridgePrefix ? serveToolBridge(root, bridgePrefix, bridgeTools) : null;
    // 超时 = leaf 硬上界 + 30s buffer (worker 内部还有自己的 leafTimeoutMs / 进展看门狗兜底)。
    // ⚠ 判据必须是**我们自己那把刀砍没砍**, 不是 `proc.killed` (2026-07-31 live 抓出来的):
    // worker 因 `Module not found` 秒级自己死掉时, 那条错误消息照样播报「子进程超时被杀 (3600s)」——
    // 而两种成因的下一步**相反**: 真超时 → 加时间/换池; 起不来 → 修部署, 加多少时间都没用。
    // 这与本轮 A5 普查治的是同一种病, 只是它藏在一个 fail-open 的错误分支里。
    let timedOut = false;
    const killer = setTimeout(() => {
      timedOut = true;
      proc.kill(9);
    }, timeoutMs + 30_000);
    try {
      const [, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      clearTimeout(killer);
      let parsed: { ok: boolean; result?: AgentLeafResult; error?: string } | null = null;
      try {
        parsed = JSON.parse(readFileSync(resultAbs, 'utf8'));
      } catch {
        parsed = null;
      }
      if (parsed?.ok && parsed.result) return parsed.result;
      // worker 没产出结果 (崩溃/超时被杀/bwrap 起不来) → 响亮抛 (executor-dag failedFromThrow 接住,
      // 别静默降级成 empty-done 假成功)。
      const why =
        parsed?.error ??
        (timedOut
          ? `子进程跑满 ${timeoutMs / 1000}s 被我们杀掉 (真超时 → 加时间/换池)`
          : `子进程自己退了 (exit ${code}, 没跑满超时) — 多半是起不来而不是跑得慢; 加时间没用, 看下面的 stderr`);
      // `why` 必须进日志 (2026-08-11): 此前只记 code/stderr, 于是 worker 侧**自己报的**错误
      // (leaf-worker 恒 `process.exit(0)`, 失败经结果文件的 `{ok:false,error}` 回传) 在日志上
      // 长成一句无解的「worker 失败 code:0」—— 退出码 0 与"判失败"看着矛盾, 其实成因就写在
      // 那个字段里, 只是没被记下来。吞异常不吞证据。
      logger.error({ root, code, timedOut, why, stderr: stderr.slice(-600) }, '[omd/sandboxed-leaf] worker 失败');
      throw new Error(`[sandboxed-leaf] ${why} — stderr 尾: ${stderr.slice(-400)}`);
    } finally {
      stopBridge?.();
      rmSync(payloadAbs, { force: true });
      rmSync(resultAbs, { force: true });
      if (bridgePrefix) {
        for (const f of readdirSync(root).filter((f) => f.startsWith(bridgePrefix))) rmSync(join(root, f), { force: true });
      }
      if (piAgentCopy) rmSync(piAgentCopy, { recursive: true, force: true });
    }
  };
}
