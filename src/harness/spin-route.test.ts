/**
 * spin-route 模块 — 反向自检 (2026-08-25, SDD §4 片 S1)。
 *
 * ## 钉的是什么
 *
 * 把「空转档 1 注入」从**灵感**提到**机制**:四件套缺槽如实 + 哈希稳定 + 具名判据 +
 * 重复包拒注。活体接线在 agent-leaf-spin-route.test.ts(片 2),本文件只钉纯函数契约。
 *
 * 反向自检清单(改这块前先跑一遍;**下面是实跑读数,不是预期**):
 * - 删 `packHash` 字段 → 「哈希稳定」红、「同输入同包」红。
 * - `judgeRungOutcome` 把 touchedNow>touchedBefore 改成 >= → 「touched 增长」红。
 * - `samePack` 用 deepEqual 而非哈希 → 「重复包拒注」可能误红(对象同但哈希被改) → 留 invariant。
 * - 把 no-history 字面改成 '' → 「字面逐字」红。
 */
import { describe, expect, it } from 'bun:test';
import {
  RUNG_1,
  SPIN_ROUTE_OBSERVATION_KIND,
  SPIN_ROUTE_OUTCOMES,
  SPIN_ROUTE_SDK_SKIP_LOG,
  buildSpinEvidencePack,
  judgeRungOutcome,
  samePack,
  spinRouteEnvEnabled,
} from './spin-route';

const FULL_INPUT = {
  failSig: 'bash:sleep 1; ls /tmp',
  sameCount: 7,
  failSetBefore: ['test:shell-exit', 'test:write-visibility'],
  failSetNow: ['test:write-visibility'],
  watchdogFinding: '[leaf-spin] sameCount=7 ringSize=3 for 12s',
  advisorLines: ['诊断:产出叶只读不写', '下一步:用 bash 直接写产物到 /tmp/x.ts'] as const,
};

describe('常数与开关 (片 1 公共契约)', () => {
  it('RUNG_1 === 1 (档位常数具名,改值会级联跑偏)', () => {
    expect(RUNG_1).toBe(1);
  });
  it('SPIN_ROUTE_OBSERVATION_KIND === "spin-route" (observation kind,engine 侧按字符串分发)', () => {
    expect(SPIN_ROUTE_OBSERVATION_KIND).toBe('spin-route');
  });
  it('SPIN_ROUTE_OUTCOMES 四态全在 (D-5 observation 字段契约)', () => {
    expect([...SPIN_ROUTE_OUTCOMES].sort()).toEqual(['fail', 'injected', 'sdk-bypass', 'success']);
  });
  it('SPIN_ROUTE_SDK_SKIP_LOG 是具名文案,含「档 1」「SDK 通道」「不启用」三要素 (I-6)', () => {
    expect(typeof SPIN_ROUTE_SDK_SKIP_LOG).toBe('string');
    expect(SPIN_ROUTE_SDK_SKIP_LOG).toContain('档 1');
    expect(SPIN_ROUTE_SDK_SKIP_LOG).toContain('SDK 通道');
    expect(SPIN_ROUTE_SDK_SKIP_LOG).toContain('不启用');
  });
});

describe('env 开关 (OMD_SPIN_ROUTE=0 旁路, INV-8)', () => {
  it('OMD_SPIN_ROUTE 未设 → 开', () => {
    expect(spinRouteEnvEnabled({})).toBe(true);
  });
  it('OMD_SPIN_ROUTE=1 / OMD_SPIN_ROUTE=true → 开(非 "0" 全部按开处理)', () => {
    expect(spinRouteEnvEnabled({ OMD_SPIN_ROUTE: '1' })).toBe(true);
    expect(spinRouteEnvEnabled({ OMD_SPIN_ROUTE: 'true' })).toBe(true);
  });
  it('OMD_SPIN_ROUTE=0 → 关 (对照臂,与 OMD_SELF_CHECK=0 同模式)', () => {
    expect(spinRouteEnvEnabled({ OMD_SPIN_ROUTE: '0' })).toBe(false);
  });
});

