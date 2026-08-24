/**
 * src/mcp/tools/run-control-parity.test —— 「不漂」这条闸的载体 (INV-RC-1, SDD 片 7 切片 2)。
 *
 * ## 为什么是它
 *
 * `dag_intervene` 在片 7 之前自己 `appendBoard(...)` 一份 (`intervene.ts:72-81`),
 * 共享件 `recordIntervention` 在片 7 切片 1 也是 `appendBoard(...)` —— 两条路各自写
 * 各自拼, 同一条因同输入但板上形状**可能**已经漂了。本测试钉的就是:
 * 「同一 cwd × 同一 (runId, cause, note) → 经 MCP 与经共享件写出来的两条板条
 *  `v` / `event` / `runId` / `cause` / `note` 逐字段相等, 仅 `ts` 不同」。
 *
 * 一旦 MCP 侧又把 `appendBoard` 抄回去 (或 `recordIntervention` 内部改了字段集),
 * 这条立刻红。
 *
 * ## 停图那一半 (2026-08-23 补 · GWT-PARITY-C1..C4)
 *
 * ⚠ **这道闸原先只钉了 intervene 那一半。** 而 `dag_cancel` 当时**自己抄了一份**写侧
 * (`dag-tools.ts` 旧 566-610: 自建目录 + 自写 cancel 标记 + 自发 SIGTERM, 且把
 * `writeFileSync` 写了两遍), `cancel` 这个词在本文件里一次都没出现过 —— 于是 MCP 的 `s`
 * 与 TUI 收件箱的 `s` 可以静默漂开, 而**没有任何东西会红**。
 * 「一条永远绿的闸不是闸」的一个变体: 这条闸是绿的, 但它守的面只有一半。
 *
 * C 组钉两件事:
 *   1. **同一份写侧** —— 同 (cwd, runId, why) 经 MCP 与经 `cancelDetachedRun`,
 *      盘上 cancel 标记逐字节相等, 收到 SIGTERM 的 pid 相等。
 *   2. **INV-RC-4 四种结局分得开** —— `signalled` / `pid-dead` / `no-owner-pid` /
 *      `signal-failed` 各回各的话。尤其 `no-owner-pid` ≠ `pid-dead`:
 *      前者是**账本缺一列**, 后者是进程真死了 (CLAUDE.md 坑①)。
 *
 * ## 反向自检 (实跑过的反向自证)
 *
 *   · 把 `intervene.ts` 里 `recordIntervention(...)` 换回 `appendBoard(deps.cwd, {...})` 手写
 *     → GWT-PARITY-1 红 (date 字段差异 / note trim 行为差异都能见红)。
 *   · 在 `recordIntervention` 里把 `cause` 字段改名为 `kind` → GWT-PARITY-1 红
 *     (`toMatchObject({ cause })` 失败)。
 *   · 在 `recordIntervention` 里把 note trim 拿掉 → GWT-PARITY-3 红 (空格留作 note)。
 *   · 把 MCP 侧 `try/catch` 拿掉 → GWT-PARITY-4 红 (抛而非 err 回执)。
 *   C 组四条 2026-08-23 逐条实跑证伪 (每次只动一处, 跑完还原并复绿 11/0):
 *   · `dag_cancel` 在共享件之后**再按自己的格式写一遍**标记 (`why + '\n'`)
 *     → C1 红 (两路标记字节不等)。⚠ 第一版突变写在共享件**之前**, 被共享件覆盖回去,
 *     C1 反而不红 —— "写了个突变" ≠ "证伪了这条断言", 突变得打在断言真正管的那一跳上。
 *   · 同一个手写标记写在共享件**之前** → C2 / C3 红 (该一个字节不写的两格写了)。
 *   · 把 `no-owner-pid` 那支的回执改成与 `pid-dead` 同一句 → C3 红。
 *   · 把 `signal-failed` 那支的 `isError` 拿掉 → C4 红。
 *
 * @see SDD 片 7 切片 2 · INV-RC-1 · INV-RC-4
 * @see src/harness/run-control.test.ts (片 1 的契约闸)
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readBoard } from '../../harness/board/run-board';
import { cancelDetachedRun, recordIntervention } from '../../harness/run-control';
import { createInterveneTools } from './intervene';
import { createDagTools } from './dag-tools';
import { RunRegistry } from '../run-registry';
import { createRunStore } from '../run-store';
import type { ExecutorDagResult } from '../../harness/dag/types';

const mkCwd = (): string => mkdtempSync(join(tmpdir(), 'omd-run-control-parity-'));
const byName = (cwd: string, name: string) =>
  createInterveneTools({ cwd }).find((t) => t.name === name)!;

const call = (
  h: ReturnType<typeof byName>['handler'],
  args: Record<string, unknown>,
): Promise<{ content: { text: string }[]; isError?: boolean }> =>
  h(args as never, {} as never) as unknown as Promise<{ content: { text: string }[]; isError?: boolean }>;

/** 把 MCP 路与共享件路的板条对比字段 ── 除 `ts` 外逐字段相等。 */
function expectBoardsEqualExceptTs(a: Record<string, unknown>, b: Record<string, unknown>): void {
  const { ts: _aTs, ...aRest } = a;
  const { ts: _bTs, ...bRest } = b;
  // 静默吃掉 _aTs/_bTs (lint 抓未用变量)
  void _aTs;
  void _bTs;
  expect(aRest).toEqual(bRest);
  expect(typeof a.ts).toBe('string');
  expect(typeof b.ts).toBe('string');
  // ts 必须真不同 (两路现取, 不应撞毫秒 — 给 1ms 间隔)
  expect(a.ts === b.ts).toBe(false);
}

