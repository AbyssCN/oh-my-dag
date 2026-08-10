/**
 * pi 式分支摘要的闸(台账 `docs/bars/pi-agent-core-模块台账.md` §1.3 / C11)。
 *
 * ## 每条钉的都是"往同一份文件里追加分支节点"这件事**会静默错**的地方
 *
 * - **摘要节点挂在谁下面** —— 挂错就是挂在被放弃那条分支的尾巴上,而它要交代的正是那条分支。
 *   投影一样有内容、`tsc` 干净、也不报错,只有下一轮模型读到的历史是错的;
 * - **旧分支的消息一条都不许丢** —— C11 的全部意思就是"不复制会话、原消息不动";
 * - **摘要失败不许导航** —— 移了 lane 又没摘要 = 那条分支被放弃且没有任何交代(S-1 那一族);
 * - **没有可摘要的东西时不花模型调用**,也不落一条空摘要节点(NULL ≠ 0 ≠ 不适用);
 * - **模型真看得到它** —— 落进文件不等于进上下文,`convertToLlm` 那一跳要有人量。
 *
 * ## 逐条证伪方式(都实跑过,见每条里的注)
 *
 * 用注入的 `callModelFn` 而不是注册假 provider:理由与 `compaction.test.ts` 头注同一条
 * (provider 注册表是跨测试文件共享的可变全局,靠它做隔离单文件绿、全量红)。
 * 账本那条边由「默认值钉」守着 —— `planBranchNavigation` 不传 `callModelFn` 时必须是真
 * `callModel`,而 `emitModelUsage` 挂在它出口上。
 */
import { BRANCH_SUMMARY_PREFIX, type AgentMessage, convertToLlm } from '@earendil-works/pi-agent-core';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { callModel } from '../../model';
import { branchSummaryMessage, entryKind, entryPreview, planBranchNavigation } from './branch-summary';
import { type OmdSession, type OmdSessionStore, createOmdSessionStore, resetSessionCacheForTest } from './session-store';

const MODEL = 'deepseek:deepseek-v4-flash'; // pi 内置目录离线可解

let root: string;
let store: OmdSessionStore;
let calls: { system: string; user: string }[] = [];

const msg = (role: 'user' | 'assistant', text: string): AgentMessage =>
  ({ role, content: [{ type: 'text', text }], timestamp: 1 }) as unknown as AgentMessage;

/** 假的摘要调用:记下收到的两段提示词,回一份固定摘要。 */
const fakeCallModel = (async (req: { messages: { role: string; content: string }[] }) => {
  calls.push({
    system: req.messages.find((m) => m.role === 'system')?.content ?? '',
    user: req.messages.find((m) => m.role === 'user')?.content ?? '',
  });
  return { text: '## Goal\n试了一条别的路子\n## Next Steps\n(none)', usage: { in: 10, out: 5 }, raw: {}, model: 'fake:branch', attempts: 1 };
}) as unknown as typeof callModel;

/** 塌掉的摘要调用 —— 「失败不导航」那条要靠它。 */
const throwingCallModel = (async () => {
  throw new Error('provider said no');
}) as unknown as typeof callModel;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'omd-branch-summary-'));
  resetSessionCacheForTest(); // 单写者表是模块级的 —— 不清会把上一条临时目录的实例带进来
  store = createOmdSessionStore(root);
  calls = [];
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/**
 * 造一条四消息的会话,返回会话与**第二条**(user/assistant 各一轮之后)的条目 id。
 * 那个 id 就是"回到这里重走"的目标节点。
 */
const seed = async (): Promise<{ s: OmdSession; forkPoint: string }> => {
  const s = await store.create('t', 'tree');
  await s.append(msg('user', '第一问'));
  await s.append(msg('assistant', '第一答'));
  await s.append(msg('user', '第二问 —— 这一段要被放弃'));
  await s.append(msg('assistant', '第二答 —— 这一段要被放弃'));
  const all = await s.allEntries();
  return { s, forkPoint: all[1]!.id };
};

