/**
 * `RunRegistry.getSummary` 的**文本契约**测试(2026-08-12 新立)。
 *
 * ## 为什么这份到今天才有
 *
 * `getSummary` 的那几行字是**每个 session 判断一个 run 死活时唯一读的东西**,而它在
 * 全仓**零断言**。2026-08-12 实测代价:一程里因为读它读错,连报三条错结论 ——
 *
 * - run `360405a5` 的 `status: done` 被读成「这一片交付了」,而节点级是
 *   `2 done / 1 failed / 10 skipped`(`impl-types` 挂了,下游全级联跳过);
 * - `updated == created` 被读成「零进度」,而那只是说 registry 那一格没再被写;
 * - `created`/`updated` 是 UTC ISO 串,而人在本地时区读 —— 同一程算错三次时长。
 *
 * 三条的共同形状:**摘要行印的东西不足以支撑读它的人要下的那个判断**,而缺的部分
 * 盘上其实都有(`fail-*.txt` / `progress.settled`)。本仓 S-33 同族。
 *
 * ## 七条不变量
 *
 * 1. **节点账对所有态都印**,不只 `running`。终态恰恰是最需要它的时候。
 * 2. **五个数恒印,0 也印**。`skipped: 0` 与「这一格没数据」是两件事(NULL ≠ 0 ≠ 不适用)。
 * 3. **`skipped` 不并进 `failed`**。级联跳过与真失败是两种因;旧实现写的是
 *    `failed = settled.length - done`,会把 `1 failed + 10 skipped` 印成 `11 failed`。
 * 4. **`elapsed` 印相对时长**,读的人不必拿 UTC 串自己换算时区。
 * 5. **数节点不数 settle 事件**:`settled` 是追加数组,重跑的节点会留多条,按最后一次算。
 * 6. **分母认「见过的所有 id」**:重规划变体 settle 了却不在 `planned` 里,漏进分母就取小了。
 * 7. **在飞单独一格**:`started` 且未 settle 的落不进前四格,少这一格「和 = 总数」就不成立。
 *
 * 5/6/7 三条**全是拿真数据(41 个历史 run)对账时抓出来的**,不是想出来的 ——
 * 前四条写完自测全绿,一跑真数据当场三处对不上。**判据自己也要过真数据这一关。**
 *
 * ## 反向自检(一条永远绿的闸不是闸)
 *
 * 每条测试注释里写了「怎么让它红」,全部当场证伪过。
 */
import { describe, expect, test } from 'bun:test';
import { RunRegistry } from './run-registry';
import type { DagNodeEvent } from '../harness/dag/types';

const T0 = Date.parse('2026-08-12T07:00:00.000Z');

/** 固定时钟:`elapsed` 是相对量,时钟不定死就没法断言。 */
function makeReg(nowMs: () => number): RunRegistry {
  return new RunRegistry(() => new Date(nowMs()));
}

function textOf(reg: RunRegistry, runId: string): string {
  const r = reg.getSummary(runId);
  return r.content.map((c) => (c as { text: string }).text).join('\n');
}

/** 造一张 13 节点的图, settle 出 2 done / 1 failed / 10 skipped —— 就是 run 360405a5 的形状。 */
function seed(reg: RunRegistry, runId: string): void {
  const planned: DagNodeEvent = {
    type: 'planned',
    nodes: Array.from({ length: 13 }, (_, i) => ({ id: `n${i}`, kind: 'leaf' })),
  } as DagNodeEvent;
  reg.applyNodeEvent(runId, planned);
  const settle = (id: string, status: 'done' | 'failed' | 'skipped'): void => {
    reg.applyNodeEvent(runId, { type: 'settle', id, status, kind: 'leaf' } as DagNodeEvent);
  };
  settle('n0', 'done');
  settle('n1', 'done');
  settle('n2', 'failed');
  for (let i = 3; i < 13; i++) settle(`n${i}`, 'skipped');
}

