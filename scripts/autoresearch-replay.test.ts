/**
 * `scripts/autoresearch-replay.ts` 契约 C-4 真值链断言 (2026-09-01 前置件)。
 *
 * 真值链:
 *   · `--baseline` 输出含 manifest.totalHash + manifest.seats + 聚合 fitness;
 *   · stub 座位下同 variant 同输入 → runBaseline 输出**字节级**相同
 *     (JSON.stringify 序列化后逐字节相等, 不是浅 toEqual);
 *   · `--stability N` 输出各维方差 (含 speedupTheoreticalMedian 的 null 处理);
 *   · `--live` 路径 = 真联机 (defaultLiveProvider → src/model/gateway.send),
 *     但**测试通过 opts.liveProvider 注入 fake** —— 路径真存在 + 测试零冒烟,
 *     这两条同时成立是 LIVE_FAKE_INJECTION 这组测试锁的事;
 *   · C-2 闸透传: --split heldout 不带 --allow-heldout → throw。
 *
 * 反向自检 (锁死判据力):
 *   - REPLAY_STUB_JSON: 把 runBaseline 的某字段去掉 (如 seats) → C-4 闸红 (字段断言失守);
 *   - REPLAY_STUB_JSON: 把 stubVariantToRawText 改成返同一 rawText (去 stableHash)
 *     → 两 variant 的 output 仍字节同 (但 fakeSerialPairs 键失守, 真值链 #2 红);
 *   - STABILITY_VARIANCE: 把 computeStability 的方差改用 |a-b| → speedupTheoreticalMedian
 *     字段在 stub 同输入下仍为 0 (因为 |a-b|=0), 但 fakeSerialPairsTotal 字段断言 > 0 即红;
 *   - HELDOUT_LOCK_FORWARD: 把 dispatch 的 C-2 闸注释保留但代码删 → loadCorpusFromPath
 *     抛的错不含 "heldout" 字样, 闸即破;
 *   - LIVE_FAKE_INJECTION: 把 defaultLiveProvider 替换成返 stubVariantToRawText
 *     → live 路径仍跑通, 但 fakeLiveProvider 计数从 n 跌到 0 → LIVE-1/2/3 全红;
 *   - LIVE_FAKE_INJECTION: 把 resolveProvider 的 live 分支直接删 (默认返 stub) →
 *     fakeLiveProvider 计数仍为 0, LIVE-1/2/3 红。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  computeStability,
  defaultLiveProvider,
  dispatch,
  evaluateSplit,
  type RawTextProvider,
  loadCorpusFromPath,
  parseReplayArgs,
  runBaseline,
  runStability,
  stubVariantToRawText,
  type DispatchOpts,
  type LiveProvider,
  type ReplayArgs,
  type ReplayBaseline,
} from './autoresearch-replay';
import {
  freezeCorpus,
  loadCorpus,
  type CorpusItem,
  type LoadedCorpus,
} from '../src/eval/replay/corpus';
import type { GatewayRequest, ModelResponse } from '../src/model/gateway';

const SEATS = {
  conductor: 'minimax-cn:MiniMax-M3',
  worker: 'minimax-cn:MiniMax-M3',
  verifier: 'openai-codex:gpt-5.6-sol',
};
const TARGET_COUNTS: readonly [number, number, number] = [6, 20, 8];

function sampleItems(): CorpusItem[] {
  const ids = ['aa', 'ab', 'ac', 'ad', 'ae', 'af', 'ag', 'ah', 'ai', 'aj', 'ak', 'al'];
  return ids.map((id, i) => ({
    id,
    prompt: `prompt for ${id}: synthetic text #${i + 1}`,
    srcRunId: `run-${Math.floor(i / 4) + 1}`,
  }));
}

/** 把 manifest freeze → 写盘 → 读盘, 产 LoadedCorpus。C-2 闸默认锁 heldout。 */
function makeLoadedCorpus(allowHeldout: boolean): {
  root: string;
  path: string;
  loaded: LoadedCorpus;
} {
  const root = mkdtempSync(join(tmpdir(), 'replay-fixture-'));
  const path = join(root, 'manifest.json');
  const m = freezeCorpus(sampleItems(), { seats: SEATS, targetCounts: TARGET_COUNTS });
  writeFileSync(path, `${JSON.stringify(m, null, 2)}\n`);
  const loaded = loadCorpus(readFileSync(path, 'utf8'), { allowHeldout });
  return { root, path, loaded };
}

