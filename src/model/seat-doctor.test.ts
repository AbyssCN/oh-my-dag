/**
 * seat-doctor 装配纯函数测试 (切片 2 · docs/plan/2026-08-10-seats-doctor-report.md 契约)。
 *
 *  · G-1 数据面: 每行含 坐标 / 配置来源层 / 凭证态 / 熔断态 / 周期用量; 任一 NULL 格必有原因列。
 *  · G-2 冷却/自愈两态与 `inCooldown(coord, now)` 判定一致 (provider-health.ts:136-146)。
 *       手法照 provider-health.test.ts:113-131: OMD_SEAT_HEALTH_PATH 指 mkdtemp 临时目录,
 *       盘上注入一条未过期周期冷却 + 一条已过期条目。
 *  · INV-2 行覆盖 = 座位全集 + 所有已发现渠道 (六源坐标并集)。
 *  · G-6 反向自检 (证伪方式见各用例注释): 实现把缺数据格按 0 填充 → 当场红。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inCooldown, resetProviderCooldowns } from './provider-health';
import { ALL_SEAT_IDS } from './seats';
import { assembleDoctorRows, type ConfigLayer, type DoctorRow, type SeatHealthFile } from './seat-doctor';

// G-2 文件级: inCooldown 会读 OMD_SEAT_HEALTH_PATH 指向的 seat-health.json —— 不重定向就把
// 测试写的冷却条目落到**真仓** .omd/seat-health.json (先例 provider-health.test.ts:21-22)。
let fileDir: string;
let savedEnv: string | undefined;
beforeEach(() => {
  fileDir = mkdtempSync(join(tmpdir(), 'omd-seat-doctor-'));
  savedEnv = process.env.OMD_SEAT_HEALTH_PATH;
  process.env.OMD_SEAT_HEALTH_PATH = join(fileDir, 'seat-health.json');
  resetProviderCooldowns();
});
afterEach(() => {
  if (savedEnv === undefined) delete process.env.OMD_SEAT_HEALTH_PATH;
  else process.env.OMD_SEAT_HEALTH_PATH = savedEnv;
  rmSync(fileDir, { recursive: true, force: true });
  resetProviderCooldowns();
});

/** G-1 三态不变式: 任一 NULL 格必有非空原因列 (值 ≠ NULL+原因 ≠ 0 填充)。 */
function expectNullCauses(row: DoctorRow): void {
  if (row.coord === null) expect(row.coordCause, `coord 原因 (row ${row.channelId}/${row.seatIndex})`).toBeTruthy();
  if (row.configLayer === null) expect(row.configLayerCause, 'configLayer 原因').toBeTruthy();
  if (row.credentialState === null) expect(row.credentialCause, 'credential 原因').toBeTruthy();
  if (row.circuitState === null) expect(row.circuitCause, 'circuit 原因').toBeTruthy();
  if (row.cooldownRemaining === null) expect(row.cooldownCause, 'cooldown 原因').toBeTruthy();
  if (row.periodUsage === null) expect(row.usageCause, 'periodUsage 原因').toBeTruthy();
}

