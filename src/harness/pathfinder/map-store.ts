/**
 * src/harness/pathfinder/map-store —— markdown ↔ 内存 PathMap ↔ SQLite 三态互转 (组件 1, D-3)。
 *
 * D-3 存储契约: **markdown-in-git = 真相源** (docs/plan/pathfinder/<slug>.md, 耐久跨机, 人可读可编);
 * `.omd/pathfinder.db` = 本地前沿快查索引 (gitignore, **可从 md 重建**)。
 *
 * 纯/不纯分层 (SDD 测试接缝: md↔db 往返 property test):
 *  - renderMapMarkdown / parseMapMarkdown = **纯函数** (无磁盘), roundtrip 属性: parse(render(m)) ≡ m。
 *  - saveMapDb / loadMapDb / rebuildDbFromMarkdown = 落 bun:sqlite (镜像 dag-record.ts idiom)。
 *  - 路径 helper (mapMarkdownPath / defaultDbPath) 与纯 render/parse 分离, 便于无盘单测。
 *
 * markdown 格式选 byte-stable 的行式 kv (见下), 保证 render∘parse∘render 幂等。
 */
import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ExecutorKind, PathMap, Ticket, TicketStatus, TicketType } from './types';

// ── 路径 helper (与纯 render/parse 分离) ──────────────────────────────────────

/** markdown 真相文件路径: <cwd>/docs/plan/pathfinder/<slug>.md。 */
export function mapMarkdownPath(slug: string, cwd: string): string {
  return join(cwd, 'docs', 'plan', 'pathfinder', `${slug}.md`);
}

/** 本地索引 db 默认路径: <cwd>/.omd/pathfinder.db。 */
export function defaultDbPath(cwd: string): string {
  return join(cwd, '.omd', 'pathfinder.db');
}

// ── markdown render / parse (纯, byte-stable, roundtrip 属性) ─────────────────

/** 渲染的状态分组顺序 (固定 → byte-stable)。 */
const STATUS_ORDER: TicketStatus[] = ['open', 'blocked', 'ruled', 'escalated'];

/** 转义自由文本里的换行/反斜杠 (单遍, 与 unesc 互逆) → 保证一票一行不被撑破。 */
function esc(s: string): string {
  return s.replace(/[\\\n]/g, (c) => (c === '\n' ? '\\n' : '\\\\'));
}
function unesc(s: string): string {
  return s.replace(/\\(.)/g, (_, c: string) => (c === 'n' ? '\n' : c));
}

/** 渲染一张票为一段 markdown (稳定字段顺序; 可选字段缺则省行 → 区分 undefined 与空)。 */
function renderTicket(t: Ticket): string {
  const lines = [`### ${t.id}`, `- type: ${t.type}`, `- title: ${esc(t.title)}`, `- status: ${t.status}`, `- blockedBy: ${t.blockedBy.join(', ')}`];
  if (t.ruling !== undefined) lines.push(`- ruling: ${esc(t.ruling)}`);
  if (t.executorKind !== undefined) lines.push(`- executorKind: ${t.executorKind}`);
  if (t.children !== undefined) lines.push(`- children: ${t.children.join(', ')}`);
  if (t.dNumber !== undefined) lines.push(`- dNumber: ${t.dNumber}`);
  return lines.join('\n');
}

/**
 * PathMap → markdown (git-tracked 真相)。目的地表头 + 决策日志 + 票按 status 分组。
 * 票在各组内保持 map.tickets 原顺序。
 */
export function renderMapMarkdown(map: PathMap): string {
  const out: string[] = [`# Pathfinder: ${esc(map.destination)}`, '', `<!-- slug: ${map.slug} -->`, '', '## Decisions so far', ''];
  if (map.decisionsLog.length === 0) {
    out.push('_(none yet)_', '');
  } else {
    for (const d of map.decisionsLog) out.push(`- [${d.ticketId}] ${esc(d.gist)}`);
    out.push('');
  }
  out.push('## Tickets', '');
  for (const status of STATUS_ORDER) {
    const group = map.tickets.filter((t) => t.status === status);
    out.push(`### status: ${status}`, '');
    if (group.length === 0) {
      out.push('_(none)_', '');
    } else {
      for (const t of group) out.push(renderTicket(t), '');
    }
  }
  return out.join('\n');
}

