/**
 * 正文内嵌工具调用抢救解析 —— 形态表 + 三条边界。
 *
 * **反向自检 (仓规: 新加的闸必须当场证伪一次)**: 下面每一组"认得出"的用例, 都配一条
 * 把关键标记改掉之后**认不出**的对照。只有正向用例的解析器, 换个正则照样全绿。
 */
import { describe, expect, test } from 'bun:test';
import { containsEmbeddedToolCalls, parseEmbeddedToolCalls, stripSpans } from './tool-call-salvage';

const KNOWN = new Set(['write', 'read', 'bash']);

describe('形态表 —— 每一种都配一个真实见过的例子', () => {
  test('<tool_call> 里包 JSON (Qwen / MiniMax / GLM 系)', () => {
    const text = `我来写文件。\n<tool_call>{"name": "write", "arguments": {"path": "a.ts", "content": "x"}}</tool_call>`;
    const r = parseEmbeddedToolCalls(text, KNOWN);
    expect(r.calls).toEqual([{ name: 'write', arguments: { path: 'a.ts', content: 'x' } }]);
    expect(stripSpans(text, r.spans)).toBe('我来写文件。');
  });

  test('<tool-call> 连字符写法同样认', () => {
    const r = parseEmbeddedToolCalls(`<tool-call>{"tool":"read","args":{"path":"b.ts"}}</tool-call>`, KNOWN);
    expect(r.calls).toEqual([{ name: 'read', arguments: { path: 'b.ts' } }]);
  });

  test('<invoke name="…"> + <parameter name="…"> (Anthropic 风格被学去的形态)', () => {
    const text = `<invoke name="write">\n<parameter name="path">a.ts</parameter>\n<parameter name="content">hello</parameter>\n</invoke>`;
    const r = parseEmbeddedToolCalls(text, KNOWN);
    expect(r.calls).toEqual([{ name: 'write', arguments: { path: 'a.ts', content: 'hello' } }]);
  });

  test('<function=name> + <parameter=key> 等号写法', () => {
    const text = `<function=bash><parameter=command>ls -la</parameter></function>`;
    const r = parseEmbeddedToolCalls(text, KNOWN);
    expect(r.calls).toEqual([{ name: 'bash', arguments: { command: 'ls -la' } }]);
  });

  test('```json 围栏 —— 单条 / tool_calls 整包 / 裸数组三种壳', () => {
    const one = parseEmbeddedToolCalls('```json\n{"name":"read","arguments":{"path":"x"}}\n```', KNOWN);
    expect(one.calls).toHaveLength(1);
    const pack = parseEmbeddedToolCalls(
      '```json\n{"tool_calls":[{"name":"read","arguments":{"path":"x"}},{"name":"bash","arguments":{"command":"ls"}}]}\n```',
      KNOWN,
    );
    expect(pack.calls.map((c) => c.name)).toEqual(['read', 'bash']);
    const arr = parseEmbeddedToolCalls('```\n[{"name":"bash","arguments":{"command":"ls"}}]\n```', KNOWN);
    expect(arr.calls).toHaveLength(1);
  });

  test('OpenAI 线协议照抄: arguments 是 JSON **字符串**', () => {
    const r = parseEmbeddedToolCalls(
      `<tool_call>{"function":{"name":"write","arguments":"{\\"path\\":\\"a.ts\\"}"}}</tool_call>`,
      KNOWN,
    );
    expect(r.calls).toEqual([{ name: 'write', arguments: { path: 'a.ts' } }]);
  });

  test('整段正文就是一个 JSON 对象 (裸 JSON)', () => {
    const r = parseEmbeddedToolCalls('  {"name":"bash","arguments":{"command":"bun test"}}  ', KNOWN);
    expect(r.calls).toEqual([{ name: 'bash', arguments: { command: 'bun test' } }]);
  });
});

describe('反向 —— 标记不对就必须认不出 (证伪正则真的在干活)', () => {
  test('普通散文里提到工具名不算调用', () => {
    const text = '我打算用 write 工具把结果写进 a.ts, 但先确认一下路径。';
    expect(containsEmbeddedToolCalls(text)).toBe(false);
    expect(parseEmbeddedToolCalls(text, KNOWN).calls).toEqual([]);
  });

  test('散文中间夹一个 JSON 对象**不**抠出来 —— 那多半是模型在举例', () => {
    // 这条是刻意的取舍, 见 tool-call-salvage.ts ⑤ 的注: 从散文里抠 JSON 会把
    // 「我本来打算调 write」这句说明变成一次真实写入。
    const text = '例如可以这样调: {"name":"write","arguments":{"path":"a.ts"}} —— 但我先不写。';
    expect(parseEmbeddedToolCalls(text, KNOWN).calls).toEqual([]);
  });

  test('JSON 少了 name / tool / function 三种键 → 不是调用', () => {
    const r = parseEmbeddedToolCalls('<tool_call>{"path":"a.ts","content":"x"}</tool_call>', KNOWN);
    expect(r.calls).toEqual([]);
  });

  test('arguments 串本身坏了 → 整条丢弃, 不猜', () => {
    const r = parseEmbeddedToolCalls(`<tool_call>{"name":"write","arguments":"{not json"}</tool_call>`, KNOWN);
    expect(r.calls).toEqual([]);
  });
});