describe('G-1 数据面: 行模型字段 + NULL 必有原因', () => {
  const t0 = Date.now();
  const base = {
    seats: ['conductor', 'leaf', 'gate'],
    configLayerBySeat: new Map<string, ConfigLayer>([
      ['conductor', 'config'],
      ['leaf', 'env'],
    ]),
    seatHealth: { cooldowns: [] },
    usageEntries: [
      { ts: t0 - 1_000, model: 'allegretto:kimi-k3', in: 100, out: 10 },
      { ts: t0 - 2_000, model: 'allegretto:kimi-k3', in: 200, out: 20 },
      { ts: t0 - 3_000, model: 'deepseek:deepseek-v4-flash', in: 5, out: 1 },
    ],
    planLedger: [{ id: 'r1', coords: ['allegretto:kimi-k3'] }],
    configState: {
      models: { conductor: 'allegretto:kimi-k3', leaf: 'deepseek:deepseek-v4-flash' },
      credentials: { allegretto: 'ok' as const }, // as const: 字面量收窄, 否则 widen 成 string 不认 CredentialState
    },
    now: t0,
  };

  test('座位行: 坐标/来源层/凭证态/熔断态/周期用量齐全, 有值格原因列为空', () => {
    const rows = assembleDoctorRows(base);
    const conductor = rows.find((r) => r.seatIndex === 0)!;
    expect(conductor.coord).toBe('allegretto:kimi-k3');
    expect(conductor.channelId).toBe('allegretto');
    expect(conductor.configLayer).toBe('config');
    expect(conductor.credentialState).toBe('ok');
    expect(conductor.circuitState).toBe('closed'); // 无冷却记录 = 不在冷却
    expect(conductor.periodUsage).toEqual({ count: 2, tokens: 330 }); // (100+10)+(200+20)
    expect(conductor.usageCause).toBeNull();
    const leaf = rows.find((r) => r.seatIndex === 1)!;
    expect(leaf.configLayer).toBe('env');
    expect(leaf.credentialState).toBeNull(); // deepseek 无凭证注入 → NULL + 原因
    expect(leaf.credentialCause).toBeTruthy();
    expect(leaf.periodUsage).toEqual({ count: 1, tokens: 6 });
  });

  test('缺配置座位: 各格 NULL + 原因 (G-6 证伪的同一形状)', () => {
    const rows = assembleDoctorRows(base);
    const gate = rows.find((r) => r.seatIndex === 2)!;
    expect(gate.coord).toBeNull();
    expect(gate.coordCause).toBeTruthy();
    expect(gate.channelId).toBeNull();
    expect(gate.configLayer).toBeNull();
    expect(gate.configLayerCause).toBeTruthy();
    expect(gate.credentialState).toBeNull();
    expect(gate.credentialCause).toBeTruthy();
    expect(gate.circuitState).toBeNull(); // 不适用: 无坐标可查熔断
    expect(gate.circuitCause).toBeTruthy();
    expect(gate.cooldownRemaining).toBeNull();
    expect(gate.cooldownCause).toBeTruthy();
    expect(gate.periodUsage).toBeNull();
    expect(gate.usageCause).toBeTruthy();
  });

  test('NULL 格必有原因列 (全行不变式)', () => {
    for (const row of assembleDoctorRows(base)) expectNullCauses(row);
  });
});

describe('G-2 冷却/自愈两态与 inCooldown 判定一致', () => {
  const t0 = Date.now();
  const healthPath = (): string => process.env.OMD_SEAT_HEALTH_PATH!;
  /** 与 inCooldown 同读同一份盘上文件 —— 判定一致的前提是同一数据源 + 同一 now。 */
  const healthFile = (): SeatHealthFile =>
    JSON.parse(readFileSync(healthPath(), 'utf8')) as SeatHealthFile;

  test('未过期冷却 → open + 剩余时间; 已过期 → 已自愈 closed', () => {
    writeFileSync(
      healthPath(),
      JSON.stringify({
        cooldowns: [
          { key: 'allegretto:kimi-k3', until: t0 + 60_000, since: t0 - 1_000 }, // 未过期 (周期档形状)
          { key: 'deepseek:deepseek-v4-flash', until: t0 - 1_000, since: t0 - 7_200_000 }, // 已过期
        ],
      }),
    );
    const rows = assembleDoctorRows({
      seats: ['conductor', 'leaf'],
      configLayerBySeat: new Map(),
      seatHealth: healthFile(),
      usageEntries: [],
      planLedger: [],
      configState: { models: { conductor: 'allegretto:kimi-k3', leaf: 'deepseek:deepseek-v4-flash' } },
      now: t0,
    });
    const conductor = rows.find((r) => r.seatIndex === 0)!;
    expect(inCooldown('allegretto:kimi-k3', t0)).toBe(true); // 判定一致的前提
    expect(conductor.circuitState).toBe('open');
    expect(conductor.cooldownRemaining).toBe(60_000); // 剩余时间 = until - now
    const leaf = rows.find((r) => r.seatIndex === 1)!;
    expect(inCooldown('deepseek:deepseek-v4-flash', t0)).toBe(false); // 过期 = 自愈
    expect(leaf.circuitState).toBe('closed');
    expect(leaf.cooldownRemaining).toBeNull();
    expect(leaf.cooldownCause).toBeTruthy();
  });

  test('无冷却记录 → closed, 与 inCooldown=false 一致', () => {
    const rows = assembleDoctorRows({
      seats: ['conductor'],
      configLayerBySeat: new Map(),
      seatHealth: { cooldowns: [] },
      usageEntries: [],
      planLedger: [],
      configState: { models: { conductor: 'allegretto:kimi-k3' } },
      now: t0,
    });
    const conductor = rows.find((r) => r.seatIndex === 0)!;
    expect(inCooldown('allegretto:kimi-k3', t0)).toBe(false);
    expect(conductor.circuitState).toBe('closed');
    expect(conductor.cooldownRemaining).toBeNull();
    expect(conductor.cooldownCause).toBeTruthy();
  });
});

