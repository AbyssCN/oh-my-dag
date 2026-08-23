/**
 * `ShellRun.outputTail` + `engineFacts` 输出尾行 的闸 (片 3m, 2026-08-23)。
 *
 * ## 它守的是什么
 *
 * verifier 反复要的是「这条命令打印了什么」(判词常驻尾部:`6694 pass / 0 fail`、
 * 编译错误汇总、栈尾),而引擎此前只记了命令与退出码。修法: 采集器多记一位 `outputTail`,
 * `engineFacts` 把它**另起一行**摆进卷面(`执行命令: …` 那行字节不动,D-1)。
 *
 * 这条闸的 oracle 是契约的 9 条 GWT —— 拆两段:
 *   · C-1 (采集)  INV-1/2/3/4/5 — 喂合成事件给 `createShellRunCollector`,断言 `runs()`;
 *   · C-2 (渲染)  INV-6/7/8/9 — 喂 `engineFacts`,断言返回数组 + 源码面(`ugrep -c`)。
 *
 * ## 反向自检 (切片 1 表)
 *
 * | # | 文件 | oldText | newText |
 * |---|---|---|---|
 * | 1 | agent-leaf.ts | `const text = (first as { text?: unknown }).text;` 之后取原文 | 取 `undefined` |
 * | 2 | agent-leaf.ts | `flat.slice(-SHELL_OUTPUT_TAIL_CAP)` | `flat.slice(0, SHELL_OUTPUT_TAIL_CAP)` |
 *
 * #1 ⇒ GWT-1 红; #2 ⇒ GWT-4 红。两刀都实测过。
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createShellRunCollector, extractShellOutputTail } from '../agent-leaf';
import { engineFacts, parseShellRunFact, renderShellRunFact } from './claimed-actions';
import { SHELL_OUTPUT_TAIL_CAP, type ShellRun } from '../leaf-runners';

const RUN_COLLECTOR = join(import.meta.dir, '..', 'agent-leaf.ts');
const RENDER = join(import.meta.dir, 'claimed-actions.ts');

// ── C-1 采集 ────────────────────────────────────────────────────────
describe('C-1 采集面多记一位', () => {
  test('★ GWT-1 (INV-1): tool_execution_end 带 content 文本 → outputTail 包含那段', () => {
    const c = createShellRunCollector();
    c.note({
      type: 'tool_execution_start',
      toolName: 'bash',
      toolCallId: 'c1',
      args: { command: 'echo hi' },
    });
    c.note({
      type: 'tool_execution_end',
      toolName: 'bash',
      toolCallId: 'c1',
      result: {
        content: [{ type: 'text', text: '...\n6694 pass / 0 fail' }],
        details: { exitCode: 0 },
      },
    });
    const runs = c.runs();
    expect(runs.length).toBe(1);
    expect(runs[0]!.outputTail).toBeDefined();
    expect(runs[0]!.outputTail!).toContain('6694 pass / 0 fail');
  });

  test('★ GWT-2 (INV-2): content 缺席 → outputTail 字段缺席 (不是 "")', () => {
    const c = createShellRunCollector();
    c.note({
      type: 'tool_execution_start',
      toolName: 'bash',
      toolCallId: 'c2',
      args: { command: 'true' },
    });
    c.note({
      type: 'tool_execution_end',
      toolName: 'bash',
      toolCallId: 'c2',
      result: { details: { exitCode: 0 } }, // no content at all
    });
    const runs = c.runs();
    expect(runs.length).toBe(1);
    expect('outputTail' in runs[0]!).toBe(false);
  });

  test('★ GWT-2b (INV-2): content 是空串 / 压平后为空 → 字段同样缺席', () => {
    const c = createShellRunCollector();
    c.note({
      type: 'tool_execution_start',
      toolName: 'bash',
      toolCallId: 'c2b',
      args: { command: 'true' },
    });
    c.note({
      type: 'tool_execution_end',
      toolName: 'bash',
      toolCallId: 'c2b',
      result: {
        content: [{ type: 'text', text: '   \n  \t  ' }], // 只有空白
        details: { exitCode: 0 },
      },
    });
    const runs = c.runs();
    expect('outputTail' in runs[0]!).toBe(false);
  });

  test('★ GWT-3 (INV-3): outputTail 不含换行, 长度 ≤ SHELL_OUTPUT_TAIL_CAP', () => {
    const c = createShellRunCollector();
    c.note({
      type: 'tool_execution_start',
      toolName: 'bash',
      toolCallId: 'c3',
      args: { command: 'big' },
    });
    c.note({
      type: 'tool_execution_end',
      toolName: 'bash',
      toolCallId: 'c3',
      result: {
        content: [{ type: 'text', text: 'y'.repeat(5000) + '\nwith newlines\n\nmore lines' }],
        details: { exitCode: 0 },
      },
    });
    const tail = c.runs()[0]!.outputTail!;
    expect(tail.includes('\n')).toBe(false);
    expect(tail.length).toBeLessThanOrEqual(SHELL_OUTPUT_TAIL_CAP);
  });

  test('★ GWT-4 (INV-4): 取的是**末尾**(D-3), 不是开头', () => {
    const c = createShellRunCollector();
    c.note({
      type: 'tool_execution_start',
      toolName: 'bash',
      toolCallId: 'c4',
      args: { command: 'big' },
    });
    c.note({
      type: 'tool_execution_end',
      toolName: 'bash',
      toolCallId: 'c4',
      result: {
        content: [{ type: 'text', text: 'HEAD_X' + 'y'.repeat(5000) + 'TAIL_Z' }],
        details: { exitCode: 0 },
      },
    });
    const tail = c.runs()[0]!.outputTail!;
    expect(tail).toContain('TAIL_Z');
  });

  test('★ GWT-5 (INV-5): 老三位不变 — isError 时 exitCode 仍缺席 (不编 0), ok=false', () => {
    const c = createShellRunCollector();
    c.note({
      type: 'tool_execution_start',
      toolName: 'bash',
      toolCallId: 'c5',
      args: { command: 'whatever' },
    });
    c.note({
      type: 'tool_execution_end',
      toolName: 'bash',
      toolCallId: 'c5',
      isError: true,
      result: undefined,
    });
    const run = c.runs()[0]!;
    expect('exitCode' in run).toBe(false);
    expect(run.ok).toBe(false);
  });
});

// ── C-2 渲染 ────────────────────────────────────────────────────────
describe('C-2 渲染面另起一行', () => {
  test('★ GWT-6 (INV-6): engineFacts 对带 outputTail 的 run 在「执行命令: …」**之后**多推一行', () => {
    const facts = engineFacts(
      { shellRuns: [{ command: 'bun test', exitCode: 0, ok: true, outputTail: '6694 pass 0 fail' }] },
      { shellCap: 6 },
    );
    expect(facts.some((f) => f.includes('6694 pass 0 fail'))).toBe(true);
    expect(facts).toContain('执行命令: bun test (exit 0)');
    // 顺序: tail 行紧跟在其命令行的下一行 (D-1 「另起一行」)。
    const cmdIdx = facts.indexOf('执行命令: bun test (exit 0)');
    const tailIdx = facts.findIndex((f) => f.includes('6694 pass 0 fail'));
    expect(tailIdx).toBe(cmdIdx + 1);
  });

  test('★ GWT-6b (INV-6): outputTail 缺席 → 不推那一行', () => {
    const facts = engineFacts(
      { shellRuns: [{ command: 'true', exitCode: 0, ok: true }] },
      { shellCap: 6 },
    );
    expect(facts).toEqual(['执行命令: true (exit 0)']);
  });

  test('★ GWT-7 (INV-7): 「执行命令: …」行逐字节不变 + parseShellRunFact 仍解得出原对', () => {
    const run: Pick<ShellRun, 'command' | 'exitCode'> = { command: 'bun test', exitCode: 0 };
    const fact = renderShellRunFact(run);
    expect(fact).toBe('执行命令: bun test (exit 0)');
    const parsed = parseShellRunFact(fact);
    expect(parsed).toEqual({ command: 'bun test', exitCode: 0 });
  });

  test('★ GWT-7b (INV-7): 输出尾那行的行首是固定前缀, 不污染 parseShellRunFact 的正则', () => {
    // 关键: parseShellRunFact 用 `^执行命令: ...$` 锁行首尾, 若新行也以「执行命令」开头会被它误吞。
    const facts = engineFacts(
      { shellRuns: [{ command: 'bun test', exitCode: 0, ok: true, outputTail: 'some output here' }] },
      { shellCap: 6 },
    );
    const tailLine = facts.find((f) => f.includes('some output here'))!;
    expect(tailLine.startsWith('执行命令')).toBe(false); // 不是「执行命令:」开头
    // parseShellRunFact 解不出 → 守卫成立 (防止判据面被破坏)。
    expect(parseShellRunFact(tailLine)).toBeNull();
  });

  test('★ GWT-8 (INV-8): shellCap 仍按命令条数计, 多出的尾行不挤掉别的命令', () => {
    const shellRuns = Array.from({ length: 7 }, (_, i) => ({
      command: `cmd${i}`,
      exitCode: 0,
      ok: true,
      outputTail: `out${i}`,
    }));
    const facts = engineFacts({ shellRuns }, { shellCap: 6 });
    // 6 条命令 × 2 行 (命令行 + tail 行) = 12 行 + 1 行「另有 1 条命令未展示」= 13。
    const cmdLines = facts.filter((f) => f.startsWith('执行命令:'));
    expect(cmdLines.length).toBe(6);
    const tailLines = facts.filter((f) => f.startsWith('命令输出尾:'));
    expect(tailLines.length).toBe(6);
    expect(facts.some((f) => f.includes('另有 1 条命令未展示'))).toBe(true);
  });

  test('★ GWT-9 (INV-9): 判据函数 (isVerificationRun / recordSupportsVerification 等) 源码未动', () => {
    // 切片 1 的护栏: D-5 不动判据。直接钉源码面 ——
    //   · 这些函数体没出现在本次 diff 里 (git diff 的语义, 用 ugrep-count 的占位替);
    //   · 出现位置与改前相同 (这条由 git diff 自己证, 这里只钉**仍存在**)。
    const src = readFileSync(RENDER, 'utf8');
    expect(src).toMatch(/export function isVerificationRun\b/);
    expect(src).toMatch(/export function isFailedVerificationRun\b/);
    expect(src).toMatch(/export function recordSupportsVerification\b/);
    expect(src).toContain('EXIT_CODE_NOT_ATTRIBUTABLE');
    expect(src).toContain('VERIFICATION_COMMAND');
  });

  test('★ GWT-9b (INV-9): EXIT_CODE_NOT_ATTRIBUTABLE 出现次数仍是 5 (契约验收第 5 条)', () => {
    const src = readFileSync(RENDER, 'utf8');
    // 数**字面**出现次数 — 不依赖 regex 边界, 直接 split-and-count, 与 `ugrep -c` 同口径。
    const n = src.split('EXIT_CODE_NOT_ATTRIBUTABLE').length - 1;
    expect(n).toBe(5);
  });
});

// ── 纯函数单元 (sanity) ─────────────────────────────────────────────
describe('extractShellOutputTail 单元行为', () => {
  test('正常 text → 压平末尾', () => {
    expect(extractShellOutputTail({ content: [{ type: 'text', text: '  hello\n  world  ' }] })).toBe('hello world');
  });
  test('content 缺席 → undefined', () => {
    expect(extractShellOutputTail(undefined)).toBeUndefined();
    expect(extractShellOutputTail({})).toBeUndefined();
  });
  test('首项非 text → undefined', () => {
    expect(extractShellOutputTail({ content: [{ type: 'image', data: 'x' }] })).toBeUndefined();
  });
  test('text 非 string → undefined', () => {
    expect(extractShellOutputTail({ content: [{ type: 'text', text: 123 }] })).toBeUndefined();
  });
  test('空数组 → undefined', () => {
    expect(extractShellOutputTail({ content: [] })).toBeUndefined();
  });
  test('超长 → 切末尾', () => {
    const text = 'HEAD' + 'x'.repeat(5000) + 'TAIL';
    const out = extractShellOutputTail({ content: [{ type: 'text', text }] })!;
    expect(out.endsWith('TAIL')).toBe(true);
    expect(out.length).toBe(SHELL_OUTPUT_TAIL_CAP);
  });
  test('单换行压平 — D-2 单行', () => {
    const out = extractShellOutputTail({ content: [{ type: 'text', text: 'a\nb\nc' }] })!;
    expect(out.includes('\n')).toBe(false);
    expect(out).toBe('a b c');
  });
});