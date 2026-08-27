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
 * 判据换成 **git 可查的证据**:契约落盘之后,本片写集里的文件被动过没有。
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
  type ExecGit,
} from './slice-delivery';

const ev = (p: Partial<SliceGitEvidence>): SliceGitEvidence => ({
  available: true,
  commitsTouchingWriteSet: 0,
  dirtyWriteSetFiles: 0,
  ...p,
});

describe('GREEN_VERIFY_DISAMBIGUATED:活已干完 vs 判据虚', () => {
  test('★ 契约落盘后有提交动过写集 → 活已干完', () => {
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
 * git 替身。**两次 `log` 按调用序给不同输出** —— 第 1 次是查契约落盘点,第 2 次是数
 * 落盘点之后动过写集的提交。给同一份输出的话,这组测试就分不出两跳被写反了
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

  test('★ 落盘点之后有提交动过写集 → 计数带出来', () => {
    const ev = collectSliceGitEvidence('docs/plan/x.md', WS, fakeGit({
      birth: { stdout: 'shaNEW\nshaOLD\n', exitCode: 0 },      // 落盘点 = 最后一行 shaOLD
      since: { stdout: 'c1\nc2\nc3\n', exitCode: 0 },          // 之后 3 个提交动过写集
      status: { stdout: ' M src/a.ts\n', exitCode: 0 },
    }));
    expect(ev.available).toBe(true);
    expect(ev.commitsTouchingWriteSet).toBe(3);
    expect(ev.dirtyWriteSetFiles).toBe(1);
    expect(explainGreenVerify(ev).kind).toBe('already-delivered');
  });

  test('★ 契约还没提交 (查不到落盘点) → 仍可用, 只靠脏文件数判', () => {
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
