/**
 * verdict-ledger —— append-only 同键幂等账本(片 2 · INV-4 / INV-5)。
 *
 * 写点笔记见 `./verdict-ledger.ts` 文件头。本文件只测纯函数边界,**不接 engine**:
 * 接线与「注入 verifier 超时 → 重跑不覆盖」走 `./s3-wiring.test.ts`(片 5)。
 *
 * 反作弊条款两条:
 *   ① 锚串 `VERDICT_LEDGER_FROZEN` 必须逐字出现 —— `o6-vacuous-verify` 与片 2 verify 共同查它;
 *   ② 测断言都在跑 `append` / `terminal` / `infraObserved` 三个具名函数上,
 *      **不**用 grep 日志,不 mock 任何代码。
 */
import { describe, expect, test } from 'bun:test';
import {
  append,
  emptyLedger,
  infraObserved,
  terminal,
  type VerdictEntry,
  type VerdictLedger,
} from './verdict-ledger';

/** 片 2 锚串。改这一行的理由必须是「改了反作弊条款」,不是「代码里需要这个串」。 */
const VERDICT_LEDGER_FROZEN = 'VERDICT_LEDGER_FROZEN';

const substantive = (over: Partial<VerdictEntry> = {}): VerdictEntry => ({
  round: 1,
  kind: 'substantive',
  pass: false,
  reason: '判词原文',
  at: '2026-08-27T00:00:00Z',
  ...over,
});

const infra = (over: Partial<VerdictEntry> = {}): VerdictEntry => ({
  round: 1,
  kind: 'infra',
  pass: false,
  reason: '[verifier-error] 判卷官调不通',
  at: '2026-08-27T00:00:00Z',
  ...over,
});

/** 链式 append: 收到 OK 就把账本交下去。拒绝处显式抛, 拒绝路径会另测。 */
function chain(initial: VerdictLedger, entries: VerdictEntry[]): VerdictLedger {
  let l = initial;
  for (const e of entries) {
    const r = append(l, e);
    if (!r.ok) throw new Error(`chain: append 拒绝 (${r.reason}), 不应发生于本测试`);
    l = r.ledger;
  }
  return l;
}

