/**
 * **§8.4 动作级熔断闸** (2026-07-31)。
 *
 * 本文件盯的**不是**"重复够次数会不会熔断"(那是显然的), 而是那条让它敢开着跑的判据:
 * **失败得逐字相同才算数**。
 *
 * 照抄书里的「同一条命令失败 N 次」在 omd 会造成严重误伤 —— 失败的 command 节点常常就是
 * oracle(`bun test` 红 = 活还没干完), 修复环的正常形态就是"红 → 改 → 再红 → 再改 → 绿"。
 * 所以下面那条 **`同一条命令 + 不同失败输出 → 不熔断`** 才是本文件的重点; 少了它, 上面几条
 * 全都可能是"把修复回路掐死"的假阳性。
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { actionFingerprint, repeatedActionBlock, type ActionAttempt } from './repeated-action';
import { runExecutorDagWithPlan } from '../executor-dag';
import { CheckpointManager } from '../continuity/checkpoint-manager';
import { PLAN_BOUNDARY } from '../conductor-plan';
import type { ConductorPlan } from '../conductor-plan';
import type { ContentPart } from '../../model/gateway';
import type { ExecutorDagConfig, GenerateFn } from '../executor-dag-types';

const a = (command: string, output: string): ActionAttempt => ({ command, output });

describe('判据 — 逐字相同才算"同一次失败又发生了一遍"', () => {
  test('空历史 / 只失败过一次 → 不熔断', () => {
    expect(repeatedActionBlock([])).toBeNull();
    expect(repeatedActionBlock([a('bun test', 'FAIL: 3 tests')])).toBeNull();
  });

  test('同命令 + 同输出 ×2 → 熔断, 且理由里带得出命令与输出', () => {
    const why = repeatedActionBlock([a('bun test', 'FAIL: 3 tests'), a('bun test', 'FAIL: 3 tests')]);
    expect(why).not.toBeNull();
    expect(why).toContain('bun test');
    expect(why).toContain('FAIL: 3 tests');
    expect(why).toContain('2 次');
  });

  test('⚠ **同命令 + 不同输出 → 不熔断** ←没有这条, 整个修复回路会被掐死', () => {
    // 这正是修复环跑得对的时候的样子: 命令没变, 但断言在动。
    expect(
      repeatedActionBlock([
        a('bun test', 'FAIL: 3 tests'),
        a('bun test', 'FAIL: 2 tests'),
        a('bun test', 'FAIL: 1 test'),
      ]),
    ).toBeNull();
  });

  test('不同命令 + 同输出 → 不熔断 (两条不同的动作, 不是同一个动作重复)', () => {
    expect(repeatedActionBlock([a('bun test', 'boom'), a('tsc --noEmit', 'boom')])).toBeNull();
  });

  test('前后空白不算差异 (同一条命令被重画时缩进可能变)', () => {
    expect(repeatedActionBlock([a(' bun test ', 'boom\n'), a('bun test', '  boom')])).not.toBeNull();
  });

  test('中间夹着别的失败也算 —— 判据是"发生了几次", 不是"连着几次"', () => {
    expect(
      repeatedActionBlock([a('bun test', 'X'), a('tsc --noEmit', 'Y'), a('bun test', 'X')]),
    ).not.toBeNull();
  });

  test('阈值可调; 0/1 = 关闭本闸', () => {
    const h = [a('c', 'x'), a('c', 'x')];
    expect(repeatedActionBlock(h, 3)).toBeNull();
    expect(repeatedActionBlock([...h, a('c', 'x')], 3)).not.toBeNull();
    // 阈值 1 等于"一失败就熔断", 那不是熔断是禁用 —— 明确不支持。
    expect(repeatedActionBlock(h, 1)).toBeNull();
    expect(repeatedActionBlock(h, 0)).toBeNull();
  });

  test('指纹: 命令与输出都进键, 任一不同即不同键', () => {
    expect(actionFingerprint(a('c', 'x'))).toBe(actionFingerprint(a(' c ', ' x ')));
    expect(actionFingerprint(a('c', 'x'))).not.toBe(actionFingerprint(a('c', 'y')));
    expect(actionFingerprint(a('c', 'x'))).not.toBe(actionFingerprint(a('d', 'x')));
  });
});

// ── 环的接缝: 熔断真的把环退出去了吗 ─────────────────────────────────────────

const contentText = (c: string | ContentPart[] | undefined): string =>
  typeof c === 'string' ? (c ?? '') : (c ?? []).map((p) => (p.type === 'text' ? p.text : '')).join('\n');

/** 子图: 一个写方 + 一个恒失败的验收命令 (最常见的修复环形态)。 */
const SUB_PLAN = JSON.stringify({
  name: 'sub',
  nodes: {
    fix: { goal: '把它改对' },
    verify: { goal: '跑验收', executor: 'command', command: 'bun test', depends_on: ['fix'] },
  },
});

