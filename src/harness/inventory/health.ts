/**
 * src/harness/inventory/health —— inventory 健康探针 (D1 / 片 1, C-1)。
 *
 * 契约来源 (C-1, 见执行契约 D1):
 *   - INV-1: probeEntry 纯模块, deps 注入, 零真网络零真磁盘。
 *   - INV-2: PROBE_STATES / APPLICABILITIES 具名常数 (枚举与断言共用同一份)。
 *   - INV-3: isExcluded 判据: 仅 PROBED_FAIL ∧ APPLICABLE 真, 其余 11 组合全假。
 *   - INV-4: recordProbeChange: 与上次同状态不写; 不同才追加。fail-open 但
 *            catch 留 console.error 证据 (静默坑 2: fail-open 可吞异常, 不许吞证据)。
 *   - INV-5: 本模块不 import bandit / dream / model-router 任何一个 (I-11 探测隔离)。
 *
 * 与 inventory.ts / resolve.ts 的关系: 本模块**不依赖**那两个模块, 也不反向依赖。
 * 装配期由 conductor 调 probeEntry → 拿 ProbeHealth 写回 entry 的 health 字段;
 * resolve 走的是 entry 上已写好的 health.* 字段, 不经本模块。
 */
import { appendFileSync, readFileSync, existsSync } from 'node:fs';

// ─── I-11 probe 源标签 (S2 后半, C-2 / INV-10) ───────────────────────────────
//
// 探测记录 = probe usage 段的来源。所有信用写入面 (`applyToolCredit` /
// `applyPlanCredit` / `applyLeafCredit` / `recordReward` / dream extract·merge) 以
// `rejectIfProbe` 在源头拒收。本模块不 import `../dag/credit` —— INV-5 (I-11 隔离) 要求
// health 模块零依赖 bandit / dream / model-router; probe source 字面量在本件内**复刻**,
// 不引入新耦合。⚠ 字面量漂移会让拒收静默失效 (probe 记录改名为其他字串 → 闸空转) ——
// 由 `credit-isolation.test.ts` 的「rejectIfProbe 字面量与 health 注释一致」检查钉死。
export const PROBE_SOURCE_TAG = 'probe' as const;
export type ProbeSourceTagLocal = typeof PROBE_SOURCE_TAG;

// ─── 枚举常数 (INV-2) ─────────────────────────────────────────────────────────

/** 探测状态 (D-3):
 *   - UNPROBED    = 没探过 (缺席态, 不是失败);
 *   - PROBED_OK   = 探过且可用;
 *   - PROBED_FAIL = 探过且**确定不可用** (402/401/坐标解析不出);
 *   - PROBE_ERROR = **探本身没跑成** (超时/网络断) — 探不出来 ≠ 探出来是坏的。 */
export const PROBE_STATES = [
  'UNPROBED',
  'PROBED_OK',
  'PROBED_FAIL',
  'PROBE_ERROR',
] as const;
export type ProbeState = (typeof PROBE_STATES)[number];

/** 适用性 (D-3): 决定该 entry 要不要走 callTool。 */
export const APPLICABILITIES = [
  'APPLICABLE',
  'NOT_APPLICABLE',
  'UNKNOWN',
] as const;
export type Applicability = (typeof APPLICABILITIES)[number];

export const UNPROBED: ProbeState = 'UNPROBED';
export const PROBED_OK: ProbeState = 'PROBED_OK';
export const PROBED_FAIL: ProbeState = 'PROBED_FAIL';
export const PROBE_ERROR: ProbeState = 'PROBE_ERROR';

export const APPLICABLE: Applicability = 'APPLICABLE';
export const NOT_APPLICABLE: Applicability = 'NOT_APPLICABLE';
export const UNKNOWN: Applicability = 'UNKNOWN';

// ─── 类型 ────────────────────────────────────────────────────────────────────

/** deps.callTool 返值。**不**用抛错区分 (那是 caller 的错);
 *  抛错 = 探针基础设施问题 (超时/网络), 走 PROBE_ERROR 路径。 */
