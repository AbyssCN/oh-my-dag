/**
 * W4 session-sink 测试切片 (SDD 契约 · `src/harness/session/sink.ts`)。
 *
 * 契约面 (GWT-4):
 * - Given 注入 `OmdMemory` 的 `SinkDeps`, When `sinkCheckpoint` 被调,
 *   Then 返回 `ok: true` 且以 namespace=`continuity` / identity_key 派生自 sessionId 落一条;
 *   Given 无 memory, Then 返回 `:87` 现状 error (fail-open 不变)。
 * - 同 session 多写 = 演化更新一行 (supersede, 非追加): 第二次写 factStatus=`updated`, live 行数不变。
 * - `listCheckpoints`: 只读时间线 (live 快照); 无 memory → `[]` (fail-open)。
 *
 * 闸料说明: `continuity` 未注册于 DEFAULT_SAFEGUARD (仅 user 与 omd 两族) → 本测试注入
 * `OmdMemory({ safeguard })` 时装配含 continuity branch 的 pack (真闸真库, 非 fake memory;
 * namespace 注册属 W5 接线前置, 见实施报告遗留项)。
 */
import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { createOmdMemory } from '../../src/harness/memory';
import {
  assembleSafeguard,
  confidenceField,
  sourceAnchor,
  type NamespacePack,
} from '../../src/memory/safeguards/namespace-kernel';
import {
  listCheckpoints,
  sinkCheckpoint,
  type CheckpointSinkInput,
  type CheckpointRow,
} from '../../src/harness/session/sink';

// ─── continuity pack (测试侧装配; 生产注册见 W5 接线)──────────────────────────

const CONTINUITY_PACK: NamespacePack = {
  branches: [
    z.object({
      namespace: z.literal('continuity'),
      /** session id —— identity 字段: 同 session 多写 supersede 一行。 */
      id: z.string().min(1),
      mode: z.enum(['rolling', 'final', 'precompact']),
      md: z.string().min(1),
      intent: z.string().optional(),
      next: z.string().optional(),
      ctxTokens: z.number().nullable().optional(),
      degraded: z.boolean().optional(),
      checkpointPath: z.string().optional(),
      ...sourceAnchor,
      ...confidenceField,
    }),
  ],
  allowedNamespaces: ['continuity'],
  identityFields: { continuity: ['id'] },
  banGlobs: [],
};

const CONTINUITY_SAFEGUARD = assembleSafeguard([CONTINUITY_PACK]);

function memoryWithContinuity() {
  return createOmdMemory({ path: ':memory:', safeguard: CONTINUITY_SAFEGUARD });
}

function sampleInput(over: Partial<CheckpointSinkInput> = {}): CheckpointSinkInput {
  return {
    sessionId: 'sess-w4-1',
    mode: 'rolling',
    md: '# 续接 checkpoint\n\n§1 摘要\n\n§2 下一步',
    intent: '§1 摘要',
    next: '§2 下一步',
    ctxTokens: 226451,
    degraded: false,
    checkpointPath: '/tmp/omd/data/session/sess-w4-1/checkpoint.md',
    ...over,
  };
}

// ─── GWT-4 · 有 memory → 落一条 (namespace=continuity / identity 派生自 sessionId) ──