describe('getSummary 的节点账', () => {
  test('★ INV-1+3: 终态 done 也印节点账, 且 skipped 不并进 failed', () => {
    const reg = makeReg(() => T0);
    reg.register('r1', { goal: 'g' });
    reg.start('r1');
    seed(reg, 'r1');
    reg.succeed('r1', { ok: true });

    const t = textOf(reg, 'r1');
    expect(t).toContain('status: done');
    // 怎么让它红: 把节点账那行放回 `if (rec.status === 'running')` 里 → 终态不印 → 红。
    expect(t).toMatch(/nodes: 2 done \/ 1 failed \/ 10 skipped/);
    // 怎么让它红: 恢复 `failed = settled.length - done` → 印成 11 failed → 红。
    expect(t).not.toContain('11 failed');
  });

  test('★ INV-2: 四个数恒印, 0 也印 (缺席 ≠ 0)', () => {
    const reg = makeReg(() => T0);
    reg.register('r2', { goal: 'g' });
    reg.start('r2');
    reg.applyNodeEvent('r2', {
      type: 'planned',
      nodes: [{ id: 'a', kind: 'leaf' }],
    } as DagNodeEvent);
    reg.applyNodeEvent('r2', { type: 'settle', id: 'a', status: 'done', kind: 'leaf' } as DagNodeEvent);
    reg.succeed('r2', {});

    const t = textOf(reg, 'r2');
    // 怎么让它红: 把任一格改回「非零才印」(如 `${failed ? … : ''}`) → 这三条断言逐条红。
    expect(t).toContain('0 failed');
    expect(t).toContain('0 skipped');
    expect(t).toContain('0 pending');
  });

  test('★ INV-4: elapsed 是相对时长, 不逼读的人换算 UTC', () => {
    let now = T0;
    const reg = makeReg(() => now);
    reg.register('r3', { goal: 'g' });
    reg.start('r3');
    now = T0 + 13 * 60_000 + 58_000; // 13m58s —— 本程真实读错过的那个量级
    const t = textOf(reg, 'r3');
    // 怎么让它红: 删掉 elapsed 行 → 红; 或印成绝对时间戳 → 不含 'm' → 红。
    expect(t).toMatch(/elapsed: 13m/);
  });

  test('★ INV-5: 数的是**节点**不是 settle 事件 —— 重跑过的节点只算一次, 且四数之和 = total', () => {
    // 真数据抓出来的(2026-08-12): `settled` 是追加数组, 一个节点被重跑(内环轮次 / 毒集强制
    // 重跑 / __r1)会留多条。按事件数数, run 360405a5 印成「13 done / 2 failed / 11 skipped
    // (共 13)」—— 26 个数落在 13 个格子里, 单位错了(本仓 S-22)。以**最后一次** settle 为准:
    // 先 failed 后重跑成功的节点,最终状态是 done。
    const reg = makeReg(() => T0);
    reg.register('r5', { goal: 'g' });
    reg.start('r5');
    reg.applyNodeEvent('r5', {
      type: 'planned',
      nodes: [{ id: 'a', kind: 'leaf' }, { id: 'b', kind: 'leaf' }],
    } as DagNodeEvent);
    // a 先失败, 重跑成功 —— 两条 settle, 一个节点
    reg.applyNodeEvent('r5', { type: 'settle', id: 'a', status: 'failed', kind: 'leaf' } as DagNodeEvent);
    reg.applyNodeEvent('r5', { type: 'settle', id: 'a', status: 'done', kind: 'leaf' } as DagNodeEvent);
    reg.applyNodeEvent('r5', { type: 'settle', id: 'b', status: 'skipped', kind: 'leaf' } as DagNodeEvent);
    reg.succeed('r5', {});

    const t = textOf(reg, 'r5');
    // 怎么让它红: 去掉按 id 去重(直接 filter settled)→ 印成 1 done / 1 failed / 1 skipped(共 2), 和为 3 ≠ 2 → 红。
    expect(t).toContain('nodes: 1 done / 0 failed / 1 skipped / 0 running / 0 pending (共 2)');

    // 和恒等于 total —— 这条是上面那个单位错误的通用探针, 不依赖具体数字
    const m = /nodes: (\d+) done \/ (\d+) failed \/ (\d+) skipped \/ (\d+) running \/ (\d+) pending \(共 (\d+)\)/.exec(t);
    expect(m, '节点账那行不见了').not.toBeNull();
    const [d, f, s, r, p, total] = m!.slice(1).map(Number) as [number, number, number, number, number, number];
    expect(d + f + s + r + p).toBe(total);
  });

  test('★ INV-6: 分母认「见过的所有节点」—— 重规划变体 settle 了却不在 planned 里, 不许漏进分母', () => {
    // 真数据抓出来的(2026-08-12, run 66095b2f): 四数之和 19 > 分母 18, 因为 `__r1` 这类
    // 重规划变体会 settle 但不进 planned。分母取 planned.length 就少了一个格子(本仓 S-19)。
    const reg = makeReg(() => T0);
    reg.register('r6', { goal: 'g' });
    reg.start('r6');
    reg.applyNodeEvent('r6', { type: 'planned', nodes: [{ id: 'a', kind: 'leaf' }] } as DagNodeEvent);
    reg.applyNodeEvent('r6', { type: 'settle', id: 'a', status: 'failed', kind: 'leaf' } as DagNodeEvent);
    // 重规划变体: settle 了, 但 planned 里没有它
    reg.applyNodeEvent('r6', { type: 'settle', id: 'a.__r1', status: 'done', kind: 'leaf' } as DagNodeEvent);
    reg.succeed('r6', {});

    const t = textOf(reg, 'r6');
    // 怎么让它红: 把 total 改回 `p.planned.length || …` → 印成「1 done / 1 failed / … (共 1)」, 和 2 ≠ 1 → 红。
    expect(t).toContain('nodes: 1 done / 1 failed / 0 skipped / 0 running / 0 pending (共 2)');
  });

  test('★ INV-7: 在飞节点单独一格 —— 少这一格「和 = 总数」就不成立', () => {
    // 真数据抓出来的(2026-08-12, run d39b559e running): 四数之和 29 而分母 30, 差的正是
    // 那一个 started 未 settle 的。settle 会把 id 从 started 摘掉, 所以 started 就是在飞集。
    const reg = makeReg(() => T0);
    reg.register('r7', { goal: 'g' });
    reg.start('r7');
    reg.applyNodeEvent('r7', {
      type: 'planned',
      nodes: [{ id: 'a', kind: 'leaf' }, { id: 'b', kind: 'leaf' }, { id: 'c', kind: 'leaf' }],
    } as DagNodeEvent);
    reg.applyNodeEvent('r7', { type: 'start', id: 'a' } as DagNodeEvent);
    reg.applyNodeEvent('r7', { type: 'start', id: 'b' } as DagNodeEvent);
    reg.applyNodeEvent('r7', { type: 'settle', id: 'a', status: 'done', kind: 'leaf' } as DagNodeEvent);
    // b 在飞, c 没起跑
    const t = textOf(reg, 'r7');
    // 怎么让它红: 去掉 running 那一格 → 「1 done / 0 failed / 0 skipped / 1 pending (共 3)」和 2 ≠ 3 → 红。
    expect(t).toContain('nodes: 1 done / 0 failed / 0 skipped / 1 running / 1 pending (共 3)');
  });

  test('★ INV-8: settle 之后又被重新 start 的节点算「在飞」, 不许同时进两格', () => {
    // 真数据抓出来的(2026-08-12, run bf651d37): 和 12 > 分母 11。毒集强制重跑会让一个
    // 已 settle 的节点重新 start —— 它此刻的真状态是 running, 不是上一轮那个结果。
    const reg = makeReg(() => T0);
    reg.register('r8', { goal: 'g' });
    reg.start('r8');
    reg.applyNodeEvent('r8', { type: 'planned', nodes: [{ id: 'a', kind: 'leaf' }] } as DagNodeEvent);
    reg.applyNodeEvent('r8', { type: 'settle', id: 'a', status: 'failed', kind: 'leaf' } as DagNodeEvent);
    reg.applyNodeEvent('r8', { type: 'start', id: 'a' } as DagNodeEvent); // 毒集重跑
    const t = textOf(reg, 'r8');
    // 怎么让它红: 去掉 byStatus 里的 `!inFlight.has(s.id)` → 印成「0 done / 1 failed / 0 skipped /
    // 1 running / 0 pending (共 1)」, 和 2 ≠ 1 → 红。
    expect(t).toContain('nodes: 0 done / 0 failed / 0 skipped / 1 running / 0 pending (共 1)');
  });

  test('★ 失败态也要有节点账 —— 「为什么失败」的第一手就是它', () => {
    const reg = makeReg(() => T0);
    reg.register('r4', { goal: 'g' });
    reg.start('r4');
    seed(reg, 'r4');
    reg.fail('r4', 'boom');

    const t = textOf(reg, 'r4');
    expect(t).toContain('status: failed');
    expect(t).toContain('error: boom');
    // 怎么让它红: 节点账只对 done 印 → 这条红。
    expect(t).toMatch(/nodes: 2 done \/ 1 failed \/ 10 skipped/);
  });
});
