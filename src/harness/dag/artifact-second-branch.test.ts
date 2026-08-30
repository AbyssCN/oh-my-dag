/**
 * artifact-second-branch.test —— 刀① (2026-08-30 闸门三角结) 产物闸第二支 + 毒集关闸。
 *
 * 契约 verify 列 (docs/plan/2026-08-30-闸门三角结-执行契约.md 刀①), 逐条对应:
 *   T1 「上一轮真做出产物、本轮被重跑」: 改前判 empty-artifact (死循环形态), 改后第二支放行判 done,
 *      且下游不再级联 skip (run 1c9a4566 / 58df6b9e 形态回归)。
 *   T2 三种仍判死: 产物在盘上但本节点无 checkpoint (HEAD 本来就有) · checkpoint 是别的节点的 ·
 *      内容变过 (字节漂移零容差)。
 *   T3 毒集节点 checkpoint 已归档 + 拿旧产物顶 → 仍判死 (丢 checkpoint 即关闸, 不加标志位)。
 *   T4 formatter 改一字节 → 第二支不放行、节点重跑、日志有漂移证据行 ({path, was, now})。
 *   T5 head 档基线救援: 写集相对 run 基线快照有改动 → 判真写入 (刀①-2)。
 *   T6 外部干扰: 盘上哈希既非跑前值也非节点记录值 → infra 隔离, 不记 empty-artifact (刀①-6)。
 *
 * 反向自检 (手做过, 记录在此):
 *   · 把 CheckpointManager.archiveCheckpoint 改 no-op → T3 当场红 (被否决产出借第二支复活)。
 *   · 把第二支的 `now !== was` 判等改恒 false (等于容差∞) → T2c/T4 当场红。
 * 谎报完成闸 (engine.ts D-4) 一个字节未动 —— 守护是 false-completion.test.ts 全绿。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runExecutorDagWithPlan } from './engine';
import { CheckpointManager, hashArtifact } from '../continuity/checkpoint-manager';
import { setCoreLogger, type CoreLogger } from '../logger';
import type { AgentLeafRunner } from '../leaf-runners';
import type { ConductorPlan } from '../conductor-plan';
import type { ExecutorDagConfig, ExecutorDagResult, GenerateFn, PriorExec } from './types';
import type { NodeCheckpoint } from '../continuity/types';

// ── 装置 (照 artifact-gate-verdict.test 的模式) ──────────────────────────────

interface Captured { msg: string; payload: Record<string, unknown> }

const captureLogger = (): { logger: CoreLogger; lines: Captured[] } => {
  const lines: Captured[] = [];
  const push = (obj: unknown, msg?: string): void => void lines.push({ msg: msg ?? '', payload: (obj ?? {}) as Record<string, unknown> });
  return { lines, logger: { debug: () => {}, info: push, warn: push, error: push } };
};
const dumpLogger = (): CoreLogger => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} });

let execTree: string;
let ckptRoot: string;
let mgr: CheckpointManager;
const RUN_ID = 'second-branch-run';

beforeEach(() => {
  execTree = mkdtempSync(join(tmpdir(), 'omd-2nd-exec-'));
  ckptRoot = mkdtempSync(join(tmpdir(), 'omd-2nd-ckpt-'));
  mgr = new CheckpointManager(ckptRoot);
});
afterEach(() => {
  for (const p of [execTree, ckptRoot]) {
    try { rmSync(p, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

async function runPlan(opts: {
  plan: ConductorPlan;
  agentRunner: AgentLeafRunner;
  prior?: PriorExec;
  resume?: boolean;
}): Promise<{ result: ExecutorDagResult; lines: Captured[] }> {
  const cap = captureLogger();
  setCoreLogger(cap.logger);
  const generate: GenerateFn = async () => ({ text: 'unused', usage: { in: 1, out: 1 } });
  const cfg: ExecutorDagConfig = {
    conductorModel: 'test:conductor',
    leafModel: 'test:leaf',
    generate,
    agentTemplates: new Map(),
    agentRunner: opts.agentRunner,
    continuity: {
      manager: mgr,
      runId: RUN_ID,
      repoRoot: execTree,
      execRoot: execTree,
      ...(opts.resume ? { resume: true } : {}),
    },
  };
  try {
    const result = await runExecutorDagWithPlan(opts.plan, cfg, opts.prior);
    return { result, lines: cap.lines };
  } finally {
    setCoreLogger(dumpLogger());
  }
}

/** 盘上写一份文件 (建目录), 返回内容 hash。 */
function seedFile(rel: string, content: string): string {
  const abs = join(execTree, rel);
  mkdirSync(abs.slice(0, abs.lastIndexOf('/')), { recursive: true });
  writeFileSync(abs, content);
  return hashArtifact(abs)!;
}

