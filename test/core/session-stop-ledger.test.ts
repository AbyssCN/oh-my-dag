/**
 * tests/harness/session/stop-ledger.test.ts —— W3 Stop-ledger parser 测试切片(Open-5 冻结, RED gate 后不可变)。
 *
 * 契约:src/harness/session/stop-ledger.ts 的冻结 API(parseStopLedger),逐字见
 *   docs/plan/session-continuity-follow-on.md §2。行为真源 = 冻结 Markdown 断言:
 *   docs/plan/2026-08-06-已实测两份真实-omd-transcript-191-485-行-核心风险-格式漂移打断-tok.md
 *   (GWT-3/4/6 · D-3/D-5 · E-P1 ctxTokens 公式) + docs/plan/session-continuity-pathfinder.md。
 *
 * 覆盖:增量 ledger 消费 · usage/ctxTokens 记账 · touched-file/Bash 抽取材料 ·
 *   user 基础设施前导容忍(<system-reminder / <task-notification 精确前缀) ·
 *   lastUserAsk 逆序选择(最后真实 ask;仅原始精确前缀跳过, 宽泛过滤禁止) ·
 *   未知 line.type 忽略(GWT-3 allowlist)· malformed 输入 typed-error fail-open 值语义。
 *
 * fixture 只内联合成 JSONL(Open-3: 不读真实 transcript、不做 transcript grep —— W3 只消费结构化源串)。
 */
import { describe, expect, test } from 'bun:test';
import { parseStopLedger } from '../../src/harness/session/stop-ledger';

type ParseResult = ReturnType<typeof parseStopLedger>;

// ─── 合成 fixture(只内联, 不读真实 transcript)─────────────────────────────────

function assistant(content: unknown, usage?: unknown): string {
  return JSON.stringify({ type: 'assistant', message: { role: 'assistant', content }, usage });
}

function userLine(text: string): string {
  return JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } });
}
function userRaw(text: string): string {
  return JSON.stringify({ type: 'user', message: { role: 'user', content: text } });
}

function userToolResult(): string {
  return JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_r1', content: 'ok' }] },
  });
}

function unknownType(type: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ type, ...extra });
}

// E-P1 冻结实测 usage 形状:四键齐全, ctxTokens = input + cache_read + cache_creation(不含 output)。
const USAGE_A = {
  input_tokens: 1,
  cache_creation_input_tokens: 4691,
  cache_read_input_tokens: 221759,
  output_tokens: 94,
}; // → 226451
const USAGE_B = {
  input_tokens: 2,
  cache_creation_input_tokens: 3757,
  cache_read_input_tokens: 186430,
  output_tokens: 87,
}; // → 190189
const USAGE_C = {
  input_tokens: 5,
  cache_creation_input_tokens: 5,
  cache_read_input_tokens: 1490,
  output_tokens: 20,
}; // → 1500

// ─── 增量 ledger 消费 ─────────────────────────────────────────────────────────

describe('parseStopLedger — 增量 ledger 消费', () => {
  test('entries 按源序、ordinal 从 1 连续、tokenBucket 可逐条累加消费', () => {
    const src = [
      assistant([{ type: 'text', text: '第一轮: 先看现状' }], USAGE_A),
      assistant([{ type: 'text', text: '第二轮' }], USAGE_B),
      assistant([{ type: 'text', text: '第三轮' }], USAGE_C),
    ].join('\n');
    const r = parseStopLedger(src);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.ledger.entries).toHaveLength(3);
    expect(r.ledger.entries.map((e) => e.ordinal)).toEqual([1, 2, 3]);
    // 消费方逐条累加 tokenBucket(token bucket 是唯一 commit-independent 主触发材料, Open-3)。
    const consumed = r.ledger.entries.reduce((acc, e) => acc + (e.tokenBucket ?? 0), 0);
    expect(consumed).toBe(226451 + 190189 + 1500);
    // 纯函数确定性:同源重解析逐字一致。
    expect(parseStopLedger(src)).toEqual(r);
  });

  test('增量追加(chunked):prefix 与整源解析一致, append 只增一条且 ordinal 续接', () => {
    const turn1 = assistant([{ type: 'text', text: '第一轮' }], USAGE_A);
    const turn2 = assistant([{ type: 'text', text: '第二轮' }], USAGE_B);
    const r1 = parseStopLedger(turn1);
    const r2 = parseStopLedger(`${turn1}\n${turn2}`);
    expect(r1.ok && r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) return;
    expect(r2.ledger.entries).toHaveLength(2);
    expect(r2.ledger.entries[0]).toEqual(r1.ledger.entries[0]);
    expect(r2.ledger.entries[1]!.ordinal).toBe(2);
    expect(r2.ledger.entries[1]!.tokenBucket).toBe(190189);
  });
});