/** 从一行 `- key: value` 取 value (原样, 不 trim value 以保留内部空格)。 */
function fieldValue(line: string, key: string): string | null {
  const prefix = `- ${key}: `;
  const bare = `- ${key}:`;
  if (line.startsWith(prefix)) return line.slice(prefix.length);
  if (line === bare) return '';
  return null;
}

/** 逗号分隔 id 列表 → string[] (空 → [])。 */
function splitIds(v: string): string[] {
  return v === '' ? [] : v.split(', ');
}

/**
 * markdown → PathMap (renderMapMarkdown 的逆; roundtrip: parse(render(m)) ≡ m, 排序归一后)。
 * 忽略 `_(none)_` / `_(none yet)_` 占位。
 */
export function parseMapMarkdown(md: string): PathMap {
  const lines = md.split('\n');
  let destination = '';
  let slug = '';
  const decisionsLog: { ticketId: string; gist: string }[] = [];
  const tickets: Ticket[] = [];
  let cur: Partial<Ticket> & { id?: string } = {};

  const flush = () => {
    if (cur.id !== undefined) {
      tickets.push({
        id: cur.id,
        type: cur.type ?? 'task',
        title: cur.title ?? '',
        blockedBy: cur.blockedBy ?? [],
        status: cur.status ?? 'open',
        ...(cur.ruling !== undefined ? { ruling: cur.ruling } : {}),
        ...(cur.executorKind !== undefined ? { executorKind: cur.executorKind } : {}),
        ...(cur.children !== undefined ? { children: cur.children } : {}),
        ...(cur.dNumber !== undefined ? { dNumber: cur.dNumber } : {}),
      });
    }
    cur = {};
  };

  for (const line of lines) {
    if (line.startsWith('# Pathfinder: ')) {
      destination = unesc(line.slice('# Pathfinder: '.length));
      continue;
    }
    const slugM = line.match(/^<!-- slug: (.*) -->$/);
    if (slugM) {
      slug = slugM[1]!;
      continue;
    }
    const decM = line.match(/^- \[(.+?)\] (.*)$/);
    if (decM && cur.id === undefined) {
      decisionsLog.push({ ticketId: decM[1]!, gist: unesc(decM[2]!) });
      continue;
    }
    if (line.startsWith('### status: ')) {
      flush(); // 组头 (非票头) — 只收尾上一票, 不开新票
      continue;
    }
    if (line.startsWith('### ')) {
      flush();
      cur = { id: line.slice('### '.length) };
      continue;
    }
    if (cur.id === undefined) continue;
    let v: string | null;
    if ((v = fieldValue(line, 'type')) !== null) cur.type = v as TicketType;
    else if ((v = fieldValue(line, 'title')) !== null) cur.title = unesc(v);
    else if ((v = fieldValue(line, 'status')) !== null) cur.status = v as TicketStatus;
    else if ((v = fieldValue(line, 'blockedBy')) !== null) cur.blockedBy = splitIds(v);
    else if ((v = fieldValue(line, 'ruling')) !== null) cur.ruling = unesc(v);
    else if ((v = fieldValue(line, 'executorKind')) !== null) cur.executorKind = v as ExecutorKind;
    else if ((v = fieldValue(line, 'children')) !== null) cur.children = splitIds(v);
    else if ((v = fieldValue(line, 'dNumber')) !== null) cur.dNumber = v;
  }
  flush();

  return { destination, slug, tickets, decisionsLog };
}

// ── SQLite 索引 (镜像 dag-record.ts idiom; :memory: 传 Database 句柄) ──────────

/** 打开/复用 db。传 Database → 复用 (不 close); 传 path (非 :memory:) → mkdirSync + new Database。 */
function openDb(dbPath: string | Database): { db: Database; owned: boolean } {
  if (dbPath instanceof Database) return { db: dbPath, owned: false };
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
  return { db: new Database(dbPath), owned: true };
}

