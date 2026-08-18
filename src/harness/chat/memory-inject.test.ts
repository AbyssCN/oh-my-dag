/**
 * 记忆自动注入(goal §4 S16,A8)。
 *
 * 四条 goal 点名的判据:
 *  ① 注入是 **advisory** —— 失败静默 no-op,**不阻断一轮**;
 *  ② TTL 扫过之后过期 fact 真的不见了;
 *  ③ `human_verified` 在 headless 下 **fail-closed**;
 *  ④ 注入只改这一次请求,**不写回会话**。
 */
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { describe, expect, test } from 'bun:test';
import { createConductorChatTools } from '../../serve/chat-tools';
import { RECALL_CLOSE, RECALL_OPEN, createMemoryTransform, formatRecall, lastUserText } from './memory-inject';

const user = (t: string): AgentMessage => ({ role: 'user', content: t, timestamp: 1 }) as AgentMessage;
const assistant = (t: string): AgentMessage =>
  ({ role: 'assistant', content: [{ type: 'text', text: t }], timestamp: 1 }) as unknown as AgentMessage;

/** 最小 OmdMemory 替身:只实现被用到的两个方法。 */
function fakeMemory(over: { hits?: { text: string }[]; pruned?: number; throws?: Error } = {}) {
  const calls = { retrieve: [] as string[], prune: 0 };
  return {
    calls,
    mem: {
      prune: () => {
        calls.prune++;
        return over.pruned ?? 0;
      },
      retrieve: async (q: string) => {
        calls.retrieve.push(q);
        if (over.throws) throw over.throws;
        return (over.hits ?? []).map((h) => ({ text: h.text })) as never;
      },
    } as never,
  };
}

describe('lastUserText', () => {
  test('★ 取的是**最后一条用户消息**, 不是整段对话', () => {
    expect(lastUserText([user('第一问'), assistant('答'), user('第二问')])).toBe('第二问');
  });

  test('没有用户消息 → null', () => {
    expect(lastUserText([assistant('只有助手')])).toBeNull();
  });

  test('多块内容的用户消息也取得出文本', () => {
    const m = { role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] } as unknown as AgentMessage;
    expect(lastUserText([m])).toBe('a\nb');
  });
});

describe('formatRecall', () => {
  test('★ 空召回 → null(不注入一个空块)', () => {
    expect(formatRecall([], 100)).toBeNull();
    expect(formatRecall([{ text: '   ' }], 100)).toBeNull();
  });

  test('★ 两端都有定界符 —— 只有开头的话后面的正文会被读成召回内容', () => {
    const out = formatRecall([{ text: '事实一' }], 100) as string;
    expect(out.startsWith(RECALL_OPEN)).toBe(true);
    expect(out.endsWith(RECALL_CLOSE)).toBe(true);
  });

  test('★ 说清召回是线索不是真理(冲突时以当前证据为准)', () => {
    expect(formatRecall([{ text: 'x' }], 100)).toContain('线索不是真理');
  });

  test('单条超长事实被截断, 不挤掉其它条', () => {
    const out = formatRecall([{ text: 'x'.repeat(500) }, { text: '短的' }], 50) as string;
    expect(out).toContain('短的');
    expect(out).toContain('…');
  });
});

