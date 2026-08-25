/**
 * src/harness/repo-checks —— **leaf 级仓规检查清单 runner** (D2 切片 2, #266 修补节点)。
 *
 * ## 为什么是独立件
 *
 * accept 闸的仓规红 (禁词 / 沉默 catch 净增) 是文件级、机械 oracle 可复验的 ≤10 行残缺,
 * 但引擎此前只有「整轮重规划」一条修复路, 确定性重规划按节点目标语义判复用,
 * 仓规红不改目标语义 → 必然空转 (run e7e360f6 第 2 轮 72 秒零修复空转 6/7 复用即实证)。
 *
 * 修补节点 = 跑一次本件, 对该 leaf 的写集跑一遍仓规清单, FAIL → 引擎按既有 L0 重试机制
 * 打回同一 leaf (check 输出进 causeNote, leaf 上下文还热, 当场自修)。
 *
 * ## 设计不变量 (SDD #266 · D2)
 *
 * - **INV-D2-1 (可移植性)**: 引擎侧**一个仓库规则都不许硬编码**。引擎只认「检查清单 +
 *   scope 协议」; 禁词表 / catch 证据纪律属于本仓, 只作为清单内容存在 (本件不 import
 *   `scripts/jargon-scan.ts` / `scripts/catch-evidence-scan.ts`, 也未在引擎源码里写死
 *   这些检查)。本仓的实际清单放在 `src/mcp/assemble.ts` 的装配层, 由仓库侧配置覆盖。
 * - **INV-D2-2 (写权)**: 检查清单 + 本 runner 对 leaf / conductor / verifier 无写权
 *   (同 `post-leaf-gate.ts` 的 `gateWriteAuthority`)。本件只读不写; 写盘归 leaf,
 *   check 脚本自身是仓库资产, 引擎无权碰。
 * - **INV-D2-3 (三态)**: 沿用 `GateVerdict` (OK / FAIL / UNVERIFIED) ——
 *   UNVERIFIED 是 oracle 自身故障 (spawn 抛 / 超时 / 退出码 null), 不许压成 FAIL
 *   (post-leaf-gate.ts 顶注写明的事故教训)。
 * - **INV-D2-4 (fail-open 不吞证据)**: 清单缺席 / 脚本崩 / spawn 抛 → 不拦主流程,
 *   但 logger 留一行 (runId / checkId / 错误原文)。
 * - **INV-D2-5 (scope)**: leaf 级检查只跑该 leaf 的写集文件 (INV-2-1 由调用方传 `files`)。
 *   全仓扫描不属于 leaf 检查 (那是 accept 层已有的事)。
 *
 * ## 与 `post-leaf-gate.ts` 的关系
 *
 * 复用其三态 (`GateVerdict`) 与子进程跑法签名 (`GateSpawn`); 不复用 `evaluatePostLeaf`
 * 因为后者跑的是**脚本路径** (`sh -c '<script>'`), 而仓规清单是**命令串** (含占位符、
 * 管道、shell 重定向) —— 形态不同, 入口各异。两条路共用同一份语义真源, 但**不共用
 * 同一个入口函数** (会双源, 见 `command-leaf-cache-scope.test.ts` 反向自检)。
 */
import { logger } from '../logger';
import type { GateSpawn, GateVerdict } from './post-leaf-gate';

// ── types ────────────────────────────────────────────────────────────────────

/**
 * 一条仓规检查。引擎侧**只认这个形状**, 不认任何仓库特定的键 (INV-D2-1)。
 *
 * - `id`: 引擎账本用的稳定名 (跨 run 可比)。仓规侧负责取唯一 (如 `jargon-scan` /
 *   `catch-evidence-net-add`)。
 * - `command`: shell 命令串, 含 `{files}` 占位符 —— 引擎跑前用 space-separated quoted
 *   路径列表替换; 占位符缺席 = 命令对文件范围不敏感 (例如全仓扫描; 但 INV-D2-5
 *   仍要传该 leaf 的 `files`, 由调用方决定要不要用)。
 */
