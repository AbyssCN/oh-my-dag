/**
 * profile 库自检:G-1 字段级 merge (项目层胜)、内置加载、未知名 → undefined、确定性隔离。
 * 影子测试用**真实内置档案** design-review (P4 首个条目, 测试只读不写内置目录):
 * 项目层 .omd/profiles/design-review.json 覆盖其中部分字段 → 断言覆盖字段项目值胜、
 * 未写字段保留内置值 (字段级 merge, 不是整体覆盖)。隔离纪律:每个测试独立临时 cwd,
 * afterEach 清掉 → 测试间零共享状态、不污染仓库。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setCoreLogger, type CoreLogger } from '../logger';
import { loadProfiles, resolveProfile, type ProfileSpec } from './profile';

const BUILTIN_DIR = join(import.meta.dir, 'builtin');
const BUILTIN_FILE = 'design-review.json';

const consoleLogger: CoreLogger = {
  debug: () => {},
  info: (o, m) => console.log(m ?? '', typeof o === 'string' ? o : ''),
  warn: (o, m) => console.warn(m ?? '', typeof o === 'string' ? o : ''),
  error: (o, m) => console.error(m ?? '', o),
};

let cwd: string;
const warns: Array<{ file: string; err: string; msg: string }> = [];

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'profiles-'));
  warns.length = 0;
  setCoreLogger({
    debug: () => {},
    info: () => {},
    warn(o, m) {
      const r = o as { file?: string; err?: string };
      warns.push({ file: String(r.file ?? ''), err: String(r.err ?? ''), msg: m ?? '' });
    },
    error(o, m) {
      const r = o as { file?: string; err?: string };
      warns.push({ file: String(r.file ?? ''), err: String(r.err ?? ''), msg: m ?? '' });
    },
  });
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
  setCoreLogger(consoleLogger);
});

/** 读真实内置档案 (只读, 不造夹具) —— 影子测试的"被覆盖方"。 */
const readBuiltin = (): ProfileSpec =>
  JSON.parse(readFileSync(join(BUILTIN_DIR, BUILTIN_FILE), 'utf8')) as ProfileSpec;

const writeProject = (file: string, spec: Partial<ProfileSpec>): void => {
  mkdirSync(join(cwd, '.omd', 'profiles'), { recursive: true });
  writeFileSync(join(cwd, '.omd', 'profiles', file), JSON.stringify(spec));
};

describe('profiles', () => {
  test('G-1: 项目层影子覆盖真实内置 → 项目字段胜、未写字段保留内置值', () => {
    const builtin = readBuiltin();
    // 项目层只写 persona + seat, 其余字段不写 → 应保留内置值。
    writeProject(BUILTIN_FILE, { name: builtin.name, persona: 'project-persona', seat: 'project-seat' });

    const p = loadProfiles(cwd).get(builtin.name);
    expect(p).toBeDefined();
    expect(p?.persona).toBe('project-persona'); // 覆盖字段 → 项目值胜
    expect(p?.seat).toBe('project-seat');
    // 未写字段保留内置值 → 字段级 merge, 不是整体覆盖。
    expect(p?.outputSchema).toBe(builtin.outputSchema);
    expect(p?.ledgerPath).toBe(builtin.ledgerPath);
    expect(p?.skills).toEqual(builtin.skills);
    expect(p?.tools).toEqual(builtin.tools);
    expect(p?.frontendGlob).toBe(builtin.frontendGlob);
  });

  test('内置加载:无项目层时 design-review 以完整内置值出现', () => {
    const builtin = readBuiltin();
    const all = loadProfiles(cwd);
    expect(all.size).toBe(1); // 全新临时 cwd 无项目档案 → 只有内置, 隔离干净
    expect(all.get(builtin.name)).toEqual(builtin);
  });

  test('未知名 → undefined, 不抛', () => {
    expect(resolveProfile('no-such-profile', cwd)).toBeUndefined();
    expect(loadProfiles(cwd).has('no-such-profile')).toBe(false);
  });

  test('确定性隔离:项目层只影响自身 cwd, 同 cwd 重复加载结果一致', () => {
    writeProject('local-only.json', { name: 'local-only', persona: 'p' });
    const withProject = [...loadProfiles(cwd)];

    const other = mkdtempSync(join(tmpdir(), 'profiles-'));
    try {
      expect([...loadProfiles(other)]).toEqual([...loadProfiles(other)]); // 重复加载无状态变异
      expect(loadProfiles(other).has('local-only')).toBe(false); // 不跨 cwd 泄漏
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
    expect([...loadProfiles(cwd)]).toEqual(withProject);
  });

  test('损坏 json 单文件跳过不炸整表, 且留证据 (文件名 + 错误原文)', () => {
    writeProject('broken.json', '{ not json !!!' as unknown as ProfileSpec);
    writeProject('good.json', { name: 'zz-good', persona: 'p' });

    const all = loadProfiles(cwd);
    expect(all.get('zz-good')?.persona).toBe('p'); // 好文件照常加载
    expect(all.has('broken')).toBe(false); // 坏文件不产生条目
    const ev = warns.find((w) => w.file.endsWith('broken.json'));
    expect(ev).toBeDefined(); // 证据:文件名…
    expect(ev?.err.length).toBeGreaterThan(0); // …与错误原文
  });
});
