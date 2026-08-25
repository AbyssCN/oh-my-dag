/**
 * src/harness/notify —— owner 推式桥的纯接缝 (SDD F1 片 1, C-1 五条 INV)。
 *
 * ## 它治的是什么
 *
 * owner 端「我不在 TUI 面前时也要知道发生了啥」的告知需求 —— 终态 / escalation /
 * 预算过半这三件事发生时, 把一条 owner 配的命令 spawn 起来, payload 以单个 argv
 * 元素传入。属告知层: **fail-open, 不挡主流程**, 失败留一行证据 (仓规 §静默坑 2)。
 *
 * ## 设计要点
 *
 * - **零 daemon、零 await**: 入口同步返回, 不等待子进程退出 (INV-5)。生产 spawn 用
 *   `child_process.spawn(..., { detached: true, stdio: 'ignore' })` 解绑父进程。
 * - **零 fs 默认**: 读配置走 `readConfigText` 注入 (D-1), 生产端在 wiring 处经
 *   `omdConfigPath` + 现有 `readJsonSafe` (config-discovery.ts) 接入。本片只定**接缝**。
 * - **payload 单 argv 元素**: 杜绝 shell 引号注入与截断 (D-3)。owner 命令以
 *   `sh -c '<cmd> "$@"' omd-notify <payloadJson>` 形态被调用 —— owner 命令内
 *   用 `$1` 取整段 JSON。payload **不**拼进 command 串。
 * - **非法 events 项 → warn 后忽略, 合法项照用** (D-8 / D-4 ②)。白名单缺省 =
 *   三类全发; 只配非法项 = 视同未配白名单。
 *
 * ## 不在本片范围 (片 2 才接)
 *
 * - `appendBoard` 两处 terminal 写者侧的调用 (D-5);
 * - 引擎事件桥 (`replan` → escalation; 新增 `budget` 事件 → budget-half) 的组合 sink;
 * - 预算过半阈值的轮边界读数 + 内环幂等 (D-6);
 * - 生产端 `readConfigText` 默认实现。
 *
 * @module
 */
import { spawn as cpSpawn } from 'node:child_process';
import { logger } from './logger';

// ── 词表 ─────────────────────────────────────────────────────────────────────

/** F1 三类事件词表 (D-2)。片 1 冻结, 后片只消费; 拼写错 = 静默不发。 */
export const NOTIFY_EVENTS = ['terminal', 'escalation', 'budget-half'] as const;
export type OwnerNotifyEvent = typeof NOTIFY_EVENTS[number];

/** payload 必含 `event` + `runId` + `at` (ISO) (D-2); 类专属字段各自加。 */
export interface TerminalPayload {
  event: 'terminal';
  runId: string;
  at: string;
  outcome: string;
  headline: string;
}
export interface EscalationPayload {
  event: 'escalation';
  runId: string;
  at: string;
  round: number;
  /** 毒集计数 (entries.length, 不是 entries 本身 —— payload 是单 argv 元素, 不宜塞大对象)。 */
  poisoned: number;
}
export interface BudgetHalfPayload {
  event: 'budget-half';
  runId: string;
  at: string;
  axis: 'tokens' | 'ms';
  spent: number;
  cap: number;
}
export type OwnerNotifyPayload = TerminalPayload | EscalationPayload | BudgetHalfPayload;

// ── 配置 ─────────────────────────────────────────────────────────────────────

/** notify 段形状 (D-8 / INV-3); 多余键照旧忽略 (looseObject)。 */
export interface NotifyConfig {
  /** 必填, 字符串。owner 命令字符串, 经 sh -c 包裹调用。 */
  command: string;
  /** 可选白名单; 缺省 = 三类全发。非法项在 readNotifyConfig 阶段 warn 后忽略。 */
  events?: OwnerNotifyEvent[];
}

// ── 注入接缝 ─────────────────────────────────────────────────────────────────

/** 记一次 spawn 调用 —— argv 已含 sh + -c + command + omd-notify + payload。 */
export interface SpawnCall { argv: string[] }

/**
 * spawn 接缝 —— 测试注入 fake; 生产默认 `child_process.spawn({detached,stdio:'ignore'})`
 * 不等待退出 (INV-5)。返值是只取 `pid` 的最小面 (调用方不读 stdout/stderr/exit)。
 */
export type SpawnFn = (argv: string[]) => { pid?: number } | undefined;

/**
 * 配置读接缝 —— 返 raw JSON 文本, 不存在 / 解析失败 / 非对象 = null (fail-open)。
 * 生产端在 wiring 处经 `omdConfigPath` (config-discovery.ts) + 现有 `readJsonSafe` 接入。
 * **本片不嵌读盘默认** —— 接线位空 = 调用方必须显式递, 否则 `readConfigText` 缺席
 * 视同"未配", 全程 no-op (INV-1 零涟漪)。
 */
export type ReadConfigText = () => string | null;

export interface NotifyDeps {
  readConfigText?: ReadConfigText;
  spawn?: SpawnFn;
  /** 注入式时刻源 —— 默认 `new Date().toISOString()` (本片默认不动, 测试不覆)。 */
  now?: () => string;
}

// ── 内部 ─────────────────────────────────────────────────────────────────────

/** `sh -c '<cmd> "$@"' omd-notify <payloadJson>` 的 argv 形态 (D-3)。 */
function buildArgv(command: string, payloadJson: string): string[] {
  return ['sh', '-c', `${command} "$@"`, 'omd-notify', payloadJson];
}

