/**
 * src/harness/board/dag-run-board —— 把 `dag_run` 接进 run-board(2026-08-12)。
 *
 * ## 为什么需要它
 *
 * run-board 与点火预检硬闸(S1/S2)**只挂在 goal 一条路上**:实核 `appendBoard` 的生产
 * 调用点两个,全在 `src/harness/goal/**`;`ignitionPreflight` 的消费点一个,
 * `src/mcp/tools/goal.ts`(= `dag_goal`)。`dag_run` 路径 `dag-tools.ts` 0 处、
 * `dag-exec.ts` 0 处 —— **结构上够不着那道闸**。
 *
 * 2026-08-12 一天的账(六个 run 全走 `dag_run`,board 上零留痕):
 * - 两次**重复派工**:同一份任务书被派了两遍(`e2fe57a2` / `bd728c39`),都跑到实施期才被人眼发现;
 * - 一次**真写集撞车**:两个 run 同改 `src/harness/agent-leaf.ts`;
 * - 一次**跨 run 毒闸**:一个 run 的 `green-gate` 跑 `tsc` 时撞上另一个 run 半成品的
 *   编译错而失败,继而触发整轮重规划 —— 红灯指的是别人的文件。
 *
 * 三件事都在盘上有闸可拦,而闸看不见它们。
 *
 * ## 与 goal 路径的分野:写集是**未声明**,不是**空**
 *
 * goal 路点火时手上有 SDD 分解表,写集是并集,是**事实**。`dag_run` 的任务是自由文本,
 * 起跑那一刻**没有任何声明**。于是本模块 claim 时**不写 `writeSet` 字段**,而不是写 `[]` ——
 * 「没声明」与「声明了不碰任何文件」是两件事(本仓 NULL ≠ 0 ≠ 不适用):
 * 后者可以断言无冲突,前者只能说**判不了**。
 *
 * ⚠ `liveRuns()`(S1 冻结接口)对缺席的 writeSet 做 `?? []`,在那一层两者已经压平。
 * 所以三态判断做在**本模块**读原始 entry,不改 S1。
 *
 * ## 只报不拦(第一刀)
 *
 * 本模块不拒任何点火。理由:`dag_run` 没有写集声明面,拦的判据不成立;而且一道刚上线、
 * 判据还没量过的硬闸会先误伤再被绕过。先把事实印出来,拦不拦下一刀再说。
 *
 * @module
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { appendBoard, readBoard, type BoardEntry } from './run-board';
import { notifyOwner } from '../notify';
import { logger } from '../logger';

/** 一个板上活着的 run 在**本模块**眼里的样子(比 liveRuns 多一位:写集到底声明没)。 */
export interface LiveRunView {
  runId: string;
  /** `undefined` = **未声明**(判不了交集);`[]` = 声明了空集(可断言无冲突)。 */
  writeSet: string[] | undefined;
  /** claim 时随手记的一句任务摘要 —— 「在跑的是什么」是重复派工的唯一可读线索。 */
  goalHint?: string;
}

/** claim 行里放任务摘要的前缀(读回时按它取)。 */
const GOAL_NOTE_PREFIX = 'goal: ';

/** 任务摘要截断长度。长了会把 board 撑成日志,而它是协调介质不是真源。 */
const GOAL_HINT_MAX = 120;

/**
 * 起跑登记。**刻意不写 `writeSet`** —— 见模块头注:`dag_run` 起跑时没有声明面,
 * 写 `[]` 会把「判不了」伪装成「无冲突」。
 *
 * 同一 runId 重复 claim 是安全的(S1: 后写者覆盖先写者)—— 分离进程会经 `resume`
 * 再入一次同一个 handler,不去重反而省一个状态位。
 */
export function claimDagRun(root: string, runId: string, goal: string): void {
  const hint = goal.replace(/\s+/g, ' ').trim().slice(0, GOAL_HINT_MAX);
  appendBoard(root, {
    v: 1,
    ts: new Date().toISOString(),
    runId,
    event: 'claimed',
    ...(hint ? { note: `${GOAL_NOTE_PREFIX}${hint}` } : {}),
  });
}

/** 终态登记。不写这一行,这个 run 会在板上**永远活着**,把后来的每一次起跑都报成冲突。 */
export function terminalDagRun(root: string, runId: string, outcome: string): void {
  appendBoard(root, { v: 1, ts: new Date().toISOString(), runId, event: 'terminal', outcome });
  // F1 (片 2, INV-6 / INV-9): 终态发生 → 推一次 owner 通知。**在板写之后** (板是事实层,
  // 通知是告知层)。wrap try/catch 在这一层兜底 (notifyOwner 自身只吞 spawn 同步抛错, 上层
  // payload 构造 / reader 抛错它管不着 —— 我们也不让它管, INV-9: 接线位不伤主流程)。
  // 证据行: notifyOwner 已为 spawn 异常留一行 warn; 这里的兜底 catch 是双保险, debug 而非 warn
  // (生产里这一层基本不会触发, 不刷屏)。
  try {
    notifyOwner(
      { event: 'terminal', runId, at: new Date().toISOString(), outcome, headline: outcome },
      { readConfigText: () => readNotifyConfigText(root) },
    );
  } catch (err) {
    console.error(`[dag-run-board] terminal 通知抛错 (不影响 run): ${String(err)}`);
  }
}

