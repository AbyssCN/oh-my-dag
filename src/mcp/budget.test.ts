/**
 * 周预算闸契约测试(SDD 2026-08-09 远程指挥接缝 §2 ECON)。
 *
 * **反向自检(每条都写明怎么让它红)**:
 * - 「超限真的拦」:把 `over: w.costUsd >= limitUsd` 改成 `false` → 拦不住那几条当场红;
 * - 「7 天窗口是滚动的」:把 `SEVEN_DAYS_MS` 改成 `Number.MAX_SAFE_INTEGER`(等于不滚)→
 *   「8 天前那笔不算」当场红(**已实测**:13 → 11 pass / 2 fail)。这条是本文件里最容易做成
 *   假闸的一格 —— 窗口若不滚,闸会在仓库第一次跑够 $50 之后**永久拒服务**,而所有
 *   "超限拦得住"的断言仍然全绿。第一版正是假的:时间戳从 `SEVEN_DAYS_MS` 自己推,
 *   改宽窗口测试跟着一起动,13/13 全绿 —— **量的是尺子**。现在写死天数,两侧都会红;
 * - 「读数不可用 ≠ 0」:把 `Number.isFinite` 那段删掉 → 缺 costUsd 的行让求和成 NaN,
 *   `NaN >= limit` 恒 false,闸**看起来绿着**地失效 —— 对应断言当场红;
 * - 「非法 env 不当关闸」:把 `resolveWeeklyLimitUsd` 的非法分支改成 `return 0` → 那条红;
 * - 「阀块形状不许漂」:把 `renderBudgetEscalation` 的 lane 改成别的字 → parseEscalation 认不出, 红。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_WEEKLY_BUDGET_USD,
  SEVEN_DAYS_MS,
  WEEKLY_BUDGET_ENV,
  checkWeeklyBudget,
  renderBudgetEscalation,
  renderBudgetLine,
  resetBudgetLedgerMemoForTest,
  resolveWeeklyLimitUsd,
  usageLedgerDir,
} from './budget';
import { parseEscalation } from './tools/chat';
import { USAGE_LEDGER_FILE, createTuiUsageLedger, type UsageRecord } from '../tui/usage/ledger';

const NOW = 1_800_000_000_000;
/** 窗口判据用**写死的天**, 不用被测常量推(见下面那条滚动窗口测试的注释)。 */
const DAY_MS = 24 * 60 * 60 * 1000;
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'omd-budget-'));
  // C-7 增量 memo 是模块级;测试里 writeFileSync **重写**账本(生产只 append + 合并缩小),
  // 不 reset 的话「同尺寸重写」会让偏移语义静默失真。
  resetBudgetLedgerMemoForTest();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** 写假账本行。`raw` 档用来造「缺字段的历史行」—— 那是真会出现的形态(账本演进过)。 */
const writeLedger = (rows: (Partial<UsageRecord> | string)[]): void =>
  writeFileSync(
    join(dir, USAGE_LEDGER_FILE),
    `${rows.map((r) => (typeof r === 'string' ? r : JSON.stringify({ ts: NOW - 1000, model: 'a:m', source: 'engine', in: 1, out: 1, cacheHit: 0, costUsd: 0, unpriced: false, ...r }))).join('\n')}\n`,
  );

const check = (env: NodeJS.ProcessEnv = {}) => checkWeeklyBudget({ dir, env, now: () => NOW });

describe('上限解析(OMD_WEEKLY_BUDGET_USD)', () => {
  test('未设 → 默认 $50;显式 0 → 关闸;正常数 → 照用', () => {
    expect(resolveWeeklyLimitUsd({})).toBe(DEFAULT_WEEKLY_BUDGET_USD);
    expect(resolveWeeklyLimitUsd({ [WEEKLY_BUDGET_ENV]: '0' })).toBe(0);
    expect(resolveWeeklyLimitUsd({ [WEEKLY_BUDGET_ENV]: '12.5' })).toBe(12.5);
  });

  test('★ 非法值不当成关闸 —— 回落默认(打错一个字符 = 闸悄悄没了, 那是最贵的静默失效)', () => {
    expect(resolveWeeklyLimitUsd({ [WEEKLY_BUDGET_ENV]: 'fifty' })).toBe(DEFAULT_WEEKLY_BUDGET_USD);
    expect(resolveWeeklyLimitUsd({ [WEEKLY_BUDGET_ENV]: '-5' })).toBe(DEFAULT_WEEKLY_BUDGET_USD);
  });
});