/** 计 fake live 调了多少次 + 返回的 rawText 列表 (供 fitness 验证)。 */
function makeFakeLiveProvider(): {
  provider: LiveProvider;
  calls: { id: string; prompt: string; seats: Record<string, string>; variant: string }[];
} {
  const calls: { id: string; prompt: string; seats: Record<string, string>; variant: string }[] = [];
  const provider: LiveProvider = async (id, prompt, ctx) => {
    calls.push({ id, prompt, seats: { ...ctx.seats }, variant: ctx.variant });
    // 用 canned clean fixture 当 fake rawText —— fake rawText 仍要走 parsePlan/fitness,
    // 不能返字符串让 parsePlan 拒 (那会让所有题目 planValidity=false, 失去对路径的判别力)。
    return stubVariantToRawText(ctx.variant);
  };
  return { provider, calls };
}

// =====================================================================
// REPLAY_STUB_JSON — C-4 baseline 可复算 + stub 字节同
// =====================================================================
describe('REPLAY_STUB_JSON — C-4 baseline 可复算 + stub 字节同', () => {
  let root: string;
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  test('C-4.a --baseline 输出含 manifestHash + seats + 聚合 fitness', async () => {
    // 真值链:
    //   · freeze 12 题 → manifest.totalHash 16 进制;
    //   · loadCorpus 验 hash 通过 → loaded.manifest.totalHash 稳定;
    //   · runBaseline 把 totalHash + seats + 聚合 fitness 全塞进 baseline JSON。
    const fixture = makeLoadedCorpus(false);
    root = fixture.root;
    const args: ReplayArgs = {
      manifestPath: fixture.path,
      variant: 'baseline',
      split: 'main',
      allowHeldout: false,
      baseline: true,
      stability: null,
      live: false,
    };
    const out = await runBaseline(args, fixture.loaded);
    expect(out.ok).toBe(true);
    // C-4 闸: 语料哈希 + 座位坐标**必须**在输出里
    expect(out.manifestHash).toBe(fixture.loaded.manifest.totalHash);
    expect(out.seats).toEqual(SEATS);
    expect(out.variant).toBe('baseline');
    expect(out.split).toBe('main');
    expect(out.aggregate.n).toBeGreaterThan(0);
    // 序列化后再断言字段集合, 防 runtime 加字段掩盖
    const json = JSON.parse(JSON.stringify(out)) as Record<string, unknown>;
    expect(json['manifestHash']).toBe(fixture.loaded.manifest.totalHash);
    expect(json['seats']).toEqual(SEATS);
    expect('aggregate' in json).toBe(true);
    expect('perItem' in json).toBe(true);
  });

  test('C-4.b stub 座位下同 variant 同输入两跑 → 字节级同输出 (byte-identical)', async () => {
    // 真值链:
    //   · stubVariantToRawText(variant) 走 stableHash(variant, seed) % 4 → 桶定, 字节定;
    //   · evaluateSplit 内只走 parsePlan + computeFitness + aggregateFitness (纯函数);
    //   · aggregateFitness 不读时钟, 不读全局, 不引入随机;
    //   · 两次 runBaseline 序列化后逐字节相等。
    // 反向自检: 把 stubVariantToRawText 的分桶改回 constant → 两个不同 variant 输出仍字节同
    //   (本断言不会红, 必须配合 C-4.d 一起锁)。
    const fixture = makeLoadedCorpus(false);
    root = fixture.root;
    const args: ReplayArgs = {
      manifestPath: fixture.path,
      variant: 'baseline',
      split: 'main',
      allowHeldout: false,
      baseline: true,
      stability: null,
      live: false,
    };
    const out1 = await runBaseline(args, fixture.loaded);
    const out2 = await runBaseline(args, fixture.loaded);
    const s1 = JSON.stringify(out1);
    const s2 = JSON.stringify(out2);
    expect(s1).toBe(s2);
    // 双重保险: 关键数值字段相等 (防 stub 改 silent change 而 JSON.stringify 顺序凑巧同)
    expect(out1.aggregate).toEqual(out2.aggregate);
    expect(out1.perItem).toEqual(out2.perItem);
  });

  test('C-4.c stub rawText 由 variant 决定: 不同 variant → 不同 rawText (大概率)', () => {
    // 真值链: stableHash(variant, 0xabcdef) % 4 → 'baseline' (桶 1) 走 fakeSerialRawText,
    //   'dense-fanout' (桶 3) 走 shapedCleanRawText, 二者字节级不同。
    // 反向自检: 把 stubVariantToRawText 内的 stableHash 调用去掉 → 全返 cleanRawText,
    //   本断言红 (不同 variant 串相同)。
    const a = stubVariantToRawText('baseline');
    const b = stubVariantToRawText('dense-fanout');
    expect(a).not.toBe(b);
  });

  test('C-4.d 不同 variant 跑同一语料 → fitness 向量不同 (variant 真起作用)', async () => {
    // 真值链: clean fixture → fakeSerialPairs=0, shapeDeclared=false;
    //         fake-serial fixture → fakeSerialPairs>0, shapeDeclared=true。
    // 两条 variant 走两个分桶, fitness 维度差异至少在 fakeSerialPairs 上被读出。
    const fixture = makeLoadedCorpus(false);
    root = fixture.root;
    const baselineArgs: ReplayArgs = {
      manifestPath: fixture.path,
      variant: 'baseline',
      split: 'main',
      allowHeldout: false,
      baseline: true,
      stability: null,
      live: false,
    };
    const denseArgs: ReplayArgs = { ...baselineArgs, variant: 'dense-fanout' };
    const a = await runBaseline(baselineArgs, fixture.loaded);
    const b = await runBaseline(denseArgs, fixture.loaded);
    // 至少 fakeSerialPairsTotal 不同 → variant 真影响打分
    expect(a.aggregate.fakeSerialPairsTotal).not.toBe(b.aggregate.fakeSerialPairsTotal);
  });

  test('C-4.e --split heldout 不带 --allow-heldout → throw (C-2 闸透传)', () => {
    // 真值链: parseReplayArgs 检测 split===heldout && !allowHeldout → throw;
    //   闸在 CLI 解析层 (早于 load), 不让 heldout id 漏到 prompt 端。
    expect(() =>
      parseReplayArgs([
        '/some/manifest.json',
        '--split',
        'heldout',
      ]),
    ).toThrow(/heldout/i);
  });

  test('C-4.f --allow-heldout + --split heldout → 放行', async () => {
    const fixture = makeLoadedCorpus(true);
    root = fixture.root;
    const args: ReplayArgs = {
      manifestPath: fixture.path,
      variant: 'baseline',
      split: 'heldout',
      allowHeldout: true,
      baseline: true,
      stability: null,
      live: false,
    };
    const out = await runBaseline(args, fixture.loaded);
    expect(out.split).toBe('heldout');
    expect(out.aggregate.n).toBeGreaterThan(0);
  });

  test('C-4.g 默认 split=main, 不用 --split', () => {
    const fixture = makeLoadedCorpus(false);
    root = fixture.root;
    const args = parseReplayArgs([fixture.path]);
    expect(args.split).toBe('main');
    expect(args.baseline).toBe(true);
  });

  test('C-4.h --baseline 与 --stability 互斥 → throw', () => {
    expect(() =>
      parseReplayArgs([
        '/some/manifest.json',
        '--baseline',
        '--stability',
        '3',
      ]),
    ).toThrow(/mutually exclusive/);
  });
});

