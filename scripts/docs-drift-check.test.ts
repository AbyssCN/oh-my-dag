/**
 * docs-drift-check 的**反向自检** —— 本仓惯例: 每条闸都要当场证明它真的会红。
 *
 * 一条永远绿的闸不是闸。所以每条判据这里都成对断言:
 *   坏 fixture → 至少一条 finding, 且 finding 指到那一行
 *   好 fixture (同形状但正确) → 零 finding
 * 只证"会红"会养出一条**永远红**的闸, 同样没用; 只证"该绿时绿"就是零信息。两侧都要。
 *
 * 全部 fixture 都是本文件内的字面量字符串, `exists` 也是注入的纯函数 —— 零磁盘零网络,
 * 于是这些断言不会因为别人改了 docs/ 而随机变色 (那是 main 入口的活, 不是判据的活)。
 */
import { describe, expect, test } from 'bun:test';
import {
  checkAnchors,
  checkBilingualHeadings,
  checkMermaid,
  checkToolCount,
  countAnchors,
  countH2,
  countMermaidBlocks,
  countRegisteredTools,
  normalizeAnchor,
  type DocFile,
} from './docs-drift-check';

/** 盘上"存在"的东西 —— 注入版, 于是判据可测且与真实仓状态解耦。 */
const ON_DISK = new Set(['src/model/seats.ts', 'scripts/omd-doctor.ts', 'src/mcp']);
const exists = (p: string) => ON_DISK.has(p);

const doc = (path: string, text: string): DocFile => ({ path, text });

describe('① 锚点存在', () => {
  test('断锚点 → 报到具体行, 并说出是哪个路径', () => {
    const f = checkAnchors(
      [doc('docs/architecture.md', ['# 标题', '', '真源在 `src/model/seats.ts`。', '细节见 `src/nope/gone.ts`。'].join('\n'))],
      exists,
    );
    expect(f).toHaveLength(1);
    expect(f[0]!.line).toBe(4);
    expect(f[0]!.what).toContain('src/nope/gone.ts');
    expect(f[0]!.fix.length).toBeGreaterThan(0);
  });

  test('全部锚点都在盘上 → 零 finding (证明它不是永远红)', () => {
    expect(checkAnchors([doc('docs/a.md', '见 `src/model/seats.ts` 与 `scripts/omd-doctor.ts`。')], exists)).toEqual([]);
  });

  test('`路径:行号` 只验路径部分', () => {
    expect(checkAnchors([doc('docs/a.md', '见 `src/model/seats.ts:42`。')], exists)).toEqual([]);
    expect(checkAnchors([doc('docs/a.md', '见 `src/nope/gone.ts:42`。')], exists)).toHaveLength(1);
  });

  test('围栏内的路径不算锚点 —— 那是命令示例', () => {
    const text = ['```bash', 'bun run `scripts/nope.ts`', '```'].join('\n');
    expect(checkAnchors([doc('docs/a.md', text)], exists)).toEqual([]);
  });

  test('glob 与裸目录前缀跳过', () => {
    expect(normalizeAnchor('src/**/*.test.ts')).toBeNull();
    expect(normalizeAnchor('src/')).toBeNull();
    expect(normalizeAnchor('scripts')).toBeNull();
    expect(normalizeAnchor('src/model/seats.ts:42')).toBe('src/model/seats.ts');
    expect(checkAnchors([doc('docs/a.md', '测试在 `src/**/*.test.ts`, 源码树是 `src/`。')], exists)).toEqual([]);
  });

  test('台账文件按名豁免 —— 同内容换个名字就得红 (豁免不是漏检)', () => {
    const body = ['案例当时的现场:', '`src/nope/gone.ts` 已被删。'].join('\n');
    expect(checkAnchors([doc('docs/silent-failures.md', body)], exists)).toHaveLength(0);
    expect(checkAnchors([doc('docs/worktrees-archive.md', body)], exists)).toHaveLength(0);
    expect(checkAnchors([doc('docs/architecture.md', body)], exists)).toHaveLength(1);
  });

  test('countAnchors 数的是"扫到"不是"通过" —— 0 失败要能和 0 扫到分开', () => {
    expect(countAnchors([doc('docs/a.md', '`src/model/seats.ts` 与 `src/nope/gone.ts`')])).toBe(2);
    expect(countAnchors([doc('docs/a.md', '这里一个路径都没有')])).toBe(0);
  });
});