/** 预存一份「上一轮已 done」的 checkpoint (最小字段合法形状, 与引擎写的同 schema)。 */
function seedCheckpoint(nodeId: string, hashes: Record<string, string>, extra?: Partial<NodeCheckpoint>): void {
  mgr.saveCheckpoint(RUN_ID, {
    nodeId,
    leafKind: 'agent',
    status: 'done',
    outputPaths: Object.keys(hashes),
    artifactHashes: hashes,
    tokenUsage: { in: 1, out: 1 },
    summary: '上一轮真交付',
    durationMs: 1,
    createdAt: new Date().toISOString(),
    schemaVersion: 1,
    ...extra,
  });
}

/** 只读不写的 leaf —— run 1c9a4566 那五个节点的形态 (理性行为, 不是偷懒)。 */
const readOnlyRunner: AgentLeafRunner = async () => ({
  text: '看了一眼, 活已经在盘上干完了。',
  usage: { in: 1, out: 1 },
  filesTouched: [],
  cwd: '',
});
const readOnlyIn = (tree: () => string): AgentLeafRunner => async (input) => ({ ...(await readOnlyRunner(input)), cwd: tree() });

const PLAN_W: ConductorPlan = {
  name: 'second-branch',
  nodes: { W: { goal: '改文件', executor: 'agent', output_path: 'src/a.ts' } },
};
const VALID_TS = '// 上一轮的真交付\nexport const a = 1;\n';

// ── T1 + 回归: 第二支放行, 下游不再级联 skip ─────────────────────────────────

describe('T1 上一轮真做出产物、本轮被重跑 → 第二支放行判 done', () => {
  test('★ checkpoint 哈希与盘上逐字相同 ⇒ done, filesTouched 来自 checkpoint.outputPaths', async () => {
    const h = seedFile('src/a.ts', VALID_TS);
    seedCheckpoint('W', { 'src/a.ts': h });
    const { result, lines } = await runPlan({ plan: PLAN_W, agentRunner: readOnlyIn(() => execTree) });
    expect(result.results.W!.status).toBe('done');
    expect(result.results.W!.filesTouched).toEqual(['src/a.ts']);
    expect(lines.some((l) => l.msg.startsWith('[omd/executor-dag][artifact-echo] 第二支放行'))).toBe(true);
  });

  test('★ 回归 run 1c9a4566 形态: 重跑 leaf 只读不写, 下游不再级联 skip', async () => {
    const h = seedFile('src/a.ts', VALID_TS);
    seedCheckpoint('W', { 'src/a.ts': h });
    const plan: ConductorPlan = {
      name: 'second-branch-chain',
      nodes: {
        W: { goal: '改文件', executor: 'agent', output_path: 'src/a.ts' },
        V: { goal: '复核 (只读)', executor: 'agent', output_type: 'none', depends_on: ['W'] },
      },
    };
    const { result } = await runPlan({ plan, agentRunner: readOnlyIn(() => execTree) });
    expect(result.results.W!.status).toBe('done');
    expect(result.results.V!.status).toBe('done'); // 改前这里是 dep-skip
  });
});

// ── T2 三种仍判死 ────────────────────────────────────────────────────────────

describe('T2 第二支的三种不放行', () => {
  test('★ 产物在盘上但本 run 无本节点 checkpoint (HEAD 里本来就有) ⇒ 仍判死', async () => {
    seedFile('src/a.ts', VALID_TS); // 盘上有, 但没有任何 checkpoint
    const { result } = await runPlan({ plan: PLAN_W, agentRunner: readOnlyIn(() => execTree) });
    expect(result.results.W!.status).toBe('failed');
    expect(result.results.W!.failureKind).toBe('empty-artifact');
  });

  test('★ checkpoint 是**别的节点**的 (产物被别人写的) ⇒ 仍判死', async () => {
    const h = seedFile('src/a.ts', VALID_TS);
    seedCheckpoint('X', { 'src/a.ts': h }); // X 写的, W 拿不到自己的 checkpoint
    const { result } = await runPlan({ plan: PLAN_W, agentRunner: readOnlyIn(() => execTree) });
    expect(result.results.W!.status).toBe('failed');
    expect(result.results.W!.failureKind).toBe('empty-artifact');
  });

  test('★ 内容变过 (checkpoint 哈希 ≠ 盘上) ⇒ 仍判死', async () => {
    seedFile('src/a.ts', VALID_TS);
    seedCheckpoint('W', { 'src/a.ts': 'deadbeefdeadbeef' }); // 记录值与盘上不同
    const { result, lines } = await runPlan({ plan: PLAN_W, agentRunner: readOnlyIn(() => execTree) });
    expect(result.results.W!.status).toBe('failed');
    expect(result.results.W!.failureKind).toBe('empty-artifact');
    expect(lines.some((l) => l.msg.startsWith('[omd/executor-dag][artifact-drift] 第二支不放行'))).toBe(true);
  });
});

