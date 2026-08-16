/**
 * 闸红短路的判据网(#145 提议 5 Phase A)。
 *
 * 两层各钉各的:
 *   ① 纯谓词 `findRedOracles` —— **窄**判据。这份网的大半在证明「哪些红**不**算」,
 *      因为放宽它的代价是拿基础设施故障冒充质量信号(判词见 oracle-red.ts 文件头那张表);
 *   ② 端到端 —— verifier 替身**被调用了几次**。判据是次数不是判词:
 *      这次改动要省的就是那一发,而"省了没有"只有次数答得了。
 */
import { describe, expect, test } from 'bun:test';
import { findRedOracles, renderOracleRedVerdict } from './oracle-red';
import { runExecutorDagWithPlan } from './engine';
import type { ConductorPlan } from '../conductor-plan';
import type { ExecutorDagConfig, GenerateFn, LeafResult } from './types';

const leaf = (p: Partial<LeafResult> & Pick<LeafResult, 'id' | 'status' | 'kind'>): LeafResult =>
  ({ output: '', deps: [], usage: { in: 0, out: 0 }, ...p }) as LeafResult;

const table = (rs: LeafResult[]): Record<string, LeafResult> =>
  Object.fromEntries(rs.map((r) => [r.id, r]));

describe('findRedOracles —— 窄判据', () => {
  test('★ 红: command 节点 assert-failed → 认', () => {
    // 证伪: 把 `r.failureKind !== 'assert-failed'` 那句 continue 删掉 → 下面「不认」的几条全绿转红。
    const out = findRedOracles(
      table([leaf({ id: 'gate', status: 'failed', kind: 'command', failureKind: 'assert-failed', output: 'error TS2322: x' })]),
    );
    expect(out.map((r) => r.id)).toEqual(['gate']);
    expect(out[0]!.excerpt).toContain('TS2322'); // 判词必须带编译器原话, 不许写成"闸没过"
  });

  test('★ 不认 `timed-out` —— 没跑完 ≠ 跑出了错答案', () => {
    // 这一条是整张网里最要紧的: 超时的命令**这一次根本没被测到**, 拿它当 oracle 判词
    // 就是把"没量到"读成"量到了坏的"。证伪: 判据放宽到任何 failureKind → 本条红。
    expect(
      findRedOracles(table([leaf({ id: 'g', status: 'failed', kind: 'command', failureKind: 'timed-out' })])),
    ).toEqual([]);
  });

  test('★ 不认 `gate-rejected` / `missing-capability` —— 命令压根没执行', () => {
    expect(
      findRedOracles(
        table([
          leaf({ id: 'a', status: 'failed', kind: 'command', failureKind: 'gate-rejected' }),
          leaf({ id: 'b', status: 'failed', kind: 'command', failureKind: 'missing-capability' }),
        ]),
      ),
    ).toEqual([]);
  });

  test('★ 不认非 command 的红 —— agent 写坏了是执行体的事, 不是 oracle 的判词', () => {
    expect(
      findRedOracles(
        table([
          leaf({ id: 'w', status: 'failed', kind: 'agent', failureKind: 'broken-artifact' }),
          leaf({ id: 'i', status: 'failed', kind: 'inproc', failureKind: 'assert-failed' }),
        ]),
      ),
    ).toEqual([]);
  });

  test('不认 dep-skip(零执行零花费), 也不认全绿', () => {
    expect(
      findRedOracles(
        table([
          leaf({ id: 's', status: 'skipped', kind: 'command', failureKind: 'dep-skip' }),
          leaf({ id: 'ok', status: 'done', kind: 'command' }),
        ]),
      ),
    ).toEqual([]);
  });

  test('判词随错误内容变化 —— D-6 同因熔断靠逐字比对判词', () => {
    // 固定成一句"闸没过"的话, 两轮不同的编译错会被熔断闸当成"连撞同一根因"而提前停。
    // 证伪: 让 renderOracleRedVerdict 忽略 excerpt → 本条红。
    const a = renderOracleRedVerdict([{ id: 'g', excerpt: 'error TS2322' }]);
    const b = renderOracleRedVerdict([{ id: 'g', excerpt: 'error TS7006' }]);
    expect(a).not.toBe(b);
    expect(a).toContain('未请强模型判卷'); // 事后读日志的人要看得出这一发是**故意**没打的
  });
});

