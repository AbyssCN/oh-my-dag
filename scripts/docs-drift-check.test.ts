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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'bun:test';
import {
  checkAnchors,
  checkBilingualHeadings,
  checkPublicCoverage,
  coveredByWhitelist,
  parseWhitelist,
  checkMermaid,
  checkRefs,
  checkToolCount,
  countAnchors,
  countH2,
  countMermaidBlocks,
  countRefs,
  countRegisteredTools,
  extractRefs,
  normalizeAnchor,
  resolveRef,
  scanTargets,
  type DocFile,
} from './docs-drift-check';

/** 盘上"存在"的东西 —— 注入版, 于是判据可测且与真实仓状态解耦。 */
const ON_DISK = new Set([
  'src/model/seats.ts',
  'scripts/omd-doctor.ts',
  'src/mcp',
  'assets/diagrams/engine-flow.svg',
  'assets/diagrams/tui.gif',
  'README.md',
  'docs/README.md',
  'docs/guide/tui.md',
  'docs/architecture/overview.md',
]);
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

describe('⑤ 引用可达 —— 图片', () => {
  test('图片指向盘上没有的文件 → 报到具体行, 并同时给原样目标与解析结果', () => {
    const text = ['# t', '', '![流程图](../assets/diagrams/engine-flow.svg)', '![不存在](../assets/diagrams/nope.svg)'];
    const f = checkRefs([doc('docs/README.md', text.join('\n'))], exists);
    expect(f).toHaveLength(1);
    expect(f[0]!.line).toBe(4);
    expect(f[0]!.what).toContain('../assets/diagrams/nope.svg');
    expect(f[0]!.what).toContain('assets/diagrams/nope.svg'); // 解析后的仓根相对路径
    expect(f[0]!.fix.length).toBeGreaterThan(0);
  });

  test('图片都在盘上 → 零 finding (证明它不是永远红)', () => {
    const text = '![流程](assets/diagrams/engine-flow.svg) 与 ![TUI](assets/diagrams/tui.gif)';
    expect(checkRefs([doc('README.md', text)], exists)).toEqual([]);
  });

  test('<img src> 形式一样认 —— README 里 HTML 图片不比 markdown 图片少见', () => {
    const bad = checkRefs([doc('README.md', '<img src="assets/diagrams/nope.gif" width="600">')], exists);
    expect(bad).toHaveLength(1);
    expect(bad[0]!.what).toContain('assets/diagrams/nope.gif');
    expect(checkRefs([doc('README.md', "<img src='assets/diagrams/tui.gif'>")], exists)).toEqual([]);
  });

  test('http(s) 图片跳过 —— 徽章不归本闸管', () => {
    const badge = '[![MCP server: 49 tools](https://img.shields.io/badge/x-49-c9a227)](docs/README.md)';
    expect(checkRefs([doc('README.md', badge)], exists)).toEqual([]);
  });

  test('嵌套徽章里外层链接照样验 —— 不抹掉图片那层就会漏掉它', () => {
    const badge = '[![MCP server: 49 tools](https://img.shields.io/badge/x-49-c9a227)](docs/nope.md)';
    const f = checkRefs([doc('README.md', badge)], exists);
    expect(f).toHaveLength(1);
    expect(f[0]!.what).toContain('docs/nope.md');
  });

  test('图片在台账里也不豁免 —— 坏图对读者就是碎图标, 与"这是历史记录"无关', () => {
    const f = checkRefs([doc('docs/silent-failures.md', '![旧图](assets/diagrams/nope.svg)')], exists);
    expect(f).toHaveLength(1);
  });
});

