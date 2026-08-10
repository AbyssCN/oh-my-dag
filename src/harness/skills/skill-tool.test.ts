/**
 * src/harness/skills/skill-tool —— read_skill umbrella 下放 leaf 的契约闸 (开放生态 S3, A TEST 片)。
 *
 * 覆盖 (契约 §GWT 逐条转录, 不发明):
 *  C-S3-2  roots 顺序 = [<cwd>/.omd/skills, 包内 client-skills, ~/.claude/skills], 同名项目胜;
 *  C-S3-3  纪律保留: 空 roots → createSkillTools 返回 []; 裸组名总览走 execute 返回值;
 *          promptSnippet/description 静态, 不含任何 skill 名 (冻结前缀 I-3)。
 *
 * 环境隔离 (D-S3-9): 全部 fixture 落 mkdtempSync 的 tmp 目录, 不读真仓 `.omd/` 与
 * `~/.claude/skills` (roots 顺序断言只比字符串, 不碰盘)。每条闸的证伪方式 (C-S3-6) 写在
 * 各 describe 头注里 —— 缺一条即证该闸是摆设。
 */
import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AnyOmdTool } from '../agent-tools';
import { createSkillTools } from './skill-tool';
import { defaultSkillRoots, listSkills, loadSkillSourceByName, skillsRoot, userSkillsRoot } from './skills';

/** 落一条最小 SKILL.md (frontmatter + 正文)。 */
function mkSkill(root: string, name: string, body: string): void {
  mkdirSync(join(root, name), { recursive: true });
  writeFileSync(join(root, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} 的测试描述\n---\n${body}\n`);
}

type ToolResult = { content: { type: string; text?: string }[]; details?: unknown };
const call = (t: AnyOmdTool, args: unknown): Promise<ToolResult> =>
  t.execute('call-1', args as never, undefined, undefined) as Promise<ToolResult>;
const resultText = (r: ToolResult): string => r.content.map((c) => (c.type === 'text' ? c.text ?? '' : '')).join('');

describe('C-S3-2: roots 顺序 = [<cwd>/.omd/skills, 包内 client-skills, ~/.claude/skills], 同名项目胜', () => {
  // 证伪 (C-S3-6): ① defaultSkillRoots 漏掉项目级根或把它排到包内之后 → 顺序 toEqual 当场红;
  // ② listSkills 的 seen 去重改成"后到的覆盖先到的" → 同名项目胜两条断言当场红。
  it('defaultSkillRoots(cwd) 三段顺序钉死: 项目级在前, 用户级殿后', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omd-s3-roots-'));
    expect(defaultSkillRoots(cwd)).toEqual([join(cwd, '.omd', 'skills'), skillsRoot(), userSkillsRoot()]);
  });

  it('同名 skill 三个根各一份 → 项目级版本赢 (listSkills 与 loadSkillSourceByName 同判)', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omd-s3-priority-'));
    const proj = join(cwd, '.omd', 'skills');
    const bundled = join(cwd, 'bundled');
    const home = join(cwd, 'home');
    mkSkill(proj, 'zk-dup', 'PROJECT 版正文');
    mkSkill(bundled, 'zk-dup', 'BUNDLED 版正文');
    mkSkill(home, 'zk-dup', 'HOME 版正文');
    const roots = [proj, bundled, home]; // Root 序即优先级 (D-S3-3), 先到先得
    const listed = listSkills(roots).filter((s) => s.name === 'zk-dup');
    expect(listed).toHaveLength(1); // seen 去重: 同名只留一份, 先扫到的赢
    expect(listed[0]!.root).toBe(proj);
    expect(loadSkillSourceByName('zk-dup', roots)?.body).toContain('PROJECT 版正文');
  });
});

describe('C-S3-3: 纪律保留 —— 空 roots 不挂, 组总览走返回值, promptSnippet 静态', () => {
  // 证伪 (C-S3-6): ①删掉零 skill 短路 (skills.length===0 仍挂工具) → 空 roots 两条断言红;
  // ②把组总览或扫描数字拼回 promptSnippet (2026-08-07 自查修前的形态) → 静态性断言红;
  // ③裸组名分支改成不列成员 → 总览断言红。
  it('空 roots → createSkillTools 返回 [] (恒失败的工具比没有更糟)', () => {
    expect(createSkillTools({ roots: [] })).toEqual([]);
    const empty = mkdtempSync(join(tmpdir(), 'omd-s3-empty-'));
    expect(createSkillTools({ roots: [empty] })).toEqual([]);
  });

  it('裸组名调用 → 组总览在 execute 返回值里 (不进冻结前缀)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'omd-s3-group-'));
    mkSkill(root, 'zk-alpha', 'A 正文');
    mkSkill(root, 'zk-beta', 'B 正文');
    mkSkill(root, 'zk-gamma', 'C 正文');
    const tools = createSkillTools({ roots: [root] });
    expect(tools).toHaveLength(1);
    const res = await call(tools[0]!, { name: 'zk' });
    const text = resultText(res);
    expect(text).toContain('zk-alpha');
    expect(text).toContain('zk-beta');
    expect(text).toContain('zk-gamma');
    expect(res.details).toEqual({ name: 'zk', found: true });
  });

  it('promptSnippet/description 静态: 不含任何 skill 名, 换 roots 逐字节不变', () => {
    const a = mkdtempSync(join(tmpdir(), 'omd-s3-static-a-'));
    const b = mkdtempSync(join(tmpdir(), 'omd-s3-static-b-'));
    mkSkill(a, 'zk-alpha', 'A 正文');
    mkSkill(b, 'zk-delta', 'D 正文');
    const ta = createSkillTools({ roots: [a] })[0]!;
    const tb = createSkillTools({ roots: [b] })[0]!;
    expect(ta.promptSnippet).toBe(tb.promptSnippet); // 静态: 与扫描结果无关 (I-3)
    expect(ta.description).toBe(tb.description);
    expect(ta.promptSnippet).not.toContain('zk-alpha'); // skill 名不进前缀
    expect(ta.promptSnippet).not.toContain('zk-delta');
  });

  it('★ 市面 skill 兼容 (O-2 裁决): 全文带目录锚 + 捆绑资源清单 —— 相对路径资源第三层披露不断链 (证伪: 删 skill-tool.ts 的 header 拼装 → 本条红)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'omd-s3-market-'));
    mkSkill(root, 'zk-market', '跑 scripts/run.py 完成任务');
    mkdirSync(join(root, 'zk-market', 'scripts'), { recursive: true });
    writeFileSync(join(root, 'zk-market', 'scripts', 'run.py'), 'print(1)');
    const t = createSkillTools({ roots: [root] })[0]!;
    const text = resultText(await call(t, { name: 'zk-market' }));
    expect(text).toContain(join(root, 'zk-market')); // 目录锚 (绝对路径)
    expect(text).toContain('scripts/run.py'); // 捆绑资源清单
    expect(text).toContain('跑 scripts/run.py 完成任务'); // 正文仍在
  });
});