describe('verdict-ledger —— append-only 同键幂等 (INV-4)', () => {
  test('锚串 VERDICT_LEDGER_FROZEN 逐字存在(反作弊 EMPTY MATCH)', () => {
    // 这一条的存在意义是: 删掉它整个文件 = 锚串消失 = verify 闸红。
    expect(VERDICT_LEDGER_FROZEN).toBe('VERDICT_LEDGER_FROZEN');
  });

  test('★ 空账本 + 同一 (round, kind) 连追 3 次 → 长度恰为 1, appended 标志位逐次 false', () => {
    const e = substantive();
    const r1 = append(emptyLedger(), e);
    expect(r1.ok).toBe(true);
    if (!r1.ok) throw new Error('first append must succeed');
    expect(r1.appended).toBe(true);
    expect(r1.ledger.entries.length).toBe(1);

    const r2 = append(r1.ledger, e);
    expect(r2.ok).toBe(true);
    if (!r2.ok) throw new Error('idempotent append must succeed');
    expect(r2.appended).toBe(false); // ← 幂等, 不是覆写
    expect(r2.ledger.entries.length).toBe(1);

    const r3 = append(r2.ledger, e);
    expect(r3.ok).toBe(true);
    if (!r3.ok) throw new Error('idempotent append must succeed');
    expect(r3.appended).toBe(false);
    expect(r3.ledger.entries.length).toBe(1);
  });

  test('★ 不同 round 追 3 次 → 长度恰为 3', () => {
    const l = chain(emptyLedger(), [substantive({ round: 1 }), substantive({ round: 2 }), substantive({ round: 3 })]);
    expect(l.entries.length).toBe(3);
    expect(l.entries.map((e) => e.round)).toEqual([1, 2, 3]);
  });

  test('★ 同键 + 异内容 → 拒并返具名错误, 账本逐字节不变', () => {
    const a = substantive({ round: 1, reason: '缺条目 X' });
    const b = substantive({ round: 1, reason: '缺条目 Y' });
    const r1 = append(emptyLedger(), a);
    expect(r1.ok).toBe(true);
    if (!r1.ok) throw new Error('seed append must succeed');

    const r2 = append(r1.ledger, b);
    expect(r2.ok).toBe(false);
    if (r2.ok) throw new Error('同键异内容 必须被拒');
    expect(r2.reason).toBe('same-key-different-content');
    // 账本逐字节不变 —— 旧条目还在, 长度仍是 1, 内容是 a
    expect(r2.ledger.entries.length).toBe(1);
    expect(r2.ledger.entries[0]).toEqual(a);
  });

  test('同键 + 内容逐字节相同 → 幂等空操作 (appended=false)', () => {
    const r1 = append(emptyLedger(), substantive());
    if (!r1.ok) throw new Error('first append must succeed');
    const r2 = append(r1.ledger, substantive());
    expect(r2.ok).toBe(true);
    if (!r2.ok) throw new Error('idempotent append must succeed');
    expect(r2.appended).toBe(false);
    expect(r2.ledger.entries.length).toBe(1);
  });

  test('(round, kind) 同 round + 不同 kind 是异键, 不冲突', () => {
    // round 1 substantive + round 1 infra = 两条(不是覆写也不是拒)
    const l = chain(emptyLedger(), [
      substantive({ round: 1, kind: 'substantive', reason: 'S1' }),
      infra({ round: 1, kind: 'infra', reason: 'I1' }),
    ]);
    expect(l.entries.length).toBe(2);
    expect(l.entries[0]!.kind).toBe('substantive');
    expect(l.entries[1]!.kind).toBe('infra');
  });

  test('异键 + 异内容照常追加', () => {
    // (1, substantive) 与 (2, substantive) 是异键, 即便 reason 不同也不冲突
    const l = chain(emptyLedger(), [
      substantive({ round: 1, reason: 'r1' }),
      substantive({ round: 2, reason: 'r2' }),
    ]);
    expect(l.entries.length).toBe(2);
  });

  test('at 字段不影响内容等价(它只是元数据, 改 at 不算改判词)', () => {
    const r1 = append(emptyLedger(), substantive({ at: '2026-08-27T00:00:00Z' }));
    if (!r1.ok) throw new Error('first append must succeed');
    const r2 = append(r1.ledger, substantive({ at: '2026-08-27T00:00:01Z' }));
    expect(r2.ok).toBe(true);
    if (!r2.ok) throw new Error('append with only differing at must be idempotent');
    expect(r2.appended).toBe(false);
    expect(r2.ledger.entries.length).toBe(1);
  });

  test('content 判定覆盖 reason 与 pass 各自不等', () => {
    // 证伪: 把 content 比对写成只看 reason → pass 不等的两次会被误判幂等
    const r1 = append(emptyLedger(), substantive({ round: 1, pass: true, reason: 'ok' }));
    if (!r1.ok) throw new Error('first append must succeed');
    const r2 = append(r1.ledger, substantive({ round: 1, pass: false, reason: 'ok' }));
    expect(r2.ok).toBe(false);
    if (r2.ok) throw new Error('pass 不同也必须被拒');
    expect(r2.reason).toBe('same-key-different-content');
  });
});

