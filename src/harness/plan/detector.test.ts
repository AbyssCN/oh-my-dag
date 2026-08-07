/**
 * D-Q 图内检测者 —— 协议解析 + **裁决真的落进环** (2026-07-30 补网)。
 *
 * 为什么这份测试是后补的、以及为什么它值得存在: D-Q 交付时只钉了「明示即承诺」那一层
 * (登记表 / 空旋钮扫描里点了 `detector` 的名), 而**协议本身与环的接缝一条测试都没有**。
 * 于是当天的 eval 挖出一条静默失效时, 没有任何东西会变红 —— 见下面第二个 describe。
 *
 * 两层各钉一件事:
 *   ① `parseDetectorVerdict` 的**格式契约**: 行首 + 大写才算裁决; 没有协议行 = 没有裁决
 *      (不是"全批准"也不是"全拒绝" —— 检测者是加一层观察, 不是新增一道必过的闸)。
 *   ② 环的接缝: 检测者点的名要进毒集 (被拒的子节点下一轮**重跑**, 没被拒的复用),
 *      `BLOCKED:` 要让环提前退出。**含检测者自身 failed 的那一路** —— 那正是被修掉的洞。
 */
import { describe, expect, test } from 'bun:test';
import { parseDetectorVerdict } from './detector';
import { runExecutorDagWithPlan } from '../dag/engine';
import type { ConductorPlan } from '../conductor-plan';
import { PLAN_BOUNDARY } from '../conductor-plan';
import type { ContentPart } from '../../model/gateway';
import type { ExecutorDagConfig, GenerateFn } from '../dag/types';

// ── ① 协议格式契约 ────────────────────────────────────────────────────────────

describe('D-Q parseDetectorVerdict — 什么算裁决', () => {
  const ids = ['P::aaa', 'P::bbb'];

  test('没有协议行 = 空裁决 (既不是全批准也不是全拒绝)', () => {
    const v = parseDetectorVerdict('两份文档口径一致, 没有发现冲突。', ids);
    expect(v.rejected).toEqual([]);
    expect(v.blocked).toBeUndefined();
  });

  test('行首 + 大写才算 —— 正文里提到 reject 不误命中', () => {
    const v = parseDetectorVerdict(
      '我本来想 reject: P::aaa, 但再看一遍其实没问题 (REJECT 这个词出现在句中不算数)。',
      ids,
    );
    expect(v.rejected).toEqual([]);
  });

  test('前导空白允许 (列表缩进是模型的常见写法)', () => {
    expect(parseDetectorVerdict('  REJECT: P::aaa', ids).rejected).toEqual(['P::aaa']);
  });

  test('别名翻译: 命令检测者只知道规划期的可读名 —— 引擎翻回内容寻址 id', () => {
    const aliases = new Map([['write-zh', 'P::aaa']]);
    const v = parseDetectorVerdict('REJECT: write-zh', ids, aliases);
    expect(v.rejected).toEqual(['P::aaa']);
    expect(v.ghosts).toEqual([]);
  });

  test('翻译不出来的名字进 ghosts, 不进毒集 (幻觉不许铸票)', () => {
    const v = parseDetectorVerdict('REJECT: 某个不存在的节点', ids);
    expect(v.rejected).toEqual([]);
    expect(v.ghosts).toEqual(['某个不存在的节点']);
  });

  test('同一个 id 点两次只入一次 (毒集是集合)', () => {
    expect(parseDetectorVerdict('REJECT: P::aaa\nREJECT: P::aaa', ids).rejected).toEqual(['P::aaa']);
  });

  test('多条 BLOCKED 取第一条 (同一件事的不同说法, 拼接不像人写的话)', () => {
    const v = parseDetectorVerdict('BLOCKED: 缺少上游事实\nBLOCKED: 另一种说法', ids);
    expect(v.blocked).toBe('缺少上游事实');
  });
});

// ── ② 环的接缝 (整条 conductor 内环, 零真实 LLM) ────────────────────────────

const contentText = (c: string | ContentPart[] | undefined): string =>
  typeof c === 'string' ? (c ?? '') : (c ?? []).map((p) => (p.type === 'text' ? p.text : '')).join('\n');

/** 固定子图: 两个写方 + 一个 fan-in 检测者 (命令档 —— 也是 prompt 里首选的那一档)。 */
const SUB_PLAN = JSON.stringify({
  name: 'sub',
  nodes: {
    'write-zh': { goal: '写中文版承诺' },
    'write-en': { goal: '写英文版承诺' },
    'cross-check': {
      goal: '核对两版承诺是否一致',
      executor: 'command',
      command: 'node -e check',
      depends_on: ['write-zh', 'write-en'],
      detector: true,
    },
  },
});

/**
 * fake generate: conductor 那次调用 (user 消息带 PLAN_BOUNDARY) 回子图 JSON, 其余当 leaf 输出。
 * `leafGoals` 逐次记下跑过的 leaf goal —— 跨轮复用的观察面就是它 (复用 = 零 LLM 调用)。
 */
