import { describe, expect, test } from 'bun:test';
import { createVerifyGateExtension, type RunResult } from './verify-gate-extension';

/** 假 pi: 收集 registerTool / on handler, 手工驱动事件流。 */
function harness(runResults: RunResult[]) {
  const handlers = new Map<string, Function[]>();
  let verifyExecute: Function | null = null;
  const pi = {
    registerTool(def: { name: string; execute: Function }) {
      if (def.name === 'verify_changes') verifyExecute = def.execute;
    },
    on(event: string, fn: Function) {
      handlers.set(event, [...(handlers.get(event) ?? []), fn]);
    },
  };
  const queue = [...runResults];
  const factory = createVerifyGateExtension({}, { run: () => queue.shift() ?? { errored: true, ok: false, output: 'queue empty' } });
  factory(pi as never);

  const fire = (event: string, payload: unknown) => {
    let out: unknown;
    for (const fn of handlers.get(event) ?? []) out = fn(payload, { ui: {} });
    return out as { block?: boolean; reason?: string } | undefined;
  };
  const verify = (mode?: string) => verifyExecute!('id', { mode }, undefined, undefined, { cwd: '/', ui: {} });
  return { fire, verify };
}

const editOk = { toolName: 'edit', input: { path: 'src/a.ts' }, content: [{ type: 'text', text: 'ok' }] };
const bashCall = { toolName: 'bash', input: { command: 'bun run deploy' } };

const PASS: RunResult = { errored: false, ok: true, output: '' };
const FAIL: RunResult = { errored: false, ok: false, output: '2 tests failed' };

describe('verify-gate', () => {
  test('write marks dirty → bash blocked; edit/write never blocked', () => {
    const h = harness([]);
    h.fire('tool_result', editOk);
    const verdict = h.fire('tool_call', bashCall);
    expect(verdict?.block).toBe(true);
    expect(verdict?.reason).toContain('src/a.ts');
    expect(h.fire('tool_call', { toolName: 'edit', input: { path: 'x' } })?.block).toBeUndefined();
  });

  test('git undo escapes the gate and clears dirty on success', () => {
    const h = harness([]);
    h.fire('tool_result', editOk);
    const undo = { toolName: 'bash', input: { command: 'git checkout -- src/a.ts' } };
    expect(h.fire('tool_call', undo)?.block).toBeUndefined();
    h.fire('tool_result', { ...undo, content: [{ type: 'text', text: 'done' }] });
    expect(h.fire('tool_call', bashCall)?.block).toBeUndefined();
  });

  test('verify green (tc + test) clears the gate', async () => {
    const h = harness([PASS, PASS]);
    h.fire('tool_result', editOk);
    const res = await h.verify();
    expect(res.content[0].text).toContain('✅');
    expect(h.fire('tool_call', bashCall)?.block).toBeUndefined();
  });

  test('typecheck not completing (spawn error) keeps the gate', async () => {
    const h = harness([{ errored: true, ok: false, output: 'ENOENT' }]);
    h.fire('tool_result', editOk);
    const res = await h.verify();
    expect(res.content[0].text).toContain('❌');
    expect(h.fire('tool_call', bashCall)?.block).toBe(true);
  });

  test('test env-unavailable is skipped (clears), real test failure keeps gate', async () => {
    const down = harness([PASS, { errored: false, ok: false, output: 'ECONNREFUSED 127.0.0.1:5432' }]);
    down.fire('tool_result', editOk);
    expect((await down.verify()).content[0].text).toContain('✅');

    const broken = harness([PASS, FAIL]);
    broken.fire('tool_result', editOk);
    expect((await broken.verify()).content[0].text).toContain('❌');
    expect(broken.fire('tool_call', bashCall)?.block).toBe(true);
  });

  test('quick mode skips tests entirely', async () => {
    const h = harness([PASS, FAIL]); // FAIL would trip if tests ran
    h.fire('tool_result', editOk);
    expect((await h.verify('quick')).content[0].text).toContain('✅');
  });

  test('failed write result does not mark dirty', () => {
    const h = harness([]);
    h.fire('tool_result', { toolName: 'edit', input: { path: 'x' }, content: [{ type: 'text', text: 'Error: no match' }] });
    expect(h.fire('tool_call', bashCall)?.block).toBeUndefined();
  });
});
