/**
 * src/harness/goal/ignition-forecast-planname.test —— IGN-2 改的是前缀匹配,
 * 这片就是那一次改的回归围栏。
 *
 * ## 这是 `★ 反向自检` 的反向自检
 *
 * D-5: "账本里存在新 plan 名而统计到 0 行时必须被测出来。" 改 `=` → `LIKE` 那一步
 * 看似无脑, 但**真正会埋雷的是下一次再改名** —— GWT-4 那条 (`goal-execute-新后缀`)
 * 就是这条雷的雷管: 任何把前缀收窄回精确名的回滚, 这条立刻红。
 *
 * 测的全是 `mkdtemp` 临时账本 —— 严禁读仓里的 `.omd/dag-runs.db`。
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readIgnitionBandwidth } from './ignition-forecast';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** 造一个 ledger, 列 = 真表的最小子集(被测查询只读 usage, plan_name 给 LIKE 用)。 */
function ledgerWith(rows: { plan: string; leavesIn: number; conductorIn?: number; ts?: number }[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'omd-ignition-pn-'));
  dirs.push(dir);
  const path = join(dir, 'dag-runs.db');
  const db = new Database(path);
  db.run(
    `CREATE TABLE omd_dag_runs (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, plan_name TEXT NOT NULL, usage TEXT NOT NULL)`,
  );
  rows.forEach((r, i) => {
    db.run(`INSERT INTO omd_dag_runs (id, created_at, plan_name, usage) VALUES (?, ?, ?, ?)`, [
      `p${i}`,
      r.ts ?? 1000 + i,
      r.plan,
      JSON.stringify({ conductorIn: r.conductorIn ?? 0, leavesIn: r.leavesIn }),
    ]);
  });
  db.close();
  return path;
}

describe('readIgnitionBandwidth · plan_name 前缀匹配 (IGN-2)', () => {
  // GWT-1 ── 只有 goal-execute-flat 行 ⇒ execute 非 null 且 n 等于行数
  test('GWT-1: 只有 goal-execute-flat 行时, execute 段被前缀覆盖 (n 等于行数)', () => {
    const path = ledgerWith([
      { plan: 'goal-execute-flat', leavesIn: 300_000, ts: 1001 },
      { plan: 'goal-execute-flat', leavesIn: 500_000, ts: 1002 },
      { plan: 'goal-execute-flat', leavesIn: 700_000, ts: 1003 },
    ]);
    const b = readIgnitionBandwidth({ path });
    expect(b.execute).not.toBeNull();
    expect(b.execute!.n).toBe(3); // 三行全被前缀抓住
    expect(b.execute!.plan).toBe('goal-execute');
  });

  // GWT-2 ── 同时有 goal-execute + goal-execute-flat ⇒ 两者都进, 按 created_at DESC, 限 20
  test('GWT-2: 同时有 goal-execute 与 goal-execute-flat 时, 两者都进, 按 created_at DESC 取近 20', () => {
    const rows = [
      { plan: 'goal-execute', leavesIn: 100_000, ts: 1000 },
      { plan: 'goal-execute-flat', leavesIn: 200_000, ts: 1001 },
      { plan: 'goal-execute', leavesIn: 300_000, ts: 1002 },
      { plan: 'goal-execute-flat', leavesIn: 400_000, ts: 1003 },
    ];
    const path = ledgerWith(rows);
    const b = readIgnitionBandwidth({ path, limit: 20 });
    expect(b.execute).not.toBeNull();
    expect(b.execute!.n).toBe(4); // 前缀 = goal-execute ⇒ 4 行全收
    expect(b.contract).toBeNull(); // 没写过契约段
  });

  // GWT-3 ── 只有 something-else ⇒ execute 为 null (前缀不许放太宽)
  test('GWT-3: 只有不相关的 plan 名时, execute 为 null (前缀不许放太宽)', () => {
    const path = ledgerWith([
      { plan: 'something-else', leavesIn: 999_999_999, ts: 1001 },
      { plan: 'map-execute', leavesIn: 999_999_999, ts: 1002 }, // 注意: 不以 goal-execute 开头
    ]);
    const b = readIgnitionBandwidth({ path });
    expect(b.execute).toBeNull();
  });

  // GWT-4 ── 账本文件不存在 ⇒ fail-open (不抛)
  test('GWT-4: 账本文件不存在时, fail-open 返 {null, null}, 不抛', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omd-ignition-pn-missing-'));
    dirs.push(dir);
    const nonexistent = join(dir, 'never-existed.db');
    expect(() => readIgnitionBandwidth({ path: nonexistent })).not.toThrow();
    expect(readIgnitionBandwidth({ path: nonexistent })).toEqual({ contract: null, execute: null });
  });

  // INV-6 / D-5: 「执行段曾以 goal-execute 落账, 后改 goal-execute-flat; 锁前缀是为了
  // 下一次再改名 (goal-execute-batch / -v2 / ... ) 不会重演同一个静默 bug。」
  // 这条用例模拟的就是那种"下次改名"的形状 —— 用一个从前没出现过的后缀,
  // **回滚 `=` 会让这条立刻红**。
  test('★ INV-6 / D-5 守卫: 执行段只以全新后缀落账时, 仍被前缀覆盖', () => {
    const path = ledgerWith([
      { plan: 'goal-execute-batch', leavesIn: 1_000_000, ts: 1001 },
      { plan: 'goal-execute-batch', leavesIn: 2_000_000, ts: 1002 },
    ]);
    const b = readIgnitionBandwidth({ path });
    expect(b.execute).not.toBeNull();
    expect(b.execute!.n).toBe(2); // 全新后缀仍被前缀抓住 —— 不需要改代码
  });

  // 契约段同样以前缀工作 (INV-2) —— 与执行段对称, 单独提一条防回滚
  test('★ INV-2: 契约段同样以前缀工作 — 以同族名开头的行全收', () => {
    const path = ledgerWith([
      { plan: 'goal-contract', leavesIn: 1_000_000, ts: 1001 },
      { plan: 'goal-contract-batch', leavesIn: 2_000_000, ts: 1002 },
    ]);
    const b = readIgnitionBandwidth({ path });
    expect(b.contract).not.toBeNull();
    expect(b.contract!.n).toBe(2);
  });

  // INV-4: usage 解析口径不变 (conductorIn + leavesIn, > 0 才计)
  test('★ INV-4: usage 解析口径不变 — conductorIn + leavesIn, 0 行被舍', () => {
    const path = ledgerWith([
      { plan: 'goal-execute-flat', leavesIn: 0, conductorIn: 0, ts: 1001 }, // 输入侧 0, 跳过
      { plan: 'goal-execute-flat', leavesIn: 600_000, conductorIn: 40_000, ts: 1002 }, // 实际有效
    ]);
    const b = readIgnitionBandwidth({ path });
    expect(b.execute).not.toBeNull();
    expect(b.execute!.n).toBe(1); // 第一行 0 被舍
    expect(b.execute!.median).toBe(640_000); // 60 + 40 = 640_000
  });
});
