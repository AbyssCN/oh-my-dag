/**
 * src/tui/skills —— **方法论 skill 进 TUI**(goal §4 S15,A7)。
 *
 * ## 为什么这一片**不需要** S15a 的扩展宿主
 *
 * goal §4 把 S15 标成「被岔口 ① 阻塞」,理由是加载机制与 extension 问题绑在一起。
 * **那个绑定是错的**,查了才看清:A7 要的是「在 TUI 里唤起 **omd 的**方法论 skill」——
 * `client-skills/` 那 20 个 `omd-*` 是**包内自带的一等公民**(`client-skills-install.ts:37`
 * 从包根解析它们),不是从 npm 装来的第三方代码。
 *
 * 读自己仓里的 markdown 不需要沙箱。**沙箱那条约束管的是第三方 extension**(S15a),
 * 与这一片是两件事 —— 把它们捆在一起会让一个不需要隔离的能力等一个进程宿主。
 * (这条偏离已在 commit 里写明,不是静默绕过 owner 的裁决。)
 *
 * ## 注入的是**纪律**,不是让它去执行
 *
 * skill 的 SKILL.md 是一套方法论(怎么审、怎么切、什么算完)。唤起一条 skill =
 * 把它的正文作为**本轮**的额外纪律注进上下文,不是替 conductor 决定要做什么。
 * 所以它走与记忆注入同一条 `transformContext` 甲类钩子,**只影响这一次请求**,
 * 也**不写进 ChatStore** —— 否则一条 skill 会在往后每一轮里重复出现。
 */
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSkillSource } from '../harness/skills/compile';
import { COMMAND_NAMES } from './commands';
import { fitLine } from './render/line';

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
  return fileURLToPath(new URL('../../client-skills', import.meta.url));
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

/** 默认扫描顺序。**包内在前** —— 同名时包内那份赢(它是一等公民,版本跟着 omd 走)。 */
export function defaultSkillRoots(): string[] {
  return [skillsRoot(), userSkillsRoot()];
}

export interface SkillMeta {
  name: string;
  /** frontmatter 的 description(一句话)。缺 → `null`,**不拿正文首行冒充**。 */
  description: string | null;
  /** 它是从哪个根扫出来的 —— `loadSkillBlock` 要靠它回到正确的目录。 */
  root: string;
}

/**
 * 列出全部可唤起的 skill(包内 + 用户级)。目录不在(瘦包 / 没装过 Claude Code)→ 跳过。
 *
 * ⚠ 同名**先到先得**:包内排在前面,所以 omd 自带的那份赢。反过来的话,
 * 用户目录里一个同名的旧副本会静默顶掉包内的新版 —— 而两者长得一模一样,查不出来。
 */
