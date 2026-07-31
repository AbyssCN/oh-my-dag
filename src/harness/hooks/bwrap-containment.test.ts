/**
 * **jail 容器性探针** (2026-07-31, R2 第二层)。
 *
 * ## 为什么这条不该用 live 去问
 *
 * 2026-07-31 live 第三跑抓到: 隔离档下一个 agent 的产物落在**沙箱主树**
 * (`/…/omd-smoke-goal-Kp197I/docs/from-faq.md`), 即隔离树之外。根因是 `sandboxRoot` 那层
 * (bwrap: 整个 leaf 进程只见这棵树) **生产从来没接** —— 机制早就有、eval oracle 一直在用。
 *
 * 接上之后"绝对路径还逃不逃得出去"是个**容器问题, 不是模型问题**: 拦得住拦不住由 bwrap 的
 * bind 决定, 与 agent 写了什么无关。所以它值一个确定性探针, 不值一次 live。
 * (这正是本轮反复在做的分工: 便宜的问题用便宜的办法问掉, live 只留给 live 才答得了的。)
 *
 * ## 判据
 *
 * 在与 `createSandboxedLeafRunner` **逐字相同**的 bwrap 参数下:
 *   ① jail 内写**树内**相对/绝对路径 → 成功 (否则隔离把正事也挡了)
 *   ② jail 内写**树外**绝对路径 → 失败 (那正是 live 逃逸的那条路)
 *
 * ⚠ 本机无 bwrap → 跳过并**响亮说明**, 不静默绿。"没测" 与 "测过且通过" 必须分得开 ——
 * 这是本轮第五次为同一条纪律付账。
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bwrapArgs, defaultRoBinds } from './bwrap';

const HAS_BWRAP = Boolean(Bun.which('bwrap'));

/** 在 jail 里跑一条 sh 命令, 返退出码。cwd 由 bwrap `--chdir` 定在 root。 */
function inJail(root: string, shell: string): number {
  const argv = ['bwrap', ...bwrapArgs(root, defaultRoBinds(root)), 'sh', '-c', shell];
  const r = Bun.spawnSync(argv, { stdout: 'pipe', stderr: 'pipe' });
  return r.exitCode;
}

describe('bwrap 容器性 — 隔离档的"绝对路径也逃不出去"到底成不成立', () => {
  if (!HAS_BWRAP) {
    test('⚠ 本机没有 bwrap → 本组**未测**(不是通过)', () => {
      // 刻意让这条留在输出里: 静默跳过会让 CI 上一片绿被读成"隔离验过了"。
      expect(HAS_BWRAP).toBe(false);
    });
    return;
  }

  test('① 树内写得进去 (隔离不能把正事也挡了)', () => {
    const root = mkdtempSync(join(tmpdir(), 'omd-jail-in-'));
    expect(inJail(root, 'echo hi > inside.txt')).toBe(0);
    expect(existsSync(join(root, 'inside.txt'))).toBe(true);
    // 树内的**绝对**路径同样该通 —— 拦的是"树外", 不是"绝对"。
    expect(inJail(root, `echo hi > ${root}/inside-abs.txt`)).toBe(0);
    expect(existsSync(join(root, 'inside-abs.txt'))).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  test('② **树外绝对路径写不进去** ←live 逃逸的正是这条', () => {
    const root = mkdtempSync(join(tmpdir(), 'omd-jail-out-'));
    const outside = mkdtempSync(join(tmpdir(), 'omd-jail-victim-'));
    const victim = join(outside, 'stolen.txt');

    const code = inJail(root, `echo pwned > ${victim}`);
    expect(code).not.toBe(0); // 写失败
    // 更要紧的是**受害文件真的没被创建** —— 退出码非 0 也可能是别的原因, 落点才是硬证据。
    expect(existsSync(victim)).toBe(false);

    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  test('③ 树外**已存在**的文件也改不动 (live 那次是往已存在的沙箱主树里写)', () => {
    const root = mkdtempSync(join(tmpdir(), 'omd-jail-out2-'));
    const outside = mkdtempSync(join(tmpdir(), 'omd-jail-victim2-'));
    const victim = join(outside, 'existing.txt');
    Bun.write(victim, 'original\n');

    inJail(root, `echo overwritten > ${victim}`);
    expect(Bun.spawnSync(['cat', victim], { stdout: 'pipe' }).stdout.toString()).toBe('original\n');

    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });
});
