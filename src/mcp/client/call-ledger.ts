/**
 * src/mcp/client/call-ledger —— 外部 MCP 调用台账(开放生态 SDD S1 / D-11 / C-6)。
 *
 * 每次 mcp_call **成败都入账**:server / tool / session / 状态 / 错误原文。
 * 存储照 touch-ledger.ts:bun:sqlite + WAL,库落 `<root>/.omd/mcp-calls.db`(gitignored),
 * 写失败 fail-open(warn 留痕)绝不扰动工具主路径。
 * NULL≠0 纪律:`session` 没给 = NULL(≠ 空串);`error` 无错 = NULL(≠ '')。
 */
import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '../../logger';

/**
 * 调用结局。拒绝四态分列不合并 —— 「没发往 server」有四种理由,抹平就再也分不开:
 * rejected-unfetched = C-4 闸(没 find 过) · rejected-args = C-3 闸(参数不合 schema) ·
 * rejected-policy = C-5 策略闸(声明方法未授权该副作用) · unknown-tool = 名字解析不到。
 * connect-error 与 error 分开:前者没到工具,后者到了。
 */
export type McpCallStatus = 'ok' | 'error' | 'rejected-unfetched' | 'rejected-args' | 'rejected-policy' | 'unknown-tool' | 'connect-error';

export interface McpCallRecord {
  server: string | null;
  tool: string;
  status: McpCallStatus;
  session?: string | null;
  error?: string | null;
}

export interface McpCallRow extends Required<McpCallRecord> {
  ts: number;
}

export interface McpCallLedger {
  record(input: McpCallRecord): void;
  rows(): McpCallRow[];
  close(): void;
}

export interface OpenMcpCallLedgerOpts {
  /** 工作根 → 库落 `<root>/.omd/mcp-calls.db`。 */
  root?: string;
  /** 注入 db(测试 ':memory:')。 */
  db?: Database;
}

export function openMcpCallLedger(opts: OpenMcpCallLedgerOpts = {}): McpCallLedger {
  const db =
    opts.db ??
    (() => {
      if (!opts.root) throw new Error('openMcpCallLedger 需要 root 或 db 之一');
      const dir = join(opts.root, '.omd');
      mkdirSync(dir, { recursive: true });
      return new Database(join(dir, 'mcp-calls.db'));
    })();
  db.run('PRAGMA journal_mode = WAL');
  db.run(`
    CREATE TABLE IF NOT EXISTS calls (
      ts INTEGER NOT NULL,      -- ms epoch
      session TEXT,             -- NULL = 调用方没给 (≠ '')
      server TEXT,              -- NULL = 名字没解析到 server (unknown-tool)
      tool TEXT NOT NULL,
      status TEXT NOT NULL,     -- McpCallStatus
      error TEXT                -- NULL = 无错 (≠ ''); 有错存原文
    )
  `);

  return {
    record(input) {
      try {
        db.query('INSERT INTO calls (ts, session, server, tool, status, error) VALUES (?, ?, ?, ?, ?, ?)').run(
          Date.now(),
          input.session ?? null,
          input.server,
          input.tool,
          input.status,
          input.error ?? null,
        );
      } catch (e) {
        // 台账写失败不许扰动调用主路径;但证据不许吞 —— warn 带全部字段。
        logger.warn(
          { err: (e as Error).message, server: input.server, tool: input.tool, status: input.status },
          '[omd/mcp-client] call-ledger 写入失败 (fail-open)',
        );
      }
    },
    rows() {
      return db.query('SELECT ts, session, server, tool, status, error FROM calls ORDER BY ts').all() as McpCallRow[];
    },
    close() {
      db.close();
    },
  };
}
