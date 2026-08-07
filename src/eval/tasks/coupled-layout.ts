/**
 * coupled-layout fixture —— 测**并行 fan-out vs 顺序单 owner**,耦合由**构造**保证。
 *
 * ## 为什么要构造耦合,而不是去检测耦合
 *
 * 外部发现(`mshumer/Claude-of-Duty` README,2026-08):六个 agent 各管一个目录跑三轮,
 * 分数 +0.46 而毁帧缺陷 60 → 66(**涨了**);换成一个 owner 顺着做一遍,+1.00,缺陷 66 → 26。
 * 作者给的机制解释是「色调映射、天空、间接光本来是一个耦合系统,隔离的 agent 一直在破坏
 * 彼此的前提」。
 *
 * 想在本仓复现这个对比,第一反应是拿 `detectRuntimeWriteRace` 去历史 run 里找耦合的节点对。
 * **实测否掉了这条路**(2026-08-07,`scripts/probes/retro-write-race.ts`):
 *   1106 个节点 checkpoint 里只有 **266 份报了 `outputPaths`**;
 *   于是 1661 对真重叠的执行窗口里,判据够得着的只有 **24 对(1.4%)**,撞车 0。
 * 那个 `0` 不是「omd 没有写竞争」,是「76% 的节点没交作业」——
 * `OverlapPair.aPaths` 的注释早就写了:**空集 = 这一侧没报过写,不是没写**。
 *
 * ⇒ 所以这里**不依赖任何检测器**:三条需求在**物理上必须落在同一个函数**里,
 *   耦合由构造保证,可见性问题绕开。
 *
 * ## 三条需求为什么真的耦合
 *
 * 目标是一个终端行渲染器 `renderRow(cells, totalWidth)`:
 *   R1 列宽分配 · R2 超长截断 · R3 ANSI 序列不计入宽度
 *
 * 任意两条单独做对、第三条没做,**交叉用例必红**:
 *   - 截断时不认 ANSI → 截出来的可见宽度是错的(R2 对、R3 错);
 *   - 认 ANSI 但不补 reset → 颜色漏进填充空格(R3 一半);
 *   - 列宽分配不给截断留省略号的位 → 列宽 1 时越界(R1 与 R2 的接缝)。
 * 这正是「三个 agent 各修一条、互相破坏前提」能被观测到的形状。
 *
 * ## 读数怎么分(这条比 fixture 本身重要)
 *
 * 缺陷**分两格记**:`singleFail`(R1/R2/R3 各自的用例)与 `crossFail`(X/ 交叉用例)。
 * 假说的预测是**具体的**:并行臂若真的输,应该**主要输在 `crossFail` 上** ——
 * 各人把自己那条做对了,合起来对不上。
 * 若两格一起输,那机制就不是「耦合」而是别的(例如某臂拿到的上下文更全),
 * **假说没被证实,别硬往耦合上解释**。
 *
 * ## 判据自己先过一遍
 *
 * `scripts/probes/coupled-layout-selfcheck.ts` —— 参考实现必须 11/11 全绿(正向),
 * ANSI 盲的实现必须红在 R3 与 X 格上(反向)。**改本文件的需求原文或契约测试之后必须重跑。**
 * 首跑就靠反向那一半抓到两条永远绿的假用例(细节在那个脚本的头里)。
 *
 * ## 它不证明什么
 *
 * 一个函数级的耦合,不等于跨子系统的耦合。这里量到的是**干预方向**,不是可外推的效应量。
 * 而且顺序臂天然比并行臂**多看见**别人的产出 —— 那是第二个变量,靠 `scripts/eval-coupling-ab.ts`
 * 的三臂拆(P/C/S),不靠这份 fixture。
 */
import { $ } from 'bun';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createWorktreeFixture } from './worktree';

/** 被测模块在 worktree 里的位置(新增文件,不动仓里任何既有模块)。 */
const IMPL_REL = 'src/eval/fixture-layout/layout.ts';
const TEST_REL = 'src/eval/fixture-layout/layout.test.ts';

/** 未实现的桩:tsc 干净、测试全红 —— 起点缺陷 = 全部用例,是想要的。 */
const IMPL_STUB = `// EVAL FIXTURE —— 照 EVAL_SPEC.md 实现本模块, 使 layout.test.ts 转绿。
export function renderRow(_cells: string[], _totalWidth: number): string {
  throw new Error('未实现: 见 EVAL_SPEC.md');
}
`;

/**
 * oracle 测试。**故意不 import 实现里的宽度函数** —— 拿被测者自己的尺子去量它,
 * 等于让它自证(本仓 S-6 那一族)。这里的 `vis`/`width` 是测试自带的第二把尺子。
 */
