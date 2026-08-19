/**
 * test/core/session-continuity-trigger —— #206 **触发器**闸(`scripts/session-continuity-hook.ts`
 * + `src/harness/session/continuity-hook.ts`)。
 *
 * ⚠ 别与 `session-continuity-hook.test.ts` 混:那份钉的是**冻结决策器**
 * (`docs/examples/.../session-continuity.ts` 的 `evaluateSessionContinuityStop`,只出 block 决策);
 * 本份钉的是**真派 writer 的那条**。两个入口同时存在、互斥安装,所以测试也分两份。
 *
 * 这条链此前断在「没有任何东西会自动调 writer」上,而断点**两侧各自都是绿的**:
 * 冻结决策器有测试、writer 有测试、sink 有测试,中间那一格没有被试过。所以本件钉的是**接缝**:
 *   - A1 端到端:真喂一次 hook → 库里出现 `namespace='continuity'` 行(`--mechanical`,零模型调用);
 *   - A2 **写读同库**:读面用 MCP 生产装配(`createDefaultMemory`)读得回;
 *   - A3 触发 policy:跨档一次性 / 同档不重复 / 守卫 / PreCompact;
 *   - A4 路径三处同源(`sessionDirOf` === `appendLedger` 的 ledgerPath 目录);
 *   - A5 fail-open:坏输入 exit 0、零写入。
 *
 * 反向自检(逐条实测红过,不是"应该会红"):
 *   - A1 摘掉薄壳里的 `spawn` 那一行 → 库里零行;
 *   - A2 把 `createDefaultMemory` 换回 `UNIVERSAL_SAFEGUARD` → 读面恒空。**这条是实装缺陷的现场**:
 *     读路也走 `safeguard.schema.parse`,universal 装配没有 continuity 分支 ⇒ parse 抛 ⇒
 *     `listCheckpoints` 的 `catch` 吞成 `[]`。本件下方「读面装配」那组把这一对钉死;
 *   - A3「同档延续」与「跨档」互为反面:把判定的 `>` 改成 `>=` → 同档那条红;
 *   - A4 把 `sessionDirOf` 的 `dataPath` 换成裸 `.omd` → 与 ledgerPath 不等。
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import {
  decideContinuityTrigger,
  engineRoot,
  sessionDirOf,
  writerArgv,
  type ContinuityHookInput,
} from '../../src/harness/session/continuity-hook';
import { createDefaultMemory } from '../../src/mcp/assemble';
import { appendLedger } from '../../src/harness/session/ledger';
import { createOmdMemory } from '../../src/harness/memory';
import { UNIVERSAL_SAFEGUARD } from '../../src/memory/safeguards/namespaces';
import { slugifyProject } from '../../src/harness/project-scope';
import { listCheckpoints, type CheckpointRow } from '../../src/harness/session/sink';
import type { StopLedger, StopLedgerEntry } from '../../src/harness/session/stop-ledger';

// ─── fixture ────────────────────────────────────────────────────────────────

const HOOK = join(engineRoot(), 'scripts/session-continuity-hook.ts');

/** ledger 装配:只给 tokenBucket —— 触发判定只读它。 */
function ledgerOf(...buckets: (number | null)[]): StopLedger {
  const entries: StopLedgerEntry[] = buckets.map((tokenBucket, i) => ({
    ordinal: i + 1,
    tokenBucket,
    assistantText: null,
  }));
  return { entries, lastUserAsk: { status: 'empty', value: null, sourceLine: null } };
}

const stop = (over: Partial<ContinuityHookInput> = {}): ContinuityHookInput => ({
  hook_event_name: 'Stop',
  ...over,
});