describe('sinkCheckpoint — GWT-4 (有 memory 分支)', () => {
  test('写成功 → ok:true + factStatus=created, 以 namespace=continuity 落一条, identity 派生自 sessionId', async () => {
    const memory = memoryWithContinuity();
    try {
      const res = await sinkCheckpoint(sampleInput(), { memory });
      expect(res.ok).toBe(true);
      expect(res.factStatus).toBe('created');
      expect(res.error).toBeUndefined();

      // 落一条: namespace=continuity, identity_key = JSON.stringify(['continuity', sessionId])。
      const live = memory.liveFactsByNamespace('continuity');
      expect(live).toHaveLength(1);
      expect(live[0]!.identityKey).toBe(JSON.stringify(['continuity', 'sess-w4-1']));
      const fact = memory.liveByIdentity('continuity', JSON.stringify(['continuity', 'sess-w4-1']));
      expect(fact).not.toBeNull();
      expect(fact!.id).toBe('sess-w4-1');
      expect(fact!.md).toBe(sampleInput().md);
      expect(fact!.ctxTokens).toBe(226451);
    } finally {
      memory.close();
    }
  });

  test('同 session 再写 → ok:true + factStatus=updated, live 仍一行 (演化更新, 不追加)', async () => {
    const memory = memoryWithContinuity();
    try {
      const first = await sinkCheckpoint(sampleInput({ ctxTokens: 190189 }), { memory });
      expect(first.factStatus).toBe('created');
      const second = await sinkCheckpoint(sampleInput({ ctxTokens: 226451, degraded: true }), { memory });
      expect(second.ok).toBe(true);
      expect(second.factStatus).toBe('updated');

      const live = memory.liveFactsByNamespace('continuity');
      expect(live).toHaveLength(1); // supersede, 非追加
      expect(live[0]!.identityKey).toBe(JSON.stringify(['continuity', 'sess-w4-1']));
      const fact = memory.liveByIdentity('continuity', JSON.stringify(['continuity', 'sess-w4-1']));
      expect(fact!.ctxTokens).toBe(226451); // 后写覆盖前写
      expect(fact!.degraded).toBe(true);
    } finally {
      memory.close();
    }
  });

  test('不同 session → 各自一行 (identity 按 session 分区)', async () => {
    const memory = memoryWithContinuity();
    try {
      await sinkCheckpoint(sampleInput({ sessionId: 'sess-a' }), { memory });
      await sinkCheckpoint(sampleInput({ sessionId: 'sess-b' }), { memory });
      const live = memory.liveFactsByNamespace('continuity');
      expect(live).toHaveLength(2);
      expect(new Set(live.map((r) => r.identityKey))).toEqual(
        new Set([JSON.stringify(['continuity', 'sess-a']), JSON.stringify(['continuity', 'sess-b'])]),
      );
    } finally {
      memory.close();
    }
  });

  test('writeFact 被闸拒 (注入 DEFAULT_SAFEGUARD memory, continuity 未注册) → ok:false + factStatus=rejected, 不抛 (fail-open)', async () => {
    const memory = createOmdMemory({ path: ':memory:' }); // 默认闸料: 无 continuity
    try {
      const res = await sinkCheckpoint(sampleInput(), { memory });
      expect(res.ok).toBe(false);
      expect(res.factStatus).toBe('rejected');
      expect(res.error).toContain('rejected');
      expect(memory.count()).toBe(0); // 拒写零落库
    } finally {
      memory.close();
    }
  });
});

// ─── GWT-4 · 无 memory → :87 现状 error (fail-open 不变) ─────────────────────

describe('sinkCheckpoint — GWT-4 (无 memory 分支)', () => {
  test('无 memory 注入 → { ok:false, error: "no OmdMemory injected — skip SQLite sink (markdown 已落)" }', async () => {
    const res = await sinkCheckpoint(sampleInput());
    expect(res).toEqual({
      ok: false,
      error: 'no OmdMemory injected — skip SQLite sink (markdown 已落)',
    });
  });

  test('sinkCheckpoint 永不抛 (输入畸形也 fail-open)', async () => {
    const res = await sinkCheckpoint({ sessionId: '', mode: 'rolling', md: '' });
    expect(res.ok).toBe(false);
  });
});

// ─── listCheckpoints · 只读时间线 ────────────────────────────────────────────

describe('listCheckpoints — 只读时间线 (read-only)', () => {
  test('有 memory → 返回 live 快照行 (CheckpointRow 字段齐全)', async () => {
    const memory = memoryWithContinuity();
    try {
      await sinkCheckpoint(sampleInput({ sessionId: 'sess-1', checkpointPath: '/tmp/omd/data/session/sess-1/checkpoint.md', ctxTokens: 226451 }), { memory });
      await sinkCheckpoint(sampleInput({ sessionId: 'sess-2', checkpointPath: '/tmp/omd/data/session/sess-2/checkpoint.md', ctxTokens: 190189, degraded: true }), { memory });

      const rows = await listCheckpoints({}, { memory });
      expect(rows).toHaveLength(2);
      const row: CheckpointRow = rows.find((r) => r.sessionId === 'sess-1')!;
      expect(row).toMatchObject({
        sessionId: 'sess-1',
        mode: 'rolling',
        intent: '§1 摘要',
        ctxTokens: 226451,
        degraded: false,
        checkpointPath: '/tmp/omd/data/session/sess-1/checkpoint.md',
      });
      expect(row.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/); // ISO 时间戳
    } finally {
      memory.close();
    }
  });

  test('sessionId 过滤 + recent 截断 (按 ts 倒序)', async () => {
    const memory = memoryWithContinuity();
    try {
      await sinkCheckpoint(sampleInput({ sessionId: 'sess-x', ctxTokens: 100 }), { memory });
      await sinkCheckpoint(sampleInput({ sessionId: 'sess-y', ctxTokens: 200 }), { memory });
      await sinkCheckpoint(sampleInput({ sessionId: 'sess-z', ctxTokens: 300 }), { memory });

      const filtered = await listCheckpoints({ sessionId: 'sess-y' }, { memory });
      expect(filtered).toHaveLength(1);
      expect(filtered[0]!.sessionId).toBe('sess-y');

      const recent = await listCheckpoints({ recent: 2 }, { memory });
      expect(recent).toHaveLength(2);
      expect(recent[0]!.ts >= recent[1]!.ts).toBe(true); // 新在前
    } finally {
      memory.close();
    }
  });

  test('无 memory → [] (fail-open, 不抛)', async () => {
    const rows = await listCheckpoints({}, undefined);
    expect(rows).toEqual([]);
  });
});
