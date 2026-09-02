/**
 * dotenv-isolation 的会红闸。
 *
 * 反向自检 (做过一次, 2026-09-03):
 *  · 从 bunfig.toml 的 preload 里删掉 dotenv-isolation → ★① 红 (这台机 `.env` 有 21 个键, 全部仍在 process.env)
 *  · 没有 `.env` 的机器: ★① 是空判 (STRIPPED 为空且 .env 不存在), ★② / ★③ 纯函数兜底
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
// ⚠ 只 import 纯函数半。import `./dotenv-isolation` 的副作用会替 preload 删键, ★① 就永远绿
// (2026-09-03 第一版就是这么被自己骗过的: 删掉 preload 行照样 3 pass)。
import { STRIPPED_MARKER, dotenvKeyNames, stripKeys } from './dotenv-keys';

describe('仓根 .env 不许灌进测试进程', () => {
  test('★① preload 接线还在: 标记在场, 且 .env 里的每个键在 process.env 里都不在了', () => {
    // 标记由 preload 写; preload 没跑 → 标记缺席 → 红。这一条不依赖这台机有没有 .env。
    expect(process.env[STRIPPED_MARKER]).toBeDefined();
    const p = join(process.cwd(), '.env');
    const stripped = (process.env[STRIPPED_MARKER] ?? '').split(',').filter(Boolean);
    if (!existsSync(p) || process.env.OMD_TEST_KEEP_DOTENV === '1') {
      // 这台机没有 .env (或显式保留): 只确认没乱删。
      expect(stripped).toEqual([]);
      return;
    }
    const names = dotenvKeyNames(readFileSync(p, 'utf8'));
    expect(names.length).toBeGreaterThan(0);
    for (const k of names) expect(process.env[k]).toBeUndefined();
    // 删掉的 ⊆ 声明的 (不许越界删别的)
    for (const k of stripped) expect(names).toContain(k);
  });

  test('★② dotenvKeyNames: 认 KEY= / export KEY= / 引号值; 跳注释、空行、畸形行; 保序去重', () => {
    const text = [
      '# comment',
      '',
      'A=1',
      'export B="two"',
      "C='3' # trailing",
      'not a kv line',
      '  D = spaced',
      'A=dup',
      '1BAD=x',
    ].join('\n');
    expect(dotenvKeyNames(text)).toEqual(['A', 'B', 'C', 'D']);
  });

  test('★③ stripKeys 只删在场的, 返回真删掉的 (原本不在的不算)', () => {
    const env: Record<string, string | undefined> = { X: '1', Y: '2' };
    expect(stripKeys(env, ['X', 'Z'])).toEqual(['X']);
    expect(env).toEqual({ Y: '2' });
  });
});
