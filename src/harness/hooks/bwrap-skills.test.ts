import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bwrapArgs, skillHomeBinds } from './bwrap';

// 现场 (plana run 08307db2): jail 的 HOME=/tmp, read_skill 扫 /tmp/.claude/skills —— 没挂 →
// 只剩包内 omd-* 22 个, 档案声明的 impeccable 报「不存在」。而 ~/.claude/skills 多数是符号链接:
// 相对链接 (../../.agents/skills/x) 在 jail 里解析到 /tmp/.agents/skills, 绝对链接指向原路径。
describe('skillHomeBinds: 用户 skill 根挂进 jail HOME, 链接目标一并可达', () => {
  const home = mkdtempSync(join(tmpdir(), 'omd-skill-home-'));
  const skills = join(home, '.claude', 'skills');
  const agents = join(home, '.agents', 'skills');
  const other = mkdtempSync(join(tmpdir(), 'omd-skill-abs-'));
  mkdirSync(join(skills, 'plain'), { recursive: true });
  writeFileSync(join(skills, 'plain', 'SKILL.md'), '---\nname: plain\n---\n');
  mkdirSync(join(agents, 'rel'), { recursive: true });
  symlinkSync('../../.agents/skills/rel', join(skills, 'rel'));
  mkdirSync(join(other, 'abs'), { recursive: true });
  symlinkSync(join(other, 'abs'), join(skills, 'abs'));

  test('三类: 本体目录 → /tmp/.claude/skills · 相对链接父目录 → jail 内解析位置 · 绝对链接父目录 → 原路径', () => {
    const binds = skillHomeBinds(home, '/tmp');
    expect(binds).toContainEqual({ src: skills, dest: '/tmp/.claude/skills' });
    expect(binds).toContainEqual({ src: agents, dest: '/tmp/.agents/skills' });
    expect(binds).toContainEqual({ src: other, dest: other });
    expect(binds.length).toBe(3); // 按父目录去重, 不是一条链接一条绑定
  });

  test('没有 ~/.claude/skills → 空 (不挂不存在的路径)', () => {
    expect(skillHomeBinds(mkdtempSync(join(tmpdir(), 'omd-no-skills-')), '/tmp')).toEqual([]);
  });

  test('bwrapArgs 真的带上这些绑定, 且排在 --tmpfs /tmp 之后', () => {
    const args = bwrapArgs(mkdtempSync(join(tmpdir(), 'omd-root-')), [], { skillHome: home });
    const at = args.indexOf('/tmp/.claude/skills');
    expect(at).toBeGreaterThan(args.indexOf('--tmpfs'));
    expect(args[at - 2]).toBe('--ro-bind');
  });
});

describe('skillHome 的安全面', () => {
  test('★ 挂 skills 时 ~/.claude 下只有 skills 子树, 绝不挂 projects/ (会话记录)', () => {
    const home = mkdtempSync(join(tmpdir(), 'omd-skill-sec-'));
    mkdirSync(join(home, '.claude', 'skills', 'x'), { recursive: true });
    mkdirSync(join(home, '.claude', 'projects'), { recursive: true });
    const args = bwrapArgs(mkdtempSync(join(tmpdir(), 'omd-root-')), [], { skillHome: home });
    const srcs = args.filter((_, i) => args[i - 1] === '--ro-bind' || args[i - 1] === '--bind');
    const claudeish = srcs.filter((s) => s.includes('/.claude'));
    expect(claudeish).toEqual([join(home, '.claude', 'skills')]);
  });
});
