import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPlanExtension } from './plan-extension';
import { createPlanModeState } from './mode';
import { PlanLedger } from './ledger';
import { renderSddDoc, SDD_EXTRA_SECTIONS } from './sdd-template';
import type { SessionStore } from './session-store';

/** /sdd 输出必含的 canonical-plan 增强段标题。 */
const SDD_HEADINGS = [
  '## 测试接缝 (Seams)',
  '## 先红纪律',
  '## Oracle-cmd',
  '## Allowed files / Forbidden files',
  '## Review Gate',
  '## 决策记录 (D-numbers)',
];

/** 假 pi (mirror verify-gate-extension.test.ts): 收集 registerCommand handler, 手工驱动命令。 */
function harness(cwd: string) {
  const commands = new Map<string, Function>();
  const pi = {
    registerShortcut() {},
    registerCommand(name: string, def: { handler: Function }) {
      commands.set(name, def.handler);
    },
    on() {},
    exec: async () => ({ code: 1, stdout: '', stderr: 'stub' }),
    getSessionName: () => 'test-session',
  };
  const recorded: unknown[] = [];
  const sessionStore: SessionStore = {
    record(c) {
      recorded.push(c);
      return 'id';
    },
    bySession: () => [],
    search: () => [],
    list: () => [],
    close() {},
  };
  const ledger = new PlanLedger({ goal: '测试目标' });
  ledger.note('D 决策一');
  const state = createPlanModeState(ledger);
  // D-12: 技能解绑, /sdd 无需 plan mode (普通聊天可用)。
  const factory = createPlanExtension({
    state,
    sessionStore,
    retriever: { fetch: async () => ({ ok: false as const, url: '', error: 'stub' }) } as never,
    distill: (async () => ({ relevance: '', extract: '' })) as never,
  });
  factory(pi as never);
  const notices: string[] = [];
  const ctx = {
    cwd,
    ui: { notify: (m: string) => notices.push(m), setStatus() {} },
  };
  const run = (name: string, args = '') => commands.get(name)!(args, ctx);
  return { run, notices, recorded, ledger };
}

describe('sdd-template', () => {
  test('renderSddDoc 在共享骨架后追加全部增强段', () => {
    const doc = renderSddDoc('# 标题\n\n## Contracts (钉不变量, 非全行为)\n');
    expect(doc).toContain('## Contracts');
    for (const h of SDD_HEADINGS) expect(doc).toContain(h);
    // 纪律条文钉住 (不只是标题存在)
    expect(doc).toContain('接缝需 owner 确认后才进实现');
    expect(doc).toContain('红→绿→重构');
    expect(doc).toContain('exit 0 = pass');
    expect(doc).toContain('fleet 越界即违约');
    expect(doc).toContain('owner 终审');
    expect(doc).toContain('上报 owner');
  });

  test('/sdd 落盘 docs/plan 文档含共享骨架 + 增强段', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omd-sdd-'));
    const h = harness(cwd);
    await h.run('sdd', '我的 feature');
    const dir = join(cwd, 'docs', 'plan');
    const files = readdirSync(dir);
    expect(files.length).toBe(1);
    const doc = readFileSync(join(dir, files[0]!), 'utf8');
    // 共享骨架仍在
    expect(doc).toContain('# 我的 feature');
    expect(doc).toContain('## Contracts (钉不变量, 非全行为)');
    expect(doc).toContain('## TDD 红测清单');
    // 增强段全部出现
    for (const heading of SDD_HEADINGS) expect(doc).toContain(heading);
    // 结晶库照记
    expect(h.recorded.length).toBe(1);
  });

  test('/crystallize 共享骨架不背 sdd 增强段 (两路分离)', () => {
    // ledger.crystallize 是共享骨架的唯一产出口; 增强段只由 renderSddDoc 追加。
    const base = new PlanLedger().crystallize('t', '2026-07-19');
    expect(base).toContain('## Contracts');
    for (const h of SDD_HEADINGS) expect(base).not.toContain(h);
    expect(base).not.toContain(SDD_EXTRA_SECTIONS.slice(0, 20));
  });
});