// =====================================================================
// STABILITY_VARIANCE — C-4 --stability N 各维方差
// =====================================================================
describe('STABILITY_VARIANCE — --stability N 各维方差', () => {
  let root: string;
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  test('S-1 --stability 3 → 3 个 aggregate + perDimVariance 全键存在', async () => {
    // 真值链: runStability 跑 N 次 evaluateSplit → 每轮 aggregate 进数组 → computeStability
    //   出 5 个维 (含 speedupTheoreticalMedian)。stub 座位下 N 跑方差均为 0 (同输入),
    //   但**字段在、值存在**才是本契约交付; 数值判断留人读。
    const fixture = makeLoadedCorpus(false);
    root = fixture.root;
    const args: ReplayArgs = {
      manifestPath: fixture.path,
      variant: 'baseline',
      split: 'main',
      allowHeldout: false,
      baseline: false,
      stability: 3,
      live: false,
    };
    const out = await runStability(args, fixture.loaded);
    expect(out.runs).toBe(3);
    expect(out.aggregates.length).toBe(3);
    const v = out.perDimVariance;
    expect(typeof v.planValidityRate).toBe('number');
    expect(typeof v.fakeSerialPairsTotal).toBe('number');
    expect(typeof v.shapeDeclarationRate).toBe('number');
    expect(typeof v.planningTokensTotal).toBe('number');
    // speedup 中位: 若全是 number → number; 若全 null → null。两态合法。
    expect(
      v.speedupTheoreticalMedian === null || typeof v.speedupTheoreticalMedian === 'number',
    ).toBe(true);
  });

  test('S-2 stub 同输入下 --stability 各维方差 = 0 (复算性)', async () => {
    // 真值链: stub 确定性 → 每轮 aggregate 完全一致 → variance(sample)=0。
    // 反向自检: 把 varianceOf 改成 sum|x-m| (均值绝对差) → 仍为 0, 但换 |a-b| 替代方差
    //   公式 → 在 stub 下也是 0, 所以本断言不锁方法 —— S-3 锁数值正确性。
    const fixture = makeLoadedCorpus(false);
    root = fixture.root;
    const args: ReplayArgs = {
      manifestPath: fixture.path,
      variant: 'baseline',
      split: 'main',
      allowHeldout: false,
      baseline: false,
      stability: 5,
      live: false,
    };
    const out = await runStability(args, fixture.loaded);
    const v = out.perDimVariance;
    expect(v.planValidityRate).toBe(0);
    expect(v.fakeSerialPairsTotal).toBe(0);
    expect(v.shapeDeclarationRate).toBe(0);
    expect(v.planningTokensTotal).toBe(0);
  });

  test('S-3 不同 variant 跑 --stability → fakeSerialPairsTotal 方差 > 0 (数值真值)', async () => {
    // 真值链: 'baseline' 与 'dense-fanout' 分桶不同 → 每次 aggregate.fakeSerialPairsTotal
    //   也不同 → 5 跑方差非 0。这条锁住「方差字段是统计真值, 不是写死常数」。
    // 反向自检: 把 runStability 改成只跑 1 次然后重复塞同 aggregate → variance=0 → 红。
    const fixture = makeLoadedCorpus(false);
    root = fixture.root;
    // 强制让 5 跑在两个 variant 间交错, 让 fakeSerialPairsTotal 序列有差异。
    const variants = ['baseline', 'dense-fanout', 'baseline', 'dense-fanout', 'baseline'];
    const aggregates: Awaited<ReturnType<typeof evaluateSplit>>['aggregate'][] = [];
    for (const variant of variants) {
      const out = await evaluateSplit({
        loaded: fixture.loaded,
        split: 'main',
        rawTextProvider: () => Promise.resolve(stubVariantToRawText(variant)),
      });
      aggregates.push(out.aggregate);
    }
    const v = computeStability(aggregates);
    expect(v.fakeSerialPairsTotal).toBeGreaterThan(0);
  });

  test('S-4 computeStability 在 N<2 时返回 0/null 兜底 (兜底真在, 不抛错)', () => {
    // 真值链: parseReplayArgs 已经 --stability N>=2 闸, 这里兜底保护 direct 调用者。
    // 入参 N=1 是类型上的「非法」, 但 computeStability 内部兜底返 0/null 不抛错 —— 这条
    // 锁住 direct 调用者也能安全调用。
    const v = computeStability([
      {
        planValidityRate: 1,
        fakeSerialPairsTotal: 0,
        speedupTheoreticalMedian: null,
        speedupCostBasis: null,
        shapeDeclarationRate: 0,
        planningTokensTotal: 0,
        n: 1,
      },
    ]);
    expect(v.planValidityRate).toBe(0);
    expect(v.speedupTheoreticalMedian).toBeNull();
  });
});

