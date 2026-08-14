/**
 * src/harness/goal/ignition-forecast.test —— 点火消耗预告的闸。
 *
 * **每条都写了怎么让它红。** 三条主闸:
 * ① 没历史 → `null` 且回执写「没记」,不是印 `0.00M`(NULL ≠ 0,本仓 §3 第 1 条);
 * ② 分布跨三个数量级 → 中位/p75/max 三个数都得在,少印一个就等于拿尾巴当中心;
 * ③ 无 sddPath 那句提示必须出现 —— 它是这一片存在的全部理由(纪律拦不住,回执才拦得住)。
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readIgnitionBandwidth, renderIgnitionForecast } from './ignition-forecast';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** 造一本只含 usage 的账本(列取真表的子集 —— 被测查询只读这几列)。 */
function ledgerWith(rows: { plan: string; leavesIn: number; conductorIn?: number; ts?: number }[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'omd-ignition-'));
  dirs.push(dir);
  const path = join(dir, 'dag-runs.db');
  const db = new Database(path);
  db.run(`CREATE TABLE omd_dag_runs (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, plan_name TEXT NOT NULL, usage TEXT NOT NULL)`);
  rows.forEach((r, i) => {
    db.run(`INSERT INTO omd_dag_runs (id, created_at, plan_name, usage) VALUES (?, ?, ?, ?)`, [
      `r${i}`,
      r.ts ?? 1000 + i,
      r.plan,
      JSON.stringify({ conductorIn: r.conductorIn ?? 0, leavesIn: r.leavesIn }),
    ]);
  });
  db.close();
  return path;
}

describe('readIgnitionBandwidth', () => {
  test('conductorIn + leavesIn 合成输入侧, 中位/p75/max 都出', () => {
    const path = ledgerWith([
      { plan: 'goal-contract', leavesIn: 1_000_000 },
      { plan: 'goal-contract', leavesIn: 2_000_000, conductorIn: 100_000 },
      { plan: 'goal-contract', leavesIn: 9_000_000 },
      { plan: 'goal-contract', leavesIn: 3_000_000 },
    ]);
    const b = readIgnitionBandwidth({ path });
    expect(b.contract).not.toBeNull();
    expect(b.contract!.n).toBe(4);
    expect(b.contract!.median).toBe(2_100_000); // conductorIn 真的算进去了 (不算的话是 2,000,000)
    expect(b.contract!.max).toBe(9_000_000);
    expect(b.execute).toBeNull(); // 这本账里没有执行段
  });

  test('★ 反向自检: 没有历史返 null, 不返 0', () => {
    // 证伪方式: 把 phaseOf 的 `if (vals.length === 0) return null` 改成返一个零值对象 → 这条红。
    const b = readIgnitionBandwidth({ path: ledgerWith([]) });
    expect(b.contract).toBeNull();
    expect(b.execute).toBeNull();
  });

  test('★ 反向自检: 账本不存在 / 读不动 → 预告缺席, 不抛 (fail-open, 点火不许被它挡下)', () => {
    // 证伪方式: 去掉 readIgnitionBandwidth 的 try/catch 或 existsSync 短路 → 这两条抛。
    expect(readIgnitionBandwidth({ path: '/nonexistent/nope.db' })).toEqual({ contract: null, execute: null });
    const dir = mkdtempSync(join(tmpdir(), 'omd-ignition-bad-'));
    dirs.push(dir);
    const bad = join(dir, 'bad.db');
    Bun.write(bad, 'this is not a sqlite file');
    expect(() => readIgnitionBandwidth({ path: bad })).not.toThrow();
  });

  test('limit 只看近期 —— 老行不该把中位数拖走', () => {
    const rows = [
      ...Array.from({ length: 5 }, (_, i) => ({ plan: 'goal-execute', leavesIn: 100_000, ts: 1000 + i })),
      ...Array.from({ length: 5 }, (_, i) => ({ plan: 'goal-execute', leavesIn: 50_000_000, ts: 2000 + i })),
    ];
    const path = ledgerWith(rows);
    expect(readIgnitionBandwidth({ path, limit: 5 }).execute!.median).toBe(50_000_000); // 近 5 跑全是大的
    expect(readIgnitionBandwidth({ path, limit: 10 }).execute!.median).toBe(100_000); // 放宽窗口 → 老的小跑把中位拖回去
    expect(readIgnitionBandwidth({ path, limit: 10 }).execute!.n).toBe(10);
  });
});

describe('renderIgnitionForecast', () => {
  const bw = {
    contract: { plan: 'goal-contract', n: 20, median: 1_860_866, p75: 4_808_958, max: 15_746_294 },
    execute: null,
  };

  test('★ 反向自检: 缺历史那一段写「没记」, 绝不印 0.00M', () => {
    // 证伪方式: 把 band() 里 null 分支换成 `m(0)` → 这条红。这正是把「没记」读成「不烧」的那一步。
    const text = renderIgnitionForecast({ coords: [], bandwidth: bw, sddPath: undefined });
    expect(text).toContain('没记');
    expect(text).not.toContain('0.00M');
  });

  test('中位 / p75 / max 三个数都在 (分布跨三个数量级, 单个数是误导)', () => {
    const text = renderIgnitionForecast({ coords: [], bandwidth: bw, sddPath: undefined });
    expect(text).toContain('中位 1.86M');
    expect(text).toContain('p75 4.81M');
    expect(text).toContain('max 15.75M');
    expect(text).toContain('近 20 跑');
  });

  test('★ 无 sddPath → 明说这趟会烧契约段; 有 sddPath → 明说跳过', () => {
    // 证伪方式: 删掉 renderIgnitionForecast 的 ② 段 → 两条都红。这一段是本片存在的理由。
    expect(renderIgnitionForecast({ coords: [], bandwidth: bw, sddPath: undefined })).toContain('会烧契约段');
    const withSdd = renderIgnitionForecast({ coords: [], bandwidth: bw, sddPath: 'docs/plan/x.md' });
    expect(withSdd).toContain('契约段跳过');
    expect(withSdd).toContain('docs/plan/x.md');
  });

  test('订阅额度与美元账分开摆 (混在一起会把「没花钱」读成「免费」)', () => {
    const text = renderIgnitionForecast({
      coords: [
        { label: 'conductor', coord: 'claude-code:opus' }, // channelOf 硬判订阅
        { label: 'leaf', coord: 'deepseek:deepseek-v4-flash' },
      ],
      bandwidth: bw,
      sddPath: undefined,
    });
    expect(text).toContain('订阅额度: conductor=claude-code:opus');
    expect(text).toContain('美元账: leaf=deepseek:deepseek-v4-flash');
  });

  test('没有坐标可报时不印那一行空标题', () => {
    expect(renderIgnitionForecast({ coords: [], bandwidth: bw, sddPath: undefined })).not.toContain('烧哪本账');
  });
});
