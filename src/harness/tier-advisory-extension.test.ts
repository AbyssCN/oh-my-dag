import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { setLang } from './i18n';
import {
  createTierAdvisoryExtension,
  failureSignature,
  type TierAdvisoryOpts,
  type TierAdvisoryDeps,
} from './tier-advisory-extension';

// ── 假 pi harness (verify-gate-extension.test.ts 同款): 收集 on/appendEntry, 手工驱动事件流 ──

function harness(opts: TierAdvisoryOpts = {}, deps: TierAdvisoryDeps = {}) {
  const handlers = new Map<string, Function[]>();
  const entries: Array<{ type: string; data: Record<string, unknown> }> = [];
  const notifications: Array<{ text: string; level: string }> = [];
  const pi = {
    on(event: string, fn: Function) {
      handlers.set(event, [...(handlers.get(event) ?? []), fn]);
    },
    appendEntry(type: string, data: Record<string, unknown>) {
      entries.push({ type, data });
    },
    registerTool() {},
  };
  createTierAdvisoryExtension({ ...opts }, { env: {}, premiumPool: () => [], ...deps })(pi as never);

  const ctx = { ui: { notify: (text: string, level: string) => notifications.push({ text, level }) } };
  const fire = (event: string, payload: unknown) => {
    let out: unknown;
    for (const fn of handlers.get(event) ?? []) out = fn(payload, ctx);
    return out as { block?: boolean } | undefined;
  };
  const failResult = (tool = 'bash', input: Record<string, unknown> = { command: 'bun run deploy' }) =>
    fire('tool_result', { toolName: tool, input, content: [{ type: 'text', text: 'Error: exit 1' }] });
  const okResult = (tool = 'bash', input: Record<string, unknown> = { command: 'bun run deploy' }) =>
    fire('tool_result', { toolName: tool, input, content: [{ type: 'text', text: 'done' }] });
  return { fire, failResult, okResult, entries, notifications };
}

describe('tier-advisory', () => {
  // 建议文案断言按中文写 → 钉住语言, 不受宿主 $LANG/OMD_LANG 影响
  beforeAll(() => setLang('zh'));
  afterAll(() => setLang(null));

  test('same-signature failures below threshold stay silent; crossing emits exactly one advisory', () => {
    const h = harness();
    h.failResult();
    h.failResult();
    expect(h.notifications.length).toBe(0);
    h.failResult(); // 第 3 次 → 越线
    expect(h.notifications.length).toBe(1);
    expect(h.notifications[0]!.level).toBe('warning');
    expect(h.notifications[0]!.text).toContain('连续失败 3 次');
    expect(h.entries).toHaveLength(1);
    expect(h.entries[0]!.type).toBe('tier-advisory');
    expect(h.entries[0]!.data.kind).toBe('consecutive');
    expect(h.entries[0]!.data.count).toBe(3);
  });

  test('no-spam: further failures of an already-advised signature do not re-emit', () => {
    const h = harness();
    for (let i = 0; i < 6; i++) h.failResult();
    expect(h.notifications.length).toBe(1); // 3 次越线发一次, 4/5/6 不刷
  });

  test('success of the same signature resets the streak AND re-arms the advisory', () => {
    const h = harness();
    h.failResult();
    h.failResult();
    h.okResult(); // 同签名成功 → 归零
    h.failResult();
    h.failResult();
    expect(h.notifications.length).toBe(0); // 复位后只连 2 次, 未越线
    h.failResult();
    expect(h.notifications.length).toBe(1); // 重新连满 3 次 → 再次可发
  });

  test('different inputs are different signatures (no cross-contamination)', () => {
    const h = harness();
    h.failResult('bash', { command: 'a' });
    h.failResult('bash', { command: 'b' });
    h.failResult('bash', { command: 'c' });
    expect(h.notifications.length).toBe(0); // 三个不同签名各 1 次, 无连续
    expect(failureSignature('bash', { command: 'a' })).not.toBe(failureSignature('bash', { command: 'b' }));
    expect(failureSignature('bash', { x: 1 })).toBe(failureSignature('bash', { x: 1 }));
  });

  test('session rolling window crosses at sessionThreshold across mixed signatures; turn_end resets', () => {
    const h = harness({ sessionThreshold: 4, threshold: 99 }); // 关掉同签名线, 只测窗口线
    h.failResult('bash', { command: 'a' });
    h.failResult('read', { path: 'b' });
    h.failResult('bash', { command: 'c' });
    expect(h.notifications.length).toBe(0);
    h.failResult('edit', { path: 'd' }); // 第 4 次 → 窗口越线
    expect(h.notifications.length).toBe(1);
    expect(h.entries[0]!.data.kind).toBe('session');
    h.failResult('bash', { command: 'e' }); // 已发 → 不刷
    expect(h.notifications.length).toBe(1);

    h.fire('turn_end', {});
    for (const c of ['f', 'g', 'h', 'i']) h.failResult('bash', { command: c });
    expect(h.notifications.length).toBe(2); // 窗口复位后重新计满再发
  });

  test('suggestion lists ONLY configured upgrade paths', () => {
    // 全裸配置: 无 escalation model, 贵层池空 → 只剩 redraw 一项
    const bare = harness();
    for (let i = 0; i < 3; i++) bare.failResult();
    const bareText = bare.notifications[0]!.text;
    expect(bareText).toContain('/execute --redraw');
    expect(bareText).not.toContain('OMD_CONDUCTOR_ESCALATION_MODEL');
    expect(bareText).not.toContain("depth:'deep'");
    expect(bare.entries[0]!.data.suggestions).toHaveLength(1);

    // 全配置: 三项全列, 且带具体坐标
    const full = harness({}, {
      env: { OMD_CONDUCTOR_ESCALATION_MODEL: 'deepseek:deepseek-v4-pro' },
      premiumPool: () => ['mimo:mimo-v2.5-pro'],
    });
    for (let i = 0; i < 3; i++) full.failResult();
    const fullText = full.notifications[0]!.text;
    expect(fullText).toContain('① 换更强 runtime/conductor (OMD_CONDUCTOR_ESCALATION_MODEL=deepseek:deepseek-v4-pro)');
    expect(fullText).toContain('② /execute --redraw "失败要点" 重画');
    expect(fullText).toContain("③ 媒体任务用 depth:'deep' 走贵层多模态池 (mimo:mimo-v2.5-pro)");
    expect(full.entries[0]!.data.suggestions).toHaveLength(3);
  });

  test('advisory-only: handlers never return a block verdict', () => {
    const h = harness();
    for (let i = 0; i < 5; i++) {
      const out = h.failResult();
      expect(out?.block).toBeUndefined();
    }
  });

  test('non-error results and malformed events are ignored quietly', () => {
    const h = harness();
    h.okResult();
    h.fire('tool_result', { content: [{ type: 'text', text: 'Error: no toolName' }] }); // 无 toolName → 忽略
    h.fire('tool_result', { toolName: 'bash' }); // 无 content → 非失败
    expect(h.notifications.length).toBe(0);
    expect(h.entries.length).toBe(0);
  });
});