const TEST_SRC = `import { expect, test } from 'bun:test';
import { renderRow } from './layout';

const SGR = /\\x1b\\[[0-9;]*m/g;
const vis = (s: string): string => s.replace(SGR, '');
const width = (s: string): number => vis(s).length;

test('R1/ 三列均分 + 单空格分隔', () => {
  expect(renderRow(['a', 'b', 'c'], 11)).toBe('a   b   c  ');
});

test('R1/ 余数从左往右各加一列宽', () => {
  expect(renderRow(['a', 'b', 'c'], 12)).toBe('a    b   c  ');
});

test('R2/ 超长截断成 列宽-1 个可见字符 + 省略号', () => {
  expect(renderRow(['abcdef'], 3)).toBe('ab\\u2026');
});

test('R2/ 列宽 1 时只剩省略号', () => {
  expect(renderRow(['abc', 'x'], 3)).toBe('\\u2026 x');
});

test('R2/ 可见宽度恰好等于列宽时不截断', () => {
  expect(renderRow(['abc'], 3)).toBe('abc');
});

test('R3/ ANSI 序列不计入宽度', () => {
  expect(renderRow(['\\x1b[31mab\\x1b[0m'], 4)).toBe('\\x1b[31mab\\x1b[0m  ');
});

test('R3/ 只有颜色码的单元格视作空', () => {
  expect(renderRow(['\\x1b[31m\\x1b[0m', 'xy'], 5)).toBe('\\x1b[31m\\x1b[0m   xy');
});

test('X/ 带色 + 超长 + 窄列: 截断保留起始样式并补 reset', () => {
  expect(renderRow(['\\x1b[31mabcdef\\x1b[0m', 'x'], 5)).toBe('\\x1b[31ma\\u2026\\x1b[0m x ');
});

test('X/ 填充空格不许被上一段颜色染上 (reset 在填充之前)', () => {
  expect(renderRow(['\\x1b[31mab', 'cd'], 7)).toBe('\\x1b[31mab\\x1b[0m  cd ');
});

test('X/ 整行结束时没有悬空的样式', () => {
  const out = renderRow(['\\x1b[31mabcdef\\x1b[0m', '\\x1b[32mg', 'h'], 11);
  const last = out.lastIndexOf('\\x1b[');
  expect(out.slice(last)).toMatch(/^\\x1b\\[0m/);
});

test('X/ 不变量: 可见宽度 = totalWidth, 且不许留下截了一半的转义序列', () => {
  const cases: Array<[string[], number]> = [
    [['a', 'b', 'c'], 11],
    [['abcdef'], 3],
    [['abc', 'x'], 3],
    [['\\x1b[31mabcdef\\x1b[0m', 'x'], 5],
    [['\\x1b[31mab', 'cd'], 7],
    [['\\x1b[32mlong-green-cell\\x1b[0m', '\\x1b[31mred\\x1b[0m', 'z'], 14],
  ];
  for (const [cells, w] of cases) {
    const out = renderRow(cells, w);
    // 只查宽度是**不够**的: 按字节截断会切出半截转义 (ESC 后面不是完整的 [..m),
    // 而那个半截同样占 1 个字符位, 于是宽度照样对得上 —— 反向自检当场抓到过。
    expect(out).not.toMatch(/\\x1b(?!\\[[0-9;]*m)/);
    expect(width(out)).toBe(w);
  }
});
`;

/** 一条需求 —— 并行臂里它是一个节点的全部 goal。 */
export interface Requirement {
  id: 'R1' | 'R2' | 'R3';
  title: string;
  body: string;
}

export const REQUIREMENTS: readonly Requirement[] = [
  {
    id: 'R1',
    title: '列宽分配',
    body: [
      '把 totalWidth 分给 N 个单元格, 单元格之间用**一个空格**分隔 (共 N-1 个分隔符)。',
      '可用宽度 avail = totalWidth - (N-1); 基础列宽 = floor(avail / N);',
      '余数 r = avail % N **从左往右**分给前 r 列, 每列 +1。',
      '每个单元格渲染出来的**可见宽度必须恰好等于它的列宽** —— 不足右侧补空格。',
    ].join('\n'),
  },
  {
    id: 'R2',
    title: '超长截断',
    body: [
      '单元格可见宽度超过它的列宽时必须截断, 并以 U+2026 (…) 结尾。',
      '列宽 >= 2: 保留前 (列宽-1) 个**可见字符**, 再接一个 …;',
      '列宽 == 1: 只输出一个 …;',
      '可见宽度恰好等于列宽时**不截断**。',
      '截断之后该单元格的可见宽度仍必须恰好等于列宽。',
    ].join('\n'),
  },
  {
    id: 'R3',
    title: 'ANSI 透明',
    body: [
      'ANSI SGR 序列 (/\\x1b\\[[0-9;]*m/) **不计入**任何宽度计算。',
      '截断时必须保留被保留字符前面已经出现过的 SGR 序列。',
      '若一个单元格里出现过 SGR 且它的内容不以 \\x1b[0m 结尾,',
      '则在**该单元格的内容之后、右侧填充空格之前**补一个 \\x1b[0m ——',
      '目的是颜色不许漏进填充空格, 也不许漏到下一个单元格。',
    ].join('\n'),
  },
];

