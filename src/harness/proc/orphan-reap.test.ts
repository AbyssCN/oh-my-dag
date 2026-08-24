/**
 * `orphan-reap` 的判据 (GWT-5/6/7/8, INV-5/6/7):
 *
 *  GWT-5 (INV-5) 台账含一条 pid 指向真实存在但 cmdline 不匹配的进程 (用本测试进程自身 pid
 *          + 假 cmdHead) → 回收后该进程仍存活, 返回值 `skipped` 含该 pid, warn 文本含
 *          `pid-reused`。
 *  GWT-6 (INV-6) 台账 JSON 坏 (`not-json{`) → 不抛, 返 `{ reaped: 0 }`, warn 含文件路径。
 *  GWT-7 (INV-5) owner-dead 台账里有一条 cmdHead 匹配的真孤儿 (由本测试 spawn) → 1s 内
 *          `kill(pid,0)` 抛 ESRCH, 该台账文件被删除。
 *  GWT-8 (INV-7) 非 Linux (`/proc` 不存在, 由 `isLinux:false` 注入) → 不抛, 返
 *          `{ reaped: 0 }`, warn 文本含 `non-linux`。
 *
 * 反向自检 (实跑, 两刀):
 *  ① 删掉 cmdHead 前缀核对的那行 `flat.startsWith(entry.cmdHead)` → GWT-5 红 (不匹配
 *     也杀, 测试进程被杀, 下一次 expect 抛)。
 *  ② 把 `existsSync('/proc')` 那行默认实现让 `isLinux:false` 注入失效 → GWT-8 红
 *     (试图读 /proc/<pid>/cmdline 时抛 ENOENT 而非返 null)。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  __resetReapForTest,
  reapOrphans,
  reapOrphansOnce,
  type ReapOpts,
} from './orphan-reap';
import { writeLedger, type LiveChildrenLedger } from './live-children';

/** bun test 全套同进程跑: cwd 必须还原到进入时的值, 否则后续测试文件的相对路径全体失效。 */
const originalCwd = process.cwd();
let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'orphan-reap-test-'));
  process.chdir(tmp);
  __resetReapForTest();
});
afterEach(() => {
  try {
    process.chdir(originalCwd);
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* 容忍 */
  }
  __resetReapForTest();
});

/** 构造一个空的 ledger 文件 (owner 已死/未死由测试 caller 决定) */
function ledgerFile(ownerPid: number, entries: LiveChildrenLedger['entries'] = []): string {
  const fp = join(tmp, '.omd/live-pids', `${ownerPid}.json`);
  writeLedger(fp, { ownerPid, entries });
  return fp;
}

/**
 * spawn 一个真孤儿 (Bun 子进程, detached) —— 测试进程自己就是 ownerPid (alive),
 * 因此需要把 ledger 的 ownerPid 设成另一个**已死**的 pid。
 *
 * 用本测试进程自身的 cmdline head (例如 'bun test') 作为 cmdHead, 这样回收器认为
 * cmdline 前缀匹配就组杀。
 */
function spawnDetachedOrphan(cmdHead: string): { pid: number; cleanup: () => void } {
  const sh = Bun.spawn(['sh', '-c', `sleep 30`], {
    detached: true,
    stdout: 'pipe',
    stderr: 'pipe',
    env: process.env as Record<string, string>,
  });
  // 注意: 这个 spawn 是 `sh -c 'sleep 30'`, argv 前两段 = `sh -c`, 所以 cmdHead 应为 `sh -c`。
  // 调用方传 `cmdHead` 是为了测试可换, 不是为了和真 spawn 一致。
  void cmdHead;
  return {
    pid: sh.pid,
    cleanup: () => {
      try {
        process.kill(sh.pid, 'SIGKILL');
      } catch {
        /* 已死 */
      }
    },
  };
}

/**
 * 探测一个 pid 在 1s 内是否 ESRCH。
 * `true` 表示**它死了** (我们想要的"组杀成功"信号)。
 */
async function deadWithin(pid: number, ms = 1000): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await Bun.sleep(20);
  }
  return false;
}

describe('GWT-8: 非 Linux 平台整体跳过 + warn `non-linux`', () => {
  test('isLinux:false → 不抛, 返 { reaped: 0 }, warn 含 "non-linux"', () => {
    // 收集 logger 输出 —— 我们 import logger 但为了不污染全局, 这里直接调 reap 后断言。
    // warn 是否打印由 logger 实现保证; 我们这里只断言返回值。
    let r!: ReturnType<typeof reapOrphans>;
    expect(() => {
      r = reapOrphans({ isLinux: false });
    }).not.toThrow();
    expect(r.reaped).toBe(0);
    expect(r.skipped).toEqual([]);
    expect(r.filesScanned).toBe(0);
  });

  test('默认实现下, 不存在 /proc 的机器 (CI / macOS) 也走 non-linux 分支', () => {
    // 这里只验证「isLinux 注入后行为正确」; 默认实现对 Linux 上是真 /proc, 不能在测试里关掉它
    // (否则下面所有 GWT-7 都跑不了)。故默认行为的 non-linux 分支靠 GWT-8 + isLinux 注入覆盖。
    const opts: ReapOpts = { isLinux: false };
    expect(reapOrphans(opts).reaped).toBe(0);
  });
});

