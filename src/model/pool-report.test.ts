/**
 * 池读数板的闸(2026-08-05)。
 *
 * ## 这份网真正钉的那一条
 *
 * 读数板与执行期**各写一份解析序**,迟早会出现「读数说用 A、实际跑 B」——
 * 而那比没有读数板更坏:你会以为看过了。所以下面每一条都是拿**同一个 env/config**
 * 同时问读数板和执行期的解析器,断言两边说的是同一件事。
 *
 * 背景:owner 一天内连撞三处坐标漂移(判优池里的 429 死座位 · 溢出兜底拿 mimo 跑文本 ·
 * review verify 层指着欠费座位),每一处都得 grep 全仓才翻得出来。这块读数板就是为此加的。
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reportPools, renderPoolReport } from './pool-report';
import { POOL_DEFAULTS } from './pool-defaults';
import { POOL_TIERS, poolEnvKey, resetConfigCache, resolveConfiguredPools } from './role-models';

/** 造一个临时 config,并把 OMD_CONFIG_PATH 指过去(确定性发现:显式即权威)。 */
function withConfig<T>(pools: Record<string, unknown>, fn: (env: Record<string, string | undefined>) => T): T {
  const root = mkdtempSync(join(tmpdir(), 'omd-poolreport-'));
  const path = join(root, 'config.json');
  writeFileSync(path, JSON.stringify({ version: 2, pools }), 'utf8');
  const prev = process.env.OMD_CONFIG_PATH;
  process.env.OMD_CONFIG_PATH = path;
  resetConfigCache();
  try {
    return fn({ ...process.env });
  } finally {
    if (prev === undefined) delete process.env.OMD_CONFIG_PATH;
    else process.env.OMD_CONFIG_PATH = prev;
    resetConfigCache();
    rmSync(root, { recursive: true, force: true });
  }
}

const rowOf = (env: Record<string, string | undefined>, tier: string) =>
  reportPools(env).find((r) => r.tier === tier)!;

describe('读数板与执行期解析同一件事', () => {
  test('★ 每一档: 读数板报的坐标 = 执行期解析器给的坐标', () => {
    withConfig({ judge: ['opencode-go:glm-5.2'], fallbackWorker: ['deepseek:deepseek-v4-flash'] }, (env) => {
      const resolved = resolveConfiguredPools(undefined, env);
      for (const row of reportPools(env)) {
        if (row.source === 'env' || row.source === 'config') {
          // 配过的档: 必须与执行期逐字相同
          expect(row.coords, row.tier).toEqual(resolved[row.tier]!);
        } else {
          // 没配过的档: 执行期看不到它 (由源码默认 / 座位推导接手)
          expect(resolved[row.tier], row.tier).toBeUndefined();
        }
      }
    });
  });

  test('★ 三层解析序与执行期一致: env 压过 config, config 压过源码默认', () => {
    withConfig({ judge: ['opencode-go:glm-5.2'] }, (env) => {
      // ① 只有 config → 报 config
      expect(rowOf(env, 'judge').source).toBe('config');
      expect(rowOf(env, 'judge').coords).toEqual(['opencode-go:glm-5.2']);
      // ② env 压上来 → 报 env, 且与执行期同值
      const withEnv = { ...env, [poolEnvKey('judge')]: 'opencode-go:qwen3.8-max' };
      expect(rowOf(withEnv, 'judge').source).toBe('env');
      expect(rowOf(withEnv, 'judge').coords).toEqual(resolveConfiguredPools(undefined, withEnv).judge!);
      // ③ 两层都没有 → 落源码默认 (lens 这一档本次没配)
      expect(rowOf(env, 'lens').source).toBe('default');
      expect(rowOf(env, 'lens').coords).toEqual([...(POOL_DEFAULTS.lens ?? [])]);
    });
  });

  test('★ 没有静态默认的档报 `derived`, **不许编一个假默认**', () => {
    // strong/mid/cheap 未配时由座位推导。在这里编一份默认, 读数板就会报一个根本没生效的值 ——
    // 那比不报更坏 (它看起来像个答案)。
    withConfig({}, (env) => {
      for (const tier of ['strong', 'mid', 'cheap']) {
        const row = rowOf(env, tier);
        expect(row.source, tier).toBe('derived');
        expect(row.coords, tier).toEqual([]);
        expect(row.note, tier).toBeTruthy(); // 必须说得出"那它由什么决定"
      }
    });
  });

  test('每一档都报得出「想改去改哪儿」(读数板的用处一半在这句话上)', () => {
    withConfig({}, (env) => {
      for (const row of reportPools(env)) {
        expect(row.overrideWith, row.tier).toContain(poolEnvKey(row.tier));
        expect(row.overrideWith, row.tier).toContain(`config.pools.${row.tier}`);
      }
    });
  });

  test('覆盖全部 POOL_TIERS —— 加了池却漏进读数板 = 又一处看不见的漂移', () => {
    withConfig({}, (env) => {
      expect(reportPools(env).map((r) => r.tier)).toEqual([...POOL_TIERS]);
    });
  });
});

describe('渲染', () => {
  test('列出坐标, 并标出没凭证的那些', () => {
    withConfig({ judge: ['opencode-go:glm-5.2', 'ghost:nope'] }, (env) => {
      const text = renderPoolReport(reportPools(env), (c) => (c.startsWith('ghost') ? `${c} ✗无凭证` : c)).join('\n');
      expect(text).toContain('opencode-go:glm-5.2');
      expect(text).toContain('ghost:nope ✗无凭证');
      expect(text).toContain('[config]');
    });
  });

  test('`derived` 档渲染成"由什么决定 + 想固定住改哪儿", 不是一行空坐标', () => {
    withConfig({}, (env) => {
      const line = renderPoolReport([rowOf(env, 'strong')], (c) => c)[0]!;
      expect(line).toContain('座位推导');
      expect(line).toContain('OMD_POOL_STRONG');
    });
  });
});
