/**
 * L1 判据:OSC-8 可点路径(2026-08-21)。
 *
 * ## 它要杀死的失效形态
 *
 * omd 满屏 `file:line` 全是死文本,要跳只能人手抄 —— 而 pi-tui 一直提供 `hyperlink()`,
 * omd 一次都没用过(131 个导出里没接上的那 90 个之一)。
 *
 * ## 三条前提各有一条闸,因为它们错了都是**静默**的
 *
 * ① 宽度:OSC-8 必须计 0 列,否则每个 `fitLine` 都会算错 —— 而算错不报错,只是画歪。
 * ② 默认关:开着的话一票按字节断言的测试会在**与它们无关的维度**上变红。
 * ③ 只包真路径:`command` / `pattern` 包成 `file://` 是画错,而屏上看不出来。
 *
 * 证伪方式:`enabled` 恒 true → 「默认恒等」那条红;`PATH_FIELDS` 换成整个 `FIELDS` →
 * 「只包真路径」那条红;`linkPath` 里去掉 `LINE_SUFFIX` 剥离 → 「行号不进 URL」那条红。
 */
import { visibleWidth } from '@earendil-works/pi-tui';
import { afterEach, describe, expect, test } from 'bun:test';
import { fileUrl, hyperlinksOn, initHyperlinks, linkPath, resetHyperlinks } from './link';
import { formatToolLine, summarizeToolArg } from './tool-arg';

afterEach(() => resetHyperlinks());

describe('开关', () => {
  test('★ 默认关 —— 渲染函数恒等, 不开这一行全仓行为逐字节照旧', () => {
    expect(hyperlinksOn()).toBe(false);
    expect(linkPath('src/a.ts', 'src/a.ts', '/repo')).toBe('src/a.ts');
  });

  test('★ OMD_NO_HYPERLINKS 一票否决 —— 存在即生效(哪怕空串), 同 NO_COLOR 的判据', () => {
    expect(initHyperlinks({ OMD_NO_HYPERLINKS: '' }, true)).toBe(false);
    expect(linkPath('src/a.ts', 'src/a.ts', '/repo')).toBe('src/a.ts');
  });

  test('force 覆盖能力探测(测试注入口)', () => {
    expect(initHyperlinks({}, true)).toBe(true);
    expect(linkPath('x', 'src/a.ts', '/repo')).not.toBe('x');
  });
});

describe('fileUrl —— 纯函数, 与开关无关', () => {
  test('相对路径按 cwd 解析 —— 终端拿相对路径无从跳转', () => {
    expect(fileUrl('src/a.ts', '/repo')).toBe('file:///repo/src/a.ts');
  });
  test('绝对路径原样', () => {
    expect(fileUrl('/x/y.ts', '/repo')).toBe('file:///x/y.ts');
  });
  test('空格与 # ? 编码, CJK 不编(编了终端 tooltip 读不出来)', () => {
    expect(fileUrl('/a b/c#d?e/中文.ts', '/r')).toBe('file:///a%20b/c%23d%3Fe/中文.ts');
  });
});

describe('linkPath', () => {
  test('★ 宽度不变 —— OSC-8 计 0 列, 否则每个 fitLine 都算错(而算错只画歪不报错)', () => {
    initHyperlinks({}, true);
    const plain = 'src/tui/render/line.ts';
    expect(visibleWidth(linkPath(plain, plain, '/repo'))).toBe(visibleWidth(plain));
  });

  test('★ 行号留在可见文本里, 不进 URL(file:// 不认 :34)', () => {
    initHyperlinks({}, true);
    const out = linkPath('line.ts:34', 'src/line.ts:34', '/repo');
    expect(out).toContain('file:///repo/src/line.ts');
    expect(out).not.toContain('line.ts:34\\'); // URL 段里没有行号
    expect(out).toContain('line.ts:34'); // 可见文本里有
  });

  test('空路径不包 —— 包出个 file:///repo 是画错', () => {
    initHyperlinks({}, true);
    expect(linkPath('x', '   ', '/repo')).toBe('x');
  });
});

describe('接进工具行', () => {
  test('★ 只包真路径:file_path 包, command / pattern 不包', () => {
    initHyperlinks({}, true);
    expect(summarizeToolArg({ file_path: 'src/a.ts' }, 56, 'Write', '/repo')).toContain('file:///repo/src/a.ts');
    // command 不是路径 —— 包成 file:// 是画错, 而屏上看不出来。
    expect(summarizeToolArg({ command: 'bun test' }, 56, 'Bash', '/repo')).toBe('bun test');
  });

  test('★ 先截再包 —— 反过来会把转义序列截成乱码', () => {
    initHyperlinks({}, true);
    const long = 'src/harness/goal/' + 'x'.repeat(80) + '.ts';
    const out = summarizeToolArg({ file_path: long }, 20, 'Write', '/repo')!;
    expect(visibleWidth(out)).toBeLessThanOrEqual(20); // 可见宽仍守着预算
    expect(out).toContain('…'); // 截了且说了
    expect(out).toContain(`file:///repo/${long}`); // URL 是**全**路径, 不是截断后的
  });

  test('关着时 formatToolLine 逐字节等于老行为', () => {
    expect(formatToolLine('read', { file_path: 'src/a.ts' }, 56, '/repo')).toBe('read src/a.ts');
  });
});