describe('三条边界', () => {
  test('工具名未注册 → 不抢救, 但要留名 (它和"正文里没有调用"是两件事)', () => {
    const r = parseEmbeddedToolCalls(`<tool_call>{"name":"rm_rf","arguments":{"path":"/"}}</tool_call>`, KNOWN);
    expect(r.calls).toEqual([]);
    expect(r.unknownNames).toEqual(['rm_rf']);
  });

  test('未闭合尾块 (被 maxTokens 砍断) → truncated 为真且**不产出调用**', () => {
    const r = parseEmbeddedToolCalls('先写文件\n<tool_call>{"name":"write","arguments":{"content":"半个文', KNOWN);
    expect(r.calls).toEqual([]);
    expect(r.truncated).toBe(true);
  });

  test('闭合块吃掉之后不残留开标签 → truncated 为假', () => {
    const r = parseEmbeddedToolCalls(`<tool_call>{"name":"read","arguments":{"path":"a"}}</tool_call>`, KNOWN);
    expect(r.truncated).toBe(false);
  });

  test('XML 参数值原样交出去 (不猜类型) —— schema 那一层去红', () => {
    const r = parseEmbeddedToolCalls('<function=bash><parameter=timeout>30</parameter></function>', KNOWN);
    expect(r.calls[0]!.arguments.timeout).toBe('30'); // 字符串, 不是 30
  });
});

/**
 * 2026-08-26 补的两种格式 —— **验收 fixture 逐字取自 iceCoder 对照报告**
 * (`docs/research/2026-08-26-icecoder-gap-analysis.md` 面 7 的「变红条件」),
 * 不是我自己编的例子。报告给的红判据是:任一 fixture 未产生且只产生一个结构化调用,
 * 或残留通道标记进入用户可见正文,即红。
 */
describe('★ 面 7 点名的两个漏项 (fixture 取自对照报告)', () => {
  const KNOWN2 = new Set(['run_command', 'read_file']);

  test('fixture ①: 方括号参数 `[<task_id>…]`', () => {
    const text = '<tool_call><function=run_command>[<task_id>bg_46rq7i][<action>check]</function></tool_call>';
    const r = parseEmbeddedToolCalls(text, KNOWN2);
    expect(r.calls).toEqual([{ name: 'run_command', arguments: { task_id: 'bg_46rq7i', action: 'check' } }]);
    expect(stripSpans(text, r.spans)).toBe('');
  });

  test('fixture ②: 通道分隔符 `<]minimax[>` —— 只产一个调用, 且标记不留在正文里', () => {
    const text =
      '<]minimax[><tool_call><function=run_command><parameter=action>check</parameter></function></tool_call>';
    const r = parseEmbeddedToolCalls(text, KNOWN2);
    expect(r.calls).toEqual([{ name: 'run_command', arguments: { action: 'check' } }]); // **恰好一个**, 不重复
    expect(stripSpans(text, r.spans)).toBe(''); // 残留通道标记 = 报告点名的红判据
  });

  test('通道分隔符当开标签 (没有正规 `<tool_call>` 开头)', () => {
    const text = '<]minimax[><function=read_file>[<path>a.ts]</tool_call>';
    const r = parseEmbeddedToolCalls(text, KNOWN2);
    expect(r.calls).toEqual([{ name: 'read_file', arguments: { path: 'a.ts' } }]);
  });

  test('反向: `[</tag>]` 闭合行不是参数 (否则会读出一个叫 `/tag` 的参数)', () => {
    const r = parseEmbeddedToolCalls('<tool_call><function=read_file>[<path>a.ts][</path>]</function></tool_call>', KNOWN2);
    expect(Object.keys(r.calls[0]!.arguments)).toEqual(['path']);
  });

  test('反向: 一条都没抢救到时**不剥**通道标记 (不替模型改我们不理解的正文)', () => {
    const text = '<]minimax[> 我先想想再说。';
    const r = parseEmbeddedToolCalls(text, KNOWN2);
    expect(r.calls).toEqual([]);
    expect(r.spans).toEqual([]);
    expect(stripSpans(text, r.spans)).toBe(text);
  });

  test('反向: 方括号值不跨 `]` (贪婪会把后一个参数一起吃掉)', () => {
    const r = parseEmbeddedToolCalls('<function=run_command>[<a>1][<b>2]</function>', KNOWN2);
    expect(r.calls[0]!.arguments).toEqual({ a: '1', b: '2' });
  });
});

describe('stripSpans', () => {
  test('多段区间挖干净, 重叠区间合并', () => {
    expect(stripSpans('abcdef', [{ start: 1, end: 3 }, { start: 2, end: 4 }])).toBe('aef');
  });
  test('空区间表 = 原文', () => {
    expect(stripSpans('abc', [])).toBe('abc');
  });
});
