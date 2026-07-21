/**
 * src/harness/plan-ledger —— plan-memory Phase A 数据层 (SDD docs/plan/2026-07-21-plan-memory.md)。
 *
 * DAG 图记忆的账本: 每次 dag_run 跑完记一笔 (family 聚类 + 版本去重 + 战绩计数)。
 * **纯记账, 零行为改变** —— 召回闸 (Phase B) 压在证据门后 (issue #10, 2026-08-11 检查复现分布)。
 *
 * 存储: bun:sqlite + WAL, `.omd/plan-ledger.db` (gitignored)。**db 是可重建投影**, 真相源 =
 * continuity/<runId>/_dag.json (plan 全量 + taskText, 缺口①); rebuild() 扫目录重建。
 *
 * family 聚类 (A2 自举悖论的修复 — 不聚类则单 plan runs 永≈1, runs≥2 闸永不开):
 *   归一化精确匹配快路 → 全表字符 bigram Jaccard ≥ 0.8 并族 → 未中开新族。
 *   实装偏离 SDD 一处: 不用 FTS5 做候选 (unicode61 对 CJK 整段一 token, 检索质量差;
 *   个人规模 family ≤ 数百, 全表扫 + bigram Jaccard 更准更简 — ponytail 判断)。
 *
 * 版本去重: plan_hash = sha256(稳定序列化 plan)。同 family 同 hash → 同版本行计数++;
 * 结构不同 → 新版本 (parent 链)。conductor 非确定性 → 同任务可产多版本, 各记各的战绩,
 * Phase B 召回取战绩达标的最新版。
 *
 * ok 判定 (A3 verdict 闸空转的修复 — MCP 路径无 verifier, "pass 才入账"=账本永空):
 *   ok = verifier pass ∨ (无 verifier ∧ 全叶 done); verified 布尔留强弱信号痕。
 */
import { Database } from 'bun:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { logger } from './logger';

/** 并族阈值: 字符 bigram Jaccard ≥ 0.8 = 同 family (近同文本; 同参重放的匹配前提)。 */
const FAMILY_JACCARD_THRESHOLD = 0.8;

export interface PlanRecordInput {
  /** 用户任务原文 (family 聚类键)。空/缺 → 不记账 (无匹配键)。 */
  taskText: string;
  /** 完整 ConductorPlan (结构面, 同 DagMetadata.plan)。 */
  plan: { name: string; description?: string; nodes: Record<string, unknown> };
  /** 本次 run 是否成功 (verifier pass ∨ 无 verifier ∧ 全叶 done)。 */
  ok: boolean;
  /** 是否有 verifier 背书 (强信号) — 区分弱信号 ok (全叶 done 而已)。 */
  verified: boolean;
  /** 本次 run 总成本 (USD, computeCost 累加; unpriced 计 0)。 */
  costUsd?: number;
  /** DAG 形态签名 (computeDagGeneration)。 */
  generation?: string;
}

export interface PlanRecordResult {
  familyId: string;
  planId: string;
  version: number;
  newFamily: boolean;
  newVersion: boolean;
}

export interface FamilyEntry {
  id: string;
  canonicalTask: string;
  runs: number;
  okRuns: number;
  retired: boolean;
  versions: number;
  createdAt: string;
}

export interface PlanEntry {
  id: string;
  familyId: string;
  version: number;
  parentId: string | null;
  verified: boolean;
  runs: number;
  okRuns: number;
  totalCostUsd: number;
  generation: string | null;
  createdAt: string;
}

export interface PlanLedger {
  /** 记一笔 run。taskText 空 → null (不记账)。永不抛 (fail-open, 记账不许扰动执行)。 */
  record(input: PlanRecordInput): PlanRecordResult | null;
  /** 列 family (战绩降序) — omd_plans 数据源 + Phase B 证据门仪表。 */
  families(): FamilyEntry[];
  /** 列一族的版本链 (version 升序)。 */
  plans(familyId: string): PlanEntry[];
  /** 取一版的完整 plan JSON (Phase B 重放取图; Phase A 仅审计用)。 */
  planJson(planId: string): string | null;
  /** 从 continuity 目录全量重建 (drop + rescan; db 是投影, 真相在 _dag.json)。返重建笔数。 */
  rebuild(continuityDir: string): number;
  close(): void;
}

// ---------------------------------------------------------------------------
// 纯函数 (导出可测): 归一化 / bigram Jaccard / 稳定序列化 hash
// ---------------------------------------------------------------------------

/**
 * 任务文本归一化: 小写 + **移除全部空白**。匹配键不需要词边界 —— CJK 混排里 "的 diff 并" vs
 * "的diff并" 若只折叠空白, bigram 集合差异会把同任务打到 0.68 (<0.8 阈值, 测试实测); 全移则精确命中。
 * 展示仍用 canonical_task 原文。
 */
export function normalizeTask(text: string): string {
  return text.toLowerCase().replace(/\s+/g, '');
}

