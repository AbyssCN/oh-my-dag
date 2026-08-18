/**
 * src/mcp/seat-self-report.ts — worker 座位自报 (v1 schema).
 *
 * 职责:
 *   - worker 在执行完成后把自己的**实解坐标**写盘 (actualModel/actualSeatLabel),
 *     server 的内存态 (`serverSeatMemory`) 只是缓存, 不是真身 —— drift 时以自报为准。
 *   - `renderSeatLine` 拿这份自报渲染一行, 缺失 → UNCONFIRMED, 绝不打印 server 内存态坐标
 *     (那是漂移源: 见 seat-drift.test.ts 子闸 1 的证伪)。
 *
 * 设计边界:
 *   - **不 import 任何现有座位解析模块** —— 这份自报是真相来源, 而其它模块正是
 *     漂移怀疑的对象, 让它们互引等于锁死同一个 bug。
 *   - 原子写: tmp + rename, 失败打印 `[seat] seat-self-report-write-failed ...` 带原文, **不静默吞**。
 *   - 读侧: 缺失/损坏/v≠1/runId 不匹配 → null, **不抛** —— 调用方据此走 UNCONFIRMED 分支。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { logger } from '../logger';

/** 自报 schema 标识字面量; read 侧以此判版, 不匹配 → null。 */
export const SEAT_SELF_REPORT_SCHEMA = 'oh-my-dag.seat-self-report.v1' as const;

/** 自报 schema 版本; read 侧以此判版, 不匹配 → null。 */
export const SEAT_SELF_REPORT_VERSION = 1 as const;

/**
 * worker 座位自报载荷 (worker 实际跑出来的坐标, 不是 server 派活时声明的)。
 *
 * `actualSeatLabel: null` 是合法值 (worker 拿不到 label 但能确认 model); 不与
 * "字段缺失"混为一谈 —— read 侧判存在以**字段是否在 JSON 里**为准, 见 `readSeatSelfReport`。
 */
export interface SeatSelfReport {
  readonly v: 1;
  readonly schema: 'oh-my-dag.seat-self-report.v1';
  readonly runId: string;
  readonly seatId: string;
  readonly actualModel: string;
  readonly actualSeatLabel: string | null;
  readonly reportedAt: string;
  readonly source: string;
}

/** seat-self-report.json 在 run 目录里的文件名。 */
const FILE_NAME = 'seat-self-report.json';

/**
 * 自报盘的绝对路径。`runDir` 通常是 `<cwd>/.omd/runs/<runId>`, 调用方负责传进来
 * —— 这模块**不**单方面决定 run 根目录位置, 那是 harness 的事。
 */
export function seatSelfReportPath(runDir: string): string {
  return join(runDir, FILE_NAME);
}

/**
 * 写自报 (原子: tmp → rename)。失败 → 打印 `[seat] seat-self-report-write-failed ...`
 * 带错误原文, **不静默吞** —— 自报写不进去至少要让人知道 (与 run-registry.persist 同一条规矩)。
 *
 * `runDir` 不存在 → 顺手 mkdirSync({recursive:true})。这是单文件落点, 不是新的目录约定。
 */
export function writeSeatSelfReport(
  runDir: string,
  payload: SeatSelfReport,
): void {
  const target = seatSelfReportPath(runDir);
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  try {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
    renameSync(tmp, target);
  } catch (e) {
    const reason = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    // 写失败绝不带走过 —— 自报本身就是"漂移防线", 写不进去就在日志里亮明。
    logger.error(
      { runId: payload.runId, seatId: payload.seatId, path: target, err: reason },
      '[seat] seat-self-report-write-failed',
    );
  }
}

/**
 * 读自报。判坏 4 条 (任一命中 → null):
 *   1. 文件缺失 (未自报过) —— 正常分支, 不算错。
 *   2. JSON 解析失败 —— 损坏; 不抛, 留给调用方走 UNCONFIRMED。
 *   3. `v !== 1` —— 旧版/新版混盘。
 *   4. `runId` 与预期不符 —— 这是别人 run 的自报被错位读到。
 *
 * **不抛** —— render 路径要把异常态当"无自报"处理, 抛了就逼调用方到处包 try。
 */
export function readSeatSelfReport(runDir: string, expectedRunId: string): SeatSelfReport | null {
  const path = seatSelfReportPath(runDir);
  if (!existsSync(path)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (o.v !== SEAT_SELF_REPORT_VERSION) return null;
  if (o.schema !== SEAT_SELF_REPORT_SCHEMA) return null;
  if (typeof o.runId !== 'string' || o.runId !== expectedRunId) return null;
  if (typeof o.seatId !== 'string') return null;
  if (typeof o.actualModel !== 'string') return null;
  // actualSeatLabel: null 是合法值, 不是缺失。其它类型 → null。
  if (o.actualSeatLabel !== null && typeof o.actualSeatLabel !== 'string') return null;
  if (typeof o.reportedAt !== 'string') return null;
  if (typeof o.source !== 'string') return null;
  return {
    v: 1,
    schema: SEAT_SELF_REPORT_SCHEMA,
    runId: o.runId,
    seatId: o.seatId,
    actualModel: o.actualModel,
    actualSeatLabel: o.actualSeatLabel,
    reportedAt: o.reportedAt,
    source: o.source,
  };
}

/**
 * 渲染一行 seat 坐标摘要。
 *
 * **依赖注入** (readSelfReport / getServerSeatMemory 都不在这里拿), 这样:
 *   - 单测可以塞 `readSelfReport = () => null` 证伪"无自报时拿 server 内存态顶"那种漂移;
 *   - 生产侧由 caller (server 渲染层) 自己接线, 这层永远只读自报, 绝不查 server 内存态坐标。
 *
 * 输出契约:
 *   - 无自报 → `[seat] UNCONFIRMED: worker未自报实解坐标(server内存态非真身, 以worker自报为准)`。
 *     绝不拼入 `getServerSeatMemory()` 的值 —— 那是漂移源, 一旦印出来就跟自报分不清真假。
 *   - 有自报 → `[seat] CONFIRMED worker自报: seatId=... actualModel=<...> actualSeatLabel=<...|null>`
 */
export interface RenderSeatLineDeps {
  readSelfReport: () => SeatSelfReport | null;
  /** 调用方在自报缺失时本该备用的内存态坐标。本模块故意不读它的返回值。 */
  getServerSeatMemory: () => string;
}

export function renderSeatLine(deps: RenderSeatLineDeps): string {
  const report = deps.readSelfReport();
  if (!report) {
    // ⚠ 故意不调用 deps.getServerSeatMemory() —— 它的值不进字符串。详见 seat-drift.test.ts
    // 子闸 1: 写了这一行, 子闸 1 的 `not.toContain('xiaomi mimo')` 立刻红。
    return '[seat] UNCONFIRMED: worker未自报实解坐标(server内存态非真身, 以worker自报为准)';
  }
  const label = report.actualSeatLabel ?? 'null';
  return `[seat] CONFIRMED worker自报: seatId=${report.seatId} actualModel=${report.actualModel} actualSeatLabel=${label}`;
}