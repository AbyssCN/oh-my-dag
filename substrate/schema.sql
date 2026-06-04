-- wright-skills substrate schema (从 SkillRegistry 实例 dump, 真理源)
-- 改 src/wright/skills/registry.ts 的 CREATE TABLE → 重跑导出自动同步。

CREATE TABLE gene_fact_links (
        gene_id  INTEGER NOT NULL,
        fact_id  TEXT NOT NULL,
        relation TEXT NOT NULL CHECK(relation IN ('source_pattern','produced','validated_by')),
        PRIMARY KEY(gene_id, fact_id, relation)
      );

CREATE TABLE genes (
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
      );

CREATE VIRTUAL TABLE genes_fts USING fts5(gene_key UNINDEXED, signals_match, strategy);

CREATE TABLE skill_evolution_events (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        skill_id    TEXT NOT NULL,
        event_type  TEXT NOT NULL
                      CHECK(event_type IN ('route_hit','held_out_delta','grounded_label','dmi_change','version_bump','description_trigger_delta','eval_fixture_generated')),
        delta_value REAL,
        metadata    TEXT,
        created_at  INTEGER NOT NULL
      );

CREATE TABLE skill_examples (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        skill_id    TEXT NOT NULL REFERENCES skills(id),
        query       TEXT NOT NULL,
        label       TEXT NOT NULL DEFAULT 'positive' CHECK(label IN ('positive','negative')),
        created_at  INTEGER NOT NULL,
        UNIQUE(skill_id, query)
      );

CREATE TABLE skill_fact_links (
        skill_id TEXT NOT NULL,
        fact_id  TEXT NOT NULL,
        role     TEXT NOT NULL CHECK(role IN ('input','output','context','result')),
        PRIMARY KEY(skill_id, fact_id, role)
      );

CREATE TABLE skill_gene_links (
        skill_id TEXT NOT NULL,
        gene_id  INTEGER NOT NULL,
        relation TEXT NOT NULL CHECK(relation IN ('derived_from','applied_to','informed_by')),
        PRIMARY KEY(skill_id, gene_id, relation)
      );

CREATE TABLE skill_versions (
        version_id  INTEGER PRIMARY KEY AUTOINCREMENT,
        skill_id    TEXT NOT NULL REFERENCES skills(id),
        version_num INTEGER NOT NULL,
        delta_score REAL,
        change_desc TEXT,
        status      TEXT NOT NULL DEFAULT 'active',
        created_at  INTEGER NOT NULL
      );

CREATE TABLE skills (
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
      );
