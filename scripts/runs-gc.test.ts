/**
 * `runs-gc` 分类判据的闸(#252)。
 *
 * 这里钉的是**判序**,不是「能不能删」——因为今天这个局面就是判序错出来的:
 * 票原本的护栏是「终态 < 2 天跳过」,而 51 棵树里 **35 棵既无 runs.db 账也无 continuity**
 * (测试造的残渣),它们被年龄护栏一路豁免,于是跑得越勤积得越多,29 棵是两小时内长出来的。
 *
 * 判序必须是:LIVE → 太新 → **无账残渣** → 太年轻 → DIRTY → UNMERGED → 干净。
 * - 残渣排在「太年轻」**之前**:否则它永远轮不到被回收(今天的病根);
 * - 但排在 LIVE / 太新**之后**:一个刚起跑还没记账的 run,长得就跟残渣一模一样,
 *   把它删了就是删活人的树。
 *
 * 反向自检(实测过):
 * - 把 debris 那一支挪到 too-young 之后 ⇒ ★③ 红;
 * - 把 debris 那一支挪到 too-fresh 之前 ⇒ ★② 红;
 * - 删掉 dirty 分支(让脏树直接走 merged-clean)⇒ ★④ 红。
 */
import { describe, expect, test } from 'bun:test';
import { classify, type SurveyDeps } from './runs-gc';

const DAY = 86_400_000;
const NOW = 1_700_000_000_000;

/** 缺省 = 一棵终态很久、干净、有账、已合并的树(= merged-clean)。逐用例只翻**一个**旋钮。 */
function deps(over: Partial<SurveyDeps> = {}): SurveyDeps {
  return {
    lookupRun: () => ({ status: 'done', updatedAt: NOW - 10 * DAY }),
    hasContinuity: () => true,
    pidAlive: () => false,
    dirtyCount: () => 0,
    aheadCount: () => 0,
    isMerged: () => true,
    createdAt: () => NOW - 10 * DAY,
    now: () => NOW,
    ...over,
  };
}

describe('runs-gc 分类判序', () => {
  test('★① LIVE 压过一切 —— 脏、领先、无账都不许让它被回收', () => {
    const r = classify('r1', '/d', deps({
      lookupRun: () => ({ status: 'running' }),
      hasContinuity: () => false,   // 无账
      dirtyCount: () => 7,          // 脏
      aheadCount: () => 3,          // 领先
      isMerged: () => false,
    }));
    expect(r.category).toBe('live');
  });

  test('★① LIVE 也认「属主 pid 还活着」(status 可能还没写回盘)', () => {
    const r = classify('r1', '/d', deps({ lookupRun: () => ({ status: 'failed', ownerPid: 4242 }), pidAlive: () => true }));
    expect(r.category).toBe('live');
  });

  test('★② 刚建出来的树跳过 —— 而且这一条要压过「无账」(刚起跑的 run 长得就像残渣)', () => {
    const r = classify('r1', '/d', deps({
      hasContinuity: () => false,
      lookupRun: () => undefined,          // 无账
      createdAt: () => NOW - 60_000,       // 1 分钟前
    }));
    expect(r.category).toBe('too-fresh');
  });

  test('★③ 无账残渣**不受**年龄护栏 —— 这是今天 35 棵积起来的病根', () => {
    const r = classify('r1', '/d', deps({
      hasContinuity: () => false,
      lookupRun: () => undefined,
      createdAt: () => NOW - 2 * 3_600_000, // 两小时前, 远超 fresh 但远不到 2 天
    }));
    expect(r.category).toBe('debris');
    expect(r.hasLedgerEntry).toBe(false);
  });

  test('★③ 对照臂: 同样两小时前、但**有账** → 走年龄护栏跳过, 不当残渣删', () => {
    const r = classify('r1', '/d', deps({
      lookupRun: () => ({ status: 'done', updatedAt: NOW - 2 * 3_600_000 }),
      createdAt: () => NOW - 2 * 3_600_000,
    }));
    expect(r.category).toBe('too-young');
  });

  test('★④ 脏树走 salvage, 不许混进 merged-clean 直接删', () => {
    const r = classify('r1', '/d', deps({ dirtyCount: () => 5 }));
    expect(r.category).toBe('dirty');
    expect(r.action).toContain('salvage');
    expect(r.action).toContain('archive/run/r1');
  });

  test('★⑤ 领先 main 且未合并 → 转 tag, 不直接删支', () => {
    const r = classify('r1', '/d', deps({ aheadCount: () => 2, isMerged: () => false }));
    expect(r.category).toBe('unmerged');
    expect(r.action).toContain('archive/run/r1');
  });

  test('领先但已合并 (merge 提交在 main 上) → 干净可删', () => {
    const r = classify('r1', '/d', deps({ aheadCount: () => 2, isMerged: () => true }));
    expect(r.category).toBe('merged-clean');
  });

  test('缺省路径: 终态很久 + 干净 + 已合并 → merged-clean', () => {
    expect(classify('r1', '/d', deps()).category).toBe('merged-clean');
  });

  test('minAgeDays 可调, 且真的被读 (不是个被忽略的旋钮)', () => {
    const d = deps({ lookupRun: () => ({ status: 'done', updatedAt: NOW - 3 * DAY }) });
    expect(classify('r1', '/d', d, { minAgeDays: 2 }).category).toBe('merged-clean'); // 3 天 > 2 天 → 过关
    expect(classify('r1', '/d', d, { minAgeDays: 5 }).category).toBe('too-young');    // 3 天 < 5 天 → 拦下
  });
});

