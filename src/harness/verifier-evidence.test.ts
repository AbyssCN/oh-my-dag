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
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

  // ⚠ 2026-08-23 改判 (SDD `2026-08-23-卷面正文保尾-执行契约.md`): 原断言是
  // `toContain('x'.repeat(100))` —— 它拿「有 100 个连续字符」当「预算仍然生效」的代理,
  // 而那个代理只在**头截断**时代成立。正文改成头 + 省略标记 + 尾之后, 100 字节预算被切成
  // 头 30 / 尾 70, 再没有连续 100 个 —— **预算照样生效, 代理却红了**。
  // 换成直接量这件事本身: 正文里 `x` 的**总数** = 预算, 且中间那段确实被省掉了。
  test('每节点截断仍生效 (证据面变宽不等于 prompt 可以爆)', () => {
    const long = 'x'.repeat(5000);
    const s = summarizeResults(plan, { count: leaf({ id: 'count', output: long, exitCode: 0 }) }, 100);
    // ⚠ 别数整串里的 `x` —— 卷面别处也有 (`expect_exit` 两个、`exit 0` 一个, 实测多出 3)。
    // 只数正文那两段连续的 `x`。
    const runs = s.match(/x{5,}/g) ?? [];
    expect(runs.length).toBe(2); // 头一段 + 尾一段
    expect(runs.join('').length).toBe(100); // 头 + 尾 = 预算, 一字节不涨
    expect(s).toContain('中间省略 4900 字节');
  });
});

/**
 * S-33 终审产物面三态闸 —— GREEN (SDD `docs/plan/2026-08-13-在-home-nick-repos-oh-my-dag-仓里还四笔已定性的欠账-四笔互相独立-可.md` 第3笔, 落地 2026-08-14)。
 *
 * `summarizeResults` 第三形参收窄成 `string | number`: 传 string = `artifactRoot` (S-33 产物三态判据的解析根,
 * 省略 = 不判, 卷面逐字节同旧); 传 number = 老 `maxPerNode` (向后兼容, 见上一个 describe 的截断用例)。
 * 每个声明了 `output_path` 的节点跑一次 `statSync` 核盘上真实状态, 三态互斥穷尽写入
 * `artifact: <path> [<state>]`:
 *   registered   声明了 (`output_path`) 且盘上真有 且 `filesTouched` 登记了
 *   unregistered 声明了 且盘上真有 但 `filesTouched` 没登记 —— 单独标出 + 卷面附带告警 (节点上报链缺陷)
 *   missing      声明了 但盘上没有 —— 且这条节点本身 `status: 'failed'`, 钉「具体缺失路径不能被
 *                失败节点写死的 `(failed)` 正文抹掉」(那条正文原样不动, 见 verifier.ts:107)
 */
describe('S-33 终审产物面三态闸', () => {
  const artifactRoot = mkdtempSync(join(tmpdir(), 's33-'));
  writeFileSync(join(artifactRoot, 'reg.txt'), 'registered fixture');
  writeFileSync(join(artifactRoot, 'unreg.txt'), 'unregistered fixture');
  // miss.txt 故意不建 (missing 态)。

  const s33Plan: ConductorPlan = {
    name: 's33',
    nodes: {
      reg: { goal: '登记且真写', executor: 'leaf', output_path: 'reg.txt' },
      unreg: { goal: '真写但没登记进 filesTouched', executor: 'leaf', output_path: 'unreg.txt' },
      miss: { goal: '声明了但没写, 节点本身也失败', executor: 'leaf', output_path: 'miss.txt' },
    },
  };

  const s33Results: Record<string, LeafResult> = {
    reg: leaf({ id: 'reg', status: 'done', filesTouched: ['reg.txt'] }),
    unreg: leaf({ id: 'unreg', status: 'done', filesTouched: [] }),
    miss: leaf({ id: 'miss', status: 'failed', filesTouched: [] }),
  };

  test('★ S-33 盘上存在但未登记是 unregistered，不是 missing', () => {
    const s = summarizeResults(s33Plan, s33Results, artifactRoot);
    expect(s).toContain('artifact: unreg.txt [unregistered]');
    expect(s).not.toContain('artifact: unreg.txt [missing]');
  });

  test('★ S-33 registered / unregistered / missing 三态互斥且穷尽', () => {
    const s = summarizeResults(s33Plan, s33Results, artifactRoot);
    const rows = [...s.matchAll(/artifact: (\S+) \[(\w+)\]/g)].map((m) => ({ path: m[1], state: m[2] }));
    expect(rows).toEqual([
      { path: 'reg.txt', state: 'registered' },
      { path: 'unreg.txt', state: 'unregistered' },
      { path: 'miss.txt', state: 'missing' },
    ]);
    // 失败节点的正文仍写死 `(failed)` (S-33 不动那条, verifier.ts:107) —— 但产物三态是独立维度,
    // `miss.txt` 的具体缺失路径不许被这句抹掉/吞掉。
    expect(s).toContain('(failed)');
    expect(s).toContain('artifact: miss.txt [missing]');
  });

  test('★ S-33 三态真的进入模型收到的终审 prompt', async () => {
    let seen = '';
    const verifier = createDefaultVerifier({
      verifierModel: 'fake:m',
      callModelFn: (async (req: { messages: Array<{ content: string }> }) => {
        seen = req.messages.map((m) => m.content).join('\n');
        return { text: '', parsed: { pass: true, reason: 'ok' }, usage: { in: 1, out: 1 } };
      }) as never,
    });
    const v = await verifier({ task: '核验三态产物', plan: s33Plan, results: s33Results, artifactRoot });
    expect(v.pass).toBe(true);
    expect(seen).toContain('artifact: reg.txt [registered]');
    expect(seen).toContain('artifact: unreg.txt [unregistered]');
    expect(seen).toContain('artifact: miss.txt [missing]');
  });
});
