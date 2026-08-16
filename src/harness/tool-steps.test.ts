/**
 * 工具调用序列的判据测试(2026-08-16,#145 提议 2 复盘补的那一位)。
 *
 * ## 这一位是给谁用的
 *
 * 它不是又一本流水账。它存在的**唯一理由**是:有两条闸的判据写在**顺序**上,而顺序此前没人记
 * (`toolCalls` 只有次数 · `watchdog.toolTimelineMs` 只有时间戳没有名字 ·
 * `drift.stuckSigs` 只在空转时才有):
 *
 * 1. **hashline stale 之后有没有重新接地**。`hashline.ts:16` 是 fail-soft 的 —— stale 标签被拒
 *    只返一段文本,靠 `hashline.ts:66` 那条 prompt 规则叫模型重读接地。而本仓已有五个
 *    「prompt 规则按不住」的实例。可执行版就是下面 `staleWithoutRegroundCount` 那句序列判断。
 * 2. **§8.5 那条攒了一年的分布**:`[写调用数, noop 数]` 两个标量分不出「复核了一遍」(正当)
 *    与「被 stale 连拒三次」(病),而这两者的下一步正相反。
 *
 * ⚠ 本文件**只钉判据形状,不接引擎** —— 判据本身要不要升成闸,按仓规得先有分布。
 * 这里先把"读出来的东西长什么样"钉死,免得攒了半年分布才发现读法有歧义。
 */
import { describe, expect, test } from 'bun:test';
import { TOOL_STEPS_CAP, TOOL_STEPS_HEAD, type ToolStep } from './leaf-runners';

/**
 * 「edit 被拒(noop)之后,没有重新 `hashline_read` 就又发了一次 edit」的次数。
 *
 * 判据是**纯序列**的:零启发式、零模型判断、同一序列每次算同一个数。
 * 同一个路径才算 —— 改 a.ts 被拒之后去读 b.ts,那不是接地。
 */
function staleWithoutRegroundCount(steps: readonly ToolStep[]): number {
  let hits = 0;
  const pendingStale = new Set<string>(); // 该路径上有一次被拒的 edit 且此后未重读
  for (const s of steps) {
    if (!s.path) continue;
    if (s.tool === 'hashline_read') {
      pendingStale.delete(s.path); // 重新接地了
      continue;
    }
    if (s.tool !== 'hashline_edit') continue;
    if (pendingStale.has(s.path)) hits++; // ← 没重读就又发了一刀
    if (s.noop) pendingStale.add(s.path);
    else pendingStale.delete(s.path); // 真写进去了 = 这一刀是基于新鲜快照的
  }
  return hits;
}

const step = (tool: string, path?: string, noop?: boolean): ToolStep => ({
  tool,
  ...(path ? { path } : {}),
  ...(noop !== undefined ? { noop } : {}),
});

describe('hashline stale 判据 —— 「被拒之后有没有重新接地」', () => {
  test('★ 红: 被拒 → 不重读 → 又发一刀(= prompt 规则没按住,复合腐烂的起点)', () => {
    // 这正是 `hashline.ts:66` 那条规则禁止的形状, 而它今天只是一句 prompt。
    // 怎么让它红: 把 noop 那一位从 ToolStep 上删掉 → 判据拿不到"被拒"信号, 恒返 0。
    const steps = [
      step('hashline_read', 'routes.tsx'),
      step('hashline_edit', 'routes.tsx', true), // stale 被拒 → 盘上没动
      step('hashline_edit', 'routes.tsx', false), // ← 没重读就又来一刀
    ];
    expect(staleWithoutRegroundCount(steps)).toBe(1);
  });

  test('绿: 被拒之后**重新 hashline_read** 再改 → 不算(这正是规则要的行为)', () => {
    const steps = [
      step('hashline_read', 'routes.tsx'),
      step('hashline_edit', 'routes.tsx', true),
      step('hashline_read', 'routes.tsx'), // ← 重新接地
      step('hashline_edit', 'routes.tsx', false),
    ];
    expect(staleWithoutRegroundCount(steps)).toBe(0);
  });

  test('★ 绿: 正当的 no-op(上一轮已写对, 这一轮复核)不算病', () => {
    // §8.5 那条注明说「一次 no-op 写完全可能是正当的」。判据必须能把它与病态分开 ——
    // 分不开的话, 那条攒了一年的分布就永远升不成闸。
    const steps = [step('hashline_read', 'a.ts'), step('hashline_edit', 'a.ts', true)];
    expect(staleWithoutRegroundCount(steps)).toBe(0); // 之后没有再改 → 不是复合腐烂
  });

  test('★ 路径隔离: 在 a 上被拒, 去读了 b, 再改 a —— 仍算(读 b 不是接地)', () => {
    // 怎么让它红: 把 pendingStale 从 Set<path> 退化成一个布尔 → 这条变 0。
    const steps = [
      step('hashline_edit', 'a.ts', true),
      step('hashline_read', 'b.ts'),
      step('hashline_edit', 'a.ts', false),
    ];
    expect(staleWithoutRegroundCount(steps)).toBe(1);
  });

  test('中间夹着 bash/grep 不影响判据(但它们在序列里, 这是有意的)', () => {
    // 只记读写工具会把序列剪出一个假的因果 —— 「被拒之后到底干了什么」是诊断的一半。
    const steps = [
      step('hashline_edit', 'a.ts', true),
      step('bash'),
      step('grep'),
      step('hashline_edit', 'a.ts', false),
    ];
    expect(staleWithoutRegroundCount(steps)).toBe(1);
  });
});

describe('截断口径', () => {
  test('★ 头 + 尾, 而且截了多少要说出来', () => {
    // 截尾会丢掉"它卡在哪", 截头会丢掉"它怎么起手" —— 两头才是诊断要看的, 中段最不值钱。
    // 静默截断会让「只干了 400 步」和「干了 4000 步」长得一样, 所以 dropped 必须显式。
    expect(TOOL_STEPS_HEAD).toBeLessThan(TOOL_STEPS_CAP);
    expect(TOOL_STEPS_CAP - TOOL_STEPS_HEAD).toBeGreaterThan(0);
    const all = Array.from({ length: 1000 }, (_, i) => step(`t${i}`));
    const kept = [...all.slice(0, TOOL_STEPS_HEAD), ...all.slice(all.length - (TOOL_STEPS_CAP - TOOL_STEPS_HEAD))];
    expect(kept).toHaveLength(TOOL_STEPS_CAP);
    expect(kept[0]!.tool).toBe('t0'); // 起手在
    expect(kept[kept.length - 1]!.tool).toBe('t999'); // 卡在哪也在
    expect(all.length - TOOL_STEPS_CAP).toBe(600); // ← 这个数必须随结果带走
  });

  test('上限够装下实测量级(run C 单节点最多 125 步)', () => {
    // 判据不是拍的: 上限要比真实分布的上端有余量, 否则常态就在截断, 那等于没记。
    expect(TOOL_STEPS_CAP).toBeGreaterThan(125 * 2);
  });
});
