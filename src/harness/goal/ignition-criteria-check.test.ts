/**
 * ignition-criteria-check 测试 (C-1 / #251 / INV-4)。
 *
 * 覆盖 GWT 五条 + INV-4 反向自检闸 (lint 全过而预绿 → rejected, 一条永远绿的闸不是闸):
 * ① 片写集含新建 ∧ stub exit 0 → rejected, finding=pre-green;
 * ② stub exit 1 → ok (verify 实际会失败 = 本片工作还没干);
 * ③ verify 引用盘上不存在且不在写集的路径 → rejected, finding=missing-path;
 * ④ 写集含新建 ∧ verify 首段混既有文件 → rejected, finding=mixed-first-segment;
 * ⑤ 多片多 finding → findings 全量返回 (长度 = 缺陷数, 不是 1)。
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  checkIgnitionCriteria,
  type IgnitionCriteriaFinding,
  type IgnitionRunCommand,
} from './ignition-criteria-check';
import type { SddSlice } from './sdd-direct';

const dirs: string[] = [];
const freshRoot = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'omd-criteria-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const slice = (id: number, writeSet: string[], verify: string): SddSlice => ({
  id,
  name: `切片${id}`,
  writeSet,
  deps: [],
  verify,
});

/** 铺一个文件 (自动建父目录)。 */
const touchFile = (root: string, relPath: string): void => {
  const abs = join(root, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, '');
};

/** 按 verify 串字串路由退出码: 匹配首个命中键 → 该退出码; 全不命中 → 1 (默认失败)。 */
const runnerBy = (map: Record<string, number | null>): IgnitionRunCommand => {
  return async ({ command }) => {
    for (const [pat, code] of Object.entries(map)) {
      if (command.includes(pat)) return { exitCode: code };
    }
    return { exitCode: 1 };
  };
};
const passingRunner: IgnitionRunCommand = async () => ({ exitCode: 0 });
const failingRunner: IgnitionRunCommand = async () => ({ exitCode: 1 });

const findFor = (all: IgnitionCriteriaFinding[], sliceId: number, kind: IgnitionCriteriaFinding['kind']) =>
  all.find((f) => f.sliceId === sliceId && f.kind === kind);

