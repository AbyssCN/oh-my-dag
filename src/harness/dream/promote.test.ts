/**
 * src/harness/dream/promote.test.ts —— SDD §S3 晋升 + prune 阶梯的 fixture 驱动测试(零 LLM)。
 *
 * 判据(冻结,SDD §S3 行 293-300):
 *   1. **human_verified 不可达 = 编译期闸**(裁决 10):结构性断言 promote 写入口类型
 *      `PromoteFactInput['confidence']['level']` 是字面量 `'agent_confident'`。
 *      **不写**运行时遍历所有 fact 断言 `level !== 'human_verified'` —— 那条证伪不出
 *      反例,是虚闸(SDD 行 294-296 已裁)。
 *   2. **晋升阶梯**:2 条证据(2 个不同 session)→ 仍 tentative;+ 第 3 条(第 3 个 source)
 *      → agent_confident 且 `isExpired` 恒 false;反向自检:3 条证据**同 source** → 不晋升。
 *   3. **TTL 边界**:30d+1ms → prune +1;恰 30d → 不清(`isExpired` 严格 `>`,
 *      evolution-lock.ts 头注已钉)。
 *
 * 证伪义务(每条当场证伪一次:真改坏、亲眼看红、记录报错文本、改回;实测记录见文件尾):
 *   - 判据 1:临时把 `PromoteConfidence.level` 放宽成 `string` → tsc 红在 `_levelGate`
 *     赋值(实测:`error TS2322: Type 'true' is not assignable to type 'false'.`)→ 改回。
 *   - 判据 2:临时把 `shouldPromote` 的 evidence.length 阈值改成 `>= 2` → 「证据数
 *     < N_repro → false」用例红(实测:Expected: false / Received: true)→ 改回。
 *   - 判据 3:临时把 promote 的 prune 调用改成 `memory.prune(new Date(now.getTime() + 1))`
 *     (时钟 +1ms)→ 「恰 30d 不清」用例红(prune 计数变 1)→ 改回。
 */
import { describe, expect, test } from 'bun:test';
import { createOmdMemory, type OmdMemory } from '../memory';
import { UNIVERSAL_SAFEGUARD } from '../../memory/safeguards/universal-namespaces';
import { isExpired, TENTATIVE_TTL_DAYS } from '../../memory/safeguards/evolution-lock';
import {
  promoteDreamFacts,
  promoteFactInput,
  sourceGroupOf,
  shouldPromote,
  N_sessions,
  N_repro,
  type PromoteFactInput,
} from './promote';

const TTL_MS = TENTATIVE_TTL_DAYS * 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// 判据 1:human_verified 不可达 = 编译期闸(裁决 10)
// ---------------------------------------------------------------------------

// 结构性断言:promote 写入口的 level 字段是字面量 'agent_confident' —— 类型收窄存在,
// 联合类型里根本没有 human_verified。若有人把 PromoteConfidence.level 放宽成
// string/union(比如塞进 human_verified),下面赋值在 tsc --noEmit 下红(实测记录见文件尾)。
type _PromoteLevel = PromoteFactInput['confidence']['level'];
const _levelGate: _PromoteLevel extends 'agent_confident' ? true : false = true;

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

/** 创建新的内存库(隔离)。 */
function newMemory(): OmdMemory {
  return createOmdMemory({ path: ':memory:', safeguard: UNIVERSAL_SAFEGUARD });
}

/** 预写一条 tentative fact(user.preference,同 identity: category='format')。 */
async function writeTentative(
  mem: OmdMemory,
  opts: { sessionId: string; seq: number; value?: string; createdAt?: Date },
): Promise<void> {
  const res = await mem.writeFact(
    {
      namespace: 'user.preference',
      category: 'format',
      value: opts.value ?? 'markdown',
      source_event_id: `session:${opts.sessionId}:seq:${opts.seq}`,
      confidence: {
        level: 'agent_tentative',
        source_event_ids: [`session:${opts.sessionId}:seq:${opts.seq}`],
        created_at: opts.createdAt ?? new Date(),
      },
    },
    { scanSecrets: false },
  );
  expect(res.status).toBe('written');
}

// ---------------------------------------------------------------------------
// sourceGroupOf —— S2 anchor 格式反解(具名纯函数,判据 2 的判别基础)
// ---------------------------------------------------------------------------

