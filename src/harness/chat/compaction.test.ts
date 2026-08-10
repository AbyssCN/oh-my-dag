/**
 * chat 会话压缩(TUI SDD §2.0(d),切片 S9)。
 *
 * ## 为什么用注入的 `compactionCallModel` 而不是注册一个假 provider
 *
 * 第一版起了个本地 HTTP 服务器 + `registerProvider('deepseek', 127.0.0.1)`,想让压缩真的走一遍
 * `callModel → HTTP → usage → 账本`。**单文件跑绿、全量跑红**(症状 `pi: Connection error.`):
 * provider 注册表与 pi transport deps 都是**跨测试文件共享的可变全局**,别的文件一 `clearProviders()`
 * 或把 auth 复位成真机的 `~/.pi/agent/auth.json`,这条坐标就走得通真 provider,请求飞去公网。
 *
 * ⇒ 隔离改用**注入**(与既有的 `loopFn` 同一种接缝)。账本那条边则由一条**默认值钉**守着:
 * `compactChatMessages` 不传 `callModelFn` 时必须是真的 `callModel` —— 而 `emitModelUsage`
 * 就挂在它的出口上。把默认值换掉,那条钉当场红。
 */
import { createCompactionSummaryMessage, estimateTokens, type AgentMessage } from '@earendil-works/pi-agent-core';
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { callModel } from '../../model';
import { runChatTurn } from './agent';
import { CHAT_COMPACTION_PROMPT, DEFAULT_COMPACTION_CALL_MODEL, compactChatMessages } from './compaction';
import { type OmdSessionStore, createOmdSessionStore, resetSessionCacheForTest } from './session-store';

const MODEL = 'deepseek:deepseek-v4-flash'; // pi 内置目录离线可解

let root: string;
let store: OmdSessionStore;
let calls: { system: string; user: string }[] = [];

/** 假的摘要调用:记下它收到的两段提示词,回一份固定摘要 + 一份固定用量。 */
const fakeCallModel = (async (req: { messages: { role: string; content: string }[] }) => {
  calls.push({
    system: req.messages.find((m) => m.role === 'system')?.content ?? '',
    user: req.messages.find((m) => m.role === 'user')?.content ?? '',
  });
  return {
    text: '【摘要】用户在问 DAG 进度, 已答两轮。',
    usage: { in: 1234, out: 56 },
    raw: {},
    model: 'fake:compactor',
    attempts: 1,
  };
}) as unknown as typeof callModel;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'omd-chat-compact-'));
  resetSessionCacheForTest(); // 单写者表是模块级的 —— 不清会把上一条临时目录的实例带进来
  store = createOmdSessionStore(root);
  calls = [];
});

/** 造一条已有历史的会话(新层是 append-only: 一条一条写进去, 没有"整份 save")。 */
const seed = async (id: string, ms: AgentMessage[]): Promise<void> => {
  const s = await store.create(id, 't');
  for (const m of ms) await s.append(m);
};
/** 盘上那条会话现在投影出来是什么。 */
const onDisk = async (id: string): Promise<AgentMessage[]> => (await store.open(id))!.messages();

afterEach(() => rmSync(root, { recursive: true, force: true }));

/** fake 循环:复刻 runAgentLoop 语义(返回 prompts+生成,不动 context.messages)。 */
const fakeLoop =
  (seen: { history?: AgentMessage[]; systemPrompt?: string } = {}) =>
  async (prompts: AgentMessage[], context: { messages: AgentMessage[]; systemPrompt: string }) => {
    seen.history = [...context.messages];
    seen.systemPrompt = context.systemPrompt;
    return [...prompts, { role: 'assistant', content: [{ type: 'text', text: '答' }], timestamp: 2, stopReason: 'stop' } as unknown as AgentMessage];
  };

const userMsg = (t: string): AgentMessage => ({ role: 'user', content: t, timestamp: 1 }) as AgentMessage;
const assistantMsg = (t: string): AgentMessage =>
  ({ role: 'assistant', content: [{ type: 'text', text: t }], timestamp: 1, stopReason: 'stop' }) as unknown as AgentMessage;

