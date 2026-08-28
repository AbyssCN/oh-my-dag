#!/usr/bin/env bun
/**
 * scripts/omd-migrate-handoff —— 把 `namespace='continuity'` 的会话交接镜像从共享
 * `memory.db` 搬到交接专库 `handoff.db`(2026-08-28 分库的数据半边)。
 *
 * 代码半边已经改完(`resolveHandoffDbPath`),**新**写入直接进专库;本脚本管**既有行**。
 * 不搬也不会坏:`HOST_SAFEGUARD` 仍带 continuity 分支,老行照样 parse 得动 —— 只是它们会
 * 继续占着 `retrieve` 的候选池(实测 73k 行时一次召回 379–429ms, 且 top-3 常被它们占满)。
 *
 * ## 三个刻意的选择
 *
 * ① **默认 dry-run**。删行是不可逆的, 判据不该由脚本自己下。`--apply` 才真动。
 * ② **先拷贝并核对, 再删**。核对不过 ⇒ 一行都不删, 非零退出。拷贝用 `INSERT OR IGNORE`
 *    按 id 幂等 —— 中途挂掉重跑不会产生重复行。
 * ③ **tombstone 行照搬**。软删的 payload 是 `collectIdentityEvidence` 的证据账本,
 *    "反正是删掉的"就地丢弃 = 把账本销毁一半。它们在目标库同样不进 FTS(与 `tombstone()` 一致)。
 *
 * ```bash
 * bun run scripts/omd-migrate-handoff.ts --cwd .            # 看看会搬多少
 * bun run scripts/omd-migrate-handoff.ts --cwd . --apply    # 真搬
 * bun run scripts/omd-migrate-handoff.ts --from ~/.omd/memory.db --to ~/.omd/handoff.db --apply --vacuum
 * ```
 *
 * @module
 */
import '../src/harness/script-bootstrap';
import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { createOmdMemory } from '../src/harness/memory';
import { resolveMemoryDbPath, resolveHandoffDbPath } from '../src/harness/memory/db-path';
import { CONTINUITY_SAFEGUARD } from '../src/memory/safeguards/continuity-namespace';

const NS = 'continuity';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const has = (name: string): boolean => process.argv.includes(`--${name}`);

interface FactRow {
  id: string;
  namespace: string;
  identity_key: string;
  text: string;
  payload: string;
  embedding: Uint8Array;
  created_at: number;
  deleted_at: number | null;
  deleted_reason: string | null;
  superseded_by: string | null;
}

/** 目标库建表 = 直接构造一次 `OmdMemory`(建表逻辑只有一份, 不在这里复制 DDL)。 */
function ensureTargetSchema(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  createOmdMemory({ path, safeguard: CONTINUITY_SAFEGUARD }).close();
}

function sizeMb(path: string): string {
  try {
    return `${(statSync(path).size / 1024 / 1024).toFixed(1)}MB`;
  } catch {
    return 'n/a';
  }
}

const cwd = resolvePath(arg('cwd') ?? process.cwd());
const from = resolvePath(arg('from') ?? resolvePath(cwd, resolveMemoryDbPath(process.env)));
const to = resolvePath(arg('to') ?? resolvePath(cwd, resolveHandoffDbPath(process.env)));
const apply = has('apply');
const vacuum = has('vacuum');

if (from === to) {
  console.error(`[migrate-handoff] --from 与 --to 同一个文件 (${from}) → 拒绝`);
  process.exit(2);
}
if (!existsSync(from)) {
  console.log(`[migrate-handoff] 源库不存在: ${from} → 无事可做`);
  process.exit(0);
}

const src = new Database(from);
src.run('PRAGMA busy_timeout = 20000');

const total = (src.query(`SELECT count(*) n FROM facts WHERE namespace = ?`).get(NS) as { n: number }).n;
const live = (
  src.query(`SELECT count(*) n FROM facts WHERE namespace = ? AND deleted_at IS NULL`).get(NS) as { n: number }
).n;
const others = (src.query(`SELECT count(*) n FROM facts WHERE namespace != ?`).get(NS) as { n: number }).n;

