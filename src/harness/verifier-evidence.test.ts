/**
 * verifier 的**证据面**闸 (2026-08-01, 校准量出来的)。
 *
 * 这道闸的判词是「默认怀疑, 证据不足时判不通过」—— 那么"喂给它什么"就直接决定判得准不准。
 * 六条 fixture 的校准里, 它唯一一条判错的(真做到了却判不过)判词逐字写着:
 * **「未展示所执行的具体命令与退出码」**。而这两样引擎手里都有:
 * `plan.nodes[id].command`(规划期定死的命令串) 与 `LeafResult.exitCode`(内核给的退出码) ——
 * 只是 `summarizeResults` 没递给它。
 *
 * command 节点的全部价值就是它是**确定性 oracle**。把命令与退出码藏起来, 等于请一个怀疑者来审,
 * 却把唯一不需要信任的证据扣下、逼他去信一段自述 —— **假红**由此而来, 而假红的下一步是
 * escalation 重规划, 空转的账就是这么记上的。
 *
 * 判据取**模型真收到的 prompt**(不是只测辅助函数的返回值): 中间少接一段, 上面那条就白立了。
 */
import { describe, expect, test } from 'bun:test';
import { createDefaultVerifier, summarizeResults } from './verifier';
import type { ConductorPlan } from './conductor-plan';
import type { LeafResult } from './dag/engine';

const plan: ConductorPlan = {
  name: 'p',
  nodes: {
    count: { goal: '统计 .ts 文件数', executor: 'command', command: 'ls src/harness/*.ts | wc -l' },
    blocked: { goal: '读凭证 (会被闸拒)', executor: 'command', command: 'cat .env' },
    prose: { goal: '写一段说明', executor: 'leaf' },
  },
};

const leaf = (over: Partial<LeafResult> & { id: string }): LeafResult =>
  ({ status: 'done', kind: 'command', output: '', deps: [], usage: { in: 0, out: 0 }, ...over }) as LeafResult;

const results: Record<string, LeafResult> = {
  count: leaf({ id: 'count', output: '93', exitCode: 0 }),
  blocked: leaf({ id: 'blocked', status: 'failed', output: '[blocked secret-file]', exitCode: -1 }),
  prose: leaf({ id: 'prose', kind: 'inproc', output: '一段说明文字。' }),
};

describe('verifier 的证据面: command 节点必须带命令串与退出码', () => {
  test('summarizeResults 给出 `$ 命令` 与 `exit 码`', () => {
    const s = summarizeResults(plan, results);
    expect(s).toContain('$ ls src/harness/*.ts | wc -l');
    expect(s).toContain('exit 0');
    expect(s).toContain('93');
  });

  test('闸拒 (exit < 0) 与普通失败在摘要里分得开 —— 两者的下一步相反', () => {
    const s = summarizeResults(plan, results);
    expect(s).toContain('exit -1');
    expect(s).toContain('闸拒');
    // 对照: 断言没成立 (命令真跑了, 退出 1) 不该被标成闸拒。
    const s2 = summarizeResults(plan, { count: leaf({ id: 'count', status: 'failed', exitCode: 1 }) });
    expect(s2).toContain('exit 1');
    expect(s2).not.toContain('闸拒');
  });

  test('非 command 节点不无端加命令行 (没有的东西别编)', () => {
    const s = summarizeResults(plan, { prose: results.prose! });
    expect(s).not.toContain('$ ');
    expect(s).not.toContain('exit ');
  });

  test('证据真的进了模型收到的 prompt (不是只到辅助函数为止)', async () => {
    let seen = '';
    const verifier = createDefaultVerifier({
      verifierModel: 'fake:m',
      callModelFn: (async (req: { messages: Array<{ content: string }> }) => {
        seen = req.messages.map((m) => m.content).join('\n');
        return { text: '', parsed: { pass: true, reason: 'ok' }, usage: { in: 1, out: 1 } };
      }) as never,
    });
    const v = await verifier({ task: '统计并给出命令输出', plan, results });
    expect(v.pass).toBe(true);
    expect(seen).toContain('$ ls src/harness/*.ts | wc -l');
    expect(seen).toContain('exit 0');
    expect(seen).toContain('exit -1');
  });

  test('每节点截断仍生效 (证据面变宽不等于 prompt 可以爆)', () => {
    const long = 'x'.repeat(5000);
    const s = summarizeResults(plan, { count: leaf({ id: 'count', output: long, exitCode: 0 }) }, 100);
    expect(s).toContain('x'.repeat(100));
    expect(s).not.toContain('x'.repeat(101));
  });
});
