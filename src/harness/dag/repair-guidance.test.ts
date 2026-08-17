/**
 * repair-guidance 反向自检:每条 fingerprint 用**历史真原文**验命中(不是编的样本),
 * 实质红样本必须零命中(误注入的指引会把修复轮带偏)。
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPAIR_FINGERPRINTS, REPAIR_LEDGER_FILE, collectRepairGuidance, loadRepairFingerprints } from './repair-guidance';

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

describe('纠正台账 (.omd/repair-guidance.jsonl)', () => {
  /** 临时根 + 台账内容 → 生效登记表(判据自证式:把台账摆进 mkdtemp 的临时世界跑一遍)。 */
  const withLedger = (content: string | null) => {
    const root = mkdtempSync(join(tmpdir(), 'omd-repair-ledger-'));
    if (content !== null) {
      mkdirSync(join(root, '.omd'), { recursive: true });
      writeFileSync(join(root, REPAIR_LEDGER_FILE), content);
    }
    return loadRepairFingerprints({ root });
  };

  test('台账缺席 → 纯内置零变化', () => {
    expect(withLedger(null).map((f) => f.id)).toEqual(REPAIR_FINGERPRINTS.map((f) => f.id));
  });

  // 证伪方式 (当场验过): 注释掉 loadRepairFingerprints 里的 byId.set(id, …) → 本条红; 恢复后绿。
  test('台账条目生效: 同形失败命中新指引', () => {
    const fps = withLedger(
      JSON.stringify({
        id: 'hashline-stale-loop',
        pattern: 'stale 标签被拒.{0,80}未重新 hashline_read',
        guidance: '被拒后先重 hashline_read 接地, 别在旧行号上继续叠编辑。',
        anchor: 'run 6692b415 验尸 / issue #146 反面样本表',
      }) + '\n',
    );
    const hits = collectRepairGuidance('编辑失败: stale 标签被拒 3 次, 工具序列显示未重新 hashline_read', fps);
    expect(hits.some((h) => h.includes('[修复指引 hashline-stale-loop]'))).toBe(true);
  });

  test('同 id 覆盖内置(不改码修正内置指引)', () => {
    const fps = withLedger(
      JSON.stringify({ id: 'bun-x-form', pattern: 'Script not found "x"', guidance: '覆盖版指引', anchor: 'NOTES 2026-08-17' }) + '\n',
    );
    const hits = collectRepairGuidance('error: Script not found "x"', fps);
    expect(hits).toEqual(['[修复指引 bun-x-form] 覆盖版指引']);
    expect(fps.length).toBe(REPAIR_FINGERPRINTS.length);
  });

  test('坏行拒载不阻断: JSON 坏 / 缺 anchor / regex 坏 → 跳过, 内置完好', () => {
    const fps = withLedger(
      [
        '{ 这不是 JSON',
        JSON.stringify({ id: 'no-anchor', pattern: 'x', guidance: 'y' }),
        JSON.stringify({ id: 'bad-re', pattern: '([', guidance: 'y', anchor: 'z' }),
        '# 注释行照跳',
        '',
      ].join('\n'),
    );
    expect(fps.map((f) => f.id)).toEqual(REPAIR_FINGERPRINTS.map((f) => f.id));
  });
});
