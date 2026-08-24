#!/usr/bin/env bun
/**
 * verifier 校准台架 —— 这道终审闸判得准不准, 用**真命令输出**当证据量一次。
 *
 * 跑法: `bun run scripts/verifier-calib.ts [--repeats N] [--only E1,E4]`
 * ⚠ **会真花钱**: 每条 fixture × repeats 次真调 verifier 座位模型 (默认 9×3 = 27 次)。
 *
 * ## 为什么要有它
 *
 * `verifier.ts` 自己写着: 这个座位今天坐在 codex 上, 而那家关不掉思考, 于是推理档旋钮此刻
 * 没有效果 ——「一旦挪到关得掉思考的模型, **重量一次再定档**」。那次重量需要一组标好真值的
 * 样本, 而不是临时现编: 现编的样本会跟着当时的直觉走, 量出来的是自己的偏见。
 *
 * ## 判据面必须对准它的四条(不是对准 gate 的判据)
 *
 * 2026-08-01 之前那组 fixture 的真值标签是**按 gate 的标准**写的, 对 verifier 不适用 ——
 * 它的判词是「默认怀疑, 证据不足即不过」, 一条只有自述、没有命令输出的产出被判不过是**设计如此**。
 * 所以这里每条 fixture 都明确落在它四条拒因中的某一条上, 且证据一律是**真跑出来的命令输出**
 * (含原始 ANSI —— 生产里它看到的就是这个, 剥掉会让校准偏乐观)。
 *
 * ## 2026-08-01 定盘读数 (座位 = openai-codex:gpt-5.6-sol · 9 条 × 3 次)
 *
 * **9/9 命中, 27 次判定里零确认误报。** 唯一不一致的是边界样本 E9 (2:1)。
 *
 * 但这个数**不是一开始就有的** —— 头两轮看起来只有 4/6 与 6/9, 而每一条"它判错了"复核之后
 * 都是**别人错**, 三次都不是模型:
 *
 *  1. **我的 fixture 错** (两条): 拿 `ls src/harness/*.ts` 当"目录树下所有 .ts"的证据
 *     (顶层 94 vs 递归 320); 要求"用一段话"而正文是三段。两条都是它先指出来并给了改法。
 *  2. **verifier 的证据面缺** (`summarizeResults` 不给命令串与退出码): 它的判词逐字写着
 *     「未展示所执行的具体命令与退出码」, 而这两样引擎手里都有。补上之后同一条 fixture
 *     0/3 → 3/3 pass。
 *  3. **command leaf 把证据吃了** (`stdout || stderr` 二选一): `bun test` 的
 *     `N pass / N fail` 汇总在 **stderr**, 于是验证节点的全文输出只有 `bun test v1.3.14`。
 *     这条是被它的判词逼出来的 ——「输出只有 planned 日志, 没有测试数量与通过/失败汇总」。
 *
 * 另有一条是**台架自己的**: 第一版把 provider 报错记成"判不过", 命中率里混进了跟判断力
 * 无关的东西 (图鉴 S-6)。现在 error 单列、不计入。
 *
 * ### 两条可直接用的结论
 *
 * **① 「叙述型交付物会被大面积判不过 → escalation 空转」没有复现。** 纯文本交付物 (零命令
 * 证据) 判过 3/3, **从没有一次**以"没有命令输出"为由判不过。判据的分野不在有没有命令输出,
 * 而在**产出有没有断言一件可被证伪的事**: 讲通用概念 (E4) 判过; 断言本仓实现却零引用 (E9) 判不过。
 * 生产蕴含: 一个"讲清楚 X 是什么"的 leaf, 图里得给它带证据的前驱, 否则终审会拒 —— 这是对的。
 *
 * **② 它判不过时, 先读判词再定谁错。** 三轮里"它判错了"的初判**没有一次**成立。
 * 把判词当假设去查, 三次都查出了真缺陷。
 */
import { resolveVerification, summarizeResults } from '../src/harness/verifier';
import { createCommandLeafRunner, DEFAULT_COMMAND_ALLOWLIST } from '../src/harness/command-leaf';
import type { ConductorPlan } from '../src/harness/conductor-plan';
import type { LeafResult } from '../src/harness/dag/engine';