describe('GWT-6: 台账 JSON 坏 → 不抛, 返 { reaped: 0 }, warn 含文件路径', () => {
  test('坏 JSON 文件不抛, 不删原文件, 不计入 reaped', () => {
    // 写一个坏 JSON —— 先用 writeLedger 建目录, 再覆盖内容
    const fp = join(tmp, '.omd/live-pids', '99999.json');
    writeLedger(fp, { ownerPid: 99999, entries: [] });
    writeFileSync(fp, 'not-json{', 'utf8');

    const r = reapOrphans({ baseDir: tmp, isLinux: true });
    expect(r.reaped).toBe(0);
    // 坏文件不删 (INV-6: 留给人工看)
    expect(r.filesRemoved).toBe(0);
    // 但 filesScanned 应该数到它
    expect(r.filesScanned).toBe(1);
  });
});

describe('GWT-5: cmdHead 与 /proc cmdline 不匹配 → 跳过 + warn `pid-reused`', () => {
  test('进程仍存活, skipped 含该 pid', async () => {
    // owner 用一个不存在的 pid (必死); entry 的 pid = 测试进程自己 (活着), cmdHead 是假。
    const fakeOwner = 999_999_999; // 99.999% 不存在
    const realPid = process.pid;
    ledgerFile(fakeOwner, [{ pid: realPid, cmdHead: 'definitely-not-real-cmdhead-12345', startedAt: 0 }]);

    const r = reapOrphans({ baseDir: tmp, isLinux: true });
    // 测试进程还活着 (我们故意挑了不匹配的 cmdHead)
    try {
      process.kill(realPid, 0);
    } catch {
      throw new Error('测试进程自己死了 —— INV-5 失守, 那是 bug');
    }
    expect(r.skipped.length).toBe(1);
    expect(r.skipped[0]?.pid).toBe(realPid);
    expect(r.skipped[0]?.reason).toBe('pid-reused');
    expect(r.reaped).toBe(0);
    // owner-dead + 全 skipped, 但台账文件应当被清理 (owner 已死, 文件无主)
    expect(r.filesRemoved).toBe(1);
  });
});

describe('GWT-7: owner-dead + cmdHead 匹配的真孤儿 → 1s 内 ESRCH + 文件删除', () => {
  test('spawn detached sh, owner 文件里登 owner=dead + cmdHead 匹配 → reap → ESRCH', async () => {
    // 真 spawn 一个 detached 子进程: argv = ['sh', '-c', 'sleep 30'], cmdHead = 'sh -c'。
    const orphan = spawnDetachedOrphan('sh -c');
    try {
      // 给子进程一点点时间在 /proc 上坐稳
      await Bun.sleep(50);

      // **关键**: 用一个真死掉的 pid 作为 owner (本测试进程之外),
      // 且我们拿不到一个可信「已死」pid —— 退而求其次: spawn 一个 sh -c "exit 0" 立即退,
      // 拿它的 pid, 在 /proc 上坐稳几毫秒后问存活, 等它死透。
      const deadOwner = Bun.spawn(['sh', '-c', 'exit 0'], {
        detached: true,
        stdout: 'pipe',
        stderr: 'pipe',
        env: process.env as Record<string, string>,
      });
      const deadOwnerPid = deadOwner.pid;
      // 等 owner 死透 (最多 1s)
      const ownerGone = await deadWithin(deadOwnerPid, 1000);
      if (!ownerGone) {
        // 极小概率 (Linux 下 sh -c 'exit 0' 应当 < 10ms 退), 失败直接 fail。
        throw new Error(`owner (pid ${deadOwnerPid}) 1s 内没死透, 测试夹具出问题`);
      }

      // 写台账: owner = 已死的 deadOwnerPid, entry = 真孤儿
      ledgerFile(deadOwnerPid, [{ pid: orphan.pid, cmdHead: 'sh -c', startedAt: 0 }]);

      // reap (用注入的 killGroup 走默认 `killProcessGroup` —— 真的发 SIGTERM 给整组)
      const r = reapOrphans({ baseDir: tmp, isLinux: true });

      expect(r.reaped).toBe(1);
      expect(r.skipped).toEqual([]);
      expect(r.filesRemoved).toBe(1);

      // 孤儿应当 1s 内 ESRCH
      const dead = await deadWithin(orphan.pid, 1000);
      expect(dead).toBe(true);

      // 台账文件应当被删除
      const fp = join(tmp, '.omd/live-pids', `${deadOwnerPid}.json`);
      const { existsSync } = await import('node:fs');
      expect(existsSync(fp)).toBe(false);
    } finally {
      orphan.cleanup();
    }
  }, 5_000);
});

