/**
 * src/wright/mcp/tool-index —— 隐藏工具索引 (sqlite + FTS5/BM25)。
 *
 * MR-INV-1: schema 藏这里, LLM 不预载。MR-INV-3: 单一真理源, boot 缓存 + 动态增量。
 * 检索 = FTS5 BM25 (基准证 context-mode 不用 embedding 即达 98%; MR-INV-9)。
 * 镜像 session-store/quota-store: 可注入 db = 测试瞬时。
 */
import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { IndexedTool } from './types';

export interface MenuEntry {
  id: string;
  server: string;
  description: string;
}

export interface ToolIndex {
  upsert(tools: IndexedTool[]): void;
  removeServer(server: string): void;
  get(id: string): IndexedTool | null;
  /** BM25 检索, 返 top-k。空/无词 query → []。 */
  search(query: string, k?: number): IndexedTool[];
  /** 常驻菜单 (名+一句话, 不含 schema)。 */
  menu(): MenuEntry[];
  all(): IndexedTool[];
  close(): void;
}

interface Row {
  id: string;
  server: string;
  name: string;
  description: string;
  input_schema: string;
}

const rowToTool = (r: Row): IndexedTool => ({
  id: r.id,
  server: r.server,
  name: r.name,
  description: r.description,
  inputSchema: JSON.parse(r.input_schema),
});

/** FTS5 安全 query: 取 alnum token, 各加引号 OR 连 (任一词命中, bm25 排序)。 */
export function ftsQuery(q: string): string {
  const tokens = q.toLowerCase().match(/[a-z0-9_]+/g) ?? [];
  return tokens.map((t) => `"${t}"`).join(' OR ');
}

export function createToolIndex(opts: { path?: string; db?: Database } = {}): ToolIndex {
  const path = opts.path ?? '.wright/mcp-tools.db';
  if (!opts.db && path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = opts.db ?? new Database(path);
  db.run('PRAGMA journal_mode = WAL');
  db.run(`
    CREATE TABLE IF NOT EXISTS wright_mcp_tools (
      id           TEXT PRIMARY KEY,
      server       TEXT NOT NULL,
      name         TEXT NOT NULL,
      description  TEXT NOT NULL,
      input_schema TEXT NOT NULL
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_mcp_tools_server ON wright_mcp_tools (server)`);
  db.run(`
    CREATE VIRTUAL TABLE IF NOT EXISTS wright_mcp_tools_fts
    USING fts5(id UNINDEXED, name, description, tokenize='porter unicode61')
  `);

  const insMain = db.query(
    `INSERT OR REPLACE INTO wright_mcp_tools (id, server, name, description, input_schema) VALUES (?, ?, ?, ?, ?)`,
  );
  const delFts = db.query(`DELETE FROM wright_mcp_tools_fts WHERE id = ?`);
  const insFts = db.query(`INSERT INTO wright_mcp_tools_fts (id, name, description) VALUES (?, ?, ?)`);
  const getOne = db.query(`SELECT * FROM wright_mcp_tools WHERE id = ?`);
  const idsByServer = db.query(`SELECT id FROM wright_mcp_tools WHERE server = ?`);
  const delMain = db.query(`DELETE FROM wright_mcp_tools WHERE server = ?`);
  const menuQ = db.query(`SELECT id, server, description FROM wright_mcp_tools ORDER BY server, name`);
  const allQ = db.query(`SELECT * FROM wright_mcp_tools ORDER BY server, name`);
  const searchQ = db.query(
    `SELECT t.* FROM wright_mcp_tools_fts
       JOIN wright_mcp_tools t ON t.id = wright_mcp_tools_fts.id
      WHERE wright_mcp_tools_fts MATCH ?
      ORDER BY bm25(wright_mcp_tools_fts) LIMIT ?`,
  );

  const upsertTx = db.transaction((tools: IndexedTool[]) => {
    for (const t of tools) {
      insMain.run(t.id, t.server, t.name, t.description, JSON.stringify(t.inputSchema));
      delFts.run(t.id);
      insFts.run(t.id, t.name, t.description);
    }
  });

  return {
    upsert(tools) {
      if (tools.length) upsertTx(tools);
    },
    removeServer(server) {
      const ids = (idsByServer.all(server) as { id: string }[]).map((r) => r.id);
      const tx = db.transaction(() => {
        for (const { id } of ids.map((id) => ({ id }))) delFts.run(id);
        delMain.run(server);
      });
      tx();
    },
    get(id) {
      const row = getOne.get(id) as Row | null;
      return row ? rowToTool(row) : null;
    },
    search(query, k = 5) {
      const fq = ftsQuery(query);
      if (!fq) return [];
      return (searchQ.all(fq, k) as Row[]).map(rowToTool);
    },
    menu() {
      return menuQ.all() as MenuEntry[];
    },
    all() {
      return (allQ.all() as Row[]).map(rowToTool);
    },
    close() {
      db.close();
    },
  };
}
