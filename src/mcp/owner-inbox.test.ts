/**
 * S3 owner 收件箱 —— 岔口冒到 run 级 · 指令逐字 · 出口通 (2026-07-31)。
 *
 * 这条网盯的四个失效形态,每个都会让 S3 变成"看起来有 HITL 其实没有":
 *  ① **指令被改写/摘要** → 失真的地方 owner 自己看不见。观测者在这条链上只是信使。
 *  ② **指令每轮重放** → conductor 读成"owner 在反复强调", 而其实他只说过一次。
 *  ③ **岔口挂在子图上** → 子图每轮重画, 内容寻址 id 每轮都变, 那张票下一轮就没有对应物了。
 *     (这一条是 OpenAI Agents SDK 的 HITL 教的: 嵌套里的审批**仍然冒到外层 run**。)
 *  ④ **裁决了但没进指令队列** → 人裁了, 环照旧跑错的那条路, 而读数上看不出区别。
 */
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createOwnerInbox, renderOwnerDirectives } from './owner-inbox';
import { createTriageTools } from './tools/triage';
import { RunRegistry } from './run-registry';

const mk = () => createOwnerInbox({ db: new Database(':memory:') });

const fork = (over: Partial<Parameters<ReturnType<typeof mk>['openFork']>[0]> = {}) => ({
  id: 'f1',
  runId: 'run-1',
  nodeId: 'execute::abc',
  round: 1,
  question: '摘要按接口分成两份, 还是合成一份?',
  recommendation: '分两份 —— 源材料本身是两份, 合并会掩盖冲突',
  assumption: '分两份',
  blocking: false,
  ...over,
});

describe('owner 收件箱', () => {
  test('岔口挂在 **runId** 上, 不挂子节点 —— 子图每轮重画, 挂上去下一轮就没了', () => {
    const inbox = mk();
    inbox.openFork(fork());
    // nodeId 只作审计线索; 查询与裁决全走 runId + forkId, 两者都比一轮活得久。
    expect(inbox.openForks('run-1')).toHaveLength(1);
    expect(inbox.openForks('别的 run')).toHaveLength(0);
    inbox.close();
  });

  test('裁决 → **自动**变成一条 owner 指令 (不让调用方再手动加一次)', () => {
    const inbox = mk();
    inbox.openFork(fork());
    const out = inbox.rule('f1', '合成一份, 冲突单列一节');
    expect(out).toBeTruthy();
    expect(out!.fork.status).toBe('ruled');
    // 裁完就该有待消费指令 —— 否则"裁了但环照旧跑错的路", 读数上看不出区别。
    const pend = inbox.pendingDirectives('run-1');
    expect(pend).toHaveLength(1);
    expect(pend[0]!.text).toContain('合成一份, 冲突单列一节');
    inbox.close();
  });

  test('**逐字**: owner 原话一个字不改地出现在渲染结果里', () => {
    const inbox = mk();
    const raw = '别用 zod v4 的 .loose(), 我们锁在 v3 —— 这是踩过的坑, 不要"顺手升级"。';
    inbox.addDirective('run-1', raw);
    const text = renderOwnerDirectives(inbox.pendingDirectives('run-1'));
    expect(text).toContain(raw); // 逐字, 不摘要不润色
    expect(text).toContain('<owner 指令>'); // 独立的块, 与引擎观察分开 (D-S)
    inbox.close();
  });

  test('消费一次就记账 —— 同一条指令不许每轮重放', () => {
    const inbox = mk();
    inbox.addDirective('run-1', '只改 src/, 别动 test/');
    const first = inbox.pendingDirectives('run-1');
    expect(first).toHaveLength(1);
    inbox.markConsumed(first.map((d) => d.id), 2);
    expect(inbox.pendingDirectives('run-1')).toHaveLength(0); // 第 3 轮不再看到它
    inbox.close();
  });

  test('空 → 空串 (不给 conductor 一个空标题去解读)', () => {
    expect(renderOwnerDirectives([])).toBe('');
  });

  test('同一个岔口重复裁决只认第一次 (裁决是一次性的)', () => {
    const inbox = mk();
    inbox.openFork(fork());
    inbox.rule('f1', '第一次');
    inbox.rule('f1', '第二次');
    const pend = inbox.pendingDirectives('run-1');
    expect(pend).toHaveLength(1);
    expect(pend[0]!.text).toContain('第一次');
    inbox.close();
  });
});

describe('dag_triage / dag_rule 调用面', () => {
  const tools = (inbox: ReturnType<typeof mk>) => {
    const reg = new RunRegistry();
    const t = createTriageTools({ inbox, runRegistry: reg });
    return {
      triage: t.find((x) => x.name === 'dag_triage')!,
      rule: t.find((x) => x.name === 'dag_rule')!,
      reg,
    };
  };
  const call = (t: { handler: unknown }, a: Record<string, unknown>) =>
    (t.handler as (x: never, y: never) => Promise<{ content: { text: string }[]; isError?: boolean }>)(a as never, {} as never);

  test('收件箱把**假设**也摆出来 —— owner 要判的不只是"选哪个", 还有"它已经按什么在跑了"', async () => {
    const inbox = mk();
    inbox.openFork(fork());
    const { triage } = tools(inbox);
    const out = await call(triage, {});
    expect(out.content[0]!.text).toContain('我的建议');
    expect(out.content[0]!.text).toContain('它已按此假设继续跑');
    inbox.close();
  });

  test('红线岔口显式标出来 (它与"带着假设继续跑"是两件事)', async () => {
    const inbox = mk();
    inbox.openFork(fork({ id: 'f2', blocking: true }));
    const { triage } = tools(inbox);
    expect((await call(triage, {})).content[0]!.text).toContain('红线');
    inbox.close();
  });

  test('空收件箱**如实说空**, 不是回一片空白', async () => {
    const inbox = mk();
    const { triage } = tools(inbox);
    expect((await call(triage, {})).content[0]!.text).toContain('收件箱是空的');
    inbox.close();
  });

  test('裁决与假设不同 → **明确提示下游要重算**', async () => {
    const inbox = mk();
    inbox.openFork(fork());
    const { rule } = tools(inbox);
    const out = await call(rule, { forkId: 'f1', ruling: '合成一份' });
    expect(out.content[0]!.text).toContain('需要重算');
    inbox.close();
  });

  test('裁决与假设一致 → 说清已有产出不受影响 (别吓人)', async () => {
    const inbox = mk();
    inbox.openFork(fork());
    const { rule } = tools(inbox);
    const out = await call(rule, { forkId: 'f1', ruling: '分两份' });
    expect(out.content[0]!.text).toContain('不受影响');
    inbox.close();
  });

  test('**不自动重跑** —— 裁决与重跑是两个决定, 回话给命令由 owner 扣扳机', async () => {
    const inbox = mk();
    inbox.openFork(fork());
    const { rule } = tools(inbox);
    const out = await call(rule, { forkId: 'f1', ruling: '就这么办' });
    expect(out.content[0]!.text).toContain('dag_goal resume=run-1');
    inbox.close();
  });

  test('裁一个不存在的岔口 / 重复裁 → 响亮失败, 不静默覆盖', async () => {
    const inbox = mk();
    inbox.openFork(fork());
    const { rule } = tools(inbox);
    expect((await call(rule, { forkId: '不存在', ruling: 'x' })).isError).toBe(true);
    await call(rule, { forkId: 'f1', ruling: '第一次' });
    const again = await call(rule, { forkId: 'f1', ruling: '第二次' });
    expect(again.isError).toBe(true);
    expect(again.content[0]!.text).toContain('第一次');
    inbox.close();
  });
});
