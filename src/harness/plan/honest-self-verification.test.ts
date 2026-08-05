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
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordSupportsVerification, renderShellRunFact } from './claimed-actions';
import { runExecutorDagWithPlan } from '../executor-dag';
import { createShellRunCollector } from '../agent-leaf';
import { PLAN_BOUNDARY } from '../conductor-plan';
import { CheckpointManager } from '../continuity/checkpoint-manager';
import type { ContentPart } from '../../model/gateway';
import type { ConductorPlan } from '../conductor-plan';
import type { ExecutorDagConfig, GenerateFn } from '../executor-dag-types';
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

// ── ② 端到端:整条内环 ────────────────────────────────────────────────────────

const contentText = (c: string | ContentPart[] | undefined): string =>
  typeof c === 'string' ? (c ?? '') : (c ?? []).map((p) => (p.type === 'text' ? p.text : '')).join('\n');

/** 一个 agent 节点 —— 它会自己跑命令, 然后在产出里声称测试过了。 */
const SUB_PLAN = JSON.stringify({
  name: 'sub',
  nodes: { impl: { goal: '实现 clamp 并自测', executor: 'agent' } },
});

/** 产出里的声称 —— 与语料 `code-green-forged-claim` 同族。 */
const CLAIM = '已实现 clamp, 单元测试全部通过';

const generate: GenerateFn = async (req) => {
  const user = contentText(req.messages.find((m) => m.role === 'user')?.content);
  if (user.includes(PLAN_BOUNDARY.trim().split('\n')[0]!) || user.includes('TASK (dynamic')) {
    return { text: SUB_PLAN, usage: { in: 1, out: 1 } };
  }
  return { text: CLAIM, usage: { in: 1, out: 1 } };
};

const plan: ConductorPlan = {
  name: 'p',
  nodes: { P: { goal: '写好 clamp', executor: 'conductor', max_rounds: 2 } },
};

/** 跑一次内环, 回 judge 看到的视图全文 + 账本。`shellRuns` 是两臂唯一的差别。 */
async function run(shellRuns: ShellRun[]): Promise<{ views: string[]; kinds: string[]; root: string }> {
  const root = mkdtempSync(join(tmpdir(), 'omd-honest-'));
  const views: string[] = [];
  const cfg = {
    conductorModel: 'c:m',
    leafModel: 'l:m',
    agentLeafModel: 'a:m',
    generate,
    agentTemplates: new Map(),
    agentRunner: async () => ({ text: CLAIM, usage: { in: 1, out: 1 }, filesTouched: [], shellRuns }),
    judgeSend: async (req: { messages: { role: string; content: string | ContentPart[] }[] }) => {
      views.push(req.messages.map((m) => contentText(m.content)).join('\n'));
      return {
        text: '',
        parsed: { converged: false, score: 3, failureReason: '还差一点', rejectedNodes: [] },
        usage: { in: 0, out: 0 },
        raw: {},
        model: 'judge:fake',
        attempts: 1,
      };
    },
    continuity: { manager: new CheckpointManager(root), runId: 'run-1' },
  } as unknown as ExecutorDagConfig;
  const r = await runExecutorDagWithPlan(plan, cfg);
  return { views, kinds: (r.observations ?? []).map((o) => o.kind), root };
}

describe('端到端:同一句声称,跑没跑过测试决定报不报', () => {
  test('★ 真跑过 `bun test` (exit 0) → **不报**(诚实自验的结构性误报被治住)', async () => {
    const { views, kinds, root } = await run([{ command: 'bun test', exitCode: 0, ok: true }]);
    expect(kinds).not.toContain('unsupported-claim');
    expect(views.some((v) => v.includes('[引擎记录核对]'))).toBe(false);
    // 命令本身要出现在 judge 视图里 —— 判据放过它, 判官仍该看得见凭什么放过。
    expect(views.some((v) => v.includes('执行命令: bun test (exit 0)'))).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  test('★ 只跑过 `ls` → 照报(通道没变成"有 bash 就免检")', async () => {
    const { views, kinds, root } = await run([{ command: 'ls -la src', exitCode: 0, ok: true }]);
    expect(kinds).toContain('unsupported-claim');
    expect(views.some((v) => v.includes('[引擎记录核对]'))).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  test('★ 跑了 `bun test` 但 exit 1 → 照报(红着的测试撑不起「全部通过」)', async () => {
    const { kinds, root } = await run([{ command: 'bun test', exitCode: 1, ok: false }]);
    expect(kinds).toContain('unsupported-claim');
    rmSync(root, { recursive: true, force: true });
  });

  test('一条命令都没跑 → 照报(与补这条通道之前同行为, 零回归)', async () => {
    const { kinds, root } = await run([]);
    expect(kinds).toContain('unsupported-claim');
    rmSync(root, { recursive: true, force: true });
  });

  test('命令条数超上限 → 剩下的**列出条数**, 不静默丢 (no-silent-caps)', async () => {
    const many: ShellRun[] = Array.from({ length: 9 }, (_, i) => ({ command: `echo ${i}`, exitCode: 0, ok: true }));
    const { views, root } = await run(many);
    expect(views.some((v) => v.includes('另有 3 条命令未展示'))).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });
});