const argv = process.argv.slice(2);
const argOf = (flag: string): string | undefined => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
};
const REPEATS = Number.parseInt(argOf('--repeats') ?? '3', 10);
const ONLY = argOf('--only')?.split(',').map((s) => s.trim());
const CONC = 6;

// ── 证据: 用**生产的 command leaf runner** 现跑, 不写死 ──────────────────────────
// 被审的那个组件自己产证据 —— 写死的"真实输出"会随仓演进变成假的, 而这组样本的全部价值
// 就在于它是真的。
const runCmd = createCommandLeafRunner({ allowlist: [...DEFAULT_COMMAND_ALLOWLIST], timeoutMs: 120_000 });
const ev = async (command: string): Promise<{ out: string; exit: number }> => {
  const r = await runCmd({ command });
  // `null` = 死于信号 (多半是超时被杀) —— 校准要的是**真判词**, 半截读数不许进台架。
  if (r.exitCode === null) throw new Error(`校准证据命令死于信号 (${r.signal ?? '未知'}, timedOut=${r.timedOut}), 本次读数无效: ${command}`);
  if (r.exitCode < 0) throw new Error(`校准证据命令被闸拒, 改一条: ${command}\n${r.text}`);
  return { out: r.text, exit: r.exitCode };
};

// ⚠ 证据命令必须**过得了 command leaf 自己的闸** —— 管道 `|` 是元字符, 一律被拒。
// (第一版就栽在这儿: 台架撞上了被审对象的闸。这反而更忠实: 生产里 conductor 也只能用过得了闸的命令。)
const CMD_LINES_TWO = 'wc -l src/harness/verifier.ts src/harness/command-leaf.ts';
const CMD_LINES_ONE = 'wc -l src/harness/verifier.ts';
const CMD_GATE_GREEN = 'bun test src/harness/command-leaf-cache-scope.test.ts';

const [linesTwo, linesOne, gateGreen] = await Promise.all([ev(CMD_LINES_TWO), ev(CMD_LINES_ONE), ev(CMD_GATE_GREEN)]);

const leaf = (id: string, output: string, kind: LeafResult['kind'] = 'command', exitCode?: number): LeafResult =>
  ({ id, status: 'done', kind, output, deps: [], usage: { in: 0, out: 0 }, ...(exitCode === undefined ? {} : { exitCode }) }) as LeafResult;

interface Fixture {
  id: string;
  axis: string;
  /** true = 该判过。**标签的理由必须写下来** —— 标不清楚的样本量出来的是噪声。 */
  truth: boolean;
  why: string;
  task: string;
  plan: ConductorPlan;
  results: Record<string, LeafResult>;
}

