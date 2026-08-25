/**
 * catch-evidence-scan `--files --base` 入口的判别力闸 (SDD s1 切片 1, O-6)。
 *
 * 两层各两条 (正例 + 反例):
 *   ① 纯函数 `netIncreaseVsBase(currentSites, baseSites)` —— 文件/行级别净增比对;
 *   ② CLI `--files f... --base <ref>` —— 起真 git tree, 跑实命令验退出码 + 输出。
 *
 * 反向自检 (任一改则此 test 由绿转红):
 *   - 净增逻辑写反 (current ⊆ base 时返回 baseSites 而不是 []) ⇒ ① 反例红;
 *   - base 缺席时返 nullSites 当成「空集」⇒ ① 「base 缺席 ⇒ 全算净增」红;
 *   - CLI 把 `--base` 漏掉照样跑 ⇒ ② 「--files 必须配 --base」红;
 *   - 退出码逻辑写反 (净增 > 0 时 exit 0) ⇒ ② 正例红;
 *   - `resolvePaths` 把相对/绝对切成两套 ⇒ ② 正例「file:line 对得上」红。
 *
 * 路径口径: 喂给 CLI / `scanFilesVsBase` 的 `file` 走 repo-相对(给 `git show <ref>:f`),
 * `readFileSync` 那一半由函数内部 join `cwd` 解决。测试 cwd = TMP, 走真 git tree。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  fetchBaseSource,
  netIncreaseVsBase,
  scanCatchEvidence,
  scanFilesVsBase,
  type CatchSite,
} from './catch-evidence-scan';

// ── 装置: 临时 git tree ────────────────────────────────────────────────────

let TMP = mkdtempSync(join(tmpdir(), 'catch-evidence-files-'));

function initGit(root: string): void {
  spawnSync('git', ['init', '-q'], { cwd: root });
  spawnSync('git', ['config', 'user.email', 't@local'], { cwd: root });
  spawnSync('git', ['config', 'user.name', 't'], { cwd: root });
}

/** 在 TMP 下写文件 + commit, 返回绝对路径(写入磁盘用)。 */
function writeAndCommit(rel: string, body: string, msg = 'baseline'): string {
  const abs = join(TMP, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, body);
  spawnSync('git', ['add', '-A'], { cwd: TMP });
  spawnSync('git', ['commit', '-q', '-m', msg], { cwd: TMP });
  return abs;
}

/** `--allow-empty` 兜底: 即便没东西可提, 也造一个 tip commit, 让 `git show` 拿得到文件。 */
function commitAll(msg: string): string {
  spawnSync('git', ['add', '-A'], { cwd: TMP });
  spawnSync('git', ['commit', '-q', '--allow-empty', '-m', msg], { cwd: TMP });
  return spawnSync('git', ['rev-parse', 'HEAD'], { cwd: TMP, encoding: 'utf8' }).stdout.trim();
}

// ── ① 纯函数 ────────────────────────────────────────────────────────────────

