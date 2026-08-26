/**
 * src/harness/repo-checks-live —— 仓规清单「活体自证」(D4 切片 3, #271)。
 *
 * 读**真实**的 `./.omd-repo-checks.json`, 钉住「清单文件在 / 格式对 / 每条命令含
 * `{files}` 占位符」—— 清单被误删或改坏时它当场红。
 *
 * ⚠ 2026-08-26 缩到只剩这一条: 原先还有两条按**清单第 1 条**(当时是 jargon-scan)真 spawn
 * 的用例, 禁用词不再是闸之后随之移除。教训是那两条**绑了具体检查项的序号** ——
 * 清单一改就得跟着改。现在这条只验清单的形状, 加减检查项都不用动它。
 *
 * 真 spawn 的基础设施 (realSpawn) 保留: 下一条需要活体自证的检查项接上就能用。
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

  // ⚠ 2026-08-26: 原来这里有两条「jargon-scan (清单第 1 条)」的活体自证。
  // 禁用词已由 owner 裁定**不再是闸**(维护成本压过收益, 见 scripts/jargon-scan.test.ts 顶部),
  // 清单里也不再有它, 所以这两条随之移除 —— 留着会验一条不存在的清单项, 那是假绿的温床。
  //
  // 上面第一条 (清单解析 + 全含 {files}) 仍是活体自证的核心: 它验的是「清单本身能被引擎吃下」,
  // 与具体有哪几条无关, 加减检查项都不用改它。
});
