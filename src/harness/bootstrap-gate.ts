/**
 * src/harness/bootstrap-gate —— C-4 bootstrap 最小闸 (片 4)。
 *
 * 契约: `docs/plan/2026-08-24-conductor-s1-五闸与清单-执行契约.md` §C-4。
 *
 * 不变量:
 *   INV-17 bootstrap 节点契约:`type:"bootstrap"` + `outputs.tool_path` +
 *     `test_gate{ tool_id, status?: green|yellow|red, oracle[], allow_non_deterministic:false, timeout_sec, cost_ceiling }` +
 *     provenance 11 字段。缺任一必填 → 编译期拒并点名缺项。
 *   INV-18 test_gate 三态:
 *     - green  (≥1 条确定性 oracle 过) → 经 inventory 的 in-flight 升格 API 入 inventory,
 *                                      可被同图 build-time 边引用;
 *     - yellow (仅非确定性 oracle 过)   → 不入 inventory, 被引用即产出 `PP-T03` 信号;
 *     - red    (全失败或全空)           → 全图不可用; **不向 conductor 透露该工具曾存在**
 *                                      (返回值里不得泄漏其 id / 名字)。
 *   INV-19 写权分立:bootstrap leaf 写 `red_tests/` 或 `fixtures/` 一律拒, 同时产出一行结构化
 *     审计记录 (返回结构, 不要自己往仓里写日志文件); 写集边界注册期冻结只许缩, 运行时越界
 *     返回 `SHADOW_EXEC` 拒绝。
 *   INV-20 test_gate 非 green 的工具不得被任何 build-time 边引用 (供 dry-run 流水线消费)。
 *   S1 红线: `allow_non_deterministic:true` 的注册请求一律拒 (S1 只收确定性 oracle)。
 *
 * 模块只依赖 zod + inventory 模块 (`./inventory`, 只 import 不改) + node 内置。
 */
import { registerInFlight, assertSingleWriter, type InFlightTestGate } from './inventory/inventory';
import { z } from 'zod';

// ─── 共享文本 ─────────────────────────────────────────────────────────────────
/** INV-19 红用例写权目录:bootstrap leaf 不得写, 红用例写权 = plan-critic 侧。 */
const RED_TESTS_DIR = 'red_tests/';
/** INV-19 fixtures 写权目录:bootstrap leaf 不得写, fixtures 写权 = plan-critic / dry-run 侧。 */
const FIXTURES_DIR = 'fixtures/';

/** 路径前缀匹配: `path === dir.slice(0,-1)` (裸目录名) 或 `path.startsWith(dir)`。 */
const insideDir = (path: string, dir: string): boolean =>
  path === dir.slice(0, -1) || path.startsWith(dir);

// ─── INV-17: bootstrap 节点契约 ───────────────────────────────────────────────
/**
 * provenance 11 字段 (INV-17 字面, 与 inventory 的 11 字段同源):
 * registered_at / registered_by / source_repo / source_path / commit_sha / import_method /
 * imported_at / imported_by / upstream_version / content_sha256 (64 hex) / schema_version。
 */
const ProvenanceShape = z
  .object({
    registered_at: z.string().min(1),
    registered_by: z.string().min(1),
    source_repo: z.string().min(1),
    source_path: z.string().min(1),
    commit_sha: z.string().min(1),
    import_method: z.string().min(1),
    imported_at: z.string().min(1),
    imported_by: z.string().min(1),
    upstream_version: z.string().min(1),
    content_sha256: z.string().regex(/^[0-9a-f]{64}$/, 'content_sha256 must be 64 hex chars'),
    schema_version: z.string().min(1),
  })
  .strict();

/** oracle 单条形态: kind 枚举照 inventory signatureShape; `deterministic` + `pass` 由
 *  evaluator 侧提供 (zod schema 只校验 shape, 不校验 pass 结果)。 */
const OracleShape = z
  .object({
    kind: z.enum(['command', 'llm-judge', 'human', 'none']),
    gateScriptRef: z.string().min(1),
    deterministic: z.boolean(),
    pass: z.boolean(),
  })
  .strict();

/**
 * bootstrap 节点契约 (INV-17)。字段顺序逐字锁定 (与 inventory 同源 INV-S1-7)。
 * - `type` 锁 `'bootstrap'`;
 * - `allow_non_deterministic` 锁 `false` (S1 红线, zod literal 拒 `true` 与任何非 false 值)。
 * - `outputs.tool_path` / `test_gate` / `provenance` 全 strict, 未知字段 → 拒。
 */