/**
 * 溢出文件回收的闸 (2026-09-02)。
 *
 * 这里钉的是**两条判据各自独立起作用**, 以及「没扫」与「扫了 0 个」分得开 —— 因为
 * 溢出文件名里**没有 runId**(只有 `<ts>-<uuid>`), 走不了 HUD 分片那条「按关联 run 终态」,
 * 只剩年龄 + 在飞下限这两条。少任何一条都会静默出错:
 * - 只有年龄 ⇒ 真跑超 24h 的 run 被删掉自己上下文里引用的全文路径(leaf 读 ENOENT);
 * - 只有下限 ⇒ runs.db 缺席时(no-db)一刀切全删。
 *
 * 反向自检(实测过):
 * - 摘掉 `decideSpillSweep` 的 `live-window` 那一句 ⇒ ★S3 红;
 * - 摘掉 `too-fresh` 那一句 ⇒ ★S1 红;
 * - 把 `dirPresent` 恒设 true(让「没扫」冒充「扫了 0 个」)⇒ ★S6 红。
 */
import {
  SPILL_GRACE_MS,
  decideSpillSweep,
  formatSpillReport,
  parseSpillName,
  sweepSpillFiles,
  type SpillLiveFloor,
  type SpillSweepDeps,
} from './runs-gc';

const HOUR = 3_600_000;
const UUID = '0123abcd-0000-4000-8000-0123456789ab';
const OLD = NOW - 10 * DAY;

function spillDeps(over: Partial<SpillSweepDeps> = {}): SpillSweepDeps {
  return {
    listOmdDir: () => [`tool-result-${OLD}-${UUID}.txt`],
    bytesOf: () => 1_000_000,
    remove: () => {},
    liveFloor: () => ({ kind: 'none-live' }),
    now: () => NOW,
    ...over,
  };
}

describe('溢出文件回收 · 判据', () => {
  test('★S1 太新一律不动 —— 哪怕一个在飞的 run 都没有', () => {
    const fresh = NOW - (SPILL_GRACE_MS - HOUR);
    expect(decideSpillSweep(fresh, NOW, { kind: 'none-live' })).toBe('too-fresh');
  });

  test('★S2 够老 + 库缺席 ⇒ 只有年龄判据生效, 照删 (no-db ≠ 没有在飞的 run, 但也不能因此永不回收)', () => {
    expect(decideSpillSweep(OLD, NOW, { kind: 'no-db' })).toBe('sweep');
  });

  test('★S3 够老但在飞下限比它更早 ⇒ 留着 —— 这份可能正是某个在飞 run 上下文里引用的全文', () => {
    const floor: SpillLiveFloor = { kind: 'floor', ms: OLD - HOUR };
    expect(decideSpillSweep(OLD, NOW, floor)).toBe('live-window');
  });

  test('★S4 够老且所有在飞 run 都在它之后才起跑 ⇒ 不可能属于任何在飞 run, 删', () => {
    const floor: SpillLiveFloor = { kind: 'floor', ms: OLD + HOUR };
    expect(decideSpillSweep(OLD, NOW, floor)).toBe('sweep');
  });

  test('★S5 只认这两种命名, 别人的文件不归本格管', () => {
    expect(parseSpillName(`tool-result-${OLD}-${UUID}.txt`)).toEqual({ kind: 'tool-result', tsMs: OLD });
    expect(parseSpillName(`bash-output-${OLD}-${UUID}.log`)).toEqual({ kind: 'bash-output', tsMs: OLD });
    expect(parseSpillName('runs.db')).toBeNull();
    expect(parseSpillName(`tool-result-${OLD}-${UUID}.log`)).toBeNull(); // 后缀对不上 = 不是它
  });
});

describe('溢出文件回收 · 扫描与报数', () => {
  test('★S6 目录缺席 = 没扫, 与「扫了 0 个」是两件事 (NULL ≠ 0)', () => {
    const missing = sweepSpillFiles(spillDeps({ listOmdDir: () => null }));
    const empty = sweepSpillFiles(spillDeps({ listOmdDir: () => [] }));
    expect(missing.dirPresent).toBe(false);
    expect(empty.dirPresent).toBe(true);
    expect(missing.scanned).toBe(0);
    expect(empty.scanned).toBe(0);
    // 两格的报数行必须念得出区别, 否则「账坏了」会被读成「干净」。
    expect(formatSpillReport(missing, false)).not.toBe(formatSpillReport(empty, false));
    expect(formatSpillReport(missing, false)).toContain('没扫');
  });

  test('★S7 不是溢出文件的连 scanned 都不计', () => {
    const r = sweepSpillFiles(spillDeps({ listOmdDir: () => ['runs.db', 'hud', 'continuity'] }));
    expect(r.scanned).toBe(0);
    expect(r.swept).toHaveLength(0);
  });

  test('★S8 缺省只报数不删; --apply 才真调 remove', () => {
    const removed: string[] = [];
    const dry = sweepSpillFiles(spillDeps({ remove: (n) => removed.push(n) }), { dryRun: true });
    expect(dry.swept).toHaveLength(1);
    expect(removed).toEqual([]);

    const wet = sweepSpillFiles(spillDeps({ remove: (n) => removed.push(n) }), { dryRun: false });
    expect(wet.swept).toHaveLength(1);
    expect(removed).toEqual([`tool-result-${OLD}-${UUID}.txt`]);
  });

  test('★S9 留下的按理由分列, 不合并成一个「跳过 N 个」', () => {
    const r = sweepSpillFiles(
      spillDeps({
        listOmdDir: () => [
          `tool-result-${NOW - HOUR}-${UUID}.txt`, // 太新
          `bash-output-${OLD}-${UUID}.log`, // 在飞窗
        ],
        liveFloor: () => ({ kind: 'floor', ms: OLD - HOUR }),
      }),
      { dryRun: true },
    );
    expect(r.scanned).toBe(2);
    expect(r.kept).toEqual({ 'too-fresh': 1, 'live-window': 1 });
    expect(r.swept).toHaveLength(0);
  });

  test('★S10 删失败进 failed 带证据, 不冒充删成功 (fail-open 不吞证据)', () => {
    const r = sweepSpillFiles(
      spillDeps({
        remove: () => {
          throw new Error('EACCES: 只读挂载');
        },
      }),
      { dryRun: false },
    );
    expect(r.swept).toHaveLength(0);
    expect(r.failed).toHaveLength(1);
    expect(r.failed[0]!.note).toContain('EACCES');
    expect(formatSpillReport(r, true)).toContain('删失败 1');
  });
});
