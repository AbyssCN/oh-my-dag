/**
 * Wright 技能加载 (harness 迁移 A 档)。
 * .claude/skills/<name>/SKILL.md (Agent Skills 标准) → Pi `loadSkillsFromDir` 原生消费。
 * 近 drop-in: SKILL.md frontmatter (name/description) 两套格式一致。
 */
import { join } from 'node:path';
import {
  loadSkillsFromDir,
  formatSkillsForPrompt,
  type LoadSkillsResult,
  type Skill,
} from '@earendil-works/pi-coding-agent';

export const SKILLS_DIR = join('.claude', 'skills');

/** 从 .claude/skills 加载全部 SKILL.md。source='wright' 用于溯源诊断。 */
export function loadWrightSkills(cwd: string = process.cwd()): LoadSkillsResult {
  return loadSkillsFromDir({ dir: join(cwd, SKILLS_DIR), source: 'wright' });
}

export { formatSkillsForPrompt };
export type { Skill, LoadSkillsResult };
