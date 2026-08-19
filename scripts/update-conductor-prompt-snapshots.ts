/**
 * 重生成 conductor prompt 字节级快照 (#182 H1)。
 *
 * 用法: `bun run scripts/update-conductor-prompt-snapshots.ts`
 *
 * 何时用: 你有意改了 `conductorSystemPrompt` 的字节 (教练 / 环境事实 / schema) 之后, 快照测试
 * (`src/harness/conductor-prompt-snapshot.test.ts`) 会红。**先读红读的是什么** —— 用 git diff 确认
 * 改动正是你想要的, 再跑本脚本重写 golden, 把 golden 一起提交。快照的目的不是拦改动, 是让每一次
 * prompt 字节改动都变成**看得见的一次变更**, 而不是"顺手改了一行没人知道"。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { conductorSystemPrompt } from '../src/harness/conductor-plan';

const DIR = join(import.meta.dir, '..', 'src', 'harness', '__fixtures__', 'conductor-prompt');
// 三档 (full/lean/lean-kb) + bare 基线。full-kb 不必单锁 —— 现有 #171 测试以字节级 replace 钉死
// `full-kb === full + KB 段`, full 又被本快照锁死, full-kb 传递性覆盖。
const PROFILES = ['full', 'lean', 'lean-kb', 'bare'] as const;

mkdirSync(DIR, { recursive: true });
for (const profile of PROFILES) {
  const prompt = conductorSystemPrompt({ profile });
  const file = join(DIR, `${profile}.txt`);
  writeFileSync(file, prompt);
  console.log(`${profile}: ${prompt.length} bytes → ${file}`);
}
