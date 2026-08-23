/**
 * **轮间交接不许静默截断**(#226,2026-08-23)。
 *
 * ## 现场
 *
 * 内环交接原本是裸 `prevReason.slice(0, 1500)` —— 没有告示、没有指针、不写入磁盘。
 * 账本 542 跑实测:模型判词单项 p90 = 1337 · p95 = 1854,**单它就 ≥1500 的占 7.8%**,
 * 而交接 = 判词 + 观察者块。切掉的是判词**尾部**,而判词尾部通常正是「下一步该做什么」。
 *
 * 更尖锐的是第二条:`NOVELTY_COLLAPSE_LINE` 在 `prevReason` **末尾**追加,截断从**头部**切
 * ⇒ 一旦超界就 100% 丢。而它「只进 prompt 不进控制流」,prompt 是它唯一的通道 ——
 * 于是账本记着 `novelty-collapse`(读起来像"提示发过了"),模型一个字没看到。
 *
 * 同一个文件里,`capFanin` 对上游正文守的是 No-silent-caps(写入磁盘 + 指针 + 告示),
 * 交接不守。这几条把两边拉到同一条纪律上。
 *
 * ⚠ 单一变量:保留下来的正文必须与改动前**逐字相同**(仍是前 1500 字符)。本片只加
 * 告示/指针/必达块,不动额度 —— 下面第 2 条就是钉这个的。
 */
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runExecutorDagWithPlan } from '../../src/harness/dag/engine';
import { CheckpointManager } from '../../src/harness/continuity/checkpoint-manager';
import { NOVELTY_COLLAPSE_LINE } from '../../src/harness/pathfinder/proximity';
import type { ConductorPlan } from '../../src/harness/conductor-plan';
import type { ExecutorDagConfig, GenerateFn } from '../../src/harness/dag/types';

let root: string;
let manager: CheckpointManager;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'omd-handoff-'));
  manager = new CheckpointManager(root);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const leafId = (p: string): string => /\[omd leaf: ([^\]]+)\]/.exec(p)?.[1] ?? '';
const SUB = JSON.stringify({ name: 's', nodes: { w: { goal: '干活' } } });
const plan = (maxRounds: number): ConductorPlan =>
  ({ name: 'outer', nodes: { C: { goal: '做完', executor: 'conductor', max_rounds: maxRounds, judge_final: true } } }) as ConductorPlan;

/** 头部可辨认 · 尾部可辨认的判词, 长度精确可控。 */
const HEAD = '判词开头-可辨认';
const TAIL = '判词结尾-下一步该做什么';
function reasonOf(len: number): string {
  const filler = '数'.repeat(Math.max(0, len - HEAD.length - TAIL.length));
  return `${HEAD}${filler}${TAIL}`;
}

/** 跑一遍, 回收每一轮的 conductor 展开 prompt。 */
async function run(reason: string, maxRounds = 2): Promise<string[]> {
  const expands: string[] = [];
  const generate: GenerateFn = async (req) => {
    const text = String(req.messages.find((m) => m.role === 'user')?.content ?? '');
    if (leafId(text)) return { text: 'ok', usage: { in: 1, out: 1 } };
    expands.push(text);
    return { text: SUB, usage: { in: 1, out: 1 } };
  };
  await runExecutorDagWithPlan(plan(maxRounds), {
    conductorModel: 'c:m',
    leafModel: 'l:m',
    agentTemplates: new Map(),
    continuity: { manager, runId: 'handoff-run', repoRoot: root },
    generate,
    judgeSend: (async () => {
      const v = { converged: false, score: 0, failureReason: reason, rejectedNodes: [] };
      return { text: JSON.stringify(v), parsed: v, usage: { in: 1, out: 1 } };
    }) as never,
  } as ExecutorDagConfig);
  return expands;
}

describe('#226 轮间交接:No-silent-caps', () => {
  test('★ 不超界 → 一个字不变, 无告示(零回归)', async () => {
    // 怎么让它红: 把 `body.length <= HANDOFF_CAP_CHARS` 那条早退删掉 → 短交接也挂告示, 这条红。
    const short = reasonOf(200);
    const p = (await run(short))[1]!;
    expect(p).toContain(short);
    expect(p).not.toContain('交接硬上限');
  });

  test('★ 超界 → 带告示 + 全文指针, 且指针指的文件里是**全文**', async () => {
    // 怎么让它红: 恢复成裸 `prevReason.slice(0, 1500)` → 无告示无指针, 这条红。那正是改动前的实装。
    const long = reasonOf(3000);
    const p = (await run(long))[1]!;
    expect(p).toContain('交接硬上限');
    expect(p).toContain('此处只含前 1500');

    const path = /全文在 (\S+\.txt)/.exec(p)?.[1];
    expect(path, '告示里必须有全文指针').toBeTruthy();
    expect(readFileSync(path!, 'utf8')).toContain(TAIL); // 被切掉的尾部在盘上找得回来
  });

  test('★ 保留的正文与改动前逐字相同(单一变量锁:只加告示, 不动额度)', async () => {
    // 怎么让它红: 把 HANDOFF_CAP_CHARS 改成别的数 → 这条红。额度是另一个决定, 不许混进本片。
    const long = reasonOf(3000);
    const p = (await run(long))[1]!;
    expect(p).toContain(long.slice(0, 1500));
    expect(p).not.toContain(TAIL); // 尾部确实不在 prompt 正文里(只在盘上)
  });

  test('★ 必达块不参与截断预算:交接被截断时 novelty 行仍逐字送达', async () => {
    // 这条是 #226 的核心。怎么让它红: 把 renderHandoff 里摘 mustReach 那段删掉 →
    // novelty 行回到 prevReason 末尾、被头切吃掉, 这条红。那正是改动前的行为。
    //
    // 触发条件(hasCollapsed: n ≥ k+1 且最后 k 个增量 ≤0, k=2): 判词逐轮相同 → 簇数恒 1,
    // 第 3 轮末坍塌 → 第 4 轮的 prompt 才带这行。所以 max_rounds 要 4。
    const long = reasonOf(3000);
    const expands = await run(long, 4);
    expect(expands.length).toBeGreaterThanOrEqual(4);
    const last = expands[3]!;
    expect(last).toContain('交接硬上限'); // 前提: 这一轮确实触发了截断
    expect(last).toContain(NOVELTY_COLLAPSE_LINE); // 而必达行照样逐字到了
  });
});