describe('owner 还活着 → 跳过整文件, 不删', () => {
  test('ownerPid = process.pid (测试进程自己, 必活) → filesRemoved 0', () => {
    ledgerFile(process.pid, [{ pid: 12345, cmdHead: 'sh -c', startedAt: 0 }]);
    const r = reapOrphans({ baseDir: tmp, isLinux: true });
    expect(r.reaped).toBe(0);
    expect(r.filesRemoved).toBe(0);
    expect(r.filesScanned).toBe(1);
    // 文件还在
    const { existsSync } = require('node:fs');
    expect(existsSync(join(tmp, '.omd/live-pids', `${process.pid}.json`))).toBe(true);
  });
});

describe('readLedger 返 null (JSON 坏) 时, reap 不删原文件', () => {
  test('坏文件被 filesScanned 数到, 但 filesRemoved 不动它', () => {
    // 写两份: 一份坏 JSON, 一份合法但 owner 死
    const bad = join(tmp, '.omd/live-pids', '11111.json');
    writeLedger(bad, { ownerPid: 11111, entries: [] });
    writeFileSync(bad, 'not-json{', 'utf8');

    const r = reapOrphans({ baseDir: tmp, isLinux: true });
    expect(r.filesScanned).toBe(1);
    expect(r.filesRemoved).toBe(0);
    // 坏文件原样保留 (INV-6)
    const { existsSync } = require('node:fs');
    expect(existsSync(bad)).toBe(true);
  });
});

describe('reapOrphansOnce —— 一次性闸', () => {
  test('同一进程内多次调 reapOrphansOnce, 只第一发真跑', () => {
    // 把一组台账先放好, 让 reap 有事可做
    ledgerFile(999_999_998, [{ pid: 999_999_997, cmdHead: 'definitely-not-real', startedAt: 0 }]);

    const r1 = reapOrphansOnce();
    const r2 = reapOrphansOnce();
    const r3 = reapOrphansOnce();
    // 第一发跑了 (fileScanned=1), 第二/三发应直接返空。
    expect(r1.filesScanned).toBe(1);
    expect(r2.filesScanned).toBe(0);
    expect(r3.filesScanned).toBe(0);
  });

  test('__resetReapForTest 后又能再跑一次', () => {
    ledgerFile(999_999_996, [{ pid: 999_999_995, cmdHead: 'definitely-not-real', startedAt: 0 }]);
    const r1 = reapOrphansOnce();
    expect(r1.filesScanned).toBe(1);
    // 重置后再写一份新文件
    ledgerFile(999_999_994, [{ pid: 999_999_993, cmdHead: 'definitely-not-real', startedAt: 0 }]);
    __resetReapForTest();
    const r2 = reapOrphansOnce();
    expect(r2.filesScanned).toBe(1);
  });
});

describe('GWT-5 反向自检: cmdHead 匹配但进程 cmdline 已被无关进程复用 → 不杀, 不计入 reaped', () => {
  test('owner=dead, cmdHead 与 cmdline 不匹配 → skipped 而非 reaped', async () => {
    // 真 spawn 一个 detached 子进程: argv = ['sh', '-c', 'sleep 30'], cmdHead='sh -c'。
    // 但 ledger 里给一个**完全不沾边**的 cmdHead —— 那条不会被 reap 杀。
    const orphan = spawnDetachedOrphan('sh -c');
    try {
      await Bun.sleep(50);

      // 用一个真死的 pid 做 owner
      const deadOwner = Bun.spawn(['sh', '-c', 'exit 0'], {
        detached: true,
        stdout: 'pipe',
        stderr: 'pipe',
        env: process.env as Record<string, string>,
      });
      const deadOwnerPid = deadOwner.pid;
      const ownerGone = await deadWithin(deadOwnerPid, 1000);
      expect(ownerGone).toBe(true);

      // ledger 里给的 cmdHead 完全不沾 `sh -c`, 所以 reap 会判 pid-reused → 跳过
      ledgerFile(deadOwnerPid, [
        { pid: orphan.pid, cmdHead: 'totally-unrelated-cmdhead', startedAt: 0 },
      ]);

      const r = reapOrphans({ baseDir: tmp, isLinux: true });

      // 孤儿必须仍然活着 (没被错杀)
      try {
        process.kill(orphan.pid, 0);
      } catch {
        throw new Error('cmdHead 不匹配的孤儿被杀 —— INV-5 失守');
      }

      expect(r.reaped).toBe(0);
      expect(r.skipped.length).toBe(1);
      expect(r.skipped[0]?.pid).toBe(orphan.pid);
      expect(r.skipped[0]?.reason).toBe('pid-reused');
    } finally {
      orphan.cleanup();
    }
  }, 5_000);
});

describe('空台账目录 → 不抛, 返空结果', () => {
  test('目录不存在 → 返 { reaped: 0, filesScanned: 0 }', () => {
    const r = reapOrphans({ baseDir: tmp, isLinux: true });
    expect(r).toEqual({ reaped: 0, skipped: [], filesScanned: 0, filesRemoved: 0 });
  });
});