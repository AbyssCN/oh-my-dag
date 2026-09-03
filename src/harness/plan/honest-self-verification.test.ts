/**
 * **诚实自验的记录通道**(2026-08-05)—— agent leaf 跑过的 bash 命令 + 退出码进引擎事实。
 *
 * ## 它补的洞
 *
 * 「产物声称的引擎校验动作 ⊆ 引擎记录的动作」这个谓词,**记录集此前缺了主要合法元素**:
 * agent leaf 手里有 bash,「我跑了 `bun test`,3/3 通过」是诚实自验的主要形状,
 * 而引擎只记 `toolCalls` 的**次数** —— 数不出跑的是什么、过没过。于是真跑过测试的诚实节点
 * 与顺手编一句的节点在 facts 上长得一模一样,子集检查的误报是**结构性**的。
 *
 * ## 这份网分两层,两层都要
 *
 * ① **往返**:引擎写出去的那行字,判据必须读得回来。今天 `命令退出码符合预期` 那一行是
 *    executor 写、claimed-actions 用正则读,**格式没有共同真源** —— 新加这条不再犯,
 *    渲染与解析在同一个文件里,而这里钉住它们真的对得上。
 * ② **端到端**:同一个声称,跑过 `bun test`(exit 0)→ 不报;只跑过 `ls` → 照报。
 *    这一条是整条通道的验收 —— 采集、透传、渲染、判据缺任何一环它都会红。
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordSupportsVerification, renderShellRunFact } from './claimed-actions';
import { runExecutorDagWithPlan } from '../dag/engine';
import { createShellRunCollector } from '../agent-leaf';
import { PLAN_BOUNDARY } from '../../../test/helpers/legacy-plan-entry';
import { CheckpointManager } from '../continuity/checkpoint-manager';
import type { ContentPart } from '../../model/gateway';
import type { ConductorPlan } from '../conductor-plan';
import type { ExecutorDagConfig, GenerateFn } from '../dag/types';
import type { ShellRun } from '../leaf-runners';

// ── ① 往返:写出去的那行字,读得回来 ──────────────────────────────────────────

describe('事实行的往返(渲染 ↔ 判据)', () => {
  const factsOf = (...runs: ShellRun[]): string[] => runs.map(renderShellRunFact);

  test('★ 校验类命令 + exit 0 → 算支撑(这条通道存在的全部理由)', () => {
    expect(recordSupportsVerification(factsOf({ command: 'bun test', exitCode: 0, ok: true }))).toBe(true);
    expect(recordSupportsVerification(factsOf({ command: 'bun run typecheck', exitCode: 0, ok: true }))).toBe(true);
    expect(recordSupportsVerification(factsOf({ command: 'npx tsc --noEmit', exitCode: 0, ok: true }))).toBe(true);
    expect(recordSupportsVerification(factsOf({ command: 'pytest -q tests/', exitCode: 0, ok: true }))).toBe(true);
  });

  test('★ 退出码非 0 → **不算**支撑(「跑了测试但红了」与「跑过且过了」是相反的两件事)', () => {
    expect(recordSupportsVerification(factsOf({ command: 'bun test', exitCode: 1, ok: false }))).toBe(false);
  });

  test('★ 没拿到退出码 → 不算支撑(闸拒/起不来:NULL ≠ 0)', () => {
    const f = factsOf({ command: 'bun test', ok: false });
    expect(f[0]).toContain('无退出码记录'); // 不许渲染成 exit 0
    expect(recordSupportsVerification(f)).toBe(false);
  });

  test('★ 非校验命令即使 exit 0 也不算 —— 否则一个 `ls` 就赦免整个节点', () => {
    for (const command of ['ls -la', 'cat README.md', 'git status', 'mkdir -p test', 'grep -rn test src/', 'bun run scripts/eval.ts']) {
      expect(recordSupportsVerification(factsOf({ command, exitCode: 0, ok: true })), command).toBe(false);
    }
  });

  test('命令里的换行被压平 —— 事实是一行,多行会被读成好几条事实', () => {
    const line = renderShellRunFact({ command: 'bun test \\\n  --coverage', exitCode: 0 });
    expect(line.includes('\n')).toBe(false);
    expect(recordSupportsVerification([line])).toBe(true);
  });

  test('超长命令截断后仍读得出(校验词在头部)', () => {
    const line = renderShellRunFact({ command: `bun test ${'x'.repeat(500)}`, exitCode: 0 });
    expect(line.length).toBeLessThan(220);
    expect(recordSupportsVerification([line])).toBe(true);
  });

  test('command 节点那条老事实照旧算数(没被新判据挤掉)', () => {
    expect(recordSupportsVerification(['命令退出码符合预期 (expect_exit=0)'])).toBe(true);
  });
});

// ── ①.2 退出码归因(2026-08-05 跨模型审查抓到的真洞)──────────────────────────

describe('★ 退出码归不到那条校验命令头上时,不算支撑', () => {
  const supports = (command: string, exitCode = 0): boolean =>
    recordSupportsVerification([renderShellRunFact({ command, exitCode })]);

  test('`|| true` 吞掉失败 → 整体 exit 0 与测试过没过无关', () => {
    // 这是最省事的一种"让闸闭嘴": 命令里带着 `bun test` 几个字, 退出码恒 0。
    expect(supports('bun test || true')).toBe(false);
  });

  test('`;` 串联 → 退出码是最后一条的, 不是测试的', () => {
    expect(supports('bun test; echo done')).toBe(false);
  });

  test('管道 → 退出码是最后一级的(没开 pipefail)', () => {
    expect(supports('bun test | tee log.txt')).toBe(false);
  });

  test('`&&` 链**算数** —— 全链成功才 exit 0', () => {
    expect(supports('cd packages/core && bun test')).toBe(true);
  });

  test('★ 命令里只是**出现**那几个字不算(锚在命令位置上)', () => {
    // `grep -rn "bun test" src/` 退出码 0 只说明搜到了, 与跑没跑测试无关。
    expect(supports('grep -rn "bun test" src/')).toBe(false);
    expect(supports('echo bun test')).toBe(false);
    expect(supports('cat scripts/run-tests.sh')).toBe(false);
  });

  test('执行器前缀照常识别(`npx tsc` / `bunx vitest`)', () => {
    expect(supports('npx tsc --noEmit')).toBe(true);
    expect(supports('bunx vitest run')).toBe(true);
  });
});

// ── ①.5 采集器:事件流 → ShellRun(命令与退出码分属两个事件,配对是有判断的) ──────

describe('bash 痕迹采集器(工具事件流的配对)', () => {
  const start = (id: string, command: string) => ({ type: 'tool_execution_start', toolCallId: id, toolName: 'bash', args: { command } });
  const end = (id: string, exitCode?: number, isError = false) => ({
    type: 'tool_execution_end',
    toolCallId: id,
    toolName: 'bash',
    isError,
    result: { content: [], details: exitCode === undefined ? {} : { exitCode } },
  });

  test('命令 + 退出码按 toolCallId 配对(交错完成也不许串)', () => {
    const c = createShellRunCollector();
    c.note(start('1', 'bun test'));
    c.note(start('2', 'ls'));
    c.note(end('2', 0)); // 后发先至
    c.note(end('1', 1));
    expect(c.runs()).toEqual([
      { command: 'ls', exitCode: 0, ok: true },
      { command: 'bun test', exitCode: 1, ok: false },
    ]);
  });

  test('★ 闸拒 (工具抛错, 无 details) → 记下来但退出码**缺席**, 不编 0', () => {
    const c = createShellRunCollector();
    c.note(start('1', 'rm -rf /'));
    c.note(end('1', undefined, true));
    // 「跑了但被拒」与「压根没跑」是两件事 —— 只记成功的那半就把它们抹平了。
    expect(c.runs()).toEqual([{ command: 'rm -rf /', ok: false }]);
    expect(c.runs()[0]).not.toHaveProperty('exitCode');
  });

  test('平台没给退出码 → 同样缺席(NULL ≠ 0)', () => {
    const c = createShellRunCollector();
    c.note(start('1', 'bun test'));
    c.note(end('1'));
    expect(c.runs()[0]).toEqual({ command: 'bun test', ok: false });
  });

  test('非 bash 工具与没见过 start 的 end 一律不记(不编一条出来)', () => {
    const c = createShellRunCollector();
    c.note({ type: 'tool_execution_start', toolCallId: '1', toolName: 'write', args: { path: 'a.ts' } });
    c.note({ type: 'tool_execution_end', toolCallId: '1', toolName: 'write', isError: false, result: {} });
    c.note(end('ghost', 0));
    expect(c.runs()).toEqual([]);
  });
});

// ── ② 端到端 (v1 内环, 2026-09-03 随 v1 退役删去; 平铺路径的扫描见下方「平铺图也要被扫到」) ──

describe('★ 产物闸不许把"闸看不见"说成"它没做"', () => {
  /** 一个 agent 节点: 声称写了文件, 但受控写工具一次没用 (filesTouched 空)。 */
  const writeNodePlan = {
    name: 'p',
    nodes: { w: { goal: '写入说明', executor: 'agent', output_type: 'file' } },
  } as unknown as ConductorPlan;

  async function runWrite(shellRuns: ShellRun[]): Promise<string> {
    const cfg = {
      conductorModel: 'c:m',
      leafModel: 'l:m',
      agentLeafModel: 'a:m',
      generate: async () => ({ text: '写好了', usage: { in: 1, out: 1 } }),
      agentTemplates: new Map(),
      agentRunner: async () => ({ text: '已把说明写进 docs/x.md', usage: { in: 1, out: 1 }, filesTouched: [], shellRuns }),
    } as unknown as ExecutorDagConfig;
    const r = await runExecutorDagWithPlan(writeNodePlan, cfg);
    return r.results.w?.output ?? '';
  }

  test('★ 跑过 bash → 判词说"闸看不见"并给出命令与救法, **不说"未做任何文件写操作"**', async () => {
    // 2026-08-05 真跑: 文件真写好了 (57 行合规), 闸却判「leaf 自报完成但未做任何文件写操作」,
    // 下游四个复核节点因此全被 skip。引擎说错话的代价与执行体说错话一样大。
    const out = await runWrite([{ command: 'python3 - <<PY ... docs/x.md', exitCode: 0, ok: true }]);
    expect(out).toContain('产物校验失败');
    expect(out).not.toContain('未做任何文件写操作');
    expect(out).toContain('bash 命令'); // 说得出它看见了什么
    expect(out).toContain('output_path'); // 说得出怎么救
  });

  test('真的一条命令都没跑 → 照旧那句(这一格的原判词是对的)', async () => {
    const out = await runWrite([]);
    expect(out).toContain('未做任何文件写操作');
  });
});