// ── T3 毒集关闸: 丢 (归档) checkpoint 即第二支天然关闭 ───────────────────────

describe('T3 毒集节点拿旧产物顶 → 仍判死 (归档关闸, 不加标志位)', () => {
  test('★ checkpoint 已归档 ⇒ loadCheckpoint 读不到 ⇒ 第二支关闭, empty-artifact', async () => {
    const h = seedFile('src/a.ts', VALID_TS);
    seedCheckpoint('W', { 'src/a.ts': h });
    expect(mgr.archiveCheckpoint(RUN_ID, 'W')).toBe(true); // 毒集处理做的那一步
    const { result } = await runPlan({ plan: PLAN_W, agentRunner: readOnlyIn(() => execTree) });
    expect(result.results.W!.status).toBe('failed');
    expect(result.results.W!.failureKind).toBe('empty-artifact');
    // 归档而非删除: 证据仍在盘上 (`W.__r1.json`), 只是第二支不认。
    const dir = join(ckptRoot, '.omd/continuity', RUN_ID);
    expect(readdirSync(dir).some((f) => /^W\.__r\d+\.json$/.test(f))).toBe(true);
  });

  test('★ 全链: resume + prior.poisoned 命中 checkpoint 指纹 ⇒ 引擎自己归档 ⇒ 仍判死', async () => {
    const POISON_FP = 'poisoned-fp-T3';
    const h = seedFile('src/a.ts', VALID_TS);
    seedCheckpoint('W', { 'src/a.ts': h }, { fingerprint: POISON_FP });
    const prior: PriorExec = {
      plan: PLAN_W,
      results: {
        W: { id: 'W', status: 'done', kind: 'agent', output: '上一轮产出', deps: [], usage: { in: 1, out: 1 } },
      },
      poisoned: new Set([POISON_FP]),
    };
    const { result } = await runPlan({ plan: PLAN_W, agentRunner: readOnlyIn(() => execTree), prior, resume: true });
    // dropPoisonedGreens 通道⑤-b 丢内存绿 + opts.archive 归档盘上份 → 第二支读不到 → 判死。
    expect(result.results.W!.status).toBe('failed');
    expect(result.results.W!.failureKind).toBe('empty-artifact');
    const dir = join(ckptRoot, '.omd/continuity', RUN_ID);
    expect(readdirSync(dir).some((f) => /^W\.__r\d+\.json$/.test(f))).toBe(true);
    // 裁决 B: 普通否决不抹盘 —— 被否决的产物仍在盘上, 一字节不动。
    expect(hashArtifact(join(execTree, 'src/a.ts'))).toBe(h);
  });
});

// ── T4 formatter 一字节漂移: 零容差 + 证据行 ─────────────────────────────────

describe('T4 字节漂移零容差', () => {
  test('★ formatter 改一字节 ⇒ 第二支不放行 (重跑), 日志带 {path, was, now}', async () => {
    const h = seedFile('src/a.ts', VALID_TS);
    seedCheckpoint('W', { 'src/a.ts': h });
    seedFile('src/a.ts', `${VALID_TS} `); // formatter 尾部加一个空格
    const { result, lines } = await runPlan({ plan: PLAN_W, agentRunner: readOnlyIn(() => execTree) });
    expect(result.results.W!.status).toBe('failed'); // 不假绿 —— 多花钱重跑
    const drift = lines.find((l) => l.msg.startsWith('[omd/executor-dag][artifact-drift]'));
    expect(drift).toBeDefined();
    expect(drift!.payload.path).toBe('src/a.ts');
    expect(drift!.payload.was).toBe(h);
    expect(typeof drift!.payload.now).toBe('string');
    expect(drift!.payload.now).not.toBe(h);
  });
});

