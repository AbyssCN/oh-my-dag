/**
 * src/harness/skills/skills —— 方法论 skill 扫描与加载 (开放生态 S3 共享层, 真源唯一)。
 *
 * 从 src/tui/skills.ts 迁出扫描/加载件; TUI 侧 re-export 或改 import (O-S3-2)。
 * defaultSkillRoots 新增项目级根 <cwd>/.omd/skills (D-S3-3)。
 */
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSkillSource } from './compile';

/** 注入块的定界符。两端都要有(同 memory-inject:只有开头的话正文会被读成 skill 内容)。 */
export const SKILL_OPEN = '<omd-skill>';
export const SKILL_CLOSE = '</omd-skill>';

/**
 * 包内 `client-skills/` 的绝对路径。
 *
 * 与 `client-skills-install.ts:37` **同一条解析** —— 两处各写一份路径必漂,
 * 而漂了的症状是"TUI 里看不到那条 skill,但 `omd mcp` 装得出来"。
 */
export function skillsRoot(): string {
  return fileURLToPath(new URL('../../../client-skills', import.meta.url));
}

/**
 * 用户级 skill 目录(`~/.claude/skills`)。
 *
 * ⚠ 这是 owner 明确要的那一半:"下载了 skill 自动发现"。包内 `client-skills/` 是 omd 自带的
 * 方法论,用户装的那 100 多条在这里 —— 只认包内的话,`/lark` 这种永远出不来。
 */
export function userSkillsRoot(): string {
  return join(homedir(), '.claude', 'skills');
}

/**
 * 默认扫描顺序。**项目级在前** —— 同名时项目级那份赢 (D-S3-3: [<cwd>/.omd/skills, 包内 client-skills, ~/.claude/skills])。
 * seen 去重 = 先到先得, Root 序即优先级。
 */
export function defaultSkillRoots(cwd: string): string[] {
  return [join(cwd, '.omd', 'skills'), skillsRoot(), userSkillsRoot()];
}

export interface SkillMeta {
  name: string;
  /** frontmatter 的 description(一句话)。缺 → `null`,**不拿正文首行冒充**。 */
  description: string | null;
  /** 它是从哪个根扫出来的 —— `loadSkillBlock` 要靠它回到正确的目录。 */
  root: string;
}

/**
 * 列出全部可唤起的 skill(项目级 + 包内 + 用户级)。目录不在(瘦包 / 没装过 Claude Code)→ 跳过。
 *
 * ⚠ 同名**先到先得**:roots 序即优先级。项目级在前,所以项目级那份赢。
 * 反过来的话,用户目录里一个同名的旧副本会静默顶掉项目级新版 —— 而两者长得一模一样,查不出来。
 */