describe('闸红短路 —— 端到端: 强模型那一发到底打没打', () => {
  const generate: GenerateFn = async () => {
    throw new Error('oracle-red 测试: generate 被意外调用');
  };
  const baseConfig = (extra: Partial<ExecutorDagConfig>): ExecutorDagConfig => ({
    conductorModel: 'test:conductor',
    leafModel: 'test:leaf',
    generate,
    agentTemplates: new Map(),
    ...extra,
  });
  const plan = (nodes: ConductorPlan['nodes']): ConductorPlan => ({ name: 'p', nodes });

  test('★ 闸红 → verifier 一次都不调, 判词由引擎合成', async () => {
    // 证伪: 把 runVerifier 里那段短路删掉 → calls 变 1(maxEscalations 默认 1 时可能更多), 本条红。
    let calls = 0;
    const r = await runExecutorDagWithPlan(
      plan({ gate: { goal: '验收', executor: 'command', command: 'false' } }),
      baseConfig({
        commandRunner: async () => ({ text: 'error TS2322: 类型不匹配', usage: { in: 0, out: 0 }, exitCode: 1 }),
        verifier: async () => {
          calls++;
          return { pass: true, reason: '强模型说好', usage: { in: 99_999, out: 999 } };
        },
      }),
    );
    expect(r.results.gate!.failureKind).toBe('assert-failed');
    expect(calls).toBe(0); // ← 这次改动要省的就是这一发
    expect(r.verification!.pass).toBe(false);
    expect(r.verification!.reason).toContain('[oracle-red]');
    expect(r.verification!.reason).toContain('TS2322'); // 编译器原话进了判词
  });

  test('★ 闸绿 → verifier 照常调(短路不许把语义闸整个吃掉)', async () => {
    // 这条防的是最坏的一种过头: 短路条件写宽了, 于是**任何** run 都不再请强模型判卷 ——
    // 那不是省钱, 是把质量闸静默关了。证伪: 让 findRedOracles 无条件返回非空 → 本条红。
    let calls = 0;
    const r = await runExecutorDagWithPlan(
      plan({ gate: { goal: '验收', executor: 'command', command: 'true' } }),
      baseConfig({
        commandRunner: async () => ({ text: 'ok', usage: { in: 0, out: 0 }, exitCode: 0 }),
        verifier: async () => {
          calls++;
          return { pass: true, reason: '过', usage: { in: 1, out: 1 } };
        },
      }),
    );
    expect(r.results.gate!.status).toBe('done');
    expect(calls).toBe(1);
    expect(r.verification!.pass).toBe(true);
  });

  test('★ 闸拒(退出码 <0)→ verifier 照常调 —— 命令没执行, 没有 oracle 判词可用', async () => {
    // 「oracle 说了不」与「oracle 没能说话」分开, 端到端也钉一次: 纯谓词层钉过了,
    // 但真正会出错的是判据接错了失败格。
    //
    // ⚠ 第一版这条**通过的理由是错的**: 没给 commandRunner, 于是它死在
    // 「缺 commandRunner → missing-capability」上, 压根没走到闸拒那条路 ——
    // 断言绿, 但量的不是标题说的东西。改成让替身**返回退出码 -1**(闸拒的契约出口,
    // 见 node-failure 的 gate-rejected: 「退出码 <0(command-leaf 闸拒, 命令未执行)」),
    // 这样测的是引擎对失败格的分辨, 而不是白名单的内部实现。
    let calls = 0;
    const r = await runExecutorDagWithPlan(
      plan({ gate: { goal: '验收', executor: 'command', command: 'rm -rf /' } }),
      baseConfig({
        commandRunner: async () => ({ text: '[blocked: 危险命令]', usage: { in: 0, out: 0 }, exitCode: -1 }),
        verifier: async () => {
          calls++;
          return { pass: false, reason: '强模型判的', usage: { in: 1, out: 1 } };
        },
      }),
    );
    expect(r.results.gate!.failureKind).toBe('gate-rejected'); // 先确认走的是这一格
    expect(calls).toBeGreaterThan(0); // 再确认它没被短路吃掉
  });
});
