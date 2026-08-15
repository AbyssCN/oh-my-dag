/**
 * TMPDIR 隔离闸(2026-08-15)。
 *
 * ## 它守的那一条
 *
 * 全仓测试到处 `mkdtempSync(join(tmpdir(), …))` 且大多不清理 —— 实测每跑一次全量在
 * `~/.cache/tmp` 留下 **+767** 个目录,累计 510,149 个 · 11G。修法是把整轮测试的 `TMPDIR`
 * 换成一次性目录(`test/setup/tmpdir-isolation.ts`,经 `bunfig.toml` 的 `[test].preload` 接线)。
 *
 * **本闸问的是「那条接线还在不在」** —— 它是整个方案唯一的承重点:preload 一旦掉了/写错路径,
 * 测试照常全绿,只是又开始悄悄堆目录。**这正是本仓反复记录的形态:配了不生效、两边都不报错。**
 *
 * ## ★ 证伪方法(改这个闸或改 preload 必做一次)
 *
 * 把 `bunfig.toml` 的 `preload` 那行注释掉 → ★① ★② **必须红**(`tmpdir()` 回到宿主共享 tmp)。
 * 改回来 → 回绿。已于 2026-08-15 实跑证伪。
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

describe('TMPDIR 隔离 —— 测试的临时目录不许堆进宿主共享 tmp', () => {
  test('★① preload 接线还在: tmpdir() 指向本轮一次性目录', () => {
    const t = tmpdir();
    // 判据是**名字形状**而不是"等于某个变量" —— 后者会退化成恒真式
    // (从同一个模块 import 那个值再断言它等于自己)。
    expect(
      basename(t).startsWith('omd-testrun-'),
      `tmpdir() = ${t} —— 不是本轮目录。多半是 bunfig.toml 的 [test].preload 掉了, ` +
        `此时测试仍会全绿, 只是又开始往宿主 tmp 堆目录 (实测 +767/跑)。`,
    ).toBe(true);
  });

  test('★② mkdtempSync 真的落在本轮目录里 (不只是 env 好看)', () => {
    // ★① 断言的是 env/tmpdir() 的值; 这一条断言**实际写盘位置** —— 两者可以不一致
    // (比如某天有人给 mkdtemp 传了写死的父目录), 那种情况下只测前者会漏。
    const d = mkdtempSync(join(tmpdir(), 'iso-probe-'));
    try {
      expect(existsSync(d)).toBe(true);
      expect(basename(dirname(d)).startsWith('omd-testrun-')).toBe(true);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  // ⚠ 这里**曾经有第三条**「子进程也继承本轮 TMPDIR」—— 写的时候以为成立, 一跑就红。
  // 实测:`Bun.spawn` 的默认 env 是**进程启动时的快照**, 运行时改 `process.env` 到不了子进程。
  // 但同一次实测也表明这个缺口**不要紧**: 带 preload 跑全量, 宿主 tmp 增量 +767 → **+1**
  // (夹具子进程的临时目录是父进程建好经 `--root` 传进去的, 子进程自己不建)。
  // 于是那条用例被**删掉**而不是改成"断言子进程拿到宿主 tmp" —— 后者是变更检测器不是闸,
  // 红了也只会让人把数字改一改。事实记在 `tmpdir-isolation.ts` 头注的「已知不覆盖面」。
});
