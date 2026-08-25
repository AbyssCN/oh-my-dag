/**
 * src/harness/agent-tools-jargon-gate.test.ts —— 禁用词**边界闸**(2026-08-26, RED)。
 *
 * ## 为什么把这道闸从验收层挪到边界层
 *
 * 三发实装 run 连续死在禁用词上, 而且死法一模一样: leaf 在注释与测试名里写了两个禁用词
 * (具体是哪两个见下方拼接常量 `W` —— 这里刻意不写字面, 因为本闸不区分「使用」与「引用」,
 * 写出来连这份说明自己都会被判红; 这个形态本 session 已经撞到第三次),
 * 收尾的仓规检查判红 → 节点 failed → 下游级联 skipped。实核出来是三层叠加:
 *
 *   ① leaf 的 prompt 里**没有禁用词表**。`agent-leaf.ts:75` 注入的是
 *      `LEAF_HARNESS_CORE`(`harness-prompts.ts:127-137`), 那段只有四条方法论,
 *      零禁用词; 完整表在同文件 `:231` 的 output-style 段, 属 conductor 的拼装。
 *      —— leaf 从来不知道有这些词。
 *   ② 反馈通道被预算掐死。`agent-leaf.ts:2492` 仓规 FAIL 抛错, 注释写明用意是让
 *      message 经 `causeOf` 进 causeNote 重试; 但 `engine.ts:4419` 是
 *      `node.max_retry ?? 0` —— 默认 0。两发实装 run 的日志里「L0 节点级重试」出现 0 次。
 *   ③ 闸的层级放错: 它约束的是「怎么写字」= 做法层, 却实装成收尾验收, 一击致命。
 *
 * 本仓的判据是「加一条纪律之前先问: 能不能做成会红的闸」。禁用词能 —— 在**写入那一刻**
 * 拒, 错误里带替换建议, leaf 当场换词, 零重试成本。这与 `requireWritable` 同层:
 * 那个判「路径在不在边界内」, 这个判「内容合不合仓规」, 两者正交。
 *
 * ## 这份网钉六条
 *
 *   (a) write 的 content 含禁用词 → 抛 BLOCKED, 且错误里带**替换建议**(不是只说"错了")。
 *   (b) 拒了就**没写成** —— 边界层 fail-closed 的定义: 文件根本不该出现。
 *   (c) edit 的 newText 含禁用词 → 同样拒。
 *   (d) edit **只查新写入的 newText**: 文件里原本就有的禁用词不连坐。
 *       这条不是洁癖 —— 2026-08-25 主干上就躺着别人提交的禁用词, 连坐会让 leaf
 *       改任何一个既有脏文件都寸步难行, 而那些词不是它写的。
 *   (e) 干净内容照常写入(零回归)。
 *   (f) 豁免面照旧: `SKIP_PREFIXES` / `EXCLUDE_FILES` 是 owner 已裁的决定
 *       (台账逐字引用 commit message、禁用词表原文本身), 边界闸**不推翻**它们。
 *
 * **证伪方式**(实跑过): 把 `agent-tools.ts` 的 `requireNoJargon` 调用删掉 ⇒ (a)(b)(c) 全红;
 * 把它改成扫整份文件而不是只扫新写入文本 ⇒ (d) 红; 把豁免判断去掉 ⇒ (f) 红。
 *
 * ⚠ 本文件自己会被 jargon-scan 扫到, 所以禁用词字面一律**拼接构造**
 *   (`W.luopan` 等), 静态扫描只认源码里的字面串 —— 这是 jargon-scan 自己给的建议。
 */
import { describe, expect, it } from 'bun:test';
import { mkdtempSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOmdAgentTools, type AnyOmdTool } from './agent-tools';

/** 禁用词字面拼接构造 —— 直接写会被本仓 jargon-scan 抓(它只认字面串)。 */
const W = {
  luopan: ['落', '盘'].join(''),
  shoukou: ['收', '口'].join(''),
  zhuashou: ['抓', '手'].join(''),
};

const toolset = (cwd: string): Record<string, AnyOmdTool> =>
  Object.fromEntries(createOmdAgentTools({ cwd }).map((t) => [t.name, t]));

