/**
 * **运行时写竞争** (2026-08-06) —— 以及它的分母。
 *
 * ## 它补的是哪一格
 *
 * `write-race` 这个名字此前只有**跑前静态**那一半 (`static-lint`, 按 `output_path` 声明判死)。
 * 一个 leaf 经 bash 写出去的文件不在任何声明里 —— 于是两个并发兄弟真撞在同一条路径上时,
 * **没有任何一处会知道**。交接 30 §五 第 2 条点的就是这一格: 台账把静态那 4 次读数当成了
 * 运行时这条的证据, 而两者的下一步相反 (前者改图, 后者要问这两个 leaf 为什么碰同一个文件)。
 *
 * ## 这套网的重心同样在**误报**那一侧
 *
 * 只报不拦的检测器, 误报的代价是把读的人支开。所以下面只有两条测它会响, 其余全在测它不该响:
 * 有依赖 (窗口不重叠) · 各写各的 · 一侧没报写 (看不见, 不是没撞) · 隔离档下同名不同根。
 *
 * ## 分母 (S-19 的教训)
 *
 * 这条从第一天就带着分母: `overlaps`(有没有并发)/ `pairs`(撞得上的机会)/ `findings`。
 * 少了中间那个, 「0 次」又会被除以运行次数 —— 那正是 ⑧ 段刚栽过的那一跤。
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectRuntimeWriteRace, type OverlapPair } from '../../src/harness/plan/observers';
import { runExecutorDagWithPlan, type GenerateFn } from '../../src/harness/dag/engine';
import { runExecutorDag } from '../helpers/legacy-plan-entry';

const pair = (a: string, b: string, aPaths: string[], bPaths: string[]): OverlapPair => ({
  a,
  b,
  aPaths: new Set(aPaths),
  bPaths: new Set(bPaths),
});

describe('运行时写竞争 · 判据本身', () => {
  test('两个重叠的节点写同一条绝对路径 → 报', () => {
    const r = detectRuntimeWriteRace([pair('x', 'y', ['/w/a.md'], ['/w/a.md'])]);
    expect(r.findings).toBe(1);
    expect(r.observations[0]!.kind).toBe('write-race');
    expect(r.observations[0]!.nodes).toEqual(['x', 'y']);
  });

  test('各写各的 → 不报, 但**照样进分母** (那是一次真的机会, 只是没撞上)', () => {
    const r = detectRuntimeWriteRace([pair('x', 'y', ['/w/a.md'], ['/w/b.md'])]);
    expect(r.findings).toBe(0);
    expect(r.pairs).toBe(1); // ← 这一行是分母存在的证据: 0/1 才是"查过零检出", 0/0 是"没机会"
  });

  test('判词点破它与静态那条的分野 —— 否则读的人会去改 plan 的声明', () => {
    const msg = detectRuntimeWriteRace([pair('x', 'y', ['/w/a.md'], ['/w/a.md'])]).observations[0]!.message;
    expect(msg).toContain('运行时写竞争');
    expect(msg).toContain('同名不同义');
    expect(msg).toContain('静态检查看不见');
  });

  test('确定性序: 同一批对象换个顺序进来, 报告逐字相同 (观察面不许有并发时序的痕迹)', () => {
    const a = pair('n1', 'n2', ['/w/a'], ['/w/a']);
    const b = pair('n3', 'n4', ['/w/b'], ['/w/b']);
    const fwd = detectRuntimeWriteRace([a, b]).observations.map((o) => o.message);
    const rev = detectRuntimeWriteRace([b, a]).observations.map((o) => o.message);
    expect(fwd).toEqual(rev);
  });
});

describe('★ 运行时写竞争 · 三个数分得开 (S-19: 分母要有人写)', () => {
  // 证伪: 把 detectRuntimeWriteRace 里 `if (p.aPaths.size === 0 || …) continue` 那行删掉
  // → 「看不见的那部分」当场混进 pairs, 下面第二条红。
  test('一侧没报写 → 算 overlap, **不算机会** (真没写 与 写了但看不见 分不开)', () => {
    const r = detectRuntimeWriteRace([pair('x', 'y', ['/w/a.md'], [])]);
    expect(r.overlaps).toBe(1);
    expect(r.pairs).toBe(0); // ← 不许拿"可能没写"冒充"确实没写"
    expect(r.findings).toBe(0);
  });

  test('两侧都没报写 → 同上, 且不会因为"两个空集相等"就报成撞车', () => {
    const r = detectRuntimeWriteRace([pair('x', 'y', [], [])]);
    expect(r.pairs).toBe(0);
    expect(r.findings).toBe(0);
  });

  test('overlaps 数的是**所有**重叠对, pairs 只数看得见的那些 —— 两个数各有各的问', () => {
    const r = detectRuntimeWriteRace([
      pair('a', 'b', ['/w/1'], ['/w/1']), // 撞了
      pair('c', 'd', ['/w/2'], ['/w/3']), // 机会, 没撞
      pair('e', 'f', ['/w/4'], []), // 看不见
    ]);
    expect(r.overlaps).toBe(3);
    expect(r.pairs).toBe(2);
    expect(r.findings).toBe(1);
  });

  test('★ 隔离档: 同名文件不同根 → 不是竞争 (判据吃的是**绝对路径**)', () => {
    // 少了这条, R2 隔离档下每一对写 out.md 的兄弟都会被报一次 —— 整个隔离档一片红。
    const r = detectRuntimeWriteRace([pair('x', 'y', ['/wt-1/out.md'], ['/wt-2/out.md'])]);
    expect(r.findings).toBe(0);
    expect(r.pairs).toBe(1);
  });
});

/**
 * **父子不算一对** + **子图那一层也要看得见**(2026-08-06 补,两条一起,因为它们互为前提)。
 *
 * 首版只在**外层 pump** 上记 `liveNow`,于是 ⑧.6 只看得见顶层调度的节点 —— 而 conductor
 * 扇出正是并发的主要来源。两个真并发的兄弟撞同一个文件时 `overlaps` 照样是 **0**,
 * 而那个 0 的意思是"没往那儿看",不是"没发生"。
 *
 * 把子图接进来之后立刻出现第二个问题:父 conductor 此刻也在 `liveNow` 里,于是配出
 * `C × C::child` 这种**父子对** —— 而父节点的 `filesTouched` 是**子树并集**,它自己一个字
 * 都没写。不滤掉就会把同一次写数两遍,报出一条**改不了**的"竞争"
 * (「让它们写不同文件」「加一条 depends_on」对父子关系都不成立)。
 *
 * ⚠ 这条守卫的代价是量过的:拿 checkpoint 重建历史窗口时**没有**它,46 条"撞车"里
 *   一眼就能看到 `execute × execute::<hash>` 这种父子对。
 */
