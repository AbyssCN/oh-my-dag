/**
 * src/harness/repo-checks-manifest —— **仓规检查清单 loader** (D4 切片 1, #271)。
 *
 * ## 为什么是独立件
 *
 * D2 (#266) 出厂了 `runRepoChecks` 三态闸 (OK / FAIL / UNVERIFIED), 但装配层
 * `assemble.ts:395/488/669` 三处 `repoChecks: []` 把闸的输入恒空 —— 「引擎有闸没清单」。
 * 清单内容是仓库资产 (INV-D2-1 禁词表 / catch 证据纪律不进引擎), 但引擎此前没有通用的
 * 「从仓库读清单」的口, 装配层三处又必须共用同一份 (三份必漂)。
 *
 * 本件 = 该口。引擎从此只认**文件名 + schema** (INV-D4-1), 文件内容一个字不进引擎源码。
 *
 * ## 设计不变量 (SDD #271 · D4)
 *
 * - **INV-D4-1 (引擎面通用)**: 只认 `<repoRoot>/.omd-repo-checks.json`, schema =
 *   `RepoCheck[]` (复用 D2 `repo-checks.ts` 的 `RepoCheck`, 不另起新类型)。
 *   `command` 必含 `{files}` 占位符 (协议沿 D2 `runRepoChecks` 的 `{files}` 替换)。
 * - **INV-D4-2 (缺席 = 今天)**: 文件不存在 → 返回 `[]`, 行为与今天逐字节相同。
 *   格式坏 (JSON 解析失败 / schema 不符) → **throw**, 错误原文含路径 —— 闸清单静默
 *   掉线 = 静默失效, 宁可 server 起不来。
 * - **INV-D4-3 (加载一次)**: `assembleOmdMcpTools` 每次调一次, 三处装配点用同一份结果
 *   (调用方职责, 本件只保证「同 root 同结果」纯函数语义)。
 *
 * ## 非目标 (Non-Goals)
 *
 * - 不动 `runRepoChecks` / agent-leaf 接线 (D2 已交付)。
 * - 不做清单热加载 —— server 重启生效即可。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RepoCheck } from './repo-checks';

/**
 * 清单文件名 (INV-D4-1)。导出给 S2 装配点 / S3 仓根落位复用, 避免字面量散落。
 */
export const REPO_CHECKS_MANIFEST_FILENAME = '.omd-repo-checks.json';

/**
 * 从 `<repoRoot>/.omd-repo-checks.json` 读清单。
 *
 * 终局:
 *   - 文件不存在 → `[]` (INV-D4-2 「缺席 = 今天」)
 *   - JSON 解析失败 → throw (错误原文含文件路径, 排账可见)
 *   - schema 不符 (顶层非数组 / 条目非对象 / 缺 id / 缺 command / command 无 `{files}`)
 *     → throw (同上)
 *
 * @param repoRoot 仓根绝对路径。装配点 = `cwd` (主树) 或 `cwd` 的 worktree (隔离档)。
 *               本件不校验路径形态, 由调用方保证。
 */
export function loadRepoChecksManifest(repoRoot: string): RepoCheck[] {
  const manifestPath = join(repoRoot, REPO_CHECKS_MANIFEST_FILENAME);

  // INV-D4-2: 缺席 → [] (零回归锚点)
  if (!existsSync(manifestPath)) return [];

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(manifestPath, 'utf-8'));
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    throw new Error(`[repo-checks-manifest] ${manifestPath} 不是合法 JSON: ${reason}`);
  }

  if (!Array.isArray(raw)) {
    const actualType = raw === null ? 'null' : Array.isArray(raw) ? 'array' : typeof raw;
    throw new Error(
      `[repo-checks-manifest] ${manifestPath} 顶层必须是数组 (当前: ${actualType})`,
    );
  }

  const checks: RepoCheck[] = [];
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      const actualType = item === null ? 'null' : Array.isArray(item) ? 'array' : typeof item;
      throw new Error(
        `[repo-checks-manifest] ${manifestPath}[${i}] 必须是对象 (当前: ${actualType})`,
      );
    }
    const obj = item as Record<string, unknown>;

    if (typeof obj.id !== 'string' || obj.id.length === 0) {
      throw new Error(
        `[repo-checks-manifest] ${manifestPath}[${i}] 缺 id 或 id 非字符串/空串`,
      );
    }
    if (typeof obj.command !== 'string') {
      throw new Error(
        `[repo-checks-manifest] ${manifestPath}[${i}] (id=${obj.id}) 缺 command 或 command 非字符串`,
      );
    }
    if (!obj.command.includes('{files}')) {
      throw new Error(
        `[repo-checks-manifest] ${manifestPath}[${i}] (id=${obj.id}) command 必须含 {files} 占位符`,
      );
    }
    // severity 缺席 → 'blocking'(零回归: 既有 manifest 没有这个键, 行为逐字节不变)。
    // 值非法 → 响亮拒, 不静默当 blocking: 把 'advisroy' 这种拼写错当成 blocking, 会让人
    // 以为已经降级了、实际仍在杀节点 —— 那正是本仓要杀的静默形态。
    if (obj.severity !== undefined && obj.severity !== 'blocking' && obj.severity !== 'advisory') {
      throw new Error(
        `[repo-checks-manifest] ${manifestPath}[${i}] (id=${obj.id}) severity 只能是 'blocking' | 'advisory' (当前: ${JSON.stringify(obj.severity)})`,
      );
    }
    checks.push({
      id: obj.id,
      command: obj.command,
      ...(obj.severity !== undefined ? { severity: obj.severity as 'blocking' | 'advisory' } : {}),
    });
  }
  return checks;
}