describe('sourceGroupOf —— S2 anchor 格式反解(具名纯函数,不散在调用点)', () => {
  test('session anchor → session:<id>', () => {
    expect(sourceGroupOf('session:s1:seq:1')).toBe('session:s1');
    expect(sourceGroupOf('session:long-id-abc:seq:42')).toBe('session:long-id-abc');
  });

  test('run anchor(带/不带 node)→ run:<id>', () => {
    expect(sourceGroupOf('run:r1')).toBe('run:r1');
    expect(sourceGroupOf('run:r1:node:synth')).toBe('run:r1');
  });

  test('解析不出 → null(不计入跨 source 判据)', () => {
    expect(sourceGroupOf('session:s1')).toBeNull(); // 缺 :seq:<n>
    expect(sourceGroupOf('run:r1:node:')).toBeNull(); // node 后空段
    expect(sourceGroupOf('garbage')).toBeNull();
    expect(sourceGroupOf('')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// shouldPromote —— 晋升判据纯函数(两条同时)
// ---------------------------------------------------------------------------

describe('shouldPromote —— 晋升判据(两条同时,SDD §S3 行 279-282)', () => {
  test('≥N_repro 证据且 ≥N_sessions 个不同 source → true', () => {
    expect(shouldPromote(['session:s1:seq:1', 'session:s2:seq:1', 'session:s3:seq:1'])).toBe(true);
    // session + run 混合也算不同 source
    expect(shouldPromote(['session:s1:seq:1', 'run:r1', 'run:r2'])).toBe(true);
  });

  test('证据数 < N_repro → false', () => {
    expect(shouldPromote(['session:s1:seq:1', 'session:s2:seq:1'])).toBe(false);
    expect(shouldPromote([])).toBe(false);
  });

  test('反向自检:≥N_repro 证据但同 source → false(防「同会话反复说三遍」)', () => {
    expect(shouldPromote(['session:s1:seq:1', 'session:s1:seq:2', 'session:s1:seq:3'])).toBe(false);
    expect(shouldPromote(['run:r1', 'run:r1:node:a', 'run:r1:node:b'])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// promoteFactInput —— 晋升写入口(判据 1 编译期闸的运行时侧)
// ---------------------------------------------------------------------------

describe('promoteFactInput —— 同 identity 构造,confidence 换 agent_confident', () => {
  test('payload/anchor 原样,confidence.source_event_ids = evidence 全集', async () => {
    const mem = newMemory();
    await writeTentative(mem, { sessionId: 's1', seq: 1 });

    const live = mem.liveFactsByNamespace('user.preference');
    expect(live.length).toBe(1);
    const input = promoteFactInput(
      live[0]!.fact,
      ['session:s1:seq:1', 'session:s2:seq:1', 'session:s3:seq:1'],
      new Date('2026-08-09T00:00:00Z'),
    );

    expect(input.namespace).toBe('user.preference');
    expect(input.category).toBe('format');
    expect(input.value).toBe('markdown');
    expect(input.source_event_id).toBe('session:s1:seq:1'); // anchor 保留原 fact 的
    expect(input.confidence.level).toBe('agent_confident');
    expect(input.confidence.source_event_ids).toEqual([
      'session:s1:seq:1',
      'session:s2:seq:1',
      'session:s3:seq:1',
    ]);
    expect(input.confidence.created_at).toEqual(new Date('2026-08-09T00:00:00Z'));
  });
});

// ---------------------------------------------------------------------------
// promoteDreamFacts —— 晋升阶梯(判据 2)+ TTL 边界(判据 3)
// ---------------------------------------------------------------------------

describe('promoteDreamFacts —— 晋升阶梯(SDD §S3 判据 2)', () => {
  test('2 条证据(2 个不同 session)→ 仍 tentative;+ 第 3 条(第 3 个 session)→ agent_confident 且 isExpired 恒 false', async () => {
    const mem = newMemory();

    await writeTentative(mem, { sessionId: 's1', seq: 1 });
    await writeTentative(mem, { sessionId: 's2', seq: 1 });

    const r2 = await promoteDreamFacts({ cwd: '/tmp', memory: mem });
    expect(r2.promoted).toBe(0);

    const live2 = mem.liveFactsByNamespace('user.preference');
    expect(live2.length).toBe(1);
    expect(live2[0]!.fact.confidence.level).toBe('agent_tentative');

    // 第 3 条证据(第 3 个 source)
    await writeTentative(mem, { sessionId: 's3', seq: 1 });

    const r3 = await promoteDreamFacts({ cwd: '/tmp', memory: mem });
    expect(r3.promoted).toBe(1);

    const live3 = mem.liveFactsByNamespace('user.preference');
    expect(live3.length).toBe(1); // 旧 tentative 行 tombstone,新 confident 行 live
    const f = live3[0]!.fact;
    expect(f.confidence.level).toBe('agent_confident');
    if (f.confidence.level === 'agent_confident') {
      expect(f.confidence.source_event_ids).toEqual([
        'session:s1:seq:1',
        'session:s2:seq:1',
        'session:s3:seq:1',
      ]);
    }
    // isExpired 对它恒 false(agent_confident 不进 TTL 规则)
    expect(isExpired(f)).toBe(false);
  });

  test('反向自检:3 条证据同 source(同 session 不同 seq)→ 不晋升', async () => {
    const mem = newMemory();
    await writeTentative(mem, { sessionId: 's1', seq: 1 });
    await writeTentative(mem, { sessionId: 's1', seq: 2 });
    await writeTentative(mem, { sessionId: 's1', seq: 3 });

    const r = await promoteDreamFacts({ cwd: '/tmp', memory: mem });
    expect(r.promoted).toBe(0);

    const live = mem.liveFactsByNamespace('user.preference');
    expect(live[0]!.fact.confidence.level).toBe('agent_tentative');
  });
});

describe('promoteDreamFacts —— TTL 边界(SDD §S3 判据 3,isExpired 严格 >)', () => {
  test('30d + 1ms → prune +1', async () => {
    const mem = newMemory();
    const now = new Date('2026-08-09T00:00:00Z');
    await writeTentative(mem, {
      sessionId: 's1',
      seq: 1,
      createdAt: new Date(now.getTime() - TTL_MS - 1),
    });

    const r = await promoteDreamFacts({ cwd: '/tmp', memory: mem, now });
    expect(r.pruned).toBe(1);
    expect(mem.count()).toBe(0); // tombstone 后无 live
  });

  test('恰 30d → 不清(严格 >,evolution-lock 头注已钉)', async () => {
    const mem = newMemory();
    const now = new Date('2026-08-09T00:00:00Z');
    await writeTentative(mem, {
      sessionId: 's1',
      seq: 1,
      createdAt: new Date(now.getTime() - TTL_MS),
    });

    const r = await promoteDreamFacts({ cwd: '/tmp', memory: mem, now });
    expect(r.pruned).toBe(0);
    expect(mem.count()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 证伪实测记录(每条当场证伪一次:真改坏、亲眼看红、改回;报错文本逐字):
//
// 1. 判据 1(human_verified 不可达 = 编译期闸):
//    临时把 PromoteConfidence.level 放宽成 `string`,跑 `bunx tsc --noEmit` →
//    promote.test.ts(46,7) 红:
//      `error TS2322: Type 'true' is not assignable to type 'false'.`
//    (定位 `_levelGate` 赋值 —— 结构性断言生效;放宽成 string 后 `string extends
//    'agent_confident'` 为 false,gate 类型变 false,赋值 true 报错)。改回
//    `'agent_confident'` → tsc 绿。⇒ 闸不是虚的:放宽类型它当场红。
//
// 2. 判据 2(晋升阶梯):
//    临时把 shouldPromote 的 `evidence.length < N_repro` 改成 `evidence.length < N_repro - 1`
//    (等效阈值 2),跑 promote.test.ts →
//    「证据数 < N_repro → false」用例红(shouldPromote 对 2 条证据误返 true):
//      `expect(received).toBe(expected)` / Expected: false / Received: true
//    ⇒ 阈值降 2 当场被抓住(2 条证据被误判可晋升)。改回 → 绿。
//
// 3. 判据 3(TTL 边界):
//    临时把 promote 的 prune 调用改成 `memory.prune(new Date(now.getTime() + 1))`(时钟
//    +1ms),跑 promote.test.ts →
//    「恰 30d → 不清」用例红:
//      `expect(received).toBe(expected)` / Expected: 0 / Received: 1 (r.pruned)
//    ⇒ 边界 +1ms 即误清,判据 3 当场抓住。改回 → 绿。
//
// 3. 判据 3(TTL 边界):
//    临时把 promote 的 prune 调用改成 `memory.prune(new Date(now.getTime() + 1))`(时钟
//    +1ms),跑 promote.test.ts →
//    「恰 30d → 不清」用例红:
//      `expect(received).toBe(expected)` / Expected: 0 / Received: 1 (r.pruned)
//    ⇒ 边界 +1ms 即误清,判据 3 当场抓住。改回 → 绿。
// ---------------------------------------------------------------------------