function ensureSchema(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS pathmaps (
      slug          TEXT PRIMARY KEY,
      destination   TEXT NOT NULL,
      decisions_log TEXT NOT NULL
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS tickets (
      map_slug      TEXT NOT NULL,
      ord           INTEGER NOT NULL,
      id            TEXT NOT NULL,
      type          TEXT NOT NULL,
      title         TEXT NOT NULL,
      blocked_by    TEXT NOT NULL,
      status        TEXT NOT NULL,
      ruling        TEXT,
      executor_kind TEXT,
      children      TEXT,
      d_number      TEXT,
      PRIMARY KEY (map_slug, id)
    )
  `);
}

/** 落一张图到 db (幂等: 先删同 slug 的旧行)。map = 内存 PathMap, dbPath = 路径或 Database 句柄。 */
export function saveMapDb(map: PathMap, dbPath: string | Database): void {
  const { db, owned } = openDb(dbPath);
  try {
    ensureSchema(db);
    db.run('DELETE FROM pathmaps WHERE slug = ?', [map.slug]);
    db.run('DELETE FROM tickets WHERE map_slug = ?', [map.slug]);
    db.query('INSERT INTO pathmaps (slug, destination, decisions_log) VALUES (?, ?, ?)').run(
      map.slug,
      map.destination,
      JSON.stringify(map.decisionsLog),
    );
    const ins = db.query(
      `INSERT INTO tickets (map_slug, ord, id, type, title, blocked_by, status, ruling, executor_kind, children, d_number)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    map.tickets.forEach((t, i) => {
      ins.run(
        map.slug,
        i,
        t.id,
        t.type,
        t.title,
        JSON.stringify(t.blockedBy),
        t.status,
        t.ruling ?? null,
        t.executorKind ?? null,
        t.children !== undefined ? JSON.stringify(t.children) : null,
        t.dNumber ?? null,
      );
    });
  } finally {
    if (owned) db.close();
  }
}

interface MapRow {
  slug: string;
  destination: string;
  decisions_log: string;
}
interface TicketRow {
  id: string;
  type: string;
  title: string;
  blocked_by: string;
  status: string;
  ruling: string | null;
  executor_kind: string | null;
  children: string | null;
  d_number: string | null;
}

/**
 * 从 db 读一张图。slug 省略 → 取唯一/第一张 (按 slug 排序, 确定)。dbPath = 路径或 Database 句柄。
 * :memory: 测试须传同一个 Database 句柄 (进程内表随连接走)。
 */
export function loadMapDb(dbPath: string | Database, slug?: string): PathMap {
  const { db, owned } = openDb(dbPath);
  try {
    ensureSchema(db);
    const mapRow = (
      slug !== undefined
        ? db.query('SELECT * FROM pathmaps WHERE slug = ?').get(slug)
        : db.query('SELECT * FROM pathmaps ORDER BY slug LIMIT 1').get()
    ) as MapRow | null;
    if (!mapRow) throw new Error(`loadMapDb: 找不到图${slug !== undefined ? ` "${slug}"` : ''}`);
    const rows = db.query('SELECT * FROM tickets WHERE map_slug = ? ORDER BY ord').all(mapRow.slug) as TicketRow[];
    const tickets: Ticket[] = rows.map((r) => ({
      id: r.id,
      type: r.type as TicketType,
      title: r.title,
      blockedBy: JSON.parse(r.blocked_by) as string[],
      status: r.status as TicketStatus,
      ...(r.ruling !== null ? { ruling: r.ruling } : {}),
      ...(r.executor_kind !== null ? { executorKind: r.executor_kind as ExecutorKind } : {}),
      ...(r.children !== null ? { children: JSON.parse(r.children) as string[] } : {}),
      ...(r.d_number !== null ? { dNumber: r.d_number } : {}),
    }));
    return {
      destination: mapRow.destination,
      slug: mapRow.slug,
      tickets,
      decisionsLog: JSON.parse(mapRow.decisions_log) as { ticketId: string; gist: string }[],
    };
  } finally {
    if (owned) db.close();
  }
}

/** "db 可从 md 真相重建"保证 (D-3): parse markdown → saveMapDb。 */
export function rebuildDbFromMarkdown(md: string, dbPath: string | Database): void {
  saveMapDb(parseMapMarkdown(md), dbPath);
}