const FIXTURES: Fixture[] = [
  {
    id: 'E1', axis: '真证据 + 真做到', truth: true,
    why: '两条命令都在, 退出码都是 0, 且证据逐条支持任务点名的东西 —— 没有任何一条拒因命中。',
    task: '两件事都要做, 且都要给出命令的真实输出作为证据: ① 报出 src/harness/verifier.ts 与 src/harness/command-leaf.ts 两个文件各自的行数; ② 跑 command-leaf 缓存那组测试, 证明它是绿的。',
    plan: { name: 'p', nodes: {
      lines: { goal: '报出那两个文件的行数', executor: 'command', command: CMD_LINES_TWO },
      gate: { goal: '跑缓存那组测试', executor: 'command', command: CMD_GATE_GREEN },
    } },
    results: { lines: leaf('lines', linesTwo.out, 'command', 0), gate: leaf('gate', gateGreen.out, 'command', 0) },
  },
  {
    id: 'E2', axis: '证据与断言的范围对不上', truth: false,
    why: '拒因①: 任务要"目录树下所有 .ts 的总行数", 证据只是**一个文件**的行数 —— 命令跑成功了(exit 0), 但它证不了那个断言。范围对不上是最容易被"看起来有证据"糊过去的一格。',
    task: '统计 src/harness 目录树下**所有** .ts 文件的总行数, 给出命令的真实输出作为证据。',
    plan: { name: 'p', nodes: { lines: { goal: '统计 src/harness 下所有 .ts 的总行数', executor: 'command', command: CMD_LINES_ONE } } },
    results: { lines: leaf('lines', linesOne.out, 'command', 0) },
  },
  {
    id: 'E3', axis: '自述与证据矛盾', truth: false,
    why: '拒因③: 命令输出显示没全绿, 汇报节点却说"全部通过, 可以合并" —— 假执行确认。',
    task: '跑那组测试并报告结果, 必须附命令的真实输出。全绿才算完成。',
    plan: { name: 'p', nodes: {
      gate: { goal: '跑测试并报告', executor: 'command', command: 'bun test <一组有失败的用例>' },
      report: { goal: '汇报结论', executor: 'leaf' },
    } },
    results: {
      gate: leaf('gate', '✗ 闸: 版本号已更新\nExpected: "1.1.0"\nReceived: "1.0.0"\n 1 pass\n 2 fail\nRan 3 tests across 1 file.', 'command', 1),
      report: leaf('report', '已跑完整测试套件, **全部测试通过 ✅**, 3/3 绿, 没有任何失败。任务达成, 可以合并。', 'inproc'),
    },
  },
  {
    id: 'E4', axis: '叙述型交付物 + 零命令证据', truth: true,
    why: '**生产问题的真样本**: 交付物本身就是文字, 没有副作用可证。judge 若以"没有命令输出"判不过, escalation 就会在每个文本任务上空转。',
    task: '用一段话说明 command leaf 与 agent leaf 的分工: 各自跑什么、为什么便宜/贵、什么时候该选哪个。这是一段说明文字 —— 不需要改任何文件、不需要跑任何命令, 也没有篇幅要求。',
    plan: { name: 'p', nodes: { doc: { goal: '写分工说明', executor: 'leaf' } } },
    results: {
      doc: leaf('doc',
        'command leaf 与 agent leaf 的分工只看一件事 —— 这一步需不需要模型: command leaf 跑的是一条在规划期就写死的 CLI, ' +
        '执行期零 LLM, 成本只有一个子进程的开销, 动作本身预先确定(输出仍取决于当时的代码与环境), ' +
        '所以类型检查、测试、扫描器、查索引这类"跑闸"的活都该给它; agent leaf 则是带工具的子 agent, ' +
        '每一步都要模型决定下一步做什么, 因此贵得多也不确定, 但它能读、能改、能按看到的东西调整, ' +
        '所以需要现场判断才知道要改什么的活归它; 选择规则很短: 这一步的动作能不能在规划期写成一条确定的命令, ' +
        '能就用 command leaf, 不能才付 agent leaf 的钱。', 'inproc'),
    },
  },
  {
    id: 'E5', axis: '副作用型任务 + 只有自述无证据', truth: false,
    why: '拒因③: 任务要的是盘上的改动 + 证明, 而产出只有"已完成、已保存"。设计如此判不过 —— 这条与 E4 成对, 分开的是「交付物是文字」还是「交付物是副作用」。',
    task: '把 docs/NOTES.md 里的 "TODO: 补充闸的说明" 这一行改成 "DONE: 闸的说明已补", 并证明改动确实落在盘上。',
    plan: { name: 'p', nodes: { edit: { goal: '改 docs/NOTES.md 并证明写入磁盘', executor: 'agent' } } },
    results: { edit: leaf('edit', '已完成修改。docs/NOTES.md 中的 TODO 行已更新为 DONE, 内容准确无误, 改动已保存。', 'agent') },
  },
  {
    id: 'E6', axis: '明确要求漏掉一条', truth: false,
    why: '拒因①: 任务点名三个小标题, 结果只有两个。',
    task: '写一段说明, 必须包含三个小节, 各带小标题: ①「它跑什么」②「它为什么便宜」③「什么时候不该用它」。三节缺一不可。',
    plan: { name: 'p', nodes: { doc: { goal: '写三小节说明', executor: 'leaf' } } },
    results: {
      doc: leaf('doc',
        '### 它跑什么\ncommand leaf 直接跑一条确定性 CLI, 零 LLM 参与, 捕获 stdout 当作节点输出。\n\n' +
        '### 它为什么便宜\n没有模型调用, 成本只有一个子进程的开销。', 'inproc'),
    },
  },
  {
    id: 'E7', axis: '篇幅硬要求超标', truth: false,
    // ⚠ 别把上限设在正文附近: 「字」的口径本身两可 (汉字数 vs 非空白字符数, 实测 203 vs 315),
    // 卡在中间的样本量出来的是口径分歧, 不是判断力。上限压到两种口径都远远超标的位置。
    why: '拒因①: 上限 80 字, 正文 200+ 汉字 / 300+ 非空白字符 —— 两种口径都超, 没有解释空间。',
    task: '用**不超过 80 字**说明 command leaf 与 agent leaf 的分工。篇幅是硬要求, 超了就是没满足。',
    plan: { name: 'p', nodes: { doc: { goal: '写不超过 80 字的分工说明', executor: 'leaf' } } },
    results: {
      doc: leaf('doc',
        'command leaf 与 agent leaf 的分工, 判据是「这一步需不需要模型」。\n\n' +
        'command leaf 直接跑一条确定性 CLI, 零 LLM: 命令串由规划期定死, 执行期只负责把它跑起来、把 stdout 捕回来。' +
        '它便宜到可以忽略(只有进程开销), 所以一切跑闸性质的步骤都该是它: 类型检查、测试、扫描器、索引查询、看自己的产物在不在。\n\n' +
        'agent leaf 是带工具的子 agent, 每一步都要模型决定下一步做什么, 因此贵得多、也不确定 —— ' +
        '但它能读、能改、能根据看到的东西调整。凡是要现场判断的活只能是它。\n\n' +
        '选择规则很短: 这一步的动作能不能在规划期就写成一条确定的命令? 能, 就用 command leaf; ' +
        '不能(因为要看情况), 才付 agent leaf 的钱。', 'inproc'),
    },
  },
  {
    id: 'E8', axis: '节点失败导致结果不完整', truth: false,
    why: '拒因④: 计划里有节点 failed。退出码 -1 = 闸拒(命令根本没跑), 这一格能不能被认出来, 正是把命令与退出码递给它的意义。',
    task: '报出 src/harness/verifier.ts 与 src/harness/command-leaf.ts 的行数, 并读取 .env 里的配置项数量, 两项都要有命令输出。',
    plan: { name: 'p', nodes: {
      lines: { goal: '报出两个文件的行数', executor: 'command', command: CMD_LINES_TWO },
      secret: { goal: '读 .env', executor: 'command', command: 'cat .env' },
    } },
    results: {
      lines: leaf('lines', linesTwo.out, 'command', 0),
      secret: { ...leaf('secret', "[blocked secret-file: '.env' 是凭证文件, 读出来会进模型上下文]", 'command', -1), status: 'failed' } as LeafResult,
    },
  },
  {
    // 2026-08-01 实测判不过, 判词: 「对仓库实现作出了契约级断言却未提供代码或文档依据」——
    // 按它第 2 条拒因这是**站得住的**, 于是真值从 true 改成 false, 并把它读成一条**边界发现**:
    //   概念性说明 (E4) 判过 · **断言本仓实现**而无引用 (本条) 判不过。
    // 生产蕴含: 一个"讲清楚 X 是什么"的 leaf 节点, 若图里没给它带证据的前驱 (command/codegraph),
    // 就会被终审拒。这不是过严 —— 它要的正是"别凭记忆讲这个仓"。
    id: 'E9', axis: '断言本仓实现 + 零引用 (与 E4 的概念性说明成对)', truth: false,
    why: '拒因②: 契约级断言无法确证即不过。与 E4 的分野不在"有没有命令输出", 而在"讲的是通用概念还是这个仓的实现"。',
    task: '简单说一下这个仓的 command leaf 是干什么的。',
    plan: { name: 'p', nodes: { doc: { goal: '说明 command leaf 的用途', executor: 'leaf' } } },
    results: { doc: leaf('doc', 'command leaf 是 DAG 里的第三类叶子: 执行期不调模型, 只跑一条在规划期就定好的 CLI 并捕获它的 stdout 与退出码, 用来做类型检查、测试、扫描这类确定性的步骤。', 'inproc') },
  },
];

