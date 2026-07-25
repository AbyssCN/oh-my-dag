import { describe, expect, test } from 'bun:test';
import { PlanLedger } from './ledger';
import { renderSddDoc, SDD_EXTRA_SECTIONS } from './sdd-template';

// sdd-template 纯渲染契约 (plan-extension 审议座舱 2026-07-25 撤除后, renderSddDoc 由
// eval/tasks 等直接消费; /sdd TUI 命令路径不复存在, 本测试只钉渲染层)。

/** 输出必含的 canonical-plan 增强段标题。 */
const SDD_HEADINGS = [
  '## 测试接缝 (Seams)',
  '## 先红纪律',
  '## Oracle-cmd',
  '## Allowed files / Forbidden files',
  '## Review Gate',
  '## 决策记录 (D-numbers)',
];

describe('sdd-template', () => {
  test('renderSddDoc 在共享骨架后追加全部增强段', () => {
    const doc = renderSddDoc('# 标题\n\n## Contracts (钉不变量, 非全行为)\n');
    expect(doc).toContain('## Contracts');
    for (const h of SDD_HEADINGS) expect(doc).toContain(h);
    // 纪律条文钉住 (不只是标题存在)
    expect(doc).toContain('接缝需 owner 确认后才进实现');
    expect(doc).toContain('红→绿→重构');
    expect(doc).toContain('exit 0 = pass');
    expect(doc).toContain('fleet 越界即违约');
    expect(doc).toContain('owner 终审');
    expect(doc).toContain('上报 owner');
  });

  test('crystallize 共享骨架不背 sdd 增强段 (两路分离)', () => {
    // ledger.crystallize 是共享骨架的唯一产出口; 增强段只由 renderSddDoc 追加。
    const base = new PlanLedger().crystallize('t', '2026-07-19');
    expect(base).toContain('## Contracts');
    for (const h of SDD_HEADINGS) expect(base).not.toContain(h);
    expect(base).not.toContain(SDD_EXTRA_SECTIONS.slice(0, 20));
  });
});