describe('INV-RC-1 · 介入写侧对位 (MCP dag_intervene ↔ recordIntervention)', () => {
  test('GWT-PARITY-1: 合法 cause + note → 两路板上记录逐字段相等, 仅 ts 不同', async () => {
    const cwd = mkCwd();
    const h = byName(cwd, 'dag_intervene').handler;

    // MCP 路
    const mcpRes = await call(h, { runId: 'run-1', cause: 'unclassified', note: '手工收编' });
    expect(mcpRes.isError).toBeFalsy();
    // 给 ts 一毫秒以上的间隔 (避免两路新 Date().toISOString() 撞同值)
    await new Promise((r) => setTimeout(r, 5));
    // 共享件路 — 同一 cwd 同一 (runId, cause, note)
    const sharedTs = recordIntervention(cwd, 'run-1', 'unclassified', '手工收编');
    expect(typeof sharedTs).toBe('string');

    const entries = readBoard(cwd);
    expect(entries).toHaveLength(2);
    expect(entries.every((e) => e.event === 'intervened')).toBe(true);
    expectBoardsEqualExceptTs(entries[0] as unknown as Record<string, unknown>, entries[1] as unknown as Record<string, unknown>);
    expect(entries[0]!.runId).toBe('run-1');
    expect(entries[0]!.cause).toBe('unclassified');
    expect(entries[0]!.note).toBe('手工收编');
    expect(entries[0]!.v).toBe(1);
  });

  test('GWT-PARITY-2: 合法 cause + 缺省 note → 两路都不留 note 字段', async () => {
    const cwd = mkCwd();
    const h = byName(cwd, 'dag_intervene').handler;

    await call(h, { runId: 'run-2', cause: 'assert-failed' });
    await new Promise((r) => setTimeout(r, 5));
    recordIntervention(cwd, 'run-2', 'assert-failed');

    const entries = readBoard(cwd);
    expect(entries).toHaveLength(2);
    for (const e of entries) {
      expect('note' in e!).toBe(false); // 整键缺席, 不是 note:''
    }
    expectBoardsEqualExceptTs(entries[0] as unknown as Record<string, unknown>, entries[1] as unknown as Record<string, unknown>);
  });

  test('GWT-PARITY-3: note 全空白 → 两路都不留 note 字段 (trim 后为空)', async () => {
    const cwd = mkCwd();
    const h = byName(cwd, 'dag_intervene').handler;

    await call(h, { runId: 'run-3', cause: 'empty-artifact', note: '   ' });
    await new Promise((r) => setTimeout(r, 5));
    recordIntervention(cwd, 'run-3', 'empty-artifact', '   ');

    const entries = readBoard(cwd);
    expect(entries).toHaveLength(2);
    for (const e of entries) {
      expect('note' in e!).toBe(false);
    }
    expectBoardsEqualExceptTs(entries[0] as unknown as Record<string, unknown>, entries[1] as unknown as Record<string, unknown>);
  });

  test('GWT-PARITY-4: 非法 cause (绕过 MCP schema 直接调 handler) → MCP 拒 + 共享件拒, 两路都不写入磁盘', async () => {
    const cwd = mkCwd();
    const h = byName(cwd, 'dag_intervene').handler;

    // MCP 路: handler fail-loud 兜底 (schema 已被绕过)
    const mcpRes = await call(h, { runId: 'run-bad', cause: 'not-a-real-kind' });
    expect(mcpRes.isError).toBe(true);
    expect(mcpRes.content[0]!.text).toContain('not-a-real-kind');
    // 共享件路: 直接调必抛
    expect(() => recordIntervention(cwd, 'run-bad', 'not-a-real-kind' as never)).toThrow(
      /FAILURE_KIND_ORDER/,
    );

    // 两路都不写入磁盘
    expect(readBoard(cwd)).toEqual([]);
  });

  test('GWT-PARITY-5: 缺 runId (绕过 MCP schema) → MCP 拒 + 共享件拒, 两路都不写入磁盘', async () => {
    const cwd = mkCwd();
    const h = byName(cwd, 'dag_intervene').handler;

    const mcpRes = await call(h, { cause: 'unclassified' });
    expect(mcpRes.isError).toBe(true);
    expect(mcpRes.content[0]!.text).toContain('runId');
    expect(() => recordIntervention(cwd, '', 'unclassified')).toThrow(/runId 必填/);

    expect(readBoard(cwd)).toEqual([]);
  });

  test('GWT-PARITY-6: 词表全集 — MCP 与共享件都接受每一项, 板上形状对位', async () => {
    // 取词表现行快照 (与 node-failure 词表单源, 不写死)
    const { FAILURE_KIND_ORDER } = await import('../../harness/node-failure');
    for (const k of FAILURE_KIND_ORDER) {
      const cwd = mkCwd();
      const h = byName(cwd, 'dag_intervene').handler;

      const mcpRes = await call(h, { runId: `run-${k}`, cause: k });
      expect(mcpRes.isError).toBeFalsy();
      await new Promise((r) => setTimeout(r, 5));
      recordIntervention(cwd, `run-${k}`, k);

      const entries = readBoard(cwd);
      expect(entries).toHaveLength(2);
      expectBoardsEqualExceptTs(
        entries[0] as unknown as Record<string, unknown>,
        entries[1] as unknown as Record<string, unknown>,
      );
    }
  });

  test('GWT-PARITY-7: MCP handler 抛 (盘写异常) → 仍走 err 回执, 不挂调用方', async () => {
    // 共享件在不可写目录下 appendBoard 会抛 ── 模拟「盘坏了」这种工程现实。
    // MCP 这路必须把异常翻译成 isError, 与原 intervene.ts 的 try/catch 行为一致。
    const cwd = mkCwd();
    // 把 board 文件路径做成文件 ── readBoard/appendBoard 会抛 ENOTDIR/EROFS 之类的
    // (具体抛什么取决于 run-board 的实现; 我们只校验 MCP 这路不裸抛)。
    // 复用片 1 的同款 idiom: 在 cwd 下放一个文件叫 .omd。
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(cwd, '.omd'), '');

    const h = byName(cwd, 'dag_intervene').handler;
    const r = await call(h, { runId: 'run-broken', cause: 'unclassified' });
    // 行为 = 旧 intervene.ts: catch 块返回 isError, 不是把异常 throw 出 handler。
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/写板失败|dag_intervene/);
  });
});