export interface RepoCheck {
  id: string;
  command: string;
  /**
   * 这条检查红了要不要**杀节点**。缺省 `'blocking'`(零回归: 既有 manifest 没有这个键)。
   *
   * ## 为什么需要这一格(2026-08-26)
   *
   * run 5bcfa2b2 的 s2 被 catch-evidence 判红「净增 17 处」→ 节点 failed →
   * 下游 `requires:'all'` 全部级联 skipped → 片 2 与片 3 的交付全丢。实核: 其中 18 处是
   * **误报**(该闸当时按行号做差集, 文件前部插入 46 行就让后面的既有 catch 整批"变新"),
   * 真问题只有 2 处、五行能修。
   *
   * 根因不在那一个判据, 在**层级错配**: 仓规检查的判据是启发式的(行号 / 词表 / 正则),
   * 却被装在 fail-closed 的位置。本仓四层理念里, 只有①边界配 fail-closed, 而它的判据
   * 必须是确定的; 启发式判据属于③验收, 该阶梯降级。
   *
   * 三态 `OK / FAIL / UNVERIFIED` 里, UNVERIFIED 只覆盖「闸自己崩了」(spawn 抛 / 超时) ——
   * **没有一态表示「闸判错了」**。设计者想到了闸会崩溃, 没想到闸会冤枉人。
   *
   * ## 怎么选
   *
   * - `'advisory'`: 这条检查在 **accept 的全量里另有防线**, leaf 收尾这道只是「早拦」。
   *   红了记 warn + 进结果, **不杀节点**。真问题照样在 accept 全量里红, 只是晚一点被发现;
   *   而误报再也杀不掉整条依赖链。本仓的 jargon-scan(`scanTree` 扫全树)与
   *   catch-evidence(`scanTree('src')` 绊线)都属此类。
   * - `'blocking'`(缺省): 没有全量侧防线的检查, 红了就杀 —— 放过去就真溜了。
   */
  severity?: 'blocking' | 'advisory';
}

/** `runRepoChecks` 的入参。`checks` / `files` 之外都是接线参数。 */
export interface RepoChecksInput {
  /** 检查清单。空数组 → 返回 OK (无检查 = 无红, INV-D2-4 路线)。 */
  checks: readonly RepoCheck[];
  /**
   * 该 leaf 的写集文件 (相对或绝对, 视调用方)。空数组 → 仍跑 (仓规可能不关心文件),
   * 但占位符替换后是空串 (命令可能被 shell 拒, 这本身要按 oracle-fault 处理)。
   */
  files: readonly string[];
  /** 命令执行的工作目录。 */
  cwd: string;
  /** 子进程跑法 (同 `GateSpawn`) —— 测试注入, 生产由 `agent-leaf.ts` 接线层注入。 */
  spawn: GateSpawn;
  /** 单条 check 超时。默认 30_000 (与 `post-leaf-gate.ts` 同)。 */
  timeoutMs?: number;
  /** 时钟注入 (测试断言 `evaluatedAt` 用)。无注入用 Date.now()。 */
  now?: () => Date;
  /** runId / nodeId 仅用于日志 (INV-D2-4 留痕)。 */
  runId?: string;
  nodeId?: string;
}

/** 单条 check 的结果。`verdict` 三态语义同 `GateResult`。 */
export interface RepoCheckOutcome {
  id: string;
  verdict: GateVerdict;
  reason?: string;
  evidence?: string;
  oracleFaults: number;
  evaluatedAt: string;
}

/** `runRepoChecks` 的聚合结果。`verdict` 聚合规则见函数顶部 doc。 */
export interface RepoChecksResult {
  /** 聚合 verdict: 任一 FAIL → FAIL; 任一 UNVERIFIED ∧ 无 FAIL → UNVERIFIED; 全 OK → OK。 */
  verdict: GateVerdict;
  /** 每条 check 的逐项结果 (顺序 = `input.checks` 顺序)。 */
  perCheck: RepoCheckOutcome[];
  /** UNVERIFIED 累计 (= 所有 check 的 oracleFaults 之和); OK / FAIL 必为 0。 */
  oracleFaults: number;
  /** 整体 `evaluatedAt` (最后一条 check 的时刻; 测试断言注入时钟用)。 */
  evaluatedAt: string;
}

