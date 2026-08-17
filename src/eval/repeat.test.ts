/**
 * repeat.ts 单测 —— 三件套 + 判据③尺子自检 (SDD #159 切片 1)。
 * 逐次落盘 (INV-1) 在 run 回调**内部**验: 第 i 次 run 跑起来时 sink 缓冲恰有 i 行 (前 i 行已落、第 i 行未落) —— 攒批到循环末的实现这里读到 0 行会红。
 *
 * 单测纯注入, 不碰真 .omd —— sink 收行计数直接验, 不读盘; 拼装路径用 repeatPath 纯函数。
 */
import { describe, expect, test } from 'bun:test';
import {
  aggregateBool,
  aggregateNum,
  renderRepeatLine,
  repeatPath,
  repeatSegment,
  type RepeatRecord,
} from './repeat';

/** 把 sink 收的行收集起来 (JSONL 解析到对象数组)。Hermetic。 */
function makeSink(): { lines: string[]; sink: (line: string) => void } {
  const lines: string[] = [];
  return { lines, sink: (line: string) => lines.push(line) };
}

/** 从 records 抽出非 error 次的 bool, 给 aggregateBool 用 (INV-2: error 不进分母)。 */
function boolsFrom<T>(records: RepeatRecord<T | { error: string }>[]): boolean[] {
  const out: boolean[] = [];
  for (const r of records) {
    if (typeof r.value === 'object' && r.value !== null && 'error' in r.value) continue;
    out.push(r.value as boolean);
  }
  return out;
}

describe('repeatSegment — GWT 1', () => {
  test('n=3 段, run 依次 true/false/true → 第 k 次 run 内盘上已有 k-1 行 (INV-1), sink 逐次 3 行, aggregateBool {n:3, pass:2}', async () => {
    const { lines, sink } = makeSink();
    const seq = [true, false, true];
    const records = await repeatSegment({
      id: 'gwt1',
      n: 3,
      run: async (i) => {
        // INV-1 反向自检: sink 在 await run(i) 之后才落第 i 行 —— 这里应恰有 i 行。
        expect(lines).toHaveLength(i);
        return seq[i]!;
      },
      sink,
    });
    expect(records).toHaveLength(3);
    expect(lines).toHaveLength(3); // INV-1
    const parsed = lines.map((l) => JSON.parse(l) as RepeatRecord<boolean>);
    expect(parsed.map((r) => r.i)).toEqual([0, 1, 2]);
    expect(parsed.map((r) => r.value)).toEqual([true, false, true]);
    expect(parsed.every((r) => typeof r.at === 'string' && r.at.length > 0)).toBe(true);
    expect(aggregateBool(boolsFrom(records))).toEqual({
      n: 3,
      pass: 2,
      rate: 2 / 3,
      wilson95: expect.any(Array) as unknown as [number, number],
    });
  });
});

describe('repeatSegment — GWT 2 (INV-2 单次抛错不中断)', () => {
  test('第 2 次 run 抛错 → 3 行照落、第 2 行 value 含 error 原文、后续次照跑, 聚合 n=2, 口径行含 err=1', async () => {
    const { lines, sink } = makeSink();
    const calls: number[] = [];
    const records = await repeatSegment<boolean>({
      id: 'gwt2',
      n: 3,
      run: async (i) => {
        calls.push(i); // 反向自检: 遇错中断段的实现 calls 只到 [0,1] → 红
        if (i === 1) throw new Error('boom');
        return i !== 1;
      },
      sink,
    });
    expect(calls).toEqual([0, 1, 2]); // 后续次照跑
    expect(lines).toHaveLength(3); // 三次都落盘, 第 2 行含 error 原文
    const parsed = lines.map((l) => JSON.parse(l) as RepeatRecord<unknown>);
    expect(parsed[0]!.value).toBe(true);
    expect(parsed[1]!.value).toEqual({ error: 'boom' });
    expect(parsed[2]!.value).toBe(true);
    // 分母只算非 error 次 → n=2
    const agg = aggregateBool(boolsFrom(records));
    expect(agg.n).toBe(2);
    expect(agg.pass).toBe(2);
    // 口径行带 err=1
    const line = renderRepeatLine('plan-validity/x', agg, 1);
    expect(line).toContain('err=1');
    // 同时基础格式仍合规 (口径单点 INV-3)
    expect(line).toMatch(/^plan-validity\/x: 2\/2 \(rate (?:\d+\.\d{3}|\.\d{3}|1\.000) · Wilson95 \[(?:\d+\.\d{3}|\.\d{3}|1\.000), (?:\d+\.\d{3}|\.\d{3}|1\.000)\] · n=2\) · err=1$/);
  });
});

