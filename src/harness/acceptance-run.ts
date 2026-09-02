/**
 * harness/acceptance-run —— **`run_acceptance` 工具的执行体**(P3 S2, 2026-09-02)。
 *
 * leaf 手里没有验收命令的参数: 引擎冻结哪一条, 这里就跑哪一条(D-6 / INV-10)。leaf 唯一能做的
 * 是「现在跑一次」。这条路存在的理由, 是 batch-7 里 leaf 自己敲的 `pytest` 变体与冻结判据对不上,
 * 引擎记录里没有「跑过验收」这件事, 尾块里的「测试通过」只能靠猜。工具化之后:
 *   · 命令原文 = `self_check.command`, 模型改不了一个字;
 *   · 引擎按调用记 `acceptance_ran`, 报告闸(S3)拿它与尾块对账;
 *   · exit 2/4/5 的判读复用 P2b 的**谓词**(bare 整仓 pytest 才算 harness 没跑起来, D-11),
 *     其余一律 `exit !== expect_exit ⇒ red` —— 带路径的 pytest exit 2 是真红, 不是「没跑起来」。
 *
 * 闸链与 self_check 探针同源: `commandBlockReason` + 调用方给的白名单(INV-2-2);沙箱在场时命令串
 * 过 `withPipefail(sandboxCommand(cmd, {root}))`, 与同一叶子的交互 bash 走**同一条物理边界**(INV-17)。
 *
 * 证伪方式(acceptance-run.test.ts): 把 `isBareWholeSuitePytest(...) &&` 那半拿掉, 「带路径 pytest +
 * exit 2 → red」当场变 inconclusive(假绿通道打开)即红; 把 sandboxCommand 包裹摘掉, INV-17 那格即红。
 */
import type { SelfCheckSpec } from './conductor-plan';
import { commandBlockReason } from './command-leaf';
import { extractFailSet } from './goal/accept-delta';
import { isBareWholeSuitePytest, PYTEST_HARNESS_INCONCLUSIVE_EXITS } from './goal/acceptance-gate';
import { sandboxCommand } from './hooks/shell-sandbox';
import { withPipefail } from './agent-tools';
import { logger } from '../logger';

/** 输出尾部保留字节(与 self_check 探针的截断口径同级, 够看到 pytest 的 summary 行)。 */
export const ACCEPTANCE_TAIL_BYTES = 4000;

/** 失败集前后对比。`baseline` 缺席时整个 delta **缺席**, 不写两个空数组冒充「零变化」。 */
export interface AcceptanceDelta {
  /** 本次红、基线不红 —— 本次改动引入的失败。 */
  readonly new: readonly string[];
  /** 基线红、本次不红 —— 本次改动修掉的失败。 */
  readonly fixed: readonly string[];
}

export type AcceptanceOutcome =
  | {
      /** 闸拒: 命令没跑。`reason` 是闸的原话(危险 / 元字符 / 首词不在白名单 / git 写子命令)。 */
      kind: 'blocked';
      command: string;
      reason: string;
    }
  | {
      kind: 'exited';
      /**
       * `green` = 退出码等于期望;`inconclusive` = bare 整仓 pytest 且退出码 ∈ {2,4,5}(harness 没跑起来,
       * 不是代码被判否);`red` = 其余一切不等。三格互斥, 判据在 {@link judgeAcceptanceExit}。
       */
      verdict: 'green' | 'red' | 'inconclusive';
      command: string;
      /** 实际交给 shell 的命令串(沙箱在场时含 bwrap 包裹)—— INV-17 的可证伪面。 */
      ran: string;
      exitCode: number | null;
      expectExit: number;
      /** stdout+stderr 的尾部(≤ {@link ACCEPTANCE_TAIL_BYTES})。 */
      tail: string;
      /** 本次输出里提取到的 `(fail)` 名字集(bun test 口径;pytest 输出提不到时为空数组)。 */
      failSet: readonly string[];
      /** 有基线才有 delta;缺席 = 第一次跑, 没得比。 */
      delta?: AcceptanceDelta;
      /** `inconclusive` 时的一句人话。 */
      why?: string;
    };

export interface AcceptanceRunOpts {
  cwd: string;
  /** 首词白名单(与 self_check 探针同源: `runtimeAllowlistForRoot(cwd)`)。 */
  allowlist: readonly string[];
  /** 与交互 bash 同一份 `opts.sandbox`;缺席 = 不包(DAG-leaf 路径的真隔离在进程级 bwrap)。 */
  sandbox?: { root: string; writable?: readonly string[] };
  /** 上一次的失败集;缺席 = 无基线, delta 缺席。 */
  baseline?: readonly string[] | null;
  timeoutMs?: number;
  /** 测试注入的 spawn;缺省走 command-leaf 的真 runner(与 self_check 探针同一条派生口径)。 */
  spawn?: (command: string, cwd: string, timeoutMs: number) => Promise<{ stdout: string; stderr: string; exitCode: number | null; signal: string | null }>;
}

