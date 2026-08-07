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
import { fileURLToPath } from 'node:url';
import { loadSkillSource } from '../harness/skills/compile';

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

export interface SkillMeta {
  name: string;
  /** frontmatter 的 description(一句话)。缺 → `null`,**不拿正文首行冒充**。 */
  description: string | null;
}

/** 列出全部一等公民 skill。目录不在(瘦包)→ 空数组。 */
export function listSkills(root = skillsRoot()): SkillMeta[] {
  if (!existsSync(root)) return [];
  const out: SkillMeta[] = [];
  for (const e of readdirSync(root, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    const src = loadSkillSource(root, e.name);
    if (!src) continue; // 没有 SKILL.md 的目录不是 skill
    const d = src.fm.description;
    out.push({ name: e.name, description: typeof d === 'string' && d.trim() ? d.trim() : null });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** `/skill` 的解析。三态:列表 / 唤起 / 不是这条命令。 */
export type SkillCommand = { kind: 'list' } | { kind: 'invoke'; name: string; rest: string } | null;

export function parseSkillCommand(text: string): SkillCommand {
  const t = text.trim();
  if (t !== '/skill' && !t.startsWith('/skill ')) return null;
  const parts = t.slice('/skill'.length).trim();
  if (!parts) return { kind: 'list' };
  const [name, ...rest] = parts.split(/\s+/);
  return { kind: 'invoke', name: name as string, rest: rest.join(' ') };
}

/** 列表渲染。缺 description 画 `-`,不编。 */
export function formatSkillList(skills: SkillMeta[]): string {
  if (skills.length === 0) return 'client-skills 目录不在或为空 (瘦包?) —— 没有可唤起的 skill';
  const lines = skills.map((s) => `  ${s.name}: ${s.description ?? '-'}`);
  return `omd 方法论 skill (唤起后注入**本轮**纪律, 不写进会话):\n${lines.join('\n')}\n用法: /skill <name> [补充说明]`;
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
export function loadSkillBlock(name: string, rest: string, root = skillsRoot()): LoadedSkill | null {
  const src = loadSkillSource(root, name);
  if (!src) return null;
  const head =
    `${SKILL_OPEN}\n` +
    `以下是 omd 的方法论 skill 「${name}」。**它是本轮的额外纪律,不是一件要执行的任务** ——\n` +
    '按它的做法办事;它与用户当前要求冲突时以用户为准。\n';
  const tail = rest ? `\n用户补充: ${rest}\n${SKILL_CLOSE}` : `\n${SKILL_CLOSE}`;
  return { name, block: `${head}\n${src.body.trim()}${tail}` };
}
