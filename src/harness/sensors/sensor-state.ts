/**
 * harness/sensors/sensor-state —— **传感器的状态与谓词层**(契约
 * `docs/plan/2026-09-22-jev-传感器-阶段0-E1-执行契约.md` 切片 2 / D-5·D-6·D-7·D-8)。
 *
 * ## 这个模块是什么
 *
 * 纯的:喂给 Jev 的那一小份状态怎么攒、怎么封顶,加上「这一步该不该问」「这个读数该不该推送」
 * 两个谓词,以及读数往哪追加。**没有 I/O 以外的副作用,没有网络** —— 发请求是
 * `src/model/jev-client.ts` 的事,点火时机是 `agent-leaf.ts` 的事。
 *
 * ## 为什么状态是引擎的账,不是 transcript
 *
 * D-5:传感器看的是引擎**自己记的账**(读账 / 工具签名 / 派发数),不是模型的自述。
 * 模型没法往这本账里写它没做过的事;而 transcript 既大又是它自己写的,拿它问「有没有证据」
 * 等于让被考的人出卷子。
 *
 * ## 不变量
 *
 *  · **硬上限 {@link SENSOR_STATE_MAX_CHARS} 字符,裁的是 `ledger` 最旧条。**
 *    `goal` 与 `claims` 逐字保留 —— 前者是任务锚,后者正是 `done_without_evidence` 要考的东西,
 *    压掉任何一个,剩下的问题都问不成。
 *    ⚠ 因此上限的**唯一**杠杆是 ledger:`goal` 本身就超 4000 时上限守不住,这是有意的取舍,
 *    不是漏判。
 *  · **开关三态,非法即 off**(D-7):认不出的值一律当没开,不猜、不报错。
 *  · **推送谓词与 W4 勘察预算互斥**:`fired` 由调用方把两边的「已注过」合成一个布尔传进来,
 *    这里只管判,不管谁注的。
 *  · **落盘 fail-open**(仓规 §引擎理念 ④):目录写不了就不写,只 `console.warn` 一行带路径 ——
 *    吞异常可以,吞证据不行(§静默坑 2)。
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ReadEvent } from '../read-ledger';
import type { JevQuestion } from '../../model/jev-client';

export type SensorsMode = 'off' | 'shadow' | 'nudge';

/** `OMD_SENSORS` 三态;缺席与认不出的值都是 `off`(D-7)。 */
export function sensorsMode(env: Record<string, string | undefined>): SensorsMode {
  const raw = env.OMD_SENSORS;
  return raw === 'shadow' || raw === 'nudge' ? raw : 'off';
}

export type SensorQuestionId = 'dispatch_now' | 'redundant_read' | 'off_task' | 'done_without_evidence' | 'stuck';

/**
 * 状态字段表 —— 每问都带上,因为 Jev 无状态:它只看这一发里给的东西,
 * 字段含义不说清就只能靠键名猜。英文写,与 wire 上的字段名同语言。
 */
const STATE_GLOSSARY = [
  'You are given the engine-recorded state of an orchestrator agent working inside a code repository.',
  'Fields: `goal` is the task it must finish. `step` is how many tool steps it has taken.',
  '`readonlySteps` counts steps that only read (grep/ls/cat/find); `dispatches` counts subtasks it has handed to worker agents; `filesTouched` counts files it has written.',
  '`ledger` is the engine record of what it has already read (deduplicated, oldest first, each entry truncated).',
  '`recent` is the last few tool signatures with the head of each result.',
  '`claims` are lines from its latest message that assert the work is done or passing.',
  'The ledger is recorded by the engine at tool-return time, so it is evidence, not self-report.',
].join(' ');

const ask = (question: string): JevQuestion => ({ type: 'noul', instructions: `${STATE_GLOSSARY}\n\n${question}` });