describe('滚动 7 天窗口聚合', () => {
  test('★ 一行 $100 → 超限(默认上限 $50)', () => {
    writeLedger([{ costUsd: 100 }]);
    const s = check();
    expect(s.over).toBe(true);
    expect(s.costUsd).toBe(100);
    expect(s.calls).toBe(1);
  });

  test('$49.99 → 不超;$50 整 → 超(边界含等号: 判据是「已达上限」)', () => {
    writeLedger([{ costUsd: 49.99 }]);
    expect(check().over).toBe(false);
    writeLedger([{ costUsd: 50 }]);
    expect(check().over).toBe(true);
  });

  test('多行求和(账本自己的 sum, 这里不另写解析)', () => {
    writeLedger([{ costUsd: 30 }, { costUsd: 25 }]);
    expect(check().costUsd).toBeCloseTo(55, 5);
    expect(check().over).toBe(true);
  });

  test('★ 窗口是滚动的且宽度就是 7 天:8 天前那笔 $100 不算, 6 天前那笔 $1 要算', () => {
    // ⚠ 这两个时间戳**故意不从 SEVEN_DAYS_MS 推**:第一版写成 `NOW - SEVEN_DAYS_MS - 1`,
    //   把窗宽改成 MAX_SAFE_INTEGER 之后测试跟着一起动, 13/13 仍全绿 —— 那一版量的是尺子自己。
    //   写死天数之后它两侧都会红:窗变宽 → 8 天前那笔算进来 → over 变 true;
    //   窗变窄 → 6 天前那笔掉出去 → calls/costUsd 少一笔。
    writeLedger([{ costUsd: 100, ts: NOW - DAY_MS * 8 }, { costUsd: 1, ts: NOW - DAY_MS * 6 }]);
    const s = check();
    expect(s.costUsd).toBeCloseTo(1, 5);
    expect(s.calls).toBe(1);
    expect(s.over).toBe(false);
    expect(SEVEN_DAYS_MS).toBe(DAY_MS * 7); // 常量本身也钉一下(上面两条不依赖它)
  });

  test('空账本 / 无账本文件 → 不拦, 且 calls=0 标明是「没记」(不等于「没花」)', () => {
    expect(check().over).toBe(false);
    expect(check().calls).toBe(0);
  });
});

describe('NULL ≠ 0 ≠ 不适用', () => {
  test('★ 未计价行算不进钱 → 判词说「≥」(已计价部分是下界, 不冒充真值)', () => {
    writeLedger([{ costUsd: 10 }, { costUsd: 0, unpriced: true, model: 'nobody:mystery' }]);
    const s = check();
    expect(s.costUsd).toBeCloseTo(10, 5); // 未计价那笔的 0 不是「花了 0」
    expect(s.unpriced).toBe(true);
    expect(s.over).toBe(false); // 只拿已计价部分比 —— 偏保守放行
    expect(renderBudgetLine(s)).toContain('≥ $10.00');
    expect(renderBudgetLine(s)).toContain('下界');
  });

  test('★ 缺 costUsd 的行 → 读数不可用(costUsd=null), fail-open 放行 —— 不可用不是 0', () => {
    writeLedger([{ costUsd: 100 }, '{"ts":' + (NOW - 1) + ',"model":"a:m","source":"engine","in":1,"out":1}']);
    const s = check();
    expect(s.costUsd).toBeNull(); // 编成 0 就把「尺子坏了」读成「没花钱」
    expect(s.over).toBe(false);
    expect(renderBudgetLine(s)).toContain('读数不可用');
  });

  test('坏 JSON 行由账本自己跳过, 好行照算(不影响闸)', () => {
    writeLedger(['{oops', { costUsd: 100 }]);
    expect(check().over).toBe(true);
  });

  test('闸关(=0)→ 不读盘也不拦, costUsd=null 表示「不适用」而不是 $0', () => {
    writeLedger([{ costUsd: 100 }]);
    const s = check({ [WEEKLY_BUDGET_ENV]: '0' });
    expect(s.over).toBe(false);
    expect(s.enabled).toBe(false);
    expect(s.costUsd).toBeNull();
  });
});