export const BootstrapNodeSchema = z
  .object({
    type: z.literal('bootstrap'),
    outputs: z
      .object({
        tool_path: z.string().min(1),
      })
      .strict(),
    test_gate: z
      .object({
        tool_id: z.string().min(1),
        status: z.enum(['green', 'yellow', 'red']).optional(),
        oracle: z.array(OracleShape).min(1),
        /** INV-17 S1 红线: S1 只收确定性 oracle; `true` / 缺省一律拒。 */
        allow_non_deterministic: z.literal(false, 'S1 只收确定性 oracle; allow_non_deterministic 必为 false'),
        timeout_sec: z.number().int().positive(),
        cost_ceiling: z.number().nonnegative(),
      })
      .strict(),
    provenance: ProvenanceShape,
  })
  .strict();

export type BootstrapNode = z.infer<typeof BootstrapNodeSchema>;

// ─── INV-17 校验结果 ──────────────────────────────────────────────────────────
/**
 * `validateBootstrapNode` 的对外结果。`ok:false` 时 `missing` 列出所有缺/坏的字段路径
 * (zod issue 的 `path.join('.')`) —— 测试断言这串字面必须出现在 errors 里。
 */
export type BootstrapValidation =
  | { ok: true; node: BootstrapNode }
  | { ok: false; phase: 'validate'; missing: string[] };

/**
 * INV-17: bootstrap 节点契约校验。缺任一必填 → 拒并点名缺项。
 *
 * `ok:false` 时 `missing[]` 含 zod issues 的所有路径, 顺序与 zod 一致; 路径可能为空
 * (`.strict()` 拒未知字段时 path 为空数组 → 归一化为 `'<root>'`)。
 */
export function validateBootstrapNode(input: unknown): BootstrapValidation {
  const parsed = BootstrapNodeSchema.safeParse(input);
  if (parsed.success) return { ok: true, node: parsed.data };
  const missing = parsed.error.issues.map((i) => i.path.join('.') || '<root>');
  return { ok: false, phase: 'validate', missing };
}

// ─── INV-18: test_gate 三态 ───────────────────────────────────────────────────
export type TestGateState = 'green' | 'yellow' | 'red';

export interface OracleResult {
  deterministic: boolean;
  pass: boolean;
}

/**
 * INV-18 三态判定:
 *   - `green`  = 至少 1 条确定性 oracle 过 (`deterministic && pass`);
 *   - `yellow` = 没有确定性 oracle 过, 但至少 1 条非确定性 oracle 过;
 *   - `red`    = 没有任何 oracle 过 (全失败或 oracle 数组空)。
 *
 * S1 节点契约要求 `allow_non_deterministic:false`, 合法节点的所有 oracle 都是确定性,
 * 实际不会触发 yellow —— 本函数保留 yellow 分支是给将来 S2 的非确定性侧留接缝,
 * 也是 plan-critic 那侧 `PP-T03` 判据的必要存在性证明。
 */
export function evaluateTestGate(oracles: readonly OracleResult[]): TestGateState {
  let anyDetPass = false;
  let anyNondetPass = false;
  for (const o of oracles) {
    if (!o.pass) continue;
    if (o.deterministic) anyDetPass = true;
    else anyNondetPass = true;
  }
  if (anyDetPass) return 'green';
  if (anyNondetPass) return 'yellow';
  return 'red';
}

// ─── INV-18: bootstrap 闸主入口 ───────────────────────────────────────────────
export type BootstrapGateVerdict =
  | { kind: 'green' }
  | { kind: 'yellow' }
  | { kind: 'red' };

/** inventory in-flight API 的注入接缝 (测试替身用)。 */
export interface InventoryInFlightAdapter {
  registerInFlight(id: string, gate: InFlightTestGate):
    | { ok: true; phase: 'in-flight'; id: string }
    | { ok: false; phase: 'in-flight'; reason: string; id: string };
}

const defaultAdapter: InventoryInFlightAdapter = {
  registerInFlight: (id, gate) => {
    const v = registerInFlight(id, gate);
    if (v.ok) return v;
    // 把 inventory 的字面 reason 串起来, 返回给上层
    return { ok: false, phase: 'in-flight', reason: v.reason, id: v.id };
  },
};

/** runBootstrapGate 入参。oracle 结果从外部 evaluator 注入, 不在此件里跑 oracle。 */
export interface BootstrapGateInput {
  node: BootstrapNode;
  oracleResults: readonly OracleResult[];
  /** 注入 inventory in-flight API; 缺省链到 inventory 真实现。 */
  inv?: InventoryInFlightAdapter;
  /**
   * B5 写会话 worktree 命名空间 (规范化绝对路径); 提供时在会话入口抢单写者锁,
   * evaluateTestGate + registerInFlight 完成后在 finally 显式 release。
   * 缺省 = 不抢锁 (单元测试与 caller 自行托管锁的场景)。契约 D-2: 来源不得用 process.cwd() 猜测,
   * 必须由 caller 注入真实 worktree。
   */
  worktree?: string;
}