describe('⑤ 引用可达 —— 仓内 md 链接', () => {
  test('死链 → 报到具体行', () => {
    const text = ['# t', '细节见 [架构](architecture/overview.md)。', '还有 [没了](guide/gone.md)。'];
    const f = checkRefs([doc('docs/README.md', text.join('\n'))], exists);
    expect(f).toHaveLength(1);
    expect(f[0]!.line).toBe(3);
    expect(f[0]!.what).toContain('guide/gone.md');
  });

  test('链接都在盘上 → 零 finding', () => {
    const text = '见 [架构](architecture/overview.md) 与 [TUI](guide/tui.md)。';
    expect(checkRefs([doc('docs/README.md', text)], exists)).toEqual([]);
  });

  test('跨目录相对链接按**本文档所在目录**解析, 不是按仓根', () => {
    // 仓根与 docs/ 下各有一份 README.md, 于是"按谁解析"这一跳只有 resolveRef 的
    // 逐字断言能钉死 —— checkRefs 那一层两种解析都会得到一个存在的文件, 分不出来。
    expect(resolveRef('docs/architecture/overview.md', '../README.md')).toBe('docs/README.md');
    expect(resolveRef('docs/architecture/overview.md', '../../README.md')).toBe('README.md');
    expect(resolveRef('docs/architecture/overview.md', '../guide/tui.md')).toBe('docs/guide/tui.md');
    expect(checkRefs([doc('docs/architecture/overview.md', '[上一层](../guide/tui.md)')], exists)).toEqual([]);
    const f = checkRefs([doc('docs/architecture/overview.md', '[上一层](../guide/nope.md)')], exists);
    expect(f).toHaveLength(1);
  });

  test('`#片段` 只验文件部分; 纯锚点跳过', () => {
    expect(resolveRef('docs/README.md', 'guide/tui.md#键位')).toBe('docs/guide/tui.md');
    expect(resolveRef('docs/README.md', '#中文速览')).toBeNull();
    expect(checkRefs([doc('docs/README.md', '见 [键位](guide/tui.md#键位) 与 [下面](#中文速览)')], exists)).toEqual([]);
    expect(checkRefs([doc('docs/README.md', '见 [键位](guide/nope.md#键位)')], exists)).toHaveLength(1);
  });

  test('仓外 / 站点绝对 / 带 scheme 的目标一概跳过 —— 本闸管不着', () => {
    expect(resolveRef('README.md', 'https://example.com/a.md')).toBeNull();
    expect(resolveRef('README.md', 'mailto:x@y.z')).toBeNull();
    expect(resolveRef('README.md', '//cdn.example.com/a.svg')).toBeNull();
    expect(resolveRef('README.md', '/docs/a.md')).toBeNull();
    expect(resolveRef('README.md', '../outside-the-repo.md')).toBeNull();
  });

  test('非 .md 链接不验 —— 目录链接 / LICENSE / .env.example 不在本闸口径内', () => {
    const text = '见 [图集](diagrams/) · [许可](../LICENSE) · [样例配置](../.env.example)';
    expect(checkRefs([doc('docs/README.md', text)], exists)).toEqual([]);
  });

  test('围栏内的链接与图片不算 —— 那是语法示例', () => {
    const text = ['```md', '[x](nope.md)', '![y](nope.svg)', '```'].join('\n');
    expect(checkRefs([doc('docs/README.md', text)], exists)).toEqual([]);
    expect(extractRefs(doc('docs/README.md', text))).toEqual([]);
  });

  test('台账文件的 md 链接豁免 —— 同内容换个名字就得红 (豁免不是漏检)', () => {
    const body = '当时那份 [笔记](guide/gone.md) 已经删了。';
    expect(checkRefs([doc('docs/silent-failures.md', body)], exists)).toEqual([]);
    expect(checkRefs([doc('docs/worktrees-archive.md', body)], exists)).toEqual([]);
    expect(checkRefs([doc('docs/README.md', body)], exists)).toHaveLength(1);
  });

  test('countRefs 数的是"验了几条"不是"过了几条" (0 失败 ≠ 0 扫到)', () => {
    const d = doc(
      'docs/README.md',
      ['![a](assets/diagrams/engine-flow.svg)', '[b](guide/tui.md) [c](diagrams/) [d](https://x.com/e.md)'].join('\n'),
    );
    expect(countRefs([d], 'image')).toBe(1); // 图片 1 张
    expect(countRefs([d], 'link')).toBe(1); // 仓内 md 链接只有 guide/tui.md
    expect(countRefs([doc('docs/README.md', '这里什么引用都没有')], 'link')).toBe(0);
  });
});

/**
 * scanTargets 是本文件里**唯一**碰磁盘的一块 —— 因为它守的就是"目录在不在盘上"。
 * 但它碰的是 mkdtemp 出来的**假仓**, 不是本仓的 docs/, 所以照样不会因为别人改文档而变色。
 *
 * 守的判据: docs 重组把顶层文件往 guide/ architecture/ 里搬, **搬之前和搬之后都得能跑**。
 * 证伪: 把 scanTargets 里的 `if (!existsSync(abs)) continue` 删掉, "重组前"那条会抛。
 */