const DEFAULT_TIMEOUT_MS = 30_000;

// ── 内部小工具 ────────────────────────────────────────────────────────────────

/**
 * 把文件列表 shell-quote 一下, 路径里带空格 / 引号时不至于炸。
 * 最小实现: 整体空格分隔, 每条路径用单引号包裹, 内部单引号换成 `'\''`。
 * 与 `post-leaf-gate.ts` 的 `shellQuote` 同源 (那件只用于脚本路径, 这件用于文件列表)。
 */
function shellQuoteList(paths: readonly string[]): string {
  return paths
    .map((p) => `'${p.replace(/'/g, `'\\''`)}'`)
    .join(' ');
}

/** 截断证据字符串 —— 防止一个挂死的 oracle 把几百 MB 的部分 stdout 塞进账本。 */
function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…[truncated ${s.length - max} chars]` : `${s}`;
}

// ── 主入口 ────────────────────────────────────────────────────────────────────

/**
 * 主入口。**不抛** —— oracle 自己出问题不该让 leaf 整条线跟着炸, 它该被翻译成 UNVERIFIED
 * 走 L0 重试机制 (与 `post-leaf-gate.ts` 同一条纪律)。
 *
 * 聚合规则:
 *   1. `checks` 空 → 直接返回 OK (INV-D2-1: 无清单 = 无红, 行为与今天完全一致)。
 *   2. 任一 FAIL → 整体 FAIL, 后续 check **仍跑** (各 check 互相独立, 不短路; 短路会让
 *      「首条红掩盖后续红」, 排账时看不出到底几条坏了)。
 *   3. 无 FAIL ∧ 任一 UNVERIFIED → 整体 UNVERIFIED (oracle-fault 路径)。
 *   4. 全 OK → 整体 OK。
 *
 * 失败输出格式 (`formatRepoChecksFailure`) 进 L0 重试的 causeNote (engine.ts 的
 * `causeOf` 拼 prompt), leaf 上下文还热, 当场自修。
 */
export async function runRepoChecks(input: RepoChecksInput): Promise<RepoChecksResult> {
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = input.now ?? (() => new Date());
  const perCheck: RepoCheckOutcome[] = [];
  let oracleFaults = 0;
  let anyFail = false;
  let anyUnverified = false;

  if (input.checks.length === 0) {
    return {
      verdict: 'OK',
      perCheck: [],
      oracleFaults: 0,
      evaluatedAt: now().toISOString(),
    };
  }

  const filesArg = shellQuoteList(input.files);

  for (const check of input.checks) {
    // `{files}` 占位符替换: 命令里没有这个 token → 命令对文件范围不敏感 (例如全仓扫描),
    // 不强制; 但 `input.files` 仍按调用方的清单传 (INV-D2-5: 调用方负责决定要不要用)。
    const cmd = check.command.includes('{files}')
      ? check.command.split('{files}').join(filesArg)
      : check.command;

    let outcome: RepoCheckOutcome;
    try {
      const result = await input.spawn(cmd, input.cwd, timeoutMs);
      if (result.timedOut) {
        oracleFaults++;
        anyUnverified = true;
        // fail-open 不吞证据 (INV-D2-4): 留 runId / checkId / 原文
        logger.warn(
          { runId: input.runId, nodeId: input.nodeId, checkId: check.id, timeoutMs },
          '[repo-checks] check 超时 → UNVERIFIED (oracle-fault)',
        );
        outcome = {
          id: check.id,
          verdict: 'UNVERIFIED',
          reason: 'script_timeout',
          evidence: `repo check exceeded ${timeoutMs}ms; partial stdout=${truncate(result.stdout, 200)}`,
          oracleFaults: 1,
          evaluatedAt: now().toISOString(),
        };
      } else if (result.exitCode !== 0) {
        // advisory 的红**不进** anyFail —— 整体 verdict 不因它变 FAIL, 于是节点不被杀。
        // 它仍如实记成 FAIL 进 perCheck: 降级的是**处置**, 不是判定 (判据一个字没放松)。
        if ((check.severity ?? 'blocking') === 'blocking') anyFail = true;
        outcome = {
          id: check.id,
          verdict: 'FAIL',
          reason: result.exitCode === null ? 'exit_null' : `exit_${result.exitCode}`,
          evidence: (result.stderr || result.stdout).trim() || undefined,
          oracleFaults: 0,
          evaluatedAt: now().toISOString(),
        };
      } else {
        outcome = {
          id: check.id,
          verdict: 'OK',
          reason: 'ok',
          evidence: result.stdout.trim() || undefined,
          oracleFaults: 0,
          evaluatedAt: now().toISOString(),
        };
      }
    } catch (e) {
      oracleFaults++;
      anyUnverified = true;
      // **异常栈原文**: 不 strip 不截断 —— 这就是排账的唯一依据
      const stack = e instanceof Error ? (e.stack ?? e.message) : String(e);
      logger.warn(
        { runId: input.runId, nodeId: input.nodeId, checkId: check.id, err: stack },
        '[repo-checks] check spawn 异常 → UNVERIFIED (oracle-fault)',
      );
      outcome = {
        id: check.id,
        verdict: 'UNVERIFIED',
        reason: 'script_threw',
        evidence: `repo check threw: ${stack}`,
        oracleFaults: 1,
        evaluatedAt: now().toISOString(),
      };
    }
    perCheck.push(outcome);
  }

  // 聚合: FAIL > UNVERIFIED > OK
  let verdict: GateVerdict;
  if (anyFail) verdict = 'FAIL';
  else if (anyUnverified) verdict = 'UNVERIFIED';
  else verdict = 'OK';

  // 顶层聚合也记一行 (与 post-leaf-gate 的 evaluatePostLeaf 同款, 排账可见)
  logger.info(
    {
      runId: input.runId,
      nodeId: input.nodeId,
      verdict,
      checks: input.checks.length,
      failed: perCheck.filter((c) => c.verdict === 'FAIL').length,
      unverified: perCheck.filter((c) => c.verdict === 'UNVERIFIED').length,
      files: input.files.length,
    },
    '[repo-checks] 清单聚合结果',
  );

  return {
    verdict,
    perCheck,
    oracleFaults,
    evaluatedAt: now().toISOString(),
  };
}

// ── 失败输出格式 ──────────────────────────────────────────────────────────────

/**
 * 把 `runRepoChecks` 结果格式化成进 L0 重试 `causeNote` 用的字符串。
 *
 * 形如:
 *
 *   [仓规检查失败: 2/3 红]
 *   - jargon-scan (exit_1):
 *       src/harness/foo.ts:42: ...命中禁词...
 *   - catch-evidence-net-add (exit_1):
 *       src/harness/bar.ts:100: ...
 *   - baz-check: OK
 *
 * OK 的 check 也列 (短, 不带 evidence), 让 leaf 知道「红的是哪几条 / 没红的是什么」。
 * UNVERIFIED 的 check 单独标 `ORACLE-FAULT`, 提示 leaf 不要尝试修复 (修了 oracle 自己会再红)。
 *
 * 只在 verdict === 'FAIL' 时调用; OK / UNVERIFIED 路径由调用方决定是否要输出。
 */
export function formatRepoChecksFailure(result: RepoChecksResult): string {
  if (result.verdict !== 'FAIL') return '';
  const failed = result.perCheck.filter((c) => c.verdict === 'FAIL');
  const unverified = result.perCheck.filter((c) => c.verdict === 'UNVERIFIED');
  const ok = result.perCheck.filter((c) => c.verdict === 'OK');
  const lines: string[] = [];
  lines.push(`[仓规检查失败: ${failed.length}/${result.perCheck.length} 红]`);
  for (const c of failed) {
    lines.push(`- ${c.id} (${c.reason ?? 'exit_unknown'}):`);
    lines.push(`    ${c.evidence ?? '(无 evidence)'}`);
  }
  if (unverified.length > 0) {
    lines.push(`(ORACLE-FAULT: ${unverified.map((c) => c.id).join(', ')} — oracle 自己崩了, 不是你的代码问题, 别尝试修复)`);
  }
  if (ok.length > 0) {
    lines.push(`(通过的 check: ${ok.map((c) => c.id).join(', ')})`);
  }
  return lines.join('\n');
}
