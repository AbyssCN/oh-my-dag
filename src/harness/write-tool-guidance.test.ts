/**
 * 「写文件要用受控写工具」这条**必须出现在执行体每次都读得到的地方**(2026-08-12)。
 *
 * ## 账
 *
 * `shell-writes.ts` 头注记的:「两次真跑两次中招,第一次还连累下游四个复核节点全 skip
 * —— **活是干完了的**」。一次写法选择,放大成半张图报废。
 *
 * ⚠ **别把 2026-08-12 的 run `360405a5` 算进这条的账**(我第一版注释这么写了,是错的):
 * 那次第一轮 `impl-types` 判 `empty-artifact` 之后 conductor 重规划,第二轮五个 impl
 * 节点全绿、代码正常落盘;它真正卡死在 `green-gate.__r1` 撞上**另一个并发 run** 半成品的
 * `tsc` 错。那是多 run 共用一棵树的代价,与本条无关。把它记在这里会让下一个读的人
 * 去修错的东西 —— 归因写错比不写更贵。
 *
 * ## 为什么闸判得没错
 *
 * 产物闸只认**受控写工具**(`write`/`edit`/`hashline`)的 `filesTouched`。经 bash 写的
 * 目标是**推断**出来的(`DagNodeResult.writeCandidates`),而本仓有一条明写的纪律:
 *
 * > `failure-trace.ts:29` —— 与 `writeCandidates` 同一条纪律:节点成败、产物闸、judge 一律不看它。
 *
 * 推断不是事实,多认一个就会把无关文件算进产物。**所以不该改闸去认 bash 写** ——
 * 该让执行体一开始就别那么写。
 *
 * ## 为什么放在工具说明里, 不放 LEAF_HARNESS_CORE
 *
 * `LEAF_HARNESS_CORE` 是**冻结前缀**(harness-prompts.ts 原注:「核有组成钉、改一字
 * 按惯例要走 A/B 读数」),且有 `prompt-prefix-stability` 守着。而这条是**工具用法**
 * 不是方法论 —— 挂在 `bash` 自己的 promptSnippet 上,正好出现在「一个执行体正要调
 * bash」的那一刻,比放进一段每轮都读但读不进去的散文强(本程实证:P-1/P-2 就在
 * always-loaded 的 CLAUDE.md 里,同程仍犯八次)。
 *
 * ## 反向自检
 *
 * 每条注释里写了「怎么让它红」,两条都当场证伪过。
 */
import { describe, expect, test } from 'bun:test';
import { createOmdAgentTools } from './agent-tools';

const tools = createOmdAgentTools({ cwd: process.cwd() });
const snippetOf = (name: string): string =>
  tools.find((t) => t.name === name)?.promptSnippet ?? '';

describe('受控写工具的用法提示', () => {
  test('★ bash 的说明里点名「写文件别走 bash」并说出后果', () => {
    const s = snippetOf('bash');
    expect(s, 'bash 工具不见了?').not.toBe('');
    // 怎么让它红: 把 promptSnippet 改回只写「在工作根跑 shell」→ 两条断言都红。
    expect(s).toContain('write');
    // 后果必须写出来 —— 只说「别用」而不说「会怎样」, 执行体没有理由听
    expect(s).toMatch(/产物闸|filesTouched|看不见/);
  });

  test('★ write/edit 的说明仍在 —— 提示指向的那两个工具得真存在', () => {
    // 怎么让它红: 删掉 write 或 edit 的 promptSnippet → 红。
    // 这条防的是「提示叫人用 X, 而 X 已经没了」那种指向空处的指路牌。
    expect(snippetOf('write')).toContain('write(');
    expect(snippetOf('edit')).toContain('edit(');
  });
});