const run = (t: AnyOmdTool, args: unknown): Promise<unknown> =>
  t.execute('call-1', args as never, undefined, undefined) as Promise<unknown>;

const tmp = (): string => mkdtempSync(join(tmpdir(), 'omd-jargon-gate-'));

describe('禁用词边界闸 · write', () => {
  it('★ (a) content 含禁用词 → 抛 BLOCKED, 错误里带替换建议', async () => {
    const cwd = tmp();
    const t = toolset(cwd);
    // 反例: 注释里写禁用词 —— 正是三发 run 实际的死法。
    const content = `// 观测位: 每笔请求原文${W.luopan}\nexport const x = 1;\n`;
    let err: Error | undefined;
    try {
      await run(t.write!, { path: 'a.ts', content });
    } catch (e) {
      err = e as Error;
    }
    expect(err, '含禁用词的 write 必须被拒').toBeDefined();
    expect(err!.message).toContain('BLOCKED');
    // 关键: 不能只说"你错了", 要说"该换成什么" —— 否则 leaf 只能猜。
    expect(err!.message).toContain(W.luopan);
    expect(err!.message).toContain('写入磁盘');
  });

  it('★ (b) 拒了就没写成 —— fail-closed, 文件不该存在', async () => {
    const cwd = tmp();
    const t = toolset(cwd);
    await run(t.write!, { path: 'b.ts', content: `// ${W.shoukou}\n` }).catch(() => undefined);
    expect(existsSync(join(cwd, 'b.ts')), '被拒的写入不许留下文件').toBe(false);
  });

  it('★ (e) 干净内容照常写入(零回归)', async () => {
    const cwd = tmp();
    const t = toolset(cwd);
    await run(t.write!, { path: 'c.ts', content: '// 观测位: 每笔请求原文写入磁盘\nexport const y = 2;\n' });
    expect(readFileSync(join(cwd, 'c.ts'), 'utf8')).toContain('写入磁盘');
  });

  it('★ (f) 豁免面照旧: docs/plan/ 下不拦(SKIP_PREFIXES 是 owner 已裁的决定)', async () => {
    const cwd = tmp();
    mkdirSync(join(cwd, 'docs', 'plan'), { recursive: true });
    const t = toolset(cwd);
    // 台账要逐字引用 commit message, 而 commit 改不了 —— 这是 jargon-scan 自己写下的理由。
    await run(t.write!, { path: 'docs/plan/x.md', content: `台账逐字引用: ${W.luopan}\n` });
    expect(existsSync(join(cwd, 'docs', 'plan', 'x.md')), '豁免前缀下的写入不该被拦').toBe(true);
  });
});

describe('禁用词边界闸 · edit', () => {
  it('★ (c) newText 含禁用词 → 抛 BLOCKED', async () => {
    const cwd = tmp();
    writeFileSync(join(cwd, 'd.ts'), 'export const a = 1;\n');
    const t = toolset(cwd);
    let err: Error | undefined;
    try {
      await run(t.edit!, { path: 'd.ts', oldText: 'const a = 1', newText: `const a = 2; // ${W.zhuashou}` });
    } catch (e) {
      err = e as Error;
    }
    expect(err, '新写入含禁用词的 edit 必须被拒').toBeDefined();
    expect(err!.message).toContain('BLOCKED');
    expect(err!.message).toContain('着力点'); // 替换建议
  });

  it('★ (d) 只查 newText —— 文件里原有的禁用词不连坐', async () => {
    const cwd = tmp();
    // 文件里本来就有禁用词(例如别人先前提交的), 但这次 edit 写的是干净文本。
    writeFileSync(join(cwd, 'e.ts'), `// 旧注释: ${W.luopan}\nexport const a = 1;\n`);
    const t = toolset(cwd);
    await run(t.edit!, { path: 'e.ts', oldText: 'const a = 1', newText: 'const a = 2' });
    const after = readFileSync(join(cwd, 'e.ts'), 'utf8');
    expect(after, '不该因为文件里原有的禁用词而拒掉一次干净的 edit').toContain('const a = 2');
  });
});