describe('运行时写竞争 · 父子不算一对 (判据本身)', () => {
  test('★ 父 × 它自己的子节点 → **一格都不进**(连 overlaps 都不算)', () => {
    const r = detectRuntimeWriteRace([pair('C', 'C::abc', ['/w/a.md'], ['/w/a.md'])]);
    expect(r.overlaps).toBe(0); // ← 父子窗口必然重叠, 那不是"并发"的观察
    expect(r.pairs).toBe(0);
    expect(r.findings).toBe(0);
  });

  test('★ 两个兄弟子节点 → 照常报 (证明守卫没把真竞争一起滤掉)', () => {
    const r = detectRuntimeWriteRace([pair('C::a', 'C::b', ['/w/x.md'], ['/w/x.md'])]);
    expect(r.overlaps).toBe(1);
    expect(r.findings).toBe(1);
  });

  test('★ 前缀相同但不是父子 (`C2` vs `C2x::a`) 不许被误滤', () => {
    // 判据挂在 `<parent>::` 这个**构造保证**的形状上, 不是"名字像"。
    const r = detectRuntimeWriteRace([pair('C2', 'C2x::a', ['/w/x.md'], ['/w/x.md'])]);
    expect(r.findings).toBe(1);
  });
});

describe('运行时写竞争 · 接在引擎上 (真跑一遍)', () => {
  /**
   * 两个**无依赖**的 agent leaf, 各自都往同一个文件里写 —— 谁都没在 `output_path` 里声明它,
   * 所以跑前那道静态 lint 一个字都看不见。这正是这条通道存在的全部理由。
   */
  const runPair = async (mode: 'collide' | 'separate') => {
    const dir = mkdtempSync(join(tmpdir(), 'wrace-'));
    const PLAN = JSON.stringify({
      name: 'p',
      nodes: {
        w1: { goal: '写一', executor: 'agent' },
        w2: { goal: '写二', executor: 'agent' },
      },
    });
    const generate: GenerateFn = async ({ model }) =>
      model === 'mimo:mimo-v2.5-pro' ? { text: PLAN, usage: { in: 1, out: 1 } } : { text: 'OUT', usage: { in: 1, out: 1 } };
    let nth = 0;
    const res = await runExecutorDag('t', {
      conductorModel: 'mimo:mimo-v2.5-pro',
      leafModel: 'deepseek:deepseek-v4-flash',
      generate,
      agentRunner: async () => {
        const i = nth++;
        // 两个 leaf 都真跑起来之后才各自返回 —— 保证窗口重叠 (否则测的是串行)。
        const file = mode === 'collide' ? 'shared.md' : `own-${i}.md`;
        await new Promise((r) => setTimeout(r, 20));
        writeFileSync(join(dir, file), `第 ${i} 个`);
        return { text: '写好了', usage: { in: 1, out: 1 }, filesTouched: [file], cwd: dir };
      },
    });
    return { res, files: readdirSync(dir) };
  };

  test('★ 两个并发 leaf 撞同一个**没声明过**的文件 → 报, 且分子分母都在 writeRace 上', async () => {
    // 证伪: 把 runExecutorDagWithPlan 结果组装里那行 `writeRace: exec.writeRace` 删掉 → 这条红。
    const { res } = await runPair('collide');
    expect(res.writeRace!.overlaps).toBeGreaterThan(0); // 夹具自证: 窗口真重叠了
    expect(res.writeRace!.pairs).toBe(1);
    expect(res.writeRace!.findings).toBe(1);
    expect(res.observations?.some((o) => o.kind === 'write-race')).toBe(true);
  });

  test('★ 各写各的 → 不报, 而**机会照样计数** (这才叫"查过零检出")', async () => {
    const { res, files } = await runPair('separate');
    expect(files.sort()).toEqual(['own-0.md', 'own-1.md']); // 夹具自证: 真写了两个不同文件
    expect(res.writeRace!.pairs).toBe(1);
    expect(res.writeRace!.findings).toBe(0);
    expect(res.observations?.some((o) => o.kind === 'write-race')).toBeFalsy();
  });
});
