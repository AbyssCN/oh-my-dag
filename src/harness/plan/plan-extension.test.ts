import { describe, expect, test } from 'bun:test';
import { createPlanExtension } from './plan-extension';
import { createPlanModeState } from './mode';
import { PlanLedger } from './ledger';

/** 假 pi: 收集 registerCommand + on handler。 */
function harness() {
  const commands = new Map<string, Function>();
  const events = new Map<string, Function[]>();
  const pi = {
    registerShortcut() {},
    registerCommand(name: string, def: { handler: Function }) {
      commands.set(name, def.handler);
    },
    on(ev: string, fn: Function) {
      events.set(ev, [...(events.get(ev) ?? []), fn]);
    },
    exec: async () => ({ code: 1, stdout: '', stderr: 'stub' }),
    getSessionName: () => 'test-session',
  };
  const state = createPlanModeState(new PlanLedger({ goal: 'g' }));
  createPlanExtension({ state })(pi as never);
  const notices: string[] = [];
  const ctx = { cwd: '/tmp', ui: { notify: (m: string) => notices.push(m), setStatus() {} } };
  return {
    state,
    commands,
    events,
    notices,
    run: (name: string, args = '') => commands.get(name)!(args, ctx),
    has: (name: string) => commands.has(name),
  };
}

describe('plan-extension (D-12 skills unbound)', () => {
  test('skills registered as plain slash commands', () => {
    const h = harness();
    for (const c of ['note', 'ref', 'search', 'grill', 'crystallize', 'sdd', 'crystals', 'council']) {
      expect(h.has(c)).toBe(true);
    }
  });

  test('does NOT register shift+tab / plan toggle (pathfinder owns it now)', () => {
    const h = harness();
    // no /plan command, no tool_call write-block
    expect(h.has('plan')).toBe(false);
  });

  test('D-5 open src: no readonly write-block (no tool_call gate registered)', () => {
    const h = harness();
    expect(h.events.has('tool_call')).toBe(false);
  });

  test('/note works in plain chat (no plan mode required; status stays normal)', async () => {
    const h = harness();
    await h.run('note', 'D1 use markdown-in-git');
    expect(h.state.status).toBe('normal');
    expect(h.state.ledger.decisions.length).toBe(1);
  });

  test('/grill toggles without requiring plan mode', async () => {
    const h = harness();
    await h.run('grill');
    expect(h.state.grilling).toBe(true);
    await h.run('grill');
    expect(h.state.grilling).toBe(false);
  });
});
