/**
 * A5 sensor 措辞普查 (2026-08-05) 的行为网 —— 治的是**下游 leaf** 这条通道。
 *
 * 判据不是"这句话对不对", 是 Fowler 那条「为 LLM 消费优化」的真问法:
 * **它的读者拿它做得了什么。**
 *
 * 探针实证的病:fan-in (`requires:'any'`) 场景下, 没过的前驱**照样**进下游的
 * `Predecessor outputs`, 且不带任何标记 —— 下游要么看到一个空标题 (与"产出为空但有效"
 * 不可分), 要么读到那个节点**自报完成的假话**, 而 prompt 末尾正写着
 * "do NOT fabricate ... inputs you were not given"。它无从知道这段正是它没真拿到的。
 */
import { describe, expect, test } from 'bun:test';
import { runExecutorDag, type GenerateFn } from '../../src/harness/executor-dag';
import { makeLlmConvergenceJudge } from '../../src/harness/plan/llm-judge';

const CONDUCTOR = 'mimo:mimo-v2.5-pro';
const LEAF = 'deepseek:deepseek-v4-flash';

/** 跑一张 fan-in 图 (一个前驱过、一个没过), 把下游 leaf 真正吃到的 prompt 抓出来。 */
async function runFanin(bad: Record<string, unknown>, cfg: Record<string, unknown>) {
  const plan = JSON.stringify({
    name: 's',
    nodes: {
      ok: { goal: '成功的上游', executor: 'leaf' },
      bad: { goal: '没过的上游', ...bad },
      down: { goal: '下游综合', executor: 'leaf', depends_on: ['ok', 'bad'], requires: 'any' },
    },
  });
  const prompts: string[] = [];
  const generate: GenerateFn = async ({ model, messages }) => {
    if (model === CONDUCTOR) return { text: plan, usage: { in: 1, out: 1 } };
    const u = messages.find((m) => m.role === 'user');
    prompts.push(typeof u?.content === 'string' ? u.content : JSON.stringify(u?.content));
    return { text: 'OUT', usage: { in: 1, out: 1 } };
  };
  const res = await runExecutorDag('t', { conductorModel: CONDUCTOR, leafModel: LEAF, generate, ...cfg });
  return { res, downPrompt: prompts.find((p) => p.includes('下游综合')) ?? '' };
}

describe('A5 · judge 这条通道: 引擎侧事故不许被读成"你的方案不行"', () => {
  const judgeWith = (parsed: unknown) =>
    makeLlmConvergenceJudge<null>({
      judgeModel: 'x:y',
      task: '目标',
      extract: () => ({ status: 'done', summary: '一段产出' }),
      callModelFn: async () => ({ text: '', parsed, usage: { in: 1, out: 1 } }) as never,
    });

  test('judge 没产出结构化裁决 → 第一句先撇清这是引擎侧事故, 并说"没被判过"', async () => {
    const v = await judgeWith(undefined)(null, 1);
    expect(v.converged).toBe(false); // fail-closed 不变 (零回归)
    expect(v.failureReason).toContain('引擎侧事故');
    expect(v.failureReason).toContain('没有被判过'); // ← 读者最需要知道的那句
    expect(v.failureReason).toContain('原样再交一次'); // ← 它做得了的事
    // 旧文案 "judge 未结构化输出" 报得对但读者做不了事 —— 别退回去
    expect(v.failureReason).not.toBe('judge 未结构化输出');
  });

  test('judge 判未收敛却没给理由 → 不替它编理由, 但要给一条做得了的事', async () => {
    const v = await judgeWith({ converged: false, score: 3 })(null, 1);
    expect(v.failureReason).toContain('没有给出理由'); // 如实说"没说"
    expect(v.failureReason).toContain('不要去猜'); // 而不是让它瞎改
    expect(v.failureReason).toContain('回到目标本身');
    expect(v.failureReason).not.toBe('未达收敛标准'); // 旧兜底: 对, 但读者做不了事
  });

  test('judge 给了理由就原样用 —— 兜底不许盖掉真判词', async () => {
    const v = await judgeWith({ converged: false, score: 3, failureReason: '缺少验收步骤' })(null, 1);
    expect(v.failureReason).toBe('缺少验收步骤');
  });

  test('收敛时不带 failureReason (兜底只管没过的)', async () => {
    const v = await judgeWith({ converged: true, score: 9 })(null, 1);
    expect(v.converged).toBe(true);
    expect(v.failureReason).toBeUndefined();
  });
});

describe('A5 · 没过的前驱进下游 prompt 时必须带可执行告示', () => {
  test('命令断言失败的前驱: 下游认得出它没过, 而不是"产出为空"', async () => {
    const { res, downPrompt } = await runFanin(
      { executor: 'command', command: 'grep -q x f.txt' },
      { commandRunner: async () => ({ text: '', usage: { in: 0, out: 0 }, exitCode: 1 }) },
    );
    expect(res.results['down']!.status).toBe('done'); // fan-in 'any': 下游照跑 (零回归)
    expect(downPrompt).toContain('前驱 bad 未通过');
    expect(downPrompt).toContain('assert-failed'); // P1 的成因在这里有了第二个消费者
  });

  test('★ 最坏那一种: 前驱自报完成的假话不再裸着进下游材料区', async () => {
    const { downPrompt } = await runFanin(
      { executor: 'agent', output_type: 'file', output_path: 'x.md' },
      { agentRunner: async () => ({ text: '我把文件写好了, 内容是三条建议', usage: { in: 1, out: 1 }, filesTouched: [] }) },
    );
    // 假话仍在 (排障要看得见), 但它前面有一句读者用得上的话
    expect(downPrompt).toContain('我把文件写好了');
    expect(downPrompt).toContain('不要把它自报的完成当真');
    // 三条**可执行**的指令, 不是一句状态播报
    expect(downPrompt).toContain('不要引用它');
    expect(downPrompt).toContain('如实写明缺了哪一块');
  });

  test('过了的前驱一个字都不多 —— 正常材料不许被告示污染', async () => {
    const { downPrompt } = await runFanin(
      { executor: 'command', command: 'true' },
      { commandRunner: async () => ({ text: 'OK', usage: { in: 0, out: 0 }, exitCode: 0 }) },
    );
    expect(downPrompt).not.toContain('未通过');
    expect(downPrompt).toContain('OUT'); // 上游材料照旧
  });

  test('告示只活在 prompt 面, 不污染 staleness 锚 (LeafResult.output)', async () => {
    // 两者刻意分开: `depOutputs` 是 inputsOf 算输入面 hash 的锚, 措辞一改就会让全图下游判 stale。
    const { res } = await runFanin(
      { executor: 'command', command: 'grep -q x f.txt' },
      { commandRunner: async () => ({ text: '', usage: { in: 0, out: 0 }, exitCode: 1 }) },
    );
    expect(res.results['bad']!.output).not.toContain('未通过');
    expect(res.results['bad']!.output).not.toContain('不要引用它');
  });
});
