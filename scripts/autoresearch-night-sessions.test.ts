/**
 * autoresearch-night-sessions.test —— 串行编排与「无卡不是失败」(契约 D-4 / INV-4 / GWT-4)。
 *
 * 两条执行路全部注入替身: 本文件零 LLM、零子进程、零磁盘语料。测的是**编排**本身 ——
 * 顺序 / 夜帽 / 单卡塌不带走整批 / 曲线怎么从代记录里取。
 *
 * 反向自检 (改一处再跑本文件, 应当转红) —— 读数见文末注释。
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CodeCard, SessionCard } from '../src/eval/replay/session-card';
import {
  NIGHT_BUDGET_STOP,
  NO_CARDS_REASON,
  parseSessionsArgs,
  parseSolveResult,
  solveBranchName,
  readAcceptedCards,
  runCards,
  type CardResult,
  type SessionsDeps,
  type SessionsOpts,
} from './autoresearch-night-sessions';

const ROOT = join(import.meta.dir, '..');

const OPTS: SessionsOpts = {
  cwd: ROOT,
  nightDir: '/tmp/omd-night-test',
  nightBudgetMinutes: 480,
};

function codeCard(id: string, over: Partial<CodeCard> = {}): CodeCard {
  return {
    version: 1,
    id,
    substrate: 'S3',
    mainObjective: 'planValidityRate',
    objectiveRow: 'O3b',
    hypothesis: 'h',
    evidenceRefs: ['failed-runs:not-converged'],
    successSignal: 's',
    voidConditions: [],
    budgetMinutes: 90,
    goal: 'g',
    writeSet: ['src/harness/x.ts'],
    verify: 'bun test',
    ...over,
  };
}

function stubResult(card: SessionCard): Omit<CardResult, 'wallMs'> {
  return {
    cardId: card.id,
    substrate: card.substrate,
    mainObjective: card.mainObjective,
    stopReason: 'maxGenerations',
    winnerIds: ['w1'],
    curve: [],
  };
}

describe('runCards 编排 (D-4)', () => {
  test('GWT-4: 零卡 → { cards: [], reason: no-cards }, 不跑任何执行路', async () => {
    let called = 0;
    const deps: SessionsDeps = {
      runCode: async (c) => {
        called += 1;
        return stubResult(c);
      },
    };
    const r = await runCards([], OPTS, deps);
    expect(r).toEqual({ cards: [], reason: NO_CARDS_REASON });
    expect(called).toBe(0);
  });

  test('按卡序串行, 不并行 (进入顺序 = 卡序)', async () => {
    const order: string[] = [];
    const deps: SessionsDeps = {
      runCode: async (c) => {
        order.push(`in:${c.id}`);
        await new Promise((res) => setTimeout(res, 1));
        order.push(`out:${c.id}`);
        return stubResult(c);
      },
    };
    await runCards([codeCard('a'), codeCard('b')], OPTS, deps);
    // 并行的话 in:b 会插在 out:a 之前
    expect(order).toEqual(['in:a', 'out:a', 'in:b', 'out:b']);
  });

  test('单卡塌不带走整批: 错误进 error 列, 后面的卡照跑', async () => {
    const deps: SessionsDeps = {
      runCode: async (c) => {
        if (c.id === 'boom') throw new Error('变异 provider 断供');
        return stubResult(c);
      },
    };
    const r = await runCards([codeCard('boom'), codeCard('ok')], OPTS, deps);
    expect(r.cards).toHaveLength(2);
    expect(r.cards[0]!.stopReason).toBe('error');
    expect(r.cards[0]!.error).toContain('变异 provider 断供');
    expect(r.cards[1]!.stopReason).toBe('maxGenerations');
  });

  test('夜帽用尽: 没轮到的卡记 night-budget, 与「跑了没成」分开', async () => {
    let t = 0;
    const deps: SessionsDeps = {
      // 每次读表推进 10 分钟 —— 第二张卡起跑时已过 15 分钟夜帽
      now: () => (t += 10 * 60_000),
      runCode: async (c) => stubResult(c),
    };
    const r = await runCards([codeCard('a'), codeCard('b')], { ...OPTS, nightBudgetMinutes: 15 }, deps);
    expect(r.cards[0]!.stopReason).toBe('maxGenerations');
    expect(r.cards[1]!.stopReason).toBe(NIGHT_BUDGET_STOP);
    expect(r.cards[1]!.error).toBeUndefined(); // 没轮到 ≠ 出错
  });

  test('wallMs 逐卡记 (夜链读数的其中一项)', async () => {
    let t = 0;
    const deps: SessionsDeps = {
      now: () => (t += 1000),
      runCode: async (c) => stubResult(c),
    };
    const r = await runCards([codeCard('a')], OPTS, deps);
    expect(r.cards[0]!.wallMs).toBeGreaterThan(0);
  });
});

describe('parseSolveResult / readAcceptedCards / parseSessionsArgs', () => {
  test('solve result-out 首两行取 outcome + runId (真机形状)', () => {
    const text = 'outcome: not-converged\nrunId: e958cbe8-8059-4445-9b68-c9f5ea92bb69\n\ngoal: …';
    expect(parseSolveResult(text)).toEqual({
      outcome: 'not-converged',
      runId: 'e958cbe8-8059-4445-9b68-c9f5ea92bb69',
    });
  });

  test('头部 criterion / expectExit 两行解析成结构 (晋升闸判据虚探针的输入); 缺一行即缺席', () => {
    const text = 'outcome: success\nrunId: r1\nacceptance: executable\ncriterion: bun test tests/x.test.ts\nexpectExit: 0\n\ngoal: …';
    expect(parseSolveResult(text)).toEqual({ outcome: 'success', runId: 'r1', criterion: { command: 'bun test tests/x.test.ts', expectExit: 0 } });
    expect(parseSolveResult('outcome: success\nrunId: r1\ncriterion: bun test\n').criterion).toBeUndefined();
  });

  test('Q1④ 分支名从 runId 派生 = 引擎 prepareRunWorktree 的真名, 不再是 night/<cardId>', () => {
    expect(solveBranchName('e958cbe8')).toBe('omd/run/e958cbe8');
  });

  test('认不出 outcome → unclassified (不猜成 success)', () => {
    expect(parseSolveResult('乱七八糟').outcome).toBe('unclassified');
  });

  test('cards.json 缺席 → 空数组 (下游记 no-cards, 不抛)', () => {
    expect(readAcceptedCards('/nowhere/cards.json')).toEqual([]);
  });

  test('参数: cards 路径与 --out 都必填', () => {
    expect(() => parseSessionsArgs(['--out', 'x'])).toThrow('cards.json');
    expect(() => parseSessionsArgs(['c.json'])).toThrow('--out');
  });
});

describe('CLI (GWT-4 端到端: accepted 为空仍写出 results.json 并退 0)', () => {
  test('空 accepted 真跑一遍', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'omd-sessions-'));
    const cards = join(tmp, 'cards.json');
    const out = join(tmp, 'results.json');
    Bun.write(cards, JSON.stringify({ accepted: [], rejected: [] }));
    const r = spawnSync(
      'bun',
      [join(ROOT, 'scripts', 'autoresearch-night-sessions.ts'), cards, '--out', out],
      { cwd: ROOT, encoding: 'utf8', timeout: 120_000 },
    );
    expect(r.status).toBe(0);
    expect(JSON.parse(readFileSync(out, 'utf8'))).toEqual({ cards: [], reason: NO_CARDS_REASON });
  });
});
