/**
 * blank-baseline 反向自检(C-6):key 全等才命中、脏树拒入、命中带来源、集合刀法。
 * 与 command-leaf 结果缓存的反向闸互不侵犯(本模块是具名记录,不碰命令执行路径)。
 */
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  extractFailSet,
  keyEquals,
  lockHashOf,
  lookupBaseline,
  writeBaseline,
  type BaselineKey,
  type BaselineRecord,
} from './blank-baseline';

let dir: string;
let store: string;
const KEY: BaselineKey = { head: 'a'.repeat(40), cleanTree: true, lockHash: lockHashOf('lock-v1') };
const rec = (over: Partial<BaselineRecord> = {}): BaselineRecord => ({
  key: KEY,
  at: '2026-08-10T05:00:00.000Z',
  runId: 'run-src-1',
  tscExit: 0,
  failSet: ['tui-pty L3', 'repo-root omdRepoRoot'],
  pass: 3800,
  fail: 2,
  skip: 1,
  ...over,
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'omd-baseline-'));
  store = join(dir, '.omd', 'blank-baseline.json');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('key 全等才命中 (失效方向不对称)', () => {
  // 证伪方式 (当场验过): keyEquals 里去掉 lockHash 比较 → 「lockfile 变了」臂红; 恢复后绿。
  test('★ 三分量任一不等 → miss (HEAD / 树干净 / lockfile)', () => {
    writeBaseline(store, rec());
    expect(lookupBaseline(store, KEY)).not.toBeNull();
    expect(lookupBaseline(store, { ...KEY, head: 'b'.repeat(40) })).toBeNull(); // HEAD 变
    expect(lookupBaseline(store, { ...KEY, lockHash: lockHashOf('lock-v2') })).toBeNull(); // 依赖变
    expect(lookupBaseline(store, { ...KEY, cleanTree: false })).toBeNull(); // 脏树连查都不查
  });

  test('★ 脏树拒入缓存 (悲观陈旧 = 静默赦免真回归, 致命面)', () => {
    expect(() => writeBaseline(store, rec({ key: { ...KEY, cleanTree: false } }))).toThrow(/脏树/);
  });

  test('命中带采集时刻与来源 runId (不许无声使用的凭据)', () => {
    writeBaseline(store, rec());
    const hit = lookupBaseline(store, KEY)!;
    expect(hit.at).toBe('2026-08-10T05:00:00.000Z');
    expect(hit.runId).toBe('run-src-1');
    expect(hit.failSet).toEqual(['tui-pty L3', 'repo-root omdRepoRoot']);
  });

  test('同 key 覆盖; 超额裁老 (最多 5 条)', () => {
    for (let i = 0; i < 7; i++) {
      writeBaseline(store, rec({ key: { ...KEY, head: String(i).repeat(40) }, at: `2026-08-10T0${i}:00:00.000Z` }));
    }
    // 第 0/1 条被裁, 第 6 条在
    expect(lookupBaseline(store, { ...KEY, head: '0'.repeat(40) })).toBeNull();
    expect(lookupBaseline(store, { ...KEY, head: '6'.repeat(40) })).not.toBeNull();
  });

  test('坏文件 fail-open 按空 (不抛)', () => {
    const { mkdirSync, writeFileSync } = require('node:fs') as typeof import('node:fs');
    mkdirSync(join(dir, '.omd'), { recursive: true });
    writeFileSync(store, '{corrupt');
    expect(lookupBaseline(store, KEY)).toBeNull();
    expect(() => writeBaseline(store, rec())).not.toThrow(); // 覆写修复
    expect(lookupBaseline(store, KEY)).not.toBeNull();
  });
});

describe('(fail) 集合刀法 (与图 N5 同款: 集合比较不是计数)', () => {
  test('提取名字、去重、去时长尾巴、排序', () => {
    const out = [
      '(fail) A > b 断言 [12.20ms]',
      '(fail) C > d [1.5s]',
      '(fail) A > b 断言 [13.01ms]', // 重复 (重跑) → 去重
      ' 3800 pass',
      '(pass) 不该被抓',
    ].join('\n');
    expect(extractFailSet(out)).toEqual(['A > b 断言', 'C > d']);
  });

  test('keyEquals 自反', () => {
    expect(keyEquals(KEY, { ...KEY })).toBe(true);
  });
});