/** 五问一发(D-6):v1 只有 `dispatch_now` 驱动执行器,其余四问只记读数。 */
export const SENSOR_QUESTIONS: Record<SensorQuestionId, JevQuestion> = {
  dispatch_now: ask(
    'Question: should the agent stop surveying the repository and dispatch work to a subtask right now? Answer yes when the ledger already contains enough to write a concrete subtask brief, and further reading would only repeat what it has.',
  ),
  redundant_read: ask(
    'Question: is the most recent read redundant? Answer yes when the content it just fetched is already present in the ledger under a different key or path.',
  ),
  off_task: ask(
    'Question: is the agent working on something other than `goal`? Answer yes when the recent steps serve a different problem than the one the goal states.',
  ),
  done_without_evidence: ask(
    'Question: is the agent claiming the work is done or passing without evidence for it? Answer yes when `claims` assert success but neither `ledger` nor `recent` shows a command output that backs the claim.',
  ),
  stuck: ask(
    'Question: is the agent stuck? Answer yes when the recent steps repeat the same signature or the same failure without the situation changing.',
  ),
};

/** tape 里的一条:读账事件与工具步共用一个形,`kind` 分得开。 */
export interface SensorTapeEntry {
  kind: ReadEvent['kind'] | 'tool';
  key: string;
  head: string;
}

export interface SensorTape {
  observeRead(ev: ReadEvent): void;
  observeTool(sig: string, resultHead: string): void;
  observeAssistant(text: string): void;
  snapshot(): { ledger: SensorTapeEntry[]; recent: { sig: string; result: string }[]; claims: string[] };
}

const DEFAULT_MAX_ENTRIES = 12;
const DEFAULT_MAX_HEAD = 120;
const DEFAULT_MAX_RECENT = 3;
const MAX_RESULT_HEAD = 200;
const MAX_CLAIMS = 5;
const MAX_CLAIM_CHARS = 200;

/** 完成声称的判据(大小写不敏感):命中任一即算一条 claim。 */
const CLAIM_MARKERS = /完成|通过|done|pass|all tests/i;

/**
 * 完成声称的**唯一**判据:`CLAIM_MARKERS` 的具名出口。tape 里挑 claims 行与「这一步该不该问」
 * 共用同一个正则 —— 调用方不许自带副本,否则会出现「问了完成声称、而 tape 里 claims 是空的」这种
 * 自相矛盾的读数,且没有任何闸会红。
 */
export function hasCompletionClaim(text: string): boolean {
  return CLAIM_MARKERS.test(text);
}

/** 从一条 assistant 文本里挑出完成声称行;去重,最多 {@link MAX_CLAIMS} 条,每条截到 200 字符。 */
function extractClaims(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t || !CLAIM_MARKERS.test(t)) continue;
    const clipped = t.slice(0, MAX_CLAIM_CHARS);
    if (!out.includes(clipped)) out.push(clipped);
    if (out.length === MAX_CLAIMS) break;
  }
  return out;
}

/**
 * 本地 tape:最近 N 条读事件 + 最近 M 步工具签名 + **最后一条** assistant 的完成声称行。
 * claims 是覆盖不是累积 —— D-5 问的是「它现在在声称什么」,上一轮的声称已经被下一轮的证据覆盖过了。
 */
export function createSensorTape(opts?: { maxEntries?: number; maxHead?: number; maxRecent?: number }): SensorTape {
  const maxEntries = opts?.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const maxHead = opts?.maxHead ?? DEFAULT_MAX_HEAD;
  const maxRecent = opts?.maxRecent ?? DEFAULT_MAX_RECENT;
  const ledger: SensorTapeEntry[] = [];
  const recent: { sig: string; result: string }[] = [];
  let claims: string[] = [];

  const push = (entry: SensorTapeEntry): void => {
    ledger.push(entry);
    while (ledger.length > maxEntries) ledger.shift();
  };

  return {
    observeRead(ev) {
      push({ kind: ev.kind, key: ev.key, head: ev.excerpt.slice(0, maxHead) });
    },
    observeTool(sig, resultHead) {
      recent.push({ sig, result: resultHead.slice(0, MAX_RESULT_HEAD) });
      while (recent.length > maxRecent) recent.shift();
    },
    observeAssistant(text) {
      claims = extractClaims(text);
    },
    snapshot() {
      return { ledger: [...ledger], recent: [...recent], claims: [...claims] };
    },
  };
}