// ─── usage / ctxTokens 记账 ───────────────────────────────────────────────────

describe('parseStopLedger — usage / ctxTokens 记账', () => {
  test('tokenBucket = input + cache_read + cache_creation(冻结公式, output 不计)', () => {
    const r = parseStopLedger(assistant([{ type: 'text', text: 'x' }], USAGE_A));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.ledger.entries[0]!.tokenBucket).toBe(226451);
    // output_tokens 不参与记账(冻结公式只含前三键)。
    expect(r.ledger.entries[0]!.tokenBucket).not.toBe(1 + 221759 + 4691 + 94);
  });

  test('usage 缺键/缺失/非对象 → tokenBucket null(best-effort, 不伪造数)', () => {
    const cases = [
      assistant([{ type: 'text', text: 'no usage' }]),
      assistant([{ type: 'text', text: 'partial' }], { input_tokens: 3, output_tokens: 4 }), // 缺 cache 两键
      assistant([{ type: 'text', text: 'bad usage' }], 'nope'),
    ];
    for (const src of cases) {
      const r = parseStopLedger(src);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.ledger.entries).toHaveLength(1);
      expect(r.ledger.entries[0]!.tokenBucket).toBeNull();
    }
  });
});

// ─── assistantText — touched-file / Bash 抽取材料 ─────────────────────────────

