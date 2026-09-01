/**
 * scripts/bench-token-accounting —— bench A 臂 token 账的纯函数读数 (D4.2 GWT-4a/4b 抽出)。
 *
 * 历史: 原与 scripts/omd-bench.ts 同居(2026-08-14 起), 该入口是 omd-bench 7 题自建题库
 * 的 CLI; omd-bench 在 2026-09-01 owner 裁决下被删除(对「编排 vs 单干」无区分度, 当验收尺
 * 不合格), 但 `readArmTokens` 自身不绑 omd-bench —— 它从权威盘 `<dir>/.omd/runs.db`
 * 读任意 runId 的 token 聚合, 适用于任何 bench 轨(含 workbuddy 外部硬核轨, 见
 * docs/plan/NOTES.md:1233)。抽出后作为通用 bench 账本工具, bench-usage.test.ts 是它的
 * 机械闸。
 *
 * 三态(NULL≠0≠不适用, 仓规 D-3):
 *   · 盘上无该 run 行 → null + note (采集器没写穿或 runId 编的)
 *   · 终态无 result.usage → null + note (采集器跑空)
 *   · usage 全 0 (没真 LLM 调用 / probe-only) → null + note (**绝不记 0 冒充**)
 *   · 真数 → numbers, note 空串
 *
 * 不读子进程日志(D-3: 源不同账不会同); 只从 `<cwd>/.omd/runs.db` 这一权威面读。
 */
import { join } from 'node:path';
import { createRunStore, type RunStore } from '../src/mcp/run-store';
import type { ModelUsage } from '../src/model/types';

/** A 臂 token 账三态读数 (NULL≠0≠不适用)。空字符串 note = 真数。 */
export interface ArmTokenReading {
  tokensIn: number | null;
  tokensOut: number | null;
  /** 真数 → 空字符串; null → 解释, **不是 0**。 */
  note: string;
}

/**
 * 从权威盘 `<dir>/.omd/runs.db` 读 run 的 token 聚合 (导体+leaves+校验器; 探测段按 I-11
 * 隔离**不算**, 与 `computeCost` / `leafCostReward` 同源)。
 */
export function readArmTokens(dir: string, runId: string): ArmTokenReading {
  const dbPath = join(dir, '.omd', 'runs.db');
  let store: RunStore | null = null;
  try {
    store = createRunStore({ path: dbPath });
    const rec = store.get(runId);
    if (!rec) {
      return {
        tokensIn: null,
        tokensOut: null,
        note: `runs.db 无 runId=${runId} 行 (detached child 没写穿或 runId 编的)`,
      };
    }
    const result = rec.result as
      | {
          usage?: {
            conductor?: ModelUsage;
            leavesIn?: number;
            leavesOut?: number;
            verifier?: ModelUsage;
          };
        }
      | undefined;
    const u = result?.usage;
    if (!u) {
      return {
        tokensIn: null,
        tokensOut: null,
        note: `run ${runId} (${rec.status}) 已终态但 result.usage 缺席 — 采集器空跑 — 不是 0`,
      };
    }
    const inV = (u.leavesIn ?? 0) + (u.conductor?.in ?? 0) + (u.verifier?.in ?? 0);
    const outV = (u.leavesOut ?? 0) + (u.conductor?.out ?? 0) + (u.verifier?.out ?? 0);
    if (inV === 0 && outV === 0) {
      return {
        tokensIn: null,
        tokensOut: null,
        note: `run ${runId} (${rec.status}) usage 全 0 (没真 LLM 调用 / probe-only) — 三态纪律退 null`,
      };
    }
    return { tokensIn: inV, tokensOut: outV, note: '' };
  } catch (e) {
    return { tokensIn: null, tokensOut: null, note: `runs.db 读失败 (${(e as Error).message}) — 不是 0` };
  } finally {
    try {
      store?.close();
    } catch {
      /* 关不上不值得抛 (退出路径) */
    }
  }
}