/** 走完一次完整导航(算 + 写),回执带摘要计划。 */
const navigate = async (s: OmdSession, targetId: string, call = fakeCallModel) => {
  const plan = await planBranchNavigation({ session: s.tree, targetId, model: MODEL, callModelFn: call });
  if (plan.ok && plan.value.entry) await s.navigateTo(targetId, plan.value.entry);
  else if (plan.ok) await s.navigateTo(targetId);
  return plan;
};

describe('★ 分支摘要 = 往同一份文件里追加一条节点(C11)', () => {
  test('★ 摘要节点挂在**目标节点**下面, 不是挂在被放弃那条分支的尾巴上', async () => {
    // ⚠ 这一条钉的是 `navigateTo` 里 moveLane → appendEntry 的**顺序**。
    //   反向自检(实跑): 把 session-store 里那两句对调 → 当场红, 摘要的 parentId 变成旧叶。
    //   两种写法都不报错、投影也都"有内容" —— 只有这条断言看得出挂错了。
    const { s, forkPoint } = await seed();
    const plan = await navigate(s, forkPoint);
    expect(plan.ok).toBe(true);
    const summaryEntry = (await s.allEntries()).find((e) => e.type === 'branch_summary');
    expect(summaryEntry?.parentId).toBe(forkPoint);
  });

  test('★ 旧分支的消息一条都没删 —— 它们仍在同一份文件里(这就是"不复制会话")', async () => {
    const { s, forkPoint } = await seed();
    await navigate(s, forkPoint);
    // 全表(整棵树)仍有四条 message 条目 + 新增那条摘要。
    const all = await s.allEntries();
    expect(all.filter((e) => e.type === 'message')).toHaveLength(4);
    expect(JSON.stringify(all)).toContain('第二答 —— 这一段要被放弃');
    // 而**当前分支**的投影里那两条不见了 —— 反向自检: 不 moveLane 只 append → 这句红。
    const now = await s.messages();
    expect(JSON.stringify(now)).not.toContain('第二问');
    expect(JSON.stringify(now)).toContain('第一答');
  });

  test('★ 新分支的起点就是那条 [branch summary], 且**模型真看得到它**', async () => {
    // 落进文件 ≠ 进上下文。这一条量的是 `buildSessionContext` → `convertToLlm` 那两跳:
    // 反向自检(实跑): 把 branch_summary 条目改写成 `custom` 类型 → 投影直接丢掉它, 两句都红。
    const { s, forkPoint } = await seed();
    await navigate(s, forkPoint);
    const now = await s.messages();
    expect(now.at(-1)).toMatchObject({ role: 'branchSummary' });
    const llm = JSON.stringify(convertToLlm(now));
    expect(llm).toContain(BRANCH_SUMMARY_PREFIX.trim().split('\n')[0] as string);
    expect(llm).toContain('试了一条别的路子');
  });

  test('摘要器收到的是**被放弃那一段**, 不是整条会话', async () => {
    const { s, forkPoint } = await seed();
    await navigate(s, forkPoint);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.user).toContain('第二问');
    // 反向自检: 把 collectEntriesForBranchSummary 换成 findEntriesOnBranch(全量)→ 这句红。
    expect(calls[0]?.user).not.toContain('第一问');
    // 段名逐字英文(照 pi 的 BRANCH_SUMMARY_PROMPT), 且**没有** ## Critical Context 段。
    expect(calls[0]?.user).toContain('## Key Decisions');
    expect(calls[0]?.user).not.toContain('## Critical Context');
  });
});