/** 三格判读的纯函数(单测面)。 */
export function judgeAcceptanceExit(command: string, exitCode: number | null, expectExit: number): 'green' | 'red' | 'inconclusive' {
  if (exitCode === expectExit) return 'green';
  if (exitCode !== null && isBareWholeSuitePytest(command) && PYTEST_HARNESS_INCONCLUSIVE_EXITS.has(exitCode)) return 'inconclusive';
  return 'red';
}

async function defaultSpawn(command: string, cwd: string, timeoutMs: number): Promise<{ stdout: string; stderr: string; exitCode: number | null; signal: string | null }> {
  const proc = Bun.spawn(['bash', '-c', command], { cwd, stdout: 'pipe', stderr: 'pipe' });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { stdout, stderr, exitCode: proc.signalCode ? null : exitCode, signal: proc.signalCode ?? null };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 跑一次冻结判据。不抛: 闸拒与信号死都落成结构化结果, 调用方(工具面)按 kind 组织回话。
 */
export async function runAcceptance(spec: SelfCheckSpec, opts: AcceptanceRunOpts): Promise<AcceptanceOutcome> {
  const command = spec.command;
  const blocked = commandBlockReason(command, opts.allowlist);
  if (blocked) {
    logger.warn({ command, reason: blocked }, '[acceptance-run] 冻结判据被命令闸拒 → blocked (命令没跑)');
    return { kind: 'blocked', command, reason: blocked };
  }
  // INV-17: 与交互 bash 同一条物理边界 —— 同一份 sandbox, 同一个包裹函数, 同一个 pipefail 前缀。
  const ran = withPipefail(
    opts.sandbox
      ? sandboxCommand(command, { root: opts.sandbox.root, ...(opts.sandbox.writable ? { extraWritable: opts.sandbox.writable } : {}) })
      : command,
  );
  const spawn = opts.spawn ?? defaultSpawn;
  const { stdout, stderr, exitCode, signal } = await spawn(ran, opts.cwd, opts.timeoutMs ?? 180_000);
  const expectExit = spec.expect_exit ?? 0;
  // 信号死折成 null(与 self_check 探针 / commandRunner 同口径: 「没拿到主动退出码」)。
  const exit = signal !== null ? null : exitCode;
  const verdict = judgeAcceptanceExit(command, exit, expectExit);
  const text = `${stdout}${stderr ? `\n${stderr}` : ''}`;
  const tail = text.length > ACCEPTANCE_TAIL_BYTES ? text.slice(-ACCEPTANCE_TAIL_BYTES) : text;
  const failSet = extractFailSet(text);
  const delta: AcceptanceDelta | undefined =
    opts.baseline != null
      ? {
          new: failSet.filter((f) => !opts.baseline!.includes(f)),
          fixed: opts.baseline.filter((f) => !failSet.includes(f)),
        }
      : undefined;
  const out: AcceptanceOutcome = {
    kind: 'exited',
    verdict,
    command,
    ran,
    exitCode: exit,
    expectExit,
    tail,
    failSet,
    ...(delta ? { delta } : {}),
    ...(verdict === 'inconclusive'
      ? { why: `bare 整仓 pytest 退出码 ${exit} ∈ {2,4,5}: 测试框架没跑起来 (收集错 / 用法错 / 零收集), 不是代码被判红` }
      : {}),
  };
  logger.info({ command, verdict, exitCode: exit, expectExit, fails: failSet.length, ...(delta ? { new: delta.new.length, fixed: delta.fixed.length } : {}) }, '[acceptance-run] 冻结判据跑完');
  return out;
}

/** 给模型看的回话(工具结果正文)。判词先行, 尾部输出在后。 */
export function renderAcceptanceOutcome(o: AcceptanceOutcome): string {
  if (o.kind === 'blocked') return `[acceptance BLOCKED] 冻结判据被命令闸拒, 命令没跑: ${o.reason}\n命令: ${o.command}`;
  const head =
    o.verdict === 'green'
      ? `[acceptance GREEN] exit ${o.exitCode} (期望 ${o.expectExit})`
      : o.verdict === 'inconclusive'
        ? `[acceptance INCONCLUSIVE] exit ${o.exitCode} (期望 ${o.expectExit}) —— ${o.why}`
        : `[acceptance RED] exit ${o.exitCode ?? '(信号死)'} (期望 ${o.expectExit})`;
  const delta = o.delta ? `\n新增失败 ${o.delta.new.length} · 修掉 ${o.delta.fixed.length}${o.delta.new.length ? `\n新增: ${o.delta.new.slice(0, 10).join(', ')}` : ''}` : '';
  return `${head}\n命令: ${o.command}${delta}\n--- 输出尾部 ---\n${o.tail}`;
}