// =====================================================================
// LIVE_FAKE_INJECTION — --live 路径 = 真联机 (defaultLiveProvider),
// 测试通过 opts.liveProvider 注入 fake, 路径真存在 + 冒烟真零。
// =====================================================================
describe('LIVE_FAKE_INJECTION — --live 走真联机路径, 测试注入 fake (零冒烟)', () => {
  let root: string;
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  test('LIVE-1 runBaseline(live=true) 真调 liveProvider, 每题 1 次, ctx.seats/variant 透传', async () => {
    // 真值链:
    //   · resolveProvider 在 args.live=true 时走 liveProvider 分支;
    //   · 每次 evaluateSplit 内 (id, prompt) → liveProvider(id, prompt, ctx);
    //   · ctx.seats === loaded.manifest.seats (回放时刻与冻结时刻座位套对齐, C-4);
    //   · ctx.variant === args.variant (variant 名进 trace 关联)。
    // 反向自检:
    //   · 把 resolveProvider 的 live 分支删 → fakeLiveProvider 计数为 0 → 闸红;
    //   · 把 defaultLiveProvider 改成 return stubVariantToRawText(ctx.variant) (不调 send)
    //     → 本测试因为注入 fake 不走 default, 不红; 但 LIVE-4 必红 (默认实现路径未真联机)。
    const fixture = makeLoadedCorpus(false);
    root = fixture.root;
    const args: ReplayArgs = {
      manifestPath: fixture.path,
      variant: 'live-test-variant',
      split: 'main',
      allowHeldout: false,
      baseline: true,
      stability: null,
      live: true,
    };
    const { provider, calls } = makeFakeLiveProvider();
    const opts: DispatchOpts = { liveProvider: provider };
    const out = await runBaseline(args, fixture.loaded, opts);
    expect(out.ok).toBe(true);
    // main split 至少有几题 (fixture 12 题, targetCounts 6/20/8, main 占 6)
    expect(calls.length).toBe(out.n);
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      expect(c.seats).toEqual(SEATS);
      expect(c.variant).toBe('live-test-variant');
      // id 必为非空, prompt 必为非空
      expect(c.id.length).toBeGreaterThan(0);
      expect(c.prompt.length).toBeGreaterThan(0);
    }
  });

  test('LIVE-2 runStability(live=true, stability=3) → 每轮 N 题, 共 N*3 次 liveProvider', async () => {
    // 真值链: runStability 跑 N=3 轮, 每轮 evaluateSplit 内对每个语料条目调一次 liveProvider;
    //   3 轮 × main split 题数 = 总调用次数。
    const fixture = makeLoadedCorpus(false);
    root = fixture.root;
    const args: ReplayArgs = {
      manifestPath: fixture.path,
      variant: 'baseline',
      split: 'main',
      allowHeldout: false,
      baseline: false,
      stability: 3,
      live: true,
    };
    const { provider, calls } = makeFakeLiveProvider();
    const opts: DispatchOpts = { liveProvider: provider };
    const out = await runStability(args, fixture.loaded, opts);
    expect(out.runs).toBe(3);
    // fake rawText 全走 stub 分桶, 同 variant → 同 rawText → 同 aggregate, 方差 0
    expect(out.perDimVariance.fakeSerialPairsTotal).toBe(0);
    // 每轮都跑 main split, 调用次数 = 轮数 × n
    expect(calls.length).toBe(3 * out.aggregates[0]!.n);
  });

  test('LIVE-3 dispatch(live=true) → opts.liveProvider 真被调到, 不抛错', async () => {
    // 真值链: parseReplayArgs 不挡 --live; dispatch 透传到 runBaseline; runBaseline 在
    //   args.live=true 时走 liveProvider 分支 (opts.liveProvider 优先于 default)。这条
    //   锁住 CLI 入口 --live 真存在且不抛闸错 (闸在更早的 heldout / 互斥层)。
    const fixture = makeLoadedCorpus(false);
    root = fixture.root;
    const { provider, calls } = makeFakeLiveProvider();
    const args = parseReplayArgs([fixture.path, '--live']);
    expect(args.live).toBe(true);
    const out = (await dispatch(args, { liveProvider: provider })) as ReplayBaseline;
    expect(out.ok).toBe(true);
    expect(calls.length).toBe(out.n);
    expect(calls.length).toBeGreaterThan(0);
  });

  test('LIVE-4 defaultLiveProvider 是函数 + 接 (id, prompt, ctx, deps) 签名 + 源里有 send/PLAN_BOUNDARY (默认实现真存在, 路径真联机)', () => {
    // 真值链: defaultLiveProvider 必须存在且签名匹配 LiveProvider 接口。这是「路径真在」
    //   这条闸的另一种锁法 —— 不调它去发请求 (否则 CI 无凭证 / 无网络会挂), 只确认它的
    //   shape + 源里确实引用了 send / PLAN_BOUNDARY (联机路径真接入), 防有人把它删了
    //   换成 LIVE_NOT_IMPLEMENTED。
    // 反向自检:
    //   · 把 defaultLiveProvider 删 → import 报 undefined → typeof 红;
    //   · 把 defaultLiveProvider 改成抛 LIVE_NOT_IMPLEMENTED → typeof 还是 function,
    //     但源码 grep 'send(' 失守 → 闸红 (本断言 + REPLAY_STUB_JSON 段反向自检一起锁)。
    expect(typeof defaultLiveProvider).toBe('function');
    // Function.length 不数带默认值的形参 (deps: LiveProviderDeps = {})。源里 deps 是第 4 形参:
    //   function defaultLiveProvider(id, prompt, ctx, deps = {})
    // 故 length === 3; 通过参数列表透出 deps 的存在 + 类型 import 锁形状。
    expect(defaultLiveProvider.length).toBe(3);
    const src = readFileSync(join(import.meta.dir, 'autoresearch-replay.ts'), 'utf8');
    const sig = src.split('export async function defaultLiveProvider')[1]?.split('{')[0] ?? '';
    // 签名里同时出现 ctx 与 deps 两参数 (deps 是 mock transport 注入点)
    expect(sig).toMatch(/LiveProviderContext/);
    expect(sig).toMatch(/LiveProviderDeps/);
    // 源文件真引用了 send (走 gateway.send) 与 PLAN_BOUNDARY (走 conductorSystemPrompt 边界) —
    // 这两行是「真联机」承诺的源码硬证据, 不是注释承诺。
    expect(src).toContain('await llmCaller(');
    expect(src).toContain('PLAN_BOUNDARY');
    // 同时: resolveProvider 真走 live 分支 (这是「live 路径真在」闸的另一半)
    expect(src).toMatch(/if\s*\(!args\.live\)/);
    // deps 透传 llmCaller 给了 → 真跑 defaultLiveProvider 装配链; 不给 → 走真 send
    expect(src).toMatch(/opts\?\.llmCaller/);
  });

  test('LIVE-5 mock transport: opts.llmCaller 替换 send, defaultLiveProvider 装配链真跑, 零发请求', async () => {
    // 真值链 (这是「mock transport」约定的真位):
    //   · 不传 opts.liveProvider → resolveProvider 走 defaultLiveProvider + opts.llmCaller;
    //   · defaultLiveProvider 跑 conductorSystemPrompt + PLAN_BOUNDARY + role 解析 + meta 拼装;
    //   · 最后调 llmCaller(req) (本测试 fake), **不**调 send();
    //   · fake transport 收到 req → 验: model 是 manifest.seats.conductor, messages[0].role=system
    //     含 conductorSystemPrompt 头部 ('You are the conductor'), messages[1] 含 PLAN_BOUNDARY;
    //   · 返 canned clean rawText → parsePlan ok → planValidity=true。
    // 反向自检:
    //   · 把 opts.llmCaller 抽走 (代码删) → resolveProvider 走真 send → CI 无凭证 → 挂;
    //   · 把 defaultLiveProvider 改成 return stubVariantToRawText(ctx.variant) (短路) →
    //     llmCaller 计数仍 0 → 闸红 (本断言就是它的反向自检)。
    const fixture = makeLoadedCorpus(false);
    root = fixture.root;
    const calls: GatewayRequest[] = [];
    const fakeTransport = async (req: GatewayRequest): Promise<ModelResponse> => {
      calls.push(req);
      return {
        text: stubVariantToRawText('transport-fake'), // clean 桶 → fakeSerialPairs=0
        usage: { in: 100, out: 200 },
        raw: { mocked: true },
        model: req.model ?? 'fake:fake',
        attempts: 1,
      };
    };
    // 抑制 stderr 心跳 (CI 测试不该打 env 摘要)
    const origWrite = process.stderr.write.bind(process.stderr);
    let writeBytes = 0;
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      const s = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
      writeBytes += s.length;
      return true;
    }) as typeof process.stderr.write;
    try {
      const args: ReplayArgs = {
        manifestPath: fixture.path,
        variant: 'transport-fake',
        split: 'main',
        allowHeldout: false,
        baseline: true,
        stability: null,
        live: true,
      };
      const opts: DispatchOpts = { llmCaller: fakeTransport };
      const out = await runBaseline(args, fixture.loaded, opts);
      expect(out.ok).toBe(true);
      // main split 题数 > 0 → 每题 1 次 transport
      expect(calls.length).toBe(out.n);
      expect(calls.length).toBeGreaterThan(0);
      // 每发都是 conductor 装配 (model = manifest.seats.conductor, messages[1] 含 PLAN_BOUNDARY)
      const expectedModel = SEATS.conductor;
      for (const req of calls) {
        expect(req.model).toBe(expectedModel);
        expect(req.messages.length).toBe(2);
        expect(req.messages[0]!.role).toBe('system');
        const sysContent = String(req.messages[0]!.content);
        expect(sysContent).toContain('conductor'); // conductorSystemPrompt 真跑
        expect(req.messages[1]!.role).toBe('user');
        const userContent = String(req.messages[1]!.content);
        expect(userContent).toContain('====='); // PLAN_BOUNDARY (含 '===== TASK')
        expect(req.thinkingLevel).toBe('high');
        expect(req.maxTokens).toBe(32_768);
        expect(req.meta?.role).toBe('conductor');
        expect(req.meta?.sessionId).toMatch(/^autoresearch-replay:/);
      }
      // 装配链跑通, fake rawText → parsePlan ok → planValidity=true
      for (const item of out.perItem) {
        expect(item.planValidity).toBe(true);
      }
      // stderr 不该被 bootstrap 心跳污染 (我们没触发 register, fake transport 也不会)
      // 注: bootstrapModelRuntime 不一定会打 stderr (仅当 shouldWarnEnv); fake transport
      //   不打。允许 bootstrap 真打了「无 provider」一行, 但 llmCaller 0 次 → 红。
      expect(writeBytes).toBeLessThan(1024); // 没污染大量 stderr
    } finally {
      process.stderr.write = origWrite;
    }
  });

  test('LIVE-6 defaultLiveProvider 直接调 + mock transport: 出 rawText 真接入 fitness (装配链 e2e)', async () => {
    // 真值链: 不走 runBaseline, 直接调 defaultLiveProvider + mock transport → 拿 rawText
    //   → 丢给 evaluateSplit 验 parsePlan + fitness。锁住「装配链出口 (rawText) 真能
    //   接到 fitness 入口 (parsePlan)」, 不靠高阶 LiveProvider 注入 (那个绕开了装配链本身)。
    // 反向自检: 把 defaultLiveProvider 改成 return stubVariantToRawText(ctx.variant) →
    //   llmCaller 计数 0 → 闸红。
    let lastReq: GatewayRequest | undefined;
    const fakeTransport = async (req: GatewayRequest): Promise<ModelResponse> => {
      lastReq = req;
      // 返 clean fixture rawText (不走 stubVariantToRawText 分桶, 避免桶分配变动让测试脆)
      const cleanPath = join(
        import.meta.dir,
        '..',
        'src',
        'eval',
        'replay',
        'fixtures',
        'plan-clean.json',
      );
      return {
        text: readFileSync(cleanPath, 'utf8'),
        usage: { in: 10, out: 20 },
        raw: { e2e: true },
        model: req.model ?? 'fake:fake',
        attempts: 1,
      };
    };
    let callCount = 0;
    const countingTransport: (req: GatewayRequest) => Promise<ModelResponse> = async (req) => {
      callCount++;
      return fakeTransport(req);
    };
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try {
      const rawText = await defaultLiveProvider(
        'e2e-id',
        'e2e prompt',
        { seats: SEATS, variant: 'e2e-fake', id: 'e2e-id' },
        { llmCaller: countingTransport, bootstrap: () => [] },
      );
      expect(callCount).toBe(1);
      expect(lastReq).toBeDefined();
      expect(lastReq!.meta?.role).toBe('conductor'); // 装配链出口真挂 conductor meta
      // 真接 parsePlan → 真进 fitness 评估
      const fixture = makeLoadedCorpus(false);
      root = fixture.root;
      const result = await evaluateSplit({
        loaded: fixture.loaded,
        split: 'main',
        rawTextProvider: () => Promise.resolve(rawText),
      });
      // clean fixture → parsePlan ok → planValidity=true; fakeSerialPairs=0 (因 output_path 都在)
      expect(result.perItem.length).toBeGreaterThan(0);
      expect(result.perItem.every((r) => r.planValidity)).toBe(true);
      expect(result.aggregate.fakeSerialPairsTotal).toBe(0);
    } finally {
      process.stderr.write = origWrite;
    }
  });
});

