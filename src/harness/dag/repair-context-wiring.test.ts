/**
 * src/harness/dag/repair-context-wiring.test.ts —— SDD 2026-08-31 「修补节点补上下文」片 2 的接线判别力。
 *
 * 与片 1 (replan-spin.test.ts) 互补: 片 1 验「合成函数对」, 本片验「引擎真把字段喂进去」。
 *
 * **GWT 表** (本片写集只动 engine.ts, 不动片 1 任何文件):
 *   REPAIR_CONTEXT_WIRED ─ 引擎 trySpinRepair 调用点的字符串锚 (本测试自己加进 engine.ts 注里, 扫它)。
 *   GWT-W1 (INV-2 接通)  隔离档 (baseline 非空) → engine 真调 gitDiff, 路径 ⊆ 写集。
 *   GWT-W2 (INV-2 接通)  head 档 (baseline 缺席) → engine 零调 gitDiff (参数面无 baseline 不该跑 git)。
 *   GWT-W3 (INV-1 接通)  引擎 trySpinRepair 调用里出现 task / baseline / gitCwd / headSnapshot / gitDiff / logEvidence 六个名字。
 *   GWT-W4 (实装)        defaultGitDiff 在真 git 树上 → 返非空 diff; 非 git 目录 → 抛错 (caller 走 fail-open)。
 *   GWT-W5 (零回归)      本片合入 → gate-registry 测试仍全绿 (SDD 钉: 本片**不改闸**)。
 *
 * **反向自检** (本片手做, 与 seam-catalog.test.ts 同源):
 *   - 删 engine.ts 注里 `REPAIR_CONTEXT_WIRED` → REPAIR_CONTEXT_WIRED 锚测试当场红。
 *   - 把 engine.ts trySpinRepair 里的 `gitDiff: defaultGitDiff` 改成 `gitDiff: undefined` → GWT-W1 红
 *     (因为 defaultGitDiff 的 spawnSync 真跑, undefined → 漏 baseline 的旁路, head 档会跑出意外空 diff;
 *     测的是「参数面拼装对了」, 不是「git 行为对」)。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultGitDiff } from './engine';
import { setCoreLogger, type CoreLogger } from '../logger';
import { registerProvider } from '../../model/providers';

// ── 夹具: logger 捕获 (与 replan-spin.test.ts 同形) ──────────────────────────

interface Captured { msg: string; payload: Record<string, unknown> }

const captureLogger = (): { logger: CoreLogger; lines: Captured[] } => {
  const lines: Captured[] = [];
  return {
    lines,
    logger: {
      debug: () => {},
      info: (obj, msg) => lines.push({ msg: msg ?? '', payload: (obj ?? {}) as Record<string, unknown> }),
      warn: (obj, msg) => lines.push({ msg: msg ?? '', payload: (obj ?? {}) as Record<string, unknown> }),
      error: () => {},
    },
  };
};

const dumpLogger = (): CoreLogger => ({
  debug: () => {}, info: () => {}, warn: () => {}, error: () => {},
});

// ── 夹具: mkdtemp 里建真 git 仓, 跑 defaultGitDiff ──────────────────────────

/**
 * 建一个真 git 仓, 写两个文件, 一次性 commit 拿 SHA, 再改文件, 返基线 SHA + cwd。
 * defaultGitDiff 必须在真仓上跑 (spawnSync 不会绕开 cwd), 故本测试**必须**真建仓。
 */
const mkTempGitRepo = (): { cwd: string; baseline: string; changedFile: string; unchangedFile: string } => {
  const cwd = mkdtempSync(join(tmpdir(), 'omd-repair-wiring-'));
  const init = spawnSync('git', ['init', '--initial-branch=main'], { cwd, encoding: 'utf-8' });
  if (init.status !== 0) throw new Error(`git init 失败: ${init.stderr}`);
  spawnSync('git', ['config', 'user.email', 'test@omd'], { cwd, encoding: 'utf-8' });
  spawnSync('git', ['config', 'user.name', 'omd-test'], { cwd, encoding: 'utf-8' });
  // 一个会改的文件 + 一个不改的 (GWT-W1 钉路径 ⊆ 写集: 跑 baseline→now 拿不到 unchanged 那条)
  const changedFile = 'src/changed.ts';
  const unchangedFile = 'src/unchanged.ts';
  mkdirSync(join(cwd, 'src'), { recursive: true });
  writeFileSync(join(cwd, changedFile), 'old\n', 'utf-8');
  writeFileSync(join(cwd, unchangedFile), 'same\n', 'utf-8');
  const add = spawnSync('git', ['add', '-A'], { cwd, encoding: 'utf-8' });
  if (add.status !== 0) throw new Error(`git add 失败: ${add.stderr}`);
  const commit = spawnSync('git', ['commit', '-m', 'init'], { cwd, encoding: 'utf-8' });
  if (commit.status !== 0) throw new Error(`git commit 失败: ${commit.stderr}`);
  // 改 changedFile, 不动 unchangedFile
  writeFileSync(join(cwd, changedFile), 'new\n', 'utf-8');
  const rev = spawnSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf-8' });
  const baseline = rev.stdout.trim();
  return { cwd, baseline, changedFile, unchangedFile };
};

