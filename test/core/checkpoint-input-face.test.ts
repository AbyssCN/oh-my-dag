/**
 * D-O checkpoint 输入面 (2026-07-29) —— 真 CheckpointManager 落 tmp 目录, 注入式 generate, 零 LLM。
 *
 * 补的是两个洞:
 *  ① **产出面只有 800 字**: resume 跳过一个节点时, 把 summary 当它的输出注入下游 —— 每续跑一次,
 *     上游信息就被静默截断一次。现在全文落 `out-<id>.txt`, summary 退回"给人看"。
 *  ② **输入面根本不存在**: 此前只有 `generation` (图**形态**签名) 守卫。形态没变而上游重跑出了
 *     **不同内容**时它一无所知 → 下游被当绿跳过, 拿旧输入的产物冒充新输入的产物。
 */
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runExecutorDagWithPlan } from '../../src/harness/dag/engine';
import { CheckpointManager, hashText } from '../../src/harness/continuity/checkpoint-manager';
import type { NodeCheckpoint } from '../../src/harness/continuity/types';
import type { ConductorPlan } from '../../src/harness/conductor-plan';
import type { ExecutorDagConfig, GenerateFn } from '../../src/harness/dag/types';

const RUN = 'do-run';
let root: string;
let manager: CheckpointManager;
let savedDataHome: string | undefined;

beforeEach(() => {
  // OMD_DATA_HOME 设了会把 checkpoint 改写到共享 ~/.omd/…/continuity → 固定 runId 跨用例泄漏。
  savedDataHome = process.env.OMD_DATA_HOME;
  delete process.env.OMD_DATA_HOME;
  root = mkdtempSync(join(tmpdir(), 'omd-do-'));
  manager = new CheckpointManager(root);
});
afterEach(() => {
  if (savedDataHome === undefined) delete process.env.OMD_DATA_HOME;
  else process.env.OMD_DATA_HOME = savedDataHome;
  rmSync(root, { recursive: true, force: true });
});

const runDir = (): string => join(root, '.omd', 'continuity', RUN);
const cp = (id: string): NodeCheckpoint => JSON.parse(readFileSync(join(runDir(), `${id}.json`), 'utf-8')) as NodeCheckpoint;

/** a → b 两节点。a 的输出每次执行都不同 (计数器), 用来制造"形态没变但内容变了"。 */
const plan: ConductorPlan = {
  name: 'do-plan',
  nodes: { a: { goal: '产出 A' }, b: { goal: '消费 A', depends_on: ['a'] } },
} as ConductorPlan;

/** 从 buildLeafPrompt 产出的 user prompt 里解析节点 id。 */
const leafId = (p: string): string => /\[omd leaf: ([^\]]+)\]/.exec(p)?.[1] ?? '?';

function fake(opts: { aBody?: (n: number) => string } = {}): {
  generate: GenerateFn;
  calls: string[];
  prompts: Record<string, string[]>;
} {
  const calls: string[] = [];
  const prompts: Record<string, string[]> = {};
  let aRuns = 0;
  const generate: GenerateFn = async (req) => {
    const user = req.messages.find((m) => m.role === 'user')?.content;
    const prompt = typeof user === 'string' ? user : '';
    const id = leafId(prompt);
    calls.push(id);
    (prompts[id] ??= []).push(prompt);
    const text = id === 'a' ? (opts.aBody ?? ((n: number) => `A-v${n}`))(++aRuns) : `B(${id})`;
    return { text, usage: { in: 1, out: 1 } };
  };
  return { generate, calls, prompts };
}

const cfg = (generate: GenerateFn, resume: boolean, extra: Partial<ExecutorDagConfig> = {}): ExecutorDagConfig => ({
  conductorModel: 'fixture:none',
  leafModel: 'fixture:none',
  generate,
  agentTemplates: new Map(),
  continuity: { manager, runId: RUN, repoRoot: root, ...(resume ? { resume: true } : {}) },
  ...extra,
});

