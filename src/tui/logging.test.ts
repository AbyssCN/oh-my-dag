/**
 * L1 判据:日志改道(TUI SDD §8,切片 S3)。
 *
 * 这一层只证明**改道这个动作本身**对不对:文件开在哪、汇有没有换过去、还原顺序对不对、
 * 开不出文件时走的是"静默 + 留证据"而不是"继续往终端上打"。
 *
 * **不证明**「终端上真的看不见」—— 那是 L3 的活(`scripts/tui-pty-check.mjs` 场景 3),
 * 因为在 bun test 里 `process.stderr` 不是终端,写进去也不会花屏,断言等于白测。
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { logger } from '../logger';
import { redirectTuiLogs } from './logging';

/** 每条用例一个独立 cwd —— 共用会让"上一条留下的文件"混进这一条的断言。 */
function freshCwd(): string {
  return mkdtempSync(join(tmpdir(), 'omd-tui-log-'));
}

describe('redirectTuiLogs —— 改道成功的那条路', () => {
  // 反向自检 (2026-08-07 实跑): 把 logging.ts 里的 `setLoggerDestination(fd)` 注释掉
  // → 「日志真的进了文件」当场红 (文件 0 字节)。把 close() 里的两行调换顺序
  // → 关闭后再 log 一次会 EBADF 抛, 「close 之后还能继续 log」红。
  test('★ 日志真的进了文件, 而不是只建了个空文件', () => {
    const cwd = freshCwd();
    const handle = redirectTuiLogs({ cwd, now: () => 1_700_000_000_000 });
    try {
      expect(handle.path).toBe(join(cwd, '.omd', 'logs', 'omd-tui-1700000000000.log'));
      expect(handle.reason).toBeNull();
      logger.warn('OMD-L1-REDIRECT-MARKER');
      expect(readFileSync(handle.path as string, 'utf8')).toContain('OMD-L1-REDIRECT-MARKER');
    } finally {
      handle.close();
    }
  });

  test('★ close 之后新日志不再进那个文件, 且不炸 (fd 已关, 汇必须先换走)', () => {
    const cwd = freshCwd();
    const handle = redirectTuiLogs({ cwd, now: () => 1 });
    const path = handle.path as string;
    handle.close();
    // 这一句就是 EBADF 的引信: 顺序写反的话它会抛。
    expect(() => logger.warn('OMD-L1-AFTER-CLOSE')).not.toThrow();
    expect(readFileSync(path, 'utf8')).not.toContain('OMD-L1-AFTER-CLOSE');
  });

  test('close 幂等 —— 第二次调用不重复关 fd', () => {
    const handle = redirectTuiLogs({ cwd: freshCwd() });
    handle.close();
    expect(() => handle.close()).not.toThrow();
  });
});

describe('redirectTuiLogs —— 开不出文件时:静默且说得出为什么', () => {
  test('★ path 为 null 时 reason 必须有内容 —— 两列互补, 不靠猜哪种 null', () => {
    const base = freshCwd();
    // cwd 指向一个**文件**: mkdir <file>/.omd/logs → ENOTDIR。
    const notADir = join(base, 'i-am-a-file');
    writeFileSync(notADir, 'x');

    const levelBefore = logger.level;
    const handle = redirectTuiLogs({ cwd: notADir });
    try {
      expect(handle.path).toBeNull();
      expect(handle.reason).toContain('日志文件开不出');
      expect(handle.reason).toContain(join(notADir, '.omd', 'logs'));
      // 失败路径的要求是**静默**, 不是"继续往终端上打" —— 后者是必然花屏的 UI。
      expect(logger.level).toBe('silent');
    } finally {
      handle.close();
    }
    expect(logger.level).toBe(levelBefore);
  });

  test('失败路径不留半个日志目录', () => {
    const base = freshCwd();
    const notADir = join(base, 'f');
    writeFileSync(notADir, 'x');
    redirectTuiLogs({ cwd: notADir }).close();
    expect(readdirSync(base)).toEqual(['f']);
  });
});
