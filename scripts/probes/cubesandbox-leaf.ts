/**
 * CubeSandbox leaf 测量器实现 (S0-IMPL, 契约
 * `docs/plan/2026-08-11-四要素定稿-owner-2026-08-11-加第-4-条信号-假设-cubesandbox-能.md`)。
 *
 * 让 `cubesandbox-leaf.test.ts` 的 INV-1..INV-6 判据从红变绿。**本文件只钉判据与
 * bwrap 侧脚手架, 不接 Cube** —— adapter TDD 是下一步。
 *
 * 复用而非重造:
 *   - bwrap 侧的 argv 组装 = {@link bwrapArgs}/{@link defaultRoBinds} (src/harness/hooks/bwrap.ts)。
 *   - subprocess-per-leaf runner = {@link createSandboxedLeafRunner} (src/harness/hooks/sandboxed-leaf.ts) —
 *     bwrap 基线实测 (下一步) 直接拿它跑, 这里只重导出供该步接线。
 *   - 产物路径命名 = CheckpointManager.saveNodeOutput 的 `out-<nodeId>.txt` 约定
 *     (src/harness/continuity/checkpoint-manager.ts:288-293, 含它的 nodeId 安全化正则),
 *     不落 `.omd/continuity` (那是 run 引擎的地盘), 落本探针自己的证据目录。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { bwrapArgs, defaultRoBinds } from '../../src/harness/hooks/bwrap';
import { createSandboxedLeafRunner } from '../../src/harness/hooks/sandboxed-leaf';

// 供下一步 (bwrap 基线实测 / adapter TDD) 接线用, 这里不调用 —— 只重导出防止两处各说各的实现。
export { bwrapArgs, defaultRoBinds, createSandboxedLeafRunner };

// ─── INV-1 · manifest 单变量可审计 ──────────────────────────────────────────

/** 单次 leaf 调用的清单形状 —— 除 leafLocation/sandboxRunId 外, 两臂 (bwrap/cube) 必须逐字段相同。 */
export interface LeafManifest {
  repoHead: string;
  worktree: string;
  planHash: string;
  planPath: string;
  seat: string;
  thinking: string;
  temperature: number;
  topP: number;
  goal: string;
  nodeId: string;
  envAllowlist: readonly string[];
  leafLocation: string;
  sandboxRunId: string;
}

/** 豁免比较的字段: 描述"跑在哪/哪次跑"的标识本身就该不同, 不算漂移。 */
export const MANIFEST_EXEMPT_FIELDS: ReadonlySet<string> = new Set(['leafLocation', 'sandboxRunId']);

export interface ManifestCompareResult {
  comparable: boolean;
  diffFields: string[];
}

function fieldsEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => fieldsEqual(v, b[i]));
  return false;
}

/**
 * 逐字段比较两份 manifest。任一非豁免字段不同 → `comparable=false`, `diffFields` 列出**全部**
 * 不同字段 (不挑一个代表)。不携带任何"为什么不同"的归因 —— 判据只判可比不可比, 不解释差值。
 */
export function compareManifests(a: LeafManifest, b: LeafManifest): ManifestCompareResult {
  const keys = new Set<string>([...Object.keys(a), ...Object.keys(b)]);
  const diffFields: string[] = [];
  for (const key of keys) {
    if (MANIFEST_EXEMPT_FIELDS.has(key)) continue;
    if (!fieldsEqual((a as unknown as Record<string, unknown>)[key], (b as unknown as Record<string, unknown>)[key])) diffFields.push(key);
  }
  return { comparable: diffFields.length === 0, diffFields };
}

// ─── INV-4 · 十名 env key 只记 presence/count, value 不可序列化 (D-9 冻结名单) ──

/** D-9 冻结名单 —— 顺序与拼写与契约行 17 逐字相同, 不得漂移。 */
export const ENV_KEY_ALLOWLIST: readonly string[] = [
  'ANYSEARCH_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'DEEPSEEK_API_KEY',
  'FIRECRAWL_API_KEY',
  'MIMO_API_KEY',
  'MIMO_PLATFORM_API_KEY',
  'OPENCODE_API_KEY',
  'PUBLER_API_KEY',
  'TAVILY_API_KEY',
  'XIAOMI_TOKEN_PLAN_AMS_API_KEY',
];

export interface EnvKeyProbe {
  key: string;
  present: boolean;
}

/** 只记 key + present, 绝不把 value 摆进返回对象 (脱敏在结构层面保证, 不靠调用方自觉)。 */
export function probeEnvKeys(env: Record<string, string | undefined>): EnvKeyProbe[] {
  return ENV_KEY_ALLOWLIST.map((key) => ({ key, present: env[key] !== undefined }));
}

// ─── INV-3 · NULL ≠ 0 的记账形态 ────────────────────────────────────────────

export interface AttemptOutcomeInput<T = unknown> {
  stage: string;
  value?: T;
  error?: Error;
}