/** 一段够长、且切得出点的会话:user/assistant 交替。 */
function longSession(rounds: number): AgentMessage[] {
  const out: AgentMessage[] = [];
  for (let i = 0; i < rounds; i++) {
    out.push(userMsg(`第 ${i} 问 ${'补'.repeat(200)}`), assistantMsg(`第 ${i} 答 ${'字'.repeat(200)}`));
  }
  return out;
}

describe('★ 轮前压缩(管跨轮增长)', () => {
  // 反向自检 (2026-08-07 实跑): 把 agent.ts 里那段 `if (wantCompaction && overBudget(...))`
  // 整块注释掉 → 「会话真的瘦了」「账本记到了」「摘要用的是 chat 口径」三条当场红。
  test('超预算的会话在开跑前被压缩, 且**写回磁盘**(否则下一轮全回来, 这次白花钱)', async () => {
    await seed('c1', longSession(12));
    const before = (await onDisk('c1')).length;

    const r = await runChatTurn({
      store, sessionId: 'c1', prompt: '再问一句', model: MODEL, cwd: root,
      // 逼它一定超预算 —— 这条测的是"超了会怎样", 不是"多少算超"。
      // keepRecent 也要调小: 默认 20k 比整段测试会话还大, 于是切点一路退到头 → 压不动。
      contextBudgetRatio: 0.000001, compactionKeepRecentTokens: 300,
      compactionCallModel: fakeCallModel, loopFn: fakeLoop() as never,
    });

    expect(r.compactions).toBeGreaterThan(0);
    const after = await onDisk('c1');
    // 压缩 + 本轮两条新消息之后, 仍必须比原来短 —— 只在内存里压不算数。
    expect(after.length).toBeLessThan(before);
    expect(JSON.stringify(after)).toContain('【摘要】');
  });

  test('★★ 压缩这一轮**发给模型的**与**下一轮载入的**是同一份(两处各拼一次 = S-1 那一族)', async () => {
    // 换存储层之后压缩落成一条 `compaction` 条目, 而条目**投影**回消息时的次序是
    // `[摘要, 首条, ...尾]` —— 与 `compactChatMessages` 自己拼的 `[首条, 摘要, ...尾]` 不同。
    // 于是"发出去的"与"存下来的"很容易变成两份:两边都有内容、都不报错, 只是不是同一份。
    // 证伪 (实跑): 把 agent.ts 里 `messages = await existing.messages()` 换成
    // `messages = compacted.messages` → 这条当场红 (第二轮开头是首条而不是摘要)。
    await seed('c3', longSession(12));
    const turn1: { history?: AgentMessage[] } = {};
    const r1 = await runChatTurn({
      store, sessionId: 'c3', prompt: '第一问', model: MODEL, cwd: root,
      contextBudgetRatio: 0.000001, compactionKeepRecentTokens: 300,
      compactionCallModel: fakeCallModel, loopFn: fakeLoop(turn1) as never,
    });
    expect(r1.compactions).toBeGreaterThan(0);

    const turn2: { history?: AgentMessage[] } = {};
    // 第二轮不许再压 (ratio=0), 否则量到的就不是"载入了什么"。
    await runChatTurn({
      store, sessionId: 'c3', prompt: '第二问', model: MODEL, cwd: root,
      contextBudgetRatio: 0, loopFn: fakeLoop(turn2) as never,
    });
    // 第二轮载入的 = 第一轮发出去的 + 第一轮新增的那两条。逐字比。
    expect(JSON.stringify(turn2.history)).toBe(JSON.stringify([...(turn1.history ?? []), ...r1.newMessages]));
  });

  test('★ 摘要用的是 **chat 口径**, 不是叶子那套"改了哪些文件"', async () => {
    await seed('c2', longSession(12));
    await runChatTurn({
      store, sessionId: 'c2', prompt: 'x', model: MODEL, cwd: root,
      contextBudgetRatio: 0.000001, compactionKeepRecentTokens: 300, compactionCallModel: fakeCallModel, loopFn: fakeLoop() as never,
    });
    const req = calls[0] as { system: string; user: string };
    expect(req.system).toContain('不要继续这段对话');
    expect(req.user).toContain('人与 conductor 的对话');
    expect(req.user).not.toContain('执行叶子');
  });

  test('★ 默认走的是真 callModel —— 账本(emitModelUsage)就挂在它出口上', () => {
    // 这条替代了"起个假服务器验账本"的写法(见文件头): 那种写法在全量跑里会被别的文件
    // 改掉的全局 provider 注册表打穿。真正要守的不变量只有一句 ——
    // **压缩这次调用不许绕开 callModel**, 绕开了这次花的钱就不在账上。
    expect(DEFAULT_COMPACTION_CALL_MODEL).toBe(callModel);
  });

  test('不传 callModelFn 时, compactChatMessages 用的就是那个默认值(不是自己另起一条路)', async () => {
    // 消息太少 → 切不出点 → 在发出任何模型调用**之前**就返回 null。
    // 于是这条既不碰网络, 又能证明"没有第二条隐藏的调用路径"。
    expect(await compactChatMessages({ messages: [], model: 'x:y' })).toBeNull();
  });

  test('★ system prompt 未受影响 —— 压缩只动 messages', async () => {
    await seed('c4', []);
    const seenShort: { systemPrompt?: string } = {};
    await runChatTurn({ store, sessionId: 'c4', prompt: 'x', model: MODEL, cwd: root, compactionCallModel: fakeCallModel, loopFn: fakeLoop(seenShort) as never });

    await seed('c5', longSession(12));
    const seenLong: { systemPrompt?: string } = {};
    await runChatTurn({
      store, sessionId: 'c5', prompt: 'x', model: MODEL, cwd: root,
      contextBudgetRatio: 0.000001, compactionKeepRecentTokens: 300, compactionCallModel: fakeCallModel, loopFn: fakeLoop(seenLong) as never,
    });
    expect(seenLong.systemPrompt).toBe(seenShort.systemPrompt as string);
  });
});