/**
  生产 spawn: detached + stdio ignore, 不 await 退出 (INV-5)。uncaughtError 由
  调用方 (notifyOwner) 包 try/catch (INV-4); 此处只在 spawn 同步抛错时透给上。
  */
const defaultSpawn: SpawnFn = (argv) => {
  const child = cpSpawn(argv[0]!, argv.slice(1), {
    detached: true,
    stdio: 'ignore',
  });
  return { pid: child.pid };
};

/**
  把 raw JSON 文本翻成 NotifyConfig。**容错**(D-4 / D-8 / INV-3):
  - 文本 null (读不到) / 解析失败 / 非对象 = null, **无 warn** (缺配置 = 常态)
  - `notify` 段不在 = null
  - `command` 缺 / 非字符串 = warn 一次, 返 null (spawn 不会发生, INV-1 零涟漪)
  - `events` 含非法名 = warn 一次 / 项, 过滤后保留合法项; 全非法 = 视同未配白名单

  ⚠ **不在这里 spawn**: readNotifyConfig 是纯逻辑, spawn 由 notifyOwner 决定。
  这条边界让测试能独立验配置解析, 也能让片 2 的接线决定何时调。
 */
export function readNotifyConfig(raw: string | null): { config: NotifyConfig | null; warnings: string[] } {
  if (raw === null) return { config: null, warnings: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    // JSON 解析失败 = 配置整体坏; 证据即留此处 (仓规 §静默坑 2), caller 不再叠加 warn。
    logger.warn({ source: 'notify.readConfig', err: String(err) }, '[notify] 配置 JSON 解析失败');
    return { config: null, warnings: [] };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { config: null, warnings: ['配置根不是对象'] };
  }
  const root = parsed as Record<string, unknown>;
  const rawSection = root.notify;
  if (rawSection === undefined) return { config: null, warnings: [] };
  if (!rawSection || typeof rawSection !== 'object' || Array.isArray(rawSection)) {
    return { config: null, warnings: ['notify 段不是对象'] };
  }
  const sec = rawSection as Record<string, unknown>;

  // command —— 缺 / 非字符串 = 致命, 返 null
  if (typeof sec.command !== 'string' || sec.command.length === 0) {
    return { config: null, warnings: ['notify.command 缺 / 非字符串 / 空串'] };
  }

  // events —— 非法项 warn 后忽略, 合法项保留; 全非法 = events 字段省略 (视为未配白名单)
  const warnings: string[] = [];
  let events: OwnerNotifyEvent[] | undefined;
  if (sec.events !== undefined) {
    if (!Array.isArray(sec.events)) {
      warnings.push('notify.events 非数组 → 忽略, 视为未配白名单');
    } else {
      const legal: OwnerNotifyEvent[] = [];
      for (const e of sec.events) {
        if (typeof e !== 'string') {
          warnings.push(`notify.events 项非字符串: ${String(e)} → 忽略`);
          continue;
        }
        if ((NOTIFY_EVENTS as ReadonlyArray<string>).includes(e)) {
          legal.push(e as OwnerNotifyEvent);
        } else {
          warnings.push(`notify.events 非法项: ${e} → 忽略`);
        }
      }
      if (legal.length > 0) events = legal;
    }
  }

  return { config: { command: sec.command, events }, warnings };
}

/**
  F1 入口: 拼 argv → spawn (不 await) → 失败 warn 一次 (D-4 ④ / INV-4)。
  - 配置缺 = no-op (INV-1)
  - payload.event ∉ 白名单 = no-op, 0 warn (D-8 静默过滤)
  - 拼出来的 argv 末元素 = `JSON.stringify(payload)` (D-3 / INV-2)
  - spawn 抛错 / 命令非零退出 = warn 一行含 runId + event (INV-4), 入口正常返回

  ⚠ **不 await**: spawn 是 fire-and-forget, 父进程不等子进程 (INV-5)。
  默认 spawn 是 detached + stdio ignore; owner 命令自身语法错误属 owner 侧, 按
  D-4 ③ 留证据即可 —— 引擎不替 owner 校验 command 串。
 */
export function notifyOwner(payload: OwnerNotifyPayload, deps?: NotifyDeps): void {
  const readConfigText = deps?.readConfigText;
  const spawnFn = deps?.spawn ?? defaultSpawn;

  // 配置缺 = 静默 no-op, 无 warn (D-4 ① / INV-1)
  if (!readConfigText) return;
  const raw = readConfigText();

  const { config, warnings } = readNotifyConfig(raw);
  // 配置解析阶段的坏形状 warn (D-4 ② / INV-3) —— 在决定 spawn 之前
  for (const w of warnings) {
    logger.warn({ source: 'notify.readConfig' }, `[notify] 配置形状坏: ${w}`);
  }
  if (!config) return;

  // 白名单过滤 —— 不在白名单 (且白名单已配) = 静默 no-op, 0 warn
  if (config.events && !config.events.includes(payload.event)) return;

  // spawn — 抛错 → warn 一行含 runId + event, 入口不抛 (INV-4); 不 await (INV-5)
  const argv = buildArgv(config.command, JSON.stringify(payload));
  try {
    spawnFn(argv);
  } catch (err) {
    logger.warn(
      { runId: payload.runId, event: payload.event, err: String(err) },
      '[notify] spawn 抛错',
    );
  }
}