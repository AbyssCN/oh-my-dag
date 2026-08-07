/**
 * **写的可见性** (2026-08-06) —— ⑧.6 的机会分母今天看不见 shell 写。
 *
 * ## 这一格是什么
 *
 * `filesTouched` 只认**受控写工具** (write/edit/hashline)。于是:
 *   · `command` 节点那一路**根本不填这一位** —— 两个并发 command 真撞在同一条路径上,
 *     ⑧.6 只看得见 `overlaps`, 机会分母恒 0;
 *   · agent leaf 既用受控工具又用 bash 写时, bash 那部分**永远隐形**
 *     (产物闸的救援② 只在 `filesTouched.length === 0` 时才跑)。
 *
 * 交接 31 §四第二条把它标成「下一程可挑」, 交接 32 §四写清了动它之前要想的那件事:
 * **救援那条的安全性质是「没有盘上证据就不救」(挡 empty-done), 而 ⑧.6 要的是
 * 可见性不是放行** —— 两者可以分开。所以本件加的是一条**只进可见性、不参与任何判定**
 * 的候选来源, 一个字都没碰救援②的判据。
 *
 * ## 证据强度不同的两类不许合并
 *
 * `filesTouched` = **确实写了**(受控工具的事实);
 * `writeCandidates` = **命令点名要写, 且那个文件在本节点执行窗口内变过**(推断, 经盘上核实)。
 * 后者弱一些 —— 一条 `a && b > x` 里 `a` 失败时 `x` 没被写, 而同窗口另一个节点写了它就会被认领。
 * 所以 ⑧.6 **两套数一起记**: `pairs`/`findings` 是严格口径(逐字同 2026-08-06 首版),
 * `pairsInferred`/`findingsInferred` 才含推断。要升闸的人得先看得见这个分野。
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runExecutorDag, type GenerateFn } from '../../src/harness/dag/engine';

/** 两个**无依赖**的 command 节点, 各自用 shell 重定向写文件 —— 谁都没在 output_path 里声明它。 */
const runCommandPair = async (mode: 'collide' | 'separate') => {
  const dir = mkdtempSync(join(tmpdir(), 'shellvis-'));
  // ⚠ **命令里用绝对路径**, 这不是为了绕开测试环境: command leaf 没有 cwd 通道
  // (`CommandLeafResult` 不报 cwd), 引擎按仓根解析相对路径 —— 而真实 command leaf 就是跑在
  // 仓根的。一条 `cd 别处 && > x.md` 的相对目标会解析到仓根、核不过、于是**不产候选**
  // (漏认不误认, 方向与整条通道一致)。这条边界写在 writeCandidates 的字段注里。
  const target = (i: number) => join(dir, mode === 'collide' ? 'shared.md' : `own-${i}.md`);
  const PLAN = JSON.stringify({
    name: 'p',
    nodes: {
      c1: { goal: '写一', executor: 'command', command: `echo one > ${target(0)}` },
      c2: { goal: '写二', executor: 'command', command: `echo two > ${target(1)}` },
    },
  });
  const generate: GenerateFn = async ({ model }) =>
    model === 'mimo:mimo-v2.5-pro' ? { text: PLAN, usage: { in: 1, out: 1 } } : { text: 'OUT', usage: { in: 1, out: 1 } };
  const res = await runExecutorDag('t', {
    conductorModel: 'mimo:mimo-v2.5-pro',
    leafModel: 'deepseek:deepseek-v4-flash',
    generate,
    // 真跑一条 shell —— 判据吃的是**命令原文**, 所以这里必须是真的重定向写法。
    // 两条都先睡一会儿再写, 保证执行窗口真重叠 (否则测的是串行)。
    commandRunner: async ({ command }) => {
      await new Promise((r) => setTimeout(r, 20));
      const proc = Bun.spawn(['sh', '-c', command], { cwd: dir, stdout: 'pipe', stderr: 'pipe' });
      const exitCode = await proc.exited;
      return { text: await new Response(proc.stdout).text(), exitCode, usage: { in: 0, out: 0 } };
    },
  });
  return { res, dir };
};

