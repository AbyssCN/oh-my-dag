/**
 * D5a 片 3 —— 编译闸宽容 (INV-4: base ∪ 全部语言包 bins 并集在编译期放行)。
 *
 * 契约 GWT:
 *   · GWT-5: verify 串 `pytest tests/x.py` 过 assertRunnable 不抛; `frobnicate x` 仍抛。
 *
 * 测的判据 = 「编译器不再因白名单拒 `pytest`」, 端到端: `compileBreakdown(bd(slice with verify))`
 * 不抛 / 抛。这条闸的真源 = `src/harness/goal/sdd-compile.ts` 的 COMPILE_ALLOWLIST
 * (base ∪ LANGUAGE_PACKS 全部 bins), 与 `command-leaf.ts` 共用 LANGUAGE_PACKS, 不另抄一份。
 *
 * 反向自检 (证伪方式写在 test 注释):
 *   · 删掉 assertRunnable 里的 COMPILE_ALLOWLIST 检查 → GWT-5 通过的那条红。
 *   · 把 COMPILE_ALLOWLIST 收回只读 base → GWT-5 通过的那条红 (`pytest` 不在 base)。
 *   · 在 LANGUAGE_PACKS 里加 `frobnicate` → GWT-5 拒的那条红 (测的是「只到已注册包」, 不是「放开任意词」)。
 */
import { describe, expect, test } from 'bun:test';
import { compileBreakdown } from './sdd-compile';
import type { SddBreakdown } from './sdd-direct';

const FULL_REGRESSION = 'bunx tsc --noEmit && bun test';

const bd = (slices: SddBreakdown['slices']): SddBreakdown => ({ slices });
const slice = (id: number, over: string[], verify: string): SddBreakdown['slices'][number] => ({
  id,
  name: `切片 ${id}`,
  writeSet: over,
  deps: [],
  verify,
});

describe('compileBreakdown × assertRunnable — 编译闸宽容 (D5a, D-3, INV-4)', () => {
  test('GWT-5: pytest verify 不被白名单拒 (python 包 bin)', () => {
    // 证伪: 把 COMPILE_ALLOWLIST 退回只读 DEFAULT_COMMAND_ALLOWLIST → 本条红 (pytest 不在 base)。
    const ok = bd([slice(1, ['src/x.py'], 'pytest tests/x.py')]);
    expect(() => compileBreakdown(ok, { acceptCommand: FULL_REGRESSION })).not.toThrow();
  });

  test('GWT-5: cargo verify 不被白名单拒 (rust 包 bin)', () => {
    const ok = bd([slice(1, ['src/lib.rs'], 'cargo test --no-run')]);
    expect(() => compileBreakdown(ok, { acceptCommand: FULL_REGRESSION })).not.toThrow();
  });

  test('GWT-5: go test verify 不被白名单拒 (go 包 bin)', () => {
    const ok = bd([slice(1, ['src/x.go'], 'go test ./...')]);
    expect(() => compileBreakdown(ok, { acceptCommand: FULL_REGRESSION })).not.toThrow();
  });

  test('GWT-5: 未注册词仍被拒 (frobnicate 不在任何语言包)', () => {
    // 证伪: 在 LANGUAGE_PACKS 里加 `frobnicate` → 本条红。测的是「宽容面只到已注册包」,
    // 不是「放开任意词」。这把 D-4 的安全边界 (包表只收验证/构建类只读向 bin) 钉在了编译闸上。
    const bad = bd([slice(1, ['src/x.ts'], 'frobnicate x')]);
    expect(() => compileBreakdown(bad, { acceptCommand: FULL_REGRESSION })).toThrow(/白名单/);
  });

  test('GWT-5: accept 命令首词为 pytest 也过 (全量回归里夹跨生态 verify)', () => {
    // SDD 跨生态通用: 全量回归命令可能本身就是 pytest/ cargo test 链 (典型 Python 仓)。
    // 编译闸对 accept 命令一视同仁。
    expect(() =>
      compileBreakdown(bd([slice(1, ['src/x.py'], 'pytest tests/x.py')]), {
        acceptCommand: 'pytest && pytest tests',
      }),
    ).not.toThrow();
  });

  test('accept 命令里夹未注册词仍被拒 (宽容面双向对称)', () => {
    // 双侧对称: accept 与 verify 同闸。frobnicate 不在任何包 → accept 里出现也抛。
    expect(() =>
      compileBreakdown(bd([slice(1, ['src/x.py'], 'pytest tests/x.py')]), {
        acceptCommand: 'frobnicate all',
      }),
    ).toThrow(/白名单/);
  });

  test('阴性对照: 已注册包的多 bin 组合 (pytest && go test) 一次过闸', () => {
    // && 链拆环逐环判: 跨生态 verify 串按段独立判, 每段首词在 COMPILE_ALLOWLIST 即放行。
    const ok = bd([slice(1, ['src/x.py'], 'pytest tests/x.py && go test ./...')]);
    expect(() => compileBreakdown(ok, { acceptCommand: FULL_REGRESSION })).not.toThrow();
  });
});
