/**
 * src/harness/skills/skill-tool —— **让模型自己取 skill** (开放生态 S3, read_skill umbrella 下放 leaf)。
 *
 * ## 为什么必须有这个工具
 *
 * umbrella 把发现层做成了"组 → 成员",但**模型没有任何通道去拿成员正文** ——
 * 唤起只能由人打 `/omd council`。于是 owner 要的那句"让模型自己发现、整理"少了一半:
 * 模型看得见组里有什么(system prompt 里有清单),却读不到任何一条。
 *
 * ## 分野:人定纪律,模型取资料
 *
 * `/skill <name>` 注入的那一块开头写着"这是本轮的额外纪律" —— 那是**人**给的约束。
 * 这个工具返回的是**正文本身**,不带那句话:模型主动读一条 skill 是查资料,
 * 不是给自己下纪律。两条路都存在,措辞不同不是疏忽。
 *
 * ⚠ 只读叶子。没有"读一个组"的形态 —— 组没有正文,它只是一层路由。
 */
import { Type } from 'typebox';
import type { Static } from 'typebox';
import type { AnyOmdTool, OmdTool } from '../agent-tools';
import { defaultSkillRoots, groupSkills, listSkills, loadSkillSourceByName } from './skills';

const SCHEMA = Type.Object({
  name: Type.String({
    description: 'Skill name. Accepts the full name (omd-council) or group+member (omd council).',
  }),
});

/** 名字归一:`omd council` / `omd-council` 都指同一条。 */
export function normalizeSkillName(raw: string, groupNames: readonly string[]): string {
  const t = raw.trim().replace(/\s+/g, ' ');
  if (!t.includes(' ')) return t;
  const [head, ...tail] = t.split(' ');
  if (head && groupNames.includes(head)) return `${head}-${tail.join('-')}`;
  return t.replace(/ /g, '-');
}

export interface SkillToolDeps {
  /** 注入用:扫描根。默认 defaultSkillRoots(cwd)。 */
  roots?: readonly string[];
  /** 工作根 (cwd), 用于 defaultSkillRoots 计算项目级根。 */
  cwd?: string;
}

/**
 * `read_skill` —— 一个工具,不是一族。
 *
 * 列表不做成工具:组与成员的清单**已经在 system prompt 里**(工具的 promptSnippet 带着),
 * 再给一个 `list_skills` 等于让模型花一次调用去拿它已经有的东西。
 */
export function createSkillTools(deps: SkillToolDeps = {}): AnyOmdTool[] {
  const roots = deps.roots ?? (deps.cwd ? defaultSkillRoots(deps.cwd) : []);
  const skills = listSkills(roots);
  if (skills.length === 0) return []; // 没有 skill 就不挂这个工具 —— 恒失败的工具比没有更糟
  const { groups } = groupSkills(skills);
  const groupNames = groups.map((g) => g.name);

  const tool: OmdTool<{ name: string; found: boolean }> = {
    name: 'read_skill',
    label: 'read_skill',
    description:
      'Read the full text of a methodology skill. Use it when a task matches a skill\'s trigger — ' +
      'the skill describes how to do that kind of work. Accepts "omd-council" or "omd council". ' +
      'Call it with a bare group name (e.g. "omd") to list that group\'s members.',
    /**
     * ★ **这一行必须是静态的。**(2026-08-07 自查修)
     *
     * 第一版往这里嵌了**启动时扫盘算出的组总览**(`lark(26) · omd(21) · xihe(4)`)。
     * 而 prompt cache 是**逐字节前缀匹配**:tools → system → messages,第 N 位差一个字节,
     * **N 之后的所有断点全失效**;工具定义又属于前缀最前面那一段。
     * 于是**装一条新 skill 就废掉整个前缀的缓存** —— 包括后面那两份 CLAUDE.md。
     * 官方对这件事的说法是"别中途改工具集,要减工具就延迟加载而不是移除"。
     *
     * 组总览没有消失,它挪进了**工具的返回值**(见 `execute` 的裸组名分支)——
     * 返回值在 messages 里、是追加的,不会让前缀失效。
     */
    promptSnippet:
      'read_skill(name) —— 读一条方法论 skill 的正文(名字形如 `<组>-<成员>`, 如 omd-council)。' +
      '不知道有哪些组时, 用裸组名调一次会列出该组成员。',
    parameters: SCHEMA,
    executionMode: 'parallel',
    async execute(_id, params) {
      const { name } = params as Static<typeof SCHEMA>;
      const bare = name.trim();
      // 裸组名 → 列成员。**这条是上面那段注释的另一半**:组总览从冻结前缀挪到了这里。
      const hitGroup = groups.find((g) => g.name === bare);
      if (hitGroup) {
        const rows = hitGroup.members.map((m) => `- ${m.name}: ${m.description ?? '-'}`).join('\n');
        return {
          content: [{ type: 'text', text: `${bare} 组共 ${hitGroup.members.length} 条:\n${rows}` }],
          details: { name: bare, found: true },
        };
      }
      const resolved = normalizeSkillName(bare, groupNames);
      const src = loadSkillSourceByName(resolved, roots);
      if (!src) {
        // 找不到就说找不到并给出可选项 —— **不返回空串**:空串会被读成"这条 skill 没内容"。
        const near = skills
          .filter((s) => s.name.startsWith(resolved.split('-')[0] ?? ''))
          .slice(0, 12)
          .map((s) => s.name);
        return {
          content: [{ type: 'text', text: `没有名为 ${resolved} 的 skill。相近的: ${near.join(', ') || '(无)'}` }],
          details: { name: resolved, found: false },
        };
      }
      return { content: [{ type: 'text', text: src.body.trim() }], details: { name: resolved, found: true } };
    },
  };
  return [tool as AnyOmdTool];
}
