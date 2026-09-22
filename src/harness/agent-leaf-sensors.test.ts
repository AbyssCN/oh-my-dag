/**
 * Jev 传感器接线 —— 谓词层逐分支 + 接线的静态判据(契约
 * `docs/plan/2026-09-22-jev-传感器-阶段0-E1-执行契约.md` 切片 3 / INV-7 · INV-8 · GWT-9/10/11)。
 *
 * ## 这里钉的是什么
 *
 * ① `planSensorStep`:env 三态 × 持卡 × 只读步/声称步 —— 整条接线的**唯一**点火闸(GWT-10/11)。
 * ② `agent-leaf.ts` 源码里的接线形状(GWT-9):三个传感器函数真被调了,且 `askJev` **不带 await**。
 *
 * ## 实测局限(诚实,与 `survey-budget.test.ts` / `agent-leaf-spin-route.test.ts` 同一条先例)
 *
 * 点火点 `tool_execution_end`、注入点 `pendingGrindAdvice` 都在 `agent-leaf.ts` 的闭包里,真走完
 * 要真实事件流 + 真 Jev 应答。本文件**不强驱真循环**:只钉谓词层与接线的静态形状。
 * 「异步不占墙钟」「与 W4 互斥只注一条」这两件事 GWT-9 只能证明形状对,**语义仍靠人读契约**
 * (仓规 §静默坑 3:oracle 绿 ≠ 语义对)。
 *
 * ## 证伪(每条要能真红)
 *
 *  · 把 `planSensorStep` 里的 `sensorsMode(s.env)` 换成常量 `'shadow'` ⇒ 「env 缺席即不点火」红。
 *  · 把 `SURVEY_READONLY_TOOLS.has(s.toolName)` 换成恒 `true` ⇒ 「写步不问」红。
 *  · 把 `hasClaim` 那一项删掉(恒 false)⇒ 「写步 + 完成声称仍要问」红。
 *  · 把 `s.hasCards` 删掉 ⇒ 「不持卡的节点恒不点火」红。
 *  · 把实装里的 `void askJev(...)` 改成 `await askJev(...)` ⇒ 「askJev 不带 await」红。
 *  · 把实装里的 `appendSensorReading(...)` 整段删掉 ⇒ 「读数真被写」红。
 *  · 把 `hasCompletionClaim` 调用换回自带的副本(或让 `hasCompletionClaim` 在 sensor-state 里消失)
 *    ⇒ 「完成声称判据单一来源」红。
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { planSensorStep } from './agent-leaf';
import { hasCompletionClaim } from './sensors/sensor-state';

const SRC = readFileSync(join(import.meta.dir, 'agent-leaf.ts'), 'utf8');

const base = { env: { OMD_SENSORS: 'shadow' } as Record<string, string | undefined>, hasCards: true, toolName: 'read', lastAssistant: '' };

describe('planSensorStep (GWT-10): 点火闸 = env 三态 × 持卡 × (只读步 | 完成声称)', () => {
  test('★ shadow + 持卡 + 只读步 → 点火, mode 原样传出', () => {
    expect(planSensorStep(base)).toEqual({ fire: true, mode: 'shadow' });
  });

  test('写步不问 (D-4: 写步的下一步该不该派活不由这把尺判)', () => {
    expect(planSensorStep({ ...base, toolName: 'write' }).fire).toBe(false);
  });

  test('★ 写步带完成声称仍要问 (done_without_evidence 正是要考这一刻)', () => {
    expect(planSensorStep({ ...base, toolName: 'write', lastAssistant: '已完成' }).fire).toBe(true);
  });

  test('不持卡的节点恒不点火 (work 子节点该读多久读多久, 同 W4 那条)', () => {
    expect(planSensorStep({ ...base, hasCards: false }).fire).toBe(false);
  });

  test('nudge 档同样点火 —— 点火与推送是两把尺 (推送由 sensorNudgeHit 另判)', () => {
    expect(planSensorStep({ ...base, env: { OMD_SENSORS: 'nudge' } })).toEqual({ fire: true, mode: 'nudge' });
  });

  test('非法值当 off, 不点火 (D-7: 认不出的值一律当没开)', () => {
    expect(planSensorStep({ ...base, env: { OMD_SENSORS: 'bogus' } })).toEqual({ fire: false, mode: 'off' });
  });

  test('只读工具全名单都算只读步 (与 W4 同一把尺 SURVEY_READONLY_TOOLS, 不新造)', () => {
    for (const t of ['read', 'ls', 'grep', 'bash', 'hashline_read']) {
      expect(planSensorStep({ ...base, toolName: t }).fire).toBe(true);
    }
  });
});

describe('planSensorStep (GWT-11): OMD_SENSORS 缺席 ⇒ 一发都不问 (INV-8 零回归的落点)', () => {
  test('★ env 空 + 持卡 + 只读步 + 完成声称 —— 四件齐备仍不点火', () => {
    expect(planSensorStep({ env: {}, hasCards: true, toolName: 'read', lastAssistant: '已完成' })).toEqual({
      fire: false,
      mode: 'off',
    });
  });

  test('显式 off 同缺席', () => {
    expect(planSensorStep({ ...base, env: { OMD_SENSORS: 'off' } }).fire).toBe(false);
  });
});

describe('接线的静态判据 (GWT-9): agent-leaf.ts 源码里的形状', () => {
  const count = (needle: string): number => SRC.split(needle).length - 1;

  test('★ 三个传感器函数各真被调了至少一次 (谓词与落盘都没被接线漏掉)', () => {
    expect(count('sensorFireHit(')).toBeGreaterThanOrEqual(1);
    expect(count('sensorNudgeHit(')).toBeGreaterThanOrEqual(1);
    expect(count('appendSensorReading(')).toBeGreaterThanOrEqual(1);
  });

  test('★ askJev 的每一处调用点都不带 await (D-3: 传感器不占主循环墙钟)', () => {
    const calls = [...SRC.matchAll(/askJev\(/g)];
    expect(calls.length).toBeGreaterThanOrEqual(1);
    for (const m of calls) {
      // 取调用点之前的 8 个字符:`await ` 是 6 个, 留余量看清前缀究竟是什么。
      const before = SRC.slice(Math.max(0, m.index - 8), m.index);
      expect(before.endsWith('await ')).toBe(false);
    }
  });

  test('推送复用 W4 文案, 不新写一段 (D-10)', () => {
    expect(count('surveyBudgetInstruction(')).toBeGreaterThanOrEqual(2); // W4 一处 + 传感器一处
  });

  test('★ 完成声称判据单一来源 (agent-leaf 只调 sensor-state 的 hasCompletionClaim, 不自带副本)', () => {
    expect(SRC).not.toContain('SENSOR_CLAIM_MARKERS');
    expect(SRC).toContain('hasCompletionClaim(');
  });
});

describe('hasCompletionClaim (单一来源的那把尺): 与点火闸同一条正则', () => {
  test('★ 五个 marker 都算声称 (大小写不敏感), 普通文本不算', () => {
    for (const t of ['完成', '通过', 'DONE', 'pass', 'All Tests green']) {
      expect(hasCompletionClaim(t)).toBe(true);
    }
    expect(hasCompletionClaim('正在读文件')).toBe(false);
    expect(hasCompletionClaim('')).toBe(false);
  });

  test('★ 同一份判据驱动点火闸: hasCompletionClaim 说「有声称」⇔ 写步也点火 (两条路不分叉)', () => {
    for (const t of ['完成', '通过', 'done', 'pass', 'all tests']) {
      expect(hasCompletionClaim(t)).toBe(true);
      expect(planSensorStep({ ...base, toolName: 'write', lastAssistant: t }).fire).toBe(true);
    }
    expect(hasCompletionClaim('还没好')).toBe(false);
    expect(planSensorStep({ ...base, toolName: 'write', lastAssistant: '还没好' }).fire).toBe(false);
  });
});
