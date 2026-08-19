/**
 * test/core/session-omd-continuity —— #211:omd **自己的**会话也有交接。
 *
 * 此前整条 continuity 只服务 Claude Code:写入触发是 CC 的 hook、蒸馏器的输入面认 CC 的
 * transcript 格式、读回面两头都没有。本件钉的就是这三处:
 *   - A3 来源缝:omd 会话 → 与 CC 同形的 `U:/A:/T:/R:` 摘录,且**增量**(游标按条目序);
 *   - A1 写入:omd 会话跑一次 → checkpoint.md 落盘 + `facts` 出 continuity 行,`id` = omd session id;
 *   - A2 读回:下一段会话读得回上一段的 §1/§2,且**不回喂自己**;
 *   - 触发口径:压缩即存 · 跨档即存 · 同档不重复 · ctx 量不到**不伪造**。
 *
 * 反向自检(逐条实测红过):
 *   - `omdSessionSource` 的 `e.type !== 'message'` 那行去掉 → compaction 条目混进摘录,A3 红;
 *   - 游标 `entries.length` 改成 `0` → 增量那条变成每次全量,A3 红;
 *   - `decideOmdCheckpoint` 的 `ctxTokens === null` 分支改成回落 0 → 「不伪造」那条红;
 *   - `readResumeBrief` 的 `excludeSessionId` 判断去掉 → 「不回喂自己」那条红;
 *   - `runWriter` 里 `transcript`/`source` 都没有时不抛而是产空 → A1 的「装配错要响亮」那条红。
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { omdSessionSource, ccTranscriptSource, type OmdEntryLike } from '../../src/harness/session/source';
import { runWriter } from '../../src/harness/session/writer';
import { readResumeBrief, renderResumeBrief } from '../../src/harness/session/resume';
import {
  decideOmdCheckpoint,
  maybeCheckpointOmdSession,
  resetOmdCheckpointStateForTest,
} from '../../src/harness/session/omd-checkpoint';
import { createDefaultMemory } from '../../src/mcp/assemble';
import { listCheckpoints } from '../../src/harness/session/sink';

// ─── fixture:omd 会话条目 ───────────────────────────────────────────────────

const msg = (message: unknown): OmdEntryLike => ({ type: 'message', message });
const userMsg = (text: string): OmdEntryLike => msg({ role: 'user', content: [{ type: 'text', text }] });
const assistantMsg = (text: string): OmdEntryLike => msg({ role: 'assistant', content: [{ type: 'text', text }] });
const toolCallMsg = (name: string, args: unknown): OmdEntryLike =>
  msg({ role: 'assistant', content: [{ type: 'toolCall', name, arguments: args }] });
const toolResultMsg = (text: string): OmdEntryLike => msg({ role: 'toolResult', content: [{ type: 'text', text }] });

function mkRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(root, '.omd'), { recursive: true });
  return root;
}

// ─── A3 来源缝 ──────────────────────────────────────────────────────────────

describe('A3 来源缝 — omd 会话 → 蒸馏器吃的摘录', () => {
  test('四类内容渲染成与 CC 同形的 U:/A:/T:/R: 行', async () => {
    const entries = [
      userMsg('把 #211 做了'),
      assistantMsg('先把缝切出来'),
      toolCallMsg('Bash', { command: 'bun test' }),
      toolResultMsg('5817 pass'),
    ];
    const out = await omdSessionSource({ entries: () => Promise.resolve(entries) }).read(0);

    expect(out.text.split('\n')).toEqual([
      'U: 把 #211 做了',
      'A: 先把缝切出来',
      'T: Bash bun test',
      'R: 5817 pass',
    ]);
    expect(out.cursor).toBe(4);
    expect(out.ctxTokens).toBeNull(); // 没给取数函数 → null, 不编一个 0
  });

  test('增量: 第二次从游标起只出新增(游标 = 条目序号, 不是字节)', async () => {
    let entries = [userMsg('第一句'), assistantMsg('第一答')];
    const source = omdSessionSource({ entries: () => Promise.resolve(entries) });

    const first = await source.read(0);
    expect(first.text).toContain('第一句');
    expect(first.cursor).toBe(2);

    entries = [...entries, userMsg('第二句')];
    const second = await source.read(first.cursor);
    expect(second.text).toBe('U: 第二句'); // 只有新增
    expect(second.cursor).toBe(3);
  });

  test('非 message 条目(compaction / model_change)不进摘录', async () => {
    const entries: OmdEntryLike[] = [
      userMsg('聊了很久'),
      { type: 'compaction', message: { role: 'assistant', content: [{ type: 'text', text: '这是压缩摘要' }] } },
      { type: 'model_change' },
      assistantMsg('接着聊'),
    ];
    const out = await omdSessionSource({ entries: () => Promise.resolve(entries) }).read(0);
    expect(out.text).toBe('U: 聊了很久\nA: 接着聊');
    expect(out.text).not.toContain('这是压缩摘要');
  });

  test('游标越界(分支切换让条目数回退)→ 回 0 重读, 不指到未来去', async () => {
    const entries = [userMsg('只剩一条')];
    const out = await omdSessionSource({ entries: () => Promise.resolve(entries) }).read(99);
    expect(out.text).toBe('U: 只剩一条');
    expect(out.cursor).toBe(1);
  });

  test('ctxTokens 由引擎自己给(CC 那侧只能回落 ledger, 这侧握着真数)', async () => {
    const out = await omdSessionSource({
      entries: () => Promise.resolve([userMsg('x')]),
      ctxTokens: () => 123_456,
    }).read(0);
    expect(out.ctxTokens).toBe(123_456);
    expect(ccTranscriptSource('/nonexistent').kind).toBe('cc-transcript'); // 两个实现并存
  });
});

// ─── 触发口径 ───────────────────────────────────────────────────────────────

describe('触发口径 — decideOmdCheckpoint', () => {
  const env = { OMD_SESSION_BUCKET: '1000' } as NodeJS.ProcessEnv;

  test('本轮压缩过 → 存, mode=precompact(与档位无关)', () => {
    const d = decideOmdCheckpoint({ ctxTokens: 10, lastFiredBucket: 0, compacted: true, env });
    expect(d.fire).toBe(true);
    expect(d.mode).toBe('precompact');
  });

  test('跨档 → 存;同档再来 → 不存', () => {
    expect(decideOmdCheckpoint({ ctxTokens: 1200, lastFiredBucket: 0, compacted: false, env })).toMatchObject({
      fire: true,
      mode: 'rolling',
      bucket: 1,
    });
    expect(decideOmdCheckpoint({ ctxTokens: 1900, lastFiredBucket: 1, compacted: false, env }).fire).toBe(false);
    expect(decideOmdCheckpoint({ ctxTokens: 2100, lastFiredBucket: 1, compacted: false, env }).fire).toBe(true);
  });

  test('ctx 量不到 → **不存**(没读数就没判据, 伪造一个数比不存更糟)', () => {
    const d = decideOmdCheckpoint({ ctxTokens: null, lastFiredBucket: 0, compacted: false, env });
    expect(d.fire).toBe(false);
    expect(d.why).toContain('不伪造');
  });

  test('档位配置坏 → 不存(不拿坏配置造档位)', () => {
    const d = decideOmdCheckpoint({
      ctxTokens: 999_999,
      lastFiredBucket: 0,
      compacted: false,
      env: { OMD_SESSION_BUCKET: 'abc' } as NodeJS.ProcessEnv,
    });
    expect(d.fire).toBe(false);
  });
});

// ─── A1 写入 ────────────────────────────────────────────────────────────────

describe('A1 写入 — omd 会话真产 checkpoint 与 facts 行', () => {
  test('runWriter 走 omd source → checkpoint.md 落盘, facts 出行且 id = omd session id', async () => {
    const root = mkRoot('omd-211-write-');
    const db = join(root, '.omd', 'memory.db');
    const memory = createDefaultMemory({ OMD_MEMORY_PATH: db } as NodeJS.ProcessEnv);
    try {
      const res = await runWriter({
        sessionId: 'omd-sess-1',
        cwd: root,
        mechanical: true, // 零模型调用
        memory,
        source: omdSessionSource({
          entries: () => Promise.resolve([userMsg('做 #211'), assistantMsg('缝切好了')]),
          ctxTokens: () => 4242,
        }),
      });

      expect(res.ok).toBe(true);
      expect(existsSync(res.checkpointPath)).toBe(true);
      expect(readFileSync(res.checkpointPath, 'utf-8')).toContain('## §1 Active intent');
      expect(res.sink?.ok).toBe(true);

      const rows = await listCheckpoints({ sessionId: 'omd-sess-1' }, { memory });
      expect(rows.length).toBe(1);
      expect(rows[0]!.sessionId).toBe('omd-sess-1');
      // ctx 真值走的是 source 报的那个数, 不是 ledger(omd 侧没有 ledger)
      expect(rows[0]!.ctxTokens).toBe(4242);
    } finally {
      memory.close();
    }
  });

  test('两个来源都不给 = 调用方装配错 → **响亮抛**, 不静默产一份空 checkpoint', async () => {
    const root = mkRoot('omd-211-noarg-');
    await expect(runWriter({ sessionId: 'no-source', cwd: root })).rejects.toThrow(/transcript 或 source/);
  });

  test('maybeCheckpointOmdSession: 判该存才存, 同档第二次不重复派', async () => {
    resetOmdCheckpointStateForTest();
    const root = mkRoot('omd-211-gate-');
    const calls: { mode?: string; kind?: string }[] = [];
    const fakeWriter = (async (o: Parameters<typeof runWriter>[0]) => {
      calls.push({ mode: o.mode, kind: o.source?.kind });
      return { ok: true, checkpointPath: join(root, 'cp.md'), degraded: false, chars: 1, skipped: false };
    }) as typeof runWriter;

    const deps = {
      sessionId: 'gate-1',
      cwd: root,
      entries: () => Promise.resolve([userMsg('x')]),
      env: { OMD_SESSION_BUCKET: '1000' } as NodeJS.ProcessEnv,
      runWriterFn: fakeWriter,
    };

    expect(await maybeCheckpointOmdSession({ ...deps, ctxTokens: 500 })).toBeNull(); // 未过首档
    expect(await maybeCheckpointOmdSession({ ...deps, ctxTokens: 1200 })).not.toBeNull(); // 跨到 1 档
    expect(await maybeCheckpointOmdSession({ ...deps, ctxTokens: 1900 })).toBeNull(); // 同档不重复
    expect(calls).toEqual([{ mode: 'rolling', kind: 'omd-session' }]);
  });

  test('writer 抛了也不上抛 —— 交接永远不该把正在跑的那一轮弄失败', async () => {
    resetOmdCheckpointStateForTest();
    const boom = (() => Promise.reject(new Error('蒸馏炸了'))) as unknown as typeof runWriter;
    const res = await maybeCheckpointOmdSession({
      sessionId: 'boom-1',
      cwd: mkRoot('omd-211-boom-'),
      entries: () => Promise.resolve([userMsg('x')]),
      ctxTokens: 5_000,
      env: { OMD_SESSION_BUCKET: '1000' } as NodeJS.ProcessEnv,
      runWriterFn: boom,
    });
    expect(res).toBeNull();
  });
});

// ─── A2 读回 ────────────────────────────────────────────────────────────────

describe('A2 读回 — 下一段会话接得住上一段', () => {
  test('写一次 → readResumeBrief 拿到 §1/§2 与全文指针', async () => {
    const root = mkRoot('omd-211-resume-');
    const written = await runWriter({
      sessionId: 'prev-sess',
      cwd: root,
      mechanical: true,
      source: omdSessionSource({ entries: () => Promise.resolve([userMsg('上一段在做 #211')]) }),
    });
    expect(written.ok).toBe(true);

    const brief = readResumeBrief({ cwd: root });
    expect(brief).not.toBeNull();
    expect(brief!.sessionId).toBe('prev-sess');
    expect(brief!.checkpointPath).toBe(written.checkpointPath);
    expect(brief!.degraded).toBe(true); // mechanical → 降级版
    expect(brief!.intent.length).toBeGreaterThan(0);

    // 渲染出来要**说明它是上一段自己写的**, 不能读着像既成事实
    const rendered = renderResumeBrief(brief!);
    expect(rendered).toContain('上一段会话的交接');
    expect(rendered).toContain('机械降级'); // 降级版照实说
    expect(rendered).toContain(written.checkpointPath);
  });

  test('不回喂自己: excludeSessionId 命中最近那份 → null', async () => {
    const root = mkRoot('omd-211-self-');
    await runWriter({
      sessionId: 'same-sess',
      cwd: root,
      mechanical: true,
      source: omdSessionSource({ entries: () => Promise.resolve([userMsg('自己写的')]) }),
    });
    expect(readResumeBrief({ cwd: root, excludeSessionId: 'same-sess' })).toBeNull();
    expect(readResumeBrief({ cwd: root, excludeSessionId: 'another-sess' })).not.toBeNull();
  });

  test('没写过任何 checkpoint → null(而不是一段空的)', () => {
    expect(readResumeBrief({ cwd: mkRoot('omd-211-empty-') })).toBeNull();
  });
});