/**
 * INV-18 主入口。三态产出, **返回值不携带 tool_id / name / path** ——
 * red 分支严格做到不向 conductor 透露该工具曾存在 (不只结果字段, 整条路径上不入库存档)。
 *
 * 路径分流:
 *   - evaluateTestGate = green  → 调 inventory.registerInFlight 入 in-flight inventory;
 *                                 注册成功 → `{ kind: 'green' }`; 注册失败 (e.g. NOT_IN_WORKING_SET)
 *                                 → 升级到 `{ kind: 'yellow' }` (PP-T03 消费, 不向 conductor 提绿)
 *   - evaluateTestGate = yellow → 不入 inventory → `{ kind: 'yellow' }`;
 *   - evaluateTestGate = red    → 不入 inventory → `{ kind: 'red' }`;
 *
 * 关键: red 分支在 inventory 侧不调用 registerInFlight, 在本件返回值里也不含 `tool_id`;
 * conductor 永远拿不到这条 bootstrap 节点的 id / name —— 这正是 INV-18 红字面
 * 「不向 conductor 透露该工具曾存在」。
 */
export function runBootstrapGate(input: BootstrapGateInput): BootstrapGateVerdict {
  // B5 writer liveness (D-1 / INV-1): worktree 提供时在入口抢单写者锁;
  // 失败直接抛 SingleWriterViolation (此时 handle 仍为 null, finally 不会误调 release)。
  const handle = input.worktree ? assertSingleWriter(input.worktree) : null;
  try {
    const state = evaluateTestGate(input.oracleResults);
    if (state === 'green') {
      const adapter = input.inv ?? defaultAdapter;
      const verdict = adapter.registerInFlight(input.node.test_gate.tool_id, {
        status: 'green',
        gate: 'bootstrap',
      });
      if (verdict.ok) return { kind: 'green' };
      // 注册失败 (NOT_IN_WORKING_SET / ALREADY_IN_FLIGHT / not_green) → 升级到 yellow
      // —— 该工具此时**已**被本图 build-time 边引用, conductor 必须看到 PP-T03 信号。
      return { kind: 'yellow' };
    }
    if (state === 'yellow') return { kind: 'yellow' };
    return { kind: 'red' };
  } finally {
    // D-2: 释放必须在会话终止路径执行 (正常返回 + 异常退出都覆盖);
    // 锁文件不依赖租约超时自动让出 —— 崩溃遗留锁由外部恢复动作处理。
    if (handle) handle.release();
  }
}

// ─── INV-19: 写权闸 ──────────────────────────────────────────────────────────
/** INV-19 审计记录 (返回结构, 严守 §「不要自己往仓里写日志文件」)。 */
export interface AuditRecord {
  kind: 'red_tests_blocked' | 'fixtures_blocked' | 'shadow_exec';
  path: string;
  reason: string;
  ts: string;
}

export type BootstrapWriteVerdict =
  | { allowed: true }
  | { allowed: false; audit: AuditRecord };

/** checkBootstrapWrite 的内部纯函数 (不依赖 BootstrapWriteSet 实例形态, 便于单测)。 */
function checkWriteInner(
  path: string,
  ts: string,
  frozenHas: (p: string) => boolean,
  frozenSnap: readonly string[],
  contains: (p: string) => boolean,
  currentSnap: readonly string[],
): BootstrapWriteVerdict {
  if (insideDir(path, RED_TESTS_DIR)) {
    return {
      allowed: false,
      audit: {
        kind: 'red_tests_blocked',
        path,
        reason:
          `INV-19: bootstrap leaf 禁止写 red_tests/ (${RED_TESTS_DIR}); ` +
          '红用例写权 = plan-critic 侧',
        ts,
      },
    };
  }
  if (insideDir(path, FIXTURES_DIR)) {
    return {
      allowed: false,
      audit: {
        kind: 'fixtures_blocked',
        path,
        reason:
          `INV-19: bootstrap leaf 禁止写 fixtures/ (${FIXTURES_DIR}); ` +
          'fixtures 写权 = plan-critic / dry-run 侧',
        ts,
      },
    };
  }
  if (!frozenHas(path)) {
    return {
      allowed: false,
      audit: {
        kind: 'shadow_exec',
        path,
        reason:
          `INV-19: 写集越界 (path 未在注册期冻结的写集里); frozen=` +
          `[${frozenSnap.join(' · ') || '(空)'}]`,
        ts,
      },
    };
  }
  if (!contains(path)) {
    return {
      allowed: false,
      audit: {
        kind: 'shadow_exec',
        path,
        reason:
          `INV-19: 写集已 shrink, 路径已不再允许; current=` +
          `[${currentSnap.join(' · ') || '(空)'}]`,
        ts,
      },
    };
  }
  return { allowed: true };
}

