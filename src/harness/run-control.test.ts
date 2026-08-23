/**
 * src/harness/run-control.test —— 共享写侧的契约 (INV-RC-1 / INV-RC-2 / INV-RC-4, SDD 片 7)。
 *
 * 钉三件事:
 *   · `recordIntervention` 写出来的板条 = `intervene.ts:74-81` 原本那串字段 (除 ts),
 *     用来钉 MCP 侧换成共享件后的 parity (本片只测共享件自己; MCP ↔ 共享件的逐字段相等
 *     由 `run-control-parity.test.ts` 在片 2 钉)。
 *   · `recordIntervention` 在非法 cause / 空 runId 上 fail-loud, 不写盘。
 *   · `cancelDetachedRun` 的 `CancelOutcome` 四种结局 (`signalled` / `no-owner-pid` /
 *     `pid-dead` / `signal-failed`) 分得开 —— INV-RC-4 那条 "不许画一句『已请求取消』"
 *     的判据。
 *
 * 反向自检 (实跑过):
 *   · 把 `recordIntervention` 里 `event: 'intervened'` 改成 `'intervene'` → "正常 cause"
 *     用例的事件名错配, 立刻红。
 *   · 把 `recordIntervention` 里 note 的 `...(trimmed ? { note: trimmed } : {})` 改成无条件
 *     带上 → "空 note 不留字段" 用例红 (板上多一个空 note)。
 *   · 把 `cancelDetachedRun` 里 `pid === null || pid === undefined` 改成只判 `=== null` →
 *     "undefined 也算 no-owner-pid" 用例红 (走到 isAlive, 测试炸)。
 *   · 把 `signalled` 分支里的 `killPid` 挪到 `isAlive` 之前 → "pid 死了不该发信号" 用例红
 *     (发了信号但 outcome 是 pid-dead, spy 计数 1 而期望 0)。
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, test } from 'bun:test';
import { cancelDetachedRun, recordIntervention } from './run-control';
import { readBoard, type BoardEntry } from './board/run-board';

let root = '';
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'omd-run-control-'));
  // mkdtemp 留下的目录交给 OS —— 测试只在临时世界跑, 不脏主仓。
});

/** 读板拿一条 (板上就该一条)。 */
const onlyEntry = (): BoardEntry => {
  const entries = readBoard(root);
  expect(entries.length).toBe(1);
  return entries[0]!;
};

describe('INV-RC-1 · recordIntervention 写板形状 (与 intervene.ts:74-81 逐字同构, 除 ts)', () => {
  test('正常 cause + 无 note → { v:1, event:"intervened", cause, runId }, ts 现取', () => {
    recordIntervention(root, 'run-1', 'unclassified');
    const e = onlyEntry();
    expect(e.v).toBe(1);
    expect(e.event).toBe('intervened');
    expect(e.runId).toBe('run-1');
    expect(e.cause).toBe('unclassified');
    expect(typeof e.ts).toBe('string');
    expect(Number.isFinite(new Date(e.ts!).getTime())).toBe(true);
    expect(e.note).toBeUndefined();
  });

  test('有 note → note 留, 前后空白被 trim', () => {
    recordIntervention(root, 'run-2', 'unclassified', '  hello world  ');
    expect(onlyEntry().note).toBe('hello world');
  });

  test('note 是空白 → 不留 note 字段 (与原 MCP 行为逐字一致)', () => {
    recordIntervention(root, 'run-3', 'unclassified', '   ');
    expect(onlyEntry().note).toBeUndefined();
  });

  test('note 是空串 → 不留 note 字段 (空串 trim 后为空, 走空串分支)', () => {
    recordIntervention(root, 'run-4', 'unclassified', '');
    expect(onlyEntry().note).toBeUndefined();
  });

  test('返回 ts = 写入时戳 (parity test 用这条做"除 ts 外逐字段相等"对账)', () => {
    const ts = recordIntervention(root, 'run-5', 'unclassified');
    expect(ts).toBe(onlyEntry().ts);
  });

  test('cause 取词表里每一项都不抛 (FAILURE_KIND_ORDER 全集)', async () => {
    // 取词表当前快照, 不写死在测试里 —— 与 node-failure 词表单源。
    const { FAILURE_KIND_ORDER } = await import('./node-failure');
    for (const k of FAILURE_KIND_ORDER) {
      recordIntervention(root, `run-${k}`, k);
    }
    const entries = readBoard(root);
    expect(entries.length).toBe(FAILURE_KIND_ORDER.length);
    const causes = new Set(entries.map((e) => e.cause));
    for (const k of FAILURE_KIND_ORDER) expect(causes.has(k)).toBe(true);
  });
});

describe('INV-RC-1 · recordIntervention fail-loud (不落盘)', () => {
  test('cause 不在词表 → 抛, 板空', () => {
    expect(() => recordIntervention(root, 'run-bad', 'not-a-real-kind' as never)).toThrow(
      /FAILURE_KIND_ORDER/,
    );
    expect(readBoard(root)).toEqual([]);
  });

  test('runId 空串 → 抛, 板空', () => {
    expect(() => recordIntervention(root, '', 'unclassified')).toThrow(/runId 必填/);
    expect(readBoard(root)).toEqual([]);
  });

  test('runId 全空白 → 抛, 板空 (trim 后为空)', () => {
    expect(() => recordIntervention(root, '   ', 'unclassified')).toThrow(/runId 必填/);
    expect(readBoard(root)).toEqual([]);
  });
});

describe('INV-RC-4 · cancelDetachedRun 四种结局', () => {
  test('readOwnerPid 返回 null → { kind: "no-owner-pid" }, 不写 cancel 标记, 不发信号', () => {
    let killed = 0;
    const r = cancelDetachedRun(root, 'run-x', '因为测试', {
      readOwnerPid: () => null,
      isAlive: () => {
        throw new Error('no-owner-pid 分支不该走到 isAlive');
      },
      killPid: () => {
        killed++;
      },
    });
    expect(r).toEqual({ kind: 'no-owner-pid' });
    expect(killed).toBe(0);
    // 不写标记
    expect(() => readFileSync(join(root, '.omd/continuity/run-x/cancel'))).toThrow();
  });

  test('readOwnerPid 返回 undefined (防御) → 同 null, 不写标记不发信号', () => {
    let killed = 0;
    const r = cancelDetachedRun(root, 'run-y', 'why', {
      readOwnerPid: () => undefined as unknown as null,
      isAlive: () => {
        throw new Error('不该走到 isAlive');
      },
      killPid: () => {
        killed++;
      },
    });
    expect(r).toEqual({ kind: 'no-owner-pid' });
    expect(killed).toBe(0);
  });

  test('pid 死了 (isAlive=false) → { kind: "pid-dead", pid }, 不发信号, 不写标记', () => {
    let killed = 0;
    const r = cancelDetachedRun(root, 'run-z', 'why', {
      readOwnerPid: () => 12345,
      isAlive: () => false,
      killPid: () => {
        killed++;
      },
    });
    expect(r).toEqual({ kind: 'pid-dead', pid: 12345 });
    expect(killed).toBe(0);
    // 没活进程 → 标记也不写 (写给鬼没用)
    expect(() => readFileSync(join(root, '.omd/continuity/run-z/cancel'))).toThrow();
  });

  test('正常: 写 cancel 标记 + SIGTERM → { kind: "signalled", pid, signal: "SIGTERM" }', () => {
    let killed = -1;
    const r = cancelDetachedRun(root, 'run-a', 'stop here', {
      readOwnerPid: () => 999,
      isAlive: () => true,
      killPid: (pid: number) => {
        killed = pid;
      },
    });
    expect(r).toEqual({ kind: 'signalled', pid: 999, signal: 'SIGTERM' });
    expect(killed).toBe(999);
    const written = readFileSync(join(root, '.omd/continuity/run-a/cancel'), 'utf8');
    expect(written).toBe('stop here');
  });

  test('标记写失败 (cwd/.omd 是文件, mkdir ENOTDIR) → 仍发信号, outcome 仍是 signalled', () => {
    // 在 cwd 下放一个**文件**叫 .omd; mkdir recursive 撞文件 → ENOTDIR → catch 触发。
    writeFileSync(join(root, '.omd'), '');
    let killed = -1;
    const r = cancelDetachedRun(root, 'run-c', 'why', {
      readOwnerPid: () => 42,
      isAlive: () => true,
      killPid: (pid: number) => {
        killed = pid;
      },
    });
    // 标记写失败不阻断 SIGTERM (与 dag-tools.ts:581 同语义: 协作通道断, 兜底不能也断)
    expect(r).toEqual({ kind: 'signalled', pid: 42, signal: 'SIGTERM' });
    expect(killed).toBe(42);
  });

  test('killPid 抛 → { kind: "signal-failed", pid, error }', () => {
    const r = cancelDetachedRun(root, 'run-b', 'why', {
      readOwnerPid: () => 7,
      isAlive: () => true,
      killPid: () => {
        throw new Error('boom');
      },
    });
    expect(r).toEqual({ kind: 'signal-failed', pid: 7, error: 'boom' });
  });
});
