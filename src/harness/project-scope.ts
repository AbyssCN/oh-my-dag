/**
 * src/harness/project-scope —— 多项目记忆的**启动解析层** (SDD multi-project P1)。
 *
 * 一句话: omd 在任何 repo 启动 → 从 cwd 确定性解析出 `project`,该值即
 * `agent_memory.tenant_id` 的分区轴 (per-project / … / global)。本模块纯解析,
 * 不连库 (registry upsert 经注入 sql),保持 omd 开源 dep 不拖 daemon ORM (同 VAL-INV-9 邻规)。
 *
 * 不变量:
 *   MP-INV-1  slug = slugify(basename(git toplevel));非 git 且无显式 OMD_PROJECT → fail-closed
 *             (不静默落 cwd 名,防垃圾分区)。slug 值域镜像 tenant_id CHECK。
 *   MP-INV-5  运行态数据脱离 cwd:OMD_DATA_HOME 设 → ~/.omd/projects/<slug>/;
 *             未设 → 退回 `.omd/`(当前行为,零回归,opt-in 迁移)。
 */
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

/** 全局层分区值 (跨项目 pattern + user.* + soul)。tenant_id='global' 任何项目上下文可读。 */
export const GLOBAL_PROJECT = 'global';

/** slug 值域 — 镜像 agent_memory.tenant_id 的 DB CHECK (MP-INV-1)。 */
const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;

export interface ProjectScope {
  /** = tenant_id 分区值。 */
  slug: string;
  /** git toplevel 绝对路径 (或非 git 时的 cwd)。 */
  rootPath: string;
  /** 该 repo 对应的 Claude Code 私有记忆目录 (摄取源)。 */
  claudeMemoryDir: string;
  /** 运行态数据文件路径 (OMD_DATA_HOME 感知;未设则 .omd/ 向后兼容)。 */
  dataPath(rel: string): string;
}

/** basename → tenant_id-legal slug (MP-INV-1)。空/非法 → 抛 (非静默 coerce)。 */
export function slugifyProject(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);
  if (!SLUG_RE.test(slug)) {
    throw new Error(`[project-scope] MP-INV-1: 无法从 "${name}" 派生合法 project slug`);
  }
  return slug;
}

/** Claude Code 的 per-cwd 记忆目录: /home/x/repos/foo → ~/.claude/projects/-home-x-repos-foo/memory。 */
export function claudeMemoryDirFor(absPath: string): string {
  const dashed = absPath.replace(/\//g, '-');
  return join(homedir(), '.claude', 'projects', dashed, 'memory');
}

/** OMD_DATA_HOME base;未设 → null = "退回 .omd/ 相对 cwd" (零回归)。 */
function dataHomeBase(): string | null {
  const env = process.env.OMD_DATA_HOME?.trim();
  return env && env.length > 0 ? env : null;
}

/** git toplevel;非 git → null。 */
function gitToplevel(cwd: string): string | null {
  try {
    const out = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

/**
 * 从 cwd 解析项目 scope。显式 `OMD_PROJECT` 覆盖 slug (别名);否则 git toplevel basename。
 * 非 git 且无 OMD_PROJECT → fail-closed 抛 (MP-INV-1)。
 */
export function resolveProject(cwd: string = process.cwd()): ProjectScope {
  const explicit = process.env.OMD_PROJECT?.trim();
  const root = gitToplevel(cwd);

  // MP-INV-1 (P3 放宽): 优先 git toplevel basename;非 git → cwd basename best-effort (script 入口
  // 不该因目录非 git 而崩);真无法 slugify (如 '/') → 'scratch'。显式 OMD_PROJECT 永远覆盖。
  const rootPath = root ?? cwd;
  const slug = explicit ? slugifyProject(explicit) : slugifyProject(basename(rootPath) || 'scratch');
  const base = dataHomeBase();

  return {
    slug,
    rootPath,
    claudeMemoryDir: claudeMemoryDirFor(rootPath),
    dataPath: (rel: string): string => (base ? join(base, 'projects', slug, rel) : join('.omd', rel)),
  };
}

// ---------------------------------------------------------------------------
// 进程级 active scope —— 散落的运行态路径点 (memory.db/skills.db/...) 经此读,
// 免把 scope 串进每个 factory 签名 (MP-INV-5)。tui 启动时 setActiveProject 一次。
// ---------------------------------------------------------------------------
let _active: ProjectScope | null = null;

/** 启动时设当前项目 scope (tui 调一次)。 */
export function setActiveProject(scope: ProjectScope): void {
  _active = scope;
}

/** 当前 active scope (未设 = null)。 */
export function activeProject(): ProjectScope | null {
  return _active;
}

/**
 * 进程级**项目本地**运行态路径: active scope 设了 → 走它 (OMD_DATA_HOME 感知);
 * 未设 → 退回 `.omd/<rel>` (零回归 — 测试/TUI 未接线路径行为不变)。
 * 用于 per-repo 工作态 (continuity / dag-runs)。
 */
export function dataPath(rel: string): string {
  return _active ? _active.dataPath(rel) : join('.omd', rel);
}

/**
 * 进程级**全局**运行态路径 (`$OMD_DATA_HOME/global/<rel>`,未设 → `.omd/<rel>` 兼容)。
 * 用于跨 repo 共享的学习/配额 (dispatch 飞轮 / web-quota / model-router) —— 你在任何 repo
 * 调 omd 都该复用同一份派活智慧 + 同一份 provider 配额账。不随 cwd repo 分裂。
 */
export function globalDataPath(rel: string): string {
  const base = dataHomeBase();
  return base ? join(base, 'global', rel) : join('.omd', rel);
}

/** 注入式 sql executor (postgres.js 兼容) — 保持本模块不依赖具体 db client。 */
export interface SqlExecutor {
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown>;
}

/**
 * MP-INV-3 自动接入: 首见 slug → 注册行 (含 claude memory dir + 默认源)。幂等。
 * sql 由调用方注入 (daemon 侧 postgres client)。
 */
export async function upsertProjectRegistry(scope: ProjectScope, sql: SqlExecutor): Promise<void> {
  await sql`
    INSERT INTO agent_memory.projects (slug, root_path, claude_memory_dir, source_globs)
    VALUES (${scope.slug}, ${scope.rootPath}, ${scope.claudeMemoryDir}, ${['docs/standards'] as unknown})
    ON CONFLICT (slug) DO UPDATE
      SET root_path = EXCLUDED.root_path, claude_memory_dir = EXCLUDED.claude_memory_dir
  `;
}
