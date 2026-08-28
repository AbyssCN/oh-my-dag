/**
 * dream 点火判定。这是**第一个**读 `gather.ts` 那三个阈值常量的东西 ——
 * 在此之前它们定义了、导出了、零读取方(一个描述性的"打算"而不是一条闸)。
 *
 * 反向自检(实跑):
 *  - 把 `OMD_DREAM_AUTO !== '1'` 那条去掉 ⇒ 「默认关」当场红;
 *  - 把冷却基准从 attempt 换回"上次成功" ⇒ 「失败之后也要冷却」当场红;
 *  - 把 `dirtySources < W_SESSIONS` 那条去掉 ⇒ 「一个源不烧一批」当场红。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { M, W_HOURS, W_SESSIONS } from './gather';
import {
  STALE_LOCK_MS,
  acquireDreamLock,
  decideDreamTrigger,
  readDreamAttempt,
  releaseDreamLock,
  writeDreamAttempt,
} from './trigger';

const ON = { OMD_DREAM_AUTO: '1' } as NodeJS.ProcessEnv;
const NOW = 1_800_000_000_000;
const base = {
  dirtyTotal: M + 100,
  dirtySources: W_SESSIONS + 10,
  attempt: null,
  nowMs: NOW,
  env: ON,
  isSdkChild: false,
};

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'omd-dream-trigger-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('点火判定 — 三条护栏', () => {
  test('★ 默认关 —— 不设 OMD_DREAM_AUTO=1 一律不点火(它要花钱)', () => {
    const r = decideDreamTrigger({ ...base, env: {} as NodeJS.ProcessEnv });
    expect(r.fire).toBe(false);
    expect(r.why).toContain('OMD_DREAM_AUTO');
    // 显式设成 0 也一样(只有 '1' 算开)
    expect(decideDreamTrigger({ ...base, env: { OMD_DREAM_AUTO: '0' } as NodeJS.ProcessEnv }).fire).toBe(false);
  });

  test('★ 自喂闸 —— SDK 子会话不点火(2026-08-20 那场 fork bomb 的同一个判别位)', () => {
    const r = decideDreamTrigger({ ...base, isSdkChild: true });
    expect(r.fire).toBe(false);
    expect(r.why).toContain('自喂闸');
  });

  test('开关开 + 水位够 + 从没跑过 → 点火', () => {
    const r = decideDreamTrigger(base);
    expect(r.fire).toBe(true);
    if (r.fire) expect(r.batch).toBeGreaterThan(0);
  });
});

describe('点火判定 — 水位', () => {
  test(`脏条目 < M(${M}) → 不点火`, () => {
    const r = decideDreamTrigger({ ...base, dirtyTotal: M - 1 });
    expect(r.fire).toBe(false);
    expect(r.why).toContain(`M=${M}`);
  });

  test(`★ 脏源 < W_SESSIONS(${W_SESSIONS}) → 不点火(别为一个源就烧一批)`, () => {
    const r = decideDreamTrigger({ ...base, dirtySources: 1 });
    expect(r.fire).toBe(false);
    expect(r.why).toContain(`W_SESSIONS=${W_SESSIONS}`);
  });

  test('★ W_SESSIONS 读作"源数"而不是"会话数" —— 纯 run 的仓也要点得着', () => {
    // 实测本仓 gather 报 303 个脏源, **全部是 run, 零 session**。
    // 按字面取"会话数"的话这条闸在只跑 DAG 的仓里永远不成立 → dream 一次都不点火。
    expect(decideDreamTrigger({ ...base, dirtySources: W_SESSIONS }).fire).toBe(true);
  });
});

describe('点火判定 — 冷却记在「尝试」不是「成功」', () => {
  test(`距上次尝试 < W_HOURS(${W_HOURS}h) → 不点火`, () => {
    const r = decideDreamTrigger({
      ...base,
      attempt: { lastAttemptAt: NOW - 1 * 3_600_000, lastOutcome: 'ok' },
    });
    expect(r.fire).toBe(false);
    expect(r.why).toContain(`W_HOURS=${W_HOURS}`);
  });

  test('★ 上次**失败**了也照样冷却 —— 否则每次 Stop 都烧一批且每次都失败', () => {
    const r = decideDreamTrigger({
      ...base,
      attempt: { lastAttemptAt: NOW - 1 * 3_600_000, lastOutcome: 'failed' },
    });
    expect(r.fire).toBe(false);
  });

  test('★ 结局未知(进程中途被杀)也照样冷却 —— null 不许当"没跑过"', () => {
    const r = decideDreamTrigger({
      ...base,
      attempt: { lastAttemptAt: NOW - 1 * 3_600_000, lastOutcome: null },
    });
    expect(r.fire).toBe(false);
  });

  test(`过了 W_HOURS → 重新点得着`, () => {
    const r = decideDreamTrigger({
      ...base,
      attempt: { lastAttemptAt: NOW - (W_HOURS + 1) * 3_600_000, lastOutcome: 'failed' },
    });
    expect(r.fire).toBe(true);
  });
});

describe('尝试记录的读写', () => {
  test('没有文件 → null(= 从没跑过, 冷却不成立)', () => {
    expect(readDreamAttempt(join(root, 'nope.json'))).toBeNull();
  });

  test('坏 JSON / 形状不对 → null(读不动 ≠ 刚跑过, 方向是"允许再跑"那边)', () => {
    const p = join(root, 'bad.json');
    writeFileSync(p, '{ 不是 json');
    expect(readDreamAttempt(p)).toBeNull();
    writeFileSync(p, '{"lastAttemptAt": "不是数字"}');
    expect(readDreamAttempt(p)).toBeNull();
  });

  test('往返;未知结局回读仍是 null(不许被塞成 failed)', () => {
    const p = join(root, 'a', 'attempt.json'); // 目录不存在 → 写入侧要自己建
    expect(writeDreamAttempt(p, { lastAttemptAt: NOW, lastOutcome: null })).toBe(true);
    expect(readDreamAttempt(p)).toEqual({ lastAttemptAt: NOW, lastOutcome: null });

    writeDreamAttempt(p, { lastAttemptAt: NOW, lastOutcome: 'ok' });
    expect(readDreamAttempt(p)!.lastOutcome).toBe('ok');
  });

  test('写不出去 → false(不抛 —— 点火链全程 fail-open)', () => {
    expect(writeDreamAttempt('/proc/nope/attempt.json', { lastAttemptAt: 1, lastOutcome: 'ok' })).toBe(false);
  });
});

// ─── 互斥锁(2026-08-28 实测撞过之后补的)──────────────────────────────────

/**
 * 现场:开关打开后第一次 Stop,hook 派的批与手起的 drain **同时**对着一个 memory.db 跑
 * (hook 侧 gather 报 126 个脏源,同一时刻 drain 已推到 114)。不是数据损坏(WAL 挡得住),
 * 是同一批语料被抽两遍 + 水位互相覆盖。
 *
 * 反向自检:把 `writeFileSync(..., {flag:'wx'})` 的 `wx` 去掉 ⇒ 「第二个拿不到」当场红。
 */
