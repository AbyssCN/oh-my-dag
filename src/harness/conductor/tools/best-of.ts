/**
 * src/harness/conductor/tools/best-of —— `best_of` 卡:n 个竞争尝试,验收命令打分。
 * 契约 S1 change note:「n[2..8] / goal / brief / mode?;无 scorer(判据不可执行)时 compile
 * 返回 ok:false」。
 *
 * review-fix (P1②,2026-09-02): 上一版编译成 N 个互不依赖、无写集的 agent 兄弟,三处坏:
 * ① 没有 write_set → `serializeWriteRaces`(static-lint.ts:531)找不到重叠,N 个 attempt
 *    在同一 worktree 并发改同一批文件 —— 是真竞争,不是"候选独立跑"。
 * ② 没有任何选择步骤 —— `short` 却写 "the engine keeps the best",是假承诺。
 * ③ `mode` 进了 schema,从未被 `compile()` 读,是一个死旋钮。
 *
 * 引擎今天没有"每个候选独立 worktree 起跑"的原语 —— `primitive-registry` 的
 * judge/tournament 走纯文本 `ctx.leaf`(engine.ts:3842 起, 无写文件工具),接不上
 * `ctx.acceptance` 这种要跑 shell 命令、要真文件改动的判据。造一个是新原语,越出 S1
 * 的编译期范围(与 map 的 `until:'no-new'` 同一类"今天没有引擎支持"的诚实拒绝理由)。
 * 改法收在 S1 能动的地方,只用既有机制:
 * · `write_set` 改为必填(与 spawn 的 `task.write_set` 同款字段;这里全部 attempt 本来就是
 *   同一个 goal 的竞争稿,天然该声明**同一批**文件)。
 * · 直接在 compile 期把 N 个 attempt 串成链(`attempt-i` `depends_on` `attempt-(i-1)`)——
 *   不指望 `serializeWriteRaces` 事后补边(那是 executePlan 入口的兜底,这里既然已经知道
 *   写集全重叠,直接声明式排定顺序更直接、可读)。
 * · 第 2..N 个 attempt 的 goal 前置一句机械判据:先跑 `ctx.acceptance.command`,已经是
 *   `expect_exit` 就什么都不碰(上一稿已经赢了 —— 这是 "engine keeps the best" 唯一站得住
 *   的落地形态:后面的攻击性尝试对已经绿的状态是只读的);没过就先用 `git checkout --` 把
 *   `write_set` 复原到这次尝试开始前的状态,再换一个不同的路子试。
 * · 删 `mode`:两个枚举值的差别建立在"能对多个通过的候选评分排出高下"上,而这里的判据是
 *   单条命令的退出码(二值:过/不过),没有分数可排 —— `best-score` 与 `first-green` 在这
 *   个打分模型下会退化成同一件事,留着是死旋钮(与仓规反死旋钮同理由,map 的 `until` 已经
 *   有一次先例)。
 */
import { z } from 'zod';
import type { ConductorPlan } from '../../conductor-plan';
import { renderManual } from '../render-manual';
import type { CompileResult, ConductorCtx, ConductorTool } from '../types';

const BestOfSchema = z
  .object({
    n: z.number().int().min(2).max(8),
    goal: z.string().min(1),
    brief: z.string().min(40),
    /** 全部 attempt 共享同一批目标文件(同一个 goal 的竞争稿)—— 让写集闸能看见重叠。 */
    write_set: z.array(z.string()).min(1),
    /** review-fix (P2⑤,2026-09-02):见 tools/work.ts 同名字段注释。 */
    help: z.boolean().optional(),
  })
  .strict();

type BestOfParams = z.infer<typeof BestOfSchema>;

const SHORT =
  'n sequential attempts on the same write_set, chained so they never race. Each later attempt runs the acceptance command first: already passing → zero changes; still failing → git-checkout the write_set and try a different approach. Worst case n full loops.';

export const bestOfTool: ConductorTool<BestOfParams> = {
  name: 'best_of',
  short: SHORT,
  schema: BestOfSchema,
  manual: () => renderManual('best_of'),
  compile(params: BestOfParams, ctx: ConductorCtx): CompileResult {
    if (!ctx.acceptance) {
      return {
        ok: false,
        error:
          'best_of 需要一条可执行判据(冻结的验收命令)给候选打分 —— 这次 run 没有,选出来的只会是模型的偏好,' +
          '引擎拒绝在没有 scorer 的情况下跑 best_of。',
        manual: renderManual('best_of'),
      };
    }
    const { command, expect_exit } = ctx.acceptance;
    const paths = params.write_set.map((p) => `'${p}'`).join(' ');
    const nodes: ConductorPlan['nodes'] = {};
    let prevId: string | undefined;
    for (let i = 0; i < params.n; i++) {
      const id = `attempt-${i + 1}`;
      const guard = prevId
        ? `Before changing anything, run: \`${command}\`. If it already exits ${expect_exit}, a previous attempt ` +
          `already won — make ZERO changes and stop. Otherwise run \`git checkout -- ${paths}\` to discard the ` +
          `previous attempt's changes, then try a DIFFERENT approach than any sibling for:\n\n`
        : '';
      nodes[id] = {
        executor: 'agent',
        goal: `${guard}${params.goal}\n\n${params.brief}\n\n(attempt ${i + 1} of ${params.n})`,
        write_set: params.write_set,
        ...(prevId ? { depends_on: [prevId] } : {}),
        self_check: { command, expect_exit },
      };
      prevId = id;
    }
    return { ok: true, plan: { name: 'conductor-best-of', nodes } };
  },
};
