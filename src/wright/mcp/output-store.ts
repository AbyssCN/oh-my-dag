/**
 * src/wright/mcp/output-store —— 大输出沙箱库 (Contract D74 轴 B, MR-INV-9 FTS5/BM25)。
 *
 * 大工具输出 (web/file/api blob) 不进 context, 切块存这里; ctx_search 按需拉相关块。
 * 切块 = 按 markdown 标题分节 (基准 context-mode 同法), 超长节再按 maxChars 二次切; 无标题→定窗。
 */
import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { ftsQuery } from './tool-index';

export interface Chunk {
  source: string;
  heading: string;
  text: string;
}

export interface OutputStore {
  /** 切块存 source 的内容, 返 {chunks, bytes}。 */
  index(source: string, content: string): { chunks: number; bytes: number };
  /** BM25 检索相关块 (可按 source 过滤)。 */
  search(query: string, opts?: { source?: string; k?: number }): Chunk[];
  removeSource(source: string): void;
  close(): void;
}

export function chunkContent(content: string, maxChars = 2000): Array<{ heading: string; text: string }> {
  const lines = content.split('\n');
  const sections: Array<{ heading: string; lines: string[] }> = [];
  let cur: { heading: string; lines: string[] } = { heading: '', lines: [] };
  for (const ln of lines) {
    if (/^#{1,6}\s/.test(ln)) {
      if (cur.lines.join('\n').trim()) sections.push(cur);
      cur = { heading: ln.replace(/^#+\s*/, '').trim(), lines: [ln] };
    } else {
      cur.lines.push(ln);
    }
  }
  if (cur.lines.join('\n').trim()) sections.push(cur);

  const out: Array<{ heading: string; text: string }> = [];
  for (const s of sections) {
    const text = s.lines.join('\n').trim();
    if (text.length <= maxChars) out.push({ heading: s.heading, text });
    else for (let i = 0; i < text.length; i += maxChars) out.push({ heading: s.heading, text: text.slice(i, i + maxChars) });
  }
  if (out.length === 0) {
    for (let i = 0; i < content.length; i += maxChars) out.push({ heading: '', text: content.slice(i, i + maxChars) });
  }
  return out;
}

interface Row {
  source: string;
  heading: string;
  text: string;
}

export function createOutputStore(opts: { path?: string; db?: Database; maxChars?: number } = {}): OutputStore {
  const path = opts.path ?? '.wright/mcp-outputs.db';
  const maxChars = opts.maxChars ?? 2000;
  if (!opts.db && path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = opts.db ?? new Database(path);
  db.run('PRAGMA journal_mode = WAL');
  db.run(`
    CREATE TABLE IF NOT EXISTS wright_output_chunks (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      source  TEXT NOT NULL,
      heading TEXT NOT NULL,
      text    TEXT NOT NULL
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_output_source ON wright_output_chunks (source)`);
  db.run(`
    CREATE VIRTUAL TABLE IF NOT EXISTS wright_output_fts
    USING fts5(text, heading, source UNINDEXED, content='wright_output_chunks', content_rowid='id', tokenize='porter unicode61')
  `);

  const ins = db.query(`INSERT INTO wright_output_chunks (source, heading, text) VALUES (?, ?, ?)`);
  const insFts = db.query(`INSERT INTO wright_output_fts (rowid, text, heading, source) VALUES (?, ?, ?, ?)`);
  const idsOfSource = db.query(`SELECT id FROM wright_output_chunks WHERE source = ?`);
  const delFts = db.query(`INSERT INTO wright_output_fts (wright_output_fts, rowid, text, heading, source) VALUES ('delete', ?, ?, ?, ?)`);
  const getChunk = db.query(`SELECT source, heading, text FROM wright_output_chunks WHERE id = ?`);
  const delMain = db.query(`DELETE FROM wright_output_chunks WHERE source = ?`);
  const searchAll = db.query(
    `SELECT c.source, c.heading, c.text FROM wright_output_fts f
       JOIN wright_output_chunks c ON c.id = f.rowid
      WHERE wright_output_fts MATCH ? ORDER BY bm25(wright_output_fts) LIMIT ?`,
  );
  const searchSrc = db.query(
    `SELECT c.source, c.heading, c.text FROM wright_output_fts f
       JOIN wright_output_chunks c ON c.id = f.rowid
      WHERE wright_output_fts MATCH ? AND c.source = ? ORDER BY bm25(wright_output_fts) LIMIT ?`,
  );

  return {
    index(source, content) {
      const chunks = chunkContent(content, maxChars);
      const tx = db.transaction(() => {
        for (const c of chunks) {
          ins.run(source, c.heading, c.text);
          const rowid = db.query('SELECT last_insert_rowid() AS id').get() as { id: number };
          insFts.run(rowid.id, c.text, c.heading, source);
        }
      });
      tx();
      return { chunks: chunks.length, bytes: content.length };
    },
    search(query, o = {}) {
      const fq = ftsQuery(query);
      if (!fq) return [];
      const k = o.k ?? 5;
      const rows = (o.source ? searchSrc.all(fq, o.source, k) : searchAll.all(fq, k)) as Row[];
      return rows;
    },
    removeSource(source) {
      const ids = idsOfSource.all(source) as { id: number }[];
      const tx = db.transaction(() => {
        for (const { id } of ids) {
          const c = getChunk.get(id) as Row | null;
          if (c) delFts.run(id, c.text, c.heading, c.source);
        }
        delMain.run(source);
      });
      tx();
    },
    close() {
      db.close();
    },
  };
}