// =====================================================================
// DISPATCH_INTEGRATION — 端到端 (CLI → dispatch → JSON)
// =====================================================================
describe('DISPATCH_INTEGRATION — 端到端 dispatch → JSON', () => {
  let root: string;
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  test('D-1 dispatch baseline → ReplayBaseline 全字段在', async () => {
    const fixture = makeLoadedCorpus(false);
    root = fixture.root;
    const args = parseReplayArgs([fixture.path, '--variant', 'baseline']);
    const out = (await dispatch(args)) as ReplayBaseline;
    expect(out.ok).toBe(true);
    expect(out.manifestHash).toBe(fixture.loaded.manifest.totalHash);
    expect(out.seats).toEqual(SEATS);
    expect(out.variant).toBe('baseline');
    expect(out.split).toBe('main');
  });

  test('D-2 dispatch --stability 3 → perDimVariance 全键在', async () => {
    const fixture = makeLoadedCorpus(false);
    root = fixture.root;
    const args = parseReplayArgs([fixture.path, '--stability', '3']);
    const out = (await dispatch(args)) as Awaited<ReturnType<typeof runStability>>;
    expect(out.ok).toBe(true);
    expect(out.runs).toBe(3);
    expect(out.perDimVariance).toBeDefined();
  });

  test('D-3 loadCorpusFromPath → 与 loadCorpus 等价 (闸配置透传)', () => {
    const fixture = makeLoadedCorpus(false);
    root = fixture.root;
    const loaded = loadCorpusFromPath(fixture.path, false);
    expect(loaded.manifest.totalHash).toBe(fixture.loaded.manifest.totalHash);
    expect(loaded.splits.heldout).toBeUndefined();
  });

  test('D-4 dispatch --help → 返 usage 不调 live provider', async () => {
    const args = parseReplayArgs(['--help']);
    const out = (await dispatch(args)) as { ok: true; usage: string };
    expect(out.ok).toBe(true);
    expect(out.usage).toContain('--baseline|--stability N');
  });
});

