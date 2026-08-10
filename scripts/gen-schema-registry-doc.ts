/**
 * 人读版「schema 字段 → 消费点」表的**生成器** (2026-07-30)。
 *
 * 表的真源是 `src/harness/schema-field-registry.ts` 的 `REGISTRY` (闸在同名 .test.ts) —— 那里有确定性 oracle
 * 在核每一列 (指纹归属比键, 明示列扫 prompt)。文档手抄一遍就是第二份真相, 早晚漂;
 * 所以这里把它打印成 markdown, 贴进 `docs/plan/2026-07-30-schema-field-registry.md` 的表格段。
 *
 * 跑法: `bun run scripts/gen-schema-registry-doc.ts`
 */
import { REGISTRY } from '../src/harness/schema-field-registry';

const FP: Record<string, string> = {
  fields: '✅ fieldsKey',
  merkle: '⚙ Merkle (经前驱指纹)',
  false: '— 不入',
};

/** 从 REGISTRY 渲染人读版表格 (真源唯一; mcp-schema-registry-regression.test.ts 复用本函数核文档不漂)。 */
export function renderRegistryDoc(): string {
  const rows = Object.entries(REGISTRY).map(([field, e]) => {
    const fp = FP[String(e.fingerprint)]!;
    const note = e.note.replace(/\|/g, '\\|');
    return `| \`${field}\` | ${e.consumer.replace(/\|/g, '\\|')} | ${fp} | ${e.declared ? '✅' : '—'} | ${note} |`;
  });
  return [
    '| 字段 | 引擎消费点 | 进语义指纹 | 进 conductor prompt | 备注 |',
    '|---|---|---|---|---|',
    ...rows,
    `\n<!-- ${rows.length} 个字段; 由 scripts/gen-schema-registry-doc.ts 生成 -->`,
  ].join('\n');
}

if (import.meta.main) console.log(renderRegistryDoc()); // 被回归测试 import 时不打印