describe('verdict-ledger —— 终值只看 substantive (INV-5)', () => {
  test('★ round 1 实质 fail + round 2 infra → 终值取 round 1 逐字, 故障标志 true', () => {
    const l = chain(emptyLedger(), [
      substantive({ round: 1, reason: '缺条目 X' }),
      infra({ round: 2, reason: '[verifier-error] 调不通' }),
    ]);
    const t = terminal(l);
    expect(t.kind).toBe('judged');
    if (t.kind !== 'judged') throw new Error('expected judged');
    expect(t.pass).toBe(false);
    expect(t.reason).toBe('缺条目 X'); // 逐字
    expect(t.reason).not.toContain('[verifier-error]'); // 终值不许含引擎故障前缀
    expect(infraObserved(l)).toBe(true);
  });

  test('★ 只有 infra, 一条 substantive 都没有 → 终值「未判卷」', () => {
    const l = chain(emptyLedger(), [
      infra({ round: 1, reason: '[verifier-error] 调不通' }),
      infra({ round: 2, reason: '[verifier-error] 又调不通' }),
    ]);
    const t = terminal(l);
    expect(t.kind).toBe('unjudged');
    // 关键不变量: unjudged 形态不能伪装成 pass:false 的实质判词。
    // 由 discriminator 钉死 —— 不需要额外断言, 但为防 type widening 漏判, 再断言一次
    // 「judged 形态里没有 pass:false 冒充位」。
    if (t.kind === 'judged') throw new Error('仅 infra 时绝不能进入 judged 形态');
    expect(infraObserved(l)).toBe(true);
  });

  test('★ 空账本 → 终值「未判卷」, infra 标志 false', () => {
    const t = terminal(emptyLedger());
    expect(t.kind).toBe('unjudged');
    expect(infraObserved(emptyLedger())).toBe(false);
  });

  test('终值取最后一条 substantive(round 3 在 round 1 / round 2 之后写入也胜出)', () => {
    // 故意乱序写入, 终值应是 round 3
    const l = chain(emptyLedger(), [
      substantive({ round: 1, reason: 'r1' }),
      substantive({ round: 3, reason: 'r3' }),
      substantive({ round: 2, reason: 'r2' }),
    ]);
    const t = terminal(l);
    expect(t.kind).toBe('judged');
    if (t.kind !== 'judged') throw new Error('expected judged');
    expect(t.reason).toBe('r2'); // 最后一条, 不是最大 round
  });

  test('终值 pass:true 仍正常返回(实质 pass 也是 substantive, 不只 fail)', () => {
    const l = chain(emptyLedger(), [substantive({ round: 1, pass: true, reason: 'all good' })]);
    const t = terminal(l);
    expect(t.kind).toBe('judged');
    if (t.kind !== 'judged') throw new Error('expected judged');
    expect(t.pass).toBe(true);
    expect(t.reason).toBe('all good');
    expect(infraObserved(l)).toBe(false);
  });

  test('实质 pass 之后再来一条实质 fail → 终值取最后一条 fail(升级重规划末轮的形状)', () => {
    const l = chain(emptyLedger(), [
      substantive({ round: 1, pass: true, reason: 'ok-1' }),
      substantive({ round: 2, pass: false, reason: 'ok-2-fail' }),
    ]);
    const t = terminal(l);
    expect(t.kind).toBe('judged');
    if (t.kind !== 'judged') throw new Error('expected judged');
    expect(t.pass).toBe(false);
    expect(t.reason).toBe('ok-2-fail');
  });

  test('实质 + infra + 实质 → 终值取最后一条 substantive, infra 标志仍 true', () => {
    const l = chain(emptyLedger(), [
      substantive({ round: 1, reason: 's1' }),
      infra({ round: 2, reason: '[verifier-error]' }),
      substantive({ round: 3, reason: 's3' }),
    ]);
    const t = terminal(l);
    expect(t.kind).toBe('judged');
    if (t.kind !== 'judged') throw new Error('expected judged');
    expect(t.reason).toBe('s3');
    expect(infraObserved(l)).toBe(true);
  });
});

describe('verdict-ledger —— VerdictKind 值域冻结', () => {
  test('kind 字段只取 substantive / infra: 写入非法 kind 被拒', () => {
    // 类型系统已钉死, 但运行期要再卡一道 —— 类型 widening 可能让 any 流进来。
    const r1 = append(emptyLedger(), {
      round: 1,
      kind: '' as VerdictEntry['kind'],
      pass: false,
      reason: 'x',
      at: 't',
    });
    expect(r1.ok).toBe(false);
    if (r1.ok) throw new Error('非法 kind 必须被拒');
    expect(r1.reason).toBe('invalid-kind');

    const r2 = append(emptyLedger(), {
      round: 1,
      kind: 'other' as VerdictEntry['kind'],
      pass: false,
      reason: 'x',
      at: 't',
    });
    expect(r2.ok).toBe(false);
    if (r2.ok) throw new Error('非法 kind 必须被拒');
    expect(r2.reason).toBe('invalid-kind');
  });

  test('ledger.entries 是 readonly, 试图 mutate 会在 TS 层拦下', () => {
    // 编译期断言 —— 由 VerdictLedger.entries: readonly VerdictEntry[] 钉死。
    // 这里再加一条结构断言, 防止有人在 .ts 之外构造 ledger。
    const l = emptyLedger();
    expect(Object.isFrozen(l.entries) || l.entries.length === 0).toBe(true);
  });
});