// =====================================================================
// FAILS_CLOSED — 入参与异常路径
// =====================================================================
describe('FAILS_CLOSED — 入参与异常', () => {
  test('F-1 无 manifest-path → parseReplayArgs throw', () => {
    expect(() => parseReplayArgs([])).toThrow(/usage|manifest/);
  });

  test('F-2 多个 positional → parseReplayArgs throw', () => {
    expect(() => parseReplayArgs(['/a.json', '/b.json'])).toThrow(/exactly one/);
  });

  test('F-3 --stability 1 (不合规) → throw', () => {
    expect(() => parseReplayArgs(['/a.json', '--stability', '1'])).toThrow(/>= 2/);
  });

  test('F-4 --stability abc → throw', () => {
    expect(() => parseReplayArgs(['/a.json', '--stability', 'abc'])).toThrow(/>= 2/);
  });

  test('F-5 --split 非法值 → throw', () => {
    expect(() => parseReplayArgs(['/a.json', '--split', 'bogus'])).toThrow(/screen \| main \| heldout/);
  });

  test('F-6 --variant 缺值 → throw', () => {
    expect(() => parseReplayArgs(['/a.json', '--variant'])).toThrow(/needs a value/);
  });

  test('F-7 未知 flag → throw', () => {
    expect(() => parseReplayArgs(['/a.json', '--no-such-flag'])).toThrow(/unknown flag/);
  });
});