describe('INV-2 行覆盖 = 座位全集 + 已发现渠道', () => {
  const t0 = Date.now();

  test('六源坐标并集发现渠道; 座位行一个不少', () => {
    const rows = assembleDoctorRows({
      seats: ALL_SEAT_IDS,
      configLayerBySeat: new Map(),
      seatHealth: { cooldowns: [{ key: 'healthonly:model', until: t0 + 1_000, since: t0, httpStatus: 403 }] },
      usageEntries: [{ ts: t0 - 500, model: 'phantom:model', in: 1, out: 1 }],
      planLedger: [{ id: 'r1', coords: ['runonly:model'] }],
      configState: { models: { conductor: 'allegretto:kimi-k3' } },
      now: t0,
    });
    const seatRows = rows.filter((r) => r.seatIndex !== null);
    expect(seatRows).toHaveLength(ALL_SEAT_IDS.length); // 座位全集
    const channelRows = rows.filter((r) => r.seatIndex === null);
    expect(channelRows.map((r) => r.channelId).sort()).toEqual([
      'allegretto', // configState.models
      'healthonly', // seatHealth 键
      'phantom', // usageEntries 坐标
      'runonly', // planLedger 坐标
    ]);
    const phantom = channelRows.find((r) => r.channelId === 'phantom')!;
    expect(phantom.periodUsage).toEqual({ count: 1, tokens: 2 });
    expect(phantom.circuitState).toBe('closed');
    const healthonly = channelRows.find((r) => r.channelId === 'healthonly')!;
    expect(healthonly.circuitState).toBe('open'); // 渠道宽门: 该渠道任一 model 在冷却
  });
});

describe('G-6 反向自检: 0 填充 NULL 格必须红', () => {
  const t0 = Date.now();

  // 证伪方式 (当场验过): 实现里把「窗口内无该坐标调用」填成 {count:0,tokens:0}
  // → 本用例第一条断言当场红; 恢复 NULL + 原因列后绿。
  test('窗口有记录但非本座 → periodUsage=NULL+原因, 不是 {count:0,tokens:0}', () => {
    const rows = assembleDoctorRows({
      seats: ['conductor'],
      configLayerBySeat: new Map(),
      seatHealth: { cooldowns: [] },
      usageEntries: [{ ts: t0 - 1_000, model: 'other:model', in: 9, out: 9 }],
      planLedger: [],
      configState: { models: { conductor: 'allegretto:kimi-k3' } },
      now: t0,
    });
    const conductor = rows.find((r) => r.seatIndex === 0)!;
    expect(conductor.periodUsage).toBeNull(); // 禁 0 填充
    expect(conductor.usageCause).toBeTruthy();
  });

  // 证伪方式 (当场验过): 把窗外老记录也计入窗口 → 本用例红; 窗口边界只认 [now-windowMs, now]。
  test('窗口内账本全空 → periodUsage=NULL+原因', () => {
    const rows = assembleDoctorRows({
      seats: ['conductor'],
      configLayerBySeat: new Map(),
      seatHealth: { cooldowns: [] },
      usageEntries: [{ ts: t0 - 10 * 24 * 3600 * 1000, model: 'allegretto:kimi-k3', in: 1, out: 1 }],
      planLedger: [],
      configState: { models: { conductor: 'allegretto:kimi-k3' } },
      now: t0,
    });
    const conductor = rows.find((r) => r.seatIndex === 0)!;
    expect(conductor.periodUsage).toBeNull();
    expect(conductor.usageCause).toBeTruthy();
  });

  // 证伪方式 (当场验过): 无凭证注入时填 'ok' 或空串 → 本用例红; 只许 NULL + 原因列。
  test("无凭证注入 → credentialState=NULL+原因, 不是 'ok'", () => {
    const rows = assembleDoctorRows({
      seats: ['conductor'],
      configLayerBySeat: new Map(),
      seatHealth: { cooldowns: [] },
      usageEntries: [],
      planLedger: [],
      configState: { models: { conductor: 'allegretto:kimi-k3' } }, // 无 credentials 段
      now: t0,
    });
    const conductor = rows.find((r) => r.seatIndex === 0)!;
    expect(conductor.credentialState).toBeNull();
    expect(conductor.credentialCause).toBeTruthy();
  });
});
