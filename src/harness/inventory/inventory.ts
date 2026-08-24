/**
 * src/harness/inventory/inventory —— 工具能力注册表内核 (S1 / 片 1)。
 *
 * 契约来源: 《S1 接口契约》§1.1 (消费者任务说明在四组字段形状上与生产者 §1.1
 * 存在冲突, 详见 .omd/continuity/.../fanin-execute__16ajv0e6i7i4j.txt 的
 * CONFLICT-1 —— 本片以消费者任务说明的四组字段为字面真源)。
 *
 * 设计要点 (INV 列表):
 * - INV-1: 引擎原语 eager 常驻, discovered-set 只读、经校验原子升格进
 *   working-set; 只有 working-set 可调; 未升格引用返回 NOT_IN_WORKING_SET。
 * - INV-3: in-flight 升格 API 要求 test_gate=green, 非 green 查询返回 not_green。
 * - INV-4: 同一 worktree 第二个写者打开注册表即拒并报错 (文件锁 wx)。
 * - INV-5: 全文件不得出现任何从散文摘取的红线 / 禁令 / 名单语义命名的函数
 *   或字段 —— capability 标签 (effect / safety_class) 是描述而非禁令。
 *
 * 字段顺序 = 指纹 (INV-S1-7): zod schema 与 TS 类型的字段顺序逐字锁定,
 * 加字段 = 升 SCHEMA_VERSION。本片 SCHEMA_VERSION 留给 conductor-plan.ts 顶层
 * 共同裁决 (任务说明未给本片独占的字面)。
 */
import { openSync, closeSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';

// ─── 共享文本 ─────────────────────────────────────────────────────────────────
/** 主键字面: `<source>:<name>@<semver>`。source 段允许字母数字下划线点横线冒号,
 *  name 段允许字母数字下划线点横线, semver 段允许数字点连字符 (即 semver 字面)。 */
const ID_RE = /^[A-Za-z0-9_.:-]+:[A-Za-z0-9_.-]+@\d+(?:\.\d+){0,2}(?:[-+][A-Za-z0-9.-]+)?$/;
/** 内容哈希 = 64 位十六进制 (SHA-256 字面)。 */
const SHA256_RE = /^[0-9a-f]{64}$/;

/** 单写者锁文件名 —— 每个 worktree 一个, 第二名写者抢同一文件即触发 INV-4。 */
export const SINGLE_WRITER_LOCK_NAME = 'inventory.lock';

// ─── 字段组合 ─────────────────────────────────────────────────────────────────
/** 常驻组: 身份 / 形态语义。effect 是能力描述, 不是禁令。 */
const residenceShape = z
  .object({
    id: z.string().regex(ID_RE, 'id must match `<source>:<name>@<semver>`'),
    name: z.string().min(1),
    when_to_use: z.string().min(1),
    effect: z.enum(['read', 'write', 'destructive', 'sidechain']),
    safety_class: z.string().min(1),
    /** 区间值留 TBD (上游 §7), 本片只锁字面集合 t0..t3。 */
    cost_tier: z.enum(['t0', 't1', 't2', 't3']),
    defer_mode: z.string().min(1),
  })
  .strict();

/** 签名组: signature = JSON Schema (passthrough 任意键), oracle = kind+gate 引用。 */
const signatureShape = z
  .object({
    signature: z.object({}).passthrough(),
    oracle: z.object({
      kind: z.enum(['command', 'llm-judge', 'human', 'none']),
      gateScriptRef: z.string().min(1),
    }),
  })
  .strict();

/** 健康组: S1 只立字段 (探针实装属 S2)。 */
const healthShape = z
  .object({
    probe_state: z.string().min(1),
    applicability: z.string().min(1),
    failure_reason: z.string().optional(),
    idle_days: z.number().int().nonnegative(),
  })
  .strict();

/** 审计组: provenance 11 字段含 sha256, 旁挂 search_hint / owner_pinned / oracle_bearing。 */
const provenanceShape = z
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
    content_sha256: z.string().regex(SHA256_RE, 'content_sha256 must be 64 hex chars'),
    schema_version: z.string().min(1),
  })
  .strict();

const auditShape = z
  .object({
    provenance: provenanceShape,
    search_hint: z.string().min(1),
    owner_pinned: z.boolean(),
    oracle_bearing: z.boolean(),
  })
  .strict();

/** 顶层条目: 字段顺序逐字锁定 (INV-S1-7)。 */
export const InventoryEntrySchema = z
  .object({
    ...residenceShape.shape,
    ...signatureShape.shape,
    ...healthShape.shape,
    ...auditShape.shape,
  })
  .strict();

export type InventoryEntry = z.infer<typeof InventoryEntrySchema>;

/** in-flight test_gate 输入: S1 只看 status 字段 (S2 才补 timeout / exitCode / 等)。 */
export interface InFlightTestGate {
  status: 'green' | 'red';
  gate: string;
}

// ─── 寄存器状态 ──────────────────────────────────────────────────────────────
/** INV-1: discovered-set 只读, working-set 经 promoteToWorkingSet 升格。 */
interface InventoryState {
  discovered: Map<string, InventoryEntry>;
  working: Map<string, InventoryEntry>;
  inFlight: Map<string, InventoryEntry>;
}

const state: InventoryState = {
  discovered: new Map(),
  working: new Map(),
  inFlight: new Map(),
};

/** 测试钩子: 每个用例 fresh 起一份。生产代码不许调。 */
export function _resetInventoryForTests(): void {
  state.discovered.clear();
  state.working.clear();
  state.inFlight.clear();
}

