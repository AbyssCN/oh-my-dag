/**
 * src/tui/ui-config —— **界面设置的 config 读写面**(切片⑥,v5 第五节)。
 *
 * 写的是 `.omd/config.json`(逐仓)。面板只是它的编辑器,**不引入第二处真源**:
 * 读回来的值就是文件里的值,改完立刻写回同一个文件。
 *
 * 形状:
 * ```jsonc
 * { "tui": { "ui": { "sidebar": true, "painter": "gantt" } } }
 * ```
 *
 * ⚠ `tui.sandbox` 段**不在这里读** —— 它的消费者是 harness 侧的工具装配
 * (`harness/hooks/command-policy.ts`),而这个文件是 TUI 的界面偏好面。
 * 两处各读一份同一个段必漂,所以是**分段而治**:界面段在这、围栏段在那。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { omdConfigPath } from '../config/config-discovery';
import { withConfigLock } from '../harness/config-lock';

export const PAINTER_NAMES = ['tree', 'gantt', 'layers'] as const;
export type PainterName = (typeof PAINTER_NAMES)[number];

/**
 * `/think` 的合法档 —— **本仓词表**(`role-models.ts` 的 ThinkingLevel,单一词汇),
 * 不是 pi 的(pi 另有 minimal/max;两表混用会让座位配置读不懂)。'off' 也是一档。
 * `satisfies` 钉住:词表漂移时 tsc 当场红。
 */
export const THINKING_LEVELS = ['off', 'low', 'medium', 'high', 'xhigh'] as const satisfies readonly ThinkingLevelName[];
export type ThinkingLevelName = import('../model/role-models').ThinkingLevel;

export interface TuiUiConfig {
  /** 左栏默认开不开。默认 true。 */
  sidebar: boolean;
  /** 全屏默认画法(下标进 tui.ts 的 PAINTERS)。默认 0 = 树。 */
  painterIdx: number;
  /** chat 轮的思考档。默认 'high'(`agent.ts` 的既有默认,这里只是把旋钮露出来)。 */
  thinking: ThinkingLevelName;
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
    thinking: THINKING_LEVELS.includes(ui?.thinking as ThinkingLevelName) ? (ui?.thinking as ThinkingLevelName) : 'high',
  };
}

/**
 * 读-改-写 `.omd/config.json`(INV-10/C-4 锁内, 锁内重读以反映并发写者最新落盘)。
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
  return withConfigLock(path, () => {
    let root: Record<string, unknown> = {};
    if (existsSync(path)) {
      try {
        // 锁内重读: 别人刚写的段 (座位/池/多模态/autoAssigned 等) 不被回退。
        root = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
      } catch (err) {
        throw new Error(`${path} is not valid JSON, refusing to overwrite it (fix it by hand first): ${(err as Error).message}`);
      }
    }
    mutate(root);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(root, null, 2)}\n`);
    return path;
  });
}

const tuiSection = (root: Record<string, unknown>): Record<string, unknown> => {
  const tui = (root.tui ??= {}) as Record<string, unknown>;
  return tui;
};

export function setTuiUi(
  cwd: string,
  patch: { sidebar?: boolean; painterIdx?: number; thinking?: ThinkingLevelName },
  env?: Record<string, string | undefined>,
): string {
  return patchOmdConfig(
    cwd,
    (root) => {
      const tui = tuiSection(root);
      const ui = (tui.ui ??= {}) as Record<string, unknown>;
      if (patch.sidebar !== undefined) ui.sidebar = patch.sidebar;
      if (patch.painterIdx !== undefined) ui.painter = PAINTER_NAMES[patch.painterIdx] ?? 'tree';
      if (patch.thinking !== undefined) ui.thinking = patch.thinking;
    },
    env,
  );
}