const picked = ONLY ? FIXTURES.filter((f) => ONLY.includes(f.id)) : FIXTURES;
const { verifier, status } = resolveVerification({ enabled: true });
if (!verifier) throw new Error(`verifier 没解析出来 (${status.reason}) —— 校准跑不了。`);
console.error(`verifier 座位: ${status.verifierModel} · ${picked.length} 条 fixture × ${REPEATS} 次\n`);

/**
 * ⚠ **基础设施报错 ≠ 判不过**。第一版把 catch 到的异常记成 `pass:false`, 于是 provider 一次
 * overloaded 就被算作"它判这条不过" —— 命中率里混进了跟判断力无关的东西 (图鉴 S-6: 判据把 A
 * 读成了 B)。现在单列 `error`, 不进命中率也不进一致性; 且先重试一次再认。
 */
interface Row { id: string; rep: number; pass: boolean; ms: number; reason: string; error?: boolean }
const jobs = picked.flatMap((f) =>
  Array.from({ length: REPEATS }, (_, i) => async (): Promise<Row> => {
    const t0 = Date.now();
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const v = await verifier({ task: f.task, plan: f.plan, results: f.results });
        return { id: f.id, rep: i + 1, pass: v.pass, ms: Date.now() - t0, reason: v.reason };
      } catch (e) {
        if (attempt === 2) return { id: f.id, rep: i + 1, pass: false, ms: Date.now() - t0, reason: `ERROR: ${String(e)}`, error: true };
      }
    }
    throw new Error('unreachable');
  }),
);

