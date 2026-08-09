/**
 * pathfinder MCP 工具面测试: 全链 map→add→rule→deliver 在临时 cwd 上走通 (fake executeSlice,
 * 永不真跑模型/真 spawn); 交付语义与 TUI 同款 (全节点 done 才翻 delivered, 失败可重试)。
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPathfinderTools, type PathfinderToolDeps } from './pathfinder';
import { createOmdMemory } from '../../harness/memory/store';
import { validateFactWrite } from '../../memory/safeguards/validator';
import { checkEvolve } from '../../memory/safeguards/evolution-lock';
import { ConfidenceSchema } from '../../memory/safeguards/namespace-kernel';
import type { ValidatedFact } from '../../memory/safeguards/namespaces';

function tools(cwd: string, overrides: Partial<PathfinderToolDeps> = {}) {
  const deps: PathfinderToolDeps = {
    cwd,
    env: {},
    models: { conductorModel: '', leafModel: 'fake:leaf' },
    agentRunner: (async () => ({ text: '', usage: { in: 0, out: 0 } })) as PathfinderToolDeps['agentRunner'],
    commandRunner: (async () => ({ text: '', usage: { in: 0, out: 0 }, exitCode: 0 })) as PathfinderToolDeps['commandRunner'],
    dispatchFrontier: (() => ({ dispatched: [], reported: [] })) as unknown as PathfinderToolDeps['dispatchFrontier'],
    ...overrides,
  };
  const list = createPathfinderTools(deps);
  const byName = new Map(list.map((t) => [t.name, t]));
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await byName.get(name)!.handler(args as never, {} as never)) as {
      content: { text: string }[];
      isError?: boolean;
    };
    return { text: r.content[0]!.text, isError: r.isError === true };
  };
  return { call };
}

describe('pathfinder MCP tools', () => {
  test('map→add→rule→deliver 全链: 区域报信 → 显式交付 → 票翻 delivered', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pf-mcp-'));
    try {
      let executed = 0;
      const { call } = tools(dir, {
        executeSlice: (async (plan: { nodes: Record<string, unknown> }) => {
          executed++;
          return {
            results: Object.fromEntries(Object.keys(plan.nodes).map((id) => [id, { status: 'done' }])),
          };
        }) as unknown as PathfinderToolDeps['executeSlice'],
      });

      expect((await call('path_map')).text).toContain('无开放地图');
      expect((await call('path_map', { destination: 'Ship X' })).text).toContain('slug=ship-x');

      const add = await call('path_add', { title: 'build the thing', type: 'task' });
      expect(add.text).toContain('✓ 已加票 t1');

      const rule = await call('path_rule', { ticketId: 't1', ruling: 'do it with bun' });
      expect(rule.text).toContain('✓ 已裁 t1');
      expect(rule.text).toContain('path_deliver'); // 区域散尽只报信
      expect(executed).toBe(0); // rule 绝不执行

      const deliver = await call('path_deliver');
      expect(deliver.isError).toBe(false);
      expect(executed).toBe(1);
      expect(deliver.text).toContain('已交付');
      expect(deliver.text).toContain('delivered=1');

      // 已交付区域不复入: 再 deliver 无可交付。
      const again = await call('path_deliver');
      expect(again.isError).toBe(true);
      expect(executed).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('deliver 失败不标记: 有节点未 done → isError, 票保持 ruled 可重试', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pf-mcp-'));
    try {
      const { call } = tools(dir, {
        executeSlice: (async () => ({ results: { t1: { status: 'failed' } } })) as unknown as PathfinderToolDeps['executeSlice'],
      });
      await call('path_map', { destination: 'Ship X' });
      await call('path_add', { title: 'build', type: 'task' });
      await call('path_rule', { ticketId: 't1', ruling: 'go' });
      const deliver = await call('path_deliver');
      expect(deliver.isError).toBe(true);
      expect(deliver.text).toContain('未标记交付');
      // 仍可交付 (票还是 ruled)。
      expect((await call('path_tickets')).text).toContain('ruled=1');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('deliver spec 护栏: 复杂区域 (≥3 票) 缺 docs/plan/ 引用 → 拦截, 不编译不执行', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pf-mcp-'));
    try {
      let executed = 0;
      const { call } = tools(dir, {
        executeSlice: (async () => {
          executed++;
          return { results: {} };
        }) as unknown as PathfinderToolDeps['executeSlice'],
      });
      await call('path_map', { destination: 'Ship X' });
      // 3 张 task 票 → 复杂区域, ruling 都无 docs/plan/ 引用 → 应被闸拦。
      for (const id of ['t1', 't2', 't3']) {
        await call('path_add', { title: `build ${id}`, type: 'task', id });
        await call('path_rule', { ticketId: id, ruling: `just do ${id}` });
      }
      const deliver = await call('path_deliver');
      expect(deliver.isError).toBe(true);
      expect(deliver.text).toContain('docs/plan/');
      expect(deliver.text).toContain('/omd-contract');
      expect(executed).toBe(0); // 拦下时无 dag 执行调用
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * **prototype 票的隔离今天没生效, 而回话得说出来**(2026-08-06 查实)。
   *
   * D-13 给 prototype 设计的隔离 worktree 住在 `pathfinder/dispatch.ts` 的 `case 'prototype'` 里,
   * 而它**没有生产调用者** —— `dispatchFrontier` 只自动派 research 票, 注释说 prototype
   * 「仅 reported 给 UI 由人显式触发」,**而那个触发口从来没建过**
   * (盘上 `.omd/pathfinder/proto/` 一个目录都没有)。
   *
   * prototype 票实际走的是 `readyRegion → path_deliver → detached solve`, 而这条路
   * **不传 `branchStrategy`** → 缺省 `head` → **直接写主树**。
   * 于是「沙盒 spike, 试验码不污主树」这句话在生产上是反的。
   *
   * ⚠ 这条只钉**说出来**, 不钉改行为 —— 改成隔离是单独的决定 (隔离树看不见未提交的活),
   *   不是一行 default 的事。
   */
  test('★ prototype 票 fire 时, 回话必须说出「它正在直接写主树」', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pf-proto-'));
    try {
      const { call } = tools(dir, {
        dispatchGoal: (() => ({ runId: 'r-proto', already: false })) as unknown as PathfinderToolDeps['dispatchGoal'],
      });
      await call('path_map', { destination: 'Ship X' });
      await call('path_add', { title: 'spike 一下', type: 'prototype', id: 'p1' });
      await call('path_rule', { ticketId: 'p1', ruling: '试一版看看' });
      const deliver = await call('path_deliver');
      expect(deliver.text).toContain('prototype');
      expect(deliver.text).toContain('直接写主树'); // ← 本用例的全部意义
      expect(deliver.text).toContain('D-13');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('path_init 引导两步流: 无 backend → 报告; md 全参 → 执行建本地图', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pf-mcp-'));
    try {
      // 注入探针替身 (全绿) + 一触发即抛的 gh (md 路径不该调 gh)。
      const initOverrides: PathfinderToolDeps['initOverrides'] = {
        probes: {
          isGitRepo: () => true,
          githubRemote: () => 'acme/repo',
          ghAuthScopes: () => ['repo', 'workflow'],
          repoVisibility: () => 'private',
          actionsEnabled: () => true,
          hasKey: () => true,
        },
        gh: () => {
          throw new Error('md 路径不该调 gh');
        },
      };
      const { call } = tools(dir, { initOverrides });

      // 第一步: 无 backend → 探测报告 + 推荐, 不执行。
      const report = await call('path_init', { destination: 'Ship X' });
      expect(report.isError).toBe(false);
      expect(report.text).toContain('探测报告');
      expect(report.text).toContain('推荐: backend=gh');

      // 第二步: md 全参 → 执行建本地图。
      const exec = await call('path_init', { destination: 'Ship X', backend: 'md' });
      expect(exec.isError).toBe(false);
      expect(exec.text).toContain('backend=md');
      // 建成的图后续 path_map 可见。
      expect((await call('path_map')).text).toContain('ship-x');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('裁决写 memory: 经注入替身断言 fact 形状 (omd.pattern + scanSecrets:false)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pf-mcp-'));
    try {
      const writes: Array<{ fact: Record<string, unknown>; opts: { scanSecrets?: boolean } }> = [];
      const memory: PathfinderToolDeps['memory'] = {
        writeFact: (async (fact: Record<string, unknown>, opts: { scanSecrets?: boolean } = {}) => {
          writes.push({ fact, opts });
          return { status: 'written', id: 'm1', action: 'insert' };
        }) as NonNullable<PathfinderToolDeps['memory']>['writeFact'],
      };
      const { call } = tools(dir, { memory });

      await call('path_map', { destination: 'Ship Widget' });
      await call('path_add', { title: 'pick the datastore', type: 'grill' });
      const rule = await call('path_rule', { ticketId: 'g1', ruling: 'use SQLite' });
      expect(rule.isError).toBe(false);
      expect(rule.text).toContain('✓ 已裁 g1');

      expect(writes.length).toBe(1);
      const { fact, opts } = writes[0]!;
      expect(fact.namespace).toBe('omd.pattern');
      expect(fact.situation).toBe('Ship Widget: pick the datastore');
      expect(fact.approach).toBe('use SQLite');
      expect(fact.outcome).toBe('worked');
      // memory_remember 同款: 显式写绕过密钥闸 (用户主权)。
      expect(opts.scanSecrets).toBe(false);
      // 裁决 8 改判 human_verified 后, confidence 为 owner 确认态。
      const conf = fact.confidence as Record<string, unknown>;
      expect(conf.level).toBe('human_verified');
      expect(conf.by).toBe('owner');
      expect(conf.verified_at).toBeInstanceOf(Date);
      expect(conf.note).toBe('path_rule:ship-widget:g1');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('裁决写 memory 真往返: 真 OmdMemory remember → recall(destination 关键词) 召回该 fact', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pf-mcp-'));
    const memory = createOmdMemory(); // 默认 :memory: + UNIVERSAL_SAFEGUARD (含 omd.pattern), 进程内真往返。
    try {
      const { call } = tools(dir, { memory });
      await call('path_map', { destination: 'Ship Widget' });
      await call('path_add', { title: 'pick the datastore', type: 'grill' });
      await call('path_rule', { ticketId: 'g1', ruling: 'use SQLite for the ledger' });

      // 消费端真检索 (memory_recall 同款 retrieve): 用 destination 关键词命中该裁决 fact。
      const hits = await memory.retrieve('Widget datastore', 10);
      expect(hits.length).toBeGreaterThan(0);
      const joined = hits.map((h) => h.text).join('\n');
      expect(joined).toContain('use SQLite for the ledger');
      expect(joined).toContain('Ship Widget');
    } finally {
      memory.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('裁决写 memory 失败不阻断: writeFact throw → 裁决仍成功 + warn 行', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pf-mcp-'));
    try {
      const memory: PathfinderToolDeps['memory'] = {
        writeFact: (async () => {
          throw new Error('memory offline');
        }) as NonNullable<PathfinderToolDeps['memory']>['writeFact'],
      };
      const { call } = tools(dir, { memory });
      await call('path_map', { destination: 'Ship Widget' });
      await call('path_add', { title: 'x', type: 'grill' });
      const rule = await call('path_rule', { ticketId: 'g1', ruling: 'go' });
      // 裁决本身不受 memory 故障影响 (增益不是链路)。
      expect(rule.isError).toBe(false);
      expect(rule.text).toContain('✓ 已裁 g1');
      expect(rule.text).toContain('⚠');
      expect(rule.text).toContain('memory 是增益');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('slug 歧义: 多图省略 slug → 报错列 slug; blockedBy 引用不存在 → 拒', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pf-mcp-'));
    try {
      const { call } = tools(dir);
      await call('path_map', { destination: 'Ship X' });
      await call('path_map', { destination: 'Ship Y' });
      const amb = await call('path_tickets');
      expect(amb.isError).toBe(true);
      expect(amb.text).toContain('ship-x');
      const bad = await call('path_add', { title: 'x', slug: 'ship-x', blockedBy: ['nope'] });
      expect(bad.isError).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * 闸 (a): path_rule 写入的 fact (human_verified) 过 validator 不被拒。
   *
   * 反向自检: 把 pathfinder.ts:271 临时改成 `{ level:'agent_confident', source_event_ids:[anchor], created_at:new Date() }`
   * (单锚, 不满足 agent_confident 的 min(3) source_event_ids) → validator 返回 `schema:Too small: expected array to have >=3 items`。
   * 证伪方式: 改 pathfinder.ts → 跑本测试 → 见 `expect(v.ok).toBe(true)` 变红, reason 如上。
   * 已改回 human_verified 形态, 测试绿。
   */
  test('闸(a): path_rule 写入 human_verified fact 过 validator', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pf-mcp-'));
    try {
      const writes: Array<Record<string, unknown>> = [];
      const memory: PathfinderToolDeps['memory'] = {
        writeFact: (async (fact: Record<string, unknown>) => {
          writes.push(fact);
          return { status: 'written', id: 'm1', action: 'insert' };
        }) as NonNullable<PathfinderToolDeps['memory']>['writeFact'],
      };
      const { call } = tools(dir, { memory });

      await call('path_map', { destination: 'Ship V' });
      await call('path_add', { title: 'choose db', type: 'grill' });
      await call('path_rule', { ticketId: 'g1', ruling: 'use pg' });

      expect(writes.length).toBe(1);
      const fact = writes[0]!;

      // 过全量 validator (与 writeFact 实际路径同款)。
      const v = validateFactWrite(fact);
      expect(v.ok).toBe(true);
      if (v.ok) {
        expect(v.validated.confidence.level).toBe('human_verified');
      }

      // 额外: 确认 agent_confident 单锚确实会被 schema 拒 (文档化, 非运行时闸)。
      const bad = ConfidenceSchema.safeParse({
        level: 'agent_confident',
        source_event_ids: ['single-anchor'],
        created_at: new Date(),
      });
      expect(bad.success).toBe(false);
      if (!bad.success) {
        expect(bad.error.issues[0]?.message).toContain('3');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * 闸 (b): 同 identity 已有 human_verified → agent_tentative 写入被 checkEvolve 拒。
   *
   * 反向自检: 把 existing 从 human_verified 改成 agent_tentative (同 identity), 同样 incoming 应为 replace。
   * 证伪方式: 改 existing.confidence 为 tentative → 跑本测试 → 见 `expect(result.action).toBe('reject')` 变红,
   * action='replace'。已改回 human_verified, 测试绿。证明闸分得开 human_verified(reject) 与 tentative(replace) 两档。
   */
  test('闸(b): human_verified 现有 → agent_tentative 写入 checkEvolve 判 reject', () => {
    const existing: ValidatedFact = {
      namespace: 'omd.pattern',
      situation: 'Ship X: pick db',
      approach: 'use SQLite',
      outcome: 'worked',
      source_event_id: 'path_rule:ship-x:g1',
      confidence: {
        level: 'human_verified',
        by: 'owner',
        verified_at: new Date('2026-08-01'),
        note: 'path_rule:ship-x:g1',
      },
    };

    const incoming: ValidatedFact = {
      namespace: 'omd.pattern',
      situation: 'Ship X: pick db',
      approach: 'use Postgres',
      outcome: 'worked',
      source_event_id: 'path_rule:ship-x:g1-v2',
      confidence: {
        level: 'agent_tentative',
        source_event_ids: ['path_rule:ship-x:g1-v2'],
        created_at: new Date('2026-08-02'),
      },
    };

    // human_verified 是 immutable → reject
    const result = checkEvolve(existing, incoming);
    expect(result.action).toBe('reject');
    expect(result.reason).toBe('human-verified-immutable');

    // 反向自检: existing 为 tentative 时, 同样 incoming 应为 replace
    const existingTentative: ValidatedFact = {
      ...existing,
      confidence: {
        level: 'agent_tentative',
        source_event_ids: ['path_rule:ship-x:g1'],
        created_at: new Date('2026-08-01'),
      },
    };
    const resultReplace = checkEvolve(existingTentative, incoming);
    expect(resultReplace.action).toBe('replace');
  });
});