describe('互斥锁', () => {
  test('★ 第一个拿得到, 第二个拿不到', () => {
    const p = join(root, 'dream.lock');
    expect(acquireDreamLock(p, NOW)).toBe(true);
    expect(acquireDreamLock(p, NOW)).toBe(false);
  });

  test('放了之后又拿得到(幂等:放两次不抛)', () => {
    const p = join(root, 'dream.lock');
    acquireDreamLock(p, NOW);
    releaseDreamLock(p);
    releaseDreamLock(p);
    expect(acquireDreamLock(p, NOW)).toBe(true);
  });

  test('★ 陈锁会过期 —— 否则一次崩溃就静默关掉自动固化', () => {
    const p = join(root, 'dream.lock');
    expect(acquireDreamLock(p, NOW)).toBe(true);
    expect(acquireDreamLock(p, NOW + STALE_LOCK_MS - 1)).toBe(false); // 还没过期
    expect(acquireDreamLock(p, NOW + STALE_LOCK_MS + 1)).toBe(true); // 过期了, 接管
  });

  test('锁文件坏了 → 拿不到(方向取安全那边:宁可少固化, 不可两个进程对着烧)', () => {
    const p = join(root, 'dream.lock');
    writeFileSync(p, '{ 不是 json');
    expect(acquireDreamLock(p, NOW)).toBe(false);
  });

  test('目录不存在时自己建(hook 在空仓里第一次点火就是这个场景)', () => {
    expect(acquireDreamLock(join(root, 'deep', 'nested', 'dream.lock'), NOW)).toBe(true);
  });
});
