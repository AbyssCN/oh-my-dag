/**
 * src/harness/goal/spec-write — 契约段有没有产出 spec 文件, **在当时**记下来。
 *
 * 为什么存在 (#209, 2026-08-19): 「这一跑的契约段落没写入磁盘」是**只活在 worktree 里**的事实。
 * 隔离档跑完 worktree 就被清, 分支合进 main 之后 `main..omd/run/<id>` 的新增也归零 ——
 * 两个信号同时消失, 而事后扫盘看到的是**基座树本来就有的** 145 份 `docs/plan/*.md`。
 * 为裁 #177 量这一位时连错三次, 最后只有 n=2 可量、另外 8 跑永久不可知。
 *
 * 所以这一位由 run-goal 在它**已经知道 specPath 的那一刻**产出 (`onContract` 回调),
 * 落进账本 `omd_dag_runs.spec_write` —— 不是事后扫盘。判定的原料是契约段那张图的
 * `filesTouched` (执行期事实), 与盘上现在还在不在**无关**。
 */

/**
 * 这一位是**怎么来的** —— kind 只答"有没有", source 答"哪条路给的"。
 *
 * - `contract`        —— complex 档真跑了契约段子图 (勘察/调研/起草)。
 * - `contract-error`  —— 契约段抛错 (引擎自己出事), 与"跑了但没产出文件"不是一回事。
 * - `sdd-direct`      —— `sddPath` 直通: spec 早就结晶在盘上, 这一跑零转录。
 * - `reused`          —— 闸 C 复用续跑前的契约段 (`specPath` 可能本来就缺席 —— 首跑就没写入磁盘)。
 * - `tier-simple`     —— simple 档压根不跑契约段 (D-5)。
 * - `no-agent-runner` —— complex 档但缺 agentRunner, 契约段整体跳过 (缺件, 不是"不需要")。
 */
export type SpecWriteSource = 'contract' | 'contract-error' | 'sdd-direct' | 'reused' | 'tier-simple' | 'no-agent-runner';

/**
 * 三值, **不是布尔** (#209 判据 ②): 有 spec / 无 spec / 该档不跑契约段。
 * 第四格是列 NULL = **没记** (非 solve 入口 / 老行) —— 由账本的缺席表达, 这里没有对应 kind。
 * 「无 spec」与「不跑契约段」的下一步相反: 前者要人看一眼 (契约段空手而归), 后者什么都不用做。
 */
export type SpecWrite =
  | { kind: 'wrote'; source: SpecWriteSource; path: string }
  | { kind: 'missing'; source: SpecWriteSource }
  | { kind: 'not-needed'; source: Extract<SpecWriteSource, 'tier-simple' | 'no-agent-runner'> };

/** `not-needed` 的两条来源 —— 判定用它, 别在调用点各写一份字面量比较。 */
const NOT_NEEDED_SOURCES = new Set<SpecWriteSource>(['tier-simple', 'no-agent-runner']);

/**
 * 由「哪条路 + 这一刻的 specPath」定这一位。
 *
 * ⚠ `specPath` 要传**执行期算出来的那一个** (契约段的 `filesTouched` 判出的), 不是
 * `existsSync()` 的结果 —— 后者在 worktree 清理之后恒 false, 那正是本票要修的错法。
 */
export function classifySpecWrite(source: SpecWriteSource, specPath: string | undefined): SpecWrite {
  if (NOT_NEEDED_SOURCES.has(source)) return { kind: 'not-needed', source: source as 'tier-simple' | 'no-agent-runner' };
  return specPath ? { kind: 'wrote', source, path: specPath } : { kind: 'missing', source };
}

/** 词表外的形状按"没记"读 (坏 JSON / 老版本写的值) —— 读数不崩, 也不编一个 kind。 */
export function isSpecWrite(v: unknown): v is SpecWrite {
  if (!v || typeof v !== 'object') return false;
  const k = (v as { kind?: unknown }).kind;
  const s = (v as { source?: unknown }).source;
  if (typeof s !== 'string') return false;
  if (k === 'wrote') return typeof (v as { path?: unknown }).path === 'string';
  if (k === 'missing') return true;
  if (k === 'not-needed') return NOT_NEEDED_SOURCES.has(s as SpecWriteSource);
  return false;
}