// ── T5 head 档基线救援 (刀①-2) ───────────────────────────────────────────────

describe('T5 head 档 run 基线 = 写集哈希快照', () => {
  test('★ 写发生在节点窗口外 (本 run 内) ⇒ 节点级快照/救援①②都看不见, head 基线判真写入 ⇒ done', async () => {
    // 场景 = 跨窗口的「本 run 已干完」: 写发生在 run 开始之后、W 的节点窗口之前 (经前置节点 N0
    // 的不可见通道) —— s1 写集核实 (节点窗口内 pre/post) 与救援①② (本窗口证据) 全都看不见,
    // 只有 run 基线快照能证明「这个 run 里写集变过」。
    seedFile('src/w.ts', '// 起跑前的旧内容\nexport {};\n');
    const plan: ConductorPlan = {
      name: 'head-rescue',
      nodes: {
        N0: { goal: '准备 (不可见通道写)', executor: 'agent', output_type: 'none' },
        // 无 output_path (绕开救援①) — declaredArtifact 由 output_type:'file' 触发。
        W: { goal: '改文件', executor: 'agent', output_type: 'file', write_set: ['src/w.ts'], depends_on: ['N0'] },
      },
    };
    const runner: AgentLeafRunner = async (input) => {
      if (input.prompt.includes('[omd leaf: N0]')) {
        writeFileSync(join(execTree, 'src/w.ts'), '// 本 run 写的新内容\nexport const w = 1;\n');
        return { text: '写好了 (引擎工具面看不见的通道)。', usage: { in: 1, out: 1 }, filesTouched: [], cwd: execTree };
      }
      return { text: '看了一眼, 活已经干完。', usage: { in: 1, out: 1 }, filesTouched: [], cwd: execTree };
    };
    const { result, lines } = await runPlan({ plan, agentRunner: runner });
    expect(result.results.W!.status).toBe('done');
    expect(result.results.W!.filesTouched).toEqual(['src/w.ts']);
    expect(lines.some((l) => l.msg.includes('head run 基线'))).toBe(true);
    // 快照 sidecar 真落了 run 目录 (证据面)。
    expect(readdirSync(join(ckptRoot, '.omd/continuity', RUN_ID)).includes('_writeset-baseline.json')).toBe(true);
  });
});

// ── T6 外部干扰分辨 (刀①-6) ──────────────────────────────────────────────────

describe('T6 盘上哈希既非跑前值也非节点记录值 → infra 隔离', () => {
  test('★ 第三方改写 ⇒ failureKind = infra-error (不烧 empty-artifact 的重试预算)', async () => {
    // 跑前值 P (进 head 基线) ≠ 节点记录值 W1 ≠ 盘上现值 F —— 三方各不同。
    seedFile('src/a.ts', '// 跑前值 P\nexport {};\n');
    const tmp = join(execTree, '.w1-probe.ts');
    writeFileSync(tmp, '// 节点上一轮写的 W1\nexport {};\n');
    const w1 = hashArtifact(tmp)!;
    rmSync(tmp);
    seedCheckpoint('W', { 'src/a.ts': w1 });
    const plan: ConductorPlan = {
      name: 'foreign',
      nodes: {
        // 第三方改写发生在 W 的节点窗口之外 (run 内, 经 N0) —— 否则节点窗口内的救援①/s1 核实
        // 会先把它认成 W 的写 (那是既有语义, 不归刀①-6 管)。
        N0: { goal: '第三方干扰', executor: 'agent', output_type: 'none' },
        W: { goal: '改文件', executor: 'agent', output_path: 'src/a.ts', write_set: ['src/a.ts'], depends_on: ['N0'] },
      },
    };
    const runner: AgentLeafRunner = async (input) => {
      if (input.prompt.includes('[omd leaf: N0]')) {
        writeFileSync(join(execTree, 'src/a.ts'), '// 第三方写的 F\nexport const f = 1;\n');
        return { text: '干扰完成。', usage: { in: 1, out: 1 }, filesTouched: [], cwd: execTree };
      }
      return { text: '只读检查。', usage: { in: 1, out: 1 }, filesTouched: [], cwd: execTree };
    };
    const { result, lines } = await runPlan({ plan, agentRunner: runner });
    expect(result.results.W!.status).toBe('failed');
    expect(result.results.W!.failureKind).toBe('infra-error');
    expect(lines.some((l) => l.msg.startsWith('[omd/executor-dag][artifact-foreign] 外部干扰'))).toBe(true);
  });
});
