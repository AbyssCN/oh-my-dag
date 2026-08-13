/**
 * 工具行参数摘要的判据(S-5)。
 *
 * 起因是实测截图:transcript 上三行 `✓ read` / `✓ edit` / `✓ bash` ——
 * 看得出动了手,看不出动了什么。**改对文件和改错文件在那张屏上长得一模一样。**
 */
import { visibleWidth } from '@earendil-works/pi-tui';
import { describe, expect, test } from 'bun:test';
import { ARG_BUDGET, formatToolLine, summarizeToolArg } from './tool-arg';

describe('挑那一格', () => {
  test('文件工具挑路径', () => {
    expect(summarizeToolArg({ path: 'src/tui/tui.ts', offset: 10 })).toBe('src/tui/tui.ts');
    expect(summarizeToolArg({ file_path: '/tmp/a.txt' })).toBe('/tmp/a.txt');
  });

  test('bash 挑命令, grep 挑模式', () => {
    expect(summarizeToolArg({ command: 'bun test' })).toBe('bun test');
    expect(summarizeToolArg({ pattern: 'TODO', glob: '*.ts' })).toBe('TODO');
  });

  // ★ 优先级不是随手排的:read 同时有 path 与 limit 时该画路径。
  test('★ 按优先级挑, 不按对象里的出现顺序', () => {
    expect(summarizeToolArg({ query: '后来的', path: '先要的' })).toBe('先要的');
  });

  // ★ 反向自检 (实跑): 给 FIELDS 加一条 `Object.values(rec)[0]` 兜底 → 这条当场红。
  test('★ 挑不出就画不出 —— 不猜第一个字段', () => {
    expect(summarizeToolArg({ verbose: true, depth: undefined })).toBeNull();
    expect(summarizeToolArg({ opts: { path: '藏在里层' } })).toBeNull();
    expect(summarizeToolArg(null)).toBeNull();
    expect(summarizeToolArg('裸串')).toBeNull();
    expect(summarizeToolArg([{ path: 'a' }])).toBeNull();
  });

  test('空白串当没有 —— 画一个空参数比不画更难读', () => {
    expect(summarizeToolArg({ path: '   ' })).toBeNull();
  });
});

describe('宽度', () => {
  // ★ 按**可见宽度**截, 不按字符数:中文一个字占两列, 按 length 截会照样把行撑爆。
  test('★ 超长参数按可见宽度截断', () => {
    const long = `${'目录'.repeat(60)}/x.ts`;
    const out = summarizeToolArg({ path: long }) as string;
    expect(visibleWidth(out)).toBeLessThanOrEqual(ARG_BUDGET);
  });

  test('短参数原样, 不补也不截', () => {
    expect(summarizeToolArg({ path: 'a.ts' })).toBe('a.ts');
  });
});

/**
 * ★ 搜索是两格(2026-08-13,owner 原话「搜了什么文件…能看到」)。
 *
 * 反向自检(实跑):把 `summarizeToolArg` 里 `SEARCH_TOOLS` 那一段删掉 → 第 1 条当场红,
 * 实得 `src/` —— 也就是修之前屏上的样子:**搜索词一个字都没有**。
 */
describe('搜索一族:词 in 范围', () => {
  test('★ pattern 压过 path —— 搜索词是信息主体, 范围是次要的', () => {
    expect(summarizeToolArg({ pattern: 'thinking_delta', path: 'src/' }, ARG_BUDGET, 'grep')).toBe('thinking_delta in src/');
  });

  test('没给范围就只画词(不编一个 in .)', () => {
    expect(summarizeToolArg({ pattern: 'foo' }, ARG_BUDGET, 'grep')).toBe('foo');
  });

  test('★ 不传工具名 = 老行为逐字不变(别的调用点不该被这条改掉读数)', () => {
    expect(summarizeToolArg({ pattern: 'foo', path: 'src/' })).toBe('src/');
  });

  test('非搜索工具不吃这条 —— read 的 path 仍是那一格', () => {
    expect(summarizeToolArg({ path: 'a.ts', pattern: 'x' }, ARG_BUDGET, 'read')).toBe('a.ts');
  });

  test('搜索工具没给 pattern → 退回通用挑格, 不是什么都不画', () => {
    expect(summarizeToolArg({ path: 'src/' }, ARG_BUDGET, 'grep')).toBe('src/');
  });

  test('两格合起来也要过宽度预算', () => {
    const out = summarizeToolArg({ pattern: 'p'.repeat(40), path: 'd'.repeat(40) }, ARG_BUDGET, 'grep') as string;
    expect(visibleWidth(out)).toBeLessThanOrEqual(ARG_BUDGET);
  });
});

describe('整行', () => {
  test('有参数画名字 + 参数', () => {
    expect(formatToolLine('read', { path: 'a.ts' })).toBe('read a.ts');
  });

  test('★ formatToolLine 自己就把工具名喂下去了(grep 不必调用方记得传)', () => {
    expect(formatToolLine('grep', { pattern: 'foo', path: 'src/' })).toBe('grep foo in src/');
  });

  test('没参数就只画名字, 不画空括号', () => {
    expect(formatToolLine('omd_status', {})).toBe('omd_status');
  });
});
