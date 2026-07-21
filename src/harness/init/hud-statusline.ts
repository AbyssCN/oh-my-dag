/**
 * src/harness/init/hud-statusline — omd-hud statusLine 的 opt-in 安装 (omd init 挂载点)。
 *
 * 写到 <repoRoot>/.claude/settings.local.json (Claude Code 约定 gitignore, per-user, project 级):
 *   - 只在本 repo 生效 (project 覆盖 user, 不动用户全局 claude-hud)
 *   - 不进版本库 (别的 cloner 各自 omd init 决定装不装 → 不劫持访客底栏)
 *
 * 非破坏性 merge (保留 settings.local.json 其余 key) + 幂等 (已装 → 无变更) +
 * 坏 JSON 拒绝覆盖 (不静默吞用户既有配置)。命令用绝对路径 → 不赖 cwd=repo 根。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface StatusLineBlock {
  type: 'command';
  command: string;
  refreshInterval: number;
  padding: number;
}

/** statusLine 命令: 绝对路径, Claude Code 从任意子目录起会话都能定位脚本。 */
export function hudStatusLineCommand(repoRoot: string): string {
  return `bun run ${join(repoRoot, 'scripts', 'omd-hud.ts')}`;
}

/** 完整 statusLine 块 (refreshInterval=2 → 空闲时也每 2s 刷活体进度; 见 docs/omd-hud.md)。 */
export function hudStatusLineBlock(repoRoot: string): StatusLineBlock {
  return { type: 'command', command: hudStatusLineCommand(repoRoot), refreshInterval: 2, padding: 0 };
}

export type MergeOutcome =
  | { ok: true; content: string; alreadyInstalled: boolean }
  | { ok: false; reason: string };

/**
 * 把 HUD statusLine merge 进既有 settings.local.json 文本 (null = 文件不存在)。纯函数。
 * 坏 JSON / 顶层非对象 → { ok:false } (拒绝覆盖, 由调用方提示手动处理, 绝不吞用户内容)。
 */
export function mergeHudStatusLine(existing: string | null, repoRoot: string): MergeOutcome {
  let obj: Record<string, unknown> = {};
  if (existing && existing.trim()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(existing);
    } catch {
      return { ok: false, reason: 'settings.local.json 非法 JSON — 拒绝覆盖, 请手动加 statusLine' };
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { ok: false, reason: 'settings.local.json 顶层非对象 — 拒绝覆盖' };
    }
    obj = parsed as Record<string, unknown>;
  }
  const block = hudStatusLineBlock(repoRoot);
  const cur = obj.statusLine as Partial<StatusLineBlock> | undefined;
  const alreadyInstalled = !!cur && cur.type === 'command' && cur.command === block.command;
  obj.statusLine = block;
  return { ok: true, content: `${JSON.stringify(obj, null, 2)}\n`, alreadyInstalled };
}

export interface HudInstallDeps {
  readFile?: (p: string) => string | null;
  writeFile?: (p: string, content: string) => void;
  ensureDir?: (dir: string) => void;
}

export interface HudInstallResult {
  status: 'installed' | 'already' | 'failed';
  path: string;
  reason?: string;
}

/** 安装 (或幂等跳过) HUD statusLine 到 <repoRoot>/.claude/settings.local.json。fs 可注入 (测试)。 */
export function installHudStatusLine(repoRoot: string, deps: HudInstallDeps = {}): HudInstallResult {
  const dir = join(repoRoot, '.claude');
  const path = join(dir, 'settings.local.json');
  const read = deps.readFile ?? ((p) => (existsSync(p) ? readFileSync(p, 'utf8') : null));
  const write = deps.writeFile ?? ((p, c) => writeFileSync(p, c, 'utf8'));
  const ensureDir = deps.ensureDir ?? ((d) => { if (!existsSync(d)) mkdirSync(d, { recursive: true }); });

  const outcome = mergeHudStatusLine(read(path), repoRoot);
  if (!outcome.ok) return { status: 'failed', path, reason: outcome.reason };
  if (outcome.alreadyInstalled) return { status: 'already', path };
  try {
    ensureDir(dir);
    write(path, outcome.content);
    return { status: 'installed', path };
  } catch (err) {
    return { status: 'failed', path, reason: err instanceof Error ? err.message : String(err) };
  }
}
