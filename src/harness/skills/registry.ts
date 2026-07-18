/**
 * src/harness/skills/registry — omd 技能系统 sqlite 复利 substrate (Phase 1)。
 *
 * 四元统一 (skills/genes/facts-link/evolution_events) 焊在一个 bun:sqlite 上, 作 curator/dream
 * 跨实体复用的物理载体 (见 docs/plan/omd-curator-dream-adapters.md)。Phase 1 = **焊表 + 预埋
 * 接缝 + gene 迁移**, 进化机器 (SkillOpt/Dream proposer/decay) 全不自动跑 (Phase 2 激活)。
 *
 * 约定对齐 src/harness/memory/store.ts: bun:sqlite · CREATE TABLE IF NOT EXISTS in ctor · FTS5 ·
 * { path?, db? } options (可与 ValalMemory 共享同一 Database)。
 *
 * 不耦合 pi: registry 是**影子元数据** (给我们的 curator/evolution 用); pi 仍管 prompt 组装,
 * DMI 走 SKILL.md frontmatter (Phase 1 lark router 已证)。registry 不取代 pi 的 skill 发现。
 */
import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';

export type SkillTier = 'core' | 'on-demand' | 'quarantine' | 'tombstone';
export type EvolutionEventType =
  | 'route_hit' | 'held_out_delta' | 'grounded_label' | 'dmi_change' | 'version_bump'
  // Phase 1 (skill-creator 飞轮): 真有 writer 才加 (anti-slop 无消费者不建)。
  // description_trigger_delta = skill-creator run_eval.py 的 trigger-rate delta (T2 机械, 非 LLM 自评)。
  // eval_fixture_generated   = eval-generate 起草 eval fixture 的留痕。
  | 'description_trigger_delta' | 'eval_fixture_generated';

export interface SkillRow {
  id: string;
  name: string;
  description: string;
  version: number;
  tier: SkillTier;
  status: string;
  dmi: number;            // 0|1 — 进 prompt 与否 (frontmatter disable-model-invocation 镜像)
  skillopt_on: number;    // 0|1 — opt-in 自动 edit (默认关 SK-INV-5)
  has_body: number;
  has_eval: number;
  rare_critical: number;
  origin: 'human' | 'dream-proposed';
  // provenance (Phase 1): vendored 第三方溯源。null = 第一方 omd skill。
  // 与 origin 正交: origin=谁建 registry 条目(human/dream); upstream_*=磁盘文件来自哪个上游。
  upstream_repo: string | null;
  license: string | null;
  upstream_commit: string | null;
  use_count: number;
  last_used_at: number | null;
  created_at: number;
}

/** eval/触发样例 (skill-creator train/test split 的素材)。skill_id = TEXT (skills.id 是 TEXT)。 */
export interface SkillExampleRow {
  id: number;
  skill_id: string;
  query: string;
  label: 'positive' | 'negative';
  created_at: number;
}

export interface GeneRow {
  gene_id: number;
  gene_key: string;       // 原 JSON 的 string id (gene_proxy_...)
  category: 'repair' | 'optimize' | 'innovate';
  signals_match: string;  // JSON array
  strategy: string;       // JSON array
  constraints: string;    // JSON
  validation: string;     // JSON array
  applies_to: string;     // JSON array
  use_count: number;
  status: string;
  human_approved: number;
  last_used_at: number | null;
  created_at: number;
}

export interface SkillRegistryOptions {
  /** SQLite file path. Default ':memory:' (ephemeral). */
  path?: string;
  /** Pre-opened Database (overrides path) — 与 ValalMemory 共享同一 sqlite。 */
  db?: Database;
}

const now = (): number => Math.floor(Date.now());

export class SkillRegistry {
  readonly db: Database;

  constructor(opts: SkillRegistryOptions = {}) {
    this.db = opts.db ?? new Database(opts.path ?? ':memory:');
    this.db.run('PRAGMA journal_mode = WAL');
    this.db.run('PRAGMA foreign_keys = ON');
    this.init();
  }

