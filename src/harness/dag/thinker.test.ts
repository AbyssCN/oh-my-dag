/**
 * src/harness/dag/thinker.test.ts —— THINKER_CRITIQUE 重画前置批评步纯函数 + 档位 (片 1)。
 *
 * 本片验 GWT:
 *   GWT-2  (INV-2): parseCritiqueOutput plan 形状 → 具名拒 (THINKER_REJECTED_PLAN_SHAPED_OUTPUT)
 *   GWT-3  (INV-3): runCritiqueStep generate 抛错 → fail-open, 留证据行, block=null
 *   GWT-4  (INV-4): pickCritiqueTier 4 格表全过
 *
 * GWT-1 (INV-1 独立调用接线) / GWT-5 (INV-5 缺省关零扰动) 接线判据在 thinker-wiring.test.ts (片 2)。
 *
 * 反向自检 (登记注释, 防漂移):
 *   · 把 pickCritiqueTier 里的 `if (!input.verdictSynthesized)` 删掉 → GWT-4 第 2 格当场红。
 *   · 把 lookLikePlanJson 短路成 `return false` → GWT-2 plan 形状用例当场红。
 *   · 把 runCritiqueStep 里的 try/catch 去掉 → GWT-3 generate 抛错用例当场红 (抛透)。
 *   · 把 buildCritiquePrompt 里的 `只批评上一张图` 改掉 → prompt 角色约束用例当场红。
 */
import { describe, expect, test } from 'bun:test';
import {
  THINKER_CRITIQUE,
  THINKER_GENERATE_FAILED,
  THINKER_REJECTED_PLAN_SHAPED_OUTPUT,
  THINKER_VERIFIER_COORD,
  buildCritiquePrompt,
  parseCritiqueOutput,
  pickCritiqueTier,
  resolveCritiqueModel,
  runCritiqueStep,
} from './thinker';
import type { GenerateFn } from './types';
import type { ModelUsage } from '../../model/gateway';

// 锚串逐字在本文件 (判据自证): ugrep -q 'THINKER_CRITIQUE' ./src/harness/dag/thinker.test.ts。
// 也作为运行时可达引用 (避免 unused-linter 把 import 折掉)。
const ANCHOR_PROBE: string = THINKER_CRITIQUE;
void ANCHOR_PROBE;

describe("THINKER_CRITIQUE · GWT-4 档位选择纯函数 (INV-4) — 四格表", () => {
  const cases: Array<{
    input: Parameters<typeof pickCritiqueTier>[0];
    want: 'conductor' | 'escalation';
    label: string;
  }> = [
    { input: { verdictSynthesized: true, sameCauseRepeat: false }, want: 'conductor', label: '(synth, 非同因) → conductor' },
    { input: { verdictSynthesized: false, sameCauseRepeat: false }, want: 'escalation', label: '(真 verifier, 非同因) → escalation' },
    { input: { verdictSynthesized: true, sameCauseRepeat: true }, want: 'escalation', label: '(synth, 同因) → escalation' },
    { input: { verdictSynthesized: false, sameCauseRepeat: true }, want: 'escalation', label: '(真 verifier, 同因) → escalation' },
  ];
  for (const c of cases) {
    test(c.label, () => {
      const got = pickCritiqueTier(c.input);
      expect(got.seat).toBe(c.want);
      expect(got.reasons.length).toBeGreaterThan(0);
    });
  }

  test('升档两条件都触发时 reasons 累积两条 (trace 用)', () => {
    const got = pickCritiqueTier({ verdictSynthesized: false, sameCauseRepeat: true });
    expect(got.seat).toBe('escalation');
    expect(got.reasons.length).toBe(2);
    expect(got.reasons[0]).toContain('real verifier');
    expect(got.reasons[1]).toContain('same normalized cause');
  });

  test('(synth, 非同因) reasons 显式说明 conductor-same 充足 (D-2)', () => {
    const got = pickCritiqueTier({ verdictSynthesized: true, sameCauseRepeat: false });
    expect(got.seat).toBe('conductor');
    expect(got.reasons[0]).toContain('conductor-same');
  });
});

