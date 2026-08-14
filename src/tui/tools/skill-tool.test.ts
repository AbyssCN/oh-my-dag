/**
 * ★ RED: /skill 参数只用 pi 原语解析和替换 (契约第 1 笔 · docs/plan/2026-08-13-...md)。
 *
 * 此刻 `src/tui/tools/skill-tool.ts` 只 re-export `createSkillTools` / `normalizeSkillName`
 * (无关的 AI 工具面), 不导出 `parseCommandArgs`/`substituteArgs` —— 本文件从同一路径导入
 * 这两个符号必然编译失败 (`bunx tsc --noEmit` 报 "has no exported member"), 是本笔的 RED 证据。
 * IMPL 阶段只许在 `skill-tool.ts` 追加 `export { parseCommandArgs, substituteArgs } from
 * '@earendil-works/pi-agent-core'`, 禁止在这里另写实现或深路径导入。
 *
 * 每条 test 头顶写"证伪方式": 临时改回旧行为(按空白拆分/不替换占位符)后, 本用例必须变红;
 * 改回后本仓验收命令 `bunx tsc --noEmit && bun test src/tui/tools/skill-tool.test.ts` 退出非 0。
 */
import { describe, expect, test } from 'bun:test';
import { parseCommandArgs, substituteArgs } from './skill-tool';

describe('parseCommandArgs', () => {
  test('引号成对切分: 引号内空白不拆分, 引号外正常按空白切', () => {
    // 证伪方式: 把实现换成 rest.split(/\s+/) (契约禁止的旧写法), 引号内的空格会被误切,
    // "src/foo bar.ts" 会拆成两个 arg, 断言 toEqual(['src/foo bar.ts', 'strict']) 变红。
    expect(parseCommandArgs('"src/foo bar.ts" strict')).toEqual(['src/foo bar.ts', 'strict']);
    expect(parseCommandArgs("'a b' 'c d' e")).toEqual(['a b', 'c d', 'e']);
  });

  test('连续空白不产空串', () => {
    // 证伪方式: 若实现用 split(/\s+/) 且首字符是空白, 或用 split(' ') 不去重连续分隔符,
    // 结果里会混入 '' 元素, 本断言 (数组不含空串 + 长度恰为 2) 变红。
    expect(parseCommandArgs('  a    b   ')).toEqual(['a', 'b']);
    expect(parseCommandArgs('a   b').includes('')).toBe(false);
  });

  test('未闭合引号把剩余内容(含空白)并入最后一个 arg', () => {
    // 证伪方式: 若实现在遇到未闭合引号时报错或截断剩余内容, 本断言 (最后一个 arg 逐字等于
    // 'bar baz', 且总长度为 2) 变红; pi 语义是缺失的收尾引号被静默吸收, 不产第三个 arg。
    expect(parseCommandArgs('foo "bar baz')).toEqual(['foo', 'bar baz']);
  });
});

describe('substituteArgs', () => {
  test('$1 越界替换为空串, 不保留占位符原文', () => {
    // 证伪方式: 若实现在越界时保留原文 `$1` (例如用 args[i] ?? match 而非 ?? '' 兜底),
    // 结果会仍含字面 '$1', 本断言 (逐字等于空串, 且不含 '$') 变红。
    expect(substituteArgs('$1', [])).toBe('');
    expect(substituteArgs('$2', ['only-one'])).toBe('');
  });

  test('${@:N} 与 ${@:N:L} 按 1-based 起点切片并以空格拼接', () => {
    // 证伪方式: 若实现把 N 当 0-based, 或 L 当"结束下标"而非"长度", 下列两条断言之一会变红
    // (['b','c'] 起点位移一位 / 长度语义反了)。
    const args = ['a', 'b', 'c'];
    expect(substituteArgs('${@:2}', args)).toBe('b c');
    expect(substituteArgs('${@:2:1}', args)).toBe('b');
  });

  test('$ARGUMENTS 替换为全部参数以空格拼接', () => {
    // 证伪方式: 若实现遗漏 $ARGUMENTS 分支 (只处理 $@), 结果仍含字面 '$ARGUMENTS', 变红。
    expect(substituteArgs('$ARGUMENTS', ['x', 'y'])).toBe('x y');
  });

  test('$@ 在 args=[] 时替换为空串(不保留占位符原文)', () => {
    // 证伪方式: 若实现对空数组走 args.join(' ') 之外的分支(例如判空后不替换直接跳过),
    // 结果仍含字面 '$@', 本断言 (逐字等于空串) 变红。
    expect(substituteArgs('$@', [])).toBe('');
    expect(substituteArgs('前缀$@后缀', [])).toBe('前缀后缀');
  });
});

describe('★ skill 正文占位符经 parseCommandArgs → substituteArgs 被真实参数替换', () => {
  test('契约示例正文: $1/$2/${@:2}/${@:2:1}/$ARGUMENTS/$@ 全部替换, 不残留占位符原文', () => {
    // 证伪方式: 把处理顺序改回"先 split(/\s+/) 再拼回原文"(契约禁止的旧路径, 即
    // src/tui/skills.ts:53-60 现状), 引号会被拆散、占位符不替换, 下列每条断言都会变红。
    const body = ['目标文件: $1', '第二参数: $2', '尾部切片: ${@:2}', '定长切片: ${@:2:1}', '全部参数: $ARGUMENTS', '同义: $@'].join('\n');
    const rest = '"src/foo bar.ts" strict';
    const args = parseCommandArgs(rest);
    expect(args).toEqual(['src/foo bar.ts', 'strict']);

    const injected = substituteArgs(body, args);
    expect(injected).toContain('目标文件: src/foo bar.ts');
    expect(injected).toContain('第二参数: strict');
    expect(injected).toContain('尾部切片: strict');
    expect(injected).toContain('定长切片: strict');
    expect(injected).toContain('全部参数: src/foo bar.ts strict');
    expect(injected).toContain('同义: src/foo bar.ts strict');
    expect(injected).not.toMatch(/\$1|\$2|\$\{@:2\}|\$\{@:2:1\}|\$ARGUMENTS|\$@/);
  });

  test('空 rest 时所有占位符替换为空串, 定界符所在行仍存在', () => {
    // 证伪方式: 若空参数走了不同代码路径(例如 rest='' 时跳过 substituteArgs 直接返回原文),
    // 占位符原文会残留, 本断言 (不含任一占位符原文 + 行数不变) 变红。
    const body = ['前置行', '正文: $1 $ARGUMENTS $@', '后置行'].join('\n');
    const args = parseCommandArgs('');
    expect(args).toEqual([]);

    const injected = substituteArgs(body, args);
    const lines = injected.split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe('前置行');
    expect(lines[2]).toBe('后置行');
    expect(injected).not.toMatch(/\$1|\$ARGUMENTS|\$@/);
  });
});
