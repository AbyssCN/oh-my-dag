/**
 * src/harness/goal/experiment-flags —— 旗标读取契约测试。
 *
 * 用 `spyOn` 桩 `omdRepoRoot`(不用 `mock.module` —— 见 `src/serve/read-api.test.ts` 头注:
 * module mock 改写进程级注册表, 会漏到别的测试文件; `spyOn` 有 `mock.restore()` 兜底且
 * 实测穿得到本模块的 import 绑定)。
 *
 * INV-2 反向自检 (2026-08-14): 把 `readExperimentFlags()` 临时硬编码为恒回
 * `{ contractFaninDistill: true }`, 跑 `bun test src/harness/goal/run-goal.test.ts` (本文件的
 * 消费方) —— `run-goal.test.ts` 中「旗标 off … 逐字节等价」那条当场变红 (多出 `minFanout: 1`),
 * 证明下游确实在读这个函数的返回值, 不是接了个没人用的死接口。还原后 `git diff` 为空, 复跑全绿。
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readExperimentFlags } from './experiment-flags';
import * as repoRoot from '../repo-root';

let root: string;
let errSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'omd-experiment-flags-'));
  mkdirSync(join(root, '.omd'), { recursive: true });
  spyOn(repoRoot, 'omdRepoRoot').mockReturnValue(root);
  errSpy = spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('readExperimentFlags', () => {
  // 证伪: 若函数不判文件存在与否直接读 → 抛 ENOENT 而非返回 off, 测试当场红。
  test('文件不存在 → 全 off, 静默, 不留证据', () => {
    expect(readExperimentFlags()).toEqual({ contractFaninDistill: false });
    expect(errSpy).not.toHaveBeenCalled();
  });

  // 证伪: 若把"键缺失"错当"解析失败"处理 → console.error 会被调用, 测试当场红。
  test('文件在但键缺失 → 全 off, 静默', () => {
    writeFileSync(join(root, '.omd', 'experiments.json'), JSON.stringify({}));
    expect(readExperimentFlags()).toEqual({ contractFaninDistill: false });
    expect(errSpy).not.toHaveBeenCalled();
  });

  // 证伪: 若把 `=== true` 换成真值判断(如 truthy)→ 传入字符串 "false" 也会被判 on, 测试当场红。
  test('键为 false → off', () => {
    writeFileSync(join(root, '.omd', 'experiments.json'), JSON.stringify({ contractFaninDistill: false }));
    expect(readExperimentFlags()).toEqual({ contractFaninDistill: false });
    expect(errSpy).not.toHaveBeenCalled();
  });

  // 证伪: 若读取路径钉死了别处(如误用 config.cwd)而非 tmp root → 读不到这份文件, 结果仍是 off, 测试当场红。
  test('键为 true → on', () => {
    writeFileSync(join(root, '.omd', 'experiments.json'), JSON.stringify({ contractFaninDistill: true }));
    expect(readExperimentFlags()).toEqual({ contractFaninDistill: true });
    expect(errSpy).not.toHaveBeenCalled();
  });

  // 证伪: 若 catch 块吞掉证据(不 console.error 或不带路径) → 断言 toHaveBeenCalled/路径包含 当场红。
  test('坏 JSON → fail-open 视同 off, 但 console.error 必留一行含路径与错误原文', () => {
    const path = join(root, '.omd', 'experiments.json');
    writeFileSync(path, '{ not valid json');
    expect(readExperimentFlags()).toEqual({ contractFaninDistill: false });
    expect(errSpy).toHaveBeenCalledTimes(1);
    const msg = errSpy.mock.calls[0]?.[0] as string;
    expect(msg).toContain(path);
  });
});