describe('② 工具数一致', () => {
  const badge = (n: number) =>
    `[![MCP server: ${n} tools](https://img.shields.io/badge/MCP%20server-${n}%20tools-c9a227)](docs/mcp-tools.md)`;

  test('数字不符 → alt 文字与 URL 各报一条 (只改一处会得到"文字对、图片错")', () => {
    const f = checkToolCount(doc('README.md', ['# t', badge(33)].join('\n')), 49);
    expect(f).toHaveLength(2);
    expect(f.map((x) => x.line)).toEqual([2, 2]);
    for (const x of f) expect(x.what).toContain('49');
  });

  test('数字相符 → 零 finding', () => {
    expect(checkToolCount(doc('README.md', badge(49)), 49)).toEqual([]);
  });

  test('只改了 alt 文字、URL 还是旧数 → 仍然红 (这才是这条闸的存在理由)', () => {
    const half = '[![MCP server: 49 tools](https://img.shields.io/badge/MCP%20server-33%20tools-c9a227)](docs/mcp-tools.md)';
    const f = checkToolCount(doc('README.md', half), 49);
    expect(f).toHaveLength(1);
    expect(f[0]!.what).toContain('徽章 URL');
  });

  test('徽章整个不见了 → 也红 (不然删掉徽章就能过闸)', () => {
    const f = checkToolCount(doc('README.md', '# 没有徽章'), 49);
    expect(f).toHaveLength(1);
    expect(f[0]!.what).toContain('找不到');
  });

  test('注册数从源码字面量数出, 旧名以 alias 计入注册面', () => {
    // dag_run 在 TOOL_RENAMES 里 → 注册面上有 run (新名) + dag_run (deprecated alias) = 2
    expect(countRegisteredTools([`{ name: 'dag_run' }`])).toBe(2);
    // dag_status 不在表里 → 1
    expect(countRegisteredTools([`{ name: 'dag_status' }`])).toBe(1);
    expect(countRegisteredTools([`{ name: 'dag_run' }`, `{ name: 'dag_status' }`])).toBe(3);
    expect(countRegisteredTools(['没有任何工具注册'])).toBe(0);
  });
});

describe('③ mermaid 健全 (轻量 lint)', () => {
  const wrap = (body: string[]) => ['# t', '', '```mermaid', ...body, '```'].join('\n');

  test('subgraph 少一个 end → 报在收尾围栏那一行, 并说少几个', () => {
    const f = checkMermaid(doc('docs/d.md', wrap(['flowchart TB', '  subgraph A', '    X --> Y'])));
    expect(f).toHaveLength(1);
    expect(f[0]!.what).toContain('多 1 个');
    expect(f[0]!.line).toBe(7);
  });

  test('配平的 subgraph → 零 finding', () => {
    expect(checkMermaid(doc('docs/d.md', wrap(['flowchart TB', '  subgraph A', '    X --> Y', '  end'])))).toEqual([]);
  });

  test('多出一个 end → 报在那个 end 上', () => {
    const f = checkMermaid(doc('docs/d.md', wrap(['flowchart TB', '  X --> Y', '  end'])));
    expect(f).toHaveLength(1);
    expect(f[0]!.what).toContain('多出一个 end');
    expect(f[0]!.line).toBe(6);
  });

  test('围栏没闭合 → 报在开栏那一行, 且不再派生块内噪声', () => {
    const f = checkMermaid(doc('docs/d.md', ['# t', '```mermaid', 'flowchart TB', '  subgraph A', '  X --> Y'].join('\n')));
    expect(f).toHaveLength(1);
    expect(f[0]!.what).toContain('没闭合');
    expect(f[0]!.line).toBe(2);
  });

  test('class 引用未定义的 classDef → 报出缺哪个, 并列出本块已有的', () => {
    const f = checkMermaid(doc('docs/d.md', wrap(['flowchart TB', '  classDef llm fill:#eee', '  class A,B ghost'])));
    expect(f).toHaveLength(1);
    expect(f[0]!.what).toContain('ghost');
    expect(f[0]!.fix).toContain('llm');
    expect(f[0]!.line).toBe(6);
  });

  test('class 引用已定义的 classDef → 零 finding', () => {
    expect(
      checkMermaid(doc('docs/d.md', wrap(['flowchart TB', '  classDef llm fill:#eee', '  class A,B llm']))),
    ).toEqual([]);
  });

  test('非 mermaid 围栏整块跳过 —— 里头的 end / subgraph 是别的语言的词', () => {
    const text = ['```ruby', 'def x', '  subgraph', 'end', '```'].join('\n');
    expect(checkMermaid(doc('docs/d.md', text))).toEqual([]);
    expect(countMermaidBlocks([doc('docs/d.md', text)])).toBe(0);
  });

  test('countMermaidBlocks 数得对 (0 失败 ≠ 0 扫到)', () => {
    expect(countMermaidBlocks([doc('docs/d.md', [wrap(['flowchart TB']), wrap(['flowchart LR'])].join('\n\n'))])).toBe(2);
  });
});

describe('④ 双语结构对照', () => {
  const en = doc('README.md', ['# t', '## One', 'a', '## Two', 'b'].join('\n'));

  test('节数不等 → 报在少的那一份上, 说清差几节', () => {
    const zh = doc('README.zh-CN.md', ['# t', '## 一', 'a'].join('\n'));
    const f = checkBilingualHeadings(en, zh);
    expect(f).toHaveLength(1);
    expect(f[0]!.file).toBe('README.zh-CN.md');
    expect(f[0]!.what).toContain('2');
    expect(f[0]!.fix).toContain('1 节');
  });

  test('节数相等 → 零 finding, 且不比标题文本 (中文版是翻译)', () => {
    const zh = doc('README.zh-CN.md', ['# t', '## 一', 'a', '## 二', 'b'].join('\n'));
    expect(checkBilingualHeadings(en, zh)).toEqual([]);
  });

  test('围栏内的 ## 不算标题', () => {
    expect(countH2(['## One', '```bash', '## 这是注释不是标题', '```'].join('\n'))).toBe(1);
    expect(countH2(['### 三级不算', '## 二级算', '##没空格不算'].join('\n'))).toBe(1);
  });
});