describe('★ 两侧都要写:失败与"没什么可摘要的"各是什么行为', () => {
  test('★ 摘要失败 → **不导航**(lane 一步都不动), 判词带 pi 的错误码', async () => {
    // ⚠ 这一条量的是 `planBranchNavigation` **自己不写**(它拿不到写口, 所以是结构保证);
    //   "调用方失败时也不该写"那一半量在 `backend-embedded.test.ts` 的同名闸上 ——
    //   反向自检也在那边(把 ok 判断去掉、失败也照样 navigateTo → 当场红)。
    //   两半分开写是因为它们**能各自单独错**:这边返错但顺手写了, 那边收到错但照样切。
    const { s, forkPoint } = await seed();
    const before = await s.leafId();
    const plan = await planBranchNavigation({ session: s.tree, targetId: forkPoint, model: MODEL, callModelFn: throwingCallModel });
    expect(plan.ok).toBe(false);
    if (!plan.ok) {
      expect(plan.error.code).toBe('summarization_failed');
      expect(plan.error.message).toContain('provider said no');
    }
    expect(await s.leafId()).toBe(before); // 没动
    expect((await s.allEntries()).some((e) => e.type === 'branch_summary')).toBe(false);
  });

  test('★ 目标就是当前叶 → 零模型调用、不落空摘要节点("没有"不是"空的")', async () => {
    const { s } = await seed();
    const leaf = (await s.leafId()) as string;
    const plan = await planBranchNavigation({ session: s.tree, targetId: leaf, model: MODEL, callModelFn: fakeCallModel });
    expect(plan.ok && plan.value.entry).toBeNull();
    expect(plan.ok && plan.value.abandoned).toBe(0);
    /**
     * 反向自检(**实跑,而且第一版跑错了**):把 `prep.messages.length === 0` 那条早退去掉
     * → 这句当场红(白花一次模型调用, 还落一条空节点)。
     *
     * ⚠ 第一版这条注释写的是"把 `entries.length === 0` 那条早退去掉 → 红"。**去掉之后
     * 10 条全绿** —— 那条分支是死的(空 entries 喂给 `prepareBranchEntries` 本来就产出空
     * messages)。真判据是**下面这条**。删掉的死分支见 `branch-summary.ts` 里那段注。
     */
    expect(calls).toHaveLength(0);
  });

  test('分支摘要条目记下了 fromId = 被放弃那条分支的叶', async () => {
    const { s, forkPoint } = await seed();
    const oldLeaf = (await s.leafId()) as string; // 四条消息之后必非 null
    const plan = await navigate(s, forkPoint);
    expect(plan.ok && plan.value.entry?.fromId).toBe(oldLeaf);
    // fromId 是"从哪条分支回来的"—— 丢了它, 树上就再也读不出这条摘要交代的是哪一支。
    const e = (await s.allEntries()).find((x) => x.type === 'branch_summary');
    expect(e && e.type === 'branch_summary' ? e.fromId : null).toBe(oldLeaf);
  });
});

describe('/tree 的取材(纯投影)', () => {
  test('entryKind 把 message 细化到 role —— 树上分不清谁说的就没法选', async () => {
    const { s } = await seed();
    const all = await s.allEntries();
    expect(all.map(entryKind)).toEqual(['message/user', 'message/assistant', 'message/user', 'message/assistant']);
  });

  test('entryPreview 截断用 ASCII 省略号(字形闸只放行量过的字形), 且不越界', async () => {
    const { s } = await seed();
    const long = (await s.allEntries())[0]!;
    expect(entryPreview(long, 6)).toBe('第一问');
    const cut = entryPreview({ ...long, message: { role: 'user', content: [{ type: 'text', text: 'x'.repeat(99) }] } } as never, 10);
    expect(cut).toHaveLength(10);
    expect(cut.endsWith('...')).toBe(true);
  });

  test('branchSummaryMessage 用 pi 的构造器 —— 与投影产出的**同一个形状**', async () => {
    // 反向自检: 手拼一个 `{role:'user', content:[...]}` 顶替它 → 这条红(role 对不上),
    // 而"两处形状漂开"正是 §1.4 为压缩摘要付过的那笔账。
    const { s, forkPoint } = await seed();
    await navigate(s, forkPoint);
    const entry = (await s.allEntries()).find((e) => e.type === 'branch_summary');
    if (!entry || entry.type !== 'branch_summary') throw new Error('没有 branch_summary 条目');
    const mine = branchSummaryMessage({ summary: entry.summary, fromId: entry.fromId }, entry.timestamp);
    expect((await s.messages()).at(-1)).toEqual(mine as never);
  });
});
