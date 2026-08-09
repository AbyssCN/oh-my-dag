/**
 * L1 判据:skill umbrella(S-6,owner 点名)。
 *
 * ## 为什么门槛是 3
 *
 * 实测这台机器上的前缀分布:`lark-` 26 · `omd-` 21 · `xihe-` 4 · `skill-` 3,
 * 之后是一条长尾。门槛压到 1 或 2 会造出几十个只有一个成员的"组" ——
 * 那不是分组,是把扁平清单换了个更长的写法。**门槛是照读数定的,不是拍的。**
 */
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { GROUP_MIN, type SkillMeta, formatGroupMembers, formatSkillList, groupSkills, listSkills, parseGroupCommand, parseSkillCommand, reservedGroupNames } from './skills';

const s = (name: string, description: string | null = 'd'): SkillMeta => ({ name, description, root: '/r' });
const many = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => s(`${prefix}-${i}`));

describe('分组', () => {
  test('★ 够门槛才成组', () => {
    const { groups } = groupSkills(many('lark', GROUP_MIN));
    expect(groups.map((g) => g.name)).toEqual(['lark']);
  });

  // ★ 反向自检 (实跑): 把 GROUP_MIN 改成 1 → 这条当场红。
  test('★ 不够门槛的留作单体, 不造只有一个成员的假组', () => {
    const { groups, loners } = groupSkills(many('solo', GROUP_MIN - 1));
    expect(groups).toEqual([]);
    expect(loners).toHaveLength(GROUP_MIN - 1);
  });

  test('没有前缀的本来就是单体', () => {
    const { groups, loners } = groupSkills([s('commit'), s('caveman')]);
    expect(groups).toEqual([]);
    expect(loners.map((x) => x.name)).toEqual(['caveman', 'commit']);
  });

  test('★ 以 - 开头的名字不算"空前缀组"', () => {
    const { groups, loners } = groupSkills([s('-weird'), ...many('omd', 3)]);
    expect(groups.map((g) => g.name)).toEqual(['omd']);
    expect(loners.map((x) => x.name)).toEqual(['-weird']);
  });

  test('组按成员数从多到少排 —— 最常用的排最前', () => {
    const { groups } = groupSkills([...many('lark', 26), ...many('omd', 21), ...many('xihe', 4)]);
    expect(groups.map((g) => g.name)).toEqual(['lark', 'omd', 'xihe']);
  });
});

describe('分组总览取代那面墙', () => {
  const wall = [...many('lark', 26), ...many('omd', 21), ...Array.from({ length: 60 }, (_, i) => s(`solo${i}`))];

  // ★ 这一条就是 S-6 存在的理由:107 条扁平铺开是 107 行, 全屏视口只有 20 出头。
  test('★ 107 条 skill 的总览不超过 5 行', () => {
    const lines = formatSkillList(wall).split('\n');
    expect(lines.length).toBeLessThanOrEqual(5);
  });

  test('★ 单体只报数不报名 —— 报名就退回成那面墙了', () => {
    const out = formatSkillList(wall);
    expect(out).toContain('plus 60 standalone skills');
    expect(out).not.toContain('solo7');
  });

  test('总览给得出下一步怎么敲', () => {
    const out = formatSkillList(wall);
    expect(out).toContain('/lark');
    expect(out).toContain('/skill all');
  });

  test('成员表去掉组前缀 —— 每行重复一遍 lark- 只是噪音', () => {
    const { groups } = groupSkills(many('lark', 3));
    const out = formatGroupMembers(groups[0] as never);
    expect(out).toContain('  0:');
    expect(out).not.toContain('lark-0');
  });
});