const loopPlan = (maxRounds: number): ConductorPlan => ({
  name: 'p',
  nodes: { P: { goal: '改到测试绿', executor: 'conductor', max_rounds: maxRounds } },
});

/**
 * @param outputs 第 N 轮那条验收命令的失败输出 (取 `outputs[轮次-1]`, 用完取最后一个)。
 *   —— 「每轮都一样」与「每轮都在变」的差别全靠它表达。
 */
function makeCfg(outputs: string[], extra: Partial<ExecutorDagConfig> = {}): {
  cfg: ExecutorDagConfig;
  rounds: () => number;
} {
  let cmdCalls = 0;
  const generate: GenerateFn = async (req) => {
    const user = contentText(req.messages.find((m) => m.role === 'user')?.content);
    if (user.includes(PLAN_BOUNDARY.trim().split('\n')[0]!) || user.includes('TASK (dynamic')) {
      return { text: SUB_PLAN, usage: { in: 1, out: 1 } };
    }
    return { text: 'out', usage: { in: 1, out: 1 } };
  };
  const cfg = {
    conductorModel: 'c:m',
    leafModel: 'l:m',
    generate,
    agentTemplates: new Map(),
    commandRunner: async () => {
      const text = outputs[Math.min(cmdCalls, outputs.length - 1)]!;
      cmdCalls++;
      return { text, usage: { in: 0, out: 0 }, exitCode: 1 };
    },
    judgeSend: async () => ({
      text: '',
      parsed: { converged: false, score: 3, failureReason: '还没绿', rejectedNodes: [] },
      usage: { in: 0, out: 0 },
      raw: {},
      model: 'judge:fake',
      attempts: 1,
    }),
    ...extra,
  } as unknown as ExecutorDagConfig;
  return { cfg, rounds: () => cmdCalls };
}

describe('环的接缝 — 熔断走 BLOCKED 出口, 恒不算收敛', () => {
  test('**每轮一模一样的失败 → 第 2 轮就退环**, 不跑满 4 轮', async () => {
    const { cfg, rounds } = makeCfg(['FAIL: 同一个断言']);
    const r = await runExecutorDagWithPlan(loopPlan(4), cfg);
    expect(r.results.P?.blocked).toContain('逐字相同');
    expect(r.results.P?.blocked).toContain('bun test');
    // 提前退环的证据: 命令只跑了 2 次而不是 4 次。
    expect(rounds()).toBe(2);
    // fail-closed: 阻塞更不该被读成成功。
    expect(r.results.P?.converged).not.toBe(true);
  });

  test('⚠ **失败在变 → 环照常跑满**, 修复回路不被掐死', async () => {
    const { cfg, rounds } = makeCfg(['FAIL: 3 个', 'FAIL: 2 个', 'FAIL: 1 个', 'FAIL: 还剩 1 个']);
    const r = await runExecutorDagWithPlan(loopPlan(4), cfg);
    expect(r.results.P?.blocked).toBeUndefined(); // 没被熔断
    expect(rounds()).toBe(4); // 跑满
  });

  test('阈值调高 → 同样的失败也能多试几轮', async () => {
    const { cfg, rounds } = makeCfg(['FAIL: 同一个断言'], { repeatedActionThreshold: 3 });
    await runExecutorDagWithPlan(loopPlan(4), cfg);
    expect(rounds()).toBe(3);
  });

  test('阈值设 0 = 关闭本闸 (跑满轮数)', async () => {
    const { cfg, rounds } = makeCfg(['FAIL: 同一个断言'], { repeatedActionThreshold: 0 });
    const r = await runExecutorDagWithPlan(loopPlan(4), cfg);
    expect(r.results.P?.blocked).toBeUndefined();
    expect(rounds()).toBe(4);
  });

  test('熔断退环时 journal 照写 (resume 接得回来; 未收敛 = 字段缺席)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'omd-breaker-'));
    const { cfg } = makeCfg(['FAIL: 同一个断言'], {
      continuity: { manager: new CheckpointManager(root), runId: 'run-b' },
    } as Partial<ExecutorDagConfig>);
    await runExecutorDagWithPlan(loopPlan(4), cfg);
    const jf = join(root, '.omd', 'continuity', 'run-b', '_loop-P.json');
    expect(existsSync(jf)).toBe(true);
    const j = JSON.parse(readFileSync(jf, 'utf-8')) as { converged?: boolean; completedRounds: number };
    // ⚠ journal 里 **未收敛 = 该字段缺席**(`writeLoopJournal` 只在 converged 时写这一格),
    // 不是写一个 `false`。断言写成 `toBe(false)` 会红 —— 这条编码本身值得钉住:
    // resume 靠 falsy 判"还没完", 哪天改成显式 false 也不会破, 但改成"缺席即收敛"就全反了。
    expect(j.converged).toBeUndefined();
    expect(j.completedRounds).toBe(2);
    rmSync(root, { recursive: true, force: true });
  });
});
