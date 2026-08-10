/**
 * src/tui/skills —— TUI 侧 skill 门面 (开放生态 S3: 扫描/加载真源迁 harness, 此文件 re-export + TUI 专有)。
 *
 * O-S3-2: 真源唯一 —— 扫描/解析逻辑只在 src/harness/skills/ 一份。
 * TUI 专有件 (format*, parse*, reservedGroupNames) 留此文件。
 * TUI 向后兼容 wrapper (listSkills/defaultSkillRoots/loadSkillBlock 维持旧调用签名无 cwd,
 *   groupSkills 默认 reserved = reservedGroupNames())。
 */

// ── 扫描/加载件真源 (从 harness import) ──
import {
  listSkills as _listSkills,
  loadSkillSourceByName as _loadSkillSourceByName,
  loadSkillBlock as _loadSkillBlock,
  groupSkills as _groupSkills,
  skillsRoot as _skillsRoot,
  userSkillsRoot as _userSkillsRoot,
  SKILL_OPEN as _SKILL_OPEN,
  SKILL_CLOSE as _SKILL_CLOSE,
  GROUP_MIN as _GROUP_MIN,
  type SkillMeta,
  type SkillGroup,
  type SkillGrouping,
  type LoadedSkill,
} from '../harness/skills/skills';

// ── re-export (类型 + 常量) ──
export { type SkillMeta, type SkillGroup, type SkillGrouping, type LoadedSkill };
export const SKILL_OPEN = _SKILL_OPEN;
export const SKILL_CLOSE = _SKILL_CLOSE;
export const GROUP_MIN = _GROUP_MIN;
export const skillsRoot = _skillsRoot;
export const userSkillsRoot = _userSkillsRoot;

// ── TUI 专有: reservedGroupNames 必须在 groupSkills wrapper 之前 ──
import { COMMAND_NAMES } from './commands';

/** 内置命令占掉的名字(裸名)。组名撞上它们就不成组 —— 见 `groupSkills` 的说明。 */
export function reservedGroupNames(): string[] {
  return COMMAND_NAMES.map((n) => n.replace(/^\//, ''));
}

// groupSkills wrapper: TUI 默认 reserved = reservedGroupNames() (harness 默认 [])
export function groupSkills(skills: readonly SkillMeta[], reserved: readonly string[] = reservedGroupNames()): SkillGrouping {
  return _groupSkills(skills, reserved);
}

import { fitLine } from './render/line';

/** `/skill` 的解析。四态:分组总览 / 全表 / 唤起 / 不是这条命令。 */
export type SkillCommand = { kind: 'list' } | { kind: 'all' } | { kind: 'invoke'; name: string; rest: string } | null;

export function parseSkillCommand(text: string): SkillCommand {
  const t = text.trim();
  if (t !== '/skill' && !t.startsWith('/skill ')) return null;
  const parts = t.slice('/skill'.length).trim();
  if (!parts) return { kind: 'list' };
  const [name, ...rest] = parts.split(/\s+/);
  if (name === 'all' && rest.length === 0) return { kind: 'all' };
  return { kind: 'invoke', name: name as string, rest: rest.join(' ') };
}

export function parseGroupCommand(
  text: string,
  groupNames: readonly string[],
): { group: string; member: string | null; rest: string } | null {
  const t = text.trim();
  if (!t.startsWith('/')) return null;
  const [head, ...tail] = t.slice(1).split(/\s+/);
  if (!head || !groupNames.includes(head)) return null;
  if (tail.length === 0) return { group: head, member: null, rest: '' };
  const raw = tail[0] as string;
  const member = raw.startsWith(`${head}-`) ? raw : `${head}-${raw}`;
  return { group: head, member, rest: tail.slice(1).join(' ') };
}

const LIST_DESC_BUDGET = 58;

function clip(s: string, budget = LIST_DESC_BUDGET): string {
  return fitLine(s.replace(/\s+/g, ' ').trim(), budget, '…');
}

export function formatSkillList(skills: readonly SkillMeta[]): string {
  if (skills.length === 0) return 'No skills to invoke (neither bundled client-skills/ nor ~/.claude/skills exists or has entries)';
  const { groups, loners } = groupSkills(skills, reservedGroupNames());
  const lines: string[] = [];
  for (const g of groups) {
    lines.push(`  /${g.name}  (${g.members.length})  - /${g.name} lists members, /${g.name} <member> invokes one`);
  }
  if (loners.length > 0) lines.push(`  plus ${loners.length} standalone skills - /skill all lists everything`);
  return `${lines.join('\n')}\nUsage: /skill <name> [notes] - invoking one injects its discipline into **this turn** only, never stored in the session`;
}

export function formatSkillAll(skills: readonly SkillMeta[]): string {
  if (skills.length === 0) return 'No skills to invoke';
  const lines = skills.map((s) => `  ${s.name}: ${s.description ? clip(s.description) : '-'}`);
  return `${lines.join('\n')}\n${skills.length} total. Usage: /skill <name> [notes] - injects discipline into **this turn** only, never stored in the session`;
}

export function formatGroupMembers(group: SkillGroup): string {
  const lines = group.members.map((m) => {
    const short = m.name.slice(group.name.length + 1);
    return `  ${short}: ${m.description ? clip(m.description) : '-'}`;
  });
  return `${group.name} (${group.members.length}):\n${lines.join('\n')}\nUsage: /${group.name} <member> [notes]`;
}

// ── TUI 向后兼容 wrapper: 维持旧调用签名 (无 cwd, 默认 roots = [包内, ~/.claude]) ──

/** TUI 默认扫描根: 不含项目级 .omd/skills (TUI 侧无 cwd 约束)。 */
export function defaultSkillRoots(): string[] {
  return [skillsRoot(), userSkillsRoot()];
}

/** 列出全部可唤起的 skill。缺省 roots = [包内, ~/.claude] (TUI 向后兼容)。 */
export function listSkills(roots?: readonly string[]): SkillMeta[] {
  return _listSkills(roots ?? defaultSkillRoots());
}

/** 逐根找一条 skill 的源码。缺省 roots = [包内, ~/.claude] (TUI 向后兼容)。 */
export function loadSkillSourceByName(name: string, roots?: readonly string[]) {
  return _loadSkillSourceByName(name, roots ?? defaultSkillRoots());
}

/** 唤起一条 skill。缺省 roots = [包内, ~/.claude] (TUI 向后兼容)。 */
export function loadSkillBlock(name: string, rest: string, roots?: readonly string[]): LoadedSkill | null {
  return _loadSkillBlock(name, rest, roots ?? defaultSkillRoots());
}