/**
 * F1 (片 2, 接线位): notify 配置的本地读法 —— `<root>/.omd/config.json`, 缺席 / IO 错 → null
 * (notify.ts readNotifyConfig 把它转成静默 no-op, INV-1)。与 run-goal.ts 同名函数**逐字节一致**:
 * 两通道共用同一份 owner 意图 (主仓层面的 .omd/config.json)。
 */
function readNotifyConfigText(root: string): string | null {
  try {
    const p = join(root, '.omd', 'config.json');
    if (!existsSync(p)) return null;
    return readFileSync(p, 'utf8');
  } catch (err) {
    // exists 过了 read 还抛 = 竞态/权限/IO; 吞掉就再也分不清「真缺席」与「读挂了」(§静默坑 2)。
    logger.warn({ err: String(err) }, '[dag-run-board] 读 notify config 失败 → 按未配处理');
    return null;
  }
}

/**
 * 板上除 `selfRunId` 之外还活着的 run。**读原始 entry**,保住「未声明 vs 空集」那一位。
 *
 * 与 `liveRuns()` 同一条判据(claimed 且无对应 terminal),刻意不复用它 ——
 * 复用就会在 `?? []` 那一步把三态压成两态,而这一位正是本模块存在的理由。
 * 判据本身**不重写第二份**:两处都是「claimed ∧ ¬terminal」,改判据要两处同步,
 * 这条同步义务写在这里(本仓 S-7:同一条规则散在多处,漏掉第三处)。
 */
export function otherLiveRuns(entries: readonly BoardEntry[], selfRunId: string): LiveRunView[] {
  const terminal = new Set(entries.filter((e) => e.event === 'terminal').map((e) => e.runId));
  const byId = new Map<string, LiveRunView>();
  for (const e of entries) {
    if (e.event !== 'claimed' || terminal.has(e.runId) || e.runId === selfRunId) continue;
    // 后写者覆盖先写者 —— 与 liveRuns 同惯例
    byId.set(e.runId, {
      runId: e.runId,
      writeSet: e.writeSet,
      ...(e.note?.startsWith(GOAL_NOTE_PREFIX) ? { goalHint: e.note.slice(GOAL_NOTE_PREFIX.length) } : {}),
    });
  }
  return [...byId.values()];
}

/**
 * 起跑回执里那两行。**没有活 run 就整段缺席**(事件不是分格 —— 同 `replan` 那条口径)。
 *
 * 写集那一位按三态念,不许把「判不了」念成「无冲突」:
 * - 对方声明了写集 → 说得出交集,或说得出「无交集」;
 * - 对方未声明 → 只能说「写集未声明,交集判不了」。
 */
export function renderLiveRunsNotice(live: readonly LiveRunView[], myWriteSet?: readonly string[]): string[] {
  if (live.length === 0) return [];
  const out: string[] = [`⚠ 板上另有 ${live.length} 个 run 在跑 —— 它们与本 run 共用同一棵工作树:`];
  for (const r of live) {
    const who = `  ${r.runId.slice(0, 8)}${r.goalHint ? ` — ${r.goalHint}` : ''}`;
    if (r.writeSet === undefined) {
      out.push(`${who}\n    写集未声明 → 交集**判不了**(不是「无交集」)`);
      continue;
    }
    if (myWriteSet === undefined) {
      out.push(`${who}\n    对方写集 ${r.writeSet.join('、') || '(空)'};本 run 未声明 → 交集判不了`);
      continue;
    }
    const mine = new Set(myWriteSet);
    const overlap = r.writeSet.filter((f) => mine.has(f));
    out.push(overlap.length ? `${who}\n    ⚠ 写集交集: ${overlap.join('、')}` : `${who}\n    写集无交集`);
  }
  out.push('  (只报不拦 —— 撞车的代价见 dag-run-board.ts 头注的三条实账)');
  return out;
}

/** 便利读法:直接从盘上读板并渲染。读不到板 → 空(fail-open:协调面挂了不许拦住起跑)。 */
export function liveRunsNotice(root: string, selfRunId: string, myWriteSet?: readonly string[]): string[] {
  try {
    return renderLiveRunsNotice(otherLiveRuns(readBoard(root), selfRunId), myWriteSet);
  } catch {
    return [];
  }
}
