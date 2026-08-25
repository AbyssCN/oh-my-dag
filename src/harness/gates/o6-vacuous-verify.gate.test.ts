/**
 * src/harness/gates/o6-vacuous-verify.gate.test.ts ——
 * 「[run-goal][o6-vacuous-verify]」闸的真开火用例。
 *
 * 三件事一起钉:
 *  ① 最小配置触发 run-goal 的 O-6 切片级 vacuous 探针 (sdd + acceptance.executable +
 *     commandRunner 返 exitCode 0), 该探针抛错 message 含整串判词标记
 *     `[run-goal][o6-vacuous-verify]`。命令白名单里的 `bun` 起首, 避免闸 B 反向自检里
 *     `assertRunnable` 提前拒掉。run-goal.ts 自身 try/catch 把这条 throw 折成 v1 回落,
 *     message 经 logger.warn 的 `err: flatFallback` 字段外泄到外层——本用例钉的是这条
 *     外泄路径, 不是直接捕获 throw。
 *  ② GATE_REGISTRY 末尾登记 `{id:'o6-vacuous-verify', file:'src/harness/goal/run-goal.ts'}`
 *     这一条 —— 既有 12 条 id 一字不动, 这里只查新条存不存在 + file 字段对不对。
 *  ③ 该条目自己的判词标记能被「放宽后的扫描器」(post-impl `scanGateVerdicts(sources)` 形状)
 *     在 run-goal.ts 源码里扫到 —— 用 unknown 桥接前/后两种入参形态, 本用例钉的是「标记真的
 *     进了源码里」, 不钉 scanner 入参是 `string` 还是 `Record<file,source>`。
 *
 * ★ 反向自检 (逐条对应, 实跑过证伪):
 *   - 把 run-goal.ts O-6 throw 文案最前面塞的 `[run-goal][o6-vacuous-verify]` 删掉 ⇒ ①、③ 同时红 (实测: 1 pass / 2 fail, 两条都因整串缺失)。
 *   - 把 GATE_REGISTRY 末尾追加的那条 {id:'o6-vacuous-verify', ...} 删掉 ⇒ ② 红。
 *   - 把 run-goal.ts 里那段 `[run-goal][o6-vacuous-verify]` 整段判词删掉 ⇒ ③ 红。
 *   - 把 `config.dag.commandRunner` 那个 if 守卫拿掉 ⇒ ① 通过 commandRunner 的那条改为不再抛,
 *     整用例 (整个 runGoal 不再 throw) ⇒ ① 红。
 *   任一跳掉链子, 对应那条立刻红。完全独立, 一红就定位到具体那一跳。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GATE_REGISTRY, scanGateVerdicts } from './gate-registry';
import { runGoal, type RunGoalConfig } from '../goal/run-goal';
import { setCoreLogger, type CoreLogger } from '../logger';
import type { AcceptanceSpec, GoalClassification } from '../goal/classify-acceptance';
import type { ConductorPlan } from '../conductor-plan';
import type { ExecutorDagConfig, ExecutorDagResult } from '../dag/types';

/** 最小可用 SDD: 单切片 / 写集互不相交 / 不下沉到 seam / verify 与 acceptCommand 不撞 / 无波形
 * (无波形走 assertAcyclic 那条, 单片零依赖天然无环)。verify 起首 `bun` 进命令白名单。 */
const SDD_OK = [
  '# o6 反向用例契约',
  '## 契约 (Contracts)',
  '- G-1 占位',
  '## 分解 (Breakdown)',
  '| 切片 | 写集 | 依赖 | verify |',
  '|---|---|---|---|',
  '| 1 占位切片 | src/o6-probe-target.ts + test | — | bun test src/o6-probe-target.test.ts |',
].join('\n');

const tmpSdd = (text: string): string => {
  const dir = mkdtempSync(join(tmpdir(), 'omd-o6-gate-sdd-'));
  const p = join(dir, 'x.md');
  writeFileSync(p, text);
  return p;
};

const ACC: AcceptanceSpec = { kind: 'executable', command: 'bun test', expectExit: 0 };
const cls = async (): Promise<GoalClassification> => ({ tier: 'complex', acceptance: ACC });

/** 把 run-goal 的 warn/error 全部捕获下来 —— O-6 抛错被 file 891 那个 try/catch 吃掉,
 * 唯一外露面是 logger.warn 的 { err: flatFallback } 字段 (run-goal.ts:932-934)。 */
interface CapturedWarn {
  msg: string;
  fields: Record<string, unknown>;
}
const captured: CapturedWarn[] = [];
const captureLogger: CoreLogger = {
  debug: () => {},
  info: () => {},
  warn: (o, m) => {
    const fields: Record<string, unknown> =
      o && typeof o === 'object' && !Array.isArray(o) ? (o as Record<string, unknown>) : {};
    captured.push({ msg: m ?? '', fields });
  },
  error: (o, m) => {
    const fields: Record<string, unknown> =
      o && typeof o === 'object' && !Array.isArray(o) ? (o as Record<string, unknown>) : {};
    captured.push({ msg: m ?? '', fields });
  },
};
/**
 * ⚠ **换回去的那一只**(2026-08-23 收编时补): `setCoreLogger` 改的是**模块级单例**,
 * 而 bun 把多个测试文件跑在同一个进程里 —— 只清数组不换回 logger, 这只"什么都不打印、
 * warn/error 全塞进一个没人读的数组"的假 logger 就会**留给后面每一个测试文件**。
 * 实测代价: 收编当趟全量 `handoff-next-steps.test.ts` 3 条红, 而单跑该文件 4 pass ——
 * 典型的跨文件污染(症状出现在受害者身上, 根因在这里)。
 * 照 `design-review.test.ts` / `profile-assembly.test.ts` 的既有惯例换回 console 直通。
 */
