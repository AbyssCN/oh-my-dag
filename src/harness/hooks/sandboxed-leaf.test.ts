/**
 * P2e review-fix (2026-09-02): jail 模式外层 bwrap 杀进程计时器必须与 agent-leaf.ts 的
 * in-process 计时器**同一条闸** —— 两个数取紧的那个, 不许被调用方的 `input.leafTimeoutMs`
 * 抬高过 `opts.leafTimeoutMs` 那道构造期上限。
 *
 * ## 它补的是哪一个洞
 *
 * 首版实现用 `input.leafTimeoutMs ?? opts.leafTimeoutMs ?? 3_600_000` (`??`, 不是
 * `Math.min`) —— 与自己头顶的注释("按调用取紧的那个")直接矛盾: `??` 只在 `input` 缺席时才
 * 退回 `opts`, `input` 一旦有值 (哪怕比 `opts` 大) 就整个覆盖掉 `opts`。
 *
 * 具体会炸的现场: 运维配 `OMD_LEAF_TIMEOUT_MS=600_000` (10min 硬崩溃兜底), 同一次
 * `solve --budgetMinutes=60` 下引擎按剩余预算算出 `input.leafTimeoutMs≈3_595_000`
 * (~60min) —— worker 内部 agent-leaf 的 `Math.min` 正确收紧到 10min, 但这层外层 `??` 只看
 * `input` 有没有值, 选中 3_595_000, SIGKILL 兜底从 10.5min 松到 60.4min。真正跑真 bwrap
 * worker 太重 (要真跑一次 agent SDK), 所以把取值算法单独导出成纯函数 `sandboxedLeafKillTimeoutMs`
 * 单独钉 (sandboxed-leaf.ts 头注)。
 *
 * 反向自检 (怎么让它红): 把 `sandboxedLeafKillTimeoutMs` 的实现改回
 * `input.leafTimeoutMs ?? opts.leafTimeoutMs ?? 3_600_000` → 下面「不许被抬高」那条当场红
 * (60.4min 那种数会重新出现)。
 */
import { describe, expect, test } from 'bun:test';
import { sandboxedLeafKillTimeoutMs } from './sandboxed-leaf';

describe('P2e review-fix: sandboxedLeafKillTimeoutMs — 外层杀进程计时器只许收紧, 不许抬高', () => {
  test('input 给得比 opts 大 (剩余预算充裕) → 取 opts 那道构造期上限, 不许被抬高', () => {
    expect(sandboxedLeafKillTimeoutMs({ leafTimeoutMs: 3_595_000 }, { leafTimeoutMs: 600_000 })).toBe(600_000);
  });

  test('input 给得比 opts 小 (剩余预算紧张) → 取 input 那个更紧的值', () => {
    expect(sandboxedLeafKillTimeoutMs({ leafTimeoutMs: 15_000 }, { leafTimeoutMs: 3_600_000 })).toBe(15_000);
  });

  test('input 缺席 (未配预算) → 退回 opts 的构造期兜底', () => {
    expect(sandboxedLeafKillTimeoutMs({}, { leafTimeoutMs: 600_000 })).toBe(600_000);
  });

  test('两者都缺席 → 历史默认 1h', () => {
    expect(sandboxedLeafKillTimeoutMs({}, {})).toBe(3_600_000);
  });
});