// ─── 注册结果 ─────────────────────────────────────────────────────────────────
/** schema 失败的 issues 给出路径 (path.join('.')) = 缺哪个字段的判词依据
 *  —— 测试断言这串字面必须出现在 issues 里。 */
export type RegisterVerdict =
  | { ok: true; phase: 'register' }
  | { ok: false; phase: 'register'; reason: 'schema_invalid'; issues: string[] };

export type PromoteVerdict =
  | { ok: true; phase: 'promote'; id: string }
  | { ok: false; phase: 'promote'; reason: 'NOT_IN_DISCOVERED'; id: string }
  | { ok: false; phase: 'promote'; reason: 'ALREADY_IN_WORKING_SET'; id: string };

export type ResolveResult =
  | { state: 'IN_WORKING_SET'; entry: InventoryEntry }
  | { state: 'NOT_IN_WORKING_SET'; id: string };

export type InFlightVerdict =
  | { ok: true; phase: 'in-flight'; id: string }
  | {
      ok: false;
      phase: 'in-flight';
      reason: 'not_green' | 'NOT_IN_WORKING_SET' | 'ALREADY_IN_FLIGHT';
      id: string;
    };

// ─── 注册 ────────────────────────────────────────────────────────────────────
/** discover: 经校验的条目进入 discovered-set。INVENTORY-1 升格前的唯一入口。 */
export function registerEntry(input: unknown): RegisterVerdict {
  const parsed = InventoryEntrySchema.safeParse(input);
  if (!parsed.success) {
    const issues = parsed.error.issues.map(
      (i) => `${i.path.join('.') || '<root>'}: ${i.message}`,
    );
    return { ok: false, phase: 'register', reason: 'schema_invalid', issues };
  }
  state.discovered.set(parsed.data.id, parsed.data);
  return { ok: true, phase: 'register' };
}

// ─── 升格 ────────────────────────────────────────────────────────────────────
/** INV-1: discovered-set 原子升格到 working-set (单线程 JS 天然原子)。 */
export function promoteToWorkingSet(id: string): PromoteVerdict {
  const entry = state.discovered.get(id);
  if (!entry) return { ok: false, phase: 'promote', reason: 'NOT_IN_DISCOVERED', id };
  if (state.working.has(id)) {
    return { ok: false, phase: 'promote', reason: 'ALREADY_IN_WORKING_SET', id };
  }
  state.working.set(id, entry);
  state.discovered.delete(id);
  return { ok: true, phase: 'promote', id };
}

/** INV-1 出口: 未升格引用一律 NOT_IN_WORKING_SET。 */
export function resolve(id: string): ResolveResult {
  const entry = state.working.get(id);
  if (entry) return { state: 'IN_WORKING_SET', entry };
  return { state: 'NOT_IN_WORKING_SET', id };
}

// ─── in-flight ───────────────────────────────────────────────────────────────
/** INV-3: test_gate 必须是 green 才允许进入 in-flight。 */
export function registerInFlight(id: string, gate: InFlightTestGate): InFlightVerdict {
  if (gate.status !== 'green') {
    return { ok: false, phase: 'in-flight', reason: 'not_green', id };
  }
  const entry = state.working.get(id);
  if (!entry) return { ok: false, phase: 'in-flight', reason: 'NOT_IN_WORKING_SET', id };
  if (state.inFlight.has(id)) {
    return { ok: false, phase: 'in-flight', reason: 'ALREADY_IN_FLIGHT', id };
  }
  state.inFlight.set(id, entry);
  return { ok: true, phase: 'in-flight', id };
}

// ─── 单写者 ──────────────────────────────────────────────────────────────────
/** INV-4: 同一 worktree 第二名写者打开即拒。文件锁 = O_EXCL (wx),
 *  抢同一 inode 的第二次创建必然失败。 */
export class SingleWriterViolation extends Error {
  override readonly name = 'SingleWriterViolation';
  readonly worktree: string;
  readonly lockPath: string;
  /** 触发锁竞争时的原始 OS 错误。避免与 Error.cause (ES2022) 重名, 用 origin 区分。 */
  readonly origin: unknown;
  constructor(worktree: string, lockPath: string, origin: unknown) {
    super(
      `INV-4 single-writer violation: worktree=${worktree} lock=${lockPath} already held`,
    );
    this.worktree = worktree;
    this.lockPath = lockPath;
    this.origin = origin;
  }
}

/** 抢锁: 成功即返回 lockPath + close 句柄, 失败抛 SingleWriterViolation。 */
export function assertSingleWriter(worktree: string): { lockPath: string; close: () => void } {
  const lockPath = join(worktree, '.omd', SINGLE_WRITER_LOCK_NAME);
  mkdirSync(dirname(lockPath), { recursive: true });
  let fd: number;
  try {
    fd = openSync(lockPath, 'wx');
  } catch (err) {
    throw new SingleWriterViolation(worktree, lockPath, err);
  }
  return {
    lockPath,
    close: () => {
      try {
        closeSync(fd);
      } catch {
        /** 关 fd 是 fd 本地资源, 业务无可观察后果; 不留证据遵循 fail-open 最小例。 */
      }
    },
  };
}

/** 非抛版本: 给试探 / 健康检查用。注意 INV-4 的真源是「锁文件 inode 存在与否」,
 *  用 existsSync 而不是 wx —— 否则「探一下」会自己抢锁反过来挡后面的 assert。 */
export function isSingleWriter(worktree: string): boolean {
  const lockPath = join(worktree, '.omd', SINGLE_WRITER_LOCK_NAME);
  return !existsSync(lockPath);
}