describe('净增比对 (纯函数)', () => {
  // 2026-08-26: 判据从**行号锚**改成**内容指纹的多重集**, 本组用例随之重写。
  // 改判据的理由不是「测试难写」, 是判据本身错: 行号锚下, 在文件前部插入 N 行会让
  // 后面每个既有 catch 的行号 +N、整批被算成新增 —— run 5bcfa2b2 因此被误杀
  // (engine.ts 只改 47 行, 报净增 9 处, 点名的还是既有的 artifactReader fail-open)。
  // 修后同一份写集的净增从 20 处落到 2 处, 而那 2 处是真的。
  // `line` 字段保留(报告要用它定位), 但**不再参与判定**。
  const site = (line: number, kind: 'silent' | 'empty', sig: string): CatchSite =>
    ({ file: 'a.ts', line, kind, sig });

  test('正例: base 缺席 (null) ⇒ 当前所有 sites 全算净增', () => {
    const cur: CatchSite[] = [site(5, 'silent', 'catch{returnnull;}'), site(9, 'empty', 'catch{}')];
    const r = netIncreaseVsBase(cur, null);
    expect(r.netIncrease).toBe(2);
    expect(r.newSites).toEqual(cur);
  });

  test('正例: base 有同款指纹 ⇒ 不算净增; 指纹没见过的算', () => {
    const cur: CatchSite[] = [
      site(5, 'silent', 'catch{returnnull;}'), // base 里有同款
      site(7, 'silent', 'catch{returnundefined;}'), // 没见过
      site(9, 'empty', 'catch{}'), // 没见过
    ];
    const base: CatchSite[] = [
      site(5, 'silent', 'catch{returnnull;}'),
      site(6, 'silent', 'catch{swallow();}'), // base 独有, 不影响净增
    ];
    const r = netIncreaseVsBase(cur, base);
    expect(r.netIncrease).toBe(2);
    expect(r.newSites.map((x) => x.line).sort()).toEqual([7, 9]);
  });

  test('★ 行号整体平移但指纹不变 ⇒ 净增 0 (run 5bcfa2b2 被误杀的那个形态)', () => {
    const base: CatchSite[] = [site(3, 'silent', 'catch{returnnull;}'), site(7, 'empty', 'catch{}')];
    // 同样两处 catch, 因为文件前部插了 40 行而各自后移 —— 一个字都没改。
    const cur: CatchSite[] = [site(43, 'silent', 'catch{returnnull;}'), site(47, 'empty', 'catch{}')];
    const r = netIncreaseVsBase(cur, base);
    expect(r.netIncrease).toBe(0);
    expect(r.newSites).toEqual([]);
  });

  test('★ 真多出一个与既有内容完全相同的 catch ⇒ 净增 1 (多重集, 不许被去重吃掉)', () => {
    const base: CatchSite[] = [site(3, 'silent', 'catch{returnnull;}')];
    const cur: CatchSite[] = [
      site(3, 'silent', 'catch{returnnull;}'),
      site(11, 'silent', 'catch{returnnull;}'), // 同款写法, 但是新多出来的一个
    ];
    const r = netIncreaseVsBase(cur, base);
    expect(r.netIncrease).toBe(1);
    expect(r.newSites.map((x) => x.line)).toEqual([11]);
  });

  test('反例: base 含 current 的全部指纹 ⇒ 净增 0, newSites 空', () => {
    const cur: CatchSite[] = [site(3, 'silent', 'catch{returnnull;}'), site(7, 'empty', 'catch{}')];
    const base: CatchSite[] = [site(3, 'silent', 'catch{returnnull;}'), site(7, 'empty', 'catch{}')];
    const r = netIncreaseVsBase(cur, base);
    expect(r.netIncrease).toBe(0);
    expect(r.newSites).toEqual([]);
  });

  test('反例: current 比 base 少 (还账) ⇒ 净增 0', () => {
    const cur: CatchSite[] = [site(3, 'silent', 'catch{returnnull;}')];
    const base: CatchSite[] = [site(3, 'silent', 'catch{returnnull;}'), site(7, 'empty', 'catch{}')];
    const r = netIncreaseVsBase(cur, base);
    expect(r.netIncrease).toBe(0);
    expect(r.newSites).toEqual([]);
  });
});

// ── ② CLI (真 git tree) ─────────────────────────────────────────────────────

describe('CLI --files --base', () => {
  beforeEach(() => {
    TMP = mkdtempSync(join(tmpdir(), 'catch-evidence-files-'));
    initGit(TMP);
  });

  // CLI 跑实命令(走 spawnSync),cwd 落到 TMP —— git show 才能在**临时那棵**里工作。
  // 喂给 CLI 的路径是 repo-相对(与生产 `writeSet` 同款),脚本内部 join cwd 解决 readFileSync。
  function runCli(args: string[]): { exitCode: number; stdout: string; stderr: string } {
    const script = join(process.cwd(), 'scripts/catch-evidence-scan.ts');
    const p = Bun.spawnSync(
      ['bun', 'run', script, ...args],
      { cwd: TMP, env: { ...process.env } },
    );
    return {
      exitCode: p.exitCode,
      stdout: new TextDecoder().decode(p.stdout),
      stderr: new TextDecoder().decode(p.stderr),
    };
  }

  test('正例: 引入新沉默 catch ⇒ exit 1, 输出含 file:line + kind', () => {
    // base: 一个空 catch (旧债, line 2) + 一个 logger 合规 catch (line 3)
    writeAndCommit(
      'src/a.ts',
      [
        'export function f(): number {',                                    // line 1
        '  try { return 1; } catch {}',                                     // line 2: 旧债
        '  try { return 2; } catch (e) { logger.warn({ e }, "x"); return 3; }', // line 3: 合规
        '}',                                                                // line 4
        '',                                                                  // line 5
      ].join('\n'),
      'baseline',
    );
    const base = commitAll('baseline-tip');
    // 现状: 在 line 4 加一个新的 silent catch
    writeFileSync(
      join(TMP, 'src/a.ts'),
      [
        'export function f(): number {',                                    // line 1
        '  try { return 1; } catch {}',                                     // line 2: 旧债
        '  try { return 2; } catch (e) { logger.warn({ e }, "x"); return 3; }', // line 3: 合规
        '  try { return 4; } catch (e) { return 5; }',                       // line 4: 新 silent
        '}',                                                                // line 5
        '',                                                                  // line 6
      ].join('\n'),
    );

    const r = runCli(['--files', 'src/a.ts', '--base', base]);
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain('src/a.ts:4');
    expect(r.stdout).toContain('无证据');
    expect(r.stdout).not.toContain('src/a.ts:2');
  });

  test('正例: 新建文件 (base 不存在) ⇒ 全算净增, exit 1', () => {
    writeAndCommit('src/keep.ts', 'export const x = 1;\n', 'baseline');
    const base = commitAll('baseline-tip');
    mkdirSync(join(TMP, 'src'), { recursive: true });
    writeFileSync(
      join(TMP, 'src/new.ts'),
      [
        'export function g(): void {',                            // line 1
        '  try { g(); } catch {}',                                // line 2: 空
        '  try { g(); } catch (e) { return; }',                   // line 3: silent
        '}',                                                       // line 4
        '',                                                         // line 5
      ].join('\n'),
    );

    const r = runCli(['--files', 'src/new.ts', '--base', base]);
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain('src/new.ts:2');
    expect(r.stdout).toContain('空');
    expect(r.stdout).toContain('src/new.ts:3');
    expect(r.stdout).toContain('无证据');
  });

  test('反例: 没引入新沉默 catch ⇒ exit 0', () => {
    writeAndCommit(
      'src/a.ts',
      [
        'export function f(): number {',  // line 1
        '  try { return 1; } catch {}',   // line 2: 旧债
        '}',                              // line 3
        '',                                // line 4
      ].join('\n'),
      'baseline',
    );
    const base = commitAll('baseline-tip');
    // 改一处与 catch 无关的代码, 行号没动 → 净增 0
    writeFileSync(
      join(TMP, 'src/a.ts'),
      [
        'export function f(): number {',  // line 1
        '  try { return 42; } catch {}',  // line 2: 旧债, 只是改了 return 值
        '}',                              // line 3
        '',                                // line 4
      ].join('\n'),
    );

    const r = runCli(['--files', 'src/a.ts', '--base', base]);
    expect(r.exitCode).toBe(0);
  });

  test('反例: --files 不配 --base ⇒ exit 2 (用法错误, 不该被静默放过)', () => {
    const r = runCli(['--files', 'src/a.ts']);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('--base');
  });
});