export type ToolProbeResult =
  | { ok: true }
  | { ok: false; reason: string };

/** probeEntry 返值。写入 entry 的 health.* 三字段时直接 spread。 */
export interface ProbeHealth {
  probe_state: ProbeState;
  applicability: Applicability;
  failure_reason?: string;
}

/** 注入依赖 (INV-1 + INV-4)。
 *  全部 optional: 不传则走缺省启发 / node:fs。
 *  测试可整组注入, 实现零真副作用。 */
export interface ProbeDeps {
  /** 真探针调用。**应不抛**; 抛了 → PROBE_ERROR (D-3 区分)。 */
  callTool: (entry: { id: string }) => ToolProbeResult;
  /** 适用性分类; 缺省按 oracle.kind 启发 (见 defaultClassify)。 */
  classifyApplicability?: (entry: { oracle?: { kind: string } }) => Applicability;
  /** fs 注入, 测试可换。readLastLine: 文件缺席 / 空 → null;
   *  appendLine: 追加单行 (含末尾 \n, 调用方不需补)。 */
  filesystem?: {
    readLastLine: (path: string) => string | null;
    appendLine: (path: string, line: string) => void;
  };
}

/** 变更台账的单行形状 (D-2, append-only JSONL)。
 *  failure_reason 缺席 = 该次探测无失败原因 (OK / ERROR / NOT_APPLICABLE)。 */
export interface ProbeChangeRecord {
  tool_id: string;
  probe_state: ProbeState;
  applicability: Applicability;
  failure_reason?: string;
  ts: string;
}

// ─── 判据 (INV-3) ────────────────────────────────────────────────────────────

/** 剔除判据 (D-5): 仅在 PROBED_FAIL ∧ APPLICABLE 时真。
 *  其余 11 组合 (PROBE_ERROR / UNPROBED / 任意 ∧ NOT_APPLICABLE/UNKNOWN) 一律假
 *  —— 探不出来 ≠ 探出来是坏的 (D-3), 合并就再犯 §静默坑 1。 */
export function isExcluded(health: {
  probe_state: ProbeState;
  applicability: Applicability;
}): boolean {
  return health.probe_state === PROBED_FAIL && health.applicability === APPLICABLE;
}

// ─── 探测 (INV-1) ────────────────────────────────────────────────────────────

/** 缺省适用性分类器 (D-4 不预画全表, 只覆盖 oracle.kind 这一维)。
 *  human / llm-judge = NOT_APPLICABLE (不能机器探);
 *  command / none / 缺席 = APPLICABLE (默认应探)。 */
function defaultClassify(entry: { oracle?: { kind: string } }): Applicability {
  const kind = entry.oracle?.kind;
  if (kind === 'human' || kind === 'llm-judge') return NOT_APPLICABLE;
  return APPLICABLE;
}

/** 探测一条 entry。**纯函数 + 注入依赖**, 零真网络零真磁盘。
 *
 *  路径表:
 *    classifyApplicability ≠ APPLICABLE → 返 UNPROBED + 原 applicability, 不调 callTool
 *    callTool 抛错                   → PROBE_ERROR + APPLICABLE (D-3 与 PROBED_FAIL 区分)
 *    callTool 返 {ok:false, reason}  → PROBED_FAIL + APPLICABLE + failure_reason
 *    callTool 返 {ok:true}           → PROBED_OK + APPLICABLE
 *
 *  注意: PROBE_ERROR 不带 failure_reason (D-4 不预画枚举, 探针能产出啥就登记啥)。 */