/** 字符 bigram 集 (CJK 安全 — 不依赖分词)。长度<2 → 单字符集。 */
function bigrams(s: string): Set<string> {
  if (s.length < 2) return new Set(s ? [s] : []);
  const out = new Set<string>();
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
  return out;
}

/** 字符 bigram Jaccard 相似度 ∈ [0,1]。 */
export function taskSimilarity(a: string, b: string): number {
  const A = bigrams(normalizeTask(a));
  const B = bigrams(normalizeTask(b));
  if (A.size === 0 && B.size === 0) return 1;
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return inter / (A.size + B.size - inter);
}

/** 递归 key 排序的稳定 JSON 序列化 (plan_hash 输入; JSON.stringify 键序不稳)。 */
function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const keys = Object.keys(v as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((v as Record<string, unknown>)[k])}`).join(',')}}`;
}

/** plan 结构 hash (版本去重键)。 */
export function planHash(plan: PlanRecordInput['plan']): string {
  return createHash('sha256').update(stableStringify(plan)).digest('hex').slice(0, 16);
}

// ---------------------------------------------------------------------------
// ledger
// ---------------------------------------------------------------------------

export interface PlanLedgerOpts {
  /** db 路径。默认 .omd/plan-ledger.db (cwd 相对)。 */
  path?: string;
  /** 注入 db (测试 :memory:)。 */
  db?: Database;
}

