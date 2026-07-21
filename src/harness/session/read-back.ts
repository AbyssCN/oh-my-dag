/**
 * src/harness/session/read-back —— 开局读回(从 memory-hub SessionStart hook 移植)。
 *
 * 找本项目最新的「非本 session」checkpoint,格式化成一段可注入的续接 briefing。
 * MVP:供手动验证单 session 回路;phase-2 由 SessionStart hook 经 additionalContext 注入。
 *
 * 落盘位置与 writer 对齐:resolveProject(cwd).dataPath('session')/<sessionId>/checkpoint.md。
 *
 * @module
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { resolveProject } from '../project-scope';

const DEFAULT_BUDGET_CHARS = 10_000; // ≈2.5k tok
const DEFAULT_MAX_AGE_DAYS = 14;

export interface CheckpointRef {
  sessionId: string;
  path: string;
  mtimeMs: number;
}

export interface ReadBackOptions {
  /** 项目根解析用 cwd;默认 process.cwd()。 */
  cwd?: string;
  /** 排除的 session(注入上一个 session 的交接,不是自己)。 */
  excludeSessionId?: string;
  /** 触发来源:compact 注入本 session(PreCompact 刚刷);其余注入上一个 session。 */
  source?: 'startup' | 'resume' | 'clear' | 'compact';
  /** 超此天数的交接不注入(避免误导)。默认 14。 */
  maxAgeDays?: number;
  /** 注入预算字符上限。默认 10_000。 */
  budgetChars?: number;
  /** 注入时钟(测试)。 */
  now?: () => number;
}

/** session checkpoint 根目录(含各 <sessionId>/checkpoint.md）。 */
function sessionRoot(cwd?: string): string {
  const scope = resolveProject(cwd);
  return resolve(scope.rootPath, scope.dataPath('session'));
}

/**
 * 找最新 checkpoint:扫 session 根目录按 mtime,可排除某 session。
 * 返回 { sessionId, path, mtimeMs } 或 undefined。
 */
export function latestCheckpoint(cwd?: string, excludeSessionId?: string): CheckpointRef | undefined {
  const root = sessionRoot(cwd);
  if (!existsSync(root)) return undefined;
  const exclude = excludeSessionId?.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
  const candidates: CheckpointRef[] = [];
  for (const name of readdirSync(root)) {
    if (exclude && name === exclude) continue;
    const p = join(root, name, 'checkpoint.md');
    try {
      const st = statSync(p);
      candidates.push({ sessionId: name, path: p, mtimeMs: st.mtimeMs });
    } catch {
      /* 无 checkpoint 的子目录 / latest.json 等,跳过 */
    }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates[0];
}

/**
 * 构造开局续接 briefing。无可注入的 checkpoint / 太老 → null。
 * 预算内全文;超预算 → §1-§4 全文 + 其余标头 + Read 指针。
 */
export function buildBriefing(opts: ReadBackOptions = {}): string | null {
  const now = opts.now ?? Date.now;
  const source = opts.source ?? 'startup';
  const budget = opts.budgetChars ?? DEFAULT_BUDGET_CHARS;
  const maxAgeMs = (opts.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS) * 24 * 3600_000;

  let found: CheckpointRef | undefined;
  if (source === 'compact' && opts.excludeSessionId) {
    // 本 session 的 checkpoint(PreCompact 刚刷)
    const sid = opts.excludeSessionId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
    const own = join(sessionRoot(opts.cwd), sid, 'checkpoint.md');
    if (!existsSync(own)) return null;
    found = { sessionId: sid, path: own, mtimeMs: 0 };
  } else {
    found = latestCheckpoint(opts.cwd, opts.excludeSessionId);
    if (!found) return null;
    if (now() - found.mtimeMs > maxAgeMs) return null; // 太老,不注入
  }

  let md: string;
  try {
    md = readFileSync(found.path, 'utf-8');
  } catch {
    return null;
  }

  let body: string;
  if (md.length <= budget) {
    body = md;
  } else {
    const cut = md.indexOf('## §5');
    const head = cut > 0 ? md.slice(0, cut) : md.slice(0, budget);
    const restHeaders = (md.slice(cut > 0 ? cut : 0).match(/^## §\d[^\n]*/gm) || []).join('\n');
    body = `${head}\n${restHeaders}\n\n(其余段落超预算截断 — 全文: Read ${found.path})`;
  }

  const age = found.mtimeMs ? `${Math.round((now() - found.mtimeMs) / 60000)}min 前` : '本 session';
  return [
    `## ⚡ Session Continuity 自动续接(来源 session ${found.sessionId.slice(0, 8)} · ${age} · source=${source})`,
    body,
    `> 此为自动 checkpoint。手动 /start 仍可用;若与 _NEXT.md 冲突以人工区为准。`,
  ].join('\n\n');
}
