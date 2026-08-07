/**
 * L1 判据:方法论 skill 进 TUI(goal §4 S15,A7)。
 *
 * 读的是**包内真的那 20 个 `omd-*`** —— 不造夹具:这一片的价值恰恰在于
 * "TUI 看到的与 `omd mcp` 装出去的是同一批",造一份假 skill 目录就把那条边测没了。
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installClientSkills } from '../harness/client-skills-install';
import { SKILL_CLOSE, SKILL_OPEN, formatSkillList, listSkills, loadSkillBlock, parseSkillCommand, skillsRoot } from './skills';

describe('parseSkillCommand', () => {
  test('不是 /skill 的不接管', () => {
    expect(parseSkillCommand('帮我审一下')).toBeNull();
    expect(parseSkillCommand('/skillset')).toBeNull();
  });

  test('裸 /skill → 列表', () => {
    expect(parseSkillCommand('/skill')).toEqual({ kind: 'list' });
  });

  test('/skill <name> [补充] → 唤起, 补充原样带上', () => {
    expect(parseSkillCommand('/skill omd-review 看这批 diff')).toEqual({
      kind: 'invoke', name: 'omd-review', rest: '看这批 diff',
    });
    expect(parseSkillCommand('/skill omd-review')).toEqual({ kind: 'invoke', name: 'omd-review', rest: '' });
  });
});

describe('★ 读的是包内真的那一批(与 omd mcp 装出去的同源)', () => {
  test('listSkills 至少列出 README 之外的一批 omd-* skill', () => {
    // ⚠ 显式只扫**包内**那个根。S-6 之后 listSkills 默认还扫 ~/.claude/skills,
    //   而那里装了什么因机器而异 —— 拿它断言"每条都以 omd- 开头"就是拿别人的机器当判据。
    const names = listSkills([skillsRoot()]).map((s) => s.name);
    expect(names.length).toBeGreaterThan(10);
    expect(names).toContain('omd-council');
    expect(names.every((n) => n.startsWith('omd-'))).toBe(true);
  });

  test('★ 与 `client-skills-install` 是**同一条路径解析** —— 两处各写一份必漂', () => {
    // 漂了的症状: TUI 里看不到那条 skill, 但 `omd mcp` 装得出来。
    const installed = installClientSkills({ dstRoot: mkdtempSync(join(tmpdir(), 'omd-skill-home-')) });
    const listed = new Set(listSkills().map((s) => s.name));
    for (const n of installed.installed ?? []) expect(listed.has(n), `装了但列不出: ${n}`).toBe(true);
  });

  test('没有 SKILL.md 的目录不算 skill', () => {
    const root = mkdtempSync(join(tmpdir(), 'omd-skill-root-'));
    mkdirSync(join(root, 'not-a-skill'));
    expect(listSkills([root])).toEqual([]);
  });

  test('★ 缺 description 画 null, **不拿正文首行冒充**', () => {
    const root = mkdtempSync(join(tmpdir(), 'omd-skill-nodesc-'));
    mkdirSync(join(root, 'x'));
    writeFileSync(join(root, 'x', 'SKILL.md'), '# 标题\n正文首行');
    expect(listSkills([root])[0]).toEqual({ name: 'x', description: null, root });
  });

  test('目录不在(瘦包)→ 空数组, 不抛', () => {
    expect(listSkills(['/nonexistent/omd-client-skills'])).toEqual([]);
  });
});

describe('★ 唤起 = 注入纪律, 不是执行', () => {
  test('注入块说清"它是本轮的额外纪律, 不是一件要执行的任务"', () => {
    const b = loadSkillBlock('omd-council', '', [skillsRoot()]);
    expect(b).not.toBeNull();
    expect(b?.block).toContain('额外纪律');
    expect(b?.block).toContain('不是一件要执行的任务');
  });

  test('★ 两端都有定界符', () => {
    const b = loadSkillBlock('omd-council', '', [skillsRoot()]) as { block: string };
    expect(b.block.startsWith(SKILL_OPEN)).toBe(true);
    expect(b.block.endsWith(SKILL_CLOSE)).toBe(true);
  });

  test('★ 说清与用户要求冲突时以用户为准 —— 否则一条 skill 能把当轮指令顶掉', () => {
    expect((loadSkillBlock('omd-council', '', [skillsRoot()]) as { block: string }).block).toContain('以用户为准');
  });

  test('用户补充原样带上', () => {
    const b = loadSkillBlock('omd-council', '拿它审这批座位读数', [skillsRoot()]) as { block: string };
    expect(b.block).toContain('拿它审这批座位读数');
  });

  test('★ 找不到 → null(调用方画"没这条", 不静默注入空块)', () => {
    expect(loadSkillBlock('omd-根本没有这条', '', [skillsRoot()])).toBeNull();
  });

  test('注入的是 SKILL.md 正文(frontmatter 不进去)', () => {
    const b = loadSkillBlock('omd-council', '', [skillsRoot()]) as { block: string };
    expect(b.block).not.toContain('---\nname:');
  });
});

describe('formatSkillList', () => {
  test('空目录说清是"目录不在或为空", 不画一张空表', () => {
    expect(formatSkillList([])).toContain('没有可唤起的 skill');
  });

  test('说清注入只管本轮、不写进会话', () => {
    const out = formatSkillList([{ name: 'omd-x', description: 'd', root: '/r' }]);
    expect(out).toContain('本轮');
    expect(out).toContain('不写进会话');
  });
});