export function probeEntry(
  entry: { id: string; oracle?: { kind: string } },
  deps: ProbeDeps,
): ProbeHealth {
  const applicability = deps.classifyApplicability
    ? deps.classifyApplicability(entry)
    : defaultClassify(entry);

  if (applicability !== APPLICABLE) {
    return { probe_state: UNPROBED, applicability };
  }

  let result: ToolProbeResult;
  try {
    result = deps.callTool(entry);
  } catch (err) {
    // 探针基础设施故障 (超时/网络断) ≠ 探出来不可用 (D-3)。
    // ⚠ fail-open 可以吞异常, **不许吞证据** (仓规 §静默坑 2): 这里丢掉错误原文,
    //   PROBE_ERROR 就成了一个查不出所以然的状态 —— 而它与 PROBED_FAIL 分开的全部意义
    //   就在于「探不出来」要能追到为什么探不出来。返回值刻意不动 (failure_reason 只收
    //   探针真能产出的值, D-4), 证据走日志。
    console.warn(`[omd/inventory] 探针基础设施故障 → PROBE_ERROR (≠ 探出来不可用): ${entry.id} — ${err instanceof Error ? err.message : String(err)}`);
    return { probe_state: PROBE_ERROR, applicability: APPLICABLE };
  }
  if (result.ok) {
    return { probe_state: PROBED_OK, applicability: APPLICABLE };
  }
  return {
    probe_state: PROBED_FAIL,
    applicability: APPLICABLE,
    failure_reason: result.reason,
  };
}

// ─── 变更台账 (INV-4) ────────────────────────────────────────────────────────

/** 默认 fs: 读全文取最后非空行; 文件缺席 / 空 → null。 */
function defaultReadLastLine(path: string): string | null {
  if (!existsSync(path)) return null;
  const text = readFileSync(path, 'utf8');
  // 从末往前扫, 跳过空行 (含文件以 \n 结尾的尾随空行)
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line !== undefined && line.length > 0) return line;
  }
  return null;
}

function defaultAppendLine(path: string, line: string): void {
  appendFileSync(path, line.endsWith('\n') ? line : line + '\n');
}

/** 判定两条记录「同状态」: tool_id + probe_state + applicability + failure_reason 全等。
 *  ts 不参与 (ts 是写入时机, 不是状态本身 —— 同一状态不同 ts 仍视为同态)。 */
function sameState(a: ProbeChangeRecord, b: Partial<ProbeChangeRecord>): boolean {
  return (
    a.tool_id === b.tool_id &&
    a.probe_state === b.probe_state &&
    a.applicability === b.applicability &&
    a.failure_reason === b.failure_reason
  );
}

/** 记录一次状态变更。
 *  - 与上次同状态 → 不写, 返 { written: false, reason: 'same-as-last' }。
 *  - 不同 (或台账首次写) → 追加一行, 返 { written: true }。
 *  - 写失败 → 返 { written: false, reason: 'no-ledged-path' }, **但** console.error
 *    留一行证据 (静默坑 2)。fail-open: 阻断探测得不偿失。 */
export function recordProbeChange(
  ledgerPath: string,
  record: ProbeChangeRecord,
  deps?: { filesystem?: NonNullable<ProbeDeps['filesystem']> },
): { written: boolean; reason?: 'same-as-last' | 'no-ledged-path' } {
  const fs = deps?.filesystem ?? {
    readLastLine: defaultReadLastLine,
    appendLine: defaultAppendLine,
  };

  // 读末行 — 失败不阻断, 视为无前态
  let lastLine: string | null = null;
  try {
    lastLine = fs.readLastLine(ledgerPath);
  } catch (err) {
    console.error('[inventory/health] ledger readLastLine failed:', err);
    lastLine = null;
  }

  if (lastLine !== null) {
    try {
      const prev = JSON.parse(lastLine) as Partial<ProbeChangeRecord>;
      if (sameState(record, prev)) {
        return { written: false, reason: 'same-as-last' };
      }
    } catch (err) {
      // 末行非合法 JSON — 不当 prev, 走追加路径, 留证据
      console.error('[inventory/health] ledger last line not JSON, appending anyway:', err);
    }
  }

  try {
    fs.appendLine(ledgerPath, JSON.stringify(record));
    return { written: true };
  } catch (err) {
    // 写不出 = 阻断探测得不偿失, 但留证据 (静默坑 2)
    console.error('[inventory/health] ledger appendLine failed:', err);
    return { written: false, reason: 'no-ledged-path' };
  }
}