describe('checkIgnitionCriteria (C-1 / #251)', () => {
  // ── GWT ① + ②: stub 退出码决定 pre-green 是否触发 ─────────────────────────

  test('GWT①: 片写集含新建 ∧ stub 回 exit 0 → rejected, finding=pre-green 带片 id', async () => {
    const root = freshRoot();
    // 写集仅含新建文件, verify 引用写集内的同一文件 —— 排除 missing-path / mixed-first-segment
    // 的干扰, 断言精确指向 pre-green 这一条 finding (GWT 文面是「finding=pre-green」非「only」,
    // 但本测试用 verify 路径在写集内的形状把其他闸的输入压平, 做到严格 toEqual)。
    const slices = [slice(1, ['src/new.ts'], `bun test src/new.ts`)];
    const r = await checkIgnitionCriteria(root, slices, passingRunner);
    expect(r.verdict).toBe('rejected');
    expect(r.findings).toEqual([{ sliceId: 1, kind: 'pre-green', detail: 'bun test src/new.ts' }]);
  });

  test('GWT②: stub 回 exit 1 → ok (verify 在本片未干时本就该失败)', async () => {
    const root = freshRoot();
    const slices = [slice(1, ['src/new.ts'], `bun test src/new.ts`)];
    const r = await checkIgnitionCriteria(root, slices, failingRunner);
    expect(r.verdict).toBe('ok');
    expect(r.findings).toEqual([]);
  });

  // ── GWT ③: missing-path (verify 引用盘上不在、写集也不收的路径) ───────────

  test('GWT③: verify 引用盘上不存在且不在写集的路径 → rejected, finding=missing-path 带 token 原文', async () => {
    const root = freshRoot();
    // 写集里是盘上存在的文件 → newFiles=[], 既不触发 pre-green 也不触发 mixed-first-segment,
    // 唯一 finding = missing-path (GWT 文面要求精确)。
    touchFile(root, 'src/keep.ts');
    const slices = [slice(2, ['src/keep.ts'], `bun test src/ghost.test.ts`)];
    const r = await checkIgnitionCriteria(root, slices, failingRunner);
    expect(r.verdict).toBe('rejected');
    expect(r.findings).toEqual([{ sliceId: 2, kind: 'missing-path', detail: 'src/ghost.test.ts' }]);
  });

  // ── GWT ④: mixed-first-segment (写集含新建 ∧ verify 首段混既有) ───────────

  test('GWT④: 写集含新建 ∧ verify 首段混既有文件 → rejected, finding=mixed-first-segment', async () => {
    const root = freshRoot();
    // 既有测试文件铺在盘上, 不在本片写集 —— 既不触发 missing-path (exists=true), 又被
    // mixed-first-segment 抓 (inWriteSet=false);写集仅一个新建文件 → newFiles 不空。
    touchFile(root, 'src/existing.test.ts');
    const slices = [slice(3, ['src/new.ts'], `bun test src/existing.test.ts`)];
    const r = await checkIgnitionCriteria(root, slices, failingRunner);
    expect(r.verdict).toBe('rejected');
    expect(r.findings).toEqual([
      { sliceId: 3, kind: 'mixed-first-segment', detail: 'src/existing.test.ts' },
    ]);
  });

  // ── GWT ⑤: 多片多 finding → findings 全量返回 (长度 = 缺陷数) ─────────────

  test('GWT⑤: 多片多 finding → findings 全量返回 (长度 = 缺陷数, 不是 1)', async () => {
    const root = freshRoot();
    // 三片各触一种 finding, 用 verify 串字串路由退出码, 让每片只暴露自己的那一类。
    // 片 30 写集 = 盘上存在的 src/keep30.ts (newFiles=[]) → 只缺 missing-path, 不掺 mixed。
    // 片 31 写集 = 新建 src/new31.ts → 触发 mixed-first-segment (verify 引既有测试)。
    // 片 32 写集 = 新建 src/new32.ts, verify 引写集内 → 走 pre-green 闸 (runner 路由 exit 0)。
    touchFile(root, 'src/keep30.ts');
    touchFile(root, 'src/existing31.test.ts');

    const s30 = slice(30, ['src/keep30.ts'], `bun test src/ghost30.test.ts`);
    const s31 = slice(31, ['src/new31.ts'], `bun test src/existing31.test.ts && echo done`);
    const s32 = slice(32, ['src/new32.ts'], `bun test src/new32.ts`);

    const runner: IgnitionRunCommand = async ({ command }) => {
      if (command.includes('src/new32.ts')) return { exitCode: 0 };
      return { exitCode: 1 };
    };
    const r = await checkIgnitionCriteria(root, [s30, s31, s32], runner);
    expect(r.verdict).toBe('rejected');
    expect(r.findings).toHaveLength(3);
    expect(r.findings).toEqual(
      expect.arrayContaining([
        { sliceId: 30, kind: 'missing-path', detail: 'src/ghost30.test.ts' },
        { sliceId: 31, kind: 'mixed-first-segment', detail: 'src/existing31.test.ts' },
        { sliceId: 32, kind: 'pre-green', detail: 'bun test src/new32.ts' },
      ]),
    );
    // 一片一类, 不漏不多。
    expect(r.findings.filter((f) => f.sliceId === 30)).toHaveLength(1);
    expect(r.findings.filter((f) => f.sliceId === 31)).toHaveLength(1);
    expect(r.findings.filter((f) => f.sliceId === 32)).toHaveLength(1);
  });
});

