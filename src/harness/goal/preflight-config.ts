/**
 * src/harness/goal/preflight-config —— 默认闸段配置加载 (t-gate-inmigrate 票 SDD D-5)。
 *
 * 闸段默认配置真源 = `<root>/.omd/preflight.json`,承载闸 A / B / C 默认值。
 * 加载优先级:调用方 `RunGoalConfig` 三字段显式注入 > `.omd/preflight.json` > 缺席(闸段缺席)。
 *
 * ## 为什么单独成一个模块(不内联 run-goal.ts)
 *
 * `run-goal.ts` 已经 162KB / 1148 行 —— 再塞「读盘 + 类型守卫 + 容错」就过 2000 行红线了
 * (本仓 §Scalpel 那条)。且加载逻辑**只有** runGoalInner 入口直调用,无第二消费者,
 * 但仍独立成模块:它有自己的「fail-open 范式」(缺席 → 闸段缺席 ≠ 拒),这个范式独立可测,
 * 不该藏在 run-goal 的 try/catch 里被外层 finally 吞掉。
 *
 * ## 为什么不做 zod 校验
 *
 * SDD 未决段 [待 owner] 明确: 默认**不**校验,与 `.omd/config.json` 现有加载范式一致
 * (notify.ts / goal.ts 都是 JSON.parse + 形状守卫,不走 zod)。owner 翻案 → 改本文件即可,
 * run-goal 不动。
 *
 * ## 形状契约(冻结,owner 翻案才扩)
 *
 *   {
 *     "freezeCheck":      { "files": [{ "path": "...", "draftMarker": "..." }] },
 *     "seatExpectations": { "<seatId>": "<coord>" },
 *     "exclusiveLocks":   { "resultOut": "<path>", "sddPath": "<path>" }
 *   }
 *
 * 字段缺失 / 类型坏 → fail-open(闸段缺席,不阻) + warn 一行留证据(§静默坑 2)。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '../logger';
import type { FreezeCheckOpts, ExclusiveLocksOpts } from './ignition-preflight';

/** 加载出的默认配置面:三字段全可选。 */
export interface PreFlightConfig {
  freezeCheck?: FreezeCheckOpts;
  seatExpectations?: Record<string, string>;
  exclusiveLocks?: ExclusiveLocksOpts;
}

/** 加载默认配置。读不到 / 坏 JSON / 坏形状 → null(fail-open,闸段缺席)。 */
export function loadPreFlightConfig(root: string): PreFlightConfig | null {
  const path = join(root, '.omd', 'preflight.json');
  if (!existsSync(path)) return null;
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    // 读失败 ≠ 缺席,但 fail-open 也算合理(闸段缺席 = 不阻);但**必须留证据**(§静默坑 2)。
    logger.warn({ err: String(err) }, '[preflight-config] 读 .omd/preflight.json 失败 → 闸段缺席');
    return null;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    logger.warn({ err: String(err) }, '[preflight-config] .omd/preflight.json 不是合法 JSON → 闸段缺席');
    return null;
  }
  if (!isObject(raw)) {
    logger.warn({ raw: typeof raw }, '[preflight-config] .omd/preflight.json 根不是对象 → 闸段缺席');
    return null;
  }
  const out: PreFlightConfig = {};
  if (isFreezeCheck(raw.freezeCheck)) {
    out.freezeCheck = raw.freezeCheck;
  } else if (raw.freezeCheck !== undefined) {
    logger.warn({ freezeCheck: raw.freezeCheck }, '[preflight-config] freezeCheck 形状坏 → 闸 A 缺席');
  }
  if (isSeatExpectations(raw.seatExpectations)) {
    out.seatExpectations = raw.seatExpectations;
  } else if (raw.seatExpectations !== undefined) {
    logger.warn(
      { seatExpectations: raw.seatExpectations },
      '[preflight-config] seatExpectations 形状坏 → 闸 B 缺席',
    );
  }
  if (isExclusiveLocks(raw.exclusiveLocks)) {
    out.exclusiveLocks = raw.exclusiveLocks;
  } else if (raw.exclusiveLocks !== undefined) {
    logger.warn(
      { exclusiveLocks: raw.exclusiveLocks },
      '[preflight-config] exclusiveLocks 形状坏 → 闸 C 缺席',
    );
  }
  return out;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isFreezeCheck(v: unknown): v is FreezeCheckOpts {
  if (!isObject(v)) return false;
  if (!Array.isArray(v.files)) return false;
  for (const f of v.files) {
    if (!isObject(f)) return false;
    if (typeof f.path !== 'string' || typeof f.draftMarker !== 'string') return false;
  }
  return true;
}

function isSeatExpectations(v: unknown): v is Record<string, string> {
  if (!isObject(v)) return false;
  for (const [k, val] of Object.entries(v)) {
    if (typeof k !== 'string' || typeof val !== 'string') return false;
  }
  return true;
}

function isExclusiveLocks(v: unknown): v is ExclusiveLocksOpts {
  if (!isObject(v)) return false;
  if (v.resultOut !== undefined && typeof v.resultOut !== 'string') return false;
  if (v.sddPath !== undefined && typeof v.sddPath !== 'string') return false;
  return true;
}