/**
 * Wright 身份注入 (harness 迁移 B 档)。
 * root CLAUDE.md + .claude/CLAUDE.md → Pi system-prompt 前缀块 (Wright 人格契约文案)。
 * 缺文件静默跳过 (worktree / 裁剪部署容忍)。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** 身份文件 (按注入顺序): root 首屏锚点 → .claude 完整规则。 */
export const IDENTITY_FILES = ['CLAUDE.md', join('.claude', 'CLAUDE.md')] as const;

/** 读取并拼接 Wright 身份契约为单个 system-prompt 块。 */
export function loadWrightIdentity(cwd: string = process.cwd()): string {
  const parts: string[] = [];
  for (const rel of IDENTITY_FILES) {
    const p = join(cwd, rel);
    if (existsSync(p)) {
      const body = readFileSync(p, 'utf8').trim();
      if (body) parts.push(`<!-- ${rel} -->\n${body}`);
    }
  }
  return parts.join('\n\n');
}
