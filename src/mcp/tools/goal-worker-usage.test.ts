/**
 * G-1 —— `scripts/goal-worker.ts` 这条生产路径要把模型用量记进 `.omd/tui-usage.jsonl`。
 *
 * ## 起因(2026-08-25 晨报读数,活体)
 *
 * `emitModelUsage` 是**观察者钩子**:无订阅者 = 逐条通知进真空。整夜四个 detached run
 * (A1/A2/B1/C1)一条用量都没进账本 —— 账本自 08-24 15:36 UTC 起零增长,而夜间 goal §3
 * 恰恰要求「每单从 `.omd/tui-usage.jsonl` 增量读三个数」。那把尺子在这条路上根本没装。
 *
 * 这与 `cli.ts:74-79` 注释描述的形态**逐字同族**:「机制在、生产零生效」。当时补的是
 * mcp 分支,goal-worker 分支漏了。
 *
 * ## 反向自检(一条永远绿的闸不是闸)
 *
 * 第二个用例**不调** `attachUsageLedger` 就 emit,断言账本文件不存在 —— 它证明第一个用例
 * 的绿来自订阅这个动作本身,而不是「emit 反正总会写盘」。把 `attachUsageLedger` 的函数体
 * 清空,第一个用例立刻红。
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { attachUsageLedger } from '../../../scripts/goal-worker';
import { emitModelUsage } from '../../model/accounting';

const ledgerPath = (cwd: string): string => join(cwd, '.omd', 'tui-usage.jsonl');

describe('G-1 goal-worker 用量入账', () => {
  test('★ attachUsageLedger 之后, emit 的每一笔都落进 <cwd>/.omd/tui-usage.jsonl', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'gw-usage-'));
    const detach = attachUsageLedger(cwd);
    try {
      emitModelUsage({ in: 1234, out: 56, cacheHit: 1000 }, 'minimax-cn:MiniMax-M3', 'engine');
    } finally {
      detach();
    }

    const lines = readFileSync(ledgerPath(cwd), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const rec = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(rec.model).toBe('minimax-cn:MiniMax-M3');
    expect(rec.in).toBe(1234);
    expect(rec.out).toBe(56);
    expect(rec.cacheHit).toBe(1000);
    // source 由 emit 侧第三参带 —— 订阅侧照抄, 不许自己编一个恒定标签
    // (那样 chat 轮与引擎调用在账上分不开, cli.ts:78-80 同款纪律)。
    expect(rec.source).toBe('engine');
  });

  test('反向自检: 不订阅就 emit → 账本文件根本不存在 (证明绿来自订阅动作)', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'gw-usage-none-'));
    emitModelUsage({ in: 999, out: 9 }, 'minimax-cn:MiniMax-M3', 'engine');
    expect(existsSync(ledgerPath(cwd))).toBe(false);
  });

  test('detach 之后不再记 —— 短命进程也不许把钩子泄漏给下一个测试', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'gw-usage-detach-'));
    const detach = attachUsageLedger(cwd);
    emitModelUsage({ in: 1, out: 1 }, 'a:b', 'engine');
    detach();
    emitModelUsage({ in: 2, out: 2 }, 'a:b', 'engine');

    const lines = readFileSync(ledgerPath(cwd), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect((JSON.parse(lines[0]!) as { in: number }).in).toBe(1);
  });

  test('OMD_TUI_USAGE_DIR 压得过 cwd —— 测试 lane 的记账不许污染真仓的 5h 窗口', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'gw-usage-cwd-'));
    const override = mkdtempSync(join(tmpdir(), 'gw-usage-override-'));
    const prev = process.env.OMD_TUI_USAGE_DIR;
    process.env.OMD_TUI_USAGE_DIR = override;
    const detach = attachUsageLedger(cwd);
    try {
      emitModelUsage({ in: 7, out: 7 }, 'a:b', 'engine');
    } finally {
      detach();
      if (prev === undefined) delete process.env.OMD_TUI_USAGE_DIR;
      else process.env.OMD_TUI_USAGE_DIR = prev;
    }

    expect(existsSync(ledgerPath(cwd))).toBe(false);
    expect(existsSync(join(override, 'tui-usage.jsonl'))).toBe(true);
  });
});