/** 每个节点都拿到的共同背景。**刻意只描述接口与跑法,不描述别人在做什么。** */
export const BRIEF = [
  '# 终端行渲染器',
  '',
  `实现 \`${IMPL_REL}\` 里的:`,
  '',
  '```ts',
  'export function renderRow(cells: string[], totalWidth: number): string',
  '```',
  '',
  `它的契约测试是 \`${TEST_REL}\`(**只读**)。跑法:`,
  '',
  '```',
  `bun test ${TEST_REL}`,
  '```',
  '',
  '当前实现是一个抛异常的桩, 所以测试现在全红。',
].join('\n');

export interface CoupledFixture {
  root: string;
  implPath: string;
  testPath: string;
  cleanup(): Promise<void>;
}

/** 建一个隔离 worktree, 写进桩 + 契约测试 + SPEC。 */
export async function createCoupledFixture(): Promise<CoupledFixture> {
  const spec = [
    BRIEF,
    '',
    '## 需求全集',
    '',
    ...REQUIREMENTS.map((r) => `### ${r.id} ${r.title}\n\n${r.body}`),
  ].join('\n');

  // targetPaths 传空: 这份 fixture 不清空仓里既有模块, 它**新增**两个文件 ——
  // 于是"起点"完全由本文件决定, 不随 HEAD 上那个模块的实现漂移。
  const fx = await createWorktreeFixture({
    id: 'coupled-layout',
    targetPaths: [],
    testPaths: [TEST_REL],
    spec,
  });
  await mkdir(join(fx.root, 'src/eval/fixture-layout'), { recursive: true });
  await writeFile(join(fx.root, IMPL_REL), IMPL_STUB, 'utf8');
  await writeFile(join(fx.root, TEST_REL), TEST_SRC, 'utf8');
  // 让新增的两个文件进 git 索引 —— 否则 `git diff` 看不见它们, 改动行数与
  // no-test-edit 约束(判据走 `git diff --name-only`)会**双双静默失效**。
  await $`git add -f ${IMPL_REL} ${TEST_REL}`.cwd(fx.root).quiet().nothrow();

  return { root: fx.root, implPath: IMPL_REL, testPath: TEST_REL, cleanup: fx.cleanup };
}

/**
 * 判决。**三态**:测试跑不起来 ≠ 零缺陷。
 *
 * `runnable:false` 时所有缺陷数都是 `undefined` 而不是 0 —— 一个跑不起来的臂
 * 印成 `缺陷 0` 就是本仓 S-23 那条(分子恒零而分母正常, 印出漂亮的 0)。
 */
export interface CoupledScore {
  /** 测试真的跑起来了吗(有 pass/fail 计数)。false ⇒ 下面的数全是 undefined。 */
  runnable: boolean;
  tscClean: boolean;
  /** R1/R2/R3 各自用例里失败的条数。 */
  singleFail?: number;
  /** X/ 交叉用例里失败的条数 —— **假说预测并行臂主要输在这一格**。 */
  crossFail?: number;
  total?: number;
  failedNames: string[];
  /** 跑不起来时的原始输出尾巴, 供事后定位(fail-open 可以吞异常, 不许吞证据)。 */
  raw?: string;
}

export async function scoreCoupled(root: string, testPath = TEST_REL): Promise<CoupledScore> {
  const tsc = await $`bun run tsc --noEmit`.cwd(root).quiet().nothrow();
  const t = await $`bun test ${testPath}`.cwd(root).quiet().nothrow();
  const out = t.stdout.toString() + t.stderr.toString();
  const pass = Number(/(\d+) pass/.exec(out)?.[1] ?? NaN);
  const fail = Number(/(\d+) fail/.exec(out)?.[1] ?? NaN);
  const tscClean = tsc.exitCode === 0;
  if (!Number.isFinite(pass) || !Number.isFinite(fail) || pass + fail === 0) {
    return { runnable: false, tscClean, failedNames: [], raw: out.slice(-1500) };
  }
  // bun 的失败行形如 `(fail) X/ 不变量: ...`。用例名前缀是我们自己钉的, 所以分格靠前缀。
  const failedNames = out
    .split('\n')
    .filter((l) => l.includes('(fail)'))
    .map((l) => l.slice(l.indexOf('(fail)') + 6).trim());
  const crossFail = failedNames.filter((n) => n.includes('X/')).length;
  return {
    runnable: true,
    tscClean,
    singleFail: failedNames.length - crossFail,
    crossFail,
    total: pass + fail,
    failedNames,
  };
}
