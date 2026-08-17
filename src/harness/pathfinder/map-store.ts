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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { declaredTicketClass } from './types';
import type { ExecutorKind, PathMap, Ticket, TicketStatus, TicketType } from './types';

/**
 * 盘上的票 = `Ticket` + 可能写着的 `ticketClass` (D-3 故意不把判别键放在 `Ticket` 上, 见 types.ts)。
 * 值取**原样字符串**: 真相文件人可手改, 词表外的手滑 (`rulingg`) 要原样往返给闸判 (fail-closed),
 * 不在存储层静默抹掉或归一 —— 与"未知 status 渲进兜底组"同一条纪律。
 */
type StoredTicket = Ticket & { ticketClass?: string };
/** 解析中间态: 扁平行先各自落进这些平铺键, flush 时才拼成 `Ticket.dispatch` 嵌套对象。 */
type ParsedTicket = Partial<StoredTicket> & {
  id?: string;
  dispatchRunId?: string;
  dispatchStartedAt?: string;
  dispatchFinishedAt?: string;
  dispatchOutcome?: string;
  // D-3 #ticket 写集 (md 锚名沿 gh 面 `Write-set:` / `Sdd-path:`, 完全一致)。
  // 字段名用 camelCase (TS 标识符), 实际锚行写为 `Write-set:` / `Sdd-path:`, 与 gh 文件可互读。
  writeSet?: string[];
  sddPath?: string;
};

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
const STATUS_ORDER: TicketStatus[] = ['suggested', 'open', 'blocked', 'ruled', 'delivered', 'escalated'];
const KNOWN_STATUS: ReadonlySet<string> = new Set(STATUS_ORDER);

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
  if (t.blockedByDelivery !== undefined) lines.push(`- blockedByDelivery: ${t.blockedByDelivery.join(', ')}`);
  if (t.ruling !== undefined) lines.push(`- ruling: ${esc(t.ruling)}`);
  if (t.executorKind !== undefined) lines.push(`- executorKind: ${t.executorKind}`);
  // D-3 #ticket 写集 (与 gh 面锚同款 `Write-set:` / `Sdd-path:`, NULL≠0)。
  // writeSet 缺省不写, 但 `[]` 必须写出空锚 (与缺省区分); sddPath 空串不写 (与 gh truthy 闸同)。
  if (t.writeSet !== undefined) lines.push(`- Write-set: ${t.writeSet.join(',')}`);
  if (t.sddPath) lines.push(`- Sdd-path: ${t.sddPath}`);
  if (t.children !== undefined) lines.push(`- children: ${t.children.join(', ')}`);
  if (t.dNumber !== undefined) lines.push(`- dNumber: ${t.dNumber}`);
  if (t.suggestedBy !== undefined) lines.push(`- suggestedBy: ${t.suggestedBy}`);
  if (t.fingerprint !== undefined) lines.push(`- fingerprint: ${t.fingerprint}`);
  // D-3 票类 + D-5 三戳: 一律"缺则省行" → 未标类无戳的存量票渲染输出逐字节不变。
  const cls = declaredTicketClass(t);
  if (cls !== undefined) lines.push(`- ticketClass: ${esc(cls)}`);
  if (t.waitingSince !== undefined) lines.push(`- waitingSince: ${t.waitingSince}`);
  if (t.ruledAt !== undefined) lines.push(`- ruledAt: ${t.ruledAt}`);
  if (t.staleAt !== undefined) lines.push(`- staleAt: ${t.staleAt}`);
  // D-6③ 派发锚 (Ticket.dispatch)。嵌套对象在这个扁平 `- key: value` 格式里存不下, 故**拆平成四行**,
  // 每行独立"缺则省行" —— 与上面三戳同规, 没锚的存量票渲染输出逐字节不变。
  // ⚠ 这里是**字段白名单**: 新增 Ticket 字段不同时改「写行 / 解析 / 重建」三处, 它就在盘上被静默丢弃
  // (本字段第一版就是这么丢的 —— 内存里写进去了, 落盘读回来是 undefined, 而没有任何报错)。
  if (t.dispatch !== undefined) {
    lines.push(`- dispatchRunId: ${t.dispatch.runId}`);
    lines.push(`- dispatchStartedAt: ${t.dispatch.startedAt}`);
    if (t.dispatch.finishedAt !== undefined) lines.push(`- dispatchFinishedAt: ${t.dispatch.finishedAt}`);
    if (t.dispatch.outcome !== undefined) lines.push(`- dispatchOutcome: ${t.dispatch.outcome}`);
  }
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
  if (map.suggestionsLog !== undefined && map.suggestionsLog.length > 0) {
    // S-1 (INV-S1-3): 处置台账 append-only。行首用 `- log:` 与决策日志的 `- [id]` 形状区分,
    // 否则 parser 在 cur.id 未开时会把它吞进 decisionsLog。
    out.push('## Suggestions log', '');
    for (const e of map.suggestionsLog) out.push(`- log: ${e.ticketId} ${e.outcome} ${e.at} ${e.runId}`);
    out.push('');
  }
  if (map.waitingLog !== undefined && map.waitingLog.length > 0) {
    // D-5 (G-5): 等人超时台账 append-only。行首 `- wait:` 同理与决策日志的 `- [id]` 分形状。
    out.push('## Waiting-human log', '');
    for (const e of map.waitingLog) out.push(`- wait: ${e.ticketId} ${e.waitingSince} ${e.waitedMs} ${e.at}`);
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
  // 永不丢票: 手改出的未知 status (真相文件"人可读可编") 渲进兜底组而非静默过滤 ——
  // 票自身的 `- status:` 行保留原词, 往返幂等, 由人看到后改回合法状态。
  const unknown = map.tickets.filter((t) => !KNOWN_STATUS.has(t.status));
  if (unknown.length > 0) {
    out.push('### status: (unrecognized)', '');
    for (const t of unknown) out.push(renderTicket(t), '');
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
  const suggestionsLog: PathMap['suggestionsLog'] = [];
  const waitingLog: PathMap['waitingLog'] = [];
  const tickets: Ticket[] = [];
  let cur: ParsedTicket = {};

  const flush = () => {
    if (cur.id !== undefined) {
      const t: StoredTicket = {
        id: cur.id,
        type: cur.type ?? 'task',
        title: cur.title ?? '',
        blockedBy: cur.blockedBy ?? [],
        ...(cur.blockedByDelivery !== undefined ? { blockedByDelivery: cur.blockedByDelivery } : {}),
        status: cur.status ?? 'open',
        ...(cur.ruling !== undefined ? { ruling: cur.ruling } : {}),
  ...(cur.executorKind !== undefined ? { executorKind: cur.executorKind } : {}),
  // D-3 #ticket 写集: writeSet/sddPath 严格沿 gh 闸, NULL≠0 防与空串混淆。
  ...(cur.writeSet !== undefined ? { writeSet: cur.writeSet } : {}),
  ...(cur.sddPath ? { sddPath: cur.sddPath } : {}),
  ...(cur.children !== undefined ? { children: cur.children } : {}),
        ...(cur.dNumber !== undefined ? { dNumber: cur.dNumber } : {}),
        ...(cur.suggestedBy !== undefined ? { suggestedBy: cur.suggestedBy } : {}),
        ...(cur.fingerprint !== undefined ? { fingerprint: cur.fingerprint } : {}),
        ...(cur.ticketClass !== undefined ? { ticketClass: cur.ticketClass } : {}),
        ...(cur.waitingSince !== undefined ? { waitingSince: cur.waitingSince } : {}),
        ...(cur.ruledAt !== undefined ? { ruledAt: cur.ruledAt } : {}),
        ...(cur.staleAt !== undefined ? { staleAt: cur.staleAt } : {}),
        // 派发锚: runId + startedAt 两者齐全才算一个锚 (缺一半 = 文件被手改坏了, 宁可当没有)。
        ...(cur.dispatchRunId !== undefined && cur.dispatchStartedAt !== undefined
          ? {
              dispatch: {
                runId: cur.dispatchRunId,
                startedAt: cur.dispatchStartedAt,
                ...(cur.dispatchFinishedAt !== undefined ? { finishedAt: cur.dispatchFinishedAt } : {}),
                ...(cur.dispatchOutcome !== undefined ? { outcome: cur.dispatchOutcome as 'passed' | 'failed' } : {}),
              },
            }
          : {}),
      };
      tickets.push(t);
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
    const logM = line.match(/^- log: (\S+) (accepted|edited|rejected|deduped-semantic|deduped) (\S+) (\S+)$/);
    if (logM && cur.id === undefined) {
      suggestionsLog.push({ ticketId: logM[1]!, outcome: logM[2] as 'accepted', at: logM[3]!, runId: logM[4]! });
      continue;
    }
    const waitM = line.match(/^- wait: (\S+) (\S+) (\d+) (\S+)$/);
    if (waitM && cur.id === undefined) {
      waitingLog.push({ ticketId: waitM[1]!, waitingSince: waitM[2]!, waitedMs: Number(waitM[3]!), at: waitM[4]! });
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
    else if ((v = fieldValue(line, 'blockedByDelivery')) !== null) cur.blockedByDelivery = splitIds(v);
    else if ((v = fieldValue(line, 'ruling')) !== null) cur.ruling = unesc(v);
    else if ((v = fieldValue(line, 'executorKind')) !== null) cur.executorKind = v as ExecutorKind;
    else if ((v = fieldValue(line, 'children')) !== null) cur.children = splitIds(v);
    else if ((v = fieldValue(line, 'dNumber')) !== null) cur.dNumber = v;
    else if ((v = fieldValue(line, 'suggestedBy')) !== null) cur.suggestedBy = v;
    else if ((v = fieldValue(line, 'fingerprint')) !== null) cur.fingerprint = v;
    else if ((v = fieldValue(line, 'ticketClass')) !== null) cur.ticketClass = unesc(v);
    else if ((v = fieldValue(line, 'waitingSince')) !== null) cur.waitingSince = v;
    else if ((v = fieldValue(line, 'ruledAt')) !== null) cur.ruledAt = v;
    else if ((v = fieldValue(line, 'staleAt')) !== null) cur.staleAt = v;
    else if ((v = fieldValue(line, 'dispatchRunId')) !== null) cur.dispatchRunId = v;
    else if ((v = fieldValue(line, 'dispatchStartedAt')) !== null) cur.dispatchStartedAt = v;
    else if ((v = fieldValue(line, 'dispatchFinishedAt')) !== null) cur.dispatchFinishedAt = v;
  else if ((v = fieldValue(line, 'dispatchOutcome')) !== null) cur.dispatchOutcome = v;
  // D-3 #ticket 写集 (md 锚名沿 gh: `Write-set:` / `Sdd-path:`)。空锚 → `[]`, 与缺省 undefined 区分。
  else if ((v = fieldValue(line, 'Write-set')) !== null) {
    cur.writeSet = v === '' ? [] : v.split(',').map((s) => s.trim()).filter(Boolean);
  } else if ((v = fieldValue(line, 'Sdd-path')) !== null) cur.sddPath = v;
  }
  flush();

  return {
    destination,
    slug,
    tickets,
    decisionsLog,
    ...(suggestionsLog.length > 0 ? { suggestionsLog } : {}),
    ...(waitingLog.length > 0 ? { waitingLog } : {}),
  };
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
      suggested_by  TEXT,
      fingerprint   TEXT,
      ticket_class  TEXT,
      waiting_since TEXT,
      ruled_at      TEXT,
      stale_at      TEXT,
      write_set     TEXT,
      sdd_path      TEXT,
      PRIMARY KEY (map_slug, id)
    )
  `);
  // S-1 就地迁移 (老索引库无新列; 索引可重建, 但别让 INSERT 在老库上炸)。
  const tcols = (db.query(`PRAGMA table_info(tickets)`).all() as { name: string }[]).map((c) => c.name);
  if (!tcols.includes('suggested_by')) db.run(`ALTER TABLE tickets ADD COLUMN suggested_by TEXT`);
  if (!tcols.includes('fingerprint')) db.run(`ALTER TABLE tickets ADD COLUMN fingerprint TEXT`);
  // D-3 票类 + D-5 三戳 (同上: 老库就地补列)。
  if (!tcols.includes('ticket_class')) db.run(`ALTER TABLE tickets ADD COLUMN ticket_class TEXT`);
  if (!tcols.includes('waiting_since')) db.run(`ALTER TABLE tickets ADD COLUMN waiting_since TEXT`);
  if (!tcols.includes('ruled_at')) db.run(`ALTER TABLE tickets ADD COLUMN ruled_at TEXT`);
  if (!tcols.includes('stale_at')) db.run(`ALTER TABLE tickets ADD COLUMN stale_at TEXT`);
  // D-3 #ticket 写集 (`write_set` 存 JSON 字符串, NULL≠0: [] 与 undefined 在该列分明)。
  if (!tcols.includes('write_set')) db.run(`ALTER TABLE tickets ADD COLUMN write_set TEXT`);
  if (!tcols.includes('sdd_path')) db.run(`ALTER TABLE tickets ADD COLUMN sdd_path TEXT`);
  const mcols = (db.query(`PRAGMA table_info(pathmaps)`).all() as { name: string }[]).map((c) => c.name);
  if (!mcols.includes('suggestions_log')) db.run(`ALTER TABLE pathmaps ADD COLUMN suggestions_log TEXT`);
  if (!mcols.includes('waiting_log')) db.run(`ALTER TABLE pathmaps ADD COLUMN waiting_log TEXT`);
}
/** 落一张图到 db (幂等: 先删同 slug 的旧行)。map = 内存 PathMap, dbPath = 路径或 Database 句柄。 */
export function saveMapDb(map: PathMap, dbPath: string | Database): void {
  const { db, owned } = openDb(dbPath);
  try {
    ensureSchema(db);
    db.run('DELETE FROM pathmaps WHERE slug = ?', [map.slug]);
    db.run('DELETE FROM tickets WHERE map_slug = ?', [map.slug]);
    db.query('INSERT INTO pathmaps (slug, destination, decisions_log, suggestions_log, waiting_log) VALUES (?, ?, ?, ?, ?)').run(
      map.slug,
      map.destination,
      JSON.stringify(map.decisionsLog),
      map.suggestionsLog !== undefined ? JSON.stringify(map.suggestionsLog) : null,
      map.waitingLog !== undefined ? JSON.stringify(map.waitingLog) : null,
    );
    const ins = db.query(
      `INSERT INTO tickets (map_slug, ord, id, type, title, blocked_by, status, ruling, executor_kind, children, d_number, suggested_by, fingerprint, ticket_class, waiting_since, ruled_at, stale_at, write_set, sdd_path)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        t.suggestedBy ?? null,
        t.fingerprint ?? null,
        declaredTicketClass(t) ?? null,
        t.waitingSince ?? null,
        t.ruledAt ?? null,
        t.staleAt ?? null,
        // D-3 #ticket 写集: `write_set` 存 JSON 串 (NULL≠0 — `[]` 与 undefined 在该列分明),
        // `sdd_path` 直存字符串 (NULL=undefined, 空串=空串)。
        JSON.stringify(t.writeSet) ?? null,
        t.sddPath ?? null,
        // ponytail: D-6③ dispatch 与 #138 blockedByDelivery **没进 db 索引** —— 加列要给既有 .omd/pathfinder.db 走 ALTER 迁移,
        // 而 `loadMapDb` 今天在生产里零消费者 (只有本模块与一段 eval 描述引用它)。真源是 markdown,
        // 索引随时可由 rebuildDbFromMarkdown 重建。**记在这儿而不是默默留着**: 哪天 loadMapDb 真被
        // 生产消费, 这条就得先还 —— 否则索引读出来的票一律没有 dispatch/blockedByDelivery 锚, 而且不会报错。
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
  suggestions_log: string | null;
  waiting_log: string | null;
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
  suggested_by: string | null;
  fingerprint: string | null;
  ticket_class: string | null;
  waiting_since: string | null;
  ruled_at: string | null;
  stale_at: string | null;
  // D-3 #ticket 写集: `write_set` 存 JSON 字符串 (NULL≠0 — `[]` 与 undefined 在该列分明),
  // `sdd_path` 直存字符串 (NULL=undefined)。
  write_set: string | null;
  sdd_path: string | null;
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
    const tickets: StoredTicket[] = rows.map((r) => ({
      id: r.id,
      type: r.type as TicketType,
      title: r.title,
      blockedBy: JSON.parse(r.blocked_by) as string[],
      status: r.status as TicketStatus,
      ...(r.ruling !== null ? { ruling: r.ruling } : {}),
      ...(r.executor_kind !== null ? { executorKind: r.executor_kind as ExecutorKind } : {}),
      ...(r.children !== null ? { children: JSON.parse(r.children) as string[] } : {}),
      ...(r.d_number !== null ? { dNumber: r.d_number } : {}),
      ...(r.suggested_by !== null ? { suggestedBy: r.suggested_by } : {}),
      ...(r.fingerprint !== null ? { fingerprint: r.fingerprint } : {}),
      ...(r.ticket_class !== null ? { ticketClass: r.ticket_class } : {}),
      ...(r.waiting_since !== null ? { waitingSince: r.waiting_since } : {}),
      ...(r.ruled_at !== null ? { ruledAt: r.ruled_at } : {}),
      ...(r.stale_at !== null ? { staleAt: r.stale_at } : {}),
      // D-3 #ticket 写集: `write_set` 经 JSON.parse 还原为 string[] (NULL≠0: `[]` 与 undefined 在该列分明),
      // `sdd_path` 直取字符串 (NULL=undefined, 空串=空串)。
      ...(r.write_set !== null ? { writeSet: JSON.parse(r.write_set) as string[] } : {}),
      ...(r.sdd_path !== null ? { sddPath: r.sdd_path } : {}),
    }));
    return {
      destination: mapRow.destination,
      slug: mapRow.slug,
      tickets,
      decisionsLog: JSON.parse(mapRow.decisions_log) as { ticketId: string; gist: string }[],
      ...(mapRow.suggestions_log !== null && mapRow.suggestions_log !== undefined
        ? { suggestionsLog: JSON.parse(mapRow.suggestions_log) as PathMap['suggestionsLog'] }
        : {}),
      ...(mapRow.waiting_log !== null && mapRow.waiting_log !== undefined
        ? { waitingLog: JSON.parse(mapRow.waiting_log) as PathMap['waitingLog'] }
        : {}),
    };
  } finally {
    if (owned) db.close();
  }
}

/** "db 可从 md 真相重建"保证 (D-3): parse markdown → saveMapDb。 */
export function rebuildDbFromMarkdown(md: string, dbPath: string | Database): void {
  saveMapDb(parseMapMarkdown(md), dbPath);
}

// ── 地图 IO 单写口 (load / save / mutate) ──────────────────────────────────────

/** 读一张地图 (docs/plan/pathfinder/<slug>.md → parseMapMarkdown); 文件不存在 → null。 */
export function loadMap(cwd: string, slug: string): PathMap | null {
  const p = mapMarkdownPath(slug, cwd);
  if (!existsSync(p)) return null;
  return parseMapMarkdown(readFileSync(p, 'utf8'));
}

/** 落一张地图: markdown 真相 (docs/plan/pathfinder/) + db 索引 (.omd/pathfinder.db)。 */
export function saveMap(map: PathMap, cwd: string): void {
  const mdPath = mapMarkdownPath(map.slug, cwd);
  mkdirSync(dirname(mdPath), { recursive: true });
  writeFileSync(mdPath, renderMapMarkdown(map), 'utf8');
  saveMapDb(map, defaultDbPath(cwd));
}

/**
 * 地图变更的**唯一入口**: fresh load → fn 就地改 → save。杜绝"各持内存快照、谁 save 谁覆盖全文件"
 * 一类静默回滚 (读-改-写全同步, 单线程事件循环内不可分割 —— 持图跨 await 再 save 才是被禁的形状)。
 * 地图不存在 → 不调 fn, 返回 null。
 */
export function mutateMap<T>(cwd: string, slug: string, fn: (map: PathMap) => T): { map: PathMap; result: T } | null {
  const map = loadMap(cwd, slug);
  if (!map) return null;
  const result = fn(map);
  saveMap(map, cwd);
  return { map, result };
}
