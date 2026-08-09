/**
 * researchFanout 的 **invalid ≠ 0 闸**:一波 leaf 有效样本为 0 → 当场抛, 永不放行。
 *
 * ## 这条闸是被咬出来的, 不是想出来的
 *
 * 2026-08-09 第一次 deep research: 单 provider 周配额耗尽, gen 波打出 `[gen] r1: 0/26`,
 * 引擎**当没事一样又跑了两轮缺口补抓** (+92k 字符), 烧完检索预算才崩。
 * 那个 `0/26` 的正确含义是 **26 个 invalid** (压根没到模型), 不是"26 次跑了没做成"。
 * 而当时 reduce/synth/judge/graft 会照常跑完 —— 产出一份对空气综合、长得和真报告一模一样的东西。
 * (jcode `DISCOVERY_RATE_BENCHMARK` 独立同构:「没有任何有效 trial 的跑永远不算通过」。)
 *
 * ## 反向自检 —— 去掉闸, 这些测试怎么红
 *
 * 把 `fanout.ts` 的 `runWave` 换回原来的 `(await warmParallel(...)).filter(Boolean)`:
 * · 「gen 波全挂」「synth 波全挂」「配置零 leaf」三条从 `rejects.toThrow` 变成 **resolve 出一份完整报告**
 *   (`final` 有字、`lensChampions` 为空) —— 即这三条测的正是"假绿"本身, 闸没了当场绿给你看;
 * · 「一半挂」那条**不会**变 —— 它钉的是"正常样本行为零变化", 闸在与不在都该过。
 *   它是这组里唯一一条**闸拿掉也绿**的, 故意留着当对照:没有它, 上面三条可以靠"全都抛"作弊通过。
 */
import { describe, expect, test } from 'bun:test';
import { researchFanout, type ResearchFanoutConfig } from './fanout';
import type { ModelRequest, ModelResponse } from '../../model/types';

/** 从请求里读出这一发属于哪个阶段 (prompt 里各阶段有各自的固定标记)。 */
function stageOf(req: ModelRequest): 'gen' | 'reduce' | 'synth' | 'judge' | 'other' {
  const c = req.messages[0]?.content;
  const text = typeof c === 'string' ? c : JSON.stringify(c);
  if (text.includes('<persona>')) return 'gen';
  if (text.includes('你是该镜头的首席 judge')) return 'reduce';
  if (text.includes('<framing>')) return 'synth';
  if (text.includes('你是评判维度')) return 'judge';
  return 'other';
}

const reply = (text: string): ModelResponse =>
  ({ text, usage: { in: 1, out: 1 }, raw: {}, model: 'fake:x', attempts: 1 }) as ModelResponse;

/**
 * 座位全部用 `fake:` 前缀:非 `opencode-go:` 坐标 → `withGoFallback` 原样抛不重试;
 * 非 mimo 坐标 → `makeBudgetedCall` 直通不排队。于是这组测试零网络、零 env 依赖。
 */
const cfg = (over: Partial<ResearchFanoutConfig> = {}): ResearchFanoutConfig => ({
  question: 'q',
  groundTruth: 'ground truth',
  lenses: [{ key: 'L1', persona: 'p1', subAngles: ['a1', 'a2'] }],
  synthesisFramings: [{ key: 'F1', framing: 'f1' }],
  judgeCriteria: [{ key: 'J1', criterion: 'c1' }],
  lensModel: 'fake:lens',
  reasonModel: 'fake:reason',
  reduceModel: 'fake:reduce',
  judgeModel: 'fake:judge',
  ...over,
});

describe('researchFanout: 0 有效样本 ≠ 通过', () => {
  test('★ gen 波全挂 (配额耗尽) → 抛, 且错话里带得走 0/N 与原始报错', async () => {
    const run = researchFanout(
      cfg({ _callModel: async (req) => {
        if (stageOf(req) === 'gen') throw new Error('429 weekly quota exhausted');
        return reply('不该走到这里');
      } }),
    );
    await expect(run).rejects.toThrow(/gen r1 波 0\/2 有效样本/);
    // fail-open 可以吞异常, 不许吞证据: `parallel` 把 leaf 的抛错吃成 null,
    // 闸必须把它捞回来 —— 否则读到的只是"0 个", 分不清配额、认证还是超时。
    await expect(run).rejects.toThrow(/429 weekly quota exhausted/);
  });

  test('★ 后面的波同样管住: gen/reduce 正常而 synth 全挂 → 抛 (不是拿空候选去 judge)', async () => {
    await expect(
      researchFanout(
        cfg({ _callModel: async (req) => {
          if (stageOf(req) === 'synth') throw new Error('auth: invalid api key');
          return reply(`ok ${stageOf(req)}`);
        } }),
      ),
    ).rejects.toThrow(/synth 波 0\/1 有效样本/);
  });

  test('★ 一半挂不算塌 —— 正常样本行为零变化 (这条闸在与不在都该绿)', async () => {
    let genSeen = 0;
    const res = await researchFanout(
      cfg({ _callModel: async (req) => {
        // 第一个 sub-angle 挂掉, 第二个成功: 单 leaf fail-open (INV-6) 是**对的**, 不许被这条闸波及。
        if (stageOf(req) === 'gen' && ++genSeen === 1) throw new Error('单 leaf 超时');
        return reply(`ok ${stageOf(req)}`);
      } }),
    );
    expect(genSeen).toBe(2);
    expect(res.lensChampions.map((c) => c.key)).toEqual(['L1']);
    expect(res.synthCandidates.map((c) => c.key)).toEqual(['F1']);
    expect(res.judgeCritiques.map((c) => c.key)).toEqual(['J1']);
    expect(res.final).toBe('ok other');
  });

  test('★ 配置里一个 leaf 都没有 → 也抛 (「没量」与「量到 0」都不许读成通过)', async () => {
    await expect(
      researchFanout(cfg({ lenses: [], _callModel: async () => reply('ok') })),
    ).rejects.toThrow(/波 0\/0 有效样本/);
  });
});
