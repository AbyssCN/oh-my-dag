/**
 * src/harness/dag/artifact-gate-verdict.test —— SDD s1 切片 1 进闸态判词 (2026-08-23)
 *
 * 承重事实: 产物闸今天**只在做了事时**打日志 (七条判词, 见 engine.ts:3769-3879 + 3923) ——
 * `filesTouched` 进闸就非空的节点 (最常见的一种), 闸**一个字都不说**。2026-08-23 想量
 * D-5 (「救援在正判据之后还有没有真命中过」), 四跑全 0 —— 而正确解读**不是**「命中 0 次」,
 * 是「**一个样本都没有**」。分母读不出来, 分子就没有意义。
 *
 * 本片只加判词 (D-4 INV-5: 不改任何判定条件与既有判词文案): 进闸的每一个节点打**恰好一行**
 * `logger.info`, payload 含 (node · entry · exit · verdict) 四位, 合成进闸态与最终判定 (D-1)。
 *
 * 六条 GWT (与 SDD C-1 一字对应):
 *   GWT-1 ★ 受控写工具写了产物 (entry>0), 闸放行 ⇒ 判词**恰好一条**含 `产物闸判定`,
 *          verdict = 'live', entry/exit 都非空。
 *   GWT-2 ★ leaf 什么都没写, 闸判死 (empty-artifact) ⇒ `产物校验失败` **之外**另有一条
 *          含 `产物闸判定` (entry = 0, verdict = 'dead')。两条并存, 非二选一。
 *   GWT-3 ★ **承重那一跳**: leaf 受控通道空、write_set 有声明、`sideEffect` 真改盘 ⇒ 写集核实
 *          把路径补进 filesTouched ⇒ **进闸**条数是 0、**出闸**条数 > 0
 *          (entryFilesTouched 必须在写集核实重赋值**之前**取, 而非之后)。
 *   GWT-4 ★ payload 四位齐: node · entry · exit · verdict 都在。
 *   GWT-5 ★ 既有判词条件与文案一字不动 (INV-5 承重, 见 SDD 验收闸 #4)。
 *   GWT-6 ★ output_type:'none' 节点**不打**这一行。
 *
 * 反向自检 (本片手做): 把 `engine.ts:3744` 的 `const entryFilesTouched = filesTouched.length;`
 * 改到写集核实**之后** (即直接用 `filesTouched.length` 当 entry) ⇒ GWT-3 当场红
 * (进闸条数从 0 变成 1, 出闸条数还是 1)。还原复绿 (贴改动原文 + 红的用例)。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runExecutorDagWithPlan } from './engine';
import { CheckpointManager } from '../continuity/checkpoint-manager';
import { setCoreLogger, type CoreLogger } from '../logger';
import type { AgentLeafRunner } from '../leaf-runners';
import type { ConductorPlan } from '../conductor-plan';
import type { ExecutorDagConfig, ExecutorDagResult, GenerateFn } from './types';

// ── 装置 ─────────────────────────────────────────────────────────────────────

interface Captured { msg: string; payload: Record<string, unknown> }
interface VerdictPayload { node: string; entry: number; exit: number; verdict: 'live' | 'dead' }

const captureLogger = (): { logger: CoreLogger; lines: Captured[] } => {
  const lines: Captured[] = [];
  return {
    lines,
    logger: {
      debug: () => {},
      info: (obj, msg) => lines.push({ msg: msg ?? '', payload: (obj ?? {}) as Record<string, unknown> }),
      warn: (obj, msg) => lines.push({ msg: msg ?? '', payload: (obj ?? {}) as Record<string, unknown> }),
      error: () => {},
    },
  };
};
const dumpLogger = (): CoreLogger => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} });

const VERDICT_MSG = '[omd/executor-dag][artifact-verdict] 产物闸判定 (declaredArtifact 节点; entry = 进闸条数)';
const pickMsg = (lines: Captured[], msg: string): Captured[] => lines.filter((l) => l.msg === msg);
const pickVerdict = (lines: Captured[]): VerdictPayload[] =>
  pickMsg(lines, VERDICT_MSG).map((l) => l.payload as unknown as VerdictPayload);

/** 收判词 + 跑一次 executorDag。trees 由调用方建/拆。 */
async function runWith(opts: {
  plan: ConductorPlan;
  execTree: string;
  agentRunner: AgentLeafRunner;
  repoRoot?: string;
}): Promise<{ result: ExecutorDagResult; cap: ReturnType<typeof captureLogger> }> {
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
      manager: new CheckpointManager(mkdtempSync(join(tmpdir(), 'omd-verdict-ckpt-'))),
      runId: 'verdict-run',
      repoRoot: opts.repoRoot ?? opts.execTree,
      execRoot: opts.execTree,
    },
  };
  try {
    const result = await runExecutorDagWithPlan(opts.plan, cfg);
    return { result, cap };
  } finally {
    setCoreLogger(dumpLogger());
  }
}