describe('parseStopLedger — assistantText(touched-file / Bash 抽取材料)', () => {
  test('text 块逐字按序保留;tool_use 的 Bash command / 文件路径随行保留(W2 抽取材料)', () => {
    const src = assistant(
      [
        { type: 'text', text: '先跑测试, 再改文件。' },
        { type: 'tool_use', id: 'toolu_01', name: 'Bash', input: { command: 'bun test tests/harness/session' } },
        {
          type: 'tool_use',
          id: 'toolu_02',
          name: 'Edit',
          input: { file_path: 'src/harness/session/stop-ledger.ts', old_string: 'a', new_string: 'b' },
        },
        { type: 'text', text: '改完了。' },
      ],
      USAGE_A,
    );
    const r = parseStopLedger(src);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const t = r.ledger.entries[0]!.assistantText;
    expect(t).not.toBeNull();
    expect(t).toContain('先跑测试, 再改文件。');
    expect(t).toContain('改完了。');
    // text 块顺序保持。
    expect(t!.indexOf('先跑测试')).toBeLessThan(t!.indexOf('改完了'));
    // 抽取材料:Bash command 与 touched-file 路径原样可达, W2 无需 transcript grep。
    expect(t).toContain('bun test tests/harness/session');
    expect(t).toContain('src/harness/session/stop-ledger.ts');
  });

  test('纯 tool_use 轮:assistantText 仍带工具材料;无内容 → null', () => {
    const r = parseStopLedger(
      [
        assistant([{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls -la' } }], USAGE_B),
        assistant([], USAGE_A), // 空 content → 无文本
        assistant(null, USAGE_A), // content null → 无文本
      ].join('\n'),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const [toolOnly, empty, nullContent] = r.ledger.entries;
    expect(toolOnly!.assistantText).not.toBeNull();
    expect(toolOnly!.assistantText).toContain('ls -la');
    expect(empty!.assistantText).toBeNull();
    expect(nullContent!.assistantText).toBeNull();
    // usage 记账与文本无关:无内容轮仍带 tokenBucket。
    expect(nullContent!.tokenBucket).toBe(226451);
  });
});

// ─── 未知 line.type 忽略(GWT-3 / D-3 结构 allowlist)──────────────────────────

describe('parseStopLedger — 未知 line.type 忽略', () => {
  test('已观察未知类型不产生 entry、不报错、后续合法行照常解析', () => {
    const unknowns = [
      unknownType('ai-title', { title: 't' }),
      unknownType('queue-operation', { op: 'q' }),
      unknownType('attachment', { files: [] }),
      unknownType('last-prompt', { prompt: 'p' }),
      unknownType('mode', { mode: 'plan' }),
      unknownType('permission-mode', { mode: 'default' }),
      unknownType('bridge-session', { id: 'b' }),
      unknownType('file-history-snapshot', { files: [] }),
      unknownType('custom-title', { title: 'c' }),
    ];
    const src = [
      unknowns[0]!,
      assistant([{ type: 'text', text: 'A' }], USAGE_A),
      ...unknowns.slice(1),
      assistant([{ type: 'text', text: 'B' }], USAGE_B),
      unknownType('queue-operation'),
    ].join('\n');
    const r = parseStopLedger(src);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.ledger.entries).toHaveLength(2);
    expect(r.ledger.entries.map((e) => e.ordinal)).toEqual([1, 2]);
    expect(r.ledger.entries[1]!.tokenBucket).toBe(190189);
  });

  test('合法 JSON 但非 record(裸值)忽略不报错', () => {
    const r = parseStopLedger(
      ['42', '"plain"', 'null', assistant([{ type: 'text', text: 'x' }], USAGE_A)].join('\n'),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.ledger.entries).toHaveLength(1);
    expect(r.ledger.entries[0]!.ordinal).toBe(1);
  });
});

// ─── user 基础设施前导容忍(GWT-4 / Open-2 窄前缀)────────────────────────────

describe('parseStopLedger — user 行与基础设施前导', () => {
  test('<system-reminder / <task-notification 精确前缀 user 行不产生 entry、不报错、不污染 assistantText', () => {
    const src = [
      userLine('<system-reminder>忽略我</system-reminder>'),
      userLine('<task-notification type="system">context 注入</task-notification>'),
      userToolResult(),
      assistant([{ type: 'text', text: '正常回复' }], USAGE_A),
      userLine('真正的用户提问'),
      assistant([{ type: 'text', text: '针对提问回复' }], USAGE_B),
    ].join('\n');
    const r = parseStopLedger(src);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // user 行(含前导)与 tool_result 均不产生 assistant entry;后续合法轮照常。
    expect(r.ledger.entries).toHaveLength(2);
    expect(r.ledger.entries.map((e) => e.ordinal)).toEqual([1, 2]);
    // 基础设施前导文本绝不漏进 assistantText。
    expect(r.ledger.entries[0]!.assistantText).toContain('正常回复');
    expect(r.ledger.entries[0]!.assistantText).not.toContain('task-notification');
    expect(r.ledger.entries[0]!.assistantText).not.toContain('system-reminder');
  });
});

// ─── lastUserAsk — 逆序选择最后真实 ask(D-1/D-2)────────────────────────────

describe('parseStopLedger — lastUserAsk(最后真实 ask)', () => {
  test('逆序选择:多条真实 user candidate 保留最后一条;tool_result 无 candidate 继续逆扫', () => {
    const src = [
      userRaw('第一问(原始字符串 content)'),
      assistant([{ type: 'text', text: '回复一' }], USAGE_A),
      userLine('第二问(text 数组 content)'),
      userToolResult(), // 无 candidate, 继续逆扫
      assistant([{ type: 'text', text: '回复二' }], USAGE_B),
    ].join('\n');
    const r = parseStopLedger(src);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.ledger.lastUserAsk).toEqual({ status: 'found', value: '第二问(text 数组 content)', sourceLine: 3 });
  });

  test('仅原始精确前缀 <task-notification 被跳过, 逆扫保留更早真实 ask;<task-notificationXYZ 同跳过', () => {
    const src = [
      userLine('真实提问'),
      assistant([{ type: 'text', text: '回复' }], USAGE_A),
      userLine('<task-notification type="task">注入</task-notification>'),
      assistant([{ type: 'text', text: '回复二' }], USAGE_B),
      userLine('<task-notificationXYZ>'),
    ].join('\n');
    const r = parseStopLedger(src);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.ledger.lastUserAsk).toEqual({ status: 'found', value: '真实提问', sourceLine: 1 });
  });

  test('宽泛过滤禁止:前导空白/大小写变化/中部命中/slash ask 均为普通 found 且 value 原样', () => {
    const cases = [
      ' <task-notification type="x">前导空格</task-notification>',
      '\t<task-notification type="x">tab 前导</task-notification>',
      '<Task-notification type="x">大小写变化</task-notification>',
      '前缀x<task-notification type="x">中部命中</task-notification>',
      '/help 需要更多上下文',
    ];
    for (const ask of cases) {
      const r = parseStopLedger(userLine(ask));
      expect(r.ok).toBe(true);
      if (!r.ok) continue;
      // value 逐字保留(不 trim、不折叠), 行号为该 user 行。
      expect(r.ledger.lastUserAsk).toEqual({ status: 'found', value: ask, sourceLine: 1 });
    }
  });

  test('既有行为不放松:user 行共存不改变 entries/tokenBucket(与纯 assistant 源逐字一致)', () => {
    const base = [
      assistant([{ type: 'text', text: '回复一' }], USAGE_A),
      assistant([{ type: 'text', text: '回复二' }], USAGE_B),
    ].join('\n');
    const withUsers = [
      userLine('提问'),
      assistant([{ type: 'text', text: '回复一' }], USAGE_A),
      userLine('<task-notification type="task">注入</task-notification>'),
      assistant([{ type: 'text', text: '回复二' }], USAGE_B),
    ].join('\n');
    const rBase = parseStopLedger(base);
    const rWith = parseStopLedger(withUsers);
    expect(rBase.ok && rWith.ok).toBe(true);
    if (!rBase.ok || !rWith.ok) return;
    expect(rWith.ledger.entries).toEqual(rBase.ledger.entries);
  });

  test('既有行为不放松:malformed 行仍 typed error, error 分支不暴露 partial ledger / lastUserAsk', () => {
    const src = [
      userLine('更早提问'),
      assistant([{ type: 'text', text: '回复' }], USAGE_A),
      '{"type":"assistant","message":{"content":[{"type":"text","text":"断行', // 故意截断的 JSON
      userLine('更晚提问'),
    ].join('\n');
    const r = parseStopLedger(src);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.line).toBe(3);
    // 错误原子性(GWT-8):error 分支只携带 error, 不暴露 partial ledger / lastUserAsk。
    expect('ledger' in r).toBe(false);
    expect('lastUserAsk' in r).toBe(false);
  });
});