describe('D-O 产出面 —— 输出全文落制品, summary 退回给人看', () => {
  test('绿 checkpoint 记 outputText, 文件里是全文而非 800 字截断', async () => {
    const long = 'X'.repeat(2000) + 'TAIL-MARK';
    const f = fake({ aBody: () => long });
    await runExecutorDagWithPlan(plan, cfg(f.generate, false));

    const a = cp('a');
    expect(a.summary).toHaveLength(800); // summary 仍是 800 字 (给人看的那份没变)
    expect(a.outputText).toBeTruthy();
    const full = readFileSync(a.outputText!, 'utf-8');
    expect(full).toHaveLength(long.length);
    expect(full.endsWith('TAIL-MARK')).toBe(true);
  });

  test('resume 跳过时下游拿到**全文**, 不是 800 字摘要 (每续跑一次截断一次的洞)', async () => {
    const long = 'X'.repeat(2000) + 'TAIL-MARK';
    await runExecutorDagWithPlan(plan, cfg(fake({ aBody: () => long }).generate, false));

    // 只让 b 重跑 (删它的 checkpoint), a 走 resume-skip → b 的 prompt 里应有 a 的全文。
    unlinkSync(join(runDir(), 'b.json'));
    const f2 = fake({ aBody: () => long });
    await runExecutorDagWithPlan(plan, cfg(f2.generate, true));

    expect(f2.calls).toEqual(['b']); // a 确实跳过了
    expect(f2.prompts.b![0]).toContain('TAIL-MARK'); // 2000 字之后的内容还在 → 没被截成 800
  });

  test('制品文件被删 → 退回 summary, 不崩 (fail-open, 有留痕)', async () => {
    await runExecutorDagWithPlan(plan, cfg(fake().generate, false));
    const outPath = cp('a').outputText!;
    unlinkSync(outPath);
    unlinkSync(join(runDir(), 'b.json'));

    const f2 = fake();
    const r = await runExecutorDagWithPlan(plan, cfg(f2.generate, true));
    expect(r.results.a?.status).toBe('done');
    expect(r.results.a?.output).toBe('A-v1'); // 短输出下 summary == 全文, 语义不丢
  });
});

describe('D-O 输入面 —— 上游内容变了, 下游不许当绿跳过', () => {
  test('依赖重跑出不同内容 → 下游作废重跑 (generation 相同也拦得住)', async () => {
    const f1 = fake();
    await runExecutorDagWithPlan(plan, cfg(f1.generate, false));
    expect(f1.calls.sort()).toEqual(['a', 'b']);
    expect(cp('b').inputHashes).toBeTruthy();

    // 只丢 a 的 checkpoint → a 重跑并产出 A-v1 (新进程新计数器, 但内容会变: 见下一步)。
    // 这里刻意让 a 第二次跑出**不同**文本, 模拟"形态没变、内容变了"。
    unlinkSync(join(runDir(), 'a.json'));
    const f2 = fake({ aBody: (n) => `A-CHANGED-${n}` });
    const r2 = await runExecutorDagWithPlan(plan, cfg(f2.generate, true));

    expect(f2.calls).toContain('a'); // a 重跑 (checkpoint 没了)
    expect(f2.calls).toContain('b'); // ← D-O: 输入变了, b 不许跳过
    expect(r2.results.b?.skipped).toBeFalsy();
    expect(f2.prompts.b![0]).toContain('A-CHANGED-1');
  });

  test('依赖重跑出**相同**内容 → 下游照旧跳过 (不为重跑而重跑)', async () => {
    await runExecutorDagWithPlan(plan, cfg(fake().generate, false));
    unlinkSync(join(runDir(), 'a.json'));

    const f2 = fake(); // a 再产出 'A-v1', 与上次逐字相同
    const r2 = await runExecutorDagWithPlan(plan, cfg(f2.generate, true));
    expect(f2.calls).toEqual(['a']); // b 跳过
    expect(r2.results.b?.skipped).toBe(true);
  });

  test('无依赖的根节点没有 inputHashes → 语义与从前一致 (向后兼容)', async () => {
    await runExecutorDagWithPlan(plan, cfg(fake().generate, false));
    expect(cp('a').inputHashes).toBeUndefined();
    expect(cp('b').inputHashes).toEqual({ a: expect.any(String) });
  });
});