// ───────────────────────── 停图那一半 (INV-RC-1 / INV-RC-4) ─────────────────────────

/** 永不完成的引擎 —— cancel 这条路一步都不该碰引擎 (与 dag-exec.test.ts 同款 idiom)。 */
const neverEngine = {
  runExecutorDag: async (): Promise<ExecutorDagResult> => {
    throw new Error('cancel 路径不该调引擎');
  },
  runExecutorDagWithPlan: async (): Promise<ExecutorDagResult> => {
    throw new Error('cancel 路径不该调引擎');
  },
};

const markerPath = (cwd: string, runId: string): string =>
  join(cwd, '.omd', 'continuity', runId, 'cancel');

/**
 * 造一个「在飞、且内存里没有取消把手」的 run —— 与 `dag-exec.test.ts:232` 同款 idiom。
 *
 * ⚠ **必须走 register+start (内存), 不能只往盘上 put 一条 `running`。**
 * 2026-08-23 第一版这么写了, 四条 C 全红在同一句 `当前 failed — 不在飞`:
 * `ensureFromDisk` 有僵尸清扫 —— 盘上 `running` 而 (ownerPid 为 null 或 pid 不活) 一律
 * 就地转 `failed` 并写回盘 (`run-registry.ts:243`)。所以纯盘造的假 run 到不了 cancel 那段。
 * 顺带这也说明 `no-owner-pid` 那一格**只在内存说 running 而账本缺列**时才到得了。
 *
 * `ownerPid: null` = 抹掉账本那一列 (INV-RC-4 的 `no-owner-pid`, 不是"进程死了")。
 */