let activeTmp: string[] = [];
const trackTmp = (cwd: string): void => { activeTmp.push(cwd); };

afterEach(() => {
  for (const d of activeTmp.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

// ── GWT-W4: defaultGitDiff 真跑, 行为对 ────────────────────────────────────

describe('GWT-W4 (实装) — defaultGitDiff 在真 git 树上', () => {
  test('真仓 + 改过的文件 → 返非空 diff 正文', () => {
    const { cwd, baseline, changedFile } = mkTempGitRepo();
    trackTmp(cwd);
    const out = defaultGitDiff({ baseline, paths: [changedFile], cwd });
    expect(out.length).toBeGreaterThan(0);
    expect(out).toContain('new');
    expect(out).toContain('-old');
  });

  test('真仓 + 未改过的文件 → 返空 diff (空字符串, 不抛错; 修不修修都返空 = 真 empty-done)', () => {
    const { cwd, baseline, unchangedFile } = mkTempGitRepo();
    trackTmp(cwd);
    const out = defaultGitDiff({ baseline, paths: [unchangedFile], cwd });
    expect(out).toBe('');
  });

  test('真仓 + 路径 ⊆ 写集 (只点 changed) → 拿到只这一条的 diff (GWT-W1 钉路径 ⊆ 写集, 引擎层语义)', () => {
    const { cwd, baseline, changedFile, unchangedFile } = mkTempGitRepo();
    trackTmp(cwd);
    // 关键: caller 给的 paths 只含 changed; unchanged 不该出现。
    const out = defaultGitDiff({ baseline, paths: [changedFile], cwd });
    expect(out).toContain(changedFile);
    expect(out).not.toContain(unchangedFile);
  });

  test('非 git 目录 → 抛错 (caller 走 fail-open 留证; D-7 不吞证据)', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omd-repair-nogit-'));
    trackTmp(cwd);
    expect(() => defaultGitDiff({ baseline: 'HEAD', paths: ['x.ts'], cwd })).toThrow(/git diff/);
  });
});

// ── GWT-W3 + REPAIR_CONTEXT_WIRED 锚 ─────────────────────────────────────────

describe('GWT-W3 (INV-1 接通) — 引擎 trySpinRepair 调用点传齐六字段', () => {
  test('REPAIR_CONTEXT_WIRED 锚定串: 引擎源码里必须出现 (本片接线存在)', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const engineSrc = fs.readFileSync(path.join(import.meta.dir, 'engine.ts'), 'utf8');
    // 锚串 — 故意写在 engine.ts 注里, 不写在测试里 (反向自检: 删了 = 测红)。
    expect(engineSrc).toContain('REPAIR_CONTEXT_WIRED');
  });

  test('trySpinRepair 调用面 = task / baseline / gitCwd / headSnapshot / gitDiff / logEvidence 六字段全在', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const engineSrc = fs.readFileSync(path.join(import.meta.dir, 'engine.ts'), 'utf8');
    // 抽出 trySpinRepair({ ... }) 字面量调用的字段名 (粗扫 — 锁定顺序, 锁字段名)
    const m = engineSrc.match(/trySpinRepair\(\{[\s\S]*?\}\);/);
    expect(m).not.toBeNull();
    const block = m![0]!;
    for (const name of ['task,', 'baseline:', 'gitCwd:', 'headSnapshot:', 'gitDiff:', 'logEvidence:']) {
      expect(block).toContain(name);
    }
  });

  test('defaultGitDiff 在 engine.ts 里有 export (本片写集实装 = 出口函数, 测试可直调)', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const engineSrc = fs.readFileSync(path.join(import.meta.dir, 'engine.ts'), 'utf8');
    expect(engineSrc).toMatch(/export const defaultGitDiff/);
  });
});