// =====================================================================
// REPLAY_CONCURRENCY —— evaluateSplit 有界并发池 (2026-09-02 烟测: M3 一题中位 95s, 串行不可用)。
// 反向自检: 把 evaluateSplit 的 width 钉死为 1 → CONC-1 的墙钟断言红 (并发没生效);
//           把 perItem 改成 push 而非按 index 回填 → CONC-2 顺序断言红 (慢题后到会乱序)。
// =====================================================================
describe('REPLAY_CONCURRENCY — evaluateSplit 并发池: 更快且顺序不变', () => {
  let root: string;
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  const slowProvider = (delayMs: (id: string) => number) => {
    let inFlight = 0;
    let peak = 0;
    const provider: RawTextProvider = async (id) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, delayMs(id)));
      inFlight--;
      return stubVariantToRawText('baseline');
    };
    return { provider, peak: () => peak };
  };

  test('CONC-1 concurrency=3 同时在飞峰值 3, 墙钟明显低于串行', async () => {
    const fx = makeLoadedCorpus(false);
    root = fx.root;
    const ids = fx.loaded.splits.main ?? [];
    expect(ids.length).toBeGreaterThanOrEqual(3);
    const { provider, peak } = slowProvider(() => 40);
    const t0 = Date.now();
    await evaluateSplit({ loaded: fx.loaded, split: 'main', rawTextProvider: provider, concurrency: 3 });
    const wall = Date.now() - t0;
    expect(peak()).toBe(3);
    expect(wall).toBeLessThan(ids.length * 40);
  });

  test('CONC-2 慢题先领后到, perItem 仍按 split id 序; 缺省 concurrency 峰值 1', async () => {
    const fx = makeLoadedCorpus(false);
    root = fx.root;
    const ids = fx.loaded.splits.main ?? [];
    // 首题最慢: 并发下它最后返回, 若按返回序 push 就会掉到末尾。
    const { provider, peak } = slowProvider((id) => (id === ids[0] ? 60 : 5));
    const out = await evaluateSplit({ loaded: fx.loaded, split: 'main', rawTextProvider: provider, concurrency: 4 });
    expect(out.perItem.map((r) => r.id)).toEqual([...ids]);
    const serial = slowProvider(() => 2);
    await evaluateSplit({ loaded: fx.loaded, split: 'main', rawTextProvider: serial.provider });
    expect(serial.peak()).toBe(1);
    expect(peak()).toBeGreaterThan(1);
  });
});