describe('aggregateBool / aggregateNum / renderRepeatLine — GWT 3 (判据③尺子自检)', () => {
  test('确定性 50% 段 n=20 → rate=0.5 ∧ wilson95 宽 > 0.3 (不是稳定数)', () => {
    const vals: boolean[] = [];
    for (let i = 0; i < 20; i++) vals.push(i % 2 === 0);
    const agg = aggregateBool(vals);
    expect(agg.n).toBe(20);
    expect(agg.pass).toBe(10);
    expect(agg.rate).toBe(0.5);
    const [lo, hi] = agg.wilson95;
    expect(hi - lo).toBeGreaterThan(0.3); // 任何干预下都不动的数通常量的是尺子 — 确认尺子在动
    expect(lo).toBeGreaterThan(0);
    expect(hi).toBeLessThan(1);
  });

  test('恒 true 段 n=20 → rate=1 ∧ wilson95 下界 > 0.8 ∧ (数值段) sd=0', () => {
    const vals = Array.from({ length: 20 }, () => true);
    const agg = aggregateBool(vals);
    expect(agg.rate).toBe(1);
    expect(agg.wilson95[0]).toBeGreaterThan(0.8);
    // 数值段: 恒定值 → sd=0
    const nums = Array.from({ length: 20 }, () => 42);
    const aNum = aggregateNum(nums);
    expect(aNum.n).toBe(20);
    expect(aNum.mean).toBe(42);
    expect(aNum.sd).toBe(0);
    expect(aNum.min).toBe(42);
    expect(aNum.max).toBe(42);
  });

  test('恒 false 段 n=20 → rate=0 ∧ wilson95 上界 < 0.2', () => {
    const vals = Array.from({ length: 20 }, () => false);
    const agg = aggregateBool(vals);
    expect(agg.rate).toBe(0);
    expect(agg.wilson95[1]).toBeLessThan(0.2);
  });

  test('n=0 退化 → 零值结构 (无信号≠满分)', () => {
    expect(aggregateBool([])).toEqual({ n: 0, pass: 0, rate: 0, wilson95: [0, 0] });
    expect(aggregateNum([])).toEqual({ n: 0, mean: 0, sd: 0, min: 0, max: 0 });
  });

  test('num sd 用 n-1 样本方差 (值有离散)', () => {
    // [1, 2, 3, 4, 5] → mean=3, 样本方差 = ((4+1+0+1+4)/4) = 2.5, sd ≈ 1.5811
    const a = aggregateNum([1, 2, 3, 4, 5]);
    expect(a.mean).toBe(3);
    expect(a.sd).toBeCloseTo(Math.sqrt(2.5), 6);
    expect(a.min).toBe(1);
    expect(a.max).toBe(5);
  });
});

describe('renderRepeatLine — 口径行格式 (INV-3 单点)', () => {
  test('标准格式 + err 注记 (errors>0)', () => {
    const agg: ReturnType<typeof aggregateBool> = {
      n: 20,
      pass: 3,
      rate: 0.15,
      wilson95: [0.052, 0.36],
    };
    expect(renderRepeatLine('plan-validity/foo', agg)).toBe(
      'plan-validity/foo: 3/20 (rate .150 · Wilson95 [.052, .360] · n=20)',
    );
    expect(renderRepeatLine('plan-validity/foo', agg, 1)).toContain('err=1');
    expect(renderRepeatLine('plan-validity/foo', agg, 0)).not.toContain('err=');
  });
});

describe('repeatSegment — 违约', () => {
  test('n<1 抛错', async () => {
    await expect(
      repeatSegment({ id: 'bad', n: 0, run: async () => true }),
    ).rejects.toThrow(/n must be an integer >= 1/);
    await expect(
      repeatSegment({ id: 'bad', n: -2, run: async () => true }),
    ).rejects.toThrow(/n must be an integer >= 1/);
    await expect(
      repeatSegment({ id: 'bad', n: 1.5, run: async () => true }),
    ).rejects.toThrow(/n must be an integer >= 1/);
  });
});

describe('repeatPath — 路径拼装 (纯函数, 不碰盘)', () => {
  test('非安全字符替换为 _', () => {
    expect(repeatPath('plan-validity/task-a')).toBe('.omd/eval/repeats/plan-validity_task-a.jsonl');
    expect(repeatPath('a/b c')).toBe('.omd/eval/repeats/a_b_c.jsonl');
    expect(repeatPath('../../etc/passwd')).toBe('.omd/eval/repeats/______etc_passwd.jsonl');
  });
  test('自定义 base', () => {
    expect(repeatPath('x', '/tmp/foo')).toBe('/tmp/foo/x.jsonl');
  });
});
