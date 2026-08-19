/**
 * 审核机械层前置 (#98, persona 判序①)。
 *
 * ## 这条网最要紧的一条是「它真的会响」
 *
 * 接一个恒返空的检测器进来 = 又造一个零方差仪器 —— #199 刚踩过 (判别力探针 66/66 全过,
 * 量的是尺子不是被测物)。所以本文件里有一条**真跑** `.omd/skills/impeccable/scripts/detect.mjs`
 * 的用例, 拿仓内真文件当输入。其余用例全注入, 零进程。
 */
import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DETECTOR_SCRIPT, hitToFinding, runMechanicalLayer } from './design-review-mechanical';
import { fingerprintOf } from '../profiles/review-ledger';

const ROOT = join(import.meta.dir, '../../..');
const hit = (o: Record<string, unknown>) => ({ antipattern: 'side-tab', file: '/repo/web/a.html', line: 28, snippet: 'border-left:3px', description: '别用侧边条', ...o });

describe('#98 机械层 —— 确定性规则命中直接落 finding', () => {
  test('命中 → ReviewFinding, 且 where 归一成相对仓根 (指纹要跨机器可比)', () => {
    const f = hitToFinding(hit({}), '/repo')!;
    expect(f.where).toBe('web/a.html:28');
    expect(f.evidence).toBe('[side-tab] — border-left:3px');
    expect(f.suggestion).toBe('别用侧边条');
    // D-5「不确定就写」的机械侧答案: 这条没有推断, 写清楚才不会被读成模型判断。
    expect(f.uncertainty).toContain('无推断');
    expect(f.uncertainty).toContain('side-tab');
  });

  /**
   * 票面「规则 id 即指纹」的落法: **不另造一套指纹**, 仍走冻结的 `fingerprintOf(where, evidence)`
   * (`validateFinding` 会逐条校验它), 只是把规则 id 放进 evidence。另造一套会让机械 finding 与
   * 模型 finding 的去重各走各路, 而台账的价值就在两者能互相认出来。
   */
  test('★ 指纹 = (位置, 规则): 同处同规则恒同指纹; 换规则或换位置就变', () => {
    const a = hitToFinding(hit({}), '/repo')!;
    const b = hitToFinding(hit({ snippet: 'border-left:4px dashed' }), '/repo')!;
    const c = hitToFinding(hit({ antipattern: 'overused-font' }), '/repo')!;
    const d = hitToFinding(hit({ line: 99 }), '/repo')!;
    // ★ 反向自检 (已实测会红): 把 evidence 里的 `[${rule}]` 去掉 → 同处不同规则撞指纹, 第二条红。
    expect(a.fingerprint).toBe(fingerprintOf('web/a.html:28', a.evidence));
    expect(c.fingerprint).not.toBe(a.fingerprint); // 换规则 → 换指纹
    expect(d.fingerprint).not.toBe(a.fingerprint); // 换位置 → 换指纹
    // snippet 只是同一条规则的排版差异 —— `normalizeEvidenceCategory` 会把标点空白抹平,
    // 但 `3px` vs `4px` 是不同字符, 仍是两条。这里只断言它是**确定的**, 不断言相等与否。
    expect(typeof b.fingerprint).toBe('string');
  });

  test('形状不对 → 丢弃这一条 (缺规则 id / 缺文件都没法定位)', () => {
    expect(hitToFinding(hit({ antipattern: undefined }), '/repo')).toBeNull();
    expect(hitToFinding(hit({ file: undefined }), '/repo')).toBeNull();
    // 缺 line 不算坏: 有些规则是文件级的, where 退化成纯路径。
    expect(hitToFinding(hit({ line: undefined }), '/repo')!.where).toBe('web/a.html');
  });

  /**
   * ★ **退出码不是"成没成"**: 这个检测器走 lint 惯例 —— **命中即非零** (实测 2026-08-19:
   * 无命中 → 0; `web/index.html` 命中 → **2**, 而 stdout 是完整 JSON)。
   * 第一版把「非零 = 跑不起来」写进 fail-open, 于是它**恰好把自己存在的唯一理由扔了**:
   * 有命中的那次全被丢, 只有无命中的那次被收 —— 一把只在没东西时才读数的尺子。
   * 端到端那条用例就是这么抓到的。
   */
  test('★ 非零退出但 stdout 是 JSON → **照收** (命中即非零是 lint 惯例, 不是失败)', () => {
    const out = runMechanicalLayer(['web/a.html'], '/repo', {
      run: () => ({ stdout: JSON.stringify([hit({})]), exitCode: 2 }),
    });
    // ★ 反向自检 (已实测会红): 把判据改回 `if (out.exitCode !== 0) return []` → 这条红。
    expect(out).toHaveLength(1);
    expect(out[0]!.where).toBe('web/a.html:28');
  });

  test('机械层是**加固不是前置条件**: 非 JSON / 抛错一律 [] 且不拦', () => {
    const files = ['web/a.html'];
    expect(runMechanicalLayer(files, '/repo', { run: () => ({ stdout: '不是 json', exitCode: 0 }) })).toEqual([]);
    expect(runMechanicalLayer(files, '/repo', { run: () => ({ stdout: '', exitCode: 2 }) })).toEqual([]); // 空 stdout → '[]'
    expect(
      runMechanicalLayer(files, '/repo', {
        run: () => {
          throw new Error('脚本没了');
        },
      }),
    ).toEqual([]);
  });

  test('零文件 → 零调用 (写集不含前端时不该起进程)', () => {
    let called = false;
    expect(runMechanicalLayer([], '/repo', { run: () => ((called = true), { stdout: '[]', exitCode: 0 }) })).toEqual([]);
    expect(called).toBe(false);
  });

  /**
   * ★ **端到端: 这把尺子真的会动。**
   *
   * 2026-08-19 实测 (接线前先验过, 免得又造一个零方差仪器):
   *   · `web/index.html` → `overused-font`
   *   · `docs/design/2026-08-07-…设计稿.html` → `side-tab` + `em-dash-overuse`
   *   · `src/serve/board-page.ts` / `src/tui` → `[]`
   * **会响也会不响** —— 那才叫在量被测物。这条用真脚本跑真文件; 脚本缺席时跳过并说明
   * (skill 可能没装), 不把"没装"读成"没命中"。
   */
  test('★ 端到端: 真跑检测器, 仓内真文件上真的命中 (不是零方差仪器)', () => {
    if (!existsSync(join(ROOT, DETECTOR_SCRIPT))) {
      // NULL≠0: 脚本没装 ≠ 规则没命中。跳过并留一句, 不伪造通过。
      expect(DETECTOR_SCRIPT).toContain('impeccable');
      return;
    }
    const findings = runMechanicalLayer(['web/index.html'], ROOT);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0]!.severity).toBe('p2');
    expect(findings[0]!.where).toStartWith('web/index.html');
    expect(findings[0]!.evidence).toStartWith('[');
    // 同一份输入跑两遍指纹必须一致 —— 去重靠它跨轮生效。
    expect(runMechanicalLayer(['web/index.html'], ROOT).map((f) => f.fingerprint)).toEqual(findings.map((f) => f.fingerprint));
  });

  /**
   * 机械层**全部落 p2** 是刻意的: 它认的是「口音」(过度使用的字体 / 侧边条 / em-dash 密度),
   * 是确定的**观察**但不是确定的**缺陷**。升成 p0/p1 会让 D-4 升档 (P0/P1 → 调强模型复审)
   * 被一堆风格项占满 —— 而那正是这一层要省下来的钱。
   */
  test('★ 机械 finding 恒 p2 (不占 D-4 升档的名额)', () => {
    for (const rule of ['side-tab', 'overused-font', 'em-dash-overuse']) {
      expect(hitToFinding(hit({ antipattern: rule }), '/repo')!.severity).toBe('p2');
    }
  });
});