describe('checkIgnitionCriteria — 闸面边缘 / INV-4 反向自检', () => {
  test('INV-4 反向自检: lint 全过而预绿 → rejected (闸能红的证伪, 不许恒绿)', async () => {
    const root = freshRoot();
    // 同一片同一输入, 只换 runner: exit 1 → ok, exit 0 → rejected. 闸面既能放行也能拒绝,
    // 把「永远绿」这条永远闸杀掉 (本仓新闸纪律, C-1 INV-4)。
    const slices = [slice(10, ['src/n.ts'], `bun test src/n.ts`)];
    const ok = await checkIgnitionCriteria(root, slices, failingRunner);
    expect(ok.verdict).toBe('ok');
    const red = await checkIgnitionCriteria(root, slices, passingRunner);
    expect(red.verdict).toBe('rejected');
    expect(red.findings).toEqual([{ sliceId: 10, kind: 'pre-green', detail: 'bun test src/n.ts' }]);
  });

  test('本片无新建文件 (写集全是既有) ∧ runner exit 0 → ok, 不判 pre-green', async () => {
    const root = freshRoot();
    // 修改既有文件这类片: verify 在改动前后都可能退 0, 不构成预绿信号 (D-3② 末段规则)。
    touchFile(root, 'src/existing.ts');
    touchFile(root, 'src/existing.test.ts');
    const slices = [slice(11, ['src/existing.ts'], `bun test src/existing.test.ts`)];
    const r = await checkIgnitionCriteria(root, slices, passingRunner);
    expect(r.verdict).toBe('ok');
    expect(r.findings).toEqual([]);
  });

  test('本片无新建文件 → mixed-first-segment 也不查 (避免误拒修改既有片)', async () => {
    const root = freshRoot();
    touchFile(root, 'src/old.ts');
    // 写集里只有既有文件 → newFiles=[], 首段引用其他既有文件 = 完全合法的修改既有片,
    // 不应被 mixed-first-segment 闸误拒。
    const slices = [slice(12, ['src/old.ts'], `bun test src/other.test.ts`)];
    touchFile(root, 'src/other.test.ts');
    const r = await checkIgnitionCriteria(root, slices, failingRunner);
    expect(r.verdict).toBe('ok');
    expect(r.findings).toEqual([]);
  });

  test('verify 段以 `&&` 串联, firstSegment 只看第一个 `&&` 之前 (INV-5c 机械化)', async () => {
    const root = freshRoot();
    touchFile(root, 'src/existing.test.ts');
    // 首段引用既有 (mixed), 第二段引用本片写集内的新建 (合法) —— 仅 mixed 触发,
    // 第二段不进入 mixed 闸面。
    const slices = [slice(13, ['src/new13.ts'], `bun test src/existing.test.ts && bun test src/new13.ts`)];
    const r = await checkIgnitionCriteria(root, slices, failingRunner);
    expect(r.verdict).toBe('rejected');
    expect(r.findings).toEqual([
      { sliceId: 13, kind: 'mixed-first-segment', detail: 'src/existing.test.ts' },
    ]);
  });

  test('empty verify → 无 token / 无 pre-green 信号, ok', async () => {
    const root = freshRoot();
    const slices = [slice(14, ['src/new14.ts'], '')];
    const r = await checkIgnitionCriteria(root, slices, passingRunner);
    expect(r.verdict).toBe('ok');
    expect(r.findings).toEqual([]);
  });

  test('路径 token 启发式: 含 / 且 .ts/.tsx/.js/.json/.md 结尾, 排除绝对路径与无 /', async () => {
    const root = freshRoot();
    // 同一 verify 内混三种 token: (a) 合法相对路径 src/ok.test.ts, (b) 无 / 的 tsconfig.json
    // (false-positive 候选), (c) 绝对路径 /usr/local/foo.ts (排除项)。期望: 仅 (a) 被识别为
    // 路径 token, 进 missing-path finding (不在写集)。
    const slices = [
      slice(
        15,
        ['src/new15.ts'],
        `bun test --config=tsconfig.json src/ok.test.ts && cat /usr/local/foo.ts`,
      ),
    ];
    const r = await checkIgnitionCriteria(root, slices, failingRunner);
    const missing = r.findings.filter((f) => f.kind === 'missing-path');
    expect(missing).toEqual([{ sliceId: 15, kind: 'missing-path', detail: 'src/ok.test.ts' }]);
    // tsconfig.json 与 /usr/local/foo.ts 都不进入路径 token 集合。
    expect(r.findings.some((f) => f.detail === 'tsconfig.json')).toBe(false);
    expect(r.findings.some((f) => f.detail === '/usr/local/foo.ts')).toBe(false);
  });

  test('token 支持 .tsx/.js/.json/.md 后缀 (与 .ts 同等)', async () => {
    const root = freshRoot();
    // 4 片共用同一写集 (盘上存在的 src/keep.ts → newFiles=[]) → 排除 mixed-first-segment
    // 与 pre-green, 只留 missing-path 闸面, 验证四种后缀都被识别为路径 token。
    touchFile(root, 'src/keep.ts');
    const slices = [
      slice(16, ['src/keep.ts'], `bun test src/x.tsx`),
      slice(17, ['src/keep.ts'], `bun test src/x.js`),
      slice(18, ['src/keep.ts'], `bun test src/x.json`),
      slice(19, ['src/keep.ts'], `bun test src/x.md`),
    ];
    const r = await checkIgnitionCriteria(root, slices, failingRunner);
    expect(r.verdict).toBe('rejected');
    expect(r.findings.map((f) => f.detail).sort()).toEqual(['src/x.js', 'src/x.json', 'src/x.md', 'src/x.tsx']);
  });

  test('同片触发两类 finding → 全量返回 (lint 与实跑并行收集, 不挤牙膏)', async () => {
    const root = freshRoot();
    touchFile(root, 'src/existing.test.ts');
    // 写集含新建, 首段引既有 (mixed) + runner exit 0 (pre-green) → 同片两 finding。
    const slices = [slice(20, ['src/new20.ts'], `bun test src/existing.test.ts`)];
    const r = await checkIgnitionCriteria(root, slices, passingRunner);
    expect(r.verdict).toBe('rejected');
    const kinds = r.findings.filter((f) => f.sliceId === 20).map((f) => f.kind);
    expect(kinds).toEqual(expect.arrayContaining(['mixed-first-segment', 'pre-green']));
  });

  test('多片混合: ok 片与有缺陷片共存 → rejected, findings 仅 defects', async () => {
    const root = freshRoot();
    touchFile(root, 'src/keep21.ts');
    const ok = slice(21, ['src/keep21.ts'], `bun test src/keep21.ts`);
    const bad = slice(22, ['src/new22.ts'], `bun test src/ghost22.test.ts`);
    const r = await checkIgnitionCriteria(root, [ok, bad], failingRunner);
    expect(r.verdict).toBe('rejected');
    expect(r.findings.filter((f) => f.sliceId === 21)).toEqual([]);
    expect(findFor(r.findings, 22, 'missing-path')?.detail).toBe('src/ghost22.test.ts');
  });

  test('stub 返回 exitCode=null (信号杀) → 不视为 pre-green, 该片过 lint 后 ok', async () => {
    const root = freshRoot();
    // 预绿判据只看 exitCode===0; 信号被杀是另一回事 (跟命令闸的子进程失败区分开)。
    const slices = [slice(23, ['src/new23.ts'], `bun test src/new23.ts`)];
    const signalRunner: IgnitionRunCommand = async () => ({ exitCode: null });
    const r = await checkIgnitionCriteria(root, slices, signalRunner);
    expect(r.verdict).toBe('ok');
    expect(r.findings).toEqual([]);
  });

  test('runnerBy 多键路由: 按 verify 串字串前缀匹配 exit 码 (为 GWT⑤ 准备)', async () => {
    const root = freshRoot();
    // 两条 verify 各自路由: 'a' → exit 0 (pre-green), 'b' → exit 1 (不触发)。
    const slices = [slice(24, ['src/na.ts'], `a`), slice(25, ['src/nb.ts'], `b`)];
    const r = await checkIgnitionCriteria(root, slices, runnerBy({ a: 0, b: 1 }));
    expect(r.verdict).toBe('rejected');
    expect(findFor(r.findings, 24, 'pre-green')?.detail).toBe('a');
    expect(findFor(r.findings, 25, 'pre-green')).toBeUndefined();
  });
});
// ── 回归: `./` 前缀归一化 (2026-08-25 活体误杀, run 8810fd65 首点火被拒) ────────
// bun 官方建议路径 filter 写 `./src/x.test.ts` (裸 filter 会被当测试名过滤), 而写集条目
// 是 `src/x.test.ts` —— 比对前不剥 `./` 就是 missing-path + mixed-first-segment 双误杀。
describe('path token `./` 前缀归一化 (真实契约的 verify 惯用法)', () => {
  test('★ 新建文件以 `./` 引用 + 写集无前缀 → 零 findings, verdict ok', async () => {
    const root = freshRoot();
    touchFile(root, 'src/guard.test.ts'); // 既有守护测试
    const s = slice(
      1,
      ['src/x.ts', 'src/x.test.ts'],
      'bun test ./src/x.test.ts && bun test src/guard.test.ts',
    );
    const report = await checkIgnitionCriteria(root, [s], runnerBy({ 'bun test': 1 }));
    expect(report.findings).toEqual([]);
    expect(report.verdict).toBe('ok');
  });
});