export interface SensorState {
  goal: string;
  step: number;
  readonlySteps: number;
  dispatches: number;
  filesTouched: number;
  ledger: SensorTapeEntry[];
  recent: { sig: string; result: string }[];
  claims: string[];
}

/** ≈ 1k token。涨上限的代价是每步的钱与时延,不是「反正传更多更准」。 */
export const SENSOR_STATE_MAX_CHARS = 4000;

/** 攒状态并封顶:超限就裁 `ledger` 最旧条,`goal` / `claims` / `recent` 逐字保留。 */
export function buildSensorState(input: {
  goal: string;
  step: number;
  readonlySteps: number;
  dispatches: number;
  filesTouched: number;
  tape: SensorTape;
}): SensorState {
  const snap = input.tape.snapshot();
  const state: SensorState = {
    goal: input.goal,
    step: input.step,
    readonlySteps: input.readonlySteps,
    dispatches: input.dispatches,
    filesTouched: input.filesTouched,
    ledger: snap.ledger,
    recent: snap.recent,
    claims: snap.claims,
  };
  while (JSON.stringify(state).length > SENSOR_STATE_MAX_CHARS && state.ledger.length > 0) state.ledger.shift();
  return state;
}

export const SENSOR_NUDGE_THRESHOLD = 0.85;

/** 该不该发这一问(D-4):只在持卡节点(conductor)的只读步或含完成声称的步上问。 */
export function sensorFireHit(s: { mode: SensorsMode; hasCards: boolean; readonlyStep: boolean; hasClaim: boolean }): boolean {
  return s.mode !== 'off' && s.hasCards && (s.readonlyStep || s.hasClaim);
}

/**
 * 这个读数该不该变成一次推送(D-10):shadow 恒 false —— 那一臂只记不裁。
 * `fired` 由调用方合成(W4 已注 ⇒ true),两边只注一次。
 */
export function sensorNudgeHit(s: {
  mode: SensorsMode;
  pDispatchNow: number | undefined;
  hasCards: boolean;
  dispatches: number;
  fired: boolean;
  bufferBusy: boolean;
}): boolean {
  return (
    s.mode === 'nudge' &&
    s.hasCards &&
    s.dispatches === 0 &&
    !s.fired &&
    !s.bufferBusy &&
    s.pDispatchNow !== undefined &&
    s.pDispatchNow >= SENSOR_NUDGE_THRESHOLD
  );
}

export interface SensorReading {
  at: string;
  step: number;
  mode: SensorsMode;
  ok: boolean;
  why?: string;
  ms: number;
  p: Partial<Record<SensorQuestionId, number>>;
  nudged: boolean;
  stateChars: number;
  dispatches: number;
  cwd: string;
}

/** 读数落点(D-8):仓外,`OMD_SENSORS_DIR` 覆盖,缺省 `<home>/.omd/sensors`。 */
export function sensorsDir(env: Record<string, string | undefined>, home: string): string {
  return env.OMD_SENSORS_DIR ?? join(home, '.omd', 'sensors');
}

/**
 * 追加一条读数到 `<YYYY-MM-DD>.jsonl`(UTC 日界,与 `at` 同一口径)。
 * **fail-open**:目录建不了、路径被普通文件占着、磁盘满 —— 都不抛,只留一行带路径的证据。
 */
export function appendSensorReading(dir: string, r: SensorReading, now: Date = new Date()): void {
  const file = join(dir, `${now.toISOString().slice(0, 10)}.jsonl`);
  try {
    mkdirSync(dir, { recursive: true });
    appendFileSync(file, `${JSON.stringify(r)}\n`);
  } catch (e) {
    console.warn(`[omd/sensor] 读数没写成 ${file}: ${e instanceof Error ? e.message : String(e)}`);
  }
}