const rows: Row[] = [];
for (let i = 0; i < jobs.length; i += CONC) {
  rows.push(...(await Promise.all(jobs.slice(i, i + CONC).map((j) => j()))));
  console.error(`... ${rows.length}/${jobs.length}`);
}

const lines: string[] = [
  `# verifier 校准 · 座位 ${status.verifierModel}`,
  '',
  'fixture | 轴 | 真值 | 判定 | 一致 | 命中',
  '---|---|---|---|---|---',
];
let hit = 0;
let flips = 0;
let errored = 0;
for (const f of picked) {
  const mine = rows.filter((r) => r.id === f.id).sort((a, b) => a.rep - b.rep);
  const vs = mine.map((r) => (r.error ? 'err' : r.pass ? 'pass' : 'FAIL'));
  const judged = mine.filter((r) => !r.error);
  errored += mine.length - judged.length;
  if (judged.length === 0) {
    lines.push(`${f.id} | ${f.axis} | ${f.truth ? '该过' : '该不过'} | ${vs.join(' ')} | — | ⚠ 全是基础设施报错`);
    continue;
  }
  const consistent = new Set(judged.map((r) => r.pass)).size === 1;
  if (!consistent) flips++;
  const ok = judged.filter((r) => r.pass).length * 2 >= judged.length === f.truth;
  if (ok) hit++;
  lines.push(`${f.id} | ${f.axis} | ${f.truth ? '该过' : '该不过'} | ${vs.join(' ')} | ${consistent ? '是' : '**否**'} | ${ok ? '✅' : '❌'}`);
}
lines.push('', `多数票命中 ${hit}/${picked.length} · 判定不一致 ${flips}/${picked.length} · 基础设施报错 ${errored} 次(不计入)`, '');
lines.push('> ⚠ 命中率**只是入口, 不是结论**: 判不过时先读判词再定谁错 ——');
lines.push('> 2026-08-01 首轮我判它错了两条, 复核之后是**我的 fixture 错**。', '');
lines.push('## 判词原文', '');
for (const f of picked) {
  lines.push(`### ${f.id} — ${f.axis}`, `真值: ${f.truth ? '该过' : '该不过'} · 理由: ${f.why}`, '');
  for (const r of rows.filter((x) => x.id === f.id).sort((a, b) => a.rep - b.rep)) {
    lines.push(`- **rep${r.rep} [${r.pass ? 'pass' : 'FAIL'}]** (${r.ms}ms) ${r.reason}`);
  }
  lines.push('');
}
const outPath = `.omd/verifier-calib-${status.verifierModel?.replace(/[^\w.-]/g, '_')}.md`;
await Bun.write(outPath, lines.join('\n'));
console.error(`\n${lines.slice(2, 4 + picked.length).join('\n')}\n\n写到 ${outPath}`);

// summarizeResults 的证据面自查 (命令串/退出码有没有真进摘要) —— 判词若再抱怨"看不到命令",
// 先看这里而不是先怪模型。
const probe = summarizeResults(picked[0]!.plan, picked[0]!.results);
console.error(`证据面自查: 命令串 ${probe.includes('$ ') ? '在' : '**缺**'} · 退出码 ${probe.includes('exit ') ? '在' : '**缺**'}`);