/**
 * ★ split-turn(2026-08-09):切点落在**轮内**时,本轮请求必须逐字活下来。
 *
 * 反向自检(实跑):把 `agent-leaf.ts` 里 `const kept = turnHead === null ? tail : [...]`
 * 改回 `const kept = tail` → 下面第一条当场红(保留段里再也找不到本轮请求那句),
 * 第二条(叶子形状 no-op)仍绿 —— 两条一起才分得开"接线起作用了"与"接线把什么都改了"。
 *
 * ⚠ 这一段量的**不是**"压不动能不能压得动"。实测(六种超预算形状,记在
 * `agent-leaf.ts` 的 `findTurnHeadIndex` 注里):omd 判 null 的两种形状 pi 的
 * `findCutPoint` 同样保留全量 —— 「压不动」是工具结果本身超预算,切点修不了。
 */
describe('★ split-turn —— 切点落在轮内时, 本轮请求逐字活下来', () => {
  const asstCall = (id: string, pad = 400): AgentMessage =>
    ({
      role: 'assistant',
      content: [
        { type: 'text', text: 'x'.repeat(pad) },
        { type: 'toolCall', id, name: 'read', arguments: { path: `f${id}.ts` } },
      ],
      api: 'openai-completions', provider: 'p', model: 'm',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: 'toolUse', timestamp: 1,
    }) as unknown as AgentMessage;
  const toolRes = (id: string, pad = 400): AgentMessage =>
    ({
      role: 'toolResult', toolCallId: id, toolName: 'read',
      content: [{ type: 'text', text: 'y'.repeat(pad) }], isError: false, timestamp: 1,
    }) as unknown as AgentMessage;

  const REQUEST = '★本轮请求: 把 src/x.ts 里的 Y 改成 Z, 别的一个字都别动';
  /** 三轮闲聊 + 最后一轮 20 次工具调用(= 大仓单轮里几十次工具调用的形状)。 */
  const multiTurn = (): AgentMessage[] => {
    const out: AgentMessage[] = [];
    for (let t = 0; t < 3; t++) out.push(userMsg(`第 ${t} 问`), assistantMsg(`第 ${t} 答`));
    out.push(userMsg(REQUEST));
    for (let i = 0; i < 20; i++) out.push(asstCall(`d${i}`), toolRes(`d${i}`, 8_000));
    return out;
  };
  const roleOf = (m: AgentMessage): string => (m as { role: string }).role;
  const tokens = (ms: AgentMessage[]): number => ms.reduce((n, m) => n + estimateTokens(m), 0);

  test('★ 多轮 + 最后一轮超预算 → 保留段里有本轮请求原文, 且不切出孤儿 toolResult', async () => {
    const msgs = multiTurn();
    const r = (await compactChatMessages({
      messages: msgs, model: MODEL, keepRecentTokens: 20_000, callModelFn: fakeCallModel,
    }))!;
    expect(r).not.toBeNull();
    // ① 本轮请求逐字在保留段里 —— 摘要转述不算 (fakeCallModel 的摘要文本里没有这句)。
    expect(JSON.stringify(r.retainedTail)).toContain(REQUEST);
    // ② 位置: [首条, 本轮轮首, ...尾], 尾以 assistant 开头 (孤儿 toolResult = provider 直接 400)。
    expect(roleOf(r.retainedTail[0] as AgentMessage)).toBe('user');
    expect((r.retainedTail[1] as { content: string }).content).toBe(REQUEST);
    expect(roleOf(r.retainedTail[2] as AgentMessage)).toBe('assistant');
    // ③ 发出去的那一份: [首条, 摘要, 轮首, ...尾]
    //    摘要那条是 pi 的 `compactionSummary` 消息 (2026-08-11 台账 §1.4: 手拼 user → pi 构造器),
    //    前缀/后缀由 `convertToLlm` 在发出去那一刻贴 —— 这里断言的是**结构**, 不是拼好的串。
    expect(roleOf(r.messages[1] as AgentMessage)).toBe('compactionSummary');
    expect((r.messages[1] as { summary: string }).summary).toContain('【摘要】');
    expect((r.messages[2] as { content: string }).content).toBe(REQUEST);
    // ④ 真的瘦了: 压缩前 ≈42k → 压缩后落在 [keep, keep*1.5) 之间。
    //    下界是"往回找"的语义 (宁可多留一点也不切出孤儿), 上界钉的是"多留不许多太多"。
    expect(tokens(r.messages)).toBeLessThan(20_000 * 1.5);
    expect(tokens(r.messages)).toBeGreaterThanOrEqual(20_000);
    expect(tokens(r.messages)).toBeLessThan(tokens(msgs) * 0.55);
  });

  test('★ 单轮形状 (叶子: 首条就是轮首) → 一个字不变, 仍是 [首条, 摘要, ...尾]', async () => {
    const msgs: AgentMessage[] = [userMsg(REQUEST)];
    for (let i = 0; i < 20; i++) msgs.push(asstCall(`s${i}`), toolRes(`s${i}`, 8_000));
    const r = (await compactChatMessages({
      messages: msgs, model: MODEL, keepRecentTokens: 20_000, callModelFn: fakeCallModel,
    }))!;
    expect(r).not.toBeNull();
    // 首条 = 轮首 ⇒ 不该多插一条: 摘要之后直接就是尾 (assistant)。
    expect((r.messages[0] as { content: string }).content).toBe(REQUEST);
    expect((r.messages[1] as { summary: string }).summary).toContain('【摘要】');
    expect(roleOf(r.messages[2] as AgentMessage)).toBe('assistant');
    expect(roleOf(r.retainedTail[1] as AgentMessage)).toBe('assistant');
  });

  test('★ 落进会话再投影回来: 本轮请求还在, 会话真的短了 (无 seq 错)', async () => {
    await seed('c9', multiTurn());
    const before = (await onDisk('c9')).length;
    const r = await runChatTurn({
      store, sessionId: 'c9', prompt: '接着改', model: MODEL, cwd: root,
      contextBudgetRatio: 0.000001, compactionKeepRecentTokens: 20_000,
      compactionCallModel: fakeCallModel, loopFn: fakeLoop() as never,
    });
    expect(r.compactions).toBeGreaterThan(0);
    const after = await onDisk('c9'); // 投影读得出来 = 条目链没断
    expect(after.length).toBeLessThan(before);
    expect(JSON.stringify(after)).toContain(REQUEST);
  });
});