function mkRunningRun(root: string, runId: string, ownerPid: number | null): RunRegistry {
  const store = createRunStore({ path: join(root, 'runs.db') });
  // pid 注入: putRecord 把 `this.pid` 当 ownerPid 写盘 (run-registry.ts:312)。
  const reg = new RunRegistry(undefined, { store, pid: ownerPid ?? process.pid });
  reg.register(runId, { goal: 'g' });
  reg.start(runId); // 只 start, **不**注册取消把手 → requestCancel 返 false → 走 detached 那支
  if (ownerPid === null) {
    const r = store.get(runId)!;
    store.put({ ...r, ownerPid: null });
  }
  return reg;
}

/** MCP 侧 `dag_cancel` —— deps 与共享件那路注入同一组 spy。 */
function mcpCancel(
  root: string,
  reg: RunRegistry,
  spies: { isAlive: (pid: number) => boolean; killPid: (pid: number) => void },
) {
  const tools = createDagTools({
    engine: neverEngine,
    runRegistry: reg,
    defaultConfig: { conductorModel: 'c:m', leafModel: 'l:m' },
    continuity: { manager: undefined as never, repoRoot: root },
    isAlive: spies.isAlive,
    killPid: spies.killPid,
  });
  return tools.find((t) => t.name === 'dag_cancel')!.handler;
}

