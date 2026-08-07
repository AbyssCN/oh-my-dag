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
 */
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');

describe('S2 · omd tui 在真 PTY 里立得住 (L3, node 托管)', () => {
  test(
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