// ─── malformed 输入 → typed error(fail-open 值语义)──────────────────────────

describe('parseStopLedger — malformed 输入', () => {
  test('非 JSON 非空行 → ok:false + 准确源行号(1-based)+ 非空 message, 不抛异常', () => {
    const src = [
      assistant([{ type: 'text', text: 'ok' }], USAGE_A),
      '{"type":"assistant","message":{"content":[{"type":"text","text":"断行', // 故意截断的 JSON
      assistant([{ type: 'text', text: 'after' }], USAGE_B),
    ].join('\n');
    const r = parseStopLedger(src); // 不抛异常本身就是 fail-open 值语义的一部分
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.line).toBe(2);
    expect(r.error.message.length).toBeGreaterThan(0);
  });

  test('空行/全空白跳过;首个 malformed 即 typed error, 行号按源行计', () => {
    const src = ['', '  ', assistant([{ type: 'text', text: 'x' }], USAGE_A), '', 'not json at all', ''].join('\n');
    const r = parseStopLedger(src);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.line).toBe(5);
  });

  test('空源/纯空白 → ok:true + 空 ledger(无记录, 非错误)', () => {
    for (const src of ['', '\n', '   \n\n  ']) {
      const r = parseStopLedger(src);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.ledger.entries).toEqual([]);
    }
  });
});
