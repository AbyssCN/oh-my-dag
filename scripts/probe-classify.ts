#!/usr/bin/env bun
/**
 * probe-classify —— **D-I 执行型判出率探针** (2026-07-31)。
 *
 * ## 它替谁省钱
 *
 * 「classify 到底判不判得出执行型、给的命令过不过闸」这个问题, 此前只能靠一次完整 live 回答 ——
 * 而一次 live 是 ~1.3M leaf token 和十几分钟。这个问题**只值 1-2 次分类调用**。
 *
 * SDD 未决里那条「分类调用的输出上限太小 → 全保守档 → 验收分型在这条路上基本判不出执行型
 * [待修:抬 maxTokens 并复量]」—— **本脚本就是那个"复量"**。
 *
 * ## 为什么值得单立一个脚本而不是随手 bun -e
 *
 * 这条链已经复发两次, 每次换一个字符: 2026-07-30 是 `$` 锚点, 2026-07-31 是引号里的 `( )`。
 * 后果链逐字相同 —— 命令被闸拒 → 降级探索型 → 任务文本写上"本目标没有机器判据·别伪造" →
 * judge 把**真做完**的活读成捏造执行确认 → 整个 goal 报 failed。
 * 一条会复发的失效需要一个**常备的、便宜的**量法, 而不是每次现写。
 *
 * ## 跑法
 *
 *   bun --env-file=.env run scripts/probe-classify.ts            # 内置几个代表性目标
 *   bun --env-file=.env run scripts/probe-classify.ts --n 3      # 每个目标重复 n 次 (看稳定性)
 *   bun --env-file=.env run scripts/probe-classify.ts --goal "…" # 只问一个
 *
 * ## 判据
 *
 * 每个目标一行: `执行型 ✓` / `执行型但被闸拒 ✗(拒因)` / `探索型`。
 * **`执行型但被闸拒` 是最坏的一格** —— 它说明模型知道该给命令、也给了, 只是踩了闸;
 * 那正是"讲一遍规则"这条路的上限所在。若它反复出现, 该换机制(让分类器把候选命令先过一次
 * `commandBlockReason` 再交出来), 而不是再改一次措辞。
 */
import { acceptanceCommandBlockReason } from '../src/harness/goal/acceptance-gate';
import { classifyGoal } from '../src/harness/goal/classify-acceptance';
import { bootstrapModelRuntime } from '../src/model/bootstrap';
import { send } from '../src/model/gateway';
import { resolveEngineModels } from '../src/mcp/assemble';
import { LIVE_SEED_CASES } from '../src/eval/tasks/live-seed-cases';

const argv = Bun.argv.slice(2);
const arg = (n: string): string | undefined => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const repeats = Number.parseInt(arg('n') ?? '1', 10);

bootstrapModelRuntime();
const models = resolveEngineModels(process.env as Record<string, string | undefined>);
const model = models.conductorModel ?? models.leafModel ?? '';
if (!model) {
  console.error('没有可用的 conductor/leaf 座位 — 先配座位再跑。');
  process.exit(1);
}

/** 代表性目标: 带种用例的 + 三个已知形状(纯文档 / 代码 / 括号陷阱)。 */
const goals: { tag: string; goal: string }[] = arg('goal')
  ? [{ tag: 'custom', goal: arg('goal')! }]
  : [
      ...LIVE_SEED_CASES.map((c) => ({ tag: c.id, goal: c.goal })),
      { tag: 'code-green', goal: '修好 src/util/clamp.ts 里的越界 bug, 让 bun test 全绿。' },
      { tag: 'doc-plain', goal: '在 notes/hello.md 里写一行 "hello omd"。' },
      // 括号陷阱: 断言文本里天然带括号 —— 2026-07-31 live 就是栽在这个形状上。
      { tag: 'paren-trap', goal: '在 docs/formats.md 里写一行 "支持格式: CSV, JSON, Excel (.xlsx)"。' },
    ];

const generate = async (req: Parameters<typeof send>[0]) => {
  const r = await send(req);
  return { text: r.text, usage: r.usage };
};

console.log(`\n座位: ${model} · 每个目标 ×${repeats}\n`);
let exec = 0;
let blocked = 0;
let explor = 0;

for (const { tag, goal } of goals) {
  for (let i = 0; i < repeats; i++) {
    const c = await classifyGoal(goal, { generate: generate as never, model });
    if (c.acceptance.kind === 'executable') {
      // 双保险: 归一化那一层已经过了闸, 这里再验一次 —— 若两处不一致说明闸漂了。
      const why = acceptanceCommandBlockReason(c.acceptance.command);
      exec++;
      console.log(`  ${tag.padEnd(18)} 执行型 ✓  ${why ? `⚠ 二次校验却被拒: ${why}` : ''}`);
      console.log(`  ${''.padEnd(18)}   \`${c.acceptance.command}\``);
    } else {
      // `fallbackExploratory` 把降级原因原样写进学习目标 —— 那是分辨"老实选的探索型"与
      // "想判执行型却被闸拒"的唯一凭据 (同 `firstBlockedReason` 的判据)。
      // F2: 加第三格之后 else 支不再恒等于探索型 —— rubric 没有 learningGoal。
      const lg = c.acceptance.kind === 'exploratory' ? c.acceptance.learningGoal : '';
      const m = /执行型但命令不可跑 — (\[blocked[^\]]*\])/.exec(lg);
      if (m) {
        blocked++;
        console.log(`  ${tag.padEnd(18)} **执行型但被闸拒 ✗** ${m[1]}`);
      } else {
        explor++;
        console.log(`  ${tag.padEnd(18)} 探索型 (模型自己选的, 不是失误)`);
      }
    }
  }
}

const total = exec + blocked + explor;
console.log(`\n── 判出率 (n=${total}) ──`);
console.log(`  执行型 ✓        ${exec}  (${((exec / total) * 100).toFixed(0)}%)`);
console.log(`  执行型但被闸拒 ✗ ${blocked}  (${((blocked / total) * 100).toFixed(0)}%)  ← 最坏的一格`);
console.log(`  探索型           ${explor}  (${((explor / total) * 100).toFixed(0)}%)`);
console.log(
  `\n读法: 被闸拒那格 > 0 说明"讲一遍规则"还没兜住。若它在措辞改过之后仍反复出现,\n` +
    `该换机制(分类器把候选命令先过一次 commandBlockReason 再交出来), 而不是再改一次措辞。\n`,
);