const consoleLogger: CoreLogger = {
  debug: () => {},
  info: (o, m) => console.log(m ?? '', typeof o === 'string' ? o : ''),
  warn: (o, m) => console.warn(m ?? '', typeof o === 'string' ? o : ''),
  error: (o, m) => console.error(m ?? '', o),
};
beforeEach(() => {
  captured.length = 0;
  setCoreLogger(captureLogger);
});
afterEach(() => {
  captured.length = 0;
  setCoreLogger(consoleLogger);
});

/** 永不被叫到的 _runDag —— 探针在调用 _runDag **之前**就抛了, 走到平铺图编译后那条 for 循环
 * 里 commandRunner 返 0 ⇒ throw。这条只是桩, 让 RunGoalConfig 的形状 type-check 过得去。 */
const noopRunDag = (async (
  _plan: ConductorPlan,
): Promise<ExecutorDagResult> => ({
  plan: { name: 'goal-execute', nodes: {} },
  results: {},
  sessionId: 'o6-probe',
  levels: [],
  usage: { conductor: { in: 0, out: 0 }, leavesIn: 0, leavesOut: 0, leavesCacheHit: 0 },
  reusedNodes: [],
})) as never;

describe('o6-vacuous-verify 闸 (run-goal O-6 切片级 vacuous 探针)', () => {
  test('① 真开火: commandRunner 返 exitCode 0 ⇒ O-6 探针抛错且判词标记能被外层 logger 捕获', async () => {
    const sddPath = tmpSdd(SDD_OK);
    const cwd = mkdtempSync(join(tmpdir(), 'omd-o6-gate-cwd-'));
    const calls: string[] = [];
    const config: RunGoalConfig = {
      cwd,
      dag: { conductorModel: 'c:m', leafModel: 'l:m' } as ExecutorDagConfig,
      _classify: cls,
      _runDag: noopRunDag,
      sddPath,
    };
    config.dag.commandRunner = async (arg: { command: string }) => {
      calls.push(arg.command);
      return { text: '', usage: { in: 0, out: 0 }, exitCode: 0, timedOut: false, signal: null };
    };

    // runGoal 自己不抛 (平铺块的 try/catch 把 O-6 throw 折成 INV-D3-4 fail-fast 终态,
    // owner 2026-08-25: sddPath 不落 v1), 但 logger.warn 会以 `err` 字段把那条 message
    // 外泄 —— 本用例就是这条外泄路径的钉子。
    await runGoal('o6 probe', config);

    const flatFallbackEntries = captured.filter((c) => c.msg.includes('INV-D3-4'));
    expect(flatFallbackEntries.length).toBeGreaterThan(0);
    const flatBlobs = flatFallbackEntries
      .map((c) => JSON.stringify(c.fields))
      .join('\n');
    expect(flatBlobs).toContain('[run-goal][o6-vacuous-verify]');
    // 探针确实顺着切片 verify 走到了 commandRunner —— 反证: 没调用 ⇒ 那个错误没来源,
    // 整条闸在空转 (闸退化成「随便抛一句」), 那不是反向自检想要的形态。
    expect(calls.some((c) => c.includes('bun test'))).toBe(true);
  });

  test('② GATE_REGISTRY 登记 o6-vacuous-verify 条目, file 指向 src/harness/goal/run-goal.ts', () => {
    const entry = GATE_REGISTRY.find((e) => e.id === 'o6-vacuous-verify');
    expect(entry).toBeDefined();
    expect(entry!.file).toBe('src/harness/goal/run-goal.ts');
  });

  test('③ 判词标记能被放宽后的扫描器在 run-goal.ts 源码里扫到', () => {
    const source = readFileSync(
      join(import.meta.dir, '../goal/run-goal.ts'),
      'utf8',
    );
    const sources: Readonly<Record<string, string>> = {
      'src/harness/goal/run-goal.ts': source,
    };
    // post-impl 签名: `scanGateVerdicts(sources: Readonly<Record<file,string>>)`。
    // 当前实现拿 Record 当字符串用, runtime 会抛 TypeError (查 matchAll 上 undefined) ——
    // 把异常吞成「没扫到」一并断言失败, 避免把「自然红」变成「异常红」(后者会让 ③ 跳闸)。
    let verdicts: Map<string, string> | undefined;
    try {
      verdicts = (
        scanGateVerdicts as unknown as (s: Readonly<Record<string, string>>) => Map<string, string>
      )(sources);
    } catch {
      verdicts = undefined;
    }
    expect(verdicts?.has('o6-vacuous-verify')).toBe(true);
  });
});