describe("THINKER_CRITIQUE · resolveCritiqueModel (D-3 升档坐席)", () => {
  test('conductor 档 → 调用方传的 conductorModel', () => {
    const m = resolveCritiqueModel({
      tier: pickCritiqueTier({ verdictSynthesized: true, sameCauseRepeat: false }),
      conductorModel: 'claude-code:claude-opus-5',
    });
    expect(m.model).toBe('claude-code:claude-opus-5');
    expect(m.tier).toBe('conductor');
    expect(m.thinkingLevel).toBe('high');
  });

  test('escalation 档 → 内置 THINKER_VERIFIER_COORD (D-3 复用现有席, 不新增登记)', () => {
    const m = resolveCritiqueModel({
      tier: pickCritiqueTier({ verdictSynthesized: false, sameCauseRepeat: false }),
      conductorModel: 'claude-code:claude-opus-5',
    });
    expect(m.model).toBe(THINKER_VERIFIER_COORD);
    expect(m.model).toBe('openai-codex:gpt-5.6-sol');
    expect(m.tier).toBe('escalation');
  });

  test('escalation 档可被调用方覆盖坐标 (未来 A/B 用, 接口已留口)', () => {
    const m = resolveCritiqueModel({
      tier: pickCritiqueTier({ verdictSynthesized: true, sameCauseRepeat: true }),
      conductorModel: 'claude-code:claude-opus-5',
      verifierFamilyCoord: 'openai-codex:gpt-5.6-sol-xhigh',
    });
    expect(m.model).toBe('openai-codex:gpt-5.6-sol-xhigh');
    expect(m.tier).toBe('escalation');
  });
});

describe("THINKER_CRITIQUE · buildCritiquePrompt (INV-2 角色约束写死)", () => {
  test('system 段写死角色硬规则 (只批评 / 不许画新图 / 不许输出节点定义)', () => {
    const p = buildCritiquePrompt({
      task: '原始任务',
      planOutline: '- [a] (command): gA',
      verdictReason: 'verifier 判不过',
      writeWallLines: [],
      normalizedCauses: [],
    });
    expect(p.messages[0]!.role).toBe('system');
    const sys = p.messages[0]!.content;
    expect(sys).toContain('只批评上一张图');
    expect(sys).toContain('不许画新图');
    expect(sys).toContain('不许输出节点定义');
    expect(p.traceName).toBe('thinker:critique');
  });

  test('user 段五块齐: task / planOutline / verdictReason / writeWallLines / normalizedCauses', () => {
    const p = buildCritiquePrompt({
      task: 'TASK-X',
      planOutline: 'OUTLINE-X',
      verdictReason: 'REASON-X',
      writeWallLines: ['[写域闸撞墙] W1', '[写域闸撞墙] W2'],
      normalizedCauses: ['empty-artifact', 'gate-rejected'],
    });
    const user = p.messages[1]!.content;
    expect(user).toContain('TASK-X');
    expect(user).toContain('OUTLINE-X');
    expect(user).toContain('REASON-X');
    expect(user).toContain('[写域闸撞墙] W1');
    expect(user).toContain('[写域闸撞墙] W2');
    expect(user).toContain('- empty-artifact');
    expect(user).toContain('- gate-rejected');
  });

  test('写域闸撞墙与归一化败因表都为空 → user 段显式「(无)」/「(空)」(不让 prompt 看着像被裁)', () => {
    const p = buildCritiquePrompt({
      task: 'T',
      planOutline: 'O',
      verdictReason: 'R',
      writeWallLines: [],
      normalizedCauses: [],
    });
    const user = p.messages[1]!.content;
    expect(user).toContain('(无)');
    expect(user).toContain('(空)');
  });
});

describe("THINKER_CRITIQUE · GWT-2 parseCritiqueOutput plan 形状具名拒 (INV-2)", () => {
  test('散文批评 → ok, block = trimmed 文本', () => {
    const r = parseCritiqueOutput('  上一轮 a 节点的 goal 写偏了; 下轮把写集改成只写 X。  ');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.block).toBe('上一轮 a 节点的 goal 写偏了; 下轮把写集改成只写 X。');
  });

  test('散文里夹带 JSON 但没有 nodes 字段 → ok (非 plan 形状)', () => {
    const text = '批评: 上一轮的 { "foo": 1 } 不是 plan 形状, 我只是举例。';
    const r = parseCritiqueOutput(text);
    expect(r.ok).toBe(true);
  });

  test('plan 形状 JSON → 具名拒 THINKER_REJECTED_PLAN_SHAPED_OUTPUT', () => {
    const planShape = JSON.stringify({
      name: 'fake',
      description: 'fake plan',
      nodes: {
        a: { goal: 'gA', executor: 'command', command: 'echo a' },
        b: { goal: 'gB', executor: 'command', command: 'echo b' },
      },
    });
    const r = parseCritiqueOutput(planShape);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBe(THINKER_REJECTED_PLAN_SHAPED_OUTPUT);
      expect(r.error.length).toBeGreaterThan(0);
    }
  });

  test('plan 形状 JSON 嵌在散文里 → 仍具名拒 (只看首个平衡 {} 切片)', () => {
    const text = `前缀散文\n${JSON.stringify({ name: 'p', nodes: { a: { goal: 'g' } } })}\n后缀散文`;
    const r = parseCritiqueOutput(text);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe(THINKER_REJECTED_PLAN_SHAPED_OUTPUT);
  });

  test('nodes 字段是数组 → 不算 plan 形状 (plan 用 Record)', () => {
    const text = JSON.stringify({ name: 'x', nodes: ['a', 'b'] });
    const r = parseCritiqueOutput(text);
    expect(r.ok).toBe(true);
  });

  test('空文本 / 纯空白 → ok, block = "" (无批评块注入, fail-open 不挡)', () => {
    expect(parseCritiqueOutput('')).toEqual({ ok: true, block: '' });
    expect(parseCritiqueOutput('   \n  ')).toEqual({ ok: true, block: '' });
  });

  test('JSON 解析失败 → 视为散文 (例如半截 JSON / 字符串未闭合)', () => {
    const r = parseCritiqueOutput('批评: { "nodes": "语法没闭合');
    expect(r.ok).toBe(true);
  });
});

