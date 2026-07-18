/**
 * plan/keybindings-setup —— 确保 shift+tab 可被 plan mode 扩展抢占。
 *
 * 根因 (pi 0.77.0): `app.thinking.cycle` 默认绑 shift+tab, 且进了 pi 的
 * RESERVED_KEYBINDINGS_FOR_EXTENSION_CONFLICTS (extensions/runner.js:7) → 扩展注册
 * shift+tab 在 getShortcuts (runner.js:270) 被 `restrictOverride === true` 静默 skip →
 * plan mode 的 shift+tab 入口失效 (用户报: "不能进入 plan mode")。/plan 命令不受影响。
 *
 * 修复: pi 的保留判定按 **action 名**算, 不是按键算 — 把 app.thinking.cycle 从 shift+tab
 * 挪到一个空键 (默认 ctrl+y), shift+tab 即不再属于任何内置 action →
 * buildBuiltinKeybindings 不收录该键 → getShortcuts 恢复注册我们的扩展 shortcut。
 *
 * tui boot 时 (main() 之前) 调用: 非破坏性 merge pi 的 keybindings.json
 * (路径用 pi 自己的 getAgentDir(), 尊重 PI_AGENT_DIR 覆盖)。只在 thinking.cycle 当前仍占
 * shift+tab (含未配置=落 pi 默认 shift+tab) 时改动, 其余键原样保留; 已让路则 no-op (幂等)。
 * 写在 main() 前 → 本次 boot 的 KeybindingsManager.create() 即读到新值, 无需 /reload。
 */
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** pi 内置 action: 循环 thinking 等级。默认绑 shift+tab, 是冲突源。 */
const THINKING_ACTION = 'app.thinking.cycle';
/** plan mode 想要独占的键 (Claude-Code 式 mode 切换约定)。 */
const PLAN_TOGGLE_KEY = 'shift+tab';
/** thinking-cycle 让路到的目标键 (pi 默认未占用)。 */
const DEFAULT_FALLBACK_KEY = 'ctrl+y';

export interface EnsurePlanKeyOpts {
  /** keybindings.json 路径。省略 = pi getAgentDir()/keybindings.json (测试注入临时路径)。 */
  configPath?: string;
  /** thinking-cycle 让路到的目标键。默认 ctrl+y。 */
  fallbackKey?: string;
}

export type EnsurePlanKeyReason =
  /** thinking.cycle 已不在 shift+tab → 该键自由, 扩展可抢占, 无需改。 */
  | 'already-free'
  /** 改了既有 binding (thinking.cycle 之前占 shift+tab)。 */
  | 'remapped'
  /** 文件无该键 (含文件不存在) → 新建让路 binding。 */
  | 'created'
  /** 现有 JSON 损坏 → 跳过 (不覆盖用户文件, 可能手改一半); plan mode 经 /plan 兜底。 */
  | 'parse-error'
  /** 写盘失败 → 跳过; plan mode 经 /plan 兜底。 */
  | 'write-error';

export interface EnsurePlanKeyResult {
  /** 是否实际改写了文件。 */
  changed: boolean;
  /** 解析到的 keybindings.json 绝对路径。 */
  path: string;
  reason: EnsurePlanKeyReason;
  /** thinking-cycle 让路到的键。 */
  fallbackKey: string;
}

/** binding 值规范化为字符串数组 (pi 支持单键字符串或多键数组)。非法值 → undefined。 */
function normalizeKeys(v: unknown): string[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'string') return [v];
  if (Array.isArray(v)) return v.filter((k): k is string => typeof k === 'string');
  return undefined;
}

/**
 * 确保 shift+tab 不被内置 thinking-cycle 占用, 使 plan mode 扩展能抢占该键。
 * 幂等 + 非破坏性: 只动 app.thinking.cycle, 其余 keybinding 原样保留。
 */
export function ensurePlanToggleKeyFree(opts: EnsurePlanKeyOpts = {}): EnsurePlanKeyResult {
  const path = opts.configPath ?? join(getAgentDir(), 'keybindings.json');
  const fallbackKey = (opts.fallbackKey ?? DEFAULT_FALLBACK_KEY).toLowerCase();

  // 读现有配置 (容缺 + 容坏): 坏 JSON 不覆盖, 缺文件按空配置 (= pi 全默认) 处理。
  let config: Record<string, unknown> = {};
  if (existsSync(path)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      return { changed: false, path, reason: 'parse-error', fallbackKey };
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { changed: false, path, reason: 'parse-error', fallbackKey };
    }
    config = parsed as Record<string, unknown>;
  }

  // 当前 thinking.cycle 绑定: 未配置 = pi 默认 shift+tab。
  const current = normalizeKeys(config[THINKING_ACTION]);
  const effective = current ?? [PLAN_TOGGLE_KEY];
  const hasShiftTab = effective.some((k) => k.toLowerCase() === PLAN_TOGGLE_KEY);

  if (!hasShiftTab) {
    return { changed: false, path, reason: 'already-free', fallbackKey };
  }

  // 让路: 去掉 shift+tab, 补 fallback (去重, 保留其余键 — 用户可能多键绑 thinking.cycle)。
  const remaining = effective.filter((k) => k.toLowerCase() !== PLAN_TOGGLE_KEY);
  if (!remaining.some((k) => k.toLowerCase() === fallbackKey)) remaining.push(fallbackKey);
  config[THINKING_ACTION] = remaining.length === 1 ? remaining[0] : remaining;

  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  } catch {
    return { changed: false, path, reason: 'write-error', fallbackKey };
  }
  return { changed: true, path, reason: current === undefined ? 'created' : 'remapped', fallbackKey };
}
