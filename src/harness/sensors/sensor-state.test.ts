/**
 * 传感器状态与谓词 —— 上限、开关、两个谓词、落盘四样两侧钉死(契约
 * `docs/plan/2026-09-22-jev-传感器-阶段0-E1-执行契约.md` INV-2..INV-6 / GWT-3..GWT-8)。
 *
 * 纯模块 + 一个 `mkdtemp` 临时目录,不碰网络也不碰 `~/.omd`。
 *
 * 证伪(每条要能真红):
 *  · `buildSensorState` 里的 while 循环删掉 ⇒ 「超限裁 ledger」红(GWT-3);
 *  · 改成裁 `goal` 或 `claims` ⇒ 「goal 逐字保留」/「claims 逐字保留」红;
 *  · `CLAIM_MARKERS` 去掉 `i` 标志 ⇒ 「DONE 大写也算」红;去掉去重 ⇒ 「同一行只留一条」红;
 *  · `observeAssistant` 改成累积而非覆盖 ⇒ 「只留最后一条 assistant 的声称」红;
 *  · `sensorsMode` 把认不出的值原样返回 ⇒ 「非法即 off」红(GWT-5);
 *  · `sensorFireHit` 去掉 `hasCards` ⇒ 「不持卡恒不点火」红;把 `||` 写成 `&&` ⇒ 「声称步也点火」红;
 *  · `sensorNudgeHit` 的 `>=` 写成 `>` ⇒ 「0.85 恰好触发」红;去掉 `mode === 'nudge'` ⇒ 「shadow 恒 false」红;
 *    去掉 `!fired` / `!bufferBusy` / `dispatches === 0` ⇒ 各自那条红;
 *  · `appendSensorReading` 去掉 try/catch ⇒ 「路径被普通文件占着不抛」红;
 *    去掉 `console.warn` ⇒ 「fail-open 也要留证据」红。
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SENSOR_NUDGE_THRESHOLD,
  SENSOR_QUESTIONS,
  SENSOR_STATE_MAX_CHARS,
  appendSensorReading,
  buildSensorState,
  createSensorTape,
  sensorFireHit,
  sensorNudgeHit,
  sensorsDir,
  sensorsMode,
  type SensorReading,
} from './sensor-state';

const tmp = (): string => mkdtempSync(join(tmpdir(), 'omd-sensors-'));

const realWarn = console.warn;
afterEach(() => {
  console.warn = realWarn;
});

describe('SENSOR_QUESTIONS (D-6): 五问全 noul, 每问自带状态字段表', () => {
  test('五个 id 齐, 类型全 noul', () => {
    expect(Object.keys(SENSOR_QUESTIONS).sort()).toEqual(
      ['dispatch_now', 'done_without_evidence', 'off_task', 'redundant_read', 'stuck'].sort(),
    );
    for (const q of Object.values(SENSOR_QUESTIONS)) expect(q.type).toBe('noul');
  });

  test('★ dispatch_now 问的是「停止勘察立即派活」, 且每问都说清了状态字段含义 (Jev 无状态, 不说就只能猜键名)', () => {
    expect(SENSOR_QUESTIONS.dispatch_now.instructions).toContain('dispatch work to a subtask right now');
    for (const q of Object.values(SENSOR_QUESTIONS)) {
      expect(q.instructions).toContain('`ledger`');
      expect(q.instructions).toContain('`goal`');
      expect(q.instructions).toContain('Question:');
    }
  });
});

describe('createSensorTape (D-5)', () => {
  test('读事件截到 maxHead, 只留最近 maxEntries 条 (最旧的先掉)', () => {
    const tape = createSensorTape();
    for (let i = 0; i < 20; i++) tape.observeRead({ kind: 'read', key: `f${i}.ts`, excerpt: 'x'.repeat(500) });
    const snap = tape.snapshot();
    expect(snap.ledger.length).toBe(12);
    expect(snap.ledger[0]!.key).toBe('f8.ts');
    expect(snap.ledger[0]!.head.length).toBe(120);
  });

  test('工具步只留最近 3 步, 结果头截到 200', () => {
    const tape = createSensorTape();
    tape.observeTool('bash:grep', 'a'.repeat(500));
    tape.observeTool('read:b', 'b');
    tape.observeTool('read:c', 'c');
    tape.observeTool('read:d', 'd');
    const snap = tape.snapshot();
    expect(snap.recent.map((r) => r.sig)).toEqual(['read:b', 'read:c', 'read:d']);
    tape.observeTool('bash:long', 'a'.repeat(500));
    expect(tape.snapshot().recent[2]!.result.length).toBe(200);
  });

  test('★ claims 只收完成声称行, 不收普通叙述 (GWT-4)', () => {
    const tape = createSensorTape();
    tape.observeAssistant('所有测试通过, 完成\n继续读文件');
    expect(tape.snapshot().claims).toEqual(['所有测试通过, 完成']);
  });

  test('claims 大小写不敏感 · 去重 · 最多 5 条 · 每条 ≤ 200 字符', () => {
    const tape = createSensorTape();
    tape.observeAssistant(
      ['ALL TESTS green', 'ALL TESTS green', 'done a', 'done b', 'done c', 'done d', 'done e', 'nothing here'].join('\n'),
    );
    const claims = tape.snapshot().claims;
    expect(claims.length).toBe(5);
    expect(claims[0]).toBe('ALL TESTS green');
    expect(claims.filter((c) => c === 'ALL TESTS green').length).toBe(1);
    expect(claims).not.toContain('nothing here');

    const tape2 = createSensorTape();
    tape2.observeAssistant(`完成 ${'x'.repeat(400)}`);
    expect(tape2.snapshot().claims[0]!.length).toBe(200);
  });

  test('claims 是覆盖不是累积 —— 问的是「它现在在声称什么」', () => {
    const tape = createSensorTape();
    tape.observeAssistant('第一轮完成');
    tape.observeAssistant('还在读文件');
    expect(tape.snapshot().claims).toEqual([]);
  });

  test('snapshot 是拷贝, 拿走之后继续 observe 不会改到手里那份', () => {
    const tape = createSensorTape();
    tape.observeRead({ kind: 'grep', key: 'a', excerpt: 'a' });
    const snap = tape.snapshot();
    tape.observeRead({ kind: 'grep', key: 'b', excerpt: 'b' });
    expect(snap.ledger.length).toBe(1);
  });
});

describe('buildSensorState 硬上限 (INV-2)', () => {
  const base = { step: 30, readonlySteps: 22, dispatches: 0, filesTouched: 0 };

  test('★ 超限时裁 ledger 最旧条, goal 逐字保留 (GWT-3)', () => {
    const goal = `修好 ${'目'.repeat(2400)} 这件事`;   // 长判据文本: 逼 ledger 让位, 而不是反过来
    const tape = createSensorTape();
    for (let i = 0; i < 40; i++) tape.observeRead({ kind: 'read', key: `src/f${i}.ts`, excerpt: 'y'.repeat(500) });
    tape.observeAssistant('全部通过');

    const s = buildSensorState({ ...base, goal, tape });
    expect(JSON.stringify(s).length).toBeLessThanOrEqual(SENSOR_STATE_MAX_CHARS);
    expect(s.ledger.length).toBeGreaterThan(0);
    expect(s.ledger.length).toBeLessThan(12);
    expect(s.goal).toBe(goal);
    expect(s.claims).toEqual(['全部通过']);
    // 裁的是最旧的那一端: 留下的一定是尾部连续的一段。
    expect(s.ledger[s.ledger.length - 1]!.key).toBe('src/f39.ts');
  });

  test('整条 tape 不截断时同样守得住上限 (裁到 ledger 空也不碰 goal/claims)', () => {
    const tape = createSensorTape({ maxEntries: 40, maxHead: 500 });
    for (let i = 0; i < 40; i++) tape.observeRead({ kind: 'bash-readonly', key: `cmd${i}`, excerpt: 'z'.repeat(500) });
    const s = buildSensorState({ ...base, goal: '短目标', tape });
    expect(JSON.stringify(s).length).toBeLessThanOrEqual(SENSOR_STATE_MAX_CHARS);
    expect(s.goal).toBe('短目标');
  });

  test('不超限就一条不裁 (上限是闸, 不是默认压缩)', () => {
    const tape = createSensorTape();
    tape.observeRead({ kind: 'ls', key: 'src', excerpt: 'a.ts b.ts' });
    tape.observeTool('read:a', 'head');
    const s = buildSensorState({ ...base, goal: 'g', tape });
    expect(s.ledger.length).toBe(1);
    expect(s.recent.length).toBe(1);
  });
});

describe('sensorsMode 三态 (INV-3 / GWT-5)', () => {
  test('★ undefined / off / shadow / nudge / 非法 ⇒ off off shadow nudge off', () => {
    expect(sensorsMode({})).toBe('off');
    expect(sensorsMode({ OMD_SENSORS: 'off' })).toBe('off');
    expect(sensorsMode({ OMD_SENSORS: 'shadow' })).toBe('shadow');
    expect(sensorsMode({ OMD_SENSORS: 'nudge' })).toBe('nudge');
    expect(sensorsMode({ OMD_SENSORS: 'x' })).toBe('off');
    expect(sensorsMode({ OMD_SENSORS: '' })).toBe('off');
    expect(sensorsMode({ OMD_SENSORS: 'NUDGE' })).toBe('off');
  });
});

describe('sensorFireHit 点火谓词 (INV-4 / GWT-6)', () => {
  const base = { mode: 'shadow' as const, hasCards: true, readonlyStep: true, hasClaim: false };

  test('★ shadow + 持卡 + 只读步 ⇒ 点火', () => {
    expect(sensorFireHit(base)).toBe(true);
  });

  test('不持卡 ⇒ 不点火 (D-4: 只在 conductor 问)', () => {
    expect(sensorFireHit({ ...base, hasCards: false })).toBe(false);
  });

  test('off ⇒ 恒不点火 (INV-8 默认零回归的那一半)', () => {
    expect(sensorFireHit({ ...base, mode: 'off' })).toBe(false);
  });

  test('写步且无完成声称 ⇒ 不点火; 写步但有声称 ⇒ 点火 (声称步是 done_without_evidence 要考的)', () => {
    expect(sensorFireHit({ ...base, readonlyStep: false, hasClaim: false })).toBe(false);
    expect(sensorFireHit({ ...base, readonlyStep: false, hasClaim: true })).toBe(true);
  });

  test('nudge 臂的点火条件与 shadow 一样 (两臂问的一样多, 差别只在裁不裁)', () => {
    expect(sensorFireHit({ ...base, mode: 'nudge' })).toBe(true);
  });
});

describe('sensorNudgeHit 推送谓词 (INV-5 / GWT-7)', () => {
  const base = {
    mode: 'nudge' as const,
    pDispatchNow: SENSOR_NUDGE_THRESHOLD,
    hasCards: true,
    dispatches: 0,
    fired: false,
    bufferBusy: false,
  };

  test('★ 恰好到阈值即推送 (0.85 ⇒ true, 0.849 ⇒ false)', () => {
    expect(sensorNudgeHit(base)).toBe(true);
    expect(sensorNudgeHit({ ...base, pDispatchNow: 0.849 })).toBe(false);
    expect(sensorNudgeHit({ ...base, pDispatchNow: 0.9 })).toBe(true);
  });

  test('shadow 恒 false (那一臂只记不裁 —— D-9 的前置样本就是这么攒的)', () => {
    expect(sensorNudgeHit({ ...base, mode: 'shadow' })).toBe(false);
    expect(sensorNudgeHit({ ...base, mode: 'off' })).toBe(false);
  });

  test('已注过 / 缓冲占着 / 已派过活 / 不持卡 ⇒ 各自不推送', () => {
    expect(sensorNudgeHit({ ...base, fired: true })).toBe(false);
    expect(sensorNudgeHit({ ...base, bufferBusy: true })).toBe(false);
    expect(sensorNudgeHit({ ...base, dispatches: 1 })).toBe(false);
    expect(sensorNudgeHit({ ...base, hasCards: false })).toBe(false);
  });

  test('没读数 ⇒ 不推送 (undefined 不是 0, 也不是「低于阈值」—— 它是这一发没回来)', () => {
    expect(sensorNudgeHit({ ...base, pDispatchNow: undefined })).toBe(false);
  });
});

describe('sensorsDir / appendSensorReading 落盘 (INV-6 / GWT-8)', () => {
  const reading = (p: number): SensorReading => ({
    at: '2026-09-22T10:00:00.000Z',
    step: 7,
    mode: 'shadow',
    ok: true,
    ms: 210,
    p: { dispatch_now: p },
    nudged: false,
    stateChars: 1234,
    dispatches: 0,
    cwd: '/repo',
  });

  test('OMD_SENSORS_DIR 覆盖, 缺省 <home>/.omd/sensors (D-8: 仓外)', () => {
    expect(sensorsDir({}, '/home/x')).toBe('/home/x/.omd/sensors');
    expect(sensorsDir({ OMD_SENSORS_DIR: '/tmp/s' }, '/home/x')).toBe('/tmp/s');
  });

  test('★ 两条读数 ⇒ 文件恰两行, 每行 JSON.parse 得回写入值', () => {
    const dir = tmp();
    const now = new Date('2026-09-22T10:00:00.000Z');
    appendSensorReading(dir, reading(0.91), now);
    appendSensorReading(dir, reading(0.12), now);
    const lines = readFileSync(join(dir, '2026-09-22.jsonl'), 'utf-8').trimEnd().split('\n');
    expect(lines.length).toBe(2);
    const first = JSON.parse(lines[0]!) as SensorReading;
    expect(first.p.dispatch_now).toBe(0.91);
    expect((JSON.parse(lines[1]!) as SensorReading).p.dispatch_now).toBe(0.12);
    expect(first.step).toBe(7);
    expect(first.mode).toBe('shadow');
    expect(first.ok).toBe(true);
    expect(first.ms).toBe(210);
    expect(first.nudged).toBe(false);
    expect(first.stateChars).toBe(1234);
  });

  test('★ 目录位置被普通文件占着 ⇒ 不抛, 但留一行带路径的证据 (fail-open 吞异常不吞证据)', () => {
    const dir = join(tmp(), 'occupied');
    writeFileSync(dir, 'not a dir');
    const warned: string[] = [];
    console.warn = (...args: unknown[]) => {
      warned.push(args.map(String).join(' '));
    };
    expect(() => appendSensorReading(dir, reading(0.5))).not.toThrow();
    expect(warned.length).toBe(1);
    expect(warned[0]).toContain(dir);
  });

  test('日期按 UTC 分文件 (与 reading.at 同一口径, 跨时区跑同一个 run 不会分两天)', () => {
    const dir = tmp();
    appendSensorReading(dir, reading(0.3), new Date('2026-09-23T23:59:59.000Z'));
    expect(readFileSync(join(dir, '2026-09-23.jsonl'), 'utf-8').trimEnd().split('\n').length).toBe(1);
  });
});