function makeGenerate(): { generate: GenerateFn; leafGoals: string[] } {
  const leafGoals: string[] = [];
  const generate: GenerateFn = async (req) => {
    const user = contentText(req.messages.find((m) => m.role === 'user')?.content);
    if (user.includes(PLAN_BOUNDARY.trim().split('\n')[0]!) || user.includes('TASK (dynamic')) {
      return { text: SUB_PLAN, usage: { in: 1, out: 1 } };
    }
    const goal = /写(中文|英文)版承诺/.exec(user)?.[0] ?? 'other';
    leafGoals.push(goal);
    return { text: `out:${goal}`, usage: { in: 1, out: 1 } };
  };
  return { generate, leafGoals };
}

/** conductor 节点 + 内环轮数。 */
const loopPlan = (maxRounds: number): ConductorPlan => ({
  name: 'p',
  nodes: { P: { goal: '两版承诺必须一致', executor: 'conductor', max_rounds: maxRounds } },
});

/** 检测者那条命令的返回 (退出码可控 —— 这正是本节要钉的那一位)。 */
const cfgWith = (
  detectorOut: string,
  exitCode: number,
  generate: GenerateFn,
  judgeConverged = false,
): ExecutorDagConfig => ({
  conductorModel: 'c:m',
  leafModel: 'l:m',
  generate,
  agentTemplates: new Map(),
  commandRunner: async () => ({ text: detectorOut, usage: { in: 0, out: 0 }, exitCode }),
  // 内环 judge 恒不收敛 → 环走满轮数, 好让第 2 轮的复用/重跑看得见。
  judgeSend: async () => ({
    text: '',
    parsed: {
      converged: judgeConverged,
      score: judgeConverged ? 9 : 3,
      failureReason: judgeConverged ? undefined : '还没对齐',
      rejectedNodes: [],
    },
    usage: { in: 0, out: 0 },
    raw: {},
    model: 'judge:fake',
    attempts: 1,
  }),
});

describe('D-Q 裁决落进环 —— 含检测者自身 failed 的那一路', () => {
  test('检测者 exit 0 + REJECT → 被点名的子节点下一轮重跑, 没点名的复用', async () => {
    const { generate, leafGoals } = makeGenerate();
    const r = await runExecutorDagWithPlan(loopPlan(2), cfgWith('REJECT: write-zh', 0, generate));
    // 第 1 轮两个写方都跑; 第 2 轮只有被拒的 write-zh 重跑 (write-en 命中跨轮复用)。
    expect(leafGoals.filter((g) => g === '写中文版承诺').length).toBe(2);
    expect(leafGoals.filter((g) => g === '写英文版承诺').length).toBe(1);
    expect(r.results.P?.status).toBeDefined();
  });

  test('**检测者自己 failed (exit 1) 但印出了 REJECT → 裁决仍落进环**', async () => {
    // 这是 2026-07-30 eval 挖出的静默失效: conductor 自发画检查节点时最常见的写法就是
    // 「发现冲突就 exit 1」—— 前一版引擎按 `status === 'failed'` 整个跳过, 于是那张票凭空消失。
    const { generate, leafGoals } = makeGenerate();
    await runExecutorDagWithPlan(loopPlan(2), cfgWith('REJECT: write-zh', 1, generate));
    expect(leafGoals.filter((g) => g === '写中文版承诺').length).toBe(2); // 重跑了 = 票收到了
    expect(leafGoals.filter((g) => g === '写英文版承诺').length).toBe(1); // 没被点名 → 仍复用
  });

  test('检测者 failed 且输出里没有协议行 → 空裁决 (读失败节点不等于瞎读)', async () => {
    // 反面用例: 真崩了的检测者吐的是堆栈, 行首不会出现 REJECT —— 解析出来仍是空,
    // 两个写方都不进毒集, 第 2 轮全部复用。没有这条, 上一条就可能是"全都重跑"的假阳性。
    const { generate, leafGoals } = makeGenerate();
    await runExecutorDagWithPlan(
      loopPlan(2),
      cfgWith('SyntaxError: Unexpected token\n    at node:internal/main', 1, generate),
    );
    expect(leafGoals.filter((g) => g === '写中文版承诺').length).toBe(1);
    expect(leafGoals.filter((g) => g === '写英文版承诺').length).toBe(1);
  });

  test('BLOCKED → 环提前退出, 且恒不算收敛 (fail-closed)', async () => {
    const { generate, leafGoals } = makeGenerate();
    const r = await runExecutorDagWithPlan(loopPlan(3), cfgWith('BLOCKED: 上游没给退款时限', 0, generate));
    expect(r.results.P?.blocked).toContain('上游没给退款时限');
    expect(r.results.P?.converged).not.toBe(true);
    // 提前退出 = 没有第 2 轮 (每个写方只跑一次)。
    expect(leafGoals.length).toBe(2);
  });

  test('检测者 failed 时喊的 BLOCKED 同样算 (与 REJECT 同一条修复)', async () => {
    const { generate } = makeGenerate();
    const r = await runExecutorDagWithPlan(loopPlan(3), cfgWith('BLOCKED: 前提自相矛盾', 1, generate));
    expect(r.results.P?.blocked).toContain('前提自相矛盾');
  });
});
