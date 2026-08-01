/**
 * 座位登记表的**完整性闸** (2026-08-01)。
 *
 * `seats.ts` 是座位的单一真源 —— 分档 / 消费点 / effort / 采样 / 建议模型全在一处, 而
 * `role-models` · `auto-assign` · `empty-knobs` 三处从它派生。真源要担得起这个位置, 就得有人
 * 守着"每一格都填了、填的是真话"。这个仓一路撞见的缺陷都是同一形态:
 * **声明面往前跑了, 消费面没跟上, 两边都不报错。** 一张没人守的真源表迟早变成第五份会漂的文档。
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SEATS, SEAT_PREFERRED_COORD, SEAT_THINKING, SEAT_TIER, seatSampling, seatSpec } from './seats';
import { capsFor } from './model-caps';
import { reasoningEffortFor } from './index';

const REPO = join(import.meta.dir, '..', '..');

describe('登记表本身填齐了', () => {
  it('★ 每个座位都写了: 干什么 / 频率 / 建议 / 至少一个消费点', () => {
    for (const s of SEATS) {
      expect(s.what.length, `${s.id}.what`).toBeGreaterThan(10);
      expect(s.frequency.length, `${s.id}.frequency`).toBeGreaterThan(2);
      expect(s.recommend.length, `${s.id}.recommend`).toBeGreaterThan(5);
      // 空的 where = 这个座位没人读 = 空旋钮。加座位不登记消费点, 这里红。
      expect(s.where.length, `${s.id}.where 为空 —— 没有消费者的座位就是空旋钮`).toBeGreaterThan(0);
    }
  });

  it('座位 id 唯一', () => {
    expect(new Set(SEATS.map((s) => s.id)).size).toBe(SEATS.length);
  });

  it('★ 消费点写的文件必须真的存在 —— 否则登记的是一句过时的话', () => {
    for (const s of SEATS) {
      for (const w of s.where) {
        // 形如 `mcp/assemble.resolveEngineModels` / `harness/tui (…)` → 取到第一个 . ( 空格之前
        const file = w.split(/[ (]/)[0]!.replace(/\.[A-Za-z_$][\w$]*$/, '');
        const hit = ['ts', 'tsx'].some((ext) => {
          try {
            readFileSync(join(REPO, 'src', `${file}.${ext}`));
            return true;
          } catch {
            try {
              readFileSync(join(REPO, 'src', file, `index.${ext}`));
              return true;
            } catch {
              return false;
            }
          }
        });
        expect(hit, `${s.id}.where 里的 "${w}" → src/${file}.ts 不存在`).toBe(true);
      }
    }
  });
});

describe('派生视图与真源一致 (别在别处写第二份)', () => {
  it('SEAT_TIER / SEAT_THINKING 覆盖每个座位', () => {
    for (const s of SEATS) {
      expect(SEAT_TIER[s.id]).toBe(s.tier);
      expect(SEAT_THINKING[s.id]).toBe(s.thinking);
    }
  });

  it('SEAT_PREFERRED_COORD 只含显式配了首选的座位', () => {
    for (const s of SEATS) {
      if (s.preferredCoord) expect(SEAT_PREFERRED_COORD[s.id]).toBe(s.preferredCoord);
      else expect(s.id in SEAT_PREFERRED_COORD).toBe(false);
    }
  });

  it('seatSpec / seatSampling 查得到; 未知 id 不炸', () => {
    expect(seatSpec('gate')?.tier).toBe('judge_synth');
    expect(seatSpec('nope')).toBeUndefined();
    expect(seatSampling('nope')).toEqual({});
  });
});

describe('★ 三层旋钮的分工没有被违反', () => {
  it('登记表只写**意图**, 不假设某个模型收不收得下 —— 夹在 transport 层', () => {
    // 同一个 xhigh 意图, 落到三个模型上应当解出三个不同的字面量。
    // 这条断言是"分工"本身的可证伪形式: 若哪天有人把模型能力写回 seats.ts, 它会失去意义。
    expect(reasoningEffortFor('deepseek', 'xhigh', 'deepseek-v4-flash')).toBe('max');
    expect(reasoningEffortFor('mimo', 'xhigh', 'mimo-v2.5-pro')).toBe('high');
    expect(reasoningEffortFor('opencode-go', 'xhigh', 'qwen3.7-plus')).toBe('high');
  });

  it('座位的采样意图会被 model-caps 按模型夹 (codex 拒 temperature)', () => {
    // verifier 座位想要低温稳定, 但它坐在 codex 上时那个参数发不出去 —— caps 说了算。
    expect(seatSampling('verifier').temperature).toBeDefined();
    expect(capsFor('gpt-5.6-sol')?.rejects).toContain('temperature');
  });
});

describe('角色分工 (这一版的分类学)', () => {
  it('★ 闸与择优是两个座位 —— 判"达成没有" ≠ 判"哪个更好"', () => {
    const gate = seatSpec('gate')!;
    const judge = seatSpec('judge')!;
    expect(gate.id).not.toBe(judge.id);
    // 闸要稳定可复现 → 必须给个低温; 没给就是把裁决交给了 provider 的默认随机性。
    expect(gate.sampling.temperature).toBeDefined();
    expect(gate.sampling.temperature!).toBeLessThanOrEqual(judge.sampling.temperature ?? 1);
  });

  it('★ 需要跨家族对抗的座位标了 required (INV-3 的可读形式)', () => {
    expect(seatSpec('verifier')!.crossFamily).toBe('required');
    // 执行/蒸馏类与家族无关 —— 标 required 只会制造假约束。
    expect(seatSpec('leaf')!.crossFamily).toBe('no');
    expect(seatSpec('distill')!.crossFamily).toBe('no');
  });
});
