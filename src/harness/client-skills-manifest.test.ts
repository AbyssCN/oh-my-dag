/**
 * client-skills 出厂清单闸 —— 目录 · README 表 · SKILL.md frontmatter 三者必须逐个对上。
 *
 * ## 为什么要这条闸
 *
 * 2026-08-07 的第三趟清点(`docs/plan/2026-08-07-omd-skill-方法论进-conductor-清点.md` D-1)
 * 量到:本机 `~/.claude/skills/` 有 21 个 `omd-*`,仓内 `client-skills/` 只有 19 个。
 * 差的两个(`omd-investigate` / `omd-research-deep`)**只活在作者这一台机器上** ——
 * 别人装了 omd 根本拿不到,而 README 照样把技能包写得像是全的。
 *
 * 这是最坏的一种形态:**看起来出厂了,其实没有。** 它不会报错、不会红、不会有人投诉,
 * 因为受害者是"没装到的人",而他们不知道自己少了什么。同一天 README 还同时挂着三个
 * 互相矛盾的数(正文说 16、标题说 19、表里 18 行)——**三个数没有一个是对的**,
 * 而且都是手写的。
 *
 * ⇒ 数不该手写。这条闸让它们对不上就红。
 *
 * ## 判据(三条,各自独立会红)
 *
 * 1. 目录里每个 `omd-*` 都在 README 表里有行 —— 否则出厂了没人知道。
 * 2. README 表里每行都有对应目录 —— 否则用户按表找,装到的却没有。
 * 3. 每个 `SKILL.md` 的 frontmatter `name:` 等于目录名 —— Claude Code 按 `name` 注册斜杠命令,
 *    对不上就是"目录在、命令不在"。
 *
 * ## 反向自检(本仓惯例:新加闸必须当场证伪一次)
 *
 * 三条都当场证伪过:① `mv client-skills/omd-sast /tmp/` → 判据 2 红(README 有行、目录没了)
 * ② 在 README 表尾按同样格式加一行 omd-nonexistent → 判据 2 红
 * ③ 把 `omd-recall/SKILL.md` 的 `name:` 改成 `omd-recal` → 判据 3 红。
 * 复跑方式同上,改完记得改回来。
 *
 * ## 诚实边界
 *
 * 只管**清单一致性**,不管内容对不对。一个 SKILL.md 正文全是错的,这条闸照样绿 ——
 * 那是 review 的活,不是这里的。也不管本机 `~/.claude/skills/` 装成了什么样
 * (那是安装侧状态,仓内测试碰不到,也不该碰)。
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadSkillSource } from './skills/compile';

const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');
const SKILLS_DIR = join(ROOT, 'client-skills');

/** 目录里真正出厂的技能名(`client-skills/` 下的 omd- 前缀目录)。 */
function shippedSkills(): string[] {
  return readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.startsWith('omd-'))
    .map((d) => d.name)
    .sort();
}

/** README 「技能一览」表里列出的名字(表格行首那个反引号包着的 /omd-xxx)。 */
function readmeListed(): string[] {
  const text = readFileSync(join(SKILLS_DIR, 'README.md'), 'utf8');
  const names: string[] = [];
  for (const line of text.split('\n')) {
    const m = /^\|\s*`\/(omd-[a-z0-9-]+)`/.exec(line);
    if (m?.[1]) names.push(m[1]);
  }
  return names.sort();
}

describe('client-skills 出厂清单', () => {
  test('目录与 README 表逐个对上(两个方向都查)', () => {
    const shipped = shippedSkills();
    const listed = readmeListed();
    expect(shipped.length).toBeGreaterThan(0); // 路径写错时别静默绿
    // 目录有、README 没有 = 出厂了没人知道
    expect(shipped.filter((n) => !listed.includes(n))).toEqual([]);
    // README 有、目录没有 = 用户按表找却装不到 (D-1 那两个正是这个形态的反面)
    expect(listed.filter((n) => !shipped.includes(n))).toEqual([]);
  });

  test('SKILL.md frontmatter 的 name 等于目录名', () => {
    for (const dir of shippedSkills()) {
      const text = readFileSync(join(SKILLS_DIR, dir, 'SKILL.md'), 'utf8');
      const m = /^name:\s*(\S+)\s*$/m.exec(text);
      expect(m?.[1], `${dir}/SKILL.md 缺 frontmatter name:`).toBe(dir);
    }
  });
});

describe('★ 每个 skill 都 load 得出来 (2026-08-07 加, 当场抓到 omd-slim)', () => {
  /**
   * 这条闸是 TUI 的 `/skill` (A7) 逼出来的: 出厂清单只核"目录/README/name 对不对得上",
   * **没有人核过 frontmatter 能不能被 YAML 解出来**。
   *
   * 抓到的真问题: `omd-slim` 的 description 里有个**没加引号的 `ponytail:`** ——
   * 冒号让 YAML 把它读成嵌套 mapping → `bad indentation of a mapping entry` →
   * `loadSkillSource` 返回 null。后果不止 TUI 看不到它: skill 编译器 (`/omd-distill`)、
   * agent 模板卡走的都是同一个函数, **它对所有消费者都是坏的**, 只是从来没人量过。
   *
   * 反向自检: 把 omd-slim description 的引号去掉 → 这条当场红。
   */
  test('client-skills/ 里每个目录的 SKILL.md 都能被 loadSkillSource 解出来', () => {
    const bad: string[] = [];
    for (const e of readdirSync(SKILLS_DIR, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      if (!loadSkillSource(SKILLS_DIR, e.name)) bad.push(e.name);
    }
    expect(bad, `这些 skill 的 frontmatter 解不出来 (多半是没加引号的冒号)`).toEqual([]);
  });
});