// ── 旁证: fetchBaseSource 在 base 缺席时返 null ────────────────────────────

describe('fetchBaseSource', () => {
  beforeEach(() => {
    TMP = mkdtempSync(join(tmpdir(), 'catch-evidence-files-'));
    initGit(TMP);
    writeAndCommit('keep.ts', 'export const x = 1;\n', 'baseline');
  });

  test('文件在 base 存在 ⇒ 返原文', () => {
    const base = commitAll('tip');
    expect(fetchBaseSource('keep.ts', base, TMP)).toBe('export const x = 1;\n');
  });

  test('文件在 base 不存在 ⇒ 返 null', () => {
    const base = commitAll('tip');
    expect(fetchBaseSource('nope.ts', base, TMP)).toBeNull();
  });
});

// ── 旁证: scanFilesVsBase 接 fetchBaseSource + cwd ─────────────────────────

describe('scanFilesVsBase (cwd)', () => {
  beforeEach(() => {
    TMP = mkdtempSync(join(tmpdir(), 'catch-evidence-files-'));
    initGit(TMP);
  });

  test('cwd 决定 git 上下文 —— 传 TMP ⇒ base 能查到 ⇒ 同位置不算净增', () => {
    writeAndCommit(
      'src/a.ts',
      ['export function f(): void {', '  try { f(); } catch (e) { return; }', '}', ''].join('\n'),
      'baseline',
    );
    const base = commitAll('tip');
    // cwd=TMP 那棵里有 src/a.ts ⇒ 同位置 (line 2) 已在 base ⇒ 净增 0
    const r2 = scanFilesVsBase(['src/a.ts'], base, TMP);
    expect(r2[0]?.netIncrease).toBe(0);
  });

  test('接受绝对路径 —— resolvePaths 切成 (abs, rel) 两套', () => {
    writeAndCommit(
      'src/a.ts',
      ['export function f(): void {', '  try { f(); } catch (e) { return; }', '}', ''].join('\n'),
      'baseline',
    );
    const base = commitAll('tip');
    const abs = join(TMP, 'src/a.ts');
    const r = scanFilesVsBase([abs], base, TMP);
    // 喂绝对路径也要能跑 (生产侧 writeSet 大多给的是相对, 但保险起见绝对也别挂)
    expect(r[0]?.netIncrease).toBe(0);
  });
});

// 钩子: scanCatchEvidence 仍可注入纯字符串, 不需要 git 上下文
test('scanCatchEvidence 注入净增源 (跨纯函数与 CLI 的判别力锚)', () => {
  const r = scanCatchEvidence(
    ['export function f(): void {', '  try { f(); } catch (e) { return; }', '}', ''].join('\n'),
    'src/x.ts',
  );
  expect(r.sites).toEqual([{ file: 'src/x.ts', line: 2, kind: 'silent', sig: 'catch(e){return;}' }]);
});

afterEach(() => rmSync(TMP, { recursive: true, force: true }));