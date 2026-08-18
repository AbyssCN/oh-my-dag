/**
 * c1 波契约测试 (D-G1.1/G1.2, GWT-G1-1) — goal 档票的分流与幂等分派。
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PathMap, Ticket } from './types';
import { compileSlice } from './slice-compiler';
import { dispatchGoalTicket, goalDispatchedPath } from './dispatch';
import { saveMap } from './maps';
import { resolveBackend } from './backend';
import { createPathfinderTools, readyRegion } from '../../mcp/tools/pathfinder';

const t = (over: Partial<Ticket> & { id: string }): Ticket => ({
  type: 'task',
  title: `票 ${over.id}`,
  blockedBy: [],
  status: 'ruled',
  ruling: `干 ${over.id}`,
  ...over,
});

describe('readyRegion 分流 (D-G1.1/G1.2)', () => {
  test('goal 档票进 goals 侧; prototype **一律** goal (#135 裁②, 与 executorKind 无关); 普通 task 进 slice 侧', () => {
    const map: PathMap = {
      destination: 'd', slug: 'm', decisionsLog: [],
      tickets: [
        t({ id: 't1' }),
        t({ id: 't2', executorKind: 'goal' }),
        t({ id: 'p1', type: 'prototype' }),
        // #135 (#103 实踩): 旧判据让 prototype+agent 掉进 slice, 而 compileSlice 拒非 task 票 ——
        // 建票合法、几天后 path_deliver 才炸。现在按 type 判, prototype 恒归 goals。
        // 证伪: isGoalKind 换回 `type==='prototype' && executorKind===undefined` 即此条红。
        t({ id: 'p2', type: 'prototype', executorKind: 'agent' }),
      ],
    };
    expect(readyRegion(map)).toEqual({ slice: ['t1'], goals: ['t2', 'p1', 'p2'] });
  });

  test('#138: 交付级前置未满足的 ruled 票被**排除**出区域 (不冻结整区); 前置 delivered 后才进', () => {
    // #102/#124 的真实形状: A (S2) 已裁未交付, B (S3) 已裁且 blockedByDelivery=[A] ——
    // 旧行为 B 进区域 (被裁即解锁), 差一步就拿没量出来过的 T=10/W=5 实装 (误杀回测 72:2)。
    // 证伪: readyRegion 去掉 blockedByDelivery 过滤 → 第一段 slice 含 'b', 断言红。
    const a = t({ id: 'a' });
    const b = t({ id: 'b', blockedByDelivery: ['a'] });
    const waiting: PathMap = { destination: 'd', slug: 'm', decisionsLog: [], tickets: [a, b] };
    expect(readyRegion(waiting)).toEqual({ slice: ['a'], goals: [] }); // b 排除, a 不受牵连
    const done: PathMap = { destination: 'd', slug: 'm', decisionsLog: [], tickets: [{ ...a, status: 'delivered' }, b] };
    expect(readyRegion(done)).toEqual({ slice: ['b'], goals: [] }); // a 真出数后 b 解锁
  });

  test('#138 硬闸半: regionIsClear 对交付前置未满足的票直接拒 (绕过 readyRegion 直呼编译也拦得住)', () => {
    const map: PathMap = {
      destination: 'd', slug: 'm', decisionsLog: [],
      tickets: [t({ id: 'a' }), t({ id: 'b', blockedByDelivery: ['a'] })],
    };
    expect(() => compileSlice(map, ['b'])).toThrow(/交付前置/);
  });

  test('compileSlice 收到 goal 档票 → 响亮炸 (D-G1.2 fail-loud, 不静默降级 leaf)', () => {
    const map: PathMap = { destination: 'd', slug: 'm', decisionsLog: [], tickets: [t({ id: 't2', executorKind: 'goal' })] };
    expect(() => compileSlice(map, ['t2'])).toThrow(/goal 档/);
  });
});

describe('dispatchGoalTicket 幂等 (GWT-G1-1 后半)', () => {
  test('首派 spawn + 写标记; 二派命中标记不重 spawn 且 runId 稳定', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'goal-disp-'));
    const spawns: string[][] = [];
    const deps = { spawnDetached: (cmd: string[]) => (spawns.push(cmd), 123), makeRunId: () => 'run-fixed' };
    const d1 = dispatchGoalTicket(cwd, 'm', t({ id: 't2' }), '收敛这个目标', deps);
    expect(d1).toEqual({ runId: 'run-fixed', already: false });
    expect(spawns).toHaveLength(1);
    expect(spawns[0]!.join(' ')).toContain('--goal 收敛这个目标');
    expect(spawns[0]!.join(' ')).toContain('--max-rounds 2'); // D-G1.6 默认档
    expect(readFileSync(goalDispatchedPath(cwd, 'm', 't2'), 'utf8')).toBe('run-fixed');
    const d2 = dispatchGoalTicket(cwd, 'm', t({ id: 't2' }), '收敛这个目标', deps);
    expect(d2).toEqual({ runId: 'run-fixed', already: true });
    expect(spawns).toHaveLength(1); // 没有第二次 spawn
    rmSync(cwd, { recursive: true, force: true });
  });

  test('spawn 抛错 → 不写标记 (无"已派"假象, 可重试)', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'goal-disp-'));
    expect(() =>
      dispatchGoalTicket(cwd, 'm', t({ id: 't2' }), 'x', { spawnDetached: () => { throw new Error('spawn 炸'); } }),
    ).toThrow(/spawn 炸/);
    expect(existsSync(goalDispatchedPath(cwd, 'm', 't2'))).toBe(false);
    rmSync(cwd, { recursive: true, force: true });
  });
});

describe('path_deliver 分流 (GWT-G1-1)', () => {
  test('纯 goal 区域: fire fake solve, slice 不编, 票留 ruled', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'goal-del-'));
    const map: PathMap = { destination: '图', slug: 'm1', decisionsLog: [], tickets: [t({ id: 't2', executorKind: 'goal' })] };
    saveMap(map, cwd);
    const fired: string[] = [];
    let sliceRan = false;
    const tools = createPathfinderTools({
      cwd,
      env: { OMD_PATH_BACKEND: 'md' },
      models: { conductorModel: 'x', leafModel: 'x' },
      agentRunner: (async () => ({ text: '', usage: { in: 0, out: 0 } })) as never,
      commandRunner: (async () => ({ text: '', usage: { in: 0, out: 0 }, timedOut: false, signal: null, exitCode: 0 })) as never,
      resolveBackend: (c) => resolveBackend(c, { env: { OMD_PATH_BACKEND: 'md' } }),
      // 切片 6: 派发口收**票**不收 id (D-3 闸够得着类了) —— 替身跟着改形状。
      dispatchGoal: ((_c: string, _s: string, gt: Ticket, goalText: string) => {
        fired.push(`${gt.id}:${goalText}`);
        return { runId: 'run-g', already: false };
      }) as never,
      executeSlice: (async () => ((sliceRan = true), { results: {}, verification: { pass: true } })) as never,
    });
    const deliver = tools.find((x) => x.name === 'path_deliver')!;
    const res = (await deliver.handler({}, {} as never)) as { content: { text: string }[]; isError?: boolean };
    expect(res.isError).not.toBe(true);
    expect(fired).toEqual(['t2:干 t2']); // goal=ruling 全文
    expect(sliceRan).toBe(false); // slice 图不含 goal 票
    const backend = resolveBackend(cwd, { env: { OMD_PATH_BACKEND: 'md' } });
    expect(backend.readMap(cwd, 'm1')!.tickets[0]!.status).toBe('ruled'); // 在飞, 未 delivered
    rmSync(cwd, { recursive: true, force: true });
  });
});

// ── c2 波: 回流三态映射 (GWT-G1-2/3) ─────────────────────────────────────────

import { mkdirSync, writeFileSync } from 'node:fs';
import { reflowGoalResults } from './afk-hook';
import { goalResumePath, researchResultPath } from './dispatch';

const writeResult = (cwd: string, slug: string, id: string, outcome: string, body = '摘要') => {
  const p = researchResultPath(cwd, slug, id);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, `outcome: ${outcome}\nrunId: run-${id}\n\n${body}`);
};

const goalMapOn = (cwd: string, id = 'g9'): void => {
  const map: PathMap = {
    destination: '图', slug: 'm1', decisionsLog: [],
    tickets: [t({ id, executorKind: 'goal' })],
  };
  saveMap(map, cwd);
};

const mdBackend = (cwd: string) => resolveBackend(cwd, { env: { OMD_PATH_BACKEND: 'md' } });

describe('reflowGoalResults 三态映射 (D-G1.4, GWT-G1-2)', () => {
  test('success → 票 delivered, 结果文件归档 .done, 标记清空', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'goal-rf-'));
    goalMapOn(cwd);
    writeResult(cwd, 'm1', 'g9', 'success');
    const out = reflowGoalResults(mdBackend(cwd), cwd, 'm1');
    expect(out).toEqual([{ ticketId: 'g9', disposition: 'delivered', outcome: 'success', runId: 'run-g9' }]);
    expect(mdBackend(cwd).readMap(cwd, 'm1')!.tickets[0]!.status).toBe('delivered');
    expect(existsSync(researchResultPath(cwd, 'm1', 'g9'))).toBe(false);
    expect(existsSync(`${researchResultPath(cwd, 'm1', 'g9')}.done`)).toBe(true);
    rmSync(cwd, { recursive: true, force: true });
  });

  test('blocked → 票 escalated (需人)', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'goal-rf-'));
    goalMapOn(cwd);
    writeResult(cwd, 'm1', 'g9', 'blocked', '要 owner 给凭证');
    const out = reflowGoalResults(mdBackend(cwd), cwd, 'm1');
    expect(out[0]!.disposition).toBe('escalated');
    expect(mdBackend(cwd).readMap(cwd, 'm1')!.tickets[0]!.status).toBe('escalated');
    rmSync(cwd, { recursive: true, force: true });
  });

  test('not-converged → 票留 ruled + 续跑锚落盘 + 结果归档 .attempt (不重复折入)', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'goal-rf-'));
    goalMapOn(cwd);
    writeResult(cwd, 'm1', 'g9', 'not-converged');
    const out = reflowGoalResults(mdBackend(cwd), cwd, 'm1');
    expect(out[0]!.disposition).toBe('resumable');
    expect(mdBackend(cwd).readMap(cwd, 'm1')!.tickets[0]!.status).toBe('ruled');
    expect(readFileSync(goalResumePath(cwd, 'm1', 'g9'), 'utf8')).toBe('run-g9');
    // 幂等: 再折一次无事发生 (结果文件已归档)
    expect(reflowGoalResults(mdBackend(cwd), cwd, 'm1')).toEqual([]);
    rmSync(cwd, { recursive: true, force: true });
  });

  test('GWT-G1-3: not-converged 后再派 → 用旧 runId 续 (resume 语义), 不造新 run', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'goal-rf-'));
    goalMapOn(cwd);
    writeResult(cwd, 'm1', 'g9', 'not-converged');
    reflowGoalResults(mdBackend(cwd), cwd, 'm1');
    const spawns: string[][] = [];
    const d = dispatchGoalTicket(cwd, 'm1', t({ id: 'g9' }), '继续收敛', { spawnDetached: (c) => (spawns.push(c), 1), makeRunId: () => 'run-NEW' });
    expect(d.runId).toBe('run-g9'); // 旧 runId, 不是 run-NEW
    expect(spawns[0]!.join(' ')).toContain('--run-id run-g9');
    expect(spawns[0]!.join(' ')).toContain('--result-out'); // 结果通道接上
    rmSync(cwd, { recursive: true, force: true });
  });

  test('research 票的结果文件不走 goal 路 (语义分离)', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'goal-rf-'));
    const map: PathMap = { destination: '图', slug: 'm1', decisionsLog: [], tickets: [{ id: 'r9', type: 'research', title: '查', blockedBy: [], status: 'open' }] };
    saveMap(map, cwd);
    writeResult(cwd, 'm1', 'r9', 'success');
    expect(reflowGoalResults(mdBackend(cwd), cwd, 'm1')).toEqual([]); // 不碰 research
    rmSync(cwd, { recursive: true, force: true });
  });
});

// ── c3 波: 发现物提取 → 建议票 (D-G1.5, GWT-G1-2 后半) ───────────────────────

import { extractGoalDiscoveries } from './afk-hook';

describe('extractGoalDiscoveries 词表 (D-G1.5)', () => {
  test('三类行各提一条; success stage 不提', () => {
    const body = [
      'goal: 干活',
      'tier: complex · 未收敛 · 2 轮',
      '  [success] research — 查完了',
      '  [oracle-failed/failed] execute — tsc 两处红',
      '阻塞 (需外部输入): 要 GCP 凭证',
      '预算停: 30 分钟到顶',
    ].join('\n');
    expect(extractGoalDiscoveries(body)).toEqual([
      { type: 'task', title: '[未收敛·execute] tsc 两处红' },
      { type: 'grill', title: '[阻塞] 要 GCP 凭证' },
      { type: 'task', title: '[预算停] 30 分钟到顶' },
    ]);
  });

  test('无失败面 → 空 (success 结果不产建议)', () => {
    expect(extractGoalDiscoveries('goal: x\n  [success] execute — 全绿')).toEqual([]);
  });
});

describe('c3 折入端到端: 发现物入图 suggested 态', () => {
  test('blocked 结果 → escalated + [阻塞] suggested 票溯源 runId + 台账留痕', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'goal-c3-'));
    goalMapOn(cwd);
    writeResult(cwd, 'm1', 'g9', 'blocked', '干到一半\n阻塞 (需外部输入): 要 owner 给 API key');
    const out = reflowGoalResults(mdBackend(cwd), cwd, 'm1', { at: '2026-08-04T12:00:00Z' });
    expect(out[0]!.disposition).toBe('escalated');
    expect(out[0]!.suggested).toContain('建议入图 1');
    const m = mdBackend(cwd).readMap(cwd, 'm1')!;
    const sugg = m.tickets.find((x) => x.status === 'suggested')!;
    // 契约 (2): caller (suggestFrom) 统一挂 resume 锚; runId = 结果文件 head.runId = 'run-g9'。
    expect(sugg.title).toBe('[阻塞] 要 owner 给 API key · resume: dag_goal resume=run-g9');
    expect(sugg.type).toBe('grill');
    expect(sugg.suggestedBy).toBe('run-g9');
    rmSync(cwd, { recursive: true, force: true });
  });

  test('同一发现物重复折入 (两张 goal 票同病) → 第二次被指纹/语义档去重, 不翻倍', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'goal-c3-'));
    const map: PathMap = {
      destination: '图', slug: 'm1', decisionsLog: [],
      tickets: [t({ id: 'g1', executorKind: 'goal' }), t({ id: 'g2', executorKind: 'goal' })],
    };
    saveMap(map, cwd);
    writeResult(cwd, 'm1', 'g1', 'not-converged', '  [oracle-failed] execute — tsc 红');
    writeResult(cwd, 'm1', 'g2', 'not-converged', '  [oracle-failed] execute — tsc 红');
    const out = reflowGoalResults(mdBackend(cwd), cwd, 'm1', { at: '2026-08-04T12:00:00Z' });
    expect(out).toHaveLength(2);
    const m = mdBackend(cwd).readMap(cwd, 'm1')!;
    expect(m.tickets.filter((x) => x.status === 'suggested')).toHaveLength(1); // 只入一张
    expect(m.suggestionsLog!.some((e) => e.outcome === 'deduped' || e.outcome === 'deduped-semantic')).toBe(true); // 去重有痕
    rmSync(cwd, { recursive: true, force: true });
  });
});

// ── 2026-08-10 事故闸: 无人续派熔断 (闸 A 次数上限 / 闸 B 探索型禁自续) ──────────
//
// 事故: cron 心跳每 30 分钟 reflow 清标记 + deliver 重派, 同一张 goal 票 3.5 天重派 ~55 次
// (117 个 contract 相位, 237.8M tokens, 本周 76% 开销)。单次调用的 max-rounds/budget-minutes
// 闸拦不住**跨次**重派; attempt.md 里"连续两次落这格再去看"是散文不是闸。
// 反向自检 (本仓惯例): 每条闸都证明它真的会红 —— 上限臂 escalated + 对照臂 resumable 成对出现。

import { goalAttemptsPath, readGoalAttempts } from './dispatch';

const writeResultWithAcceptance = (cwd: string, slug: string, id: string, outcome: string, acceptance: string): void => {
  const p = researchResultPath(cwd, slug, id);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, `outcome: ${outcome}\nrunId: run-${id}\nacceptance: ${acceptance}\n\n摘要`);
};

describe('闸 A — 续派总次数上限 (跨次重派熔断)', () => {
  test('dispatchGoalTicket 每次真 spawn 计数 +1; 幂等命中不计 (没花钱不记账)', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'goal-att-'));
    const deps = { spawnDetached: () => 1, makeRunId: () => 'r1' };
    dispatchGoalTicket(cwd, 'm1', t({ id: 'g9' }), 'x', deps);
    expect(readGoalAttempts(cwd, 'm1', 'g9')).toBe(1);
    dispatchGoalTicket(cwd, 'm1', t({ id: 'g9' }), 'x', deps); // 标记在 → 幂等命中
    expect(readGoalAttempts(cwd, 'm1', 'g9')).toBe(1);
    rmSync(goalDispatchedPath(cwd, 'm1', 'g9')); // 回流清标记后再派 = 又一次真 spawn
    dispatchGoalTicket(cwd, 'm1', t({ id: 'g9' }), 'x', deps);
    expect(readGoalAttempts(cwd, 'm1', 'g9')).toBe(2);
    rmSync(cwd, { recursive: true, force: true });
  });

  test('反向自检: 达上限的 not-converged → escalated 升人, 不写续跑锚, 计数清零', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'goal-capA-'));
    goalMapOn(cwd);
    writeResult(cwd, 'm1', 'g9', 'not-converged');
    writeFileSync(goalAttemptsPath(cwd, 'm1', 'g9'), '3');
    const out = reflowGoalResults(mdBackend(cwd), cwd, 'm1', { maxAttempts: 3 });
    expect(out[0]!.disposition).toBe('escalated');
    expect(out[0]!.warning).toContain('达上限');
    expect(mdBackend(cwd).readMap(cwd, 'm1')!.tickets[0]!.status).toBe('escalated');
    expect(existsSync(goalResumePath(cwd, 'm1', 'g9'))).toBe(false); // 无锚 → deliver 不会再续这个 run
    expect(existsSync(goalAttemptsPath(cwd, 'm1', 'g9'))).toBe(false);
    rmSync(cwd, { recursive: true, force: true });
  });

  test('对照臂: 次数未达上限 → 照旧 resumable + 续跑锚 (闸不过拦)', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'goal-capA-'));
    goalMapOn(cwd);
    writeResult(cwd, 'm1', 'g9', 'not-converged');
    writeFileSync(goalAttemptsPath(cwd, 'm1', 'g9'), '2');
    const out = reflowGoalResults(mdBackend(cwd), cwd, 'm1', { maxAttempts: 3 });
    expect(out[0]!.disposition).toBe('resumable');
    expect(readFileSync(goalResumePath(cwd, 'm1', 'g9'), 'utf8')).toBe('run-g9');
    rmSync(cwd, { recursive: true, force: true });
  });
});

describe('闸 B — 探索型验收 (无机器判据) 不进自动续跑', () => {
  test('反向自检: exploratory 头的 not-converged 第一次就升人 (续跑期望收益为零)', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'goal-capB-'));
    goalMapOn(cwd);
    writeResultWithAcceptance(cwd, 'm1', 'g9', 'not-converged', 'exploratory');
    const out = reflowGoalResults(mdBackend(cwd), cwd, 'm1');
    expect(out[0]!.disposition).toBe('escalated');
    expect(out[0]!.warning).toContain('探索型');
    expect(existsSync(goalResumePath(cwd, 'm1', 'g9'))).toBe(false);
    rmSync(cwd, { recursive: true, force: true });
  });

  test('对照臂: executable 头照旧 resumable (闸 B 只认探索型)', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'goal-capB-'));
    goalMapOn(cwd);
    writeResultWithAcceptance(cwd, 'm1', 'g9', 'not-converged', 'executable');
    const out = reflowGoalResults(mdBackend(cwd), cwd, 'm1');
    expect(out[0]!.disposition).toBe('resumable');
    rmSync(cwd, { recursive: true, force: true });
  });

  test('向后兼容: 老结果文件无 acceptance 头 → 闸 B 不触发, 只剩闸 A 兜底', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'goal-capB-'));
    goalMapOn(cwd);
    writeResult(cwd, 'm1', 'g9', 'not-converged'); // 老格式 (无 acceptance 行)
    const out = reflowGoalResults(mdBackend(cwd), cwd, 'm1');
    expect(out[0]!.disposition).toBe('resumable');
    rmSync(cwd, { recursive: true, force: true });
  });

  test('exploratory 且 success → 照旧 delivered (闸 B 只拦"没成还想续", 不拦成了的)', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'goal-capB-'));
    goalMapOn(cwd);
    writeResultWithAcceptance(cwd, 'm1', 'g9', 'success', 'exploratory');
    const out = reflowGoalResults(mdBackend(cwd), cwd, 'm1');
    expect(out[0]!.disposition).toBe('delivered');
    rmSync(cwd, { recursive: true, force: true });
  });
});