describe("THINKER_CRITIQUE · GWT-3 runCritiqueStep fail-open (INV-3 / INV-5)", () => {
  const baseInput = {
    task: 'T',
    planOutline: 'O',
    verdictReason: 'R',
    writeWallLines: ['[写域闸撞墙] W'],
    normalizedCauses: ['empty-artifact'],
  } as const;

  test('enabled=false → block=null, generate 零调用 (INV-5)', async () => {
    let calls = 0;
    const generate: GenerateFn = async () => {
      calls++;
      return { text: 'x', usage: { in: 1, out: 1 } };
    };
    const evidence: Array<{ msg: string; payload: Record<string, unknown> }> = [];
    const r = await runCritiqueStep({
      enabled: false,
      pick: { verdictSynthesized: true, sameCauseRepeat: false },
      conductorModel: 'claude-code:claude-opus-5',
      input: baseInput,
      generate,
      logEvidence: (msg, payload) => evidence.push({ msg, payload }),
    });
    expect(r.block).toBeNull();
    expect(calls).toBe(0);
    expect(evidence.length).toBe(0);
    expect(r.rejectReason).toBeUndefined();
    expect(r.usage).toEqual({ in: 0, out: 0 });
  });

  test('generate 抛错 → block=null, reject=THINKER_GENERATE_FAILED, 证据行含错误原文 (INV-3)', async () => {
    const evidence: Array<{ msg: string; payload: Record<string, unknown> }> = [];
    const generate: GenerateFn = async () => {
      throw new Error('seat-429-ratelimit');
    };
    const r = await runCritiqueStep({
      enabled: true,
      pick: { verdictSynthesized: true, sameCauseRepeat: false },
      conductorModel: 'claude-code:claude-opus-5',
      input: baseInput,
      generate,
      logEvidence: (msg, payload) => evidence.push({ msg, payload }),
    });
    expect(r.block).toBeNull();
    expect(r.rejectReason).toBe(THINKER_GENERATE_FAILED);
    expect(evidence.length).toBe(1);
    expect(evidence[0]!.payload.error).toBe(THINKER_GENERATE_FAILED);
    expect(evidence[0]!.payload.raw).toBe('seat-429-ratelimit');
    expect(evidence[0]!.payload.tier).toBe('conductor');
    expect(evidence[0]!.payload.model).toBe('claude-code:claude-opus-5');
    // 失败那一发 usage 归零 (LLM 没收钱, 不许让账本凭空多算)。
    expect(r.usage).toEqual({ in: 0, out: 0 });
  });

  test('generate 返回 plan 形状 → block=null, reject=THINKER_REJECTED_PLAN_SHAPED_OUTPUT', async () => {
    const evidence: Array<{ msg: string; payload: Record<string, unknown> }> = [];
    const planShape = JSON.stringify({ name: 'p', nodes: { a: { goal: 'g' } } });
    const generate: GenerateFn = async () => ({ text: planShape, usage: { in: 1, out: 1 } });
    const r = await runCritiqueStep({
      enabled: true,
      pick: { verdictSynthesized: true, sameCauseRepeat: false },
      conductorModel: 'claude-code:claude-opus-5',
      input: baseInput,
      generate,
      logEvidence: (msg, payload) => evidence.push({ msg, payload }),
    });
    expect(r.block).toBeNull();
    expect(r.rejectReason).toBe(THINKER_REJECTED_PLAN_SHAPED_OUTPUT);
    expect(evidence.length).toBe(1);
    expect(evidence[0]!.payload.error).toBe(THINKER_REJECTED_PLAN_SHAPED_OUTPUT);
    expect(evidence[0]!.payload.rawPreview).toBeDefined();
    // plan 形状那发 LLM 真跑了 → usage 透传给调用方。
    expect(r.usage).toEqual({ in: 1, out: 1 });
  });

  test('generate 返回散文 → block = 散文 trimmed, tier=conductor (D-2 缺省)', async () => {
    const generate: GenerateFn = async () => ({
      text: '  批评: 上轮 a 的 goal 写偏; 下轮只写 X。  ',
      usage: { in: 1, out: 1 },
    });
    const r = await runCritiqueStep({
      enabled: true,
      pick: { verdictSynthesized: true, sameCauseRepeat: false },
      conductorModel: 'claude-code:claude-opus-5',
      input: baseInput,
      generate,
      logEvidence: () => {},
    });
    expect(r.block).toBe('批评: 上轮 a 的 goal 写偏; 下轮只写 X。');
    expect(r.tier.seat).toBe('conductor');
    expect(r.rejectReason).toBeUndefined();
  });

  test('同因重败 → 升档: tier=escalation, model=THINKER_VERIFIER_COORD', async () => {
    let seenModel = '';
    const generate: GenerateFn = async (req) => {
      seenModel = req.model;
      return { text: '批评', usage: { in: 1, out: 1 } };
    };
    const r = await runCritiqueStep({
      enabled: true,
      pick: { verdictSynthesized: true, sameCauseRepeat: true },
      conductorModel: 'claude-code:claude-opus-5',
      input: baseInput,
      generate,
      logEvidence: () => {},
    });
    expect(r.tier.seat).toBe('escalation');
    expect(r.model.model).toBe(THINKER_VERIFIER_COORD);
    expect(seenModel).toBe(THINKER_VERIFIER_COORD);
    expect(r.block).toBe('批评');
  });

  test('generate 抛非 Error → 错误原文走 String(err) 落 raw', async () => {
    const evidence: Array<{ msg: string; payload: Record<string, unknown> }> = [];
    const generate: GenerateFn = async () => {
      throw 'string-error';
    };
    const r = await runCritiqueStep({
      enabled: true,
      pick: { verdictSynthesized: false, sameCauseRepeat: false },
      conductorModel: 'claude-code:claude-opus-5',
      input: baseInput,
      generate,
      logEvidence: (msg, payload) => evidence.push({ msg, payload }),
    });
    expect(r.block).toBeNull();
    expect(r.tier.seat).toBe('escalation');
    expect(evidence[0]!.payload.raw).toBe('string-error');
  });

  test('usage 透传 (调用方自记累加)', async () => {
    const u: ModelUsage = { in: 12, out: 34 };
    const generate: GenerateFn = async () => ({ text: '批评', usage: u });
    const r = await runCritiqueStep({
      enabled: true,
      pick: { verdictSynthesized: true, sameCauseRepeat: false },
      conductorModel: 'claude-code:claude-opus-5',
      input: baseInput,
      generate,
      logEvidence: () => {},
    });
    expect(r.usage).toEqual({ in: 12, out: 34 });
  });

  test('prompt 的 traceName 是 thinker:critique (分账观测名, 见 engine.ts:607 同款前缀分账先例)', async () => {
    let seenTrace = '';
    const generate: GenerateFn = async (req) => {
      seenTrace = req.traceName ?? '';
      return { text: '批评', usage: { in: 1, out: 1 } };
    };
    await runCritiqueStep({
      enabled: true,
      pick: { verdictSynthesized: true, sameCauseRepeat: false },
      conductorModel: 'claude-code:claude-opus-5',
      input: baseInput,
      generate,
      logEvidence: () => {},
    });
    expect(seenTrace).toBe('thinker:critique');
  });
});

describe('THINKER_CRITIQUE · 锚串 / 错误码常量 (判据自证)', () => {
  test('THINKER_CRITIQUE 是非空字符串', () => {
    expect(typeof THINKER_CRITIQUE).toBe('string');
    expect(THINKER_CRITIQUE.length).toBeGreaterThan(0);
  });

  test('两个具名错误码字面值稳定 (下游日志 grep 用, 改名要同步改闸线)', () => {
    expect(THINKER_REJECTED_PLAN_SHAPED_OUTPUT).toBe('THINKER_REJECTED_PLAN_SHAPED_OUTPUT');
    expect(THINKER_GENERATE_FAILED).toBe('THINKER_GENERATE_FAILED');
  });

  test('THINKER_VERIFIER_COORD 与 seats.ts verifier 家族同值', () => {
    expect(THINKER_VERIFIER_COORD).toBe('openai-codex:gpt-5.6-sol');
  });
});