  private init(): void {
    // 技能注册表 (主表) — 运行时元数据, 不含 body/eval (那是文件)
    this.db.run(`
      CREATE TABLE IF NOT EXISTS skills (
        id            TEXT PRIMARY KEY,
        name          TEXT NOT NULL UNIQUE,
        description   TEXT NOT NULL DEFAULT '',
        version       INTEGER NOT NULL DEFAULT 1,
        tier          TEXT NOT NULL DEFAULT 'on-demand'
                        CHECK(tier IN ('core','on-demand','quarantine','tombstone')),
        status        TEXT NOT NULL DEFAULT 'active',
        dmi           INTEGER NOT NULL DEFAULT 1,
        skillopt_on   INTEGER NOT NULL DEFAULT 0,
        has_body      INTEGER NOT NULL DEFAULT 0,
        has_eval      INTEGER NOT NULL DEFAULT 0,
        rare_critical INTEGER NOT NULL DEFAULT 0,
        origin        TEXT NOT NULL DEFAULT 'human'
                        CHECK(origin IN ('human','dream-proposed')),
        upstream_repo   TEXT,
        license         TEXT,
        upstream_commit TEXT,
        use_count     INTEGER NOT NULL DEFAULT 0,
        last_used_at  INTEGER,
        created_at    INTEGER NOT NULL
      )`);

    // eval/触发样例 (skill-creator train60/test40 素材)。created_at = INTEGER epoch ms (全 substrate 约定)。
    this.db.run(`
      CREATE TABLE IF NOT EXISTS skill_examples (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        skill_id    TEXT NOT NULL REFERENCES skills(id),
        query       TEXT NOT NULL,
        label       TEXT NOT NULL DEFAULT 'positive' CHECK(label IN ('positive','negative')),
        created_at  INTEGER NOT NULL,
        UNIQUE(skill_id, query)
      )`);

    // 技能版本历史 (进化记录 — held-out delta)
    this.db.run(`
      CREATE TABLE IF NOT EXISTS skill_versions (
        version_id  INTEGER PRIMARY KEY AUTOINCREMENT,
        skill_id    TEXT NOT NULL REFERENCES skills(id),
        version_num INTEGER NOT NULL,
        delta_score REAL,
        change_desc TEXT,
        status      TEXT NOT NULL DEFAULT 'active',
        created_at  INTEGER NOT NULL
      )`);

    // 基因模板库 (从 gene-library.json 迁入)
    this.db.run(`
      CREATE TABLE IF NOT EXISTS genes (
        gene_id        INTEGER PRIMARY KEY AUTOINCREMENT,
        gene_key       TEXT NOT NULL UNIQUE,
        category       TEXT NOT NULL CHECK(category IN ('repair','optimize','innovate')),
        signals_match  TEXT NOT NULL DEFAULT '[]',
        strategy       TEXT NOT NULL DEFAULT '[]',
        constraints    TEXT NOT NULL DEFAULT '{}',
        validation     TEXT NOT NULL DEFAULT '[]',
        applies_to     TEXT NOT NULL DEFAULT '[]',
        use_count      INTEGER NOT NULL DEFAULT 0,
        status         TEXT NOT NULL DEFAULT 'active',
        human_approved INTEGER NOT NULL DEFAULT 0,
        last_used_at   INTEGER,
        created_at     INTEGER NOT NULL
      )`);
    // FTS5: 失败信号 → 召回 gene (复用的命门, BM25)
    this.db.run(
      `CREATE VIRTUAL TABLE IF NOT EXISTS genes_fts USING fts5(gene_key UNINDEXED, signals_match, strategy)`,
    );

    // 进化事件流 (route_hit/held_out_delta/grounded_label/dmi_change)
    this.db.run(`
      CREATE TABLE IF NOT EXISTS skill_evolution_events (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        skill_id    TEXT NOT NULL,
        event_type  TEXT NOT NULL
                      CHECK(event_type IN ('route_hit','held_out_delta','grounded_label','dmi_change','version_bump','description_trigger_delta','eval_fixture_generated')),
        delta_value REAL,
        metadata    TEXT,
        created_at  INTEGER NOT NULL
      )`);

    // 桥表 (复利飞轮的连接组织) — Phase 1 预埋, Phase 2 填
    this.db.run(`
      CREATE TABLE IF NOT EXISTS skill_gene_links (
        skill_id TEXT NOT NULL,
        gene_id  INTEGER NOT NULL,
        relation TEXT NOT NULL CHECK(relation IN ('derived_from','applied_to','informed_by')),
        PRIMARY KEY(skill_id, gene_id, relation)
      )`);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS skill_fact_links (
        skill_id TEXT NOT NULL,
        fact_id  TEXT NOT NULL,
        role     TEXT NOT NULL CHECK(role IN ('input','output','context','result')),
        PRIMARY KEY(skill_id, fact_id, role)
      )`);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS gene_fact_links (
        gene_id  INTEGER NOT NULL,
        fact_id  TEXT NOT NULL,
        relation TEXT NOT NULL CHECK(relation IN ('source_pattern','produced','validated_by')),
        PRIMARY KEY(gene_id, fact_id, relation)
      )`);
  }

  // ── skills ────────────────────────────────────────────────────────────────

  /** upsert by name; 保留 use_count/last_used_at (运行时字段不被加载覆盖)。 */
  upsertSkill(s: {
    id: string; name: string; description?: string; version?: number; tier?: SkillTier;
    dmi?: number; skillopt_on?: number; has_body?: number; has_eval?: number;
    rare_critical?: number; origin?: 'human' | 'dream-proposed';
    upstream_repo?: string | null; license?: string | null; upstream_commit?: string | null;
  }): void {
    this.db.run(
      `INSERT INTO skills (id,name,description,version,tier,dmi,skillopt_on,has_body,has_eval,rare_critical,origin,upstream_repo,license,upstream_commit,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(name) DO UPDATE SET
         description=excluded.description, version=excluded.version, tier=excluded.tier,
         dmi=excluded.dmi, has_body=excluded.has_body, has_eval=excluded.has_eval,
         rare_critical=excluded.rare_critical, upstream_repo=excluded.upstream_repo,
         license=excluded.license, upstream_commit=excluded.upstream_commit`,
      [
        s.id, s.name, s.description ?? '', s.version ?? 1, s.tier ?? 'on-demand',
        s.dmi ?? 1, s.skillopt_on ?? 0, s.has_body ?? 0, s.has_eval ?? 0,
        s.rare_critical ?? 0, s.origin ?? 'human',
        s.upstream_repo ?? null, s.license ?? null, s.upstream_commit ?? null, now(),
      ],
    );
  }

  /** 幂等批量写 eval 样例 (UNIQUE(skill_id,query) → 重复 query no-op)。返回新增条数。 */
  upsertSkillExamples(skillId: string, examples: { query: string; label?: 'positive' | 'negative' }[]): number {
    let added = 0;
    const t = now();
    const tx = this.db.transaction(() => {
      for (const e of examples) {
        const q = e.query.trim();
        if (!q) continue;
        const info = this.db.run(
          `INSERT OR IGNORE INTO skill_examples (skill_id,query,label,created_at) VALUES (?,?,?,?)`,
          [skillId, q, e.label ?? 'positive', t],
        );
        if (info.changes > 0) added++;
      }
    });
    tx();
    return added;
  }

  listSkillExamples(skillId: string): SkillExampleRow[] {
    return this.db
      .query(`SELECT * FROM skill_examples WHERE skill_id = ? ORDER BY id`)
      .all(skillId) as SkillExampleRow[];
  }

  getSkill(name: string): SkillRow | null {
    return (this.db.query(`SELECT * FROM skills WHERE name = ?`).get(name) as SkillRow) ?? null;
  }

  listSkills(opts: { tier?: SkillTier; visibleOnly?: boolean } = {}): SkillRow[] {
    const where: string[] = [`status = 'active'`];
    if (opts.tier) where.push(`tier = '${opts.tier}'`);
    if (opts.visibleOnly) where.push(`dmi = 0`);
    return this.db.query(`SELECT * FROM skills WHERE ${where.join(' AND ')} ORDER BY name`).all() as SkillRow[];
  }

  /** tier 变更 (proposer 升级 quarantine→on-demand; dmi 同步可选)。 */
  setSkillTier(id: string, tier: SkillTier, dmi?: number): void {
    if (dmi === undefined) this.db.run(`UPDATE skills SET tier = ? WHERE id = ?`, [tier, id]);
    else this.db.run(`UPDATE skills SET tier = ?, dmi = ? WHERE id = ?`, [tier, dmi, id]);
  }

  /** 软删 (curator tombstone): status='tombstone' → 退出 listSkills(active)。可逆 (restoreSkill)。 */
  tombstoneSkill(id: string): void {
    this.db.run(`UPDATE skills SET status='tombstone' WHERE id = ?`, [id]);
  }

  /** 复活 (curate SHRINK-1 rollback / 人工回退): status='active'。 */
  restoreSkill(id: string): void {
    this.db.run(`UPDATE skills SET status='active' WHERE id = ?`, [id]);
  }

  /** route_hit: use_count++ + last_used_at + 事件流 (复利飞轮入口)。 */
  touchSkill(name: string): void {
    const t = now();
    const tx = this.db.transaction(() => {
      this.db.run(`UPDATE skills SET use_count = use_count + 1, last_used_at = ? WHERE name = ?`, [t, name]);
      const row = this.db.query(`SELECT id FROM skills WHERE name = ?`).get(name) as { id: string } | null;
      if (row) this.recordEvent(row.id, 'route_hit');
    });
    tx();
  }

  /** 某 skill 某事件类型的最新 delta_value (null = 无该类事件)。action-driver 看 delta 退化用。 */
  latestEventDelta(skillId: string, type: EvolutionEventType): number | null {
    const row = this.db
      .query(`SELECT delta_value FROM skill_evolution_events WHERE skill_id=? AND event_type=? ORDER BY id DESC LIMIT 1`)
      .get(skillId, type) as { delta_value: number | null } | null;
    return row?.delta_value ?? null;
  }

  recordEvent(skillId: string, type: EvolutionEventType, delta?: number, metadata?: unknown): void {
    this.db.run(
      `INSERT INTO skill_evolution_events (skill_id,event_type,delta_value,metadata,created_at) VALUES (?,?,?,?,?)`,
      [skillId, type, delta ?? null, metadata != null ? JSON.stringify(metadata) : null, now()],
    );
  }

  /**
   * decay 候选 (SK-INV-7/10): freq=0/90d, 非 core, 非 rare_critical → tombstone 建议。**只查不删**。
   * created_at-floor (跨 adapter 统一): 用 COALESCE(last_used_at, created_at) —— **新载入但从未用**的项给
   * created_at 当宽限基准 (而非 last_used_at IS NULL 即判 stale), 避免 fresh 项被立即误退役。
   * nowMs 可注入 (测试确定性; 默认真 now)。
   */
  decayCandidates(staleDays = 90, nowMs: number = now()): SkillRow[] {
    const cutoff = nowMs - staleDays * 86_400_000;
    return this.db
      .query(
        `SELECT * FROM skills WHERE status='active' AND tier NOT IN ('core')
           AND rare_critical = 0 AND COALESCE(last_used_at, created_at) < ?`,
      )
      .all(cutoff) as SkillRow[];
  }

  // ── genes ─────────────────────────────────────────────────────────────────

  /** 从 gene-library.json 迁入 (幂等: gene_key UNIQUE)。返回新增条数。 */
  migrateGenesFromJson(jsonPath: string): number {
    const parsed = JSON.parse(readFileSync(jsonPath, 'utf8')) as { genes?: unknown[] };
    const genes = parsed.genes ?? [];
    let added = 0;
    const tx = this.db.transaction(() => {
      for (const g of genes as Record<string, unknown>[]) {
        const key = String(g.id ?? '');
        if (!key) continue;
        const exists = this.db.query(`SELECT 1 FROM genes WHERE gene_key = ?`).get(key);
        if (exists) continue;
        const constraints = (g.constraints ?? {}) as Record<string, unknown>;
        const humanApproved = constraints.requires_human_approval === false ? 1 : 0;
        const info = this.db.run(
          `INSERT INTO genes (gene_key,category,signals_match,strategy,constraints,validation,applies_to,human_approved,created_at)
           VALUES (?,?,?,?,?,?,?,?,?)`,
          [
            key, String(g.category ?? 'repair'),
            JSON.stringify(g.signals_match ?? []), JSON.stringify(g.strategy ?? []),
            JSON.stringify(g.constraints ?? {}), JSON.stringify(g.validation ?? []),
            JSON.stringify(g.applies_to ?? []), humanApproved, now(),
          ],
        );
        this.db.run(
          `INSERT INTO genes_fts (rowid,gene_key,signals_match,strategy) VALUES (?,?,?,?)`,
          [
            Number(info.lastInsertRowid), key,
            (g.signals_match as string[] ?? []).join(' '), (g.strategy as string[] ?? []).join(' '),
          ],
        );
        added++;
      }
    });
    tx();
    return added;
  }

  /** FTS5 BM25 召回匹配 gene (复用命门: 失败信号 → 相关 gene)。 */
  searchGenes(query: string, limit = 5): GeneRow[] {
    // sanitise: FTS5 syntax chars → 空格, 拆词 OR 连接 (弱模型容错)
    const terms = query.replace(/[^\p{L}\p{N}_-]+/gu, ' ').trim().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return [];
    const match = terms.map((t) => `"${t}"`).join(' OR ');
    return this.db
      .query(
        `SELECT g.* FROM genes_fts f JOIN genes g ON g.gene_id = f.rowid
           WHERE genes_fts MATCH ? AND g.status='active' ORDER BY rank LIMIT ?`,
      )
      .all(match, limit) as GeneRow[];
  }

  geneCount(): number {
    return (this.db.query(`SELECT count(*) AS n FROM genes`).get() as { n: number }).n;
  }

  /** 拉 active gene (curate 输入)。 */
  listGenes(opts: { activeOnly?: boolean } = {}): GeneRow[] {
    const where = opts.activeOnly === false ? '' : `WHERE status='active'`;
    return this.db.query(`SELECT * FROM genes ${where} ORDER BY gene_id`).all() as GeneRow[];
  }

  /** route_hit on gene: use_count++ + last_used_at (gene 复用飞轮入口)。 */
  touchGene(geneId: number): void {
    this.db.run(`UPDATE genes SET use_count = use_count + 1, last_used_at = ? WHERE gene_id = ?`, [now(), geneId]);
  }

  /** 软删 (curator tombstone): status='deprecated' → 退出 listGenes(active)。可逆。 */
  deprecateGene(geneId: number): void {
    this.db.run(`UPDATE genes SET status='deprecated' WHERE gene_id = ?`, [geneId]);
  }

  /** 复活 (curate rollback / 人工回退): status='active'。 */
  reactivateGene(geneId: number): void {
    this.db.run(`UPDATE genes SET status='active' WHERE gene_id = ?`, [geneId]);
  }

  // ── 桥 (Phase 1 预埋接缝) ───────────────────────────────────────────────────

  linkSkillGene(skillId: string, geneId: number, relation: 'derived_from' | 'applied_to' | 'informed_by'): void {
    this.db.run(
      `INSERT OR IGNORE INTO skill_gene_links (skill_id,gene_id,relation) VALUES (?,?,?)`,
      [skillId, geneId, relation],
    );
  }

  close(): void {
    this.db.close();
  }
}
