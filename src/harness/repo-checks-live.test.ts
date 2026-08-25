/**
 * src/harness/repo-checks-live —— 仓规清单「活体自证」(D4 切片 3, #271)。
 *
 * 读**真实**的 `./.omd-repo-checks.json`, 对 mkdtemp 里含禁词样例的文件真 spawn
 * 跑清单第 1 条 → exit 1 且 evidence 含 file:line; 干净文件 → exit 0。这条测试同时
 * 钉住「清单文件在 / 格式对 / 命令真能跑」三件事 —— 清单被误删或改坏时它当场红。
 *
 * 反向自检 (与 repo-checks.test.ts 同款):
 *   - 禁词样例**不出现**在测试字面量里 —— 需要样词时运行期拼接 (JARGON_SAMPLE)。
 *   - mkdtemp 隔振, 不污染仓根。
 *   - 真 spawn (node:child_process + sh -c), 不替身 —— 这条测试的唯一价值就是
 *     「清单里的命令在真实 shell 里能跑」。
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runRepoChecks } from './repo-checks';
import {
  loadRepoChecksManifest,
  REPO_CHECKS_MANIFEST_FILENAME,
} from './repo-checks-manifest';
import type { GateSpawn } from './post-leaf-gate';

// ── 仓根 = 当前进程 cwd ──────────────────────────────────────────────────────
// accept 闸硬约束: 测试在仓根跑。写死绝对路径会随主机变, 用 cwd 更稳。
const REPO_ROOT = process.cwd();
const MANIFEST_PATH = join(REPO_ROOT, REPO_CHECKS_MANIFEST_FILENAME);

// 拼接构造禁词样例 —— 静态扫不到, 运行期拼出 (与 repo-checks.test.ts 同款)。
const JARGON_SAMPLE = ['落', '盘'].join('');

// ── 真 spawn (node:child_process + sh -c) ────────────────────────────────────
// runRepoChecks 要的 GateSpawn = (cmd, cwd, timeoutMs?) => Promise<{stdout, stderr, exitCode, timedOut?, signal?}>。
// 我们**故意**不替身 —— 这条测试的价值就是「清单里的命令在真实 shell 里能跑」。
const realSpawn: GateSpawn = (command, cwd, timeoutMs) =>
  new Promise((resolve, reject) => {
    const child = spawn('sh', ['-c', command], { cwd, timeout: timeoutMs });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.on('timeout', () => {
      timedOut = true;
      child.kill();
    });
    child.stdout?.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr?.on('data', (d) => {
      stderr += d.toString();
    });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      resolve({ stdout, stderr, exitCode: code, timedOut, signal });
    });
  });

// ── 临时目录(测试套件一次性, afterAll 一次清理) ──────────────────────────────

let tmpRoot: string | null = null;

function getTmp(): string {
  if (!tmpRoot) tmpRoot = mkdtempSync(join(tmpdir(), 'omd-repo-checks-live-'));
  return tmpRoot;
}

// ── 测试 ─────────────────────────────────────────────────────────────────────

describe('仓规清单活体自证 (./.omd-repo-checks.json 真 spawn)', () => {
  test('清单文件存在于仓根, loadRepoChecksManifest 解析成功 + 至少一条 + 全含 {files}', () => {
    // 同时钉住「文件在」「格式对」「至少一条命令」「每条命令含 {files} 占位符」。
    // 清单被误删 → 第 1 个 expect 红; 格式坏 → 第 2 个 expect 红; 命令缺占位符 → 第 4 个红。
    expect(existsSync(MANIFEST_PATH)).toBe(true);
    const checks = loadRepoChecksManifest(REPO_ROOT);
    expect(checks.length).toBeGreaterThanOrEqual(1);
    for (const c of checks) {
      expect(typeof c.id).toBe('string');
      expect(c.id.length).toBeGreaterThan(0);
      expect(c.command).toContain('{files}');
    }
  });

  test('jargon-scan (清单第 1 条) 对含禁词的 .ts → exit 1 且 evidence 含 file:line', async () => {
    const checks = loadRepoChecksManifest(REPO_ROOT);
    expect(checks[0]).toBeDefined();
    const firstCheck = checks[0]!;
    // sanity: 第 1 条应是 jargon-scan(由 INV-D4-5 钉)
    expect(firstCheck.command).toContain('jargon-scan');

    const dirtyFile = join(getTmp(), 'dirty-sample.ts');
    // 运行期拼出禁词, 静态扫不到这一行; 实际写到盘上的是含 JARGON_SAMPLE 字面串。
    writeFileSync(dirtyFile, `// 这行含禁词: ${JARGON_SAMPLE}\nexport const x = 1;\n`);

    const result = await runRepoChecks({
      checks: [firstCheck],
      files: [dirtyFile],
      cwd: REPO_ROOT,
      spawn: realSpawn,
      timeoutMs: 60_000,
    });
    expect(result.verdict).toBe('FAIL');
    const outcome = result.perCheck[0];
    expect(outcome).toBeDefined();
    expect(outcome!.verdict).toBe('FAIL');
    expect(outcome!.reason).toBe('exit_1');
    // jargon-scan 输出形如 `<abs-path>:<line> [<kind>] <word> → ...`, evidence 取 stdout
    expect(outcome!.evidence ?? '').toMatch(/dirty-sample\.ts:\d+/);
  });

  test('jargon-scan (清单第 1 条) 对干净 .ts → exit 0 (verdict OK)', async () => {
    const checks = loadRepoChecksManifest(REPO_ROOT);
    expect(checks[0]).toBeDefined();
    const firstCheck = checks[0]!;

    const cleanFile = join(getTmp(), 'clean-sample.ts');
    writeFileSync(cleanFile, '// 干净的注释, 没有禁词\nexport const x = 1;\n');

    const result = await runRepoChecks({
      checks: [firstCheck],
      files: [cleanFile],
      cwd: REPO_ROOT,
      spawn: realSpawn,
      timeoutMs: 60_000,
    });
    expect(result.verdict).toBe('OK');
    const outcome = result.perCheck[0];
    expect(outcome).toBeDefined();
    expect(outcome!.verdict).toBe('OK');
    expect(outcome!.reason).toBe('ok');
  });
});

// ── cleanup ──────────────────────────────────────────────────────────────────

afterAll(() => {
  if (tmpRoot) {
    try {
      rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
    tmpRoot = null;
  }
});