describe('★ 组名不许撞内置命令', () => {
  /**
   * 实测撞到:`skill-*` 有 3 条、够门槛, 于是画出一个 `/skill` 组入口 ——
   * 而 `/skill` 已经是内置命令, 分发轮不到组这一层。
   * 一个**看得见但点不动**的入口比不画它更糟。
   */
  test('★ 撞了内置命令名的前缀退回单体, 一条都不丢', () => {
    const members = many('skill', GROUP_MIN);
    const { groups, loners } = groupSkills(members, ['skill']);
    expect(groups).toEqual([]);
    expect(loners).toHaveLength(GROUP_MIN);
  });

  test('没撞上的照常成组', () => {
    const { groups } = groupSkills(many('lark', GROUP_MIN), ['skill']);
    expect(groups.map((g) => g.name)).toEqual(['lark']);
  });

  // ★ 反向自检: 把 reservedGroupNames 改成 () => [] → 这条当场红。
  test('★ 默认就带着内置命令名, 不用调用方记得传', () => {
    expect(reservedGroupNames()).toContain('skill');
    expect(reservedGroupNames()).toContain('help');
    expect(groupSkills(many('skill', GROUP_MIN)).groups).toEqual([]);
  });
});

describe('★ 符号链接的 skill 也要认', () => {
  /**
   * 实测:`~/.claude/skills` 里 119 条**有 77 条是符号链接**(指向别的仓)。
   * 第一版用 `Dirent.isDirectory()` 过滤 —— 那是 lstat 语义, 对符号链接一律 false,
   * 于是 `lark-*` 整族被静默跳过, `/lark` 永远出不来。屏幕上只是"少了几条", 看不出被过滤了。
   */
  test('★ 链接进来的 skill 与真目录一视同仁', () => {
    const home = mkdtempSync(join(tmpdir(), 'omd-skill-link-'));
    const real = mkdtempSync(join(tmpdir(), 'omd-skill-real-'));
    // 真目录一条
    mkdirSync(join(home, 'plain-a'));
    writeFileSync(join(home, 'plain-a', 'SKILL.md'), '---\ndescription: 甲\n---\n正文');
    // 链接一条
    mkdirSync(join(real, 'linked-b'));
    writeFileSync(join(real, 'linked-b', 'SKILL.md'), '---\ndescription: 乙\n---\n正文');
    symlinkSync(join(real, 'linked-b'), join(home, 'linked-b'));

    const names = listSkills([home]).map((x) => x.name);
    expect(names).toContain('plain-a');
    expect(names).toContain('linked-b'); // ← 反向自检: 恢复 isDirectory() 过滤 → 这一行当场红
  });

  test('`.` 与 `_` 开头仍然跳过 —— 那是约定的非 skill 目录', () => {
    const home = mkdtempSync(join(tmpdir(), 'omd-skill-skip-'));
    for (const n of ['_registry', '.hidden']) {
      mkdirSync(join(home, n));
      writeFileSync(join(home, n, 'SKILL.md'), '---\ndescription: x\n---\n正文');
    }
    expect(listSkills([home])).toEqual([]);
  });
});

describe('组命令解析', () => {
  const names = ['omd', 'lark'];

  test('/lark → 列成员', () => {
    expect(parseGroupCommand('/lark', names)).toEqual({ group: 'lark', member: null, rest: '' });
  });

  test('★ 成员名写全写短都认 —— 补全给全名, 人记得住短名', () => {
    expect(parseGroupCommand('/omd council 审这批', names)).toEqual({ group: 'omd', member: 'omd-council', rest: '审这批' });
    expect(parseGroupCommand('/omd omd-council 审这批', names)).toEqual({ group: 'omd', member: 'omd-council', rest: '审这批' });
  });

  // ★ 反向自检: 把 `groupNames.includes(head)` 去掉 → 这条当场红,
  //   而症状会是"/help 忽然不响应了"(被当成组名吃掉)。
  test('★ 清单外的名字一律不接管 —— 否则会把别的命令吃掉', () => {
    expect(parseGroupCommand('/help', names)).toBeNull();
    expect(parseGroupCommand('/settings', names)).toBeNull();
    expect(parseGroupCommand('随便说句话', names)).toBeNull();
    expect(parseGroupCommand('/lark', [])).toBeNull();
  });
});

describe('/skill all 逃生口', () => {
  test('★ 有全表可看 —— 总览默认不铺单体, 但"到底有哪些"必须问得出来', () => {
    expect(parseSkillCommand('/skill all')).toEqual({ kind: 'all' });
  });

  test('all 带了参数就当成 skill 名, 不当逃生口', () => {
    expect(parseSkillCommand('/skill all 顺便')).toEqual({ kind: 'invoke', name: 'all', rest: '顺便' });
  });
});