describe('写的可见性 · command 节点的 shell 写进不进 ⑧.6 的机会分母', () => {
  test('★ 两个并发 command 撞同一个没声明过的文件 → 推断口径报, 严格口径不报', async () => {
    const { res, dir } = await runCommandPair('collide');
    // 夹具自证: 文件真被写了 (两个都写 shared.md, 后写的赢 —— 那正是这条检测器要说的事)
    expect(readFileSync(join(dir, 'shared.md'), 'utf8').trim()).toMatch(/^(one|two)$/);
    const wr = res.writeRace!;
    expect(wr.overlaps).toBeGreaterThan(0); // 夹具自证: 窗口真重叠了

    // ── 严格口径: 一个字都不该变 (command 节点从来不填 filesTouched) ──────────────
    // 这两行是**回归闸**: 新加的推断口径若污染了严格口径, 它们当场红。
    expect(wr.pairs).toBe(0);
    expect(wr.findings).toBe(0);

    // ── 推断口径: 这才是本件补上的那一格 ────────────────────────────────────────
    expect(wr.pairsInferred).toBe(1);
    expect(wr.findingsInferred).toBe(1);
    expect(res.observations?.some((o) => o.kind === 'write-race')).toBe(true);
  });

  test('★ 各写各的 → 不报, 而**推断口径的机会照样计数** (这才叫"查过零检出")', async () => {
    const { res } = await runCommandPair('separate');
    const wr = res.writeRace!;
    expect(wr.pairsInferred).toBe(1); // 有机会
    expect(wr.findingsInferred).toBe(0); // 没撞上
    expect(res.observations?.some((o) => o.kind === 'write-race')).toBeFalsy();
  });
});

describe('写的可见性 · agent leaf 既用受控工具又用 bash 写', () => {
  /**
   * 产物闸的救援② 只在 `filesTouched` **空**时才跑 —— 于是「用 write 工具写了 a.md,
   * 又用 bash 写了 b.md」这一路里 b.md 永远隐形。本件补的正是它, 而且**没碰救援那条的门**:
   * 候选走的是独立的一位, 不参与任何判定。
   */
  const runMixed = async () => {
    const dir = mkdtempSync(join(tmpdir(), 'shellvis-mix-'));
    const PLAN = JSON.stringify({
      name: 'p',
      nodes: { m1: { goal: '混一', executor: 'agent' }, m2: { goal: '混二', executor: 'agent' } },
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
        await new Promise((r) => setTimeout(r, 20));
        // ① 受控工具写各自的文件 → filesTouched 认得
        writeFileSync(join(dir, `own-${i}.md`), 'x');
        // ② bash 写同一个共享文件 → filesTouched **认不得**, 只有命令原文里有
        writeFileSync(join(dir, 'shared.md'), `第 ${i} 个`);
        return {
          text: '写好了',
          usage: { in: 1, out: 1 },
          filesTouched: [`own-${i}.md`],
          shellRuns: [{ command: 'echo x > shared.md', exitCode: 0, ok: true }],
          cwd: dir,
        };
      },
    });
    return res;
  };

  test('★ 受控写各写各的、bash 写撞在一起 → 严格口径看不见, 推断口径看得见', async () => {
    const res = await runMixed();
    const wr = res.writeRace!;
    // 严格口径: 两侧 filesTouched 都非空 → 是一次机会, 但各写各的 → 没撞
    expect(wr.pairs).toBe(1);
    expect(wr.findings).toBe(0);
    // 推断口径: 把 bash 写并进来才看得见那次真撞车
    expect(wr.pairsInferred).toBe(1);
    expect(wr.findingsInferred).toBe(1);
  });
});
