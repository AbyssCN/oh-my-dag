#!/usr/bin/env bun
/**
 * discipline-catalog —— 印一次「CLAUDE.md 的纪律里,哪些有闸、哪些还是散文」
 * (薄 CLI,真源是 `src/harness/gates/discipline-registry.ts`,这里零判断零改动)。
 *
 * 存在的理由不是好看:**「哪些纪律没闸」此前只存在于人脑里** —— 每次想知道都得手工对一遍账。
 * 对账表把它变成可机读之后,这个脚本是它的人读出口(同 `scripts/gate-catalog.ts` 之于闸门表)。
 *
 * 跑法:
 *   bun run scripts/discipline-catalog.ts          # 全表
 *   bun run scripts/discipline-catalog.ts --debt   # 只印还是散文的那些(还账时用)
 */
import { DISCIPLINE_REGISTRY, gatedDisciplines, proseDisciplines } from '../src/harness/gates/discipline-registry';

const debtOnly = process.argv.includes('--debt');

if (!debtOnly) {
  console.log(`# 有闸 (${gatedDisciplines().length} 条)\n`);
  for (const d of gatedDisciplines()) {
    console.log(`- **${d.id}** — ${d.rule}`);
    console.log(`  出处 ${d.source} · 闸 \`${(d.enforcement as { ref: string }).ref}\``);
  }
  console.log('');
}

console.log(`# 还是散文 (${proseDisciplines().length} 条,只许缩不许涨)\n`);
for (const d of proseDisciplines()) {
  console.log(`- **${d.id}** — ${d.rule}`);
  console.log(`  出处 ${d.source}`);
  console.log(`  为什么还没有闸: ${(d.enforcement as { why: string }).why}`);
}
console.log(`\n合计 ${DISCIPLINE_REGISTRY.length} 条。`);
