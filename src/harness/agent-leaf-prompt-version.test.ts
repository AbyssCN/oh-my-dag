/**
 * agent leaf 的 **promptVersion 口径**(2026-07-31,live trace 抓到的缺口)。
 *
 * 第一条真 trace 上:8 个 agent leaf 的 prompt 全在 Langfuse 上(上一轮补的),
 * 但 `promptVersion` 一条都没有 —— 25 条 observation 里只有 9 条带版本,而带版本的那 9 条
 * 恰好都是走 gateway 的(它按 system 段算)。agent leaf 不经 gateway,整份指令都在 user prompt 里,
 * 于是"prompt 看得见但没有版本身份",按 prompt 版本分组对比这件事做不了。
 *
 * 这份网钉的是**版本必须可分组**这条性质,而不是某个具体哈希值:
 * 哈希值会随脚手架正文变(那正是它该变的时候),而"逐节点漂"是它变成废字段的方式。
 */
import { describe, expect, test } from 'bun:test';
import { agentScaffold } from './agent-leaf';
import { promptVersionOfText } from '../model/langfuse';

const V = (o: Parameters<typeof agentScaffold>[0]): string => promptVersionOfText(agentScaffold(o));
const WEAK = { profile: 'weak', model: 'deepseek:deepseek-v4-flash', toolRouting: true, disciplineCore: true } as const;

describe('promptVersion 必须可分组 —— 否则它就是个废字段', () => {
  test('★ 版本与**节点**无关:脚手架不含 goal/上游材料, 所以同档的 8 个 leaf 版本相同', () => {
    // 这是整条性质的要害。若拿整条 prompt 去哈希, 每个节点会得到不同的"版本",
    // 于是"按 prompt 版本分组比较"退化成"按节点分组", 而那个维度本来就有 (nodeId)。
    expect(agentScaffold(WEAK)).not.toContain('goal');
    const sameAcrossNodes = new Set([V(WEAK), V(WEAK), V(WEAK)]);
    expect(sameAcrossNodes.size).toBe(1);
  });

  test('★ 版本随**档位**变 —— 三套脚手架必须区分得开 (A/B 的全部意义在此)', () => {
    const strong = { ...WEAK, profile: 'strong' } as const;
    const off = { ...WEAK, profile: 'off' } as const;
    expect(new Set([V(WEAK), V(strong), V(off)]).size).toBe(3);
  });

  test('两个硬开关也各自改变版本 (关掉一块 = 换了一版脚手架)', () => {
    const noRouting = { ...WEAK, toolRouting: false } as const;
    const noDiscipline = { ...WEAK, disciplineCore: false } as const;
    expect(new Set([V(WEAK), V(noRouting), V(noDiscipline)]).size).toBe(3);
  });

  test('auto 档按模型强弱分派 —— 强模型走 house-rules, 弱模型走全量', () => {
    // 强弱分派的差别 = 要不要教**怎么选工具**: 强模型自己判得了, 弱模型要表。
    // 承重纪律 (共享层 + 执行核) 与模型强弱无关, 两档都拼。
    const auto = (model: string) => agentScaffold({ ...WEAK, profile: 'auto', model });
    expect(auto('deepseek:deepseek-v4-flash')).toContain('<tool-routing>');
    expect(auto('openai-codex:gpt-5.6-sol')).not.toContain('<tool-routing>');
    for (const m of ['deepseek:deepseek-v4-flash', 'openai-codex:gpt-5.6-sol']) {
      expect(auto(m)).toContain('<core-discipline>');
      expect(auto(m)).toContain('<leaf-execution>');
    }
  });

  test("off 档 = 裸 prompt 基线: 脚手架为空串, 版本仍是个确定值 (不是 undefined)", () => {
    expect(agentScaffold({ ...WEAK, profile: 'off' })).toBe('');
    expect(V({ ...WEAK, profile: 'off' })).toMatch(/^[0-9a-f]{12}$/);
  });

  test('拼法字节稳定 —— 脚手架与 prompt 之间恒是一个空行, 关掉的块不留空段', () => {
    // 改拼法 = 全 leaf 的 prompt-cache 失效 (实测宽扇出命中 84~98%, 这是真钱)。
    // 关掉 discipline 时不许留下一个空的 "\n\n" 头 —— 那会让前缀与别档不同而白丢缓存。
    // 关掉任一块都不许留空段: 空的 "\n\n" 会让前缀与别档不同而白丢缓存。
    // 完整拼装形状由 harness-prompts.test.ts 钉 (SSOT: 一处钉, 这里不复述)。
    for (const cfg of [WEAK, { ...WEAK, disciplineCore: false }, { ...WEAK, toolRouting: false }]) {
      const out = agentScaffold(cfg);
      expect(out.startsWith('\n')).toBe(false);
      expect(out.endsWith('\n')).toBe(false);
      expect(out).not.toContain('\n\n\n');
    }
  });
});