export function createPlanLedger(opts: PlanLedgerOpts = {}): PlanLedger {
  const path = opts.path ?? join('.omd', 'plan-ledger.db');
  if (!opts.db) mkdirSync(dirname(path), { recursive: true });
  const db = opts.db ?? new Database(path);
  db.run('PRAGMA journal_mode = WAL');
  db.run(`
    CREATE TABLE IF NOT EXISTS plan_families (
      id TEXT PRIMARY KEY,
      canonical_task TEXT NOT NULL,
      normalized_task TEXT NOT NULL,
      runs INTEGER NOT NULL DEFAULT 0,
      ok_runs INTEGER NOT NULL DEFAULT 0,
      retired INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS plan_versions (
      id TEXT PRIMARY KEY,
      family_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      parent_id TEXT,
      plan_json TEXT NOT NULL,
      plan_hash TEXT NOT NULL,
      generation TEXT,
      verified INTEGER NOT NULL DEFAULT 0,
      runs INTEGER NOT NULL DEFAULT 0,
      ok_runs INTEGER NOT NULL DEFAULT 0,
      total_cost_usd REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    )
  `);
  db.run('CREATE INDEX IF NOT EXISTS idx_plan_versions_family ON plan_versions(family_id, version)');

  const qAllFamilies = db.query(
    'SELECT id, canonical_task, normalized_task FROM plan_families WHERE retired = 0',
  );
  const qFamilyByNorm = db.query('SELECT id FROM plan_families WHERE normalized_task = ? LIMIT 1');
  const qInsertFamily = db.query(
    'INSERT INTO plan_families (id, canonical_task, normalized_task, runs, ok_runs, retired, created_at) VALUES (?, ?, ?, 0, 0, 0, ?)',
  );
  const qBumpFamily = db.query('UPDATE plan_families SET runs = runs + 1, ok_runs = ok_runs + ? WHERE id = ?');
  const qPlanByHash = db.query('SELECT id, version FROM plan_versions WHERE family_id = ? AND plan_hash = ? LIMIT 1');
  const qLatestVersion = db.query(
    'SELECT id, version FROM plan_versions WHERE family_id = ? ORDER BY version DESC LIMIT 1',
  );
  const qInsertPlan = db.query(
    `INSERT INTO plan_versions (id, family_id, version, parent_id, plan_json, plan_hash, generation, verified, runs, ok_runs, total_cost_usd, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
  );
  const qBumpPlan = db.query(
    'UPDATE plan_versions SET runs = runs + 1, ok_runs = ok_runs + ?, total_cost_usd = total_cost_usd + ?, verified = max(verified, ?) WHERE id = ?',
  );

  /** family 匹配: 归一化精确快路 → 全表 bigram Jaccard ≥0.8 择最高 → null。 */
  function matchFamily(normalized: string): string | null {
    const exact = qFamilyByNorm.get(normalized) as { id: string } | null;
    if (exact) return exact.id;
    let bestId: string | null = null;
    let bestScore = 0;
    for (const row of qAllFamilies.all() as { id: string; normalized_task: string }[]) {
      const score = taskSimilarity(normalized, row.normalized_task);
      if (score > bestScore) {
        bestScore = score;
        bestId = row.id;
      }
    }
    return bestScore >= FAMILY_JACCARD_THRESHOLD ? bestId : null;
  }

  return {
    record(input) {
      try {
        const taskText = input.taskText?.trim();
        if (!taskText) return null;
        const normalized = normalizeTask(taskText);
        const now = new Date().toISOString();
        const okInc = input.ok ? 1 : 0;
        const cost = Number.isFinite(input.costUsd) ? (input.costUsd as number) : 0;

        let familyId = matchFamily(normalized);
        const newFamily = familyId === null;
        if (familyId === null) {
          familyId = randomUUID();
          qInsertFamily.run(familyId, taskText, normalized, now);
        }
        qBumpFamily.run(okInc, familyId);

        const hash = planHash(input.plan);
        const existing = qPlanByHash.get(familyId, hash) as { id: string; version: number } | null;
        if (existing) {
          qBumpPlan.run(okInc, cost, input.verified ? 1 : 0, existing.id);
          return { familyId, planId: existing.id, version: existing.version, newFamily, newVersion: false };
        }
        const latest = qLatestVersion.get(familyId) as { id: string; version: number } | null;
        const version = (latest?.version ?? 0) + 1;
        const planId = randomUUID();
        qInsertPlan.run(
          planId, familyId, version, latest?.id ?? null,
          JSON.stringify(input.plan), hash, input.generation ?? null,
          input.verified ? 1 : 0, okInc, cost, now,
        );
        return { familyId, planId, version, newFamily, newVersion: true };
      } catch (e) {
        // 记账 fail-open: 账本故障不许扰动 dag_run 主路径。
        logger.warn({ err: (e as Error).message }, '[omd/plan-ledger] record 失败 (fail-open)');
        return null;
      }
    },

    families() {
      const rows = db
        .query(
          `SELECT f.id, f.canonical_task, f.runs, f.ok_runs, f.retired, f.created_at,
                  (SELECT count(*) FROM plan_versions v WHERE v.family_id = f.id) AS versions
           FROM plan_families f ORDER BY f.runs DESC, f.created_at ASC`,
        )
        .all() as Array<{ id: string; canonical_task: string; runs: number; ok_runs: number; retired: number; created_at: string; versions: number }>;
      return rows.map((r) => ({
        id: r.id, canonicalTask: r.canonical_task, runs: r.runs, okRuns: r.ok_runs,
        retired: r.retired === 1, versions: r.versions, createdAt: r.created_at,
      }));
    },

    plans(familyId) {
      const rows = db
        .query(
          `SELECT id, family_id, version, parent_id, verified, runs, ok_runs, total_cost_usd, generation, created_at
           FROM plan_versions WHERE family_id = ? ORDER BY version ASC`,
        )
        .all(familyId) as Array<{ id: string; family_id: string; version: number; parent_id: string | null; verified: number; runs: number; ok_runs: number; total_cost_usd: number; generation: string | null; created_at: string }>;
      return rows.map((r) => ({
        id: r.id, familyId: r.family_id, version: r.version, parentId: r.parent_id,
        verified: r.verified === 1, runs: r.runs, okRuns: r.ok_runs,
        totalCostUsd: r.total_cost_usd, generation: r.generation, createdAt: r.created_at,
      }));
    },

    planJson(planId) {
      const row = db.query('SELECT plan_json FROM plan_versions WHERE id = ?').get(planId) as { plan_json: string } | null;
      return row?.plan_json ?? null;
    },

    rebuild(continuityDir) {
      db.run('DELETE FROM plan_versions');
      db.run('DELETE FROM plan_families');
      if (!existsSync(continuityDir)) return 0;
      let n = 0;
      // 按 createdAt 升序回放 (family 计数器语义与在线记账一致)。ok/verified/cost 不在 _dag.json
      // (那是完成态信息, 记账时来自 result) → 重建走弱口径: 全绿节点检查不可得, 记 ok=true/verified=false/cost=0。
      // 重建仅恢复图资产与族谱, 战绩以在线记账为准 — 文档同 SDD "db 是投影"。
      const metas: Array<{ taskText: string; plan: PlanRecordInput['plan']; generation?: string; createdAt: string }> = [];
      for (const dir of readdirSync(continuityDir)) {
        const p = join(continuityDir, dir, '_dag.json');
        try {
          if (!existsSync(p)) continue;
          const meta = JSON.parse(readFileSync(p, 'utf8')) as { plan?: PlanRecordInput['plan']; taskText?: string; generation?: string; createdAt?: string };
          if (!meta.plan || !meta.taskText) continue; // 旧 schema (缺口①前) → 不可重建, 跳过
          metas.push({ taskText: meta.taskText, plan: meta.plan, ...(meta.generation ? { generation: meta.generation } : {}), createdAt: meta.createdAt ?? '' });
        } catch {
          /* 坏 JSON → 跳过 (fail-open) */
        }
      }
      metas.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      for (const m of metas) {
        const r = this.record({ taskText: m.taskText, plan: m.plan, ok: true, verified: false, ...(m.generation ? { generation: m.generation } : {}) });
        if (r) n++;
      }
      return n;
    },

    close() {
      db.close();
    },
  };
}