/**
 * ★ 结构化摘要 + 增量摘要(2026-08-11,台账 §1.2 / C14–C15)。
 *
 * 两臂**必须一起测**:只测"有旧摘要走增量"证明不了没有旧摘要时还走得对 ——
 * 一个恒走增量的实现能让那一条独自绿(旧摘要位填空串照样能出摘要)。
 */
describe('★ 结构化摘要骨架 + 增量合并(有旧摘要走增量 / 没有走整份)', () => {
  /** 上一次压缩留下的那条摘要消息 —— 与投影 / compactLeafContext 产出的**同一个构造器**。 */
  const prevSummaryMsg = (text: string): AgentMessage =>
    createCompactionSummaryMessage(text, 9_999, 1) as unknown as AgentMessage;
  const PREV = '## Goal\n查 DAG 卡在哪一节点\n## Next Steps\n1. 读 engine.ts 的重试分支';

  test('★ A: 摘要 prompt 带 pi C15 的段骨架(段名逐字英文, 不译)', async () => {
    // 反向自检(实跑): 把 `CHAT_SUMMARY_SKELETON` 从两条 instruction 里去掉 → 本条当场红
    // (九个段名一个都读不到)。这条钉的是**格式锚点存在**, 不是摘要写得好不好。
    await compactChatMessages({
      messages: longSession(12), model: MODEL, keepRecentTokens: 300, callModelFn: fakeCallModel,
    });
    const req = calls[0] as { user: string };
    for (const seg of ['## Goal', '## Constraints & Preferences', '## Progress', '### Done',
      '### In Progress', '### Blocked', '## Key Decisions', '## Next Steps', '## Critical Context']) {
      expect(req.user).toContain(seg);
    }
    // pi 那份格式里唯一一条内容级约束 —— chat 摘要最容易丢的正是路径与错误原文。
    expect(req.user).toContain('Preserve exact file paths, function names, and error messages');
  });

  test('★ B 臂一 —— **没有**旧摘要 → 整份生成(prompt 里不许出现 <previous-summary>)', async () => {
    // 反向自检(实跑): 把 `findPreviousSummary` 改成恒返回 `{index:0, summary:'x'}` → 本条当场红
    // (整份生成那条路上冒出了 <previous-summary>)。
    await compactChatMessages({
      messages: longSession(12), model: MODEL, keepRecentTokens: 300, callModelFn: fakeCallModel,
    });
    const req = calls[0] as { user: string };
    expect(req.user).not.toContain('<previous-summary>');
    expect(req.user).toContain('人与 conductor 的对话'); // 仍是 chat 口径, 不是叶子那套
  });

  test('★ B 臂二 —— **有**旧摘要 → 增量合并: 旧摘要原文进 prompt, 且不再重复占着上下文', async () => {
    // 反向自检(实跑, 两处各证一次):
    //  ① 把 `prompt: previous ? buildIncrementalChatPrompt(...) : CHAT_COMPACTION_PROMPT`
    //     写死成 `CHAT_COMPACTION_PROMPT` → 前两条断言当场红(prompt 里没有 <previous-summary>)。
    //  ② 把 `messages` 那行的 `.filter(...)` 去掉(旧摘要留在待压段) → 最后一条当场红
    //     (旧摘要既在新摘要里、又原样占着一条 —— 正是 C14 要消掉的那个叠加)。
    const msgs = [prevSummaryMsg(PREV), ...longSession(12)];
    const r = (await compactChatMessages({
      messages: msgs, model: MODEL, keepRecentTokens: 300, callModelFn: fakeCallModel,
    }))!;
    expect(r).not.toBeNull();

    const req = calls[0] as { user: string };
    expect(req.user).toContain('<previous-summary>');
    expect(req.user).toContain(PREV); // 旧摘要**逐字**交给模型合并, 不是转述
    expect(req.user).toContain('更新后的完整摘要'); // 要完整份不要补丁 —— 只回补丁是静默失效
    // 段骨架两条路共用: 增量产出的格式必须与它读到的旧摘要格式一致。
    expect(req.user).toContain('## Key Decisions');

    // 旧摘要不再重复:新摘要替换它, 上下文里只剩一条 compactionSummary。
    const summaries = (r.messages as AgentMessage[]).filter(
      (m) => (m as { role?: string }).role === 'compactionSummary',
    );
    expect(summaries).toHaveLength(1);
    expect((summaries[0] as { summary: string }).summary).toContain('【摘要】');
    expect(JSON.stringify(r.retainedTail)).not.toContain(PREV);
  });

  test('空摘要 ≠ 没摘要 —— 回落整份生成, 但不静默(NULL≠0≠不适用)', async () => {
    // 摘要器出过空这件事必须留痕: 走整份生成是对的, 但"这里本来有一条摘要"不许消失。
    // 反向自检(实跑): 把 `findPreviousSummary` 里那句 `if (summary.trim())` 去掉 →
    // 空串被当成旧摘要送进 <previous-summary>, 本条当场红。
    await compactChatMessages({
      messages: [prevSummaryMsg('   '), ...longSession(12)],
      model: MODEL, keepRecentTokens: 300, callModelFn: fakeCallModel,
    });
    expect((calls[0] as { user: string }).user).not.toContain('<previous-summary>');
  });

  test('★ 落进会话再压第二次 —— 走的是增量那条(读的是盘上那份摘要)', async () => {
    // 端到端: 第一轮压缩 → 会话里落一条 compaction 条目 → 第二轮载入的投影首条就是它。
    // 反向自检(实跑): 把 compactChatMessages 里的 `findPreviousSummary` 调用去掉 →
    // 第二次压缩的 prompt 里没有 <previous-summary>, 本条当场红。
    await seed('c10', longSession(12));
    await runChatTurn({
      store, sessionId: 'c10', prompt: '第一问', model: MODEL, cwd: root,
      contextBudgetRatio: 0.000001, compactionKeepRecentTokens: 300,
      compactionCallModel: fakeCallModel, loopFn: fakeLoop() as never,
    });
    calls = []; // 只看第二次那一发
    await runChatTurn({
      store, sessionId: 'c10', prompt: '第二问', model: MODEL, cwd: root,
      contextBudgetRatio: 0.000001, compactionKeepRecentTokens: 300,
      compactionCallModel: fakeCallModel, loopFn: fakeLoop() as never,
    });
    expect(calls).toHaveLength(1);
    expect((calls[0] as { user: string }).user).toContain('<previous-summary>');
    expect((calls[0] as { user: string }).user).toContain('【摘要】'); // 盘上那份就是第一次的产物
  });
});

