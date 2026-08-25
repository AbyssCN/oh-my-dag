/**
 * src/harness/inventory/health.test —— C-1 (片 1) 单元测试。
 *
 * 契约来源: src/harness/inventory/health.ts 顶部 INV 列表 + C-1 五条 GWT +
 * 验收 #2 (isExcluded 5 种组合逐条断言)。
 *
 * 本测试覆盖:
 *   ① GWT-1: deps 返 402 → PROBED_FAIL + failure_reason 非空;
 *   ② GWT-2: deps 抛错 → PROBE_ERROR (≠ PROBED_FAIL);
 *   ③ GWT-3: classifyApplicability 返 NOT_APPLICABLE → UNPROBED, 不剔;
 *   ④ GWT-4: 连续同状态 → recordProbeChange 第二行 written:false, 盘上一行;
 *   ⑤ GWT-5: 状态翻转 → 台账两行;
 *   ⑥ 验收 #2: isExcluded 真值表 4×3=12 组合, 仅 1 真;
 *   ⑦ INV-2: PROBE_STATES / APPLICABILITIES 字面值固定;
 *   ⑧ INV-5: 模块不 import bandit / dream / model-router (反向 grep 自检)。
 *
 * 断言一律 shape (toEqual) 或字面相等; 不只断 truthy —— shape assertion 是
 * 判别联合互斥与字段在场性的唯一可靠方式。
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  APPLICABILITIES,
  APPLICABLE,
  NOT_APPLICABLE,
  PROBE_ERROR,
  PROBE_STATES,
  PROBED_FAIL,
  PROBED_OK,
  UNKNOWN,
  UNPROBED,
  isExcluded,
  probeEntry,
  recordProbeChange,
  type Applicability,
  type ProbeChangeRecord,
  type ProbeDeps,
  type ProbeState,
} from './health';

// ─── 临时目录隔离 ────────────────────────────────────────────────────────────

const tmpDirs: string[] = [];
function tmpLedgerPath(): string {
  const d = mkdtempSync(join(tmpdir(), 'omd-health-'));
  tmpDirs.push(d);
  return join(d, 'inventory-probe.jsonl');
}
afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

// ─── ① GWT-1: 402 → PROBED_FAIL + failure_reason 非空 ────────────────────────
describe('C-1 ① GWT-1: deps 返 402 → PROBED_FAIL + failure_reason 非空', () => {
  test('callTool 返 {ok:false, reason:"402"} → probe_state=PROBED_FAIL', () => {
    const deps: ProbeDeps = {
      callTool: () => ({ ok: false, reason: '402' }),
    };
    const h = probeEntry({ id: 'core:foo@1.0.0' }, deps);
    expect(h).toEqual({
      probe_state: PROBED_FAIL,
      applicability: APPLICABLE,
      failure_reason: '402',
    });
  });

  test('failure_reason 任意非空字符串 → probe_state=PROBED_FAIL, isExcluded 真', () => {
    const deps: ProbeDeps = {
      callTool: () => ({ ok: false, reason: 'unknown-model' }),
    };
    const h = probeEntry({ id: 'core:foo@1.0.0' }, deps);
    expect(h.probe_state).toBe(PROBED_FAIL);
    expect(h.failure_reason).toBeTruthy();
    expect(h.failure_reason).toBe('unknown-model');
    expect(isExcluded(h)).toBe(true);
  });
});

// ─── ② GWT-2: 抛错 → PROBE_ERROR (不是 PROBED_FAIL) ─────────────────────────
describe('C-1 ② GWT-2: deps 抛错 → PROBE_ERROR ≠ PROBED_FAIL', () => {
  test('callTool throws → probe_state=PROBE_ERROR, applicability=APPLICABLE', () => {
    const deps: ProbeDeps = {
      callTool: () => {
        throw new Error('socket timeout after 5s');
      },
    };
    const h = probeEntry({ id: 'core:foo@1.0.0' }, deps);
    expect(h.probe_state).toBe(PROBE_ERROR);
    expect(h.applicability).toBe(APPLICABLE);
    // 关键区分: PROBE_ERROR 不带 failure_reason (D-4 探针没产出就不编)
    expect('failure_reason' in h).toBe(false);
  });

  test('PROBE_ERROR 不是 PROBED_FAIL —— 合并就犯 §静默坑 1', () => {
    const errDeps: ProbeDeps = {
      callTool: () => {
        throw new Error('network');
      },
    };
    const failDeps: ProbeDeps = {
      callTool: () => ({ ok: false, reason: '401' }),
    };
    const errHealth = probeEntry({ id: 'x:y@1' }, errDeps);
    const failHealth = probeEntry({ id: 'x:y@1' }, failDeps);
    // 两状态必须不同 — D-3 明文分开
    expect(errHealth.probe_state).not.toBe(failHealth.probe_state);
    // fail 剔, error 不剔 (D-5)
    expect(isExcluded(errHealth)).toBe(false);
    expect(isExcluded(failHealth)).toBe(true);
  });
});

// ─── ③ GWT-3: NOT_APPLICABLE → UNPROBED 且不剔 ─────────────────────────────
describe('C-1 ③ GWT-3: NOT_APPLICABLE → UNPROBED 且 isExcluded 假', () => {
  test('classifyApplicability 返 NOT_APPLICABLE → probe_state=UNPROBED, callTool 不调', () => {
    let called = 0;
    const deps: ProbeDeps = {
      callTool: () => {
        called++;
        return { ok: true };
      },
      classifyApplicability: () => NOT_APPLICABLE,
    };
    const h = probeEntry({ id: 'core:foo@1.0.0' }, deps);
    expect(called).toBe(0);
    expect(h.probe_state).toBe(UNPROBED);
    expect(h.applicability).toBe(NOT_APPLICABLE);
    expect(isExcluded(h)).toBe(false);
  });

  test('UNKNOWN 同样 → UNPROBED + 不调 callTool + 不剔', () => {
    let called = 0;
    const deps: ProbeDeps = {
      callTool: () => {
        called++;
        return { ok: true };
      },
      classifyApplicability: () => UNKNOWN,
    };
    const h = probeEntry({ id: 'core:foo@1.0.0' }, deps);
    expect(called).toBe(0);
    expect(h.probe_state).toBe(UNPROBED);
    expect(h.applicability).toBe(UNKNOWN);
    expect(isExcluded(h)).toBe(false);
  });

  test('缺省 oracle.kind=human → NOT_APPLICABLE (D-4 启发), callTool 不调', () => {
    let called = 0;
    const deps: ProbeDeps = {
      callTool: () => {
        called++;
        return { ok: true };
      },
    };
    const h = probeEntry(
      { id: 'core:foo@1.0.0', oracle: { kind: 'human' } },
      deps,
    );
    expect(called).toBe(0);
    expect(h.applicability).toBe(NOT_APPLICABLE);
  });
});

// ─── ⑥ 验收 #2: isExcluded 真值表 (4×3=12 组合, 仅 1 真) ───────────────────
describe('C-1 ⑥ 验收 #2: isExcluded 真值表 12 组合逐条', () => {
  test('PROBED_FAIL ∧ APPLICABLE → 真', () => {
    expect(
      isExcluded({ probe_state: PROBED_FAIL, applicability: APPLICABLE }),
    ).toBe(true);
  });

  // 其余 11 组合逐条断假 (test.each 把表格当字面量锁)
  const falseCases: Array<[ProbeState, Applicability]> = [
    [PROBED_FAIL, NOT_APPLICABLE],
    [PROBED_FAIL, UNKNOWN],
    [PROBED_OK, APPLICABLE],
    [PROBED_OK, NOT_APPLICABLE],
    [PROBED_OK, UNKNOWN],
    [PROBE_ERROR, APPLICABLE],
    [PROBE_ERROR, NOT_APPLICABLE],
    [PROBE_ERROR, UNKNOWN],
    [UNPROBED, APPLICABLE],
    [UNPROBED, NOT_APPLICABLE],
    [UNPROBED, UNKNOWN],
  ];
  for (const [ps, app] of falseCases) {
    test(`isExcluded(${ps}, ${app}) === false`, () => {
      expect(isExcluded({ probe_state: ps, applicability: app })).toBe(false);
    });
  }
});

// ─── ④ GWT-4: 同状态两次 → 台账只一行 ────────────────────────────────────────
describe('C-1 ④ GWT-4: 连续同状态 → 台账只一行', () => {
  test('两次同 (state, applicability, reason) → 第二行 written:false + 盘上一行', () => {
    const ledger = tmpLedgerPath();
    const rec1: ProbeChangeRecord = {
      tool_id: 'core:foo@1.0.0',
      probe_state: PROBED_OK,
      applicability: APPLICABLE,
      ts: '2026-01-01T00:00:00Z',
    };
    const rec2: ProbeChangeRecord = {
      ...rec1,
      ts: '2026-01-01T00:00:01Z', // ts 改但状态同 — ts 不参与同态判定
    };

    const r1 = recordProbeChange(ledger, rec1);
    const r2 = recordProbeChange(ledger, rec2);

    expect(r1).toEqual({ written: true });
    expect(r2.written).toBe(false);
    expect(r2.reason).toBe('same-as-last');

    const text = readFileSync(ledger, 'utf8');
    const lines = text.split('\n').filter((l) => l.length > 0);
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.tool_id).toBe('core:foo@1.0.0');
    expect(parsed.probe_state).toBe(PROBED_OK);
  });
});

// ─── ⑤ GWT-5: 状态翻转 → 台账两行 ──────────────────────────────────────────
describe('C-1 ⑤ GWT-5: 状态翻转 → 台账两行', () => {
  test('PROBED_OK → PROBED_FAIL → 台账两行 + 第二行带 failure_reason', () => {
    const ledger = tmpLedgerPath();
    const ok: ProbeChangeRecord = {
      tool_id: 'core:foo@1.0.0',
      probe_state: PROBED_OK,
      applicability: APPLICABLE,
      ts: '2026-01-01T00:00:00Z',
    };
    const fail: ProbeChangeRecord = {
      tool_id: 'core:foo@1.0.0',
      probe_state: PROBED_FAIL,
      applicability: APPLICABLE,
      failure_reason: '402',
      ts: '2026-01-01T00:01:00Z',
    };

    const r1 = recordProbeChange(ledger, ok);
    const r2 = recordProbeChange(ledger, fail);

    expect(r1.written).toBe(true);
    expect(r2.written).toBe(true);

    const text = readFileSync(ledger, 'utf8');
    const lines = text.split('\n').filter((l) => l.length > 0);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).probe_state).toBe(PROBED_OK);
    const second = JSON.parse(lines[1]!);
    expect(second.probe_state).toBe(PROBED_FAIL);
    expect(second.failure_reason).toBe('402');
  });

  test('tool_id 变 → 也算翻转 (前一条不能「吞掉」后一条不同工具的变更)', () => {
    const ledger = tmpLedgerPath();
    recordProbeChange(ledger, {
      tool_id: 'A:foo@1',
      probe_state: PROBED_OK,
      applicability: APPLICABLE,
      ts: 't0',
    });
    const r = recordProbeChange(ledger, {
      tool_id: 'B:bar@1',
      probe_state: PROBED_OK,
      applicability: APPLICABLE,
      ts: 't1',
    });
    expect(r.written).toBe(true);
    const text = readFileSync(ledger, 'utf8');
    const lines = text.split('\n').filter((l) => l.length > 0);
    expect(lines).toHaveLength(2);
  });

  test('台账首次写入 (文件不存在) → 直接追加', () => {
    const ledger = tmpLedgerPath();
    const r = recordProbeChange(ledger, {
      tool_id: 'core:foo@1.0.0',
      probe_state: PROBED_OK,
      applicability: APPLICABLE,
      ts: 't0',
    });
    expect(r.written).toBe(true);
    expect(r.reason).toBeUndefined();
  });
});

// ─── ⑦ INV-2: 枚举字面值锁定 ───────────────────────────────────────────────
describe('C-1 ⑦ INV-2: PROBE_STATES / APPLICABILITIES 字面值固定', () => {
  test('PROBE_STATES 字面值 (顺序 = 字符锁)', () => {
    expect([...PROBE_STATES]).toEqual([
      'UNPROBED',
      'PROBED_OK',
      'PROBED_FAIL',
      'PROBE_ERROR',
    ]);
  });
  test('APPLICABILITIES 字面值 (顺序 = 字符锁)', () => {
    expect([...APPLICABILITIES]).toEqual([
      'APPLICABLE',
      'NOT_APPLICABLE',
      'UNKNOWN',
    ]);
  });
});

// ─── ⑧ INV-5: 模块不 import bandit / dream / model-router (I-11) ────────────
describe('C-1 ⑧ INV-5: health.ts 不 import bandit / dream / model-router (反向 grep 自检)', () => {
  test('模块源码不含 forbidden import 路径', async () => {
    const srcPath = new URL('./health.ts', import.meta.url);
    const src = await Bun.file(srcPath).text();
    // import / from 字面含 bandit / dream / model-router 任一段 → 红
    // 正则贪婪最小集: `\bfrom\s+['"][^'"]*<forbidden>`
    const forbidden = ['bandit', 'dream', 'model-router'];
    for (const term of forbidden) {
      const re = new RegExp(`\\bfrom\\s+['"][^'"]*${term}`);
      expect(src).not.toMatch(re);
    }
    // 同时禁 dynamic import 与裸 require
    expect(src).not.toMatch(new RegExp(`import\\s*\\(['"][^'"]*bandit`));
    expect(src).not.toMatch(new RegExp(`import\\s*\\(['"][^'"]*dream`));
    expect(src).not.toMatch(new RegExp(`import\\s*\\(['"][^'"]*model-router`));
  });
});