describe('上报块与账本目录', () => {
  test('★ 超限块能被 S2 的 parseEscalation 认出且 lane=owner(两处形状不许漂)', () => {
    writeLedger([{ costUsd: 100 }]);
    const block = renderBudgetEscalation(check());
    expect(parseEscalation(block)?.lane).toBe('owner');
    expect(block).toContain('$100.00');
    expect(block).toContain(WEEKLY_BUDGET_ENV); // owner 要知道旋钮叫什么才裁得了
  });

  test('账本目录与 harness/cli.ts 同一条解析(OMD_TUI_USAGE_DIR 覆盖 cwd/.omd)', () => {
    expect(usageLedgerDir('/repo', {})).toBe(join('/repo', '.omd'));
    expect(usageLedgerDir('/repo', { OMD_TUI_USAGE_DIR: '/tmp/x' })).toBe('/tmp/x');
  });
});

describe('C-7 增量读 —— 与全量重算逐分等价 (禁 TTL)', () => {
  const appendRows = (rows: Partial<UsageRecord>[]): void => {
    const { appendFileSync } = require('node:fs') as typeof import('node:fs');
    appendFileSync(
      join(dir, USAGE_LEDGER_FILE),
      `${rows.map((r) => JSON.stringify({ ts: NOW - 1000, model: 'a:m', source: 'engine', in: 1, out: 1, cacheHit: 0, costUsd: 0, unpriced: false, ...r })).join('\n')}\n`,
    );
  };
  /** 全量参照:与生产旧路径同一实现 (createTuiUsageLedger 整本读)。 */
  const fullReference = () => {
    const w = createTuiUsageLedger({ dir, now: () => NOW }).window(SEVEN_DAYS_MS);
    return { calls: w.calls, costUsd: w.costUsd, unpriced: w.unpriced };
  };
  const incremental = () => {
    const s = check();
    return { calls: s.calls, costUsd: s.costUsd ?? Number.NaN, unpriced: s.unpriced };
  };

  // 证伪方式 (当场验过): readWeeklyWindow 里把 `r.ts < since` 的 continue 删掉 →
  // 「窗外行」参照/增量不等, 本测试红; 恢复后绿。
  test('★ 首读 + append 追加后, 与全量重算逐分相等 (含窗外行/坏行/未计价行)', () => {
    writeLedger([
      { costUsd: 3 },
      { costUsd: 2, ts: NOW - 8 * DAY_MS }, // 窗外
      'not-json-至-坏行',
      { costUsd: 1, unpriced: true },
    ]);
    expect(incremental()).toEqual(fullReference());
    appendRows([{ costUsd: 5 }, { costUsd: 7, ts: NOW - 6 * DAY_MS }]);
    expect(incremental()).toEqual(fullReference()); // 追加只读新增字节, 结果仍逐分相等
  });

  test('★ 落实护栏: 文件缩小 (尺寸 < 偏移) → memo 作废整本重读, 不吐陈旧和', () => {
    writeLedger([{ costUsd: 10 }, { costUsd: 20 }, { costUsd: 30 }]);
    expect(incremental().costUsd).toBe(60);
    writeLedger([{ costUsd: 1 }]); // 模拟合并: 重写成更小的文件
    expect(incremental()).toEqual(fullReference());
    expect(incremental().costUsd).toBe(1);
  });

  test('半行容忍: 尾部无换行的半行不计入, 补全后下一读计入', () => {
    const { appendFileSync } = require('node:fs') as typeof import('node:fs');
    writeLedger([{ costUsd: 2 }]);
    expect(incremental().costUsd).toBe(2);
    const row = JSON.stringify({ ts: NOW - 500, model: 'a:m', source: 'engine', in: 1, out: 1, cacheHit: 0, costUsd: 9, unpriced: false });
    appendFileSync(join(dir, USAGE_LEDGER_FILE), row.slice(0, 20)); // 写者写到一半
    expect(incremental().costUsd).toBe(2); // 半行不计入也不炸
    appendFileSync(join(dir, USAGE_LEDGER_FILE), `${row.slice(20)}\n`); // 写完
    expect(incremental().costUsd).toBe(11);
  });
});