describe('buildSpinEvidencePack 四件套 (C-1 INV-1)', () => {
  it('★ 完整输入:四件套原文 + packHash 稳定 (GWT G-W-T)', () => {
    const a = buildSpinEvidencePack(FULL_INPUT);
    const b = buildSpinEvidencePack(FULL_INPUT);
    expect(a.failSig).toBe(FULL_INPUT.failSig);
    expect(a.sameCount).toBe(FULL_INPUT.sameCount);
    expect(a.watchdogFinding).toBe(FULL_INPUT.watchdogFinding);
    expect(a.advisorLines).toEqual(FULL_INPUT.advisorLines);
    // criteriaDiff = diff,两条都非空
    expect(a.criteriaDiff.kind).toBe('diff');
    if (a.criteriaDiff.kind === 'diff') {
      expect(a.criteriaDiff.added).toEqual([]); // 没新增红
      expect(a.criteriaDiff.removed).toEqual(['test:shell-exit']); // shell-exit 消红
    }
    // 同输入两次同哈希
    expect(a.packHash).toBe(b.packHash);
    expect(a.packHash).toMatch(/^[0-9a-f]{64}$/); // sha256 hex
  });

  it('★ 无 self_check 史:diff 槽 = 「本节点无 self_check,无判据可 diff」字面, NULL ≠ 编造 (GWT G-W-T I-7)', () => {
    const pack = buildSpinEvidencePack({ ...FULL_INPUT, failSetBefore: null, failSetNow: null });
    expect(pack.criteriaDiff).toEqual({
      kind: 'no-history',
      literal: '本节点无 self_check,无判据可 diff',
    });
    // 字面逐字不变(改一字全仓读数偏差,钉在测试里)
    expect(pack.criteriaDiff.kind === 'no-history' && pack.criteriaDiff.literal).toBe(
      '本节点无 self_check,无判据可 diff',
    );
  });

  it('无 sameCount 时不编 0 (drift 没给 sameCount 不假设 0,NULL 透传)', () => {
    const pack = buildSpinEvidencePack({ ...FULL_INPUT, sameCount: undefined });
    expect(pack.sameCount).toBeUndefined();
  });

  it('failSet 两边都有但完全相同 → diff 两数组都空 (不是 no-history)', () => {
    const same = ['test:A', 'test:B'];
    const pack = buildSpinEvidencePack({ ...FULL_INPUT, failSetBefore: same, failSetNow: same });
    expect(pack.criteriaDiff.kind).toBe('diff');
    if (pack.criteriaDiff.kind === 'diff') {
      expect(pack.criteriaDiff.added).toEqual([]);
      expect(pack.criteriaDiff.removed).toEqual([]);
    }
  });

  it('★ 哈希稳定:同输入两次构包 → packHash 字节相等 (GWT G-W-T 反复构包可重现)', () => {
    const hashes = new Set<string>();
    for (let i = 0; i < 10; i++) hashes.add(buildSpinEvidencePack(FULL_INPUT).packHash);
    expect(hashes.size).toBe(1);
  });

  it('★ 哈希区分:failSig 改一字 → packHash 变 (改的不是冗余字段)', () => {
    const a = buildSpinEvidencePack(FULL_INPUT);
    const b = buildSpinEvidencePack({ ...FULL_INPUT, failSig: 'bash:sleep 2; ls /tmp' });
    expect(a.packHash).not.toBe(b.packHash);
  });

  it('★ 哈希区分:advisorLines 改一字 → packHash 变', () => {
    const a = buildSpinEvidencePack(FULL_INPUT);
    const b = buildSpinEvidencePack({ ...FULL_INPUT, advisorLines: ['诊断:产出叶只读不写', '下一步:现在写产物'] as const });
    expect(a.packHash).not.toBe(b.packHash);
  });

  it('advisorLines 两行次序有语义 → 交换顺序 → 哈希变 (行序是判据一部分)', () => {
    const a = buildSpinEvidencePack(FULL_INPUT);
    const swapped: [string, string] = [FULL_INPUT.advisorLines[1], FULL_INPUT.advisorLines[0]];
    const b = buildSpinEvidencePack({ ...FULL_INPUT, advisorLines: swapped });
    expect(a.packHash).not.toBe(b.packHash);
  });
});

describe('samePack 重复包拒注 (C-1 INV-3, I-2)', () => {
  it('★ 同包两次 → samePack=true (GWT G-W-T:逐字相同调用方拒注)', () => {
    const a = buildSpinEvidencePack(FULL_INPUT);
    const b = buildSpinEvidencePack(FULL_INPUT);
    expect(samePack(a, b)).toBe(true);
  });
  it('不同输入 → samePack=false', () => {
    const a = buildSpinEvidencePack(FULL_INPUT);
    const b = buildSpinEvidencePack({ ...FULL_INPUT, failSig: 'bash:ls' });
    expect(samePack(a, b)).toBe(false);
  });
  it('只接 packHash 字段,不要求完整 SpinEvidencePack 形状 (结构化传参,不易传错)', () => {
    expect(samePack({ packHash: 'aaa' }, { packHash: 'aaa' })).toBe(true);
    expect(samePack({ packHash: 'aaa' }, { packHash: 'bbb' })).toBe(false);
  });
});

describe('judgeRungOutcome 具名判据 (C-1 INV-2, D-3)', () => {
  it('★ touched 增长 → success (GWT G-W-T)', () => {
    expect(judgeRungOutcome({ touchedBefore: 5, touchedNow: 6, failSetBefore: null, failSetNow: null })).toBe('success');
  });
  it('★ failSet 严格缩小 → success (GWT G-W-T)', () => {
    expect(judgeRungOutcome({
      touchedBefore: 5,
      touchedNow: 5,
      failSetBefore: ['A', 'B'],
      failSetNow: ['B'],
    })).toBe('success');
  });
  it('★ 两者皆无 → fail (GWT G-W-T:再次命中空转口径)', () => {
    expect(judgeRungOutcome({ touchedBefore: 5, touchedNow: 5, failSetBefore: ['A'], failSetNow: ['A'] })).toBe('fail');
  });
  it('touched 未增长 + failSet 反而新增 → fail (新增失败不是成功)', () => {
    expect(judgeRungOutcome({
      touchedBefore: 5,
      touchedNow: 5,
      failSetBefore: ['A'],
      failSetNow: ['A', 'B'],
    })).toBe('fail');
  });
  it('★ touched 倒退 → fail (防御性,默认调用方守序但不强假设)', () => {
    expect(judgeRungOutcome({ touchedBefore: 5, touchedNow: 4, failSetBefore: null, failSetNow: null })).toBe('fail');
  });
  it('failSet 一侧 null → failSet 比较不参与,只看 touched (NULL 不编造)', () => {
    expect(judgeRungOutcome({ touchedBefore: 0, touchedNow: 0, failSetBefore: null, failSetNow: null })).toBe('fail');
    expect(judgeRungOutcome({ touchedBefore: 0, touchedNow: 1, failSetBefore: null, failSetNow: null })).toBe('success');
  });
  it('failSet 缩小与 touched 增长同时存在 → success (任一即可,或关系非与)', () => {
    expect(judgeRungOutcome({
      touchedBefore: 5,
      touchedNow: 6,
      failSetBefore: ['A'],
      failSetNow: ['A'],
    })).toBe('success');
  });
});