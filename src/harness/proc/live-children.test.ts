/**
 * `live-children` 的判据:
 *
 *  GWT-3 (INV-3)   注册 N 个子进程, 调用收尾函数两次 —— 替身恰好收到 N 次 -pgid 调用,
 *                   第二次不抛 (幂等)。
 *  GWT-4 (INV-4)   经 `registerChild` 注册一条 → 读 `.omd/live-pids/<ownerPid>.json` :=
 *                   entries[0].pid === 那个 pid && entries[0].cmdHead 非空;
 *                   `unregisterChild` 之后再读 → entries.length === 0。
 *
 * 反向自检 (实跑, 两刀):
 *  ① 把 `runSignalCleanup` 里的 `cleanupDone = true` 移到第一次调用末尾之外 → GWT-3 红
 *     (第二次又发信号)。
 *  ② 删掉 `unregisterChild` 里的 `before !== length` 早返 → GWT-4 第二次之后 entries.length === 0
 *     仍能过 (因为本来就 0), 但删除后用同一 pid 再 register 仍能复现, 这里只锁正面判据。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  __resetForTest,
  getLivePidsFilePath,
  listLedgerFiles,
  makeCmdHead,
  readLedger,
  registerChild,
  runSignalCleanup,
  unregisterChild,
  writeLedger,
} from './live-children';

/** 一个临时 cwd, 避免真污染项目根 `.omd/live-pids/` —— 但 `getLivePidsFilePath` 默认走 cwd, 故模块缓存要先重置。 */
/** bun test 全套同进程跑: cwd 必须还原到进入时的值, 否则后续测试文件的相对路径全体失效。 */
const originalCwd = process.cwd();
let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'live-children-test-'));
  process.chdir(tmp);
  __resetForTest();
});
afterEach(() => {
  try {
    process.chdir(originalCwd);
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* 容忍 */
  }
  __resetForTest();
});

describe('makeCmdHead —— argv 前两段压成字符串', () => {
  test('两条 argv join 出一个串', () => {
    expect(makeCmdHead(['bash', '-c', 'echo hi'])).toBe('bash -c');
  });
  test('单条 argv 只返那一段', () => {
    expect(makeCmdHead(['sleep'])).toBe('sleep');
  });
  test('空 argv 返空串', () => {
    expect(makeCmdHead([])).toBe('');
  });
  test('截断到 64 字符', () => {
    const long = 'x'.repeat(200);
    expect(makeCmdHead([long, long]).length).toBeLessThanOrEqual(64);
  });
});

describe('GWT-4: registerChild / unregisterChild 写入 <ownerPid>.json', () => {
  test('登记一条 → 写入磁盘, entries[0].pid/cmdHead 正确; 销账后 entries.length === 0', () => {
    registerChild({ pid: 11111, cmdHead: 'bash -c', startedAt: 1700000000000, runId: 'r-test' });
    const filePath = getLivePidsFilePath(process.pid);
    expect(existsSync(filePath)).toBe(true);
    const ledger = JSON.parse(readFileSync(filePath, 'utf8'));
    expect(ledger.entries[0].pid).toBe(11111);
    expect(ledger.entries[0].cmdHead).toBe('bash -c');
    expect(ledger.entries[0].runId).toBe('r-test');

    unregisterChild(11111);
    const ledger2 = JSON.parse(readFileSync(filePath, 'utf8'));
    expect(ledger2.entries.length).toBe(0);
  });

  test('销账不存在的 pid → no-op, entries 不被错误清空', () => {
    registerChild({ pid: 22222, cmdHead: 'sleep 30', startedAt: 0 });
    unregisterChild(99999); // 不在册
    const ledger = JSON.parse(readFileSync(getLivePidsFilePath(process.pid), 'utf8'));
    expect(ledger.entries.length).toBe(1);
    expect(ledger.entries[0].pid).toBe(22222);
  });

  test('读 JSON 坏文件 → 返 null 不抛, 不删原文件 (留给人查)', () => {
    const fp = getLivePidsFilePath(process.pid);
    writeLedger(fp, { ownerPid: 0, entries: [] });
    require('node:fs').writeFileSync(fp, 'not-json{', 'utf8');
    expect(readLedger(fp)).toBeNull();
    expect(existsSync(fp)).toBe(true); // 没删
  });

  test('listLedgerFiles 列出目录下全部 <pid>.json', () => {
    writeLedger(join(tmp, '.omd/live-pids', '100.json'), { ownerPid: 100, entries: [] });
    writeLedger(join(tmp, '.omd/live-pids', '200.json'), { ownerPid: 200, entries: [] });
    // 假文件应被忽略
    writeLedger(join(tmp, '.omd/live-pids', 'garbage.json'), { ownerPid: 0, entries: [] });
    const files = listLedgerFiles(tmp).map((f) => f.split('/').pop());
    expect(files.sort()).toEqual(['100.json', '200.json']);
  });
});

describe('GWT-3: runSignalCleanup 整组杀 + 幂等', () => {
  test('登记 2 个, 替身统计 -pgid 调用; 第二次调用不抛、不再发信号', () => {
    registerChild({ pid: 555, cmdHead: 'sleep 30', startedAt: 0 });
    registerChild({ pid: 666, cmdHead: 'sleep 30', startedAt: 0 });

    const groupCalls: Array<{ pgid: number; signal: NodeJS.Signals }> = [];
    const killFn = (pgid: number, signal: NodeJS.Signals) => {
      groupCalls.push({ pgid, signal });
      return 'group' as const;
    };

    runSignalCleanup('SIGTERM', killFn);
    runSignalCleanup('SIGTERM', killFn); // 第二次: 幂等

    expect(groupCalls).toHaveLength(2);
    expect(groupCalls.map((c) => c.pgid).sort()).toEqual([555, 666]);
    expect(groupCalls.every((c) => c.signal === 'SIGTERM')).toBe(true);
  });

  test('无在册子进程时, 收尾不发任何信号', () => {
    const groupCalls: number[] = [];
    const killFn = (pgid: number) => {
      groupCalls.push(pgid);
      return 'group' as const;
    };
    runSignalCleanup('SIGTERM', killFn);
    expect(groupCalls).toHaveLength(0);
  });

  test('注入的 killFn 抛了也不挡主流程', () => {
    registerChild({ pid: 777, cmdHead: 'x', startedAt: 0 });
    const killFn = () => {
      throw new Error('boom');
    };
    expect(() => runSignalCleanup('SIGTERM', killFn)).not.toThrow();
  });
});
