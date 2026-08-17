/**
 * L3 PTY lane 的**接线**:把 `scripts/tui-pty-check.mjs` 调起来,收退出码。
 *
 * ## ⚠ 为什么判据不写在这个文件里
 *
 * 实测(2026-08-07):`@lydell/node-pty` 在 **bun 宿主**下一个字节都不回
 * (`spawn(bun, ['-e','console.log(1)'])` → `bytes=0 exit=0`),换 **node 宿主**同样调用
 * 正常回 12 字节;对照做全了 —— bash 子进程在 bun 宿主下是好的,所以坏的不是 pty,
 * 是「bun 宿主 + 这个原生模块」这一对。
 *
 * 如果硬把判据写在 `bun test` 里,它会收到**空输出**,于是每一条 `includes()` 都假、
 * 每一条 `not.toContain()` 都真 —— **一条看起来在跑、实际什么都没验的闸**。
 * 所以 PTY 由 node 托管,这里只做接线。判据、oracle、oracle 的反测全在那个脚本里(单一定义)。
 *
 * ⚠ **node 缺席时本测试会响亮失败, 不是静默跳过** —— 静默跳过就是那条永远绿的假闸。
 *
 * ⚠ #174 (2026-08-18) 唯一例外: **隔离 worktree 里自跳**。branch 档 run 的 worktree 里
 * 本测试 flake(47s 超时红, 同一 HEAD 主仓绿, run a828a672 / 60f58f3f 连撞)—— PTY + 原生模块
 * 对执行目录敏感, 在隔离树里量不出 tui 的问题, 只量出环境。检测 = `.git` 是文件(linked
 * worktree 的定义)而非目录。**防"自跳"变永久盲区**: 跳过必打一行证据日志, 且主仓照跑
 * (主仓 `.git` 是目录, 永不满足跳过条件)。
 */
import { describe, expect, test } from 'bun:test';
import { statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');

// linked worktree 里 `.git` 是一个指回主仓 gitdir 的**文件**; 主仓里是目录。
const IN_LINKED_WORKTREE = ((): boolean => {
  try {
    return statSync(join(ROOT, '.git')).isFile();
  } catch {
    return false; // 不在 git 仓里 → 不跳 (证据: 本测试照常跑, node 缺席等失败仍响亮)
  }
})();
if (IN_LINKED_WORKTREE) {
  console.warn('[tui-pty] #174 linked worktree 检出 (.git 是文件) → PTY L3 自跳; 判据只在主仓生效, 此行即跳过证据');
}

describe('S2 · omd tui 在真 PTY 里立得住 (L3, node 托管)', () => {
  test.skipIf(IN_LINKED_WORKTREE)(
    '★ scripts/tui-pty-check.mjs 全过 (oracle 反测 + 9 条场景判据)',
    async () => {
      const proc = Bun.spawn(['node', join(ROOT, 'scripts/tui-pty-check.mjs')], {
        cwd: ROOT,
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...process.env, NO_COLOR: '1' },
      });
      const [out, err, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      // 失败时把脚本的逐条输出原样带出来 —— 否则这里只剩一个光秃秃的退出码。
      expect(code, `L3 PTY 不过:\n${out}\n${err}`).toBe(0);
      // 反向: 脚本必须真的跑过那几条, 而不是一启动就 exit 0。
      expect(out).toContain('oracle 反测通过');
      expect(out).toContain('S2-5');
      expect(out).toContain('S2-9');
    },
    120_000,
  );
});
