/**
 * repair-guidance 反向自检:每条 fingerprint 用**历史真原文**验命中(不是编的样本),
 * 实质红样本必须零命中(误注入的指引会把修复轮带偏)。
 */
import { describe, expect, test } from 'bun:test';
import { REPAIR_FINGERPRINTS, collectRepairGuidance } from './repair-guidance';

describe('fingerprint 逐条命中历史真原文', () => {
  // 证伪方式 (当场验过): 把对应 pattern 改成 /永不命中/ → 该条断言红; 恢复后绿。
  const samples: Array<[string, string]> = [
    [
      'git-subcommand-blocked',
      // run 96fc81e2 fail-N0a 原文 (样本 G)
      "[blocked git-write: 'merge-base' ∉ 只读子命令 status/diff/log/show/ls-files/ls-tree/rev-parse/blame/describe/shortlog/cat-file/grep]",
    ],
    ['bun-x-form', 'error: Script not found "x"'],
    ['seat-quota-403', 'kimi-coding:k3 调用返回 403(本计费周期配额耗尽,周期级下线)'],
    ['seat-rate-429', 'provider 返回 429 Too Many Requests(周限 ~7h 复位)'],
    ['agent-ws-1006', 'agent leaf 报 WebSocket closed 1006 Connection ended (42s)'],
    ['empty-artifact-zero-write', '产物闸: filesTouched 空,或声称的产物不在盘上'],
  ];

  for (const [id, sample] of samples) {
    test(`${id} 命中`, () => {
      const hits = collectRepairGuidance(sample);
      expect(hits.length).toBeGreaterThanOrEqual(1);
      expect(hits.some((h) => h.includes(`[修复指引 ${id}]`))).toBe(true);
    });
  }
});

describe('实质红零命中(指引不许污染真代码错的修复轮)', () => {
  const substantive = [
    // tsc 真红 (S6 N5a 原文形态)
    "scripts/omd-s6-e2e-acceptance.ts(60,37): error TS2352: Conversion of type 'Record<string, unknown>'",
    // 测试真红
    '(fail) checkExtractChatBudget > 总候选 > 8',
    // verifier 语义判词
    '验收命令在错样本上没有失败,判据是虚的',
    // 数字巧合: 含 403/429 但无配额语境 —— 窄 pattern 不该咬
    '本轮共处理 403 条记录,其中 429 条候选被合并',
  ];
  for (const s of substantive) {
    test(`零命中: ${s.slice(0, 30)}…`, () => {
      expect(collectRepairGuidance(s)).toEqual([]);
    });
  }
});

describe('登记表纪律', () => {
  test('id 唯一', () => {
    const ids = REPAIR_FINGERPRINTS.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('同一证据多段命中同一指纹 → 指引只注入一次(登记序去重)', () => {
    const evidence =
      "[blocked git-write: 'merge-base' ∉ 只读子命令 a] … [blocked git-write: 'push' ∉ 只读子命令 a]";
    const hits = collectRepairGuidance(evidence);
    expect(hits.filter((h) => h.includes('git-subcommand-blocked')).length).toBe(1);
  });
});