export interface AttemptOutcome<T = unknown> {
  stage: string;
  value: T | null;
  error: Error | null;
}

/**
 * 记一次 attempt 的结果。`stage` 必填 —— 缺它就无法分辨"起不来/没跑到/SDK 无该方法"三种"没记"。
 * 原始 error 原样保留 (不吞成布尔/字符串摘要); 未给 value → null (与 0 可区分)。
 */
export function recordAttemptOutcome<T = unknown>(input: AttemptOutcomeInput<T>): AttemptOutcome<T> {
  if (!input.stage) {
    throw new Error('[cubesandbox-leaf] recordAttemptOutcome: stage 必填 — NULL 必须带 stage, 否则无法分辨三种"没记"');
  }
  return {
    stage: input.stage,
    value: input.value === undefined ? null : input.value,
    error: input.error ?? null,
  };
}

// ─── INV-5 · byte comparator 只接受 out-*.txt 路径 ─────────────────────────

export interface ByteCompareResult {
  exitStatus: number | null;
  firstDiffOffset: number | null;
}

/** 与 CheckpointManager.saveNodeOutput 同一命名约定: `out-<nodeId>.txt` (nodeId 已安全化)。 */
function isOutArtifactPath(p: string): boolean {
  return /^out-.+\.txt$/.test(basename(p));
}

/**
 * 逐字节比较两份 leaf 产物。只接受 `out-<nodeId>.txt` 形态的路径 —— summary/checkpoint JSON
 * 或人工摘录不是"leaf 真产出", 拒绝比较防止误把摘要当产物。文件缺席 → `exitStatus: null`
 * (不是 0, 不抛未捕获异常掩盖缺席事实)。
 */
export function compareBytes(pathA: string, pathB: string): ByteCompareResult {
  if (!isOutArtifactPath(pathA) || !isOutArtifactPath(pathB)) {
    throw new Error(`[cubesandbox-leaf] compareBytes 只接受 out-<nodeId>.txt 路径, 收到: ${pathA} / ${pathB}`);
  }
  if (!existsSync(pathA) || !existsSync(pathB)) return { exitStatus: null, firstDiffOffset: null };
  const bufA = readFileSync(pathA);
  const bufB = readFileSync(pathB);
  const shorter = Math.min(bufA.length, bufB.length);
  let firstDiffOffset: number | null = null;
  for (let i = 0; i < shorter; i++) {
    if (bufA[i] !== bufB[i]) {
      firstDiffOffset = i;
      break;
    }
  }
  if (firstDiffOffset === null && bufA.length !== bufB.length) firstDiffOffset = shorter;
  return { exitStatus: firstDiffOffset === null ? 0 : 1, firstDiffOffset };
}

// ─── INV-6 · 重试有界 ────────────────────────────────────────────────────────

/** 首试之外最多重试 2 次 (冻结)。 */
export const MAX_RETRY = 2;

/** `retriesSoFar` = 首试之外已重试次数。越界请求显式拒绝 (不靠循环静默截断掩盖)。 */
export function boundRetry(retriesSoFar: number): boolean {
  return retriesSoFar <= MAX_RETRY;
}

export interface AttemptLedgerEntry<T> {
  attempt: number;
  outcome: AttemptOutcome<T>;
}

/**
 * attempt 账: 跑 `fn`, 失败按 {@link boundRetry} 有界重试, 每次尝试 (成功或失败) 都经
 * {@link recordAttemptOutcome} 记一条账目 —— NULL ≠ 0 的记账形态与重试上限在同一条链上生效,
 * 不是两处各自为政。
 */
export async function runBoundedAttempts<T>(stage: string, fn: () => Promise<T>): Promise<AttemptLedgerEntry<T>[]> {
  const ledger: AttemptLedgerEntry<T>[] = [];
  let retriesSoFar = 0;
  for (;;) {
    if (!boundRetry(retriesSoFar)) break;
    const attempt = retriesSoFar;
    try {
      const value = await fn();
      ledger.push({ attempt, outcome: recordAttemptOutcome({ stage, value }) });
      break; // 成功即停 —— 重试是为失败准备的, 不做多余的"再确认一次"
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      ledger.push({ attempt, outcome: recordAttemptOutcome({ stage, error }) });
      retriesSoFar += 1;
    }
  }
  return ledger;
}

// ─── D-3 · 单调墙钟 (发起创建 → 首次 ready-to-execute) ──────────────────────

export interface WallClock {
  readonly startedAtNs: bigint;
}

/** `process.hrtime.bigint()` 单调, 不受系统时钟调整影响 —— 量的是"发起创建"这个瞬间。 */
export function startWallClock(): WallClock {
  return { startedAtNs: process.hrtime.bigint() };
}

