/**
 * 「产物没变」检测器 (2026-08-05, G5 正解)。
 *
 * ## 它绕的是什么
 *
 * D-AD 的诊断: 我们**所有**的"卡住"检测器都键在「agent 重复了自己」上 —— 而 LLM conductor
 * 每轮重画, 从不逐字重复自己。于是那几条在 live 上恒 0, 再跑多少次都是 0。
 * 这一条改键在**盘上有没有位移** —— 产物是 agent 不重新生成的东西, 是这个环里唯一稳定的信号。
 *
 * ## 这套网的重心在**误报**那一侧
 *
 * 一个只报不拦的检测器, 漏报的代价是"少给一句提示", 误报的代价是"给下一轮灌一句错的话,
 * 把它从对的方向支开"。所以下面**只有两条**在测它会响, 其余全在测它**不该响的时候真不响**:
 * 纯分析轮 · 读不到的文件 · 路径集变了 · 内容变了。
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectNoArtifactChange, type RoundArtifacts } from '../../src/harness/plan/observers';
import { runExecutorDag, type GenerateFn } from '../../src/harness/executor-dag';

const A = (hashes: Record<string, string | null>): RoundArtifacts => ({ hashes });

describe('产物没变 · 判据本身', () => {
  test('路径集与 hash 都相同 → 命中 (盘上零位移)', () => {
    const obs = detectNoArtifactChange(A({ 'a.md': 'h1', 'b.md': 'h2' }), A({ 'a.md': 'h1', 'b.md': 'h2' }));
    expect(obs?.kind).toBe('loop-no-artifact-change');
  });

  test('任一文件内容变了 → 不响 (有位移就是有位移)', () => {
    expect(detectNoArtifactChange(A({ 'a.md': 'h1' }), A({ 'a.md': 'h2' }))).toBeNull();
  });

  test('路径集变了 → 不响', () => {
    expect(detectNoArtifactChange(A({ 'a.md': 'h1' }), A({ 'a.md': 'h1', 'c.md': 'h3' }))).toBeNull();
  });

  test('第一轮没有比对对象 → 不响', () => {
    expect(detectNoArtifactChange(null, A({ 'a.md': 'h1' }))).toBeNull();
  });
});

describe('产物没变 · 误报守卫 (这套网的重心)', () => {
  test('★ 纯分析轮 (一个文件都没碰) → 不响 —— 那是 Unobserved, 不是"没位移"', () => {
    // 少了这条闸, 所有非文件型的目标会被一路误报: 它们**按设计**就不产文件。
    expect(detectNoArtifactChange(A({}), A({}))).toBeNull();
    expect(detectNoArtifactChange(A({ 'a.md': 'h1' }), A({}))).toBeNull();
    expect(detectNoArtifactChange(A({}), A({ 'a.md': 'h1' }))).toBeNull();
  });

  test('★ 有文件读不到 (hash=null) → 不响 —— 量不到不是"没变"的证据', () => {
    // fail-open 方向: 宁可不报。把 null 当"没变"就是拿缺失冒充证据。
    expect(detectNoArtifactChange(A({ 'a.md': null }), A({ 'a.md': null }))).toBeNull();
    expect(detectNoArtifactChange(A({ 'a.md': 'h1' }), A({ 'a.md': null }))).toBeNull();
    expect(detectNoArtifactChange(A({ 'a.md': null }), A({ 'a.md': 'h1' }))).toBeNull();
  });

  test('两个 null 的 hash **不算相等** —— 别让"都读不到"凑成"都没变"', () => {
    const obs = detectNoArtifactChange(A({ 'a.md': null, 'b.md': 'h2' }), A({ 'a.md': null, 'b.md': 'h2' }));
    expect(obs).toBeNull(); // 哪怕另一个文件确实没变, 只要有一个量不到就整轮不判
  });
});

describe('产物没变 · 消息要能让下一轮做点什么 (A5 判据)', () => {
  test('不播报状态, 给具体做法 + 点破最可能的无效功', () => {
    const msg = detectNoArtifactChange(A({ 'a.md': 'h1' }), A({ 'a.md': 'h1' }))!.message;
    expect(msg).toContain('盘上没有位移');
    expect(msg).toContain('换个名字重排'); // 点破它最可能正在做的无效功
    expect(msg).toContain('改**内容**而不是改结构'); // 做得了的事
    expect(msg).toContain('能判对错的验证步骤'); // 若它判断产物已对, 也有一条出路
  });
});

describe('产物没变 · 接在环上 (真跑一遍)', () => {
  /**
   * ⚠ 夹具里有一条**非平凡**的事实, 值得写下来: 若每轮的子图**语义相同**, D-21 跨轮复用会命中,
   * 后续轮次**零 LLM** 直接复用上一轮结果 —— 于是 agent 三轮只被调 1 次, 产物当然没变。
   * 那是**真阳性**(三轮只干了一份活), 也正是这条检测器该抓的东西之一。
   *
   * 而旧的空转判据在这个形状上**够不着**: judge 没点名任何子节点时 `rejected` 为空,
   * `detectLoopNoProgress` 按设计直接返 null。D-AD 说的"再跑多少次都是 0"在这儿看得见。
   *
   * 所以"真有进展"那一条必须让每轮的子图**语义真的不同**(节点目标带轮次), 否则测的是复用不是位移。
   */
  const runLoop = async (mode: 'same' | 'different') => {
    const dir = mkdtempSync(join(tmpdir(), 'no-move-'));
    const PLAN = JSON.stringify({
      name: 's',
      nodes: { c: { goal: '内环', executor: 'conductor', max_rounds: 3, judge_final: true } },
    });
    let expandNth = 0;
    let agentCalls = 0;
    const generate: GenerateFn = async ({ model, messages }) => {
      const u = messages.find((m) => m.role === 'user');
      const text = typeof u?.content === 'string' ? u.content : '';
      if (model !== 'mimo:mimo-v2.5-pro') return { text: 'OUT', usage: { in: 1, out: 1 } };
      if (!text.includes('内环')) return { text: PLAN, usage: { in: 1, out: 1 } };
      // same: 每轮同一张子图 → 复用命中, 后续轮零 LLM;
      // different: 目标带轮次 → 语义指纹每轮不同 → 每轮真跑。
      const goal = mode === 'same' ? '写产物' : `写产物 (第 ${expandNth++} 版)`;
      return {
        text: JSON.stringify({ name: 'sub', nodes: { w: { goal, executor: 'agent', output_type: 'file', output_path: 'out.md' } } }),
        usage: { in: 1, out: 1 },
      };
    };
    const res = await runExecutorDag('t', {
      conductorModel: 'mimo:mimo-v2.5-pro',
      leafModel: 'deepseek:deepseek-v4-flash',
      generate,
      // judge 恒判未收敛 (逼环转满), 且**给了理由** —— 免得撞上 A5 那条兜底文案。
      judgeSend: async () =>
        ({ text: '', parsed: { converged: false, score: 3, failureReason: '还差一点' }, usage: { in: 1, out: 1 } }) as never,
      agentRunner: async () => {
        const nth = agentCalls++;
        const body = mode === 'same' ? '一样的内容' : `第 ${nth} 版`;
        writeFileSync(join(dir, 'out.md'), body);
        return { text: '写好了', usage: { in: 1, out: 1 }, filesTouched: ['out.md'], cwd: dir };
      },
    });
    return { res, agentCalls };
  };

  test('三轮只干了一份活 (复用命中, 盘上零位移) → 报', async () => {
    const { res, agentCalls } = await runLoop('same');
    expect(agentCalls).toBe(1); // 夹具自证: 后两轮零 LLM 复用
    expect(res.observations?.some((o) => o.kind === 'loop-no-artifact-change')).toBe(true);
  });

  test('每轮真跑且内容真变 → 不报 (有位移就别报)', async () => {
    const { res, agentCalls } = await runLoop('different');
    expect(agentCalls).toBeGreaterThan(1); // 夹具自证: 这次每轮真跑了
    expect(res.observations?.some((o) => o.kind === 'loop-no-artifact-change')).toBeFalsy();
  });

  test('★ 产物根跟着结果出图 —— 否则隔离档下 hash 全 null, 检测器静默失效', async () => {
    // 单元测试全绿而真跑恒不命中, 就是这一位没传出来 (LeafResult.artifactRoot 的注记着这次事故)。
    const { res } = await runLoop('same');
    const child = Object.values(res.results).find((r) => r.filesTouched?.length);
    expect(child?.artifactRoot).toBeTruthy();
  });
});
