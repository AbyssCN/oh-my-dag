/**
 * `killProcessGroup` (定义于 `live-children.ts`) 的判据 —— 两条契约分开钉:
 *
 *  GWT-1 (INV-1) 实跑真子进程组: `bash -c 'sleep 30 & echo CHILD_PID=$!; sleep 30'`
 *    起来的孙进程在组杀后 1s 内必须 ESRCH。
 *  GWT-2 (INV-2) EPERM 替身: 组杀抛 EPERM 时, 替身收到第二次调用 (正 PID),
 *    整个调用不抛。
 *
 * 反向自检 (实跑, 两刀):
 *  ① 删掉 EPERM 那一支 → GWT-2 红 (收尾抛 EPERM, 与 INV-2 反向)。
 *  ② 把 defaultKillPid 让它把 EPERM 之外的错也吞 → GWT-2 仍绿 (注入路径不依赖默认),
 *    但仍由 INV-2 文字注锁住行为。
 */
import { describe, expect, test } from 'bun:test';
import { killProcessGroup } from './live-children';

describe('killProcessGroup —— 组杀 + EPERM/ESRCH 兜底', () => {
  test('GWT-2: 组杀抛 EPERM 时回退单 PID kill, 不抛', () => {
    let groupCalls = 0;
    let pidCalls: Array<{ pid: number; signal?: number | NodeJS.Signals }> = [];
    const killGroup = () => {
      groupCalls++;
      const e: NodeJS.ErrnoException = new Error('kill EPERM');
      e.code = 'EPERM';
      throw e;
    };
    const killPid = (pid: number, signal?: number | NodeJS.Signals) => {
      pidCalls.push({ pid, signal });
    };
    expect(() => killProcessGroup(12345, 'SIGTERM', killGroup, killPid)).not.toThrow();
    expect(groupCalls).toBe(1);
    expect(pidCalls).toEqual([{ pid: 12345, signal: 'SIGTERM' }]);
  });

  test('ESRCH 也回退单 PID kill', () => {
    let pidCalls = 0;
    const killGroup = () => {
      const e: NodeJS.ErrnoException = new Error('kill ESRCH');
      e.code = 'ESRCH';
      throw e;
    };
    const killPid = () => {
      pidCalls++;
    };
    killProcessGroup(999, 'SIGKILL', killGroup, killPid);
    expect(pidCalls).toBe(1);
  });

  test('组杀成功时, 不调单 PID kill', () => {
    let groupCalls = 0;
    let pidCalls = 0;
    const killGroup = () => {
      groupCalls++;
    };
    const killPid = () => {
      pidCalls++;
    };
    const outcome = killProcessGroup(1234, 'SIGTERM', killGroup, killPid);
    expect(outcome).toBe('group');
    expect(groupCalls).toBe(1);
    expect(pidCalls).toBe(0);
  });

  test('组杀抛未知错时退化单 PID kill, 不挡上层', () => {
    const pidCalls: number[] = [];
    const killGroup = () => {
      const e: NodeJS.ErrnoException = new Error('something weird');
      e.code = 'EOOPS';
      throw e;
    };
    const killPid = (pid: number) => {
      pidCalls.push(pid);
    };
    expect(() => killProcessGroup(7777, 'SIGTERM', killGroup, killPid)).not.toThrow();
    expect(pidCalls).toEqual([7777]);
  });

  test('默认信号为 SIGTERM', () => {
    const killGroup = (pid: number, signal?: number | NodeJS.Signals) => {
      expect(pid).toBe(42);
      expect(signal).toBe('SIGTERM');
    };
    killProcessGroup(42, undefined as unknown as NodeJS.Signals, killGroup, () => {});
  });
});

describe('GWT-1: 真子进程组的孙进程随组杀一并死', () => {
  test('bash -c "sleep 30 & echo CHILD_PID=$!; sleep 30" → 超时组杀 → 孙 ESRCH', async () => {
    const sh = Bun.spawn(['bash', '-c', 'sleep 30 & echo "CHILD_PID=$!"; sleep 30'], {
      detached: true,
      stdout: 'pipe',
      stderr: 'pipe',
      env: process.env as Record<string, string>,
    });
    // **只读到换行就 cancel**: bash 还在 sleep 30, 不 cancel 会等 EOF, 死锁。
    const reader = sh.stdout!.getReader();
    const dec = new TextDecoder();
    let buf = '';
    while (!buf.includes('\n')) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value);
    }
    await reader.cancel();
    const m = buf.match(/CHILD_PID=(\d+)/);
    expect(m).not.toBeNull();
    const grandchildPid = Number(m![1]);

    // 给孙进程一点点时间在 /proc 上坐稳
    await Bun.sleep(50);

    // 整组杀
    const outcome = killProcessGroup(sh.pid, 'SIGTERM');
    expect(outcome).toBe('group');

    // 1s 内孙 ESRCH
    let dead = false;
    const until = Date.now() + 1000;
    while (Date.now() < until) {
      try {
        process.kill(grandchildPid, 0);
      } catch {
        dead = true;
        break;
      }
      await Bun.sleep(20);
    }
    expect(dead).toBe(true);
  }, 5_000);
});