describe('★ transformContext 钩子', () => {
  // 反向自检 (2026-08-07 实跑): 把 createMemoryTransform 改成恒返回原 messages
  // → 「召回真的注进去了」当场红。
  test('★ 召回结果注在**末尾** —— 冻结前缀在最前, 追加只失效一次并重建', async () => {
    const { mem } = fakeMemory({ hits: [{ text: '上次那个座位是 kimi-coding:k3' }] });
    const out = await createMemoryTransform({ memory: mem })([user('座位是什么来着')]);
    expect(out).toHaveLength(2);
    expect(String((out[1] as { content: string }).content)).toContain('kimi-coding:k3');
  });

  test('★ 不改原数组 —— transformContext 的语义是"只改这一次请求"', async () => {
    const { mem } = fakeMemory({ hits: [{ text: 'x' }] });
    const input = [user('q')];
    await createMemoryTransform({ memory: mem })(input);
    expect(input).toHaveLength(1); // 原数组没被 push 进东西
  });

  test('★ 召回抛错 → 原样返回消息, **不阻断这一轮**(advisory)', async () => {
    const { mem } = fakeMemory({ throws: new Error('库锁了') });
    const input = [user('q')];
    const out = await createMemoryTransform({ memory: mem })(input);
    expect(out).toEqual(input);
  });

  test('一条都没召回到 → 不注入空块', async () => {
    const { mem } = fakeMemory({ hits: [] });
    expect(await createMemoryTransform({ memory: mem })([user('q')])).toHaveLength(1);
  });

  test('没有用户消息 → 不召回(省一次检索)', async () => {
    const { mem, calls } = fakeMemory({ hits: [{ text: 'x' }] });
    await createMemoryTransform({ memory: mem })([assistant('只有助手')]);
    expect(calls.retrieve).toEqual([]);
  });

  test('★ 每次请求前跑一次 TTL 回收(prune 的挂载点就在这里)', async () => {
    const { mem, calls } = fakeMemory({ pruned: 3 });
    await createMemoryTransform({ memory: mem })([user('q')]);
    expect(calls.prune).toBe(1);
  });
});

describe('★ human_verified 在 headless 下 fail-closed', () => {
  // goal §4 点名。兑现方式不是"写的时候拦一下", 而是**这条路根本不存在**:
  // conductor 的工具白名单里只有 recall 没有 remember。
  test('chat 位工具面**没有**任何写记忆的口 —— 对话位不能自主写下一条事实', () => {
    const fake = [
      { name: 'memory_recall', handler: async () => ({ content: [] }) },
      { name: 'run', handler: async () => ({ content: [] }) },
      { name: 'solve', handler: async () => ({ content: [] }) },
      { name: 'dag_run_plan', handler: async () => ({ content: [] }) },
      { name: 'dag_status', handler: async () => ({ content: [] }) },
      { name: 'dag_node_output', handler: async () => ({ content: [] }) },
      { name: 'dag_runs', handler: async () => ({ content: [] }) },
      { name: 'dag_cancel', handler: async () => ({ content: [] }) },
      { name: 'map_open', handler: async () => ({ content: [] }) },
      { name: 'map_tickets', handler: async () => ({ content: [] }) },
      { name: 'omd_plans', handler: async () => ({ content: [] }) },
      // D-8 之后 chat 白名单恒查这两个 —— 夹具不带它们, 不是「少了个 mock」,
      // 是这次 createConductorChatTools 调用本身不再合法 (must 会响亮抛)。
      { name: 'history_read', handler: async () => ({ content: [] }) },
      { name: 'history_search', handler: async () => ({ content: [] }) },
    ] as never;
    const names = createConductorChatTools(fake).map((t) => t.name);
    expect(names).toContain('omd_recall');
    for (const n of names) {
      expect(n, `写记忆的口不许出现在 chat 位: ${n}`).not.toMatch(/remember|write_fact|memory_write/);
    }
  });
});

