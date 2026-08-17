/**
 * A2 omd_inspect 判据:
 *  ① 前缀零字节 —— 工具的 name/description/promptSnippet/schema 与 cwd 内容无关
 *    (两个内容完全不同的仓装配出的静态面逐字节相等; 动态清单只活在返回值里)。
 *  ② 空仓: 各节明说"无", 不报错。
 *  ③ 真内容: 装了的 agent 卡 / playbook / mcp server 出现在对应节。
 *  ④ 未知 section: 点名可选值, 不抛。
 *  ⑤ 坏 playbook: loadPlaybooks 的 fail-loud 原样端给模型 (inspect 自己不炸)。
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInspectTool } from './inspect-tool';

let dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'omd-inspect-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

async function run(cwd: string, what?: string): Promise<string> {
  const [tool] = createInspectTool({ cwd });
  const res = await tool!.execute('t', what ? { what } : {});
  return (res.content[0] as { text: string }).text;
}

describe('omd_inspect', () => {
  test('① 前缀零字节: 静态面与 cwd 内容无关', () => {
    const empty = tmp();
    const rich = tmp();
    mkdirSync(join(rich, '.omd'), { recursive: true });
    writeFileSync(join(rich, '.omd', 'mcp.json'), JSON.stringify({ mcpServers: { s: { url: 'http://x' } } }));
    const staticFace = (cwd: string) => {
      const [t] = createInspectTool({ cwd });
      return JSON.stringify({ name: t!.name, description: t!.description, promptSnippet: t!.promptSnippet, parameters: t!.parameters });
    };
    expect(staticFace(empty)).toBe(staticFace(rich));
    // 动态数字禁入静态面 (skill-tool 原坑): 静态面里不许出现扫盘计数
    expect(staticFace(rich)).not.toContain('1 个');
  });

  test('② 空仓: 总览有座位/原语计数, mcp/skills 明说无', async () => {
    const cwd = tmp();
    const text = await run(cwd);
    expect(text).toContain('seats:');
    expect(text).toContain('primitives:');
    expect(await run(cwd, 'mcp')).toContain('无注册');
    // skills 三层含用户级 (~/.claude/skills) —— 空仓不等于零 skill, 只断言节可取不炸
    expect(await run(cwd, 'skills')).toContain('skills');
  });

  test('③ 真内容: 项目 agent 卡 / mcp server 出现在对应节', async () => {
    const cwd = tmp();
    mkdirSync(join(cwd, '.omd', 'agents'), { recursive: true });
    writeFileSync(
      join(cwd, '.omd', 'agents', 'my-card.md'),
      ['---', 'name: my-card', 'description: 测试卡一句话', '---', '', 'persona 正文'].join('\n'),
    );
    mkdirSync(join(cwd, '.omd'), { recursive: true });
    writeFileSync(join(cwd, '.omd', 'mcp.json'), JSON.stringify({ mcpServers: { probe: { command: 'echo' } } }));
    const agents = await run(cwd, 'agents');
    expect(agents).toContain('my-card');
    expect(agents).toContain('测试卡一句话');
    const mcp = await run(cwd, 'mcp');
    expect(mcp).toContain('probe [stdio]');
    // seats 节独立可取且含真源指针
    expect(await run(cwd, 'seats')).toContain('src/model/seats.ts');
  });

  test('④ 未知 section: 点名可选值', async () => {
    const text = await run(tmp(), 'zzz');
    expect(text).toContain('未知 section');
    expect(text).toContain('seats');
  });

  test('⑤ 坏 playbook: fail-loud 原文进返回值, inspect 不炸', async () => {
    const cwd = tmp();
    mkdirSync(join(cwd, '.omd', 'playbooks', 'bad'), { recursive: true });
    writeFileSync(join(cwd, '.omd', 'playbooks', 'bad', 'playbook.json'), JSON.stringify({ name: 'bad', steps: 'not-a-list' }));
    const text = await run(cwd, 'playbooks');
    expect(text).toContain('加载失败');
  });
});
