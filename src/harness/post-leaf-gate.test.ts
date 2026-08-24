/**
 * post-leaf-gate 三态语义 + PP-S01 装配闸 回归测试。
 *
 * 覆盖 INV-13 (skill manifest checks[] → 必须有对应 PostLeafGate 节点) 与 INV-16 (三态:
 * OK / FAIL / UNVERIFIED 互不相等, oracle-fault 每发一次 +1 且留栈)。`gateWriteAuthority` 单独
 * 抽函数覆盖, 防止 leaf "修一下脚本" 这种隐蔽篡改 oracle 行为的手法。
 *
 * 临时脚本与临时目录一律 `mkdtemp` 在系统 tmp 目录, 不落仓不污染 fixture。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { evaluatePostLeaf, gateWriteAuthority } from './post-leaf-gate';
import type { GateFs, GateSpawn, PostLeafGateInput, WriteActor, WriteAuthorityVerdict } from './post-leaf-gate';

import { runPlanDryRun } from './plan-dry-run';
import type { PipelineStage } from './plan-dry-run';

// ─── 测试用临时目录 (系统 tmp, 每个测试独立 setup/teardown) ─────────────────

let tmpRoots: string[] = [];

async function newTmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'omd-post-leaf-gate-'));
  tmpRoots.push(dir);
  return dir;
}

beforeEach(() => {
  tmpRoots = [];
});

afterEach(async () => {
  await Promise.all(
    tmpRoots.map(async (d) => {
      try {
        await rm(d, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }),
  );
});

// ─── 替身: 文件系统 (造 0 字节产物测 artifact_unfinished) ─────────────────────

function makeFs(overrides: Partial<GateFs> = {}): GateFs {
  return {
    existsSync: overrides.existsSync ?? (() => true),
    statSync:
      overrides.statSync ??
      (() => {
        throw new Error('statSync not stubbed');
      }),
  };
}

// ─── 替身: spawn (三态 + 错误注入, 按需返 exit/timedOut/throw) ──────────────

function makeSpawn(
  behavior: (
    cmd: string,
    cwd: string,
    timeoutMs?: number,
  ) => Promise<{ stdout: string; stderr: string; exitCode: number | null; timedOut?: boolean; signal?: string | null }>,
): GateSpawn {
  return (cmd, cwd, timeoutMs) => behavior(cmd, cwd, timeoutMs);
}

const fixedNow = () => new Date('2026-01-01T00:00:00.000Z');

// ─── ① 三态主入口 evaluatePostLeaf ─────────────────────────────────────────

describe('evaluatePostLeaf / 三态语义 (INV-16)', () => {
  test('exit 0 → OK (reason=ok, oracleFaults=0, evaluatedAt ISO)', async () => {
    const tmp = await newTmp();
    const scriptPath = join(tmp, 'ok.sh');
    await writeFile(scriptPath, '#!/bin/sh\nexit 0\n');

    const r = await evaluatePostLeaf({
      artifact: { nodeId: 'n1' },
      scriptPath,
      checksRoot: tmp,
      spawn: makeSpawn(async () => ({ stdout: 'all good', stderr: '', exitCode: 0 })),
      now: fixedNow,
    });

    expect(r.verdict).toBe('OK');
    expect(r.reason).toBe('ok');
    expect(r.oracleFaults).toBe(0);
    expect(r.evidence).toBe('all good');
    expect(r.evaluatedAt).toBe('2026-01-01T00:00:00.000Z');
  });

  test('exit 非 0 → FAIL (reason=exit_<code>)', async () => {
    const tmp = await newTmp();
    const scriptPath = join(tmp, 'fail.sh');
    await writeFile(scriptPath, '#!/bin/sh\nexit 1\n');

    const r = await evaluatePostLeaf({
      artifact: { nodeId: 'n1' },
      scriptPath,
      checksRoot: tmp,
      spawn: makeSpawn(async () => ({ stdout: '', stderr: 'oops', exitCode: 1 })),
    });

    expect(r.verdict).toBe('FAIL');
    expect(r.reason).toBe('exit_1');
    expect(r.oracleFaults).toBe(0);
    expect(r.evidence).toBe('oops');
  });

  test('exit 非 0 = null (被信号杀掉) → FAIL (reason=exit_null)', async () => {
    const tmp = await newTmp();
    const scriptPath = join(tmp, 'killed.sh');
    await writeFile(scriptPath, '#!/bin/sh\n');

    const r = await evaluatePostLeaf({
      artifact: { nodeId: 'n1' },
      scriptPath,
      checksRoot: tmp,
      spawn: makeSpawn(async () => ({ stdout: '', stderr: 'killed', exitCode: null, signal: 'SIGKILL' })),
    });

    expect(r.verdict).toBe('FAIL');
    expect(r.reason).toBe('exit_null');
    expect(r.oracleFaults).toBe(0);
  });

  // ── UNVERIFIED 触发路径 1: 脚本缺失 ──
  test('script missing → UNVERIFIED (reason=script_missing, 路径原文进 evidence)', async () => {
    const tmp = await newTmp();
    // 注意: 不写 scriptPath 这个文件, existsSync → false
    const scriptPath = join(tmp, 'absent.sh');

    const r = await evaluatePostLeaf({
      artifact: { nodeId: 'n1' },
      scriptPath,
      checksRoot: tmp,
      // spawn 不该被调到; 提供也无害, 用于断言 "脚本缺失" 在 spawn 之前拦
      spawn: makeSpawn(async () => {
        throw new Error('spawn should not have been called');
      }),
    });

    expect(r.verdict).toBe('UNVERIFIED');
    expect(r.reason).toBe('script_missing');
    expect(r.oracleFaults).toBe(1);
    expect(r.evidence).toContain(scriptPath);
  });

  // ── UNVERIFIED 触发路径 2: 脚本抛异常 ──
  test('script throws → UNVERIFIED (reason=script_threw, evidence 含异常栈原文)', async () => {
    const tmp = await newTmp();
    const scriptPath = join(tmp, 'throw.sh');
    await writeFile(scriptPath, '#!/bin/sh\n');

    const stackText = 'FakeStack: boom\n    at <anonymous>:1:1\n    at spawn';
    function makeFakeStack(): Error {
      const e = new Error('boom');
      e.name = 'FakeStack';
      (e as Error & { stack: string }).stack = stackText;
      return e;
    }

    const r = await evaluatePostLeaf({
      artifact: { nodeId: 'n1' },
      scriptPath,
      checksRoot: tmp,
      spawn: makeSpawn(async () => {
        throw makeFakeStack();
      }),
    });

    expect(r.verdict).toBe('UNVERIFIED');
    expect(r.reason).toBe('script_threw');
    expect(r.oracleFaults).toBe(1);
    // evidence 必须含栈原文 (含 stack 字段或非空字符串) —— 排账的唯一依据
    expect(typeof r.evidence).toBe('string');
    expect((r.evidence as string).length).toBeGreaterThan(0);
    expect(r.evidence).toContain('FakeStack: boom');
    expect(r.evidence).toContain('at spawn');
  });

  // ── UNVERIFIED 触发路径 3: 脚本超时 ──
  test('script timeout → UNVERIFIED (reason=script_timeout, evidence 含超时预算)', async () => {
    const tmp = await newTmp();
    const scriptPath = join(tmp, 'slow.sh');
    await writeFile(scriptPath, '#!/bin/sh\n');

    const r = await evaluatePostLeaf({
      artifact: { nodeId: 'n1' },
      scriptPath,
      checksRoot: tmp,
      timeoutMs: 1234,
      spawn: makeSpawn(async () => ({
        stdout: 'partial-stdout-a-lot-of-bytes-here-...',
        stderr: '',
        exitCode: null,
        timedOut: true,
      })),
    });

    expect(r.verdict).toBe('UNVERIFIED');
    expect(r.reason).toBe('script_timeout');
    expect(r.oracleFaults).toBe(1);
    expect(r.evidence).toContain('1234ms');
  });

  // ── UNVERIFIED 触发路径 4a: 产物未写完 (size=0) ──
  test('artifact empty (size=0) → UNVERIFIED (reason=artifact_unfinished)', async () => {
    const tmp = await newTmp();
    const scriptPath = join(tmp, 'check.sh');
    await writeFile(scriptPath, '#!/bin/sh\n');
    const artifactPath = join(tmp, 'leaf-out.json');

    const r = await evaluatePostLeaf({
      artifact: { nodeId: 'n1' },
      scriptPath,
      checksRoot: tmp,
      artifactPath,
      fs: makeFs({ statSync: () => ({ size: 0 }) }),
      // spawn 不该被调到 (artifact 检查在 spawn 前)
      spawn: makeSpawn(async () => {
        throw new Error('spawn should not have been called for 0-byte artifact');
      }),
    });

    expect(r.verdict).toBe('UNVERIFIED');
    expect(r.reason).toBe('artifact_unfinished');
    expect(r.oracleFaults).toBe(1);
    expect(r.evidence).toContain(artifactPath);
    expect(r.evidence).toContain('0 bytes');
  });

  // ── UNVERIFIED 触发路径 4b: stat 抛异常 (文件被删 / 锁) ──
  test('artifact stat error → UNVERIFIED (evidence 含 stat 失败原文)', async () => {
    const tmp = await newTmp();
    const scriptPath = join(tmp, 'check.sh');
    await writeFile(scriptPath, '#!/bin/sh\n');
    const artifactPath = join(tmp, 'vanished.json');

    const r = await evaluatePostLeaf({
      artifact: { nodeId: 'n1' },
      scriptPath,
      checksRoot: tmp,
      artifactPath,
      fs: makeFs({
        statSync: () => {
          throw new Error('ENOENT: vanished mid-flight');
        },
      }),
    });

    expect(r.verdict).toBe('UNVERIFIED');
    expect(r.reason).toBe('artifact_unfinished');
    expect(r.oracleFaults).toBe(1);
    expect(r.evidence).toContain(artifactPath);
    expect(r.evidence).toContain('ENOENT: vanished mid-flight');
  });

  // ── 注入缺失: 没有 spawn → UNVERIFIED ──
  test('spawn 未注入 → UNVERIFIED (reason=script_threw, evidence 解释为何不能默绿)', async () => {
    const tmp = await newTmp();
    const scriptPath = join(tmp, 'any.sh');
    await writeFile(scriptPath, '#!/bin/sh\n');

    const r = await evaluatePostLeaf({
      artifact: { nodeId: 'n1' },
      scriptPath,
      checksRoot: tmp,
      // 注意: 不传 spawn
    });

    expect(r.verdict).toBe('UNVERIFIED');
    expect(r.reason).toBe('script_threw');
    expect(r.oracleFaults).toBe(1);
    expect(r.evidence).toContain('spawn is not injected');
  });
});

// ─── ② 三态互不相等 (穷举 6 对, 不许压成 boolean) ─────────────────────────

describe('evaluatePostLeaf / 三态互不相等 (INV-16, 穷举)', () => {
  const tmp = join(tmpdir(), 'omd-three-state-eq');
  let scriptPath: string;

  async function runWith(scriptExists: boolean, behavior?: GateSpawn): Promise<ReturnType<typeof evaluatePostLeaf>> {
    const fs = makeFs({
      existsSync: () => scriptExists,
      statSync: () => ({ size: 100 }), // 默认非空, 不触发 artifact_unfinished
    });
    const base: PostLeafGateInput = {
      artifact: { nodeId: 'n1' },
      scriptPath: join(tmp, 's.sh'),
      checksRoot: tmp,
      fs,
    };
    if (behavior) base.spawn = behavior;
    return evaluatePostLeaf(base);
  }

  beforeEach(async () => {
    await mkdir(tmp, { recursive: true });
    scriptPath = join(tmp, 's.sh');
  });

  test('OK ≠ FAIL ≠ UNVERIFIED (穷举 6 对不等)', async () => {
    const ok = await runWith(true, makeSpawn(async () => ({ stdout: '', stderr: '', exitCode: 0 })));
    const fail = await runWith(true, makeSpawn(async () => ({ stdout: '', stderr: '', exitCode: 1 })));
    const unver = await runWith(false); // 脚本缺失 → UNVERIFIED

    expect(ok.verdict).toBe('OK');
    expect(fail.verdict).toBe('FAIL');
    expect(unver.verdict).toBe('UNVERIFIED');

    // 穷举 3×3=9 对, 去掉对角 3 对 = 6 对不等断言
    const states = [ok.verdict, fail.verdict, unver.verdict];
    for (let i = 0; i < states.length; i++) {
      for (let j = 0; j < states.length; j++) {
        if (i === j) continue;
        expect(states[i]).not.toBe(states[j]);
      }
    }

    // 三态字符串字面量必须就是字面 (不许 boolean / 数字 / 别名)
    expect(typeof ok.verdict).toBe('string');
    expect(typeof fail.verdict).toBe('string');
    expect(typeof unver.verdict).toBe('string');
  });
});

// ─── ③ oracle-fault 计数 + 异常栈记录 ───────────────────────────────────────

describe('evaluatePostLeaf / oracleFaults 累计 + 异常栈留痕 (INV-16)', () => {
  test('每种 UNVERIFIED 路径 oracleFaults 精确 = 1 (未被默默吞)', async () => {
    const tmp = await newTmp();
    const scriptPath = join(tmp, 'check.sh');
    await writeFile(scriptPath, '#!/bin/sh\n');

    const baseArgs = { artifact: { nodeId: 'n' }, scriptPath, checksRoot: tmp };

    // 路径 1: script_missing
    const r1 = await evaluatePostLeaf({
      ...baseArgs,
      scriptPath: join(tmp, 'ghost.sh'),
    });
    expect(r1.oracleFaults).toBe(1);

    // 路径 2: script_threw
    const r2 = await evaluatePostLeaf({
      ...baseArgs,
      spawn: makeSpawn(async () => {
        throw new Error('kapow');
      }),
    });
    expect(r2.oracleFaults).toBe(1);
    expect(r2.evidence).toContain('kapow');

    // 路径 3: script_timeout
    const r3 = await evaluatePostLeaf({
      ...baseArgs,
      spawn: makeSpawn(async () => ({ stdout: 'p', stderr: '', exitCode: null, timedOut: true })),
    });
    expect(r3.oracleFaults).toBe(1);

    // 路径 4: artifact_unfinished
    const r4 = await evaluatePostLeaf({
      ...baseArgs,
      artifactPath: join(tmp, 'partial.json'),
      fs: makeFs({ statSync: () => ({ size: 0 }) }),
    });
    expect(r4.oracleFaults).toBe(1);
  });

  test('OK / FAIL 路径 oracleFaults 必为 0 (语义分界不能糊)', async () => {
    const tmp = await newTmp();
    const scriptPath = join(tmp, 'check.sh');
    await writeFile(scriptPath, '#!/bin/sh\n');

    const ok = await evaluatePostLeaf({
      artifact: { nodeId: 'n' },
      scriptPath,
      checksRoot: tmp,
      spawn: makeSpawn(async () => ({ stdout: '', stderr: '', exitCode: 0 })),
    });
    expect(ok.verdict).toBe('OK');
    expect(ok.oracleFaults).toBe(0);

    const fail = await evaluatePostLeaf({
      artifact: { nodeId: 'n' },
      scriptPath,
      checksRoot: tmp,
      spawn: makeSpawn(async () => ({ stdout: '', stderr: 'nope', exitCode: 7 })),
    });
    expect(fail.verdict).toBe('FAIL');
    expect(fail.oracleFaults).toBe(0);
  });

  test('异常栈原文保留 (不 strip 不截断) — 给定多层 stack 含函数名', async () => {
    const tmp = await newTmp();
    const scriptPath = join(tmp, 'check.sh');
    await writeFile(scriptPath, '#!/bin/sh\n');

    const sentinel = 'STACK_SENTINEL_X9Q7_2026';
    const r = await evaluatePostLeaf({
      artifact: { nodeId: 'n' },
      scriptPath,
      checksRoot: tmp,
      spawn: makeSpawn(async () => {
        const e = new Error('inner-failure');
        (e as Error & { stack: string }).stack = `InnerError: inner-failure\n    at ${sentinel}\n    at spawn`;
        throw e;
      }),
    });

    expect(r.verdict).toBe('UNVERIFIED');
    expect(r.oracleFaults).toBe(1);
    // 栈原文完整保留 (evidence 是非空字符串)
    expect(typeof r.evidence).toBe('string');
    expect(r.evidence!.length).toBeGreaterThan(0);
    expect(r.evidence).toContain(sentinel);
    expect(r.evidence).toContain('InnerError: inner-failure');
  });
});

// ─── ④ checks/ 目录写权 (INV-I9) ───────────────────────────────────────────

describe('gateWriteAuthority / checks/ 写权判定 (INV-I9, 引擎独占)', () => {
  const checksRoot = '/tmp/omd-fake-checks-root';
  const insideA = '/tmp/omd-fake-checks-root/foo.sh';
  const insideB = '/tmp/omd-fake-checks-root/sub/bar.sh';
  const outsideC = '/var/tmp/leaf-tmp/x.json';

  const actors: WriteActor[] = ['engine', 'leaf', 'conductor', 'verifier'];

  test('checks/ 内: 只有 engine 允许, 其余三角色一律拒', () => {
    for (const path of [insideA, insideB]) {
      // engine → allowed:true, 无 reason (本闸通过)
      const eng = gateWriteAuthority('engine', path, checksRoot);
      expect(eng.allowed).toBe(true);
      expect(eng.reason).toBeUndefined();

      // 其余三角色 → allowed:false, reason 必填且含 INV-I9 + actor + root
      for (const actor of ['leaf', 'conductor', 'verifier'] as const) {
        const v: WriteAuthorityVerdict = gateWriteAuthority(actor, path, checksRoot);
        expect(v.allowed).toBe(false);
        expect(typeof v.reason).toBe('string');
        expect(v.reason!.length).toBeGreaterThan(0);
        expect(v.reason).toContain('INV-I9');
        expect(v.reason).toContain(actor);
        expect(v.reason).toContain(checksRoot);
      }
    }
  });

  test('checks/ 外: 任何 actor 都 allowed:true (本闸不适用, reason 解释归属)', () => {
    for (const actor of actors) {
      const v = gateWriteAuthority(actor, outsideC, checksRoot);
      expect(v.allowed).toBe(true);
      // reason 应明示本闸不适用 —— 由其他写权策略管
      expect(typeof v.reason).toBe('string');
      expect(v.reason).toContain('gateWriteAuthority');
      expect(v.reason).toContain(checksRoot);
    }
  });

  test('checks/ 根本身 (path === root) 走同一规则 (边界)', () => {
    const eng = gateWriteAuthority('engine', checksRoot, checksRoot);
    expect(eng.allowed).toBe(true);

    const leaf = gateWriteAuthority('leaf', checksRoot, checksRoot);
    expect(leaf.allowed).toBe(false);
    expect(leaf.reason).toContain('INV-I9');
  });

  test('根尾斜杠规范化 (checksRoot="/x/" 与 "/x" 等价)', () => {
    const v = gateWriteAuthority('leaf', '/x/foo.sh', '/x/');
    expect(v.allowed).toBe(false);
    expect(v.reason).toContain('/x'); // 规范化后 root 显示不带尾斜杠
  });

  test('前缀碰撞保护: "/x-other/foo.sh" 不被误判为 "/x" 内', () => {
    // 即 "prefix-match" 必须用 "/" 边界, 不是 startsWith 字面
    const v = gateWriteAuthority('leaf', '/x-other/foo.sh', '/x');
    expect(v.allowed).toBe(true);
    expect(v.reason).toContain('不在 checks/ 内');
  });
});

// ─── ⑤ INV-13: skill manifest checks[] → plan 必须有对应 PostLeafGate ───────

describe('PP-S01 / skill manifest checks[] 装配闸 (INV-13)', () => {
  // 工具: 写一个最小但合法的 skill 目录 (manifest.json + SKILL.md)
  // 返回的是 skillDir 的**父目录** —— runPlanDryRun 把 opts.skillDir 当 listSkills 的根,
  // listSkills 读它的子目录 (每个子目录 = 一个 skill)。
  async function writeSkill(skillId: string, checkNames: string[]): Promise<string> {
    const root = await newTmp();
    const skillDir = join(root, skillId);
    await mkdir(skillDir, { recursive: true });
    const manifest = {
      skill_id: skillId,
      skill_version: '1.0.0',
      description: 'test skill',
      body_ref: 'SKILL.md',
      checks: checkNames.map((n) => ({
        name: n,
        type: 'script',
        pass_rule: 'exit 0',
        timeout_sec: 30,
      })),
      red_lines: [],
      allowed_tools: [],
      schema_version: '1.0',
    };
    await writeFile(join(skillDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
    await writeFile(join(skillDir, 'SKILL.md'), '# clean skill\nno banned phrases.\n');
    return root;
  }

  // 工具: 写一个能跑通的最小 leaf-only plan (避免其它 PP-* 干扰断言)
  // 单 leaf 节点 + 空 toolRefs, 走默认 working-set, 不触发 bootstrap / oracle / tool-resolve 噪声。
  function leafPlan(name: string, nodeId: string, goal = 'do thing'): string {
    return JSON.stringify({
      name,
      schema_version: '1.0',
      suppressions: [],
      outputs: [nodeId],
      nodes: {
        [nodeId]: {
          executor: 'leaf',
          goal,
          toolRefs: [],
          oracleKind: 'judge',
          whyNoFanout: 'singleton',
          budgetBasis: {
            calls: 1,
            tokensIn: 0,
            tokensOut: 0,
            costUsdCeiling: 0.01,
            estimatedBy: 'test:post-leaf',
          },
        },
      },
    });
  }

  // 工具: 写一个带 PostLeafGate 节点的 plan (command executor + command 串含 checkName)
  function planWithPostLeafGate(name: string, leafId: string, gateId: string, checkName: string): string {
    return JSON.stringify({
      name,
      schema_version: '1.0',
      suppressions: [],
      outputs: [leafId],
      nodes: {
        [leafId]: {
          executor: 'leaf',
          goal: 'leaf work',
          toolRefs: [],
          oracleKind: 'judge',
          whyNoFanout: 'singleton',
          budgetBasis: {
            calls: 1,
            tokensIn: 0,
            tokensOut: 0,
            costUsdCeiling: 0.01,
            estimatedBy: 'test:post-leaf',
          },
        },
        [gateId]: {
          executor: 'command',
          command: `sh ${checkName}`,
          expect_exit: 0,
          toolRefs: [],
          oracleKind: 'cheap',
          whyNoFanout: 'oracle gate',
          budgetBasis: {
            calls: 1,
            tokensIn: 0,
            tokensOut: 0,
            costUsdCeiling: 0.01,
            estimatedBy: 'test:post-leaf-gate',
          },
          depends_on: [leafId],
        },
      },
    });
  }

  test('plan 缺 PostLeafGate → PP-S01 触发, evidence 含脚本名, stage=skill-gate', async () => {
    const skillDir = await writeSkill('oracle-holder', ['unique-check-name-X.sh']);
    const planText = leafPlan('p-no-gate', 'leaf1');

    const r = await runPlanDryRun({ kind: 'text', planText }, { skillDir });

    // 取装配期 skill-gate 阶段的原版 PP-S01 (critic 循环会把同一码以 stage='cycle' 再发一次,
    // 那是 plan-dry-run 自身的 critic 行为, 不是本测试要验的装配闸)。
    const ppS01 = r.diagnostics.filter(
      (d) => d.code === 'PP-S01' && d.stage === ('skill-gate' satisfies PipelineStage),
    );
    expect(ppS01.length).toBe(1);
    expect(ppS01[0]!.check).toBe('skill_check_unattached');
    expect(ppS01[0]!.evidence).toContain('unique-check-name-X.sh');
    expect(ppS01[0]!.remediation).toContain('PostLeafGate');

    // stderrLines 同步出现 PP-S01 (INV-21 一线一格式)
    const stderrHas = r.stderrLines.some((s) => s.startsWith('PP-S01 ') && s.includes('unique-check-name-X.sh'));
    expect(stderrHas).toBe(true);
  });

  test('plan 含 PostLeafGate (command 含脚本名) → 不触发 PP-S01', async () => {
    const checkName = 'attached-check-Y.sh';
    const skillDir = await writeSkill('oracle-holder-2', [checkName]);
    const planText = planWithPostLeafGate('p-with-gate', 'leaf1', 'gate1', checkName);

    const r = await runPlanDryRun({ kind: 'text', planText }, { skillDir });

    // 装配期 skill-gate 阶段不应报 PP-S01 (下游 critic 阶段可能因其它原因报, 与本闸无关)。
    const ppS01 = r.diagnostics.filter(
      (d) => d.code === 'PP-S01' && d.stage === ('skill-gate' satisfies PipelineStage),
    );
    expect(ppS01.length).toBe(0);
  });

  test('多条 checks 全部缺 gate → 逐条报 PP-S01, evidence 各自带名', async () => {
    const checks = ['one.sh', 'two.sh', 'three.sh'];
    const skillDir = await writeSkill('multi-check-holder', checks);
    const planText = leafPlan('p-multi', 'l1');

    const r = await runPlanDryRun({ kind: 'text', planText }, { skillDir });

    const ppS01 = r.diagnostics.filter(
      (d) => d.code === 'PP-S01' && d.stage === ('skill-gate' satisfies PipelineStage),
    );
    expect(ppS01.length).toBe(checks.length);
    const names = ppS01.map((d) => d.evidence[0]).sort();
    expect(names).toEqual([...checks].sort());
  });
});