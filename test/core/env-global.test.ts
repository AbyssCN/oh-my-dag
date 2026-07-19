import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadGlobalEnv, applyEnvAliases } from '../../src/env-alias';

// 全局配置兜底 (~/.omd/env): 只填未设置的 key, cwd/.env 与显式 env 永远赢; fail-open。

describe('loadGlobalEnv', () => {
  function tmpEnvFile(content: string): string {
    const p = join(mkdtempSync(join(tmpdir(), 'omd-genv-')), 'env');
    writeFileSync(p, content);
    return p;
  }

  test('只填未设置的 key; 已设置的不覆盖; 注释/空行/坏行忽略', () => {
    const p = tmpEnvFile(['# comment', '', 'OMD_RUNTIME_PROVIDER=deepseek', 'DEEPSEEK_API_KEY=global-key', 'not a kv line'].join('\n'));
    const env: Record<string, string | undefined> = { DEEPSEEK_API_KEY: 'local-wins' };
    loadGlobalEnv(p, env);
    expect(env.OMD_RUNTIME_PROVIDER).toBe('deepseek'); // 未设置 → 填入
    expect(env.DEEPSEEK_API_KEY).toBe('local-wins'); // 已设置 → 全局不覆盖
  });

  test('缺文件 fail-open 不抛', () => {
    const env: Record<string, string | undefined> = {};
    expect(() => loadGlobalEnv('/nonexistent/omd/env', env)).not.toThrow();
    expect(Object.keys(env)).toEqual([]);
  });

  test('与 XIHE 别名桥叠加: 全局填 XIHE_* → 别名复制到 OMD_*', () => {
    const p = tmpEnvFile('XIHE_RUNTIME_PROVIDER=mimo\n');
    const env: Record<string, string | undefined> = {};
    loadGlobalEnv(p, env);
    applyEnvAliases(env);
    expect(env.OMD_RUNTIME_PROVIDER).toBe('mimo');
  });
});
