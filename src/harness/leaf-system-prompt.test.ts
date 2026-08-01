/**
 * leaf 系统提示的**形状**回归 (2026-08-01)。
 *
 * 搬到 `pi-agent-core` 之前这段是 pi CLI 拼的, 里面大半页在讲 pi 自己的文档路径 —— 对一个只负责
 * 写一个文件的 DAG 叶子是纯噪声, 还占着最贵的那段缓存前缀。自己拼之后要钉住两件事:
 *   ① 工具的自我介绍**跟着工具走** —— 加一个工具不必再改系统提示 (否则迟早漏一个, 模型就看不见它);
 *   ② **字节稳定** —— 这段是每个 leaf 请求的最前缀, 逐 leaf 漂一个字就是全场 prompt-cache 失效。
 */
import { describe, expect, it } from 'bun:test';
import { buildLeafSystemPrompt } from './agent-leaf';
import { createOmdAgentTools } from './agent-tools';

const TOOLS = createOmdAgentTools({ cwd: '/w' });

describe('leaf 系统提示', () => {
  it('★ 每个工具的 promptSnippet 都进「可用工具」段 —— 介绍跟着工具走', () => {
    const p = buildLeafSystemPrompt({ cwd: '/w', tools: TOOLS });
    for (const t of TOOLS) {
      expect(t.promptSnippet).toBeTruthy(); // 工具自己要带介绍, 否则模型看不见它
      expect(p).toContain(t.promptSnippet!);
    }
  });

  it('工具的 promptGuidelines 汇进「工具守则」段, 且去重', () => {
    const withGuides = [
      ...TOOLS,
      { ...TOOLS[0]!, name: 'x1', promptGuidelines: ['守则甲'] },
      { ...TOOLS[0]!, name: 'x2', promptGuidelines: ['守则甲', '守则乙'] },
    ];
    const p = buildLeafSystemPrompt({ cwd: '/w', tools: withGuides });
    expect(p.match(/守则甲/g)).toHaveLength(1);
    expect(p).toContain('守则乙');
  });

  it('没有 guidelines 时不留空的「工具守则」段', () => {
    const bare = TOOLS.map((t) => ({ ...t, promptGuidelines: undefined }));
    expect(buildLeafSystemPrompt({ cwd: '/w', tools: bare })).not.toContain('工具守则');
  });

  it('★ 字节稳定: 同一组工具 + 同一个 cwd → 逐字相同 (缓存前缀不许逐 leaf 漂)', () => {
    const a = buildLeafSystemPrompt({ cwd: '/w', tools: TOOLS });
    const b = buildLeafSystemPrompt({ cwd: '/w', tools: TOOLS });
    expect(a).toBe(b);
  });

  it('工作根写进去了 (相对路径的解析基准, 模型得知道)', () => {
    expect(buildLeafSystemPrompt({ cwd: '/w/sub', tools: TOOLS })).toContain('工作根: /w/sub');
  });

  it('项目说明书按传入顺序进 <project_instructions>', () => {
    const p = buildLeafSystemPrompt({
      cwd: '/w',
      tools: TOOLS,
      contextFiles: [
        { path: '/w/AGENTS.md', content: '外层约定' },
        { path: '/w/sub/AGENTS.md', content: '内层约定' },
      ],
    });
    expect(p).toContain('<project_instructions path="/w/AGENTS.md">\n外层约定\n</project_instructions>');
    expect(p.indexOf('外层约定')).toBeLessThan(p.indexOf('内层约定'));
  });

  it('★ 不再夹带 pi 自己的文档指路 (那是 CLI 的事, 不是叶子的事)', () => {
    const p = buildLeafSystemPrompt({ cwd: '/w', tools: TOOLS });
    expect(p).not.toContain('pi, a coding agent harness');
    expect(p).not.toMatch(/docs\/extensions\.md/);
  });
});