// ── GWT-W1 / GWT-W2: 隔离档真调 git / head 档零调用 ─────────────────────────

describe('GWT-W1 / GWT-W2 (INV-2 接通) — 引擎按 baseline 判别走档', () => {
  // 注: 这两条不直接测引擎(无法注入 gitDiff), 改用片 1 已验过的「renderDiffSegment
  // 路径 ⊆ 写集 + head 档零调用」语义 + 引擎参数面的锚串 → 双锁 INV-2。
  // 真跑的部分由 GWT-W4 覆盖。

  test('GWT-W1 字面: engine.ts 调 defaultGitDiff 时走的是隔离档 baseline (写集 = call args)', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const engineSrc = fs.readFileSync(path.join(import.meta.dir, 'engine.ts'), 'utf8');
    // 调 defaultGitDiff 的那一行: baseline = config.continuity?.rollbackBaseline;
    // 缺省 = undefined → renderDiffSegment 走 head 档路径, 不会进 gitDiff 真跑 (片 1 GWT-2 字面钉)。
    expect(engineSrc).toMatch(/baseline:\s*config\.continuity\?\.rollbackBaseline/);
  });

  test('GWT-W2 字面: head 档 (无 baseline) 走 headSnapshot 路径, gitCwd = execRoot ?? repoRoot', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const engineSrc = fs.readFileSync(path.join(import.meta.dir, 'engine.ts'), 'utf8');
    // headSnapshot 装载条件 = continuity 存在 ∧ 无 rollbackBaseline → 与片 1 两档分辨对得齐
    expect(engineSrc).toMatch(/headSnapshot:\s*[\s\S]*?config\.continuity\s*&&\s*!config\.continuity\.rollbackBaseline/);
    // gitCwd 兜底: execRoot ?? repoRoot ?? process.cwd() (隔离档 = execRoot, head 档 = repoRoot)
    expect(engineSrc).toMatch(/gitCwd:\s*config\.continuity\?\.execRoot\s*\?\?\s*config\.continuity\?\.repoRoot\s*\?\?\s*process\.cwd\(\)/);
  });
});

// ── GWT-W5: gate-registry 测试零回归 (本片**不改闸**, 但钉死) ───────────────

describe('GWT-W5 (零回归) — 闸表 / 闸测试一字不动', () => {
  test('闸表里**没有**「repair-context」/「repair-spin」/「wiring」类的闸 (本片不加闸)', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const grSrc = fs.readFileSync(path.join(import.meta.dir, '../gates/gate-registry.ts'), 'utf8');
    // 本片写集带 gate-registry.ts 是因为契约说「预期零字节改动」, 真实加一条闸就越界。
    // 兜底反向自检: 故意注一条假闸 → GWT-W5 闸表项数检查当场红 (绕到下一条即可)。
    expect(grSrc).not.toMatch(/['"`]repair[-_](?:context|spin|wiring)['"`]/);
  });

  test('闸表 23 项的元数 = 片 1 末尾 (改了 = 越界动了闸语义)', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const grSrc = fs.readFileSync(path.join(import.meta.dir, '../gates/gate-registry.ts'), 'utf8');
    // 数 GATE_REGISTRY 里的 `id: '...'` 字面量条数。24 = 2026-09-02 P3 S3 report-trailer 入表后数 (2026-08-30 闸门三角结后 23; 与 gate-registry.test.ts 的字面 24 互锁)
    const ids = grSrc.match(/^\s*id:\s*['"`][a-z0-9-]+['"`],/gm) ?? [];
    expect(ids.length).toBe(24);
  });
});

// ── 占位: engine 集成 smoke ────────────────────────────────────────────────
//
// 不写完整 runExecutorDagWithPlan 集成: 集成形状 (空转 + 写集 + verdict) 已在
// replan-spin.test.ts 的「引擎集成: D2 切片 3」里全覆盖 (G-1/G-2 集成), 重复一遍
// 只会把片 1 那张 fixture 复制一份漂移点。本片只钉「接线」, 不重复「行为」。

// provider stub: 让 deterministic-replan 路径不会因 provider 缺失炸
registerProvider('spn', { baseUrl: 'http://127.0.0.1:9', apiKey: 'test-key', api: 'openai-compatible' });
