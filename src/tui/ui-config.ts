/**
 * src/tui/ui-config —— **界面/审批设置的 config 读写面**(切片⑥,v5 第五节)。
 *
 * 写的是 `.omd/config.json`(逐仓)。面板只是它的编辑器,**不引入第二处真源**:
 * 读回来的值就是文件里的值,改完立刻写回同一个文件。
 *
 * 形状:
 * ```jsonc
 * { "tui": { "ui": { "sidebar": true, "painter": "gantt" }, "approvals": { "tokenTtlSec": 600 } } }
 * ```
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { omdConfigPath } from '../config/config-discovery';

export const PAINTER_NAMES = ['tree', 'gantt', 'layers'] as const;
export type PainterName = (typeof PAINTER_NAMES)[number];

export interface TuiUiConfig {
  /** 左栏默认开不开。默认 true。 */
  sidebar: boolean;
  /** 全屏默认画法(下标进 tui.ts 的 PAINTERS)。默认 0 = 树。 */
  painterIdx: number;
}

const configPathOf = (cwd: string, env: Record<string, string | undefined>): string => {
  const rel = omdConfigPath(env);
  return isAbsolute(rel) ? rel : join(cwd, rel);
};

const readRoot = (path: string): Record<string, unknown> => {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch {
    return {}; // 坏 JSON: 读侧 fail-open (写侧见 patchOmdConfig 的警告)
  }
};

export function loadTuiUiConfig(cwd: string, env: Record<string, string | undefined> = process.env): TuiUiConfig {
  const root = readRoot(configPathOf(cwd, env));
  const ui = (root.tui as Record<string, unknown> | undefined)?.ui as Record<string, unknown> | undefined;
  const painter = typeof ui?.painter === 'string' ? PAINTER_NAMES.indexOf(ui.painter as PainterName) : -1;
  return {
    sidebar: typeof ui?.sidebar === 'boolean' ? ui.sidebar : true,
    painterIdx: painter >= 0 ? painter : 0,
  };
}

/**
 * 读-改-写 `.omd/config.json`。
 *
 * ⚠ **坏 JSON 时拒绝写**(抛错)而不是拿 `{}` 覆盖 —— 覆盖会把座位配置等所有别人写的段
 * 静默抹掉,那比"改不了设置"严重得多。
 */
export function patchOmdConfig(
  cwd: string,
  mutate: (root: Record<string, unknown>) => void,
  env: Record<string, string | undefined> = process.env,
): string {
  const path = configPathOf(cwd, env);
  let root: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      root = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    } catch (err) {
      throw new Error(`${path} 不是合法 JSON, 拒绝覆盖写 (先手修): ${(err as Error).message}`);
    }
  }
  mutate(root);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(root, null, 2)}\n`);
  return path;
}

const tuiSection = (root: Record<string, unknown>): Record<string, unknown> => {
  const tui = (root.tui ??= {}) as Record<string, unknown>;
  return tui;
};

export function setTuiUi(cwd: string, patch: { sidebar?: boolean; painterIdx?: number }, env?: Record<string, string | undefined>): string {
  return patchOmdConfig(
    cwd,
    (root) => {
      const tui = tuiSection(root);
      const ui = (tui.ui ??= {}) as Record<string, unknown>;
      if (patch.sidebar !== undefined) ui.sidebar = patch.sidebar;
      if (patch.painterIdx !== undefined) ui.painter = PAINTER_NAMES[patch.painterIdx] ?? 'tree';
    },
    env,
  );
}

export function setApprovalTokenTtl(cwd: string, ttlSec: number, env?: Record<string, string | undefined>): string {
  if (!Number.isFinite(ttlSec) || ttlSec <= 0) throw new Error(`token TTL 必须是正数秒, 收到 ${ttlSec}`);
  return patchOmdConfig(
    cwd,
    (root) => {
      const tui = tuiSection(root);
      const approvals = (tui.approvals ??= {}) as Record<string, unknown>;
      approvals.tokenTtlSec = ttlSec;
    },
    env,
  );
}
