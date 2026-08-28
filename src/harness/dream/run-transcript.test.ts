/**
 * 票 #10 —— `buildRunTranscript`:把 run 记录里**本来就有**的材料喂给 extract。
 *
 * 现场:`buildExtractRunInput` 过去只传 `{runId,status,goal,error,planLedger}`,而
 * `ExtractRunInput.transcript` 与 `renderTrustedRunInput` 的 `## Transcript` 段一直都在 ——
 * 管子是通的,只是没人往里灌。实测代价:0.25 条 fact / 次模型调用。
 *
 * 反向自检(实跑):
 *  - 把 `verification.reason` 那一支删掉 ⇒ 「判词排第一」当场红;
 *  - 把 bad/good 分组去掉(全都给细节)⇒ 「done 节点只给一行」当场红;
 *  - 把 `return undefined` 改成 `return ''` ⇒ 「无材料返 undefined」当场红。
 */
import { describe, expect, test } from 'bun:test';
import { buildRunTranscript } from './assembly';
import type { PersistedRun } from '../../mcp/run-store';

const run = (over: Partial<PersistedRun>): PersistedRun =>
  ({ runId: 'r1', status: 'failed', goal: 'g', createdAt: '', updatedAt: '', meta: {}, ownerPid: null, ...over }) as PersistedRun;

describe('buildRunTranscript', () => {
  test('★ 无任何材料 → undefined(不是空串:"不适用" ≠ "这段是空的")', () => {
    expect(buildRunTranscript(run({}))).toBeUndefined();
    expect(buildRunTranscript(run({ result: {} }))).toBeUndefined();
    expect(buildRunTranscript(run({ result: { verification: { reason: '   ' } } }))).toBeUndefined();
  });

  test('★ verifier 判词排第一 —— 信噪比最高的一段不许被节点倾泻挤到后面', () => {
    const t = buildRunTranscript(
      run({
        result: { verification: { pass: false, reason: 'test_lock 节点失败, 下游全 skip' } },
        nodeDetails: { a: { status: 'failed', output: 'x' } },
      }),
    )!;
    expect(t.startsWith('### verifier 判词')).toBe(true);
    // 判词整段要排在节点段之前 —— 顺序就是给模型的注意力预算
    expect(t.indexOf('verifier 判词')).toBeLessThan(t.indexOf('未跑通的节点'));
    expect(t).toContain('test_lock 节点失败');
    expect(t).toContain('pass=false');
  });

  test('★ done 节点只给一行, 失败节点才给细节(教训在坏掉的那些里)', () => {
    const t = buildRunTranscript(
      run({
        nodeDetails: {
          ok1: { status: 'done', output: 'A'.repeat(500) },
          ok2: { status: 'done', output: 'B'.repeat(500) },
          bad1: { status: 'failed', output: '', error: 'TS2339: 属性不存在' },
        },
      }),
    )!;
    expect(t).toContain('TS2339');
    expect(t).toContain('跑通的节点: ok1, ok2');
    expect(t).not.toContain('A'.repeat(100)); // done 的 output 一个字都不进
  });

  test('单节点超长 → 截断且**明写截了多少**(悄悄截会被读成"没有")', () => {
    const t = buildRunTranscript(run({ nodeDetails: { n: { status: 'failed', output: 'x'.repeat(3000) } } }))!;
    expect(t).toContain('[截断');
    expect(t.length).toBeLessThan(3000);
  });

  test('整段超长 → 整段截断也要留话', () => {
    const many: Record<string, { status: string; output: string }> = {};
    for (let i = 0; i < 40; i++) many[`n${i}`] = { status: 'failed', output: 'y'.repeat(700) };
    const t = buildRunTranscript(run({ nodeDetails: many }))!;
    expect(t).toContain('整段截断');
    expect(t.length).toBeLessThan(6300);
  });

  test('只有节点没有判词 → 照样出得来(两个来源各自缺席不拖累另一个)', () => {
    const t = buildRunTranscript(run({ nodeDetails: { a: { status: 'failed', output: 'boom' } } }))!;
    expect(t).toContain('boom');
    expect(t).not.toContain('verifier 判词');
  });
});
