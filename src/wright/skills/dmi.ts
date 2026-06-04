/**
 * src/wright/skills/dmi — SKILL.md frontmatter `disable-model-invocation` 外科手术编辑 (Phase 1 step 3)。
 *
 * **外科式**而非 yaml.dump 整体重写: 弱模型/人写的 frontmatter 含 `>` 多行 description / 注释 /
 * key 顺序, 整体 re-serialize 会破坏。这里只动 disable-model-invocation 那一行 (有则改, 无则在闭合
 * `---` 前插), 其余字节不碰。
 *
 * **⚠️ R6 ③**: 这会改全局 `~/.claude/skills` (影响所有 CC session, 非只 wright)。调用方 (CLI) 必须
 * 显式传 skillsRoot, 不默认任何路径。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { splitFrontmatter } from './scanner';

/** 读 SKILL.md 的当前 DMI 态 (true = 已 disable, 不进 prompt)。文件无 frontmatter → false。 */
export function readDmi(skillMdPath: string): boolean {
  const { fm } = splitFrontmatter(readFileSync(skillMdPath, 'utf8'));
  return fm['disable-model-invocation'] === true;
}

/**
 * 外科设 DMI。返回 'changed' | 'noop' (已是目标值) | 'no-frontmatter' (无 `---` 块, 拒绝改)。
 * 幂等: 目标值与现状相同 → noop, 不写盘。
 */
export function setDmiInFile(skillMdPath: string, value: boolean): 'changed' | 'noop' | 'no-frontmatter' {
  const text = readFileSync(skillMdPath, 'utf8');
  const m = text.match(/^(﻿?\s*---\r?\n)([\s\S]*?)(\r?\n---\r?\n?)([\s\S]*)$/);
  if (!m) return 'no-frontmatter';
  const [, open, fmBody, close, rest] = m as unknown as [string, string, string, string, string];

  const eol = fmBody.includes('\r\n') ? '\r\n' : '\n';
  const line = `disable-model-invocation: ${value}`;
  const keyRe = /^(\s*)disable-model-invocation\s*:\s*.*$/m;

  let nextFmBody: string;
  if (keyRe.test(fmBody)) {
    const current = fmBody.match(keyRe)![0];
    if (current.trim() === line) return 'noop'; // 幂等
    nextFmBody = fmBody.replace(keyRe, (mm) => mm.replace(/disable-model-invocation\s*:\s*.*/, line));
  } else {
    // 插到 frontmatter 末尾 (闭合 --- 前)
    nextFmBody = fmBody.replace(/\s*$/, '') + eol + line;
  }
  writeFileSync(skillMdPath, open + nextFmBody + close + rest, 'utf8');
  return 'changed';
}

/** 解析 skillsRoot/<name>/SKILL.md 的绝对路径 (不存在 → null)。 */
export function skillMdPath(skillsRoot: string, name: string): string | null {
  const p = join(skillsRoot, name, 'SKILL.md');
  return existsSync(p) ? p : null;
}