describe('★ TTL 扫过之后过期 fact 真的不见了(真库, 不是替身)', () => {
  // goal §4 点名。用**真 OmdMemory**: 替身只能证明 prune 被调了一次,
  // 证明不了"调完之后那条事实真的召回不到了" —— 而后者才是这条判据要的。
  const anchor = 'test:ttl';
  const factAt = (createdAt: Date) => ({
    namespace: 'omd.pattern' as const,
    situation: 'TTL 测试: 一条会过期的暂定事实',
    approach: '这条应当在 TTL 之后消失',
    outcome: 'worked' as const,
    source_event_id: anchor,
    confidence: { level: 'agent_tentative' as const, source_event_ids: [anchor], created_at: createdAt },
  });

  test('过期的 agent_tentative 事实被 prune 掉, 之后召回不到', async () => {
    const { createOmdMemory } = await import('../memory/store');
    const { UNIVERSAL_SAFEGUARD } = await import('../../memory/safeguards/namespaces');
    const mem = createOmdMemory({ path: ':memory:', safeguard: UNIVERSAL_SAFEGUARD });
    try {
      // 31 天前写的 —— TENTATIVE_TTL_MS 是 30 天。
      const old = new Date(Date.now() - 31 * 24 * 3600 * 1000);
      const w = await mem.writeFact(factAt(old), { scanSecrets: false });
      expect(w.status).toBe('written');
      expect((await mem.retrieve('TTL 测试', 5)).length).toBeGreaterThan(0); // 先证明它本来在

      const transform = createMemoryTransform({ memory: mem });
      await transform([user('TTL 测试')]);

      // ★ 扫过之后**真的不见了** —— 不是"prune 被调了一次"。
      expect(await mem.retrieve('TTL 测试', 5)).toEqual([]);
    } finally {
      mem.close();
    }
  });

  test('★ 没过期的不许被扫掉(闸不是"把库清空")', async () => {
    const { createOmdMemory } = await import('../memory/store');
    const { UNIVERSAL_SAFEGUARD } = await import('../../memory/safeguards/namespaces');
    const mem = createOmdMemory({ path: ':memory:', safeguard: UNIVERSAL_SAFEGUARD });
    try {
      await mem.writeFact(factAt(new Date()), { scanSecrets: false });
      await createMemoryTransform({ memory: mem })([user('TTL 测试')]);
      expect((await mem.retrieve('TTL 测试', 5)).length).toBeGreaterThan(0);
    } finally {
      mem.close();
    }
  });
});

describe('C-9 召回漏斗打点 (S-F: INJECTED 从此有盘上痕迹)', () => {
  const { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } = require('node:fs') as typeof import('node:fs');
  const { tmpdir } = require('node:os') as typeof import('node:os');
  const { join } = require('node:path') as typeof import('node:path');
  const user = (t: string) => ({ role: 'user', content: t, timestamp: 1 }) as unknown as AgentMessage;

  // 证伪方式 (当场验过): memory-inject.ts 里把打点块挪到 `if (!block) return` 之前
  // → 「零命中无行」臂红 (空注入也计了一行); 恢复后绿。
  test('★ 注入真发生 → append 一行 {ts, hits, queryChars}; 零命中 → 无行 (NULL ≠ 0)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'omd-recall-ev-'));
    const eventsPath = join(dir, '.omd', 'recall-events.jsonl');
    try {
      const { mem } = fakeMemory({ hits: [{ text: '座位是 kimi-coding:k3' }] });
      await createMemoryTransform({ memory: mem, eventsPath })([user('座位?')]);
      const lines = readFileSync(eventsPath, 'utf8').trim().split('\n');
      expect(lines.length).toBe(1);
      const row = JSON.parse(lines[0]!) as { ts: number; hits: number; queryChars: number };
      expect(row.hits).toBe(1);
      expect(row.queryChars).toBe('座位?'.length);

      // 零命中 → 不注入也不打点: 行数不变 (没记 = NULL, 不是 0)
      const { mem: empty } = fakeMemory({ hits: [] });
      await createMemoryTransform({ memory: empty, eventsPath })([user('另一问')]);
      expect(readFileSync(eventsPath, 'utf8').trim().split('\n').length).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('打点写入失败 → 注入照常 (advisory), 不抛', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'omd-recall-ev2-'));
    try {
      // 让 eventsPath 的"目录"是一个普通文件 → mkdir/append 必失败
      const blocker = join(dir, 'not-a-dir');
      writeFileSync(blocker, 'x');
      const eventsPath = join(blocker, 'recall-events.jsonl');
      const { mem } = fakeMemory({ hits: [{ text: '事实' }] });
      const out = await createMemoryTransform({ memory: mem, eventsPath })([user('问')]);
      expect(out.length).toBe(2); // 注入没受影响
      expect(existsSync(eventsPath)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('省略 eventsPath → 零打点 (向后兼容, 不吃进程 cwd)', async () => {
    const { mem } = fakeMemory({ hits: [{ text: '事实' }] });
    const out = await createMemoryTransform({ memory: mem })([user('问')]);
    expect(out.length).toBe(2);
  });
});