describe('不该压的时候不压', () => {
  test('没超预算 → 一次模型调用都不发(压缩不是每轮都跑的东西)', async () => {
    await seed('c6', longSession(2));
    const r = await runChatTurn({ store, sessionId: 'c6', prompt: 'x', model: MODEL, cwd: root, loopFn: fakeLoop() as never });
    expect(r.compactions).toBe(0);
    expect(calls).toHaveLength(0);
  });

  test('★ ratio=0 关掉压缩 —— 与"开着但没压"分得开(前者 calls=0 且恒不压)', async () => {
    await seed('c7', longSession(12));
    const r = await runChatTurn({
      store, sessionId: 'c7', prompt: 'x', model: MODEL, cwd: root,
      contextBudgetRatio: 0, compactionCallModel: fakeCallModel, loopFn: fakeLoop() as never,
    });
    expect(r.compactions).toBe(0);
    expect(calls).toHaveLength(0);
    // 会话没被动过: 原来 24 条 + 本轮 2 条
    expect(await onDisk('c7')).toHaveLength(26);
  });

  test('会话太短切不出点 → 不压, 也不抛(响亮记一行, 不静默)', async () => {
    await seed('c8', [userMsg('只有一条')]);
    const r = await runChatTurn({
      store, sessionId: 'c8', prompt: 'x', model: MODEL, cwd: root,
      contextBudgetRatio: 0.000001, compactionKeepRecentTokens: 300, compactionCallModel: fakeCallModel, loopFn: fakeLoop() as never,
    });
    expect(r.compactions).toBe(0);
  });
});