function makeTree(label: string, relPaths: string[]): string {
  const root = mkdtempSync(join(tmpdir(), `omd-verdict-${label}-`));
  for (const rel of relPaths) {
    const abs = join(root, rel);
    mkdirSync(abs.slice(0, abs.lastIndexOf('/')), { recursive: true });
    writeFileSync(abs, '/* pre-existing baseline */\n');
  }
  return root;
}

function rmTree(root: string): void {
  try { rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
}

// ── GWT-1 ────────────────────────────────────────────────────────────────────

describe('GWT-1 受控写工具真写了产物 (entry>0) ⇒ 恰好一条产物闸判定 (live)', () => {
  let execTree: string;
  beforeEach(() => { execTree = makeTree('gwt1', []); });
  afterEach(() => { rmTree(execTree); });

  test('★ GWT-1 闸放行 ⇒ 产物闸判定恰好一条, verdict = live, entry > 0', async () => {
    const plan: ConductorPlan = {
      name: 'verdict-gwt1',
      nodes: {
        W: {
          goal: '改文件',
          executor: 'agent',
          output_path: 'src/a.ts',
        },
      },
    };
    const { result, cap } = await runWith({
      plan,
      execTree,
      agentRunner: async () => {
        const abs = join(execTree, 'src/a.ts');
        mkdirSync(abs.slice(0, abs.lastIndexOf('/')), { recursive: true });
        writeFileSync(abs, '// gwt1 内容\n');
        return {
          text: '写好了。',
          usage: { in: 1, out: 1 },
          filesTouched: ['src/a.ts'], // 受控通道已声明, 进闸条数 = 1
          cwd: execTree,
        };
      },
    });
    expect(result.results.W!.status).toBe('done');
    // INV-1: 恰好一条
    const verdicts = pickVerdict(cap.lines);
    expect(verdicts).toHaveLength(1);
    // INV-4: 四位齐
    const p = verdicts[0]!;
    expect(p.node).toBe('W');
    expect(p.entry).toBe(1);
    expect(p.exit).toBe(1);
    expect(p.verdict).toBe('live');
  });
});

// ── GWT-2 ────────────────────────────────────────────────────────────────────

describe('GWT-2 leaf 什么都没写 ⇒ 产物校验失败**之外**另有一条产物闸判定 (dead)', () => {
  let execTree: string;
  beforeEach(() => { execTree = makeTree('gwt2', []); });
  afterEach(() => { rmTree(execTree); });

  test('★ GWT-2 entry = 0, verdict = dead, 与产物校验失败判词并存', async () => {
    const plan: ConductorPlan = {
      name: 'verdict-gwt2',
      nodes: {
        W: {
          goal: 'noop',
          executor: 'agent',
          output_path: 'src/a.ts', // 触发 declaredArtifact=true, 让闸进闸
        },
      },
    };
    const { result, cap } = await runWith({
      plan,
      execTree,
      agentRunner: async () => ({
        text: '看了一眼, 不用改。',
        usage: { in: 1, out: 1 },
        filesTouched: [], // 受控通道空 + 无 sideEffect + 无 write_set ⇒ 闸判死
        cwd: execTree,
      }),
    });
    // 终态不变 —— R-1 改的是**尝试次数**, 不是判定。
    expect(result.results.W!.status).toBe('failed');
    expect(result.results.W!.failureKind).toBe('empty-artifact');
    // INV-2: 两条并存, 非二选一。
    //
    // ⚠ R-1 (2026-08-30) 之后这里是**每次尝试各一条**, 不再是全程各一条:
    // `empty-artifact` 进了 `REPAIRABLE_BY_CAUSE` 白名单 (retry-domain.ts) ⇒ 该节点拿到
    // 一次**带败因**的重修。本用例的假 runner 恒返 `filesTouched: []`, 所以两次都判死。
    // 原来写死 `toHaveLength(1)` 是把「判词恰好一条」与「只跑一次」耦在了一起 ——
    // 前者是本片真正要守的不变量 (INV-1「进闸的每一个节点打恰好一行」), 后者是重试策略,
    // 不该由产物闸这一片来钉。所以判据改成**两者条数相等且逐条判死**, 不是放宽成 ">=1"。
    const failMsgs = pickMsg(cap.lines, '[omd/executor-dag][artifact-empty] 产物校验失败 → 节点 failed (拒绝 empty-done)');
    const verdicts = pickVerdict(cap.lines);
    expect(verdicts.length).toBe(failMsgs.length); // 每一次进闸: 校验失败一条 ⇔ 判定一条
    expect(verdicts).toHaveLength(2); // 首发 + R-1 的那一次带败因重修
    // 判死的 payload —— **每一条**都要齐, 不是只看第一条 (只看第一条会漏掉重修那次的漂移)
    for (const p of verdicts) {
      expect(p.node).toBe('W');
      expect(p.entry).toBe(0);
      expect(p.exit).toBe(0);
      expect(p.verdict).toBe('dead');
    }
  });
});

// ── GWT-3 · 承重 ─────────────────────────────────────────────────────────────

describe('GWT-3 ★ 承重: entry 取自进闸态 (写集核实重赋值之前), 出闸条数 > 进闸条数', () => {
  let execTree: string;
  beforeEach(() => { execTree = makeTree('gwt3', ['src/a.ts']); }); // a.ts 起跑前**已存在**
  afterEach(() => { rmTree(execTree); });

  test('★ GWT-3 修前必红: entry = 0 (受控通道空), exit > 0 (写集核实把 a.ts 补回来)', async () => {
    const plan: ConductorPlan = {
      name: 'verdict-gwt3',
      nodes: {
        W: {
          goal: '改文件',
          executor: 'agent',
          output_path: 'src/a.ts',
          write_set: ['src/a.ts'], // ★ 关键: 触发写集核实 (engine.ts:3759)
        },
      },
    };
    const { result, cap } = await runWith({
      plan,
      execTree,
      agentRunner: async () => {
        // 关键三件: (1) 受控通道**空** (filesTouched = []) ⇒ 进闸条数 = 0
        //          (2) sideEffect 真改了 src/a.ts ⇒ 跑前跑后哈希**不等**
        //          (3) shellRunText 不含字面路径 ⇒ 救援② 不救;也不依赖救援①③
        const abs = join(execTree, 'src/a.ts');
        mkdirSync(abs.slice(0, abs.lastIndexOf('/')), { recursive: true });
        writeFileSync(abs, '// 新内容\n');
        return {
          text: '用 bash 写的。',
          usage: { in: 1, out: 1 },
          filesTouched: [], // (1)
          cwd: execTree,
          shellRuns: [{ command: 'bash /tmp/script.sh', exitCode: 0, ok: true }], // (3)
        };
      },
    });
    // 进闸态空, 出闸态非空: 写集核实命中 (line 3773 `filesTouched = verified`),
    // 闸放行 ⇒ 节点 done, filesTouched 来自写集核实的补值。
    expect(result.results.W!.status).toBe('done');
    expect(result.results.W!.filesTouched).toEqual(['src/a.ts']);
    // 验证写集核实在判词里也露脸 (证实它跑了 —— 闸是按这个补出 exit=1 的)
    expect(pickMsg(cap.lines, '[omd/executor-dag] 按写集核实判真写入 (不问谁写的; s1 写集核实正判据)')).toHaveLength(1);
    // ★ 承重那一跳: entry 必须是进闸态 (写集核实改写 filesTouched **之前**), 不是出闸态。
    // 反证: 把 entryFilesTouched = filesTouched.length 挪到写集核实**之后**, 此断言立即红。
    const verdicts = pickVerdict(cap.lines);
    expect(verdicts).toHaveLength(1);
    const p = verdicts[0]!;
    expect(p.node).toBe('W');
    expect(p.entry).toBe(0);    // ★ 进闸态: 受控通道空
    expect(p.exit).toBeGreaterThan(0);  // ★ 出闸态: 写集核实补了一条
    expect(p.verdict).toBe('live');
  });
});

// ── GWT-4 ────────────────────────────────────────────────────────────────────

describe('GWT-4 payload 四位齐 (node · entry · exit · verdict) 都在', () => {
  let execTree: string;
  beforeEach(() => { execTree = makeTree('gwt4', []); });
  afterEach(() => { rmTree(execTree); });

  test('★ GWT-4 INV-4 承重: payload 字段全, 类型对', async () => {
    const plan: ConductorPlan = {
      name: 'verdict-gwt4',
      nodes: {
        W: {
          goal: 'noop',
          executor: 'agent',
          output_path: 'src/a.ts',
        },
      },
    };
    const { result, cap } = await runWith({
      plan,
      execTree,
      agentRunner: async () => {
        // 真把文件写进盘, 别让 missing 把它判死 —— 本片验的是 live 那条 payload, 不是 dead。
        const abs = join(execTree, 'src/a.ts');
        mkdirSync(abs.slice(0, abs.lastIndexOf('/')), { recursive: true });
        writeFileSync(abs, '// gwt4 内容\n');
        return {
          text: '看一眼。',
          usage: { in: 1, out: 1 },
          filesTouched: ['src/a.ts'], // entry > 0, 闸放行, 验 live 那条
          cwd: execTree,
        };
      },
    });
    expect(result.results.W!.status).toBe('done');
    const verdicts = pickVerdict(cap.lines);
    expect(verdicts).toHaveLength(1);
    const p = verdicts[0]!;
    // 四位都必须在
    expect(typeof p.node).toBe('string');
    expect(typeof p.entry).toBe('number');
    expect(typeof p.exit).toBe('number');
    expect(['live', 'dead']).toContain(p.verdict);
    // 节点 id 正确
    expect(p.node).toBe('W');
    // verdict 是 live (受控通道有产物)
    expect(p.verdict).toBe('live');
  });
});

// ── GWT-6 ────────────────────────────────────────────────────────────────────

describe('GWT-6 output_type:none 节点不打产物闸判定 (零影响)', () => {
  let execTree: string;
  beforeEach(() => { execTree = makeTree('gwt6', []); });
  afterEach(() => { rmTree(execTree); });

  test('★ GWT-6 INV-6 承重: declaredArtifact = false ⇒ 闸不跑 ⇒ 判词缺席', async () => {
    const plan: ConductorPlan = {
      name: 'verdict-gwt6',
      nodes: {
        V: {
          // 关键: output_type:'none' 且无 output_path ⇒ declaredArtifact=false (engine.ts:3464)
          // goal 也不含写信号 ⇒ producesFiles=false (engine.ts:3441)
          goal: 'verify a value without touching files',
          executor: 'agent',
          output_type: 'none',
        },
      },
    };
    const { result, cap } = await runWith({
      plan,
      execTree,
      agentRunner: async () => ({
        text: '看了一眼, 没问题。',
        usage: { in: 1, out: 1 },
        filesTouched: [],
        cwd: execTree,
      }),
    });
    // 非产物节点, 闸完全跳过 ⇒ 节点 done, 零产物闸判定
    expect(result.results.V!.status).toBe('done');
    expect(pickVerdict(cap.lines)).toEqual([]);
  });
});

// ── GWT-5 既有的四道闸条件/文案一字不动 (INV-5, 见 SDD 验收 #4) ────────────
//
// 这一条自身**不**写: 守护类是同包的四道既有测试 (writeset-primary/rescue-anchor/artifact-scope/writeset-evidence),
// 在 SDD 验收闸 #4 里跑, 这一行注只钉意图。
//
// 如果它们将来红了, 那是**判定面**被动了 (D-4 INV-5 破), 立刻回来修本片判词 ——
// 而不是改判据去让它绿。
