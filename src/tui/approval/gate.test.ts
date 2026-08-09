/**
 * 审批闸行为(切片①,G-1 的可跑判据):
 * 拒绝则不执行 · 批准则执行 · read 全程不问 · token 过 TTL 后同一操作重新要审批。
 *
 * 反向自检:
 * - 「拒绝则不改」不是恒绿 —— `once` 那条证明同一个工具在批准时**真的会执行**;
 *   两条用的是同一个 executed 计数器,闸失效(拒了还执行)时 deny 那条当场红。
 * - 「token 过期」用注入时钟拨过 TTL —— 把 gate 里 `now() < exp` 改成 `true`,那条当场红。
 */
import { describe, expect, test } from 'bun:test';
import type { AnyOmdTool } from '../../harness/agent-tools';
import { DEFAULT_APPROVAL_CONFIG } from './policy';
import { type ApprovalDecision, type ApprovalRequest, type ApprovalTraceEvent, createApprovalGate } from './gate';

/** 一个能数执行次数的假工具。 */
function countingTool(name: string): { tool: AnyOmdTool; executed: () => number } {
  let n = 0;
  const tool = {
    name,
    label: name,
    description: 'test',
    parameters: undefined as never,
    executionMode: 'sequential',
    async execute() {
      n += 1;
      return { content: [{ type: 'text', text: 'ok' }], details: undefined };
    },
  } as AnyOmdTool;
  return { tool, executed: () => n };
}

function makeGate(script: ApprovalDecision[], o: { now?: () => number } = {}) {
  const asked: ApprovalRequest[] = [];
  const traces: ApprovalTraceEvent[] = [];
  const gate = createApprovalGate({ config: DEFAULT_APPROVAL_CONFIG, onTrace: (e) => traces.push(e), ...(o.now ? { now: o.now } : {}) });
  gate.setAsk(async (req) => {
    asked.push(req);
    const d = script.shift();
    if (d === undefined) throw new Error('测试脚本用完了还在问');
    return d;
  });
  return { gate, asked, traces };
}

describe('G-1 主链', () => {
  test('read 全程不问(ask 零调用), 直接执行', async () => {
    const { tool, executed } = countingTool('read');
    const { gate, asked } = makeGate([]);
    const [wrapped] = gate.wrap([tool]);
    await wrapped!.execute('t1', { path: 'src/x.ts' } as never);
    expect(executed()).toBe(1);
    expect(asked.length).toBe(0);
  });

  test('★ 拒绝则不执行(抛错带原因), 批准则执行 —— 同一个计数器上对照', async () => {
    const { tool, executed } = countingTool('write');
    const { gate, asked } = makeGate(['deny', 'once']);
    const [wrapped] = gate.wrap([tool]);
    await expect(wrapped!.execute('t1', { path: 'a.ts', content: 'x' } as never)).rejects.toThrow('[approval] 用户拒绝');
    expect(executed()).toBe(0); // 拒绝则不改
    await wrapped!.execute('t2', { path: 'a.ts', content: 'x' } as never);
    expect(executed()).toBe(1); // 批准则改
    expect(asked.length).toBe(2); // `y` 用完即焚: 第二次同一操作重新问了
  });

  test('★ token: `a` 之后同档免审; 拨过 TTL 后同一操作重新要审批', async () => {
    let clock = 1_000_000;
    const { tool, executed } = countingTool('write');
    const { gate, asked } = makeGate(['grant', 'once'], { now: () => clock });
    const [wrapped] = gate.wrap([tool]);
    await wrapped!.execute('t1', { path: 'a.ts', content: 'x' } as never); // grant → token
    clock += 599_000;
    await wrapped!.execute('t2', { path: 'a.ts', content: 'x' } as never); // TTL 内: 免审
    expect(asked.length).toBe(1);
    expect(executed()).toBe(2);
    clock += 2_000; // 过 600s
    await wrapped!.execute('t3', { path: 'a.ts', content: 'x' } as never); // 重新要审批 (script: once)
    expect(asked.length).toBe(2);
    expect(executed()).toBe(3);
  });

  test('token 按档位隔离: write 的 token 不覆盖 admin(强制审批, 不管多有把握)', async () => {
    const writeT = countingTool('write');
    const bashT = countingTool('bash');
    const { gate, asked } = makeGate(['grant', 'deny']);
    const [w, b] = gate.wrap([writeT.tool, bashT.tool]);
    await w!.execute('t1', { path: 'a.ts', content: 'x' } as never); // write 档拿到 token
    await expect(b!.execute('t2', { command: 'git push --force origin main' } as never)).rejects.toThrow('[approval]');
    expect(asked.length).toBe(2); // admin 那单照样弹了
    expect(bashT.executed()).toBe(0);
  });

  test('admin 收到 grant 防御性降级成 once: 不产生 token', async () => {
    const { tool, executed } = countingTool('bash');
    const { gate, asked } = makeGate(['grant', 'deny']);
    const [wrapped] = gate.wrap([tool]);
    const cmd = { command: 'git reset --hard HEAD~1' } as never;
    await wrapped!.execute('t1', cmd); // grant → 降级 once, 执行但不留 token
    expect(executed()).toBe(1);
    await expect(wrapped!.execute('t2', cmd)).rejects.toThrow('[approval]'); // 没有 token, 再问, 拒
    expect(asked.length).toBe(2);
    // admin 的卡片上就不该有 `a`
    expect(asked[0]!.canGrant).toBe(false);
  });

  test('fail-closed: 没接 ask handler → 拒绝, 不是放行', async () => {
    const { tool, executed } = countingTool('write');
    const gate = createApprovalGate({ config: DEFAULT_APPROVAL_CONFIG });
    const [wrapped] = gate.wrap([tool]);
    await expect(wrapped!.execute('t1', { path: 'a.ts', content: 'x' } as never)).rejects.toThrow('无审批通道');
    expect(executed()).toBe(0);
  });
});

describe('trace(v5: approval_required → approval_resolved)', () => {
  test('弹单与裁决各留一条, 顺序对; token 放行也留痕', async () => {
    let clock = 0;
    const { tool } = countingTool('write');
    const { gate, traces } = makeGate(['grant'], { now: () => clock });
    const [wrapped] = gate.wrap([tool]);
    await wrapped!.execute('t1', { path: 'a.ts', content: 'x' } as never);
    clock += 1_000;
    await wrapped!.execute('t2', { path: 'a.ts', content: 'x' } as never);
    expect(traces.map((t) => t.phase)).toEqual(['approval_required', 'approval_resolved', 'approval_token_pass']);
    expect(traces[1]!.decision).toBe('grant');
  });
});

describe('卡片内容', () => {
  test('双级命中的单是一张, reasons 两条都在(v5: 两级合并成一张单)', async () => {
    const { tool } = countingTool('edit');
    const asked: ApprovalRequest[] = [];
    const gate = createApprovalGate({
      config: { ...DEFAULT_APPROVAL_CONFIG, protectedPaths: ['src/model/seats.ts'] },
    });
    gate.setAsk(async (req) => {
      asked.push(req);
      return 'deny';
    });
    const [wrapped] = gate.wrap([tool]);
    await expect(wrapped!.execute('t1', { path: 'src/model/seats.ts', oldText: 'a', newText: 'b' } as never)).rejects.toThrow();
    expect(asked.length).toBe(1);
    expect(asked[0]!.reasons).toEqual(['function-level write', 'target is on the protected list (src/model/seats.ts)']);
    expect(asked[0]!.summary).toContain('edit src/model/seats.ts');
  });
});