/**
 * INV-19 bootstrap leaf 写权闸 (公开入口)。三层拒绝顺序:
 *   1. 路径落在 `red_tests/`     → `{ kind: 'red_tests_blocked' }`
 *   2. 路径落在 `fixtures/`      → `{ kind: 'fixtures_blocked' }`
 *   3. 路径不在 frozen 集 (越注册期边界) → `{ kind: 'shadow_exec' }`
 *   4. 路径已被 `shrink` 排除 (不在 current 集) → `{ kind: 'shadow_exec' }`
 *   5. 通过 → `{ allowed: true }` (不产 audit)
 *
 * 调用方拿到 `{ allowed: false, audit }` 后自行决定如何落账 (e.g. 写回 conductor 的
 * plan-dry-run 反馈), 本件**永不写文件**。
 *
 * `writeSet` 用 BootstrapWriteSet 接口注入 — 通常从 `createBootstrapWriteSet` 取,
 * 测试也可造替身。`now` 时钟注入便于 `audit.ts` 断言。
 */
export function checkBootstrapWrite(
  path: string,
  writeSet: BootstrapWriteSet,
  now: () => Date = () => new Date(),
): BootstrapWriteVerdict {
  return checkWriteInner(
    path,
    now().toISOString(),
    (p) => writeSet.frozenHas(p),
    writeSet.frozenSnapshot(),
    (p) => writeSet.contains(p),
    writeSet.currentSnapshot(),
  );
}

/** INV-19 写集: 注册期冻结 (`frozen`), 运行时只许缩 (`current ⊆ frozen`)。 */
export interface BootstrapWriteSet {
  /** 当前 (非 frozen) 写集成员判定。 */
  contains(path: string): boolean;
  /** frozen 集成员判定 (给 dry-run 流水线作读侧判据用)。 */
  frozenHas(path: string): boolean;
  /** 闸判入口 (一般用法 = `checkBootstrapWrite`); 这里也直接暴露以方便注入测试。 */
  check(path: string): BootstrapWriteVerdict;
  /** 缩写集: 只许删不许加, 给的 path 不在 frozen → 忽略。 */
  shrink(paths: readonly string[]): void;
  /** frozen 快照 (供 dry-run 流水线消费 / 调试)。 */
  frozenSnapshot(): readonly string[];
  /** current 快照 (供 dry-run 流水线消费 / 调试)。 */
  currentSnapshot(): readonly string[];
}

/**
 * 注册期调用: 冻结当前 `initial` 为 `frozen`, 创建 `current = frozen`。
 * 注册期之后再无路径可以加入 frozen —— `shrink` 只能从 frozen 删除。
 *
 * 时钟注入: 测试断言 `ts` 用; 缺省用 `Date.now().toISOString()` (audit 记录自带)。
 */
export function createBootstrapWriteSet(
  initial: readonly string[],
  now: () => Date = () => new Date(),
): BootstrapWriteSet {
  const frozen = new Set<string>(initial);
  const current = new Set<string>(initial);
  // 构造后用闭包引用, 不依赖对象 `this`。
  const set: BootstrapWriteSet = {
    contains: (p) => current.has(p),
    frozenHas: (p) => frozen.has(p),
    check: (p) => checkBootstrapWrite(p, set, now),
    shrink: (paths) => {
      for (const p of paths) {
        if (!frozen.has(p)) continue;
        current.delete(p);
      }
    },
    frozenSnapshot: () => Array.from(frozen),
    currentSnapshot: () => Array.from(current),
  };
  return set;
}

// ─── INV-20: build-time edge 引用判定 ─────────────────────────────────────────
/**
 * INV-20 判定函数: test_gate 非 green 的工具不得被任何 build-time 边引用。
 * 供 dry-run 流水线的 tool-resolve 阶段消费 (`plan-dry-run.ts`)。
 *
 * 只有 green 工具可以被边引用; yellow / red 引用一律触发 `PP-T03 tool_not_green`。
 * 这是 dry-run 的**编译期闸**——build-time 边在装图期就拒, 不让图跑到运行时。
 */
export function canBeReferencedByBuildTimeEdge(state: TestGateState): boolean {
  return state === 'green';
}