export function listSkills(roots: readonly string[]): SkillMeta[] {
  const out: SkillMeta[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const e of readdirSync(root, { withFileTypes: true })) {
      // ⚠ **不能用 `e.isDirectory()` 过滤**:`withFileTypes` 给的是 lstat 语义,
      //   符号链接一律返回 false。实测 `~/.claude/skills` 里 119 条有 **77 条是符号链接**
      //   (指向别的仓), 于是 `lark-*` 整族被静默跳过 —— `/lark` 永远出不来,
      //   而屏幕上只是"少了几条", 看不出是被过滤掉的。
      //   真正的判据是**有没有 SKILL.md**, 而那件事 `loadSkillSource` 已经在做(existsSync 跟随链接)。
      //   `.` / `_` 开头仍然跳过:那是约定的非 skill 目录(`_registry`、点文件)。
      if (e.name.startsWith('.') || e.name.startsWith('_')) continue;
      if (seen.has(e.name)) continue;
      const src = loadSkillSource(root, e.name);
      if (!src) continue; // 没有 SKILL.md 的目录不是 skill
      seen.add(e.name);
      const d = src.fm.description;
      out.push({ name: e.name, description: typeof d === 'string' && d.trim() ? d.trim() : null, root });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * ★ **成组的最小成员数。**
 *
 * 实测这台机器上的前缀分布:`lark-` 26 · `omd-` 21 · `xihe-` 4 · `skill-` 3,
 * 之后是一条长尾(大量只出现一两次的前缀)。门槛压到 1 或 2 会造出**几十个只有一个成员的组** ——
 * 那不是分组,是把一份扁平清单换了个更长的写法。3 是照读数定的,不是拍的。
 */
export const GROUP_MIN = 3;

export interface SkillGroup {
  /** 组名 = 第一个 `-` 之前那一段(`lark-im` → `lark`)。 */
  name: string;
  members: SkillMeta[];
}

/** 分组结果。**单体不是"杂项组"** —— 它们就是没有组的 skill,合成一个假组会误导。 */
export interface SkillGrouping {
  groups: SkillGroup[];
  loners: SkillMeta[];
}

/**
 * 按前缀分组。成员数不够 {@link GROUP_MIN} 的前缀**不成组**,其成员留作单体。
 *
 * @param reserved 保留名 (撞了这些名字的前缀不成组)。TUI 侧传 {@link reservedGroupNames},
 *   harness 侧默认 [] (无 TUI 命令名冲突)。
 */
export function groupSkills(skills: readonly SkillMeta[], reserved: readonly string[] = []): SkillGrouping {
  const byPrefix = new Map<string, SkillMeta[]>();
  const loners: SkillMeta[] = [];
  for (const s of skills) {
    const i = s.name.indexOf('-');
    if (i <= 0) {
      loners.push(s);
      continue;
    }
    const p = s.name.slice(0, i);
    const arr = byPrefix.get(p);
    if (arr) arr.push(s);
    else byPrefix.set(p, [s]);
  }
  const groups: SkillGroup[] = [];
  for (const [name, members] of byPrefix) {
    // ⚠ **撞了保留名的前缀不成组。** TUI 侧实测撞到:`skill-*` 有 3 条,够门槛,
    //   于是画出一个 `/skill` 组入口 —— 而 `/skill` 已经是内置命令, 分发轮不到组这一层。
    //   结果是一个**看得见但点不动**的入口, 比不画它更糟。
    //   这些成员退回单体, 仍然可以唤起, 一条都没丢。
    if (members.length >= GROUP_MIN && !reserved.includes(name)) groups.push({ name, members });
    else loners.push(...members);
  }
  groups.sort((a, b) => b.members.length - a.members.length || a.name.localeCompare(b.name));
  loners.sort((a, b) => a.name.localeCompare(b.name));
  return { groups, loners };
}

export interface LoadedSkill {
  name: string;
  /** 注进上下文的整块文本。 */
  block: string;
}

/**
 * 逐根找一条 skill 的源码。找不到 → `null`。
 *
 * 抽出来是因为 `loadSkillBlock`(给人用, 包一层纪律说明)与 `read_skill` 工具(给模型用,
 * 只要正文)**必须走同一条解析** —— 两处各写一份的话, 人看到的和模型读到的会是两条不同的 skill。
 */
export function loadSkillSourceByName(name: string, roots: readonly string[]) {
  for (const root of roots) {
    const src = loadSkillSource(root, name);
    if (src) return src;
  }
  return null;
}

/**
 * 唤起一条 skill。找不到 → `null`(调用方画"没这条",**不静默注入一个空块**)。
 *
 * @param rest 用户在 skill 名之后补的话 —— 原样带上,那通常是"用它来做什么"。
 */
export function loadSkillBlock(name: string, rest: string, roots: readonly string[]): LoadedSkill | null {
  // 与 read_skill 工具**同一条解析** —— 两处各写一份的话, 人看到的与模型读到的会是两条不同的 skill。
  const src = loadSkillSourceByName(name, roots);
  if (!src) return null;
  const head =
    `${SKILL_OPEN}\n` +
    `以下是 omd 的方法论 skill 「${name}」。**它是本轮的额外纪律,不是一件要执行的任务** ——\n` +
    '按它的做法办事;它与用户当前要求冲突时以用户为准。\n';
  const tail = rest ? `\n用户补充: ${rest}\n${SKILL_CLOSE}` : `\n${SKILL_CLOSE}`;
  return { name, block: `${head}\n${src.body.trim()}${tail}` };
}