// ── ④ 平铺图那道扫描(dag_run 那条路, 此前完全没有覆盖)──────────────────────────

describe('★ 平铺图(无 conductor 节点)也要被扫到', () => {
  const flatPlan = { name: 'p', nodes: { a: { goal: '干活' } } } as unknown as ConductorPlan;

  async function runFlat(text: string): Promise<{ kinds: string[]; claimCheck: unknown }> {
    const cfg = {
      conductorModel: 'c:m',
      leafModel: 'l:m',
      generate: async () => ({ text, usage: { in: 1, out: 1 } }),
      agentTemplates: new Map(),
    } as unknown as ExecutorDagConfig;
    const r = await runExecutorDagWithPlan(flatPlan, cfg);
    return { kinds: (r.observations ?? []).map((o) => o.kind), claimCheck: r.claimCheck };
  }

  test('★ 平铺图里的伪造声称照样被记进账本(此前这条路一条都收不到)', async () => {
    // 2026-08-05 首次真跑就是这种图: 6 个节点无一 conductor, 检出器结构上够不着,
    // 而账本记出来与"查过零检出"逐字相同 —— 按 entry 数它占一半流量。
    const { kinds, claimCheck } = await runFlat('本次已由引擎实测通过全部单元测试');
    expect(kinds).toContain('unsupported-claim');
    // P3 S3 (2026-09-02): 第三把尺子 `trailer` 入账 (尾块差集闸); 这条散文没有尾块 → 审过、零检出, 与「够不着」分得开。
    expect(claimCheck).toEqual({ conductor: { rounds: 0, nodes: 0, findings: 0 }, flat: { nodes: 1, findings: 1 }, trailer: { nodes: 1, findings: 0 } });
  });

  test('干净产出 → 记了、零检出(与"够不着"分得开)', async () => {
    const { kinds, claimCheck } = await runFlat('已实现 clamp 并写好测试');
    expect(kinds).not.toContain('unsupported-claim');
    expect(claimCheck).toEqual({ conductor: { rounds: 0, nodes: 0, findings: 0 }, flat: { nodes: 1, findings: 0 }, trailer: { nodes: 1, findings: 0 } });
  });
});