describe('INV-RC-1 · 停图写侧对位 (MCP dag_cancel ↔ cancelDetachedRun)', () => {
  test('GWT-PARITY-C1: 属主活着 → 两路 cancel 标记逐字节相等, SIGTERM 打同一个 pid', async () => {
    const why = '够了 — 判据已经答完';
    const pid = 4242;

    // MCP 路
    const mcpRoot = mkCwd();
    const reg = mkRunningRun(mcpRoot, 'r-live', pid);
    const mcpKilled: number[] = [];
    const mcpRes = await call(
      mcpCancel(mcpRoot, reg, { isAlive: () => true, killPid: (p) => mcpKilled.push(p) }),
      { runId: 'r-live', reason: why },
    );
    reg.close();

    // 共享件路 —— 同 (runId, why), 同一组 spy 形状
    const sharedRoot = mkCwd();
    const sharedKilled: number[] = [];
    const outcome = cancelDetachedRun(sharedRoot, 'r-live', why, {
      readOwnerPid: () => pid,
      isAlive: () => true,
      killPid: (p) => sharedKilled.push(p),
    });

    // ① 同一份写侧: 标记逐字节相等 (不是"都存在", 是**同样的字节**)
    expect(readFileSync(markerPath(mcpRoot, 'r-live'), 'utf-8')).toBe(
      readFileSync(markerPath(sharedRoot, 'r-live'), 'utf-8'),
    );
    expect(readFileSync(markerPath(sharedRoot, 'r-live'), 'utf-8')).toBe(why);
    // ② 同一个 pid 收到 SIGTERM
    expect(mcpKilled).toEqual(sharedKilled);
    expect(mcpKilled).toEqual([pid]);
    // ③ 结局对位
    expect(outcome).toEqual({ kind: 'signalled', pid, signal: 'SIGTERM' });
    expect(mcpRes.isError).toBeFalsy();
    expect(mcpRes.content[0]!.text).toContain('SIGTERM');
  });

  test('GWT-PARITY-C2: 属主 pid 已死 → 两路都一个字节不写、不发信号 (pid-dead)', async () => {
    const pid = 4243;

    const mcpRoot = mkCwd();
    const reg = mkRunningRun(mcpRoot, 'r-dead', pid);
    const mcpKilled: number[] = [];
    const mcpRes = await call(
      mcpCancel(mcpRoot, reg, { isAlive: () => false, killPid: (p) => mcpKilled.push(p) }),
      { runId: 'r-dead' },
    );
    reg.close();

    const sharedRoot = mkCwd();
    const sharedKilled: number[] = [];
    const outcome = cancelDetachedRun(sharedRoot, 'r-dead', 'why', {
      readOwnerPid: () => pid,
      isAlive: () => false,
      killPid: (p) => sharedKilled.push(p),
    });

    // 判活失败必须**在写标记之前**短路 —— 写了标记再说"没停到"是自相矛盾的回执。
    expect(existsSync(markerPath(mcpRoot, 'r-dead'))).toBe(false);
    expect(existsSync(markerPath(sharedRoot, 'r-dead'))).toBe(false);
    expect(mcpKilled).toEqual([]);
    expect(sharedKilled).toEqual([]);
    expect(outcome).toEqual({ kind: 'pid-dead', pid });
    expect(mcpRes.isError).toBe(true);
    expect(mcpRes.content[0]!.text).toContain('没有活进程可停');
  });

  test('GWT-PARITY-C3: 盘上没记 ownerPid → 与 pid-dead **说的不是同一句话** (INV-RC-4)', async () => {
    const mcpRoot = mkCwd();
    const reg = mkRunningRun(mcpRoot, 'r-nopid', null);
    const mcpKilled: number[] = [];
    const noPidRes = await call(
      mcpCancel(mcpRoot, reg, { isAlive: () => true, killPid: (p) => mcpKilled.push(p) }),
      { runId: 'r-nopid' },
    );
    reg.close();

    // 同一棵树上再造一个 pid-dead 的对照 —— 两句回执必须区分得开。
    const deadRoot = mkCwd();
    const reg2 = mkRunningRun(deadRoot, 'r-nopid', 5150);
    const deadRes = await call(
      mcpCancel(deadRoot, reg2, { isAlive: () => false, killPid: () => {} }),
      { runId: 'r-nopid' },
    );
    reg2.close();

    const sharedRoot = mkCwd();
    const outcome = cancelDetachedRun(sharedRoot, 'r-nopid', 'why', {
      readOwnerPid: () => null,
      isAlive: () => true,
      killPid: () => {
        throw new Error('没 pid 时不该发信号');
      },
    });

    expect(outcome).toEqual({ kind: 'no-owner-pid' });
    expect(existsSync(markerPath(mcpRoot, 'r-nopid'))).toBe(false);
    expect(existsSync(markerPath(sharedRoot, 'r-nopid'))).toBe(false);
    expect(mcpKilled).toEqual([]);
    // 两者都是 isError, 但**话不一样** —— 合并成一句就是把"账本缺一列"伪装成"进程死了"。
    expect(noPidRes.isError).toBe(true);
    expect(deadRes.isError).toBe(true);
    expect(noPidRes.content[0]!.text).toContain('没记 ownerPid');
    expect(noPidRes.content[0]!.text).not.toBe(deadRes.content[0]!.text);
  });

  test('GWT-PARITY-C4: SIGTERM 抛 → 两路都已写标记, MCP 走 err 回执 (signal-failed)', async () => {
    const boom = (): never => {
      throw new Error('EPERM: 没权限');
    };

    const mcpRoot = mkCwd();
    const reg = mkRunningRun(mcpRoot, 'r-boom', 4244);
    const mcpRes = await call(
      mcpCancel(mcpRoot, reg, { isAlive: () => true, killPid: boom }),
      { runId: 'r-boom', reason: 'stop' },
    );
    reg.close();

    const sharedRoot = mkCwd();
    const outcome = cancelDetachedRun(sharedRoot, 'r-boom', 'stop', {
      readOwnerPid: () => 4244,
      isAlive: () => true,
      killPid: boom,
    });

    // 标记是协作通道, 信号是兜底 —— 兜底失败不该把已送达的协作通道抹掉。
    expect(readFileSync(markerPath(mcpRoot, 'r-boom'), 'utf-8')).toBe('stop');
    expect(readFileSync(markerPath(sharedRoot, 'r-boom'), 'utf-8')).toBe('stop');
    expect(outcome).toEqual({ kind: 'signal-failed', pid: 4244, error: 'EPERM: 没权限' });
    expect(mcpRes.isError).toBe(true);
    expect(mcpRes.content[0]!.text).toContain('EPERM');
  });
});