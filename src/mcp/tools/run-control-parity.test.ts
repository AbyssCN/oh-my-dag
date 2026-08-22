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
 * ## 反向自检 (实跑过的反向自证)
 *
 *   · 把 `intervene.ts` 里 `recordIntervention(...)` 换回 `appendBoard(deps.cwd, {...})` 手写
 *     → GWT-PARITY-1 红 (date 字段差异 / note trim 行为差异都能见红)。
 *   · 在 `recordIntervention` 里把 `cause` 字段改名为 `kind` → GWT-PARITY-1 红
 *     (`toMatchObject({ cause })` 失败)。
 *   · 在 `recordIntervention` 里把 note trim 拿掉 → GWT-PARITY-3 红 (空格留作 note)。
 *   · 把 MCP 侧 `try/catch` 拿掉 → GWT-PARITY-4 红 (抛而非 err 回执)。
 *
 * @see SDD 片 7 切片 2 · INV-RC-1
 * @see src/harness/run-control.test.ts (片 1 的契约闸)
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readBoard } from '../../harness/board/run-board';
import { recordIntervention } from '../../harness/run-control';
import { createInterveneTools } from './intervene';

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

  test('GWT-PARITY-4: 非法 cause (绕过 MCP schema 直接调 handler) → MCP 拒 + 共享件拒, 两路都不落盘', async () => {
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

    // 两路都不落盘
    expect(readBoard(cwd)).toEqual([]);
  });

  test('GWT-PARITY-5: 缺 runId (绕过 MCP schema) → MCP 拒 + 共享件拒, 两路都不落盘', async () => {
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