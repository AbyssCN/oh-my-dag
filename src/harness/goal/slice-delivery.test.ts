/**
 * 切片交付判定 —— 「verify 实装前就绿」到底是**判据虚**还是**活已干完**(修复方向一,2026-08-28)。
 *
 * ## 病灶(实账)
 *
 * `run-goal.ts` 的 O-6 探针今天拿 `config.dag.continuity?.resume === true` 当
 * 「这活可能已经干过」的**代理**。票 #242 当时就是这么修的,而那次的场景确实只有 resume。
 *
 * **但代理选窄了。** 活已经干完的原因不止 resume 一种:人手做的、另一个窗口做的、
 * 上一跑用别的 runId 做的。2026-08-28 实测:F2 的片 1–3 由人做完提交之后,
 * 拿母契约点火被 `o6-vacuous-verify` 整图拒 —— 判词逐字「RED 无法成立 —— 判据虚 或 **活已干完**」。
 * 闸自己把两种可能都写在判词里了,却没有任何东西去分辨它们。
 *
 * ## 本模块只做那一次分辨
 *
 * 判据换成 **git 可查的证据**:契约入库之后,本片写集里的文件被动过没有。
 * · 动过 → 活已干完(交付过);
 * · 没动过 → 判据是虚的(它在任何代码下都绿);
 * · 证据取不到 → **不许当成任何一种**(仓规坑 ①:`NULL` ≠ 0 ≠ 不适用)。
 *
 * ⚠ **零 IO**:git 证据是**入参**不是本模块去取的。取证据那一半在调用方,
 * 这样测试能造出「非 git 仓」「git 调用失败」这些拿真仓造不出来的格。
 *
 * ## 反向自检(每条真跑过一次)
 * · 把「证据取不到」那一格改成返回 `already-delivered` → 「取不到时不许当成交付」当场红。
 * · 把「没动过」那一格也返回 `already-delivered` → 「判据虚仍要拒」当场红(闸整个失效)。
 * · 把未提交改动那一路去掉(只看提交)→ 「人刚做完还没提交也算交付」当场红。
 */
import { describe, expect, test } from 'bun:test';
import {
  explainGreenVerify,
  collectSliceGitEvidence,
  type SliceGitEvidence,
  decideO6,
  type ExecGit,
  type SliceProbe,
} from './slice-delivery';

const ev = (p: Partial<SliceGitEvidence>): SliceGitEvidence => ({
  resuming: false,
  available: true,
  commitsTouchingWriteSet: 0,
  dirtyWriteSetFiles: 0,
  ...p,
});

describe('GREEN_VERIFY_DISAMBIGUATED:活已干完 vs 判据虚', () => {
  test('★ 契约入库后有提交动过写集 → 活已干完', () => {
    const v = explainGreenVerify(ev({ commitsTouchingWriteSet: 2 }));
    expect(v.kind).toBe('already-delivered');
    expect(v.why).toContain('2');
  });

  test('★ 写集有未提交改动 → 同样算干完 (人刚做完还没提交是最常见的一格)', () => {
    // 只看提交会把「刚做完还没 commit」误判成判据虚, 而那正是人机混做时的常态。
    const v = explainGreenVerify(ev({ dirtyWriteSetFiles: 3 }));
    expect(v.kind).toBe('already-delivered');
  });

  test('★ 写集一次没被动过 → 判据是虚的, 照旧拒 (O-6 该抓的正是这一格)', () => {
    const v = explainGreenVerify(ev({}));
    expect(v.kind).toBe('vacuous-criterion');
    expect(v.why.length).toBeGreaterThan(0);
  });

  test('★ 证据取不到 → undetermined, **不许**当成交付 (NULL ≠ 0 ≠ 不适用)', () => {
    const v = explainGreenVerify(ev({ available: false, commitsTouchingWriteSet: 0 }));
    expect(v.kind).toBe('undetermined');
    // 改成 already-delivered 时这条红 —— 那会让非 git 仓里所有虚判据一路放行。
    expect(v.kind).not.toBe('already-delivered');
  });

  test('★ 证据取不到时,即使计数非零也不认 (取不到就是取不到, 别读残值)', () => {
    // available:false 时那两个计数没有意义 —— 读它们等于把「没测量」当「测量结果是 0/N」。
    expect(explainGreenVerify(ev({ available: false, commitsTouchingWriteSet: 9 })).kind)
      .toBe('undetermined');
  });

  test('★ 三格互斥且都到得了 —— 一个在任何输入下都不动的谓词量的是尺子', () => {
    const kinds = [
      explainGreenVerify(ev({ commitsTouchingWriteSet: 1 })).kind,
      explainGreenVerify(ev({})).kind,
      explainGreenVerify(ev({ available: false })).kind,
    ];
    expect(new Set(kinds).size).toBe(3);
  });
});

describe('GREEN_VERIFY_DISAMBIGUATED:调用方该怎么处置这三格', () => {
  test('★ 只有 already-delivered 才允许跳过该片;另两格一律拒', () => {
    const cases: Array<[SliceGitEvidence, boolean]> = [
      [ev({ commitsTouchingWriteSet: 1 }), true],
      [ev({ dirtyWriteSetFiles: 1 }), true],
      [ev({}), false],
      [ev({ available: false }), false],
    ];
    for (const [e, maySkip] of cases) {
      expect(explainGreenVerify(e).kind === 'already-delivered').toBe(maySkip);
    }
  });

  test('★ 每一格都带非空判词 —— 拒了要说得出为什么 (不吞证据)', () => {
    for (const e of [ev({ commitsTouchingWriteSet: 1 }), ev({}), ev({ available: false })]) {
      expect(explainGreenVerify(e).why.length).toBeGreaterThan(0);
    }
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// 取证据那一半 —— 注入式 exec,造得出真仓造不出来的格
// ──────────────────────────────────────────────────────────────────────────────
/**
 * git 替身。**两次 `log` 按调用序给不同输出** —— 第 1 次是查契约入库点,第 2 次是数
 * 入库点之后动过写集的提交。给同一份输出的话,这组测试就分不出两跳被写反了
 * (那正是它该有的判别力:替身分不出的东西,测试也判不出)。
 */
const fakeGit = (t: {
  birth?: { stdout: string; exitCode: number };
  since?: { stdout: string; exitCode: number };
  status?: { stdout: string; exitCode: number };
}): ExecGit => {
  let logCalls = 0;
  const fail = { stdout: '', exitCode: 128 };
  return (args) => {
    if (args[0] === 'log') return (logCalls++ === 0 ? t.birth : t.since) ?? fail;
    if (args[0] === 'status') return t.status ?? fail;
    return fail; // 调了不该调的 git 子命令
  };
};

describe('GREEN_VERIFY_DISAMBIGUATED:取证据(注入式)', () => {
  const WS = ['src/a.ts', 'src/a.test.ts'];

  test('★ 入库点之后有提交动过写集 → 计数带出来', () => {
    const ev = collectSliceGitEvidence('docs/plan/x.md', WS, fakeGit({
      birth: { stdout: 'shaNEW\nshaOLD\n', exitCode: 0 },      // 入库点 = 最后一行 shaOLD
      since: { stdout: 'c1\nc2\nc3\n', exitCode: 0 },          // 之后 3 个提交动过写集
      status: { stdout: ' M src/a.ts\n', exitCode: 0 },
    }));
    expect(ev.available).toBe(true);
    expect(ev.commitsTouchingWriteSet).toBe(3);
    expect(ev.dirtyWriteSetFiles).toBe(1);
    expect(explainGreenVerify(ev).kind).toBe('already-delivered');
  });

  test('★ 契约还没提交 (查不到入库点) → 仍可用, 只靠脏文件数判', () => {
    const ev = collectSliceGitEvidence('docs/plan/x.md', WS, fakeGit({
      birth: { stdout: '', exitCode: 0 },
      status: { stdout: '?? src/a.ts\n M src/a.test.ts\n', exitCode: 0 },
    }));
    expect(ev.available).toBe(true);
    expect(ev.commitsTouchingWriteSet).toBe(0);
    expect(ev.dirtyWriteSetFiles).toBe(2);
  });

  test('★ git 调用失败 (非 git 仓) → available:false, 计数不编 (NULL ≠ 0)', () => {
    const ev = collectSliceGitEvidence('docs/plan/x.md', WS, fakeGit({}));
    expect(ev.available).toBe(false);
    expect(explainGreenVerify(ev).kind).toBe('undetermined');
  });

  test('★ 空写集 → available:false (没有可查的证据面)', () => {
    expect(collectSliceGitEvidence('docs/plan/x.md', [], fakeGit({
      birth: { stdout: 'sha1\n', exitCode: 0 }, status: { stdout: '', exitCode: 0 },
    })).available).toBe(false);
  });

  test('★ 干净且无新提交 → 判据虚 (端到端走通两半)', () => {
    const ev = collectSliceGitEvidence('docs/plan/x.md', WS, fakeGit({
      birth: { stdout: '', exitCode: 0 },
      status: { stdout: '', exitCode: 0 },
    }));
    expect(explainGreenVerify(ev).kind).toBe('vacuous-criterion');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// decideO6 —— 取代 run-goal.ts 里那句 `if (resuming)` 的具名决定
// ──────────────────────────────────────────────────────────────────────────────
const sl = (id: number, verifyGreen: boolean): SliceProbe =>
  ({ id, verify: `bun test s${id}.test.ts`, writeSet: [`src/s${id}.ts`], verifyGreen });

describe('GREEN_VERIFY_DISAMBIGUATED:decideO6 —— 整图放行还是点名拒', () => {
  const delivered = ev({ commitsTouchingWriteSet: 1 });
  const vacuous = ev({});
  const unknown = ev({ available: false });

  test('★ 全部天然红 → 放行, 一片都不跳过 (O-6 前提成立的正常路径)', () => {
    const d = decideO6([sl(1, false), sl(2, false)], () => vacuous);
    expect(d.kind).toBe('proceed');
    if (d.kind === 'proceed') {
      expect(d.achieved.size).toBe(0);
      expect(d.notes).toHaveLength(0);
      // 天然红的片**不该去查 git** —— 那一格没有可争的。用 vacuous 当证据仍放行即证明没查。
    }
  });

  test('★ 已绿且写集动过 → 放行并把该片标已达成, 且留一条痕', () => {
    const d = decideO6([sl(1, true), sl(2, false)], () => delivered);
    expect(d.kind).toBe('proceed');
    if (d.kind === 'proceed') {
      expect([...d.achieved]).toEqual([1]);
      expect(d.notes).toHaveLength(1);
      expect(d.notes[0]).toContain('切片 1');
    }
  });

  test('★ 已绿而写集没动过 → 点名拒, 判词带上那条 verify 与原因', () => {
    const d = decideO6([sl(1, true)], () => vacuous);
    expect(d.kind).toBe('reject');
    if (d.kind === 'reject') {
      expect(d.sliceId).toBe(1);
      // ⚠ 判词标记 `[run-goal][o6-vacuous-verify]` 由**抛出方**前置, 不在这里 ——
      // 有条源码扫描绊线钉着那个字面量必须出现在 run-goal.ts 里 (gates/o6-vacuous-verify.gate.test.ts)。
      // 把它挪进本模块会让那条绊线红, 那是它该红 (它守的是「闸的判词认得出来自哪」)。
      expect(d.message).not.toContain('o6-vacuous-verify');
      expect(d.message).toContain('bun test s1.test.ts');
      expect(d.message).toContain('一次没被动过');
    }
  });

  test('★ 证据取不到 → 同样拒, 但判词说的是「没能去看」不是「判据虚」', () => {
    const d = decideO6([sl(1, true)], () => unknown);
    expect(d.kind).toBe('reject');
    if (d.kind === 'reject') expect(d.message).toContain('没能去看');
  });

  test('★ fail-fast:第一片判拒就整体拒, 不接着看后面的 (与今天语义逐字相同)', () => {
    const seen: number[] = [];
    const d = decideO6([sl(1, true), sl(2, true)], (s) => {
      seen.push(s.id);
      return vacuous;
    });
    expect(d.kind).toBe('reject');
    expect(seen).toEqual([1]); // 看了第 2 片即说明不是 fail-fast
  });

  test('★ 混合:一片已交付一片天然红 → 放行, 只跳过交付那片', () => {
    const d = decideO6([sl(1, true), sl(2, false)], (s) => (s.id === 1 ? delivered : vacuous));
    expect(d.kind).toBe('proceed');
    if (d.kind === 'proceed') expect([...d.achieved]).toEqual([1]);
  });
});

describe('GREEN_VERIFY_DISAMBIGUATED:resuming 是并列的第二条证据源, 不是被取代的代理', () => {
  test('★ 续跑 + verify 已绿 → 已交付, 且**不依赖 git** (#242 的原路径逐字保留)', () => {
    // 非 git 仓 (available:false) 下仍判已交付 —— #242 那份回归用例正是跑在临时目录里。
    const v = explainGreenVerify(ev({ resuming: true, available: false }));
    expect(v.kind).toBe('already-delivered');
    expect(v.why).toContain('#242');
  });

  test('★ resuming 先于 available 判 —— 顺序反了就把 #242 修回病态', () => {
    // 2026-08-28 实测: 我一度把 resuming 整个删掉换成 git 证据, run-goal-o6-resume 当场红
    // (Expected 1, Received 0 —— 平铺图没编出来, 回落了)。测试是对的, 改动不完整。
    expect(explainGreenVerify(ev({ resuming: true, available: false })).kind)
      .not.toBe('undetermined');
  });

  test('★ 非续跑时 resuming 不掺和, 三格照旧由 git 证据定', () => {
    expect(explainGreenVerify(ev({ resuming: false, commitsTouchingWriteSet: 1 })).kind).toBe('already-delivered');
    expect(explainGreenVerify(ev({ resuming: false })).kind).toBe('vacuous-criterion');
    expect(explainGreenVerify(ev({ resuming: false, available: false })).kind).toBe('undetermined');
  });
});