describe('扫描面 (scanTargets)', () => {
  const roots: string[] = [];
  const fakeRepo = (files: string[]): string => {
    const root = mkdtempSync(join(tmpdir(), 'docs-drift-'));
    roots.push(root);
    for (const f of files) {
      const abs = join(root, f);
      mkdirSync(join(abs, '..'), { recursive: true });
      writeFileSync(abs, '# t\n');
    }
    return root;
  };
  afterAll(() => {
    for (const r of roots) rmSync(r, { recursive: true, force: true });
  });

  test('重组前 (guide/ architecture/ 都还不存在) → 不抛, 扫到顶层与 diagrams', () => {
    const root = fakeRepo([
      'README.md',
      'README.zh-CN.md',
      'docs/README.md',
      'docs/architecture.md',
      'docs/diagrams/01-engine-flow.md',
      'docs/plan/2026-08-10-x.md',
    ]);
    expect(scanTargets(root)).toEqual([
      'README.md',
      'README.zh-CN.md',
      'docs/README.md',
      'docs/architecture.md',
      'docs/diagrams/01-engine-flow.md',
    ]);
  });

  test('重组后 → guide/ 与 architecture/ 进扫描面, 台账子目录仍然一条都不进', () => {
    const root = fakeRepo([
      'README.md',
      'README.zh-CN.md',
      'docs/README.md',
      'docs/silent-failures.md',
      'docs/guide/tui.md',
      'docs/architecture/overview.md',
      'docs/diagrams/01-engine-flow.md',
      'docs/plan/2026-08-10-x.md',
      'docs/handoff/y.md',
      'docs/notes/z.md',
      'docs/adr/0001.md',
    ]);
    expect(scanTargets(root)).toEqual([
      'README.md',
      'README.zh-CN.md',
      'docs/README.md',
      'docs/silent-failures.md',
      'docs/guide/tui.md',
      'docs/architecture/overview.md',
      'docs/diagrams/01-engine-flow.md',
    ]);
  });

  test('非 .md 与子目录本身不进扫描面', () => {
    const root = fakeRepo(['README.md', 'docs/guide/tui.md', 'docs/guide/screenshot.png', 'docs/guide/deep/nested.md']);
    expect(scanTargets(root)).toEqual(['README.md', 'docs/guide/tui.md']);
  });
});

// ── ⑥ 公开面覆盖 ─────────────────────────────────────────────────────────
//
// 这条闸的存在理由是两次实账: 2026-08-11 docs 分层重组后名单还是旧路径, 整套
// guide/architecture 被滤出公开镜像; 2026-08-24 加 why-omd / driving-omd 时没动名单。
// 两次 ⑤ 都全绿 —— 因为 ⑤ 查本地盘, 而公开仓是按名单重写出来的另一棵树。
describe('⑥ 公开面覆盖', () => {
  const WL = ['README.md', 'docs/guide', 'docs/architecture', 'assets/diagrams'];

  test('名单命中: 逐字条目与目录前缀都算覆盖', () => {
    expect(coveredByWhitelist('README.md', WL)).toBe(true);
    expect(coveredByWhitelist('docs/guide/tui.md', WL)).toBe(true);
    expect(coveredByWhitelist('docs/why-omd.md', WL)).toBe(false);
    // 前缀不能只比字符串 —— docs/guides/ 不是 docs/guide/ 底下的
    expect(coveredByWhitelist('docs/guidebook.md', WL)).toBe(false);
  });

  test('解析名单: 跳过注释与空行', () => {
    expect(parseWhitelist('# c\n\nREADME.md\n  docs/guide  \n\n# tail\n')).toEqual(['README.md', 'docs/guide']);
  });

  test('会红: 文档自身不在名单 → 报它, 且指向它的链接也各报一条', () => {
    const docs = [
      { path: 'README.md', text: '看 [长文](docs/why-omd.md)。' },
      { path: 'docs/why-omd.md', text: '# 长文' },
    ];
    const f = checkPublicCoverage(docs, WL);
    // 一条 = README 那个链接指向名单外; 一条 = why-omd.md 自身不在名单
    expect(f).toHaveLength(2);
    expect(f.some((x) => x.file === 'README.md' && x.line === 1)).toBe(true);
    expect(f.some((x) => x.file === 'docs/why-omd.md' && x.line === 0)).toBe(true);
  });

  test('该绿时不红: 同形状但名单covered → 零 finding', () => {
    const docs = [
      { path: 'README.md', text: '看 [指南](docs/guide/tui.md) 与 ![图](assets/diagrams/x.svg)。' },
      { path: 'docs/guide/tui.md', text: '# 指南' },
    ];
    expect(checkPublicCoverage(docs, WL)).toEqual([]);
  });

  test('台账豁免只免"自身要不要公开", 不免指向它的链接', () => {
    const docs = [
      { path: 'docs/worktrees-archive.md', text: '# 台账' },
      { path: 'README.md', text: '见 [台账](docs/worktrees-archive.md)。' },
    ];
    const f = checkPublicCoverage(docs, WL);
    expect(f).toHaveLength(1);
    expect(f[0]!.file).toBe('README.md');
  });

  test('名单缺席 → 零 finding (跳过, 不是通过 —— 标签由调用方区分)', () => {
    expect(checkPublicCoverage([{ path: 'docs/nope.md', text: '' }], null)).toEqual([]);
  });
});