/** CC transcript:一条 user + 若干 assistant(usage 三键齐 → tokenBucket 有值)。 */
function transcriptOf(...buckets: number[]): string {
  const recs: unknown[] = [{ type: 'user', message: { content: '接一次 continuity 触发器' } }];
  for (const b of buckets) {
    recs.push({
      type: 'assistant',
      message: {
        usage: { input_tokens: b, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        content: [{ type: 'text', text: `本轮 ctx ${b}` }],
      },
    });
  }
  return recs.map((r) => JSON.stringify(r)).join('\n');
}

interface World {
  /** 被派发方当成 repo 的 cwd —— facts 落 `<repo>/.omd/memory.db`。 */
  repo: string;
  /** repo 目录 basename 派生的 project slug(ledger / checkpoint 的分区键)。 */
  slug: string;
  /** OMD_DATA_HOME —— checkpoint.md / ledger.jsonl 落这里。 */
  dataHome: string;
  transcript: string;
  memoryDb: string;
}

function mkWorld(prefix: string, ...buckets: number[]): World {
  const root = mkdtempSync(join(tmpdir(), prefix));
  // repo 目录名带上 root 的随机段:两个 world 的 slug 必须不同, 否则「按 cwd 分区」那条
  // 会因为两边 basename 都叫 'repo' 而假绿。
  const repo = join(root, `repo-${basename(root)}`);
  const dataHome = join(root, 'data');
  mkdirSync(repo, { recursive: true });
  const transcript = join(root, 'transcript.jsonl');
  writeFileSync(transcript, transcriptOf(...buckets));
  return {
    repo,
    slug: slugifyProject(basename(repo)),
    dataHome,
    transcript,
    memoryDb: join(repo, '.omd', 'memory.db'),
  };
}

interface HookRun {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function runHook(world: World, input: unknown, envOver: Record<string, string> = {}): HookRun {
  const p = Bun.spawnSync(['bun', 'run', HOOK], {
    cwd: world.repo,
    stdin: Buffer.from(JSON.stringify(input)),
    env: {
      ...process.env,
      OMD_DATA_HOME: world.dataHome,
      OMD_CONTINUITY_MECHANICAL: '1', // 零模型调用 —— 端到端闸才可能是确定性的
      OMD_SESSION_BUCKET: '1000',
      ...envOver,
    },
  });
  return { exitCode: p.exitCode, stdout: p.stdout.toString(), stderr: p.stderr.toString() };
}

/** detached writer 是异步的 —— 轮询到出行或超时(超时即判失败,不"再等等")。 */
async function waitForCheckpoint(
  dbPath: string,
  sessionId: string,
  timeoutMs = 60_000,
): Promise<CheckpointRow[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (existsSync(dbPath)) {
      // 读面 = MCP 生产装配那一份, 不是测试自捏的 —— 捏一份就又变成"假如注册了会怎样"。
      const memory = createDefaultMemory({ OMD_MEMORY_PATH: dbPath } as NodeJS.ProcessEnv);
      try {
        const rows = await listCheckpoints({ sessionId }, { memory });
        if (rows.length > 0) return rows;
      } finally {
        memory.close();
      }
    }
    if (Date.now() >= deadline) return [];
    await Bun.sleep(250);
  }
}

// ─── A3 触发 policy(纯函数)──────────────────────────────────────────────────

describe('A3 触发 policy — decideContinuityTrigger', () => {
  const env = { OMD_SESSION_BUCKET: '1000' } as NodeJS.ProcessEnv;

  test('跨档触发一次, 同档第二次不触发(这一对就是彼此的反向自检)', () => {
    expect(decideContinuityTrigger(stop(), ledgerOf(800, 1200), env)).toEqual({
      fire: true,
      mode: 'rolling',
      bucket: 1,
    });
    expect(decideContinuityTrigger(stop(), ledgerOf(1200, 1600), env).fire).toBe(false);
  });

  test('D-4: 第二、第三档同样触发(冻结模块那条「≥ 档位且前一条 <」一个 session 只响一次)', () => {
    expect(decideContinuityTrigger(stop(), ledgerOf(1600, 2100), env)).toEqual({
      fire: true,
      mode: 'rolling',
      bucket: 2,
    });
    expect(decideContinuityTrigger(stop(), ledgerOf(2900, 3050), env)).toEqual({
      fire: true,
      mode: 'rolling',
      bucket: 3,
    });
  });

  test('守卫不是触发: stop_hook_active 命中 → 不决策(否则 hook 自激循环)', () => {
    expect(decideContinuityTrigger(stop({ stop_hook_active: true }), ledgerOf(800, 5000), env)).toEqual({
      fire: false,
      why: 'stop_hook_active',
    });
  });

  test('PreCompact 恒触发且 mode=precompact(压缩前那一刻不看档位)', () => {
    expect(decideContinuityTrigger({ hook_event_name: 'PreCompact' }, ledgerOf(10), env)).toEqual({
      fire: true,
      mode: 'precompact',
      bucket: 0,
    });
  });

  test('其它事件 / 空 ledger / 最新条缺 token / 坏档位配置 → 一律不触发', () => {
    expect(decideContinuityTrigger({ hook_event_name: 'SessionEnd' }, ledgerOf(5000), env).fire).toBe(false);
    expect(decideContinuityTrigger(stop(), ledgerOf(), env).fire).toBe(false);
    expect(decideContinuityTrigger(stop(), ledgerOf(800, null), env).fire).toBe(false);
    // 坏配置不拿来造档位 —— 不伪造数比"猜一个默认"重要
    expect(decideContinuityTrigger(stop(), ledgerOf(5000), { OMD_SESSION_BUCKET: 'abc' }).fire).toBe(false);
  });

  test('前一条缺 token → 记 0 档: 宁可多存一次, 不因一条读数缺失把跨档吞掉', () => {
    expect(decideContinuityTrigger(stop(), ledgerOf(null, 1200), env)).toEqual({
      fire: true,
      mode: 'rolling',
      bucket: 1,
    });
  });

  test('基准是**此前最高档**不是前一条: 跨档那一跳落在中间, 末尾几条恒等 → 仍不误触发', () => {
    // 真形状(2026-08-19 实测本仓 transcript 末尾): 一个 Stop 之间会追加多条 entry,
    // 末尾几条 tokenBucket 逐字相同。只比最后两条时这里恒判"不跨",跨档那一跳被永久漏掉。
    const tail = ledgerOf(800, 1050, 1200, 1200, 1200);
    expect(decideContinuityTrigger(stop(), tail, env).fire).toBe(false); // 1 档已在历史里 → 不重复
    // 而真正跨到 2 档时照样响, 哪怕它出现在末尾恒等段之后
    expect(decideContinuityTrigger(stop(), ledgerOf(800, 1200, 1200, 2050), env)).toEqual({
      fire: true,
      mode: 'rolling',
      bucket: 2,
    });
  });
});

// ─── A4 路径同源 ────────────────────────────────────────────────────────────

describe('A4 路径三处同源 — hook / ledger / writer 必须指同一个 session 目录', () => {
  test('sessionDirOf === appendLedger 落盘目录(漂了 writer 就永远读不到 ledger)', () => {
    const world = mkWorld('omd-hook-path-');
    const sessionId = 'path-001';
    const r = appendLedger({ ledger: ledgerOf(1, 2), sessionId, cwd: world.repo });

    expect(r.ok).toBe(true);
    expect(r.ledgerPath).toBe(join(sessionDirOf(sessionId, world.repo), 'ledger.jsonl'));
  });

  test('按 cwd 分区: 换一个 repo → 目录跟着变(证明不是碰巧写死一条路径)', () => {
    const a = mkWorld('omd-hook-path-a-');
    const b = mkWorld('omd-hook-path-b-');
    expect(sessionDirOf('same-id', a.repo)).not.toBe(sessionDirOf('same-id', b.repo));
  });

  test('writerArgv 派的是本仓的 writer, 且 mechanical 开关只在 env 命中时追加', () => {
    expect(writerArgv('/tmp/t.jsonl', 'sid-1', 'rolling', {})).toEqual([
      'run',
      join(engineRoot(), 'scripts/session-writer.ts'),
      '--transcript',
      '/tmp/t.jsonl',
      '--session',
      'sid-1',
    ]);
    expect(writerArgv('/tmp/t.jsonl', 'sid-1', 'precompact', {})).toContain('--precompact');
    expect(writerArgv('/tmp/t.jsonl', 'sid-1', 'rolling', { OMD_CONTINUITY_MECHANICAL: '1' })).toContain(
      '--mechanical',
    );
  });
});

// ─── A5 fail-open ───────────────────────────────────────────────────────────

describe('A5 fail-open — 坏输入永不阻断 session', () => {
  test('空 stdin / 坏 JSON / 缺字段 → exit 0 + stdout "{}"', () => {
    const world = mkWorld('omd-hook-failopen-');
    for (const bad of ['', 'not json', '{"hook_event_name":"Stop"}']) {
      const p = Bun.spawnSync(['bun', 'run', HOOK], {
        cwd: world.repo,
        stdin: Buffer.from(bad),
        env: { ...process.env, OMD_DATA_HOME: world.dataHome },
      });
      expect(p.exitCode).toBe(0);
      expect(p.stdout.toString()).toBe('{}');
    }
  });

  test('transcript 不存在 → exit 0、零写入, 但**留下证据**(fail-open 不吞证据)', () => {
    const world = mkWorld('omd-hook-notranscript-');
    const r = runHook(world, {
      hook_event_name: 'Stop',
      transcript_path: join(world.repo, 'nope.jsonl'),
      session_id: 'fo-1',
      cwd: world.repo,
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe('{}');
    expect(existsSync(world.memoryDb)).toBe(false);
    expect(r.stderr).toContain('[continuity-hook]');
  });

  test('未跨档 → 不派 writer, 但 ledger 照记(记账与触发是两件事)', () => {
    const world = mkWorld('omd-hook-nofire-', 100, 200); // 档位 1000, 远未过
    const sessionId = 'nofire-1';
    const r = runHook(world, {
      hook_event_name: 'Stop',
      transcript_path: world.transcript,
      session_id: sessionId,
      cwd: world.repo,
    });

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe('{}'); // 无 marker = 没派
    expect(
      existsSync(join(world.dataHome, 'projects', world.slug, 'session', sessionId, 'ledger.jsonl')),
    ).toBe(true);
  });
});

// ─── A2 读面装配(实装缺陷的现场,不需要子进程)────────────────────────────

describe('A2 读面装配 — 读一个库的 safeguard 必须覆盖库里出现过的 namespace', () => {
  test('universal 装配读 continuity 行 → 恒空(#206 第三处静默断点);host 装配读得回', async () => {
    const world = mkWorld('omd-hook-readface-');
    mkdirSync(join(world.repo, '.omd'), { recursive: true });

    // 写入侧照生产:窄 safeguard 只开 continuity 一格
    const { CONTINUITY_SAFEGUARD } = await import('../../src/memory/safeguards/continuity-namespace');
    const writer = createOmdMemory({ path: world.memoryDb, safeguard: CONTINUITY_SAFEGUARD });
    const { sinkCheckpoint } = await import('../../src/harness/session/sink');
    const sunk = await sinkCheckpoint(
      {
        sessionId: 'readface-1',
        mode: 'final',
        md: '# checkpoint',
        intent: '读面装配自证',
        checkpointPath: join(world.repo, 'checkpoint.md'),
      },
      { memory: writer },
    );
    writer.close();
    expect(sunk.ok).toBe(true); // 写入侧成功 —— 缺陷不在这边

    // ① universal 装配(#206 之前 createDefaultMemory 用的就是它)→ parse 抛 → catch 吞成 []
    const universal = createOmdMemory({ path: world.memoryDb, safeguard: UNIVERSAL_SAFEGUARD });
    const blind = await listCheckpoints({ sessionId: 'readface-1' }, { memory: universal });
    universal.close();
    expect(blind).toEqual([]); // ← 这就是"写入成功、读面恒空"的现场

    // ② 生产读面(HOST_SAFEGUARD)→ 读得回
    const host = createDefaultMemory({ OMD_MEMORY_PATH: world.memoryDb } as NodeJS.ProcessEnv);
    const rows = await listCheckpoints({ sessionId: 'readface-1' }, { memory: host });
    host.close();
    expect(rows.length).toBe(1);
    expect(rows[0]!.sessionId).toBe('readface-1');
  });
});

// ─── A1 端到端 ──────────────────────────────────────────────────────────────

describe('A1 端到端 — 喂一次 hook, 库里真出 continuity 行', () => {
  test(
    '跨档 Stop → detached writer → facts 出行, 生产读面读得回同一 sessionId',
    async () => {
      const world = mkWorld('omd-hook-e2e-', 400, 1400); // 档位 1000:第二轮跨档
      const sessionId = 'e2e-206';

      const r = runHook(world, {
        hook_event_name: 'Stop',
        transcript_path: world.transcript,
        session_id: sessionId,
        cwd: world.repo,
      });

      expect(r.exitCode).toBe(0);
      // 确定性 inline 标记:派了就同步说,不靠模型记得说
      expect(r.stdout).toContain('continuity checkpoint');
      expect(r.stdout).toContain('[distill pending]');

      // A4 的**真** env 版:hook 的 `sessionDirOf` 与 `appendLedger` 必须落同一个目录。
      // 上面 A4 那组跑在没设 OMD_DATA_HOME 的测试进程里,`dataPath` 恰好退化成裸 `.omd/`,
      // 两种写法重合 ⇒ 那组分辨不出漂移(实测:把 dataPath 换成裸 `.omd` 它照样绿)。
      // 这里子进程带着 OMD_DATA_HOME,writer.log(hook 建)与 ledger.jsonl(appendLedger 建)
      // 必须并排 —— 漂了就红。
      const contDir = join(world.dataHome, 'projects', world.slug, 'session', sessionId);
      expect(existsSync(join(contDir, 'writer.log'))).toBe(true);
      expect(existsSync(join(contDir, 'ledger.jsonl'))).toBe(true);

      const rows = await waitForCheckpoint(world.memoryDb, sessionId);
      expect(rows.length).toBeGreaterThan(0);

      const row = rows[0]!;
      expect(row.sessionId).toBe(sessionId);
      expect(row.checkpointPath).toBeTruthy();
      expect(existsSync(row.checkpointPath!)).toBe(true); // 指针指向真存在的 markdown
      expect(row.degraded).toBe(true); // OMD_CONTINUITY_MECHANICAL=1 → 机械降级版
    },
    90_000,
  );
});
