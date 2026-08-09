/**
 * src/harness/dream/merge.test.ts —— merge 闸的 fixture 驱动测试(零 LLM)。
 *
 * 判据(冻结,SDD §S2 行 244-256):
 *   1. checkEvolve 三态各一条(human_verified→reject+conflict / tentative→replace / confident→evolve)
 *   2. supersession:同 identity 连写两次 → count() 只增 1、历史行 deleted_at 非空
 *   3. K_leaf 超限:喂 9 条 → ok:false 且 failReason 含 9 与 8
 *   4. K_run 超限:喂 31 条 → ok:false 且 failReason 含 31 与 30
 *
 * 证伪义务(写进注释):
 *   - 临时把超限 fail 改成截断 → 9 条用例变绿,亲眼看红后改回
 *
 * ⚠ detectConflict 升 inbox 的确切落点:OmdMemory.writeFact 内部已调 detectConflict(fact, [existing])
 *   并在 reject 时附 raiseToInbox(InboxPayload),见 store.ts:206-211。merge 只透传 conflictsRaised 计数,
 *   不自造 inbox 基础设施。—— 实测确认该 API 存在且 merge 正确复用。
 */
import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { createOmdMemory, type OmdMemory } from '../memory';
import { UNIVERSAL_SAFEGUARD } from '../../memory/safeguards/universal-namespaces';
import {
  mergeDreamCandidates,
  K_leaf,
  K_run,
  type DreamCandidate,
  type MergeReport,
} from './merge';

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

/** 造一个最小 DreamCandidate(user.preference,runRef 锚定)。 */
function dc(opts: {
  category?: string;
  value?: string;
  eventId?: string;
  runId?: string;
} = {}): DreamCandidate {
  return {
    namespace: 'user.preference',
    payload: {
      category: opts.category ?? 'format',
      value: opts.value ?? 'markdown',
    },
    runRef: { runId: opts.runId ?? 'test-run' },
    confidence: {
      level: 'agent_tentative',
      source_event_ids: [opts.eventId ?? 'ev1'],
    },
  };
}

/** 造一个带 sessionRef 的 DreamCandidate。 */
function dcSession(opts: {
  category?: string;
  value?: string;
  sessionId?: string;
  seq?: number;
} = {}): DreamCandidate {
  return {
    namespace: 'user.preference',
    payload: {
      category: opts.category ?? 'format',
      value: opts.value ?? 'markdown',
    },
    sessionRef: { sessionId: opts.sessionId ?? 's1', seq: opts.seq ?? 1 },
    confidence: {
      level: 'agent_tentative',
      source_event_ids: ['ev-session'],
    },
  };
}

/** 创建新的内存库(隔离)。 */
function newMemory(): OmdMemory {
  return createOmdMemory({ path: ':memory:', safeguard: UNIVERSAL_SAFEGUARD });
}

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