// ── ⑤ 产物闸救援②: 从 bash 命令认写目标 + 磁盘核实 ────────────────────────────

describe('★ 产物闸救回经 bash 写入的产物(必须有盘上证据)', () => {
  const writePlan = { name: 'p', nodes: { w: { goal: '写文件', executor: 'agent', output_type: 'file' } } } as unknown as ConductorPlan;

  async function runIn(
    root: string,
    shellRuns: ShellRun[],
    /** agent **执行期间**才写盘 —— 真实形状: 文件的 mtime 必须落在本节点窗口内。 */
    writeDuring?: () => void,
  ): Promise<{ status: string; files: string[]; output: string }> {
    const cfg = {
      conductorModel: 'c:m',
      leafModel: 'l:m',
      agentLeafModel: 'a:m',
      generate: async () => ({ text: '写好了', usage: { in: 1, out: 1 } }),
      agentTemplates: new Map(),
      continuity: { manager: new CheckpointManager(root), runId: 'r', repoRoot: root },
      agentRunner: async () => {
        writeDuring?.();
        return { text: '已写好 docs/x.md', usage: { in: 1, out: 1 }, filesTouched: [], cwd: root, shellRuns };
      },
    } as unknown as ExecutorDagConfig;
    const r = await runExecutorDagWithPlan(writePlan, cfg);
    return { status: r.results.w?.status ?? '?', files: r.results.w?.filesTouched ?? [], output: r.results.w?.output ?? '' };
  }

  test('★ 命令点名的文件在本节点窗口内被改过 → 救回(此前这一格判 empty-artifact 失败)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'omd-rescue-'));
    mkdirSync(join(root, 'docs'), { recursive: true });
    const r = await runIn(root, [{ command: "cat > docs/x.md <<'EOF'", exitCode: 0, ok: true }], () =>
      writeFileSync(join(root, 'docs/x.md'), '正文\n'),
    );
    expect(r.status).toBe('done');
    expect(r.files).toEqual(['docs/x.md']);
    rmSync(root, { recursive: true, force: true });
  });

  test('★ 文件在盘上但**早于**本节点(mtime 在窗口外)→ **不救**(否则 empty-done 被洗成成功)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'omd-rescue-'));
    mkdirSync(join(root, 'docs'), { recursive: true });
    writeFileSync(join(root, 'docs/x.md'), '早就在了\n');
    // 把 mtime 推回一小时前 —— 这个节点没碰过它
    const old = new Date(Date.now() - 3_600_000);
    utimesSync(join(root, 'docs/x.md'), old, old);
    // ⚠ 命令必须是**写形状**, 否则解析器不产候选, 这条用例就走不到 mtime 判据 ——
    //   第一版用的是 `cat docs/x.md`(读), 于是拆掉 mtime 判据它照样绿。
    //   反例的形状不对, 闸就是装饰(同今天写进 S-14 的那条)。
    const r = await runIn(root, [{ command: 'echo x > docs/x.md', exitCode: 0, ok: true }]);
    expect(r.status).toBe('failed');
    expect(r.output).toContain('产物校验失败');
    rmSync(root, { recursive: true, force: true });
  });

  test('★ 命令点名的文件根本不在盘上 → 不救(没证据不救, 与救援①同一条性质)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'omd-rescue-'));
    const r = await runIn(root, [{ command: 'echo hi > docs/ghost.md', exitCode: 0, ok: true }]);
    expect(r.status).toBe('failed');
    rmSync(root, { recursive: true, force: true });
  });

  test('只跑过读命令 → 认不出写目标 → 照旧失败(纯读不该被救)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'omd-rescue-'));
    mkdirSync(join(root, 'docs'), { recursive: true });
    writeFileSync(join(root, 'docs/x.md'), '正文\n');
    const r = await runIn(root, [{ command: 'ls -la docs', exitCode: 0, ok: true }]);
    expect(r.status).toBe('failed');
    rmSync(root, { recursive: true, force: true });
  });

  // ⑥ 脚本内部的写 (2026-08-05): 解析器那侧有单测, 这里钉的是**误杀真的停了** ——
  // 解析器绿不等于闸放行 (救援还要过盘上存在 + mtime 两道)。
  test('★ 脚本内部的写(heredoc + open(f,"w"))→ 救回, 此前这一格是真误杀', async () => {
    const root = mkdtempSync(join(tmpdir(), 'omd-rescue-'));
    mkdirSync(join(root, 'docs'), { recursive: true });
    const r = await runIn(
      root,
      [{ command: "python3 - <<'PY'\nopen('docs/x.md','w').write('正文')\nPY", exitCode: 0, ok: true }],
      () => writeFileSync(join(root, 'docs/x.md'), '正文\n'),
    );
    expect(r.status).toBe('done');
    expect(r.files).toEqual(['docs/x.md']);
    rmSync(root, { recursive: true, force: true });
  });

  test('★ 脚本只**读**那个文件 → 不救(哪怕文件恰好在窗口内被别人改过)', async () => {
    // 这条守的是"不多认"那一半在**整道闸上**也成立: 并发扇出下另一个 leaf 恰好写了同名
    // 文件时, 一个纯读脚本不该被洗成成功。反例形状必须落在 open() 上 —— 用 `cat` 那种
    // 根本不产候选的命令充数, 拆掉判据它照样绿。
    const root = mkdtempSync(join(tmpdir(), 'omd-rescue-'));
    mkdirSync(join(root, 'docs'), { recursive: true });
    const r = await runIn(
      root,
      [{ command: "python3 - <<'PY'\nprint(open('docs/x.md').read())\nPY", exitCode: 0, ok: true }],
      () => writeFileSync(join(root, 'docs/x.md'), '别人写的\n'), // 窗口内, 但不是这个节点写的
    );
    expect(r.status).toBe('failed');
    rmSync(root, { recursive: true, force: true });
  });
});
