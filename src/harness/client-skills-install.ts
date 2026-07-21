/**
 * client-skills 自装 —— `omd mcp` 启动副作用:把包内自带的 `omd-*` 客户端技能幂等铺进用户级
 * `~/.claude/skills/`,让「装了 omd MCP」的用户新会话即得 `/omd-path` `/omd-deepen` 等斜杠命令,
 * 免手 `cp`。设计三条铁律(反 happy-path):
 *   ① best-effort —— 任何失败只 stderr 记一行, 绝不阻断/崩 MCP server(同 server 版本读的兜底范式);
 *   ② 不覆盖用户改过的 —— 每个技能记 SKILL.md 内容 hash 到中央清单 `.omd-skills.json`;
 *      目标存在且 hash ≠ 我们上次写的 → 判定用户动过(或第三方同名)→ 跳过, 不碰;
 *   ③ opt-out —— `OMD_INSTALL_SKILLS=0|false|no` 关掉整个自装。
 * 幂等: 每次启动都跑, 目标缺 → 装; 是我们写的且源变了 → 更; 用户改过/第三方 → 跳。包更新自动带新技能。
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const SKILL_FILE = 'SKILL.md';
const PREFIX = 'omd-';
const MANIFEST = '.omd-skills.json'; // 住 skills 根, 记我们写过的每个技能 hash → 区分"我们的未改" vs "用户改过/第三方"

export interface InstallSummary {
  installed: string[];
  updated: string[];
  skipped: string[]; // 用户改过或第三方同名, 保留不碰
  reason?: string; // 整体跳过原因 (opt-out / 无源 / 错误)
}

/** SKILL.md 内容 hash —— 这些技能都是单文件载荷, 只需哈希 SKILL.md 即可判定"是否被动过"。 */
function skillHash(dir: string): string | null {
  const f = join(dir, SKILL_FILE);
  if (!existsSync(f)) return null;
  return createHash('sha256').update(readFileSync(f)).digest('hex');
}

/** 解析包内 client-skills 源目录 (本模块在 src/harness/ → ../../client-skills = 包根)。缺失回 null(瘦包/无源)。 */
function resolveSourceRoot(): string | null {
  const root = fileURLToPath(new URL('../../client-skills', import.meta.url));
  return existsSync(root) ? root : null;
}

/** 用户级 skills 根: 尊重 CLAUDE_CONFIG_DIR 覆盖, 否则 ~/.claude/skills。 */
function resolveSkillsRoot(): string {
  const base = process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), '.claude');
  return join(base, 'skills');
}

function optedOut(): boolean {
  const v = process.env.OMD_INSTALL_SKILLS?.trim().toLowerCase();
  return v === '0' || v === 'false' || v === 'no' || v === 'off';
}

/**
 * 幂等铺设。纯副作用, 全程 try/catch 吞异常 → 返回摘要供调用方按需 stderr 记, 从不抛。
 * @param srcRootOverride/dstRootOverride 仅测试注入; 生产走 resolve*。
 */
export function installClientSkills(opts: { srcRoot?: string; dstRoot?: string } = {}): InstallSummary {
  const summary: InstallSummary = { installed: [], updated: [], skipped: [] };
  try {
    if (optedOut()) return { ...summary, reason: 'opt-out (OMD_INSTALL_SKILLS)' };

    const srcRoot = opts.srcRoot ?? resolveSourceRoot();
    if (!srcRoot) return { ...summary, reason: '无 client-skills 源目录' };
    const dstRoot = opts.dstRoot ?? resolveSkillsRoot();
    mkdirSync(dstRoot, { recursive: true });

    // 中央清单: { [skillName]: contentHash } —— 只记我们写过的。读坏/缺失 → 空 (视作首装)。
    const manifestPath = join(dstRoot, MANIFEST);
    let manifest: Record<string, string> = {};
    if (existsSync(manifestPath)) {
      try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, string>; }
      catch { manifest = {}; }
    }

    const names = readdirSync(srcRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name.startsWith(PREFIX))
      .map((e) => e.name)
      .sort();

    for (const name of names) {
      const srcDir = join(srcRoot, name);
      const srcHash = skillHash(srcDir);
      if (!srcHash) continue; // 源无 SKILL.md → 跳 (不该发生)
      const dstDir = join(dstRoot, name);

      if (!existsSync(dstDir)) {
        cpSync(srcDir, dstDir, { recursive: true });
        manifest[name] = srcHash;
        summary.installed.push(name);
        continue;
      }
      const dstHash = skillHash(dstDir);
      const ours = manifest[name];
      if (ours === undefined || dstHash !== ours) {
        // 我们没记过(第三方同名) 或 记过但现内容≠上次写的(用户改过) → 保留用户/第三方, 不碰。
        summary.skipped.push(name);
        continue;
      }
      // 是我们的且用户没改: 源变了才更新 (rm+cp 清干净, 防源删文件残留)。
      if (srcHash !== dstHash) {
        rmSync(dstDir, { recursive: true, force: true });
        cpSync(srcDir, dstDir, { recursive: true });
        manifest[name] = srcHash;
        summary.updated.push(name);
      }
    }

    // 清单只增不误删: 写回当前状态 (含本轮新 hash)。
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    return summary;
  } catch (e) {
    return { ...summary, reason: `自装异常: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** 摘要压成一行人读串, 供 stderr 记 (安静: 无动作回空串, 调用方可略过)。 */
export function formatInstallSummary(s: InstallSummary): string {
  const parts: string[] = [];
  if (s.installed.length) parts.push(`装 ${s.installed.length}`);
  if (s.updated.length) parts.push(`更 ${s.updated.length}`);
  if (s.skipped.length) parts.push(`跳 ${s.skipped.length}(用户改过/第三方)`);
  if (s.reason && !parts.length) return `omd client-skills 自装: ${s.reason}`;
  if (!parts.length) return '';
  return `omd client-skills 自装: ${parts.join(' / ')} → ~/.claude/skills/`;
}