describe('D-O CheckpointManager 单元', () => {
  const base = (over: Partial<NodeCheckpoint> = {}): NodeCheckpoint => ({
    nodeId: 'n', leafKind: 'inproc', status: 'done', outputPaths: [], artifactHashes: {},
    tokenUsage: null, summary: 's', durationMs: 1, createdAt: '2026-07-29T00:00:00Z', schemaVersion: 1,
    ...over,
  });

  test('saveNodeOutput / loadNodeOutput 往返, map 子节点 id 的 :: 被安全化', () => {
    const p = manager.saveNodeOutput(RUN, 'audit::src/x.ts', '全文内容');
    expect(p).toBeTruthy();
    expect(p!.includes('::')).toBe(false); // 文件名安全化
    expect(manager.loadNodeOutput(p!)).toBe('全文内容');
    expect(manager.loadNodeOutput(join(runDir(), 'nope.txt'))).toBeNull();
  });

  test('inputHashes 匹配 → 跳; 任一依赖内容变 / 缺席 → 不跳', () => {
    manager.saveCheckpoint(RUN, base({ inputHashes: { d1: hashText('in-1'), d2: hashText('in-2') } }));
    expect(manager.shouldSkip(RUN, 'n', undefined, { d1: 'in-1', d2: 'in-2' })).toBe(true);
    expect(manager.shouldSkip(RUN, 'n', undefined, { d1: 'in-1', d2: 'CHANGED' })).toBe(false);
    expect(manager.shouldSkip(RUN, 'n', undefined, { d1: 'in-1' })).toBe(false); // 依赖缺席也算变
  });

  test('不传 currentInputs / 老 checkpoint 无 inputHashes → 退回原语义 (向后兼容)', () => {
    manager.saveCheckpoint(RUN, base({ inputHashes: { d1: hashText('in-1') } }));
    expect(manager.shouldSkip(RUN, 'n')).toBe(true); // 调用方没给输入 → 不做输入面校验

    manager.saveCheckpoint(RUN, base({ nodeId: 'old' })); // 无 inputHashes 字段
    expect(manager.shouldSkip(RUN, 'old', undefined, { d1: '随便什么' })).toBe(true);
  });
});

describe('D-O 覆盖到 research 节点; command 节点刻意不落绿 checkpoint', () => {
  const rcPlan: ConductorPlan = {
    name: 'rc',
    nodes: {
      r: { goal: '查外部资料', executor: 'research' },
      c: { goal: '跑闸', executor: 'command', command: 'bun test' },
    },
  } as ConductorPlan;

  test('research 节点有绿 checkpoint (含全文制品) —— 它是最贵的一类, 最该被 resume 兜住', async () => {
    await runExecutorDagWithPlan(
      rcPlan,
      cfg(fake().generate, false, {
        researchRunner: async () => ({ text: '研究结论全文', sources: ['https://x.test/1'], usage: { in: 5, out: 5 } }),
        commandRunner: async () => ({ text: 'ok', usage: { in: 0, out: 0 }, timedOut: false, signal: null, exitCode: 0 }),
      }),
    );
    const r = cp('r');
    expect(r.status).toBe('done');
    expect(r.leafKind).toBe('research');
    expect(manager.loadNodeOutput(r.outputText!)).toBe('研究结论全文');
  });

  // #167 (2026-08-17) 语义翻转: command 绿 checkpoint **只当账不当闸** —— 账要诚实 (绿也落盘,
  // 否则 base 只可能 failed/skipped, run 68cfb43f 验尸把成功读成判据红), resume 不跳的性质
  // 由 shouldSkip 的 leafKind 卡保住 (专测在 src/harness/continuity/command-checkpoint.test.ts)。
  test('command 节点绿 checkpoint 在盘上 (#167: 账诚实), 且 shouldSkip 恒不跳 (闸不动)', async () => {
    await runExecutorDagWithPlan(
      rcPlan,
      cfg(fake().generate, false, {
        researchRunner: async () => ({ text: 't', sources: ['https://x.test/1'], usage: { in: 1, out: 1 } }),
        commandRunner: async () => ({ text: 'ok', usage: { in: 0, out: 0 }, timedOut: false, signal: null, exitCode: 0 }),
      }),
    );
    expect(existsSync(join(runDir(), 'c.json'))).toBe(true);
    expect(manager.shouldSkip(RUN, 'c')).toBe(false);
  });
});