export function listSkills(roots: readonly string[] = defaultSkillRoots()): SkillMeta[] {
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

/** 内置命令占掉的名字(裸名)。组名撞上它们就不成组 —— 见 `groupSkills` 的说明。 */
export function reservedGroupNames(): string[] {
  return COMMAND_NAMES.map((n) => n.replace(/^\//, ''));
}

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
 */
export function groupSkills(skills: readonly SkillMeta[], reserved: readonly string[] = reservedGroupNames()): SkillGrouping {
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
    // ⚠ **撞了内置命令名的前缀不成组。** 实测撞到:`skill-*` 有 3 条,够门槛,
    //   于是画出一个 `/skill` 组入口 —— 而 `/skill` 已经是内置命令, 分发轮不到组这一层。
    //   结果是一个**看得见但点不动**的入口, 比不画它更糟。
    //   这些成员退回单体, 仍然可以 `/skill <全名>` 唤起, 一条都没丢。
    if (members.length >= GROUP_MIN && !reserved.includes(name)) groups.push({ name, members });
    else loners.push(...members);
  }
  groups.sort((a, b) => b.members.length - a.members.length || a.name.localeCompare(b.name));
  loners.sort((a, b) => a.name.localeCompare(b.name));
  return { groups, loners };
}

/** `/skill` 的解析。四态:分组总览 / 全表 / 唤起 / 不是这条命令。 */
export type SkillCommand = { kind: 'list' } | { kind: 'all' } | { kind: 'invoke'; name: string; rest: string } | null;

export function parseSkillCommand(text: string): SkillCommand {
  const t = text.trim();
  if (t !== '/skill' && !t.startsWith('/skill ')) return null;
  const parts = t.slice('/skill'.length).trim();
  if (!parts) return { kind: 'list' };
  const [name, ...rest] = parts.split(/\s+/);
  // `/skill all` 是**逃生口**:分组总览默认不铺单体, 但"到底有哪些"必须问得出来。
  if (name === 'all' && rest.length === 0) return { kind: 'all' };
  return { kind: 'invoke', name: name as string, rest: rest.join(' ') };
}

/**
 * 组命令的解析:`/lark` 列成员,`/lark im 帮我发条消息` 唤起 `lark-im` 并把补充带上。
 *
 * ⚠ 成员名**可写全名也可写后缀**(`/omd council` 与 `/omd omd-council` 都成立)——
 * 人记得住的是后者的短形,而补全给出的是全名,两种都得认。
 *
 * @param groupNames 当前真实存在的组名。**不认清单外的名字** —— 否则 `/help` 这类
 *   命令会被当成组名吃掉,而症状是"某条命令忽然不响应了"。
 */
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

/**
 * 一条 skill 的描述在列表里最多占多少字符。超出截断。
 *
 * ⚠ 这不是排版洁癖。frontmatter 的 description 动辄 200 字(含 Trigger/Skip 全文),
 * 20 条铺开就是 80 行 —— 全屏之后**头部直接被顶出视口**,人看到的是半截列表。
 * 列表的职责是"有哪些",不是"每条讲什么";要细节的人会去唤起它。
 */
const LIST_DESC_BUDGET = 58;

/**
 * ⚠ 截断按**可见宽度**不按字符数。第一版按 `length` 截,中文一个字占两列,
 * 于是 58 个字符画出来是 116 列 —— 照样折行,墙一点没矮。走 `fitLine` 是因为
 * 本仓「宽度只有一把尺子」(`src/tui/AGENTS.md`),自己数字符就是第二把。
 */
function clip(s: string, budget = LIST_DESC_BUDGET): string {
  return fitLine(s.replace(/\s+/g, ' ').trim(), budget, '…');
}

/**
 * 列表渲染。缺 description 画 `-`,不编。
 *
 * ★ **"只管本轮"那句话放在最后一行,不放抬头。** 全屏视口只留得住尾部,
 * 放抬头的话它是第一个被顶掉的 —— 而它恰恰是这条命令最容易被误解的地方
 * (唤起 ≠ 立刻执行)。位置在这里是判据不是口味。
 */
/**
 * ★ **分组总览**(S-6 umbrella)。默认视图,不铺全表。
 *
 * 起因是实测:这台机器上包内 21 条 + 用户级 119 条,扁平铺开是 **140 行**,
 * 而全屏视口只有 20 出头 —— 头部直接被顶掉,人看到的是半截清单。
 * 分组之后默认视图是"几个组 + 一行单体计数",全表留给 `/skill all`。
 *
 * ⚠ 单体只报数不报名:报名就退回成那面墙了。要名字的人打 `/skill all`。
 */
export function formatSkillList(skills: SkillMeta[]): string {
  if (skills.length === 0) return 'No skills to invoke (neither bundled client-skills/ nor ~/.claude/skills exists or has entries)';
  const { groups, loners } = groupSkills(skills);
  const lines: string[] = [];
  for (const g of groups) {
    lines.push(`  /${g.name}  (${g.members.length})  - /${g.name} lists members, /${g.name} <member> invokes one`);
  }
  if (loners.length > 0) lines.push(`  plus ${loners.length} standalone skills - /skill all lists everything`);
  return `${lines.join('\n')}\nUsage: /skill <name> [notes] - invoking one injects its discipline into **this turn** only, never stored in the session`;
}

/** 全表(`/skill all`)。一行一条,描述按可见宽度截断。 */
export function formatSkillAll(skills: SkillMeta[]): string {
  if (skills.length === 0) return 'No skills to invoke';
  const lines = skills.map((s) => `  ${s.name}: ${s.description ? clip(s.description) : '-'}`);
  return `${lines.join('\n')}\n${skills.length} total. Usage: /skill <name> [notes] - injects discipline into **this turn** only, never stored in the session`;
}

/** 一个组的成员表(`/lark`)。组名前缀去掉 —— 每行重复一遍 `lark-` 只是噪音。 */
export function formatGroupMembers(group: SkillGroup): string {
  const lines = group.members.map((m) => {
    const short = m.name.slice(group.name.length + 1);
    return `  ${short}: ${m.description ? clip(m.description) : '-'}`;
  });
  return `${group.name} (${group.members.length}):\n${lines.join('\n')}\nUsage: /${group.name} <member> [notes]`;
}

export interface LoadedSkill {
  name: string;
  /** 注进上下文的整块文本。 */
  block: string;
}

/**
 * 唤起一条 skill。找不到 → `null`(调用方画"没这条",**不静默注入一个空块**)。
 *
 * @param rest 用户在 skill 名之后补的话 —— 原样带上,那通常是"用它来做什么"。
 */
/**
 * 逐根找一条 skill 的源码。找不到 → `null`。
 *
 * 抽出来是因为 `loadSkillBlock`(给人用, 包一层纪律说明)与 `read_skill` 工具(给模型用,
 * 只要正文)**必须走同一条解析** —— 两处各写一份的话, 人看到的和模型读到的会是两条不同的 skill。
 */
export function loadSkillSourceByName(name: string, roots: readonly string[] = defaultSkillRoots()) {
  for (const root of roots) {
    const src = loadSkillSource(root, name);
    if (src) return src;
  }
  return null;
}

export function loadSkillBlock(name: string, rest: string, roots: readonly string[] = defaultSkillRoots()): LoadedSkill | null {
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
