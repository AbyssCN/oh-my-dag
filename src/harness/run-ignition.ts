/**
 * **点火入参留档 + 续跑恢复**(2026-08-23,owner 现场报「resume 不继承参数」)。
 *
 * ## 它填的是哪个洞
 *
 * `resume` 只带 runId,其余入参由**本次调用**提供。调用方漏传一个,引擎就按缺省值跑 ——
 * 而缺省值和首跑那次未必是一回事。现场:首跑传了 `branchStrategy:'branch'`,resume 没传,
 * 落回 `head` 把这一轮的写打进主工作树(那一格已由 `run-worktree.ts` 按盘上有没有树判死,
 * **不在本模块管辖**;本模块管的是**别的**入参)。
 *
 * ## 为什么分两类,而不是「全部恢复」
 *
 * 有些参数**定义这个 run 是什么**(照哪份契约跑、什么档、在哪棵仓)——
 * 中途换掉,续跑就不是同一个 run 了,恢复它们是对的。
 *
 * 另一些参数**本来就是每次调用的旋钮**,`solve` 的 schema 自己写着
 * 「Stop opening new inner-loop rounds after this many cumulative tokens
 * (soft stop; **resume with a bigger budget**)」—— **加预算续跑正是 resume 的用法**。
 * 把它们也「恢复」成首跑的值,等于把 resume 变成没用的东西。
 *
 * ⇒ 判据不是「能不能恢复」,是「**改了它还是不是同一个 run**」。
 *
 * ## 诚实边界
 *
 * - **留档失败不挡点火**(fail-open):它是便利,不是正确性前提。但**每个 catch 留一行证据**。
 * - **档案缺席 ≠ 首跑没传**:老 run(本模块之前的)盘上没有档案,那时恢复不了 ——
 *   这两件事必须分得开,所以 {@link loadIgnitionArgs} 缺席返回 `null` 而不是 `{}`。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from './logger';

/** 哪个工具点的火。留档是工具无关的,但恢复集按工具分。 */
export type IgnitionTool = 'dag_goal' | 'dag_run';

/** 一次点火的入参留档。 */
export interface IgnitionRecord {
  tool: IgnitionTool;
  runId: string;
  /** 点火时刻(epoch ms)—— 排查「档案是哪一次点火留的」用。 */
  at: number;
  /** 入参原样(只留下面 RECOVERABLE 里那些;别的不留,免得档案变成第二份真相)。 */
  args: Record<string, unknown>;
}

/**
 * **可恢复集** —— 改了它「还是不是同一个 run」答否的那些。
 *
 * ⚠ 刻意**不含** `maxRounds` / `budgetTokens` / `budgetMinutes`:
 * 加预算 / 加轮数续跑是 resume 的正当用法,恢复它们会把 resume 变成空操作。
 * ⚠ 刻意**不含** `branchStrategy`:那一格由 `run-worktree.ts` 按**盘上有没有那棵树**判,
 * 比读档案准(档案可能缺席,而树在不在是事实)。两处各判一次会漂 —— 只留那一处。
 * ⚠ 刻意**不含** `detached` / `resultOut` / `force` / `slug`:每次调用的意图,不是 run 的属性。
 */
export const RECOVERABLE: Readonly<Record<IgnitionTool, readonly string[]>> = {
  dag_goal: ['sddPath', 'tier', 'researchRounds', 'cwd'],
  dag_run: ['conductorModel', 'leafModel', 'maxFanout'],
};

const recordPath = (cwd: string, runId: string): string =>
  join(cwd, '.omd', 'continuity', runId.replace(/[^\w.-]/g, '_'), 'ignition.json');

/**
 * 点火时留档。**只留可恢复集里那几位**,别的一律不写 ——
 * 档案存多了就成了第二份真相,而两份真相必漂(本仓反复付账的形态)。
 *
 * fail-open:写不进去不挡点火,但留一行证据(仓规 §静默坑 2)。
 */
export function saveIgnitionArgs(
  cwd: string,
  runId: string,
  tool: IgnitionTool,
  args: Record<string, unknown>,
  opts: { ifAbsent?: boolean } = {},
): void {
  try {
    // ⚠ **首写者赢, 不按「是不是 resume」判** (2026-08-23 第一版就是这么写错的):
    //   `scripts/goal-worker.ts:51` 是 `resume: opt('run-id') ?? ''` —— detached 的**首跑**
    //   在 worker 里也以 resume 身份回调 handler(那注释写得很清楚: 「首次跑也走 resume 这个
    //   参数名, 它是工具面上唯一能『用调用方给的 runId 起一个 run』的」)。把留档挂在
    //   「非 resume」分支上, 在 detached 路上**永远不触发** —— 而 detached 正是要治的那条路。
    //   判据换成「盘上有没有档案」: 有就不覆盖(真续跑不许把首跑的值改掉), 没有就写。
    if (opts.ifAbsent && existsSync(recordPath(cwd, runId))) return;
    const keep: Record<string, unknown> = {};
    for (const k of RECOVERABLE[tool]) {
      if (args[k] !== undefined) keep[k] = args[k];
    }
    const p = recordPath(cwd, runId);
    mkdirSync(join(p, '..'), { recursive: true });
    const rec: IgnitionRecord = { tool, runId, at: Date.now(), args: keep };
    writeFileSync(p, JSON.stringify(rec, null, 1), { mode: 0o600 });
  } catch (e) {
    logger.warn(
      { runId, tool, err: e instanceof Error ? e.message : String(e) },
      '[omd/run-ignition] 点火入参留档失败 (fail-open, 续跑将恢复不了入参)',
    );
  }
}

/**
 * 读回档案。**缺席返回 `null`,不是 `{}`** —— 「没档案」与「档案里那几位首跑就没传」
 * 是两件事(仓规 §静默坑 1),调用方要分得开才说得出该不该警告。
 */
export function loadIgnitionArgs(cwd: string, runId: string): IgnitionRecord | null {
  const p = recordPath(cwd, runId);
  if (!existsSync(p)) return null;
  try {
    const j = JSON.parse(readFileSync(p, 'utf8')) as IgnitionRecord;
    return j && typeof j === 'object' && j.args && typeof j.args === 'object' ? j : null;
  } catch (e) {
    logger.warn(
      { runId, path: p, err: e instanceof Error ? e.message : String(e) },
      '[omd/run-ignition] 点火档案解析失败 (fail-open, 按没有档案处理)',
    );
    return null;
  }
}

/**
 * 续跑入参解析(**纯函数**,不读盘 —— 于是判别力可注入验)。
 *
 * 规则一句话:**本次调用给了就用本次的;没给才从档案取**。
 * 本次显式给的值**永远优先** —— 续跑时改契约路径是合法操作(修 SDD 后 resume 是 O-6 的
 * 正当用法),档案不许把它盖回去。
 *
 * @returns `merged` 合并后的入参;`recovered` 这次从档案取回来的键(**给调用方打判词用** ——
 *          恢复了却不说,就是又一处「机制在、生产读不出来」)。
 */
export function resolveResumeArgs(
  tool: IgnitionTool,
  current: Record<string, unknown>,
  saved: IgnitionRecord | null,
): { merged: Record<string, unknown>; recovered: string[] } {
  const merged = { ...current };
  const recovered: string[] = [];
  if (!saved || saved.tool !== tool) return { merged, recovered };
  for (const k of RECOVERABLE[tool]) {
    if (current[k] === undefined && saved.args[k] !== undefined) {
      merged[k] = saved.args[k];
      recovered.push(k);
    }
  }
  return { merged, recovered };
}