console.log(`[migrate-handoff] 源 ${from} (${sizeMb(from)})`);
console.log(`[migrate-handoff]   continuity: ${total} 行 (live ${live} / tombstoned ${total - live})`);
console.log(`[migrate-handoff]   其余 namespace: ${others} 行 (不动)`);
console.log(`[migrate-handoff] 目标 ${to} (${sizeMb(to)})`);

if (total === 0) {
  console.log('[migrate-handoff] 没有 continuity 行 → 无事可做');
  src.close();
  process.exit(0);
}
if (!apply) {
  console.log(`[migrate-handoff] DRY-RUN — 加 --apply 才真搬。搬完源库将剩 ${others} 行。`);
  src.close();
  process.exit(0);
}

// ── 1. 拷贝(幂等) ────────────────────────────────────────────────────────────
ensureTargetSchema(to);
const dst = new Database(to);
dst.run('PRAGMA busy_timeout = 20000');
dst.run('PRAGMA journal_mode = WAL');

const rows = src.query(`SELECT * FROM facts WHERE namespace = ?`).all(NS) as FactRow[];
let copied = 0;
const copyTx = dst.transaction(() => {
  for (const r of rows) {
    const res = dst.run(
      `INSERT OR IGNORE INTO facts
         (id, namespace, identity_key, text, payload, embedding, created_at, deleted_at, deleted_reason, superseded_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        r.id,
        r.namespace,
        r.identity_key,
        r.text,
        r.payload,
        r.embedding,
        r.created_at,
        r.deleted_at,
        r.deleted_reason,
        r.superseded_by,
      ],
    );
    // changes===0 ⇒ 这一行上次已经搬过了(重跑), 那它的 FTS 也已经在, 不重复插。
    if (res.changes === 0) continue;
    copied++;
    // 与 `store.tombstone()` 一致: 软删行不进 FTS。
    if (r.deleted_at === null) dst.run(`INSERT INTO facts_fts (fact_id, text) VALUES (?, ?)`, [r.id, r.text]);
  }
});
copyTx();

// ── 2. 核对(不过就一行都不删) ────────────────────────────────────────────────
const placeholders = rows.map(() => '?').join(',');
const ids = rows.map((r) => r.id);
const present = (
  dst.query(`SELECT count(*) n FROM facts WHERE id IN (${placeholders})`).get(...ids) as { n: number }
).n;
if (present !== rows.length) {
  console.error(`[migrate-handoff] 核对失败: 目标库只找到 ${present}/${rows.length} 行 → 不删源库, 退出`);
  dst.close();
  src.close();
  process.exit(1);
}
console.log(`[migrate-handoff] 拷贝 ok — 本次新增 ${copied} 行, 目标库已含全部 ${present} 行`);

// ── 3. 删源(含 FTS 影子行) ──────────────────────────────────────────────────
const delTx = src.transaction(() => {
  src.run(`DELETE FROM facts_fts WHERE fact_id IN (SELECT id FROM facts WHERE namespace = ?)`, [NS]);
  src.run(`DELETE FROM facts WHERE namespace = ?`, [NS]);
});
delTx();
const left = (src.query(`SELECT count(*) n FROM facts WHERE namespace = ?`).get(NS) as { n: number }).n;
console.log(`[migrate-handoff] 源库已删 continuity, 剩 ${left} 行 (应为 0), 其余 namespace ${others} 行`);

if (vacuum) {
  console.log('[migrate-handoff] VACUUM 中(删行不还文件空间, 这一步才还)…');
  src.run('VACUUM');
}
dst.close();
src.close();
console.log(`[migrate-handoff] 完成。源 ${sizeMb(from)} · 目标 ${sizeMb(to)}${vacuum ? '' : ' (加 --vacuum 回收源库文件空间)'}`);