/** 从 `clock` 起点到调用此刻的毫秒数 —— 调用点应是"首次 ready-to-execute"那一瞬。 */
export function elapsedMs(clock: WallClock): number {
  return Number(process.hrtime.bigint() - clock.startedAtNs) / 1_000_000;
}

// ─── manifest 锁 (防并发写同一份基线证据) ───────────────────────────────────

/**
 * 用一个原子 `mkdir` 当锁 (已存在则 `EEXIST` 抛出, 拒绝并发写)。返回释放函数; 调用方 `finally` 里释放。
 */
export function acquireManifestLock(evidenceDir: string): () => void {
  const lockPath = join(evidenceDir, 'manifest.lock');
  mkdirSync(evidenceDir, { recursive: true });
  mkdirSync(lockPath); // 已存在 → 抛 EEXIST
  return () => {
    try {
      rmdirSync(lockPath);
    } catch {
      // 已被释放/已不存在 — 幂等释放, 不是需要上报的证据
    }
  };
}

// ─── verify-baseline / verify-evidence 子命令 ───────────────────────────────
// 只校验证据齐 / 先后 / 脱敏, 不加结果阈值 (不断言 typecheck/test 具体数字, 不断言 Cube 该跑多少次)。

export interface VerifyResult {
  ok: boolean;
  problems: string[];
}

const SECRET_LIKE = /(sk-|ghp_|xox[baprs]-|AIza|eyJhbGci)[A-Za-z0-9_-]{8,}/;

/** 证据齐 + 阈值不设: 只查 baseline.json 存在、可解析、必填字段都在, 不查字段的值合不合格。 */
export function verifyBaseline(evidenceDir: string): VerifyResult {
  const problems: string[] = [];
  const path = join(evidenceDir, 'baseline.json');
  if (!existsSync(path)) {
    problems.push(`缺 ${path} (INV-2 基线先行: 未重录基线证据)`);
    return { ok: false, problems };
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    return { ok: false, problems: [`${path} 不是合法 JSON: ${err instanceof Error ? err.message : String(err)}`] };
  }
  for (const field of ['timestamp', 'headCommit', 'typecheck', 'test']) {
    if (!(field in parsed)) problems.push(`baseline.json 缺字段 ${field}`);
  }
  if (SECRET_LIKE.test(JSON.stringify(parsed))) problems.push('baseline.json 疑似含未脱敏的密钥形态字符串');
  return { ok: problems.length === 0, problems };
}

/**
 * 证据齐 (S0-RED 文件在且非空) + 先后 (S0-RED 必须早于本实现文件, 即 TDD 红先于绿) + 脱敏
 * (证据目录任何文件都不得出现密钥形态字符串)。不断言测试通过与否的具体数字。
 */
export function verifyEvidence(evidenceDir: string, implFilePath: string): VerifyResult {
  const problems: string[] = [];
  const redPath = join(evidenceDir, 'tdd-s0-red.txt');
  if (!existsSync(redPath)) {
    problems.push(`缺 ${redPath} (S0-RED 证据缺席)`);
  } else {
    const redText = readFileSync(redPath, 'utf8');
    if (redText.trim().length === 0) problems.push(`${redPath} 为空文件`);
    if (existsSync(implFilePath)) {
      const redMtime = statSync(redPath).mtimeMs;
      const implMtime = statSync(implFilePath).mtimeMs;
      if (redMtime > implMtime) problems.push('先后倒置: tdd-s0-red.txt 的 mtime 晚于实现文件 (红应先于绿)');
    }
    if (SECRET_LIKE.test(redText)) problems.push(`${redPath} 疑似含未脱敏的密钥形态字符串`);
  }
  if (existsSync(evidenceDir)) {
    for (const f of readdirSync(evidenceDir)) {
      if (!f.endsWith('.json')) continue;
      const p = join(evidenceDir, f);
      let text: string;
      try {
        text = readFileSync(p, 'utf8');
      } catch {
        continue;
      }
      if (SECRET_LIKE.test(text)) problems.push(`${p} 疑似含未脱敏的密钥形态字符串`);
    }
  }
  return { ok: problems.length === 0, problems };
}

// ─── CLI ─────────────────────────────────────────────────────────────────

function main(argv: string[]): void {
  const [cmd] = argv;
  const evidenceDir = join(import.meta.dir, '..', '..', '.omd', 'probes', 'cubesandbox-leaf');
  const implFilePath = join(import.meta.dir, 'cubesandbox-leaf.ts');
  if (cmd === 'verify-baseline') {
    const result = verifyBaseline(evidenceDir);
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.ok ? 0 : 1);
  } else if (cmd === 'verify-evidence') {
    const result = verifyEvidence(evidenceDir, implFilePath);
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.ok ? 0 : 1);
  } else {
    console.error('用法: bun run scripts/probes/cubesandbox-leaf.ts <verify-baseline|verify-evidence>');
    process.exit(2);
  }
}

if (import.meta.main) main(process.argv.slice(2));