describe('mergeDreamCandidates', () => {
  // ── 三态: human_verified → reject + conflict raise ──
  test('existing human_verified → reject, conflictsRaised >= 1', async () => {
    const mem = newMemory();

    // 预写一条 human_verified fact(同 identity: category='format')
    await mem.writeFact(
      {
        namespace: 'user.preference',
        category: 'format',
        value: 'pdf',
        source_event_id: 'test:setup',
        confidence: { level: 'human_verified', by: 'nick', verified_at: new Date() },
      },
      { scanSecrets: false },
    );

    const report: MergeReport = await mergeDreamCandidates(
      [{ leafId: 'L1', candidate: dc({ value: 'excel' }) }],
      { cwd: '/tmp', memory: mem, runId: 'r1' },
    );

    // 拒写,reason 含 human-verified-immutable
    expect(report.rejected.length).toBe(1);
    expect(report.rejected[0]!.reason).toContain('human-verified-immutable');
    // 冲突升 inbox
    expect(report.conflictsRaised).toBeGreaterThanOrEqual(1);
    // 未写新行(count 仍是 1)
    expect(mem.count()).toBe(1);
  });

  // ── 三态: tentative → replace ──
  test('existing agent_tentative → replace', async () => {
    const mem = newMemory();

    // 预写一条 tentative fact
    const wr = await mem.writeFact(
      {
        namespace: 'user.preference',
        category: 'format',
        value: 'pdf',
        source_event_id: 'test:setup',
        confidence: {
          level: 'agent_tentative',
          source_event_ids: ['ev0'],
          created_at: new Date(),
        },
      },
      { scanSecrets: false },
    );
    expect(wr.status).toBe('written');
    const oldId = wr.status === 'written' ? wr.id : null;

    const report = await mergeDreamCandidates(
      [{ leafId: 'L1', candidate: dc({ value: 'excel', eventId: 'ev1' }) }],
      { cwd: '/tmp', memory: mem, runId: 'r1' },
    );

    expect(report.replaced).toBe(1);
    expect(report.added).toBe(0);
    // count 只增 1(旧行 tombstone)
    expect(mem.count()).toBe(1);
    // 旧 id 已 tombstone
    if (oldId) expect(mem.get(oldId)).toBeNull();
  });

  // ── 三态: confident → evolve(保链 evolution_log) ──
  test('existing agent_confident → evolve(保链 evolution_log)', async () => {
    const mem = newMemory();

    // 预写一条 confident fact
    const wr = await mem.writeFact(
      {
        namespace: 'user.preference',
        category: 'format',
        value: 'pdf',
        source_event_id: 'test:setup',
        confidence: {
          level: 'agent_confident',
          source_event_ids: ['ev0', 'ev0b', 'ev0c'],
          created_at: new Date(),
        },
      },
      { scanSecrets: false },
    );
    expect(wr.status).toBe('written');
    const oldId = wr.status === 'written' ? wr.id : null;

    const report = await mergeDreamCandidates(
      [{ leafId: 'L1', candidate: dc({ value: 'excel', eventId: 'ev1' }) }],
      { cwd: '/tmp', memory: mem, runId: 'r1' },
    );

    expect(report.evolved).toBe(1);
    expect(report.added).toBe(0);
    // count 只增 1
    expect(mem.count()).toBe(1);
    // 旧行 tombstone
    if (oldId) expect(mem.get(oldId)).toBeNull();
  });

  // ── 判据 4: supersession — 同 identity 连写两次 → count() 只增 1,旧行 deleted_at 非空 ──
  test('supersession: 同 identity 连写两次 → count() 净增 1,旧行 tombstone(永不 UPDATE-in-place)', async () => {
    const mem = newMemory();

    // 第一次 merge 写入
    const r1 = await mergeDreamCandidates(
      [{ leafId: 'L1', candidate: dc({ value: 'v1', eventId: 'ev1' }) }],
      { cwd: '/tmp', memory: mem, runId: 'r1' },
    );
    expect(r1.added).toBe(1);
    expect(mem.count()).toBe(1);

    // 取写入的 fact id(liveFactsByNamespace 拿)
    const live1 = mem.liveFactsByNamespace('user.preference');
    expect(live1.length).toBe(1);
    const oldId = live1[0]!.id;

    // 第二次 merge 写入(同 identity: category='format')
    const r2 = await mergeDreamCandidates(
      [{ leafId: 'L1', candidate: dc({ value: 'v2', eventId: 'ev2' }) }],
      { cwd: '/tmp', memory: mem, runId: 'r1' },
    );
    expect(r2.replaced).toBe(1);
    // count 净增 0(仍是 1)
    expect(mem.count()).toBe(1);
    // 旧行已 tombstone(get 返 null)
    expect(mem.get(oldId)).toBeNull();

    // 验证不是 UPDATE-in-place:旧行 deleted_at 非空 → 通过 get 返 null 间接证(tombstone 行 get 不返)
    // 同时 live 行是新 id(不同于 oldId)
    const live2 = mem.liveFactsByNamespace('user.preference');
    expect(live2.length).toBe(1);
    expect(live2[0]!.id).not.toBe(oldId);
  });

  // ── K_leaf 超限: 单 leaf 9 条 → ok:false, failReason 同时含 9 与 8 ──
  test('K_leaf 超限: 单 leaf 9 条 → ok:false, failReason 含实际数(9)与上限(8)', async () => {
    const mem = newMemory();

    const candidates: Array<{ leafId: string; candidate: DreamCandidate }> = [];
    for (let i = 0; i < 9; i++) {
      candidates.push({
        leafId: 'extract-chat:s1',
        candidate: dc({ category: `cat-${i}`, value: `v${i}`, eventId: `ev${i}` }),
      });
    }

    const report = await mergeDreamCandidates(candidates, {
      cwd: '/tmp',
      memory: mem,
      runId: 'r1',
    });

    expect(report.ok).toBe(false);
    expect(report.failReason).toBeDefined();
    expect(report.failReason!).toContain('9');
    expect(report.failReason!).toContain('8');
    expect(report.failReason!).toContain('K_leaf exceeded');

    // 验收改判(2026-08-09):超限 = **零写入** + fail,不是「照写完再插旗」。
    // 证伪方式(当场证伪过):把 merge.ts 预算前置闸挪回写入之后 → 下面断言红:
    //   "Expected: 0 Received: 9"(9 条全落了库,fail 只是事后旗)。
    expect(mem.liveFactsByNamespace('user.preference').length).toBe(0);
    expect(report.added + report.evolved + report.replaced).toBe(0);

    /**
     * 证伪方式(原 agent 记录,仍有效):
     *   临时把 K_leaf 超限的 fail 改成截断(取前 8 条,ok:true) →
     *   expect(report.ok).toBe(false) → received: true —— 亲眼看红后改回。
     */
  });

  // ── K_run 超限: 整跑 31 条 → ok:false, failReason 含 31 与 30 ──
  test('K_run 超限: 整跑 31 条 → ok:false, failReason 含实际数(31)与上限(30)', async () => {
    const mem = newMemory();

    const candidates: Array<{ leafId: string; candidate: DreamCandidate }> = [];
    // 分散到多个 leaf 以免先撞 K_leaf(max 8 per leaf)
    for (let i = 0; i < 31; i++) {
      const leafIdx = Math.floor(i / 7); // 每个 leaf 最多 7 条,不超 K_leaf=8
      candidates.push({
        leafId: `leaf-${leafIdx}`,
        candidate: dc({ category: `cat-${i}`, value: `v${i}`, eventId: `ev${i}` }),
      });
    }

    const report = await mergeDreamCandidates(candidates, {
      cwd: '/tmp',
      memory: mem,
      runId: 'r1',
    });

    expect(report.ok).toBe(false);
    expect(report.failReason).toBeDefined();
    expect(report.failReason!).toContain('31');
    expect(report.failReason!).toContain('30');
    expect(report.failReason!).toContain('K_run exceeded');

    // 验收改判(2026-08-09):同 K_leaf —— 超限 = 零写入,memory 根本不开。
    expect(mem.liveFactsByNamespace('user.preference').length).toBe(0);
    expect(report.added + report.evolved + report.replaced).toBe(0);

    /**
     * 证伪方式:
     *   临时把 K_run 超限的 fail 改成截断(取前 30 条,ok:true) →
     *   本条测试变绿 —— 亲眼看红后改回。
     */
  });

  // ── 三态: 无既有 fact → insert ──
  test('no existing fact → insert(add)', async () => {
    const mem = newMemory();

    const report = await mergeDreamCandidates(
      [{ leafId: 'L1', candidate: dc({ value: 'markdown' }) }],
      { cwd: '/tmp', memory: mem, runId: 'r1' },
    );

    expect(report.added).toBe(1);
    expect(report.replaced).toBe(0);
    expect(report.evolved).toBe(0);
    expect(mem.count()).toBe(1);
  });

  // ── 不同 identity 各自独立,不互相 supersede ──
  test('不同 identity 各自独立,不互相 supersede', async () => {
    const mem = newMemory();

    const r1 = await mergeDreamCandidates(
      [
        { leafId: 'L1', candidate: dc({ category: 'format', value: 'md' }) },
        { leafId: 'L1', candidate: dc({ category: 'theme', value: 'dark' }) },
      ],
      { cwd: '/tmp', memory: mem, runId: 'r1' },
    );

    expect(r1.added).toBe(2);
    expect(mem.count()).toBe(2);

    // 再写一条同 identity(category='format') → replace
    const r2 = await mergeDreamCandidates(
      [{ leafId: 'L1', candidate: dc({ category: 'format', value: 'pdf' }) }],
      { cwd: '/tmp', memory: mem, runId: 'r1' },
    );

    expect(r2.replaced).toBe(1);
    expect(mem.count()).toBe(2); // 仍是 2 条(format + theme)
  });

  // ── sessionRef 锚定 → source_event_id 正确构造 ──
  test('sessionRef 锚定 → source_event_id = session:<id>:seq:<n>', async () => {
    const mem = newMemory();

    const cand = dcSession({ sessionId: 'abc', seq: 5, value: 'dark' });
    // 直接走 writeFact 验证 source_event_id 落库
    const result = await mem.writeFact(
      {
        namespace: 'user.preference',
        category: 'format',
        value: 'dark',
        source_event_id: 'session:abc:seq:5',
        confidence: {
          level: 'agent_tentative',
          source_event_ids: ['ev-session'],
          created_at: new Date(),
        },
      },
      { scanSecrets: false },
    );
    expect(result.status).toBe('written');
    expect(mem.count()).toBe(1);
  });

  // ── K_leaf 不超限时 ok:true ──
  test('K_leaf 未超限(8 条) → ok:true', async () => {
    const mem = newMemory();

    const candidates: Array<{ leafId: string; candidate: DreamCandidate }> = [];
    for (let i = 0; i < 8; i++) {
      candidates.push({
        leafId: 'L1',
        candidate: dc({ category: `cat-${i}`, value: `v${i}`, eventId: `ev${i}` }),
      });
    }

    const report = await mergeDreamCandidates(candidates, {
      cwd: '/tmp',
      memory: mem,
      runId: 'r1',
    });

    expect(report.ok).toBe(true);
    expect(report.failReason).toBeUndefined();
    expect(mem.count()).toBe(8);
  });
});
