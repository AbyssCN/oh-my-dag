/**
 * runScopedSession 早期心跳闸守卫 (issue #5)。
 * 证: 窗口内零输出+无工具活动 → 提前 abort 标 stall; 有输出/有工具活动 → 不误杀 (正常完成)。
 * 用假 session (可控 emit + prompt resolve 时机), 不碰 live 模型。
 */
import { describe, expect, test } from 'bun:test';
import { runScopedSession, type ScopedRunOutcome } from './pi-runtime';

type Listener = (e: unknown) => void;

/** 假 scoped session: 可脚本化 emit 事件 + 由 abort 决定 prompt 何时 resolve。 */
function fakeSession(script: { emit?: (l: Listener) => void; selfResolveMs?: number }) {
  let listener: Listener | null = null;
  let resolvePrompt: (() => void) | null = null;
  const s = {
    subscribe(l: Listener) {
      listener = l;
      return () => {
        listener = null;
      };
    },
    prompt() {
      return new Promise<void>((res) => {
        resolvePrompt = res;
        if (listener && script.emit) script.emit(listener);
        // selfResolveMs: 正常完成路径 (leaf 自己跑完); 省略 = 只能被 abort resolve (停摆路径)。
        if (script.selfResolveMs != null) setTimeout(() => res(), script.selfResolveMs);
      });
    },
    async abort() {
      resolvePrompt?.(); // abort → settle 流 → prompt() resolve (与真 pi 语义一致)
    },
    dispose() {},
    setModel: async () => {},
    setThinkingLevel() {},
    hasExtensionHandlers() {
      return false;
    },
  };
  return s as unknown as Parameters<typeof runScopedSession>[0];
}

const textDelta = (delta: string) => ({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta } });

describe('runScopedSession 心跳闸 (issue #5)', () => {
  test('零输出+无工具活动 → 心跳闸提前中止标 stall', async () => {
    let outcome: ScopedRunOutcome | undefined;
    const session = fakeSession({}); // 从不 emit, 从不自 resolve → 只能被心跳闸 abort
    const text = await runScopedSession(session, 'p', {
      timeoutMs: 5000,
      heartbeatMs: 20,
      onOutcome: (o) => { outcome = o; },
    });
    expect(outcome?.stalled).toBe(true);
    expect(outcome?.timedOut).toBe(false);
    expect(text).toBe('');
  });

  test('输出高于下限 → 不判 stall (正常完成)', async () => {
    let outcome: ScopedRunOutcome | undefined;
    const session = fakeSession({
      emit: (l) => l(textDelta('x'.repeat(64))), // 立即输出 64B > 下限 32
      selfResolveMs: 60,
    });
    const text = await runScopedSession(session, 'p', {
      timeoutMs: 5000,
      heartbeatMs: 20,
      onOutcome: (o) => { outcome = o; },
    });
    expect(outcome?.stalled).toBe(false);
    expect(text).toBe('x'.repeat(64));
  });

  test('有工具活动即便低文本输出 → 不误杀 (合法慢叶子豁免)', async () => {
    let outcome: ScopedRunOutcome | undefined;
    const session = fakeSession({
      emit: (l) => l({ type: 'tool_execution_start', toolName: 'bash' }), // 工具活动 = 模型已应答
      selfResolveMs: 60,
    });
    await runScopedSession(session, 'p', {
      timeoutMs: 5000,
      heartbeatMs: 20,
      onOutcome: (o) => { outcome = o; },
    });
    expect(outcome?.stalled).toBe(false);
  });
});
