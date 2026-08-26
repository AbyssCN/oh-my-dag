/**
 * agent-leaf 模型解析必须与 callModel 同两级序:自有 registry 先、pi 目录后。
 *
 * 缺陷现场 (2026-08-26, bench 四批 patch 全 0 的终局根因): agent-leaf 只查 pi 目录,
 * models.json / registerProvider 注册的自定 provider (如 bench) 在 leaf 通道上恒
 * 解析失败 → 所有写文件节点 infra-error 零产出。callModel 链 (src/model/index.ts:129)
 * 一直有 registry 兜底, leaf 链没有 —— 同一坐标两条路一通一断。
 *
 * 反向自检: 把 resolveLeafModel 的 registry 分支删掉 → 前两条用例当场红。
 */
import { describe, expect, test } from 'bun:test';
import { registerProvider } from '../model/providers';
import { resolveLeafModel } from './agent-leaf';

describe('agent-leaf 自定 provider 解析 (registry 兜底)', () => {
  test('registerProvider 注册的 provider 在 leaf 链上可解析, 且带 registry 的端点与凭证', () => {
    registerProvider('bench-test-leaf', {
      baseUrl: 'http://127.0.0.1:59999/v1',
      apiKey: 'test-key-abc',
      api: 'openai-compatible',
    });
    const r = resolveLeafModel('bench-test-leaf', 'some-model');
    expect(r).toBeTruthy();
    expect(r!.piModel.id).toBe('some-model');
    // registry 的 baseUrl 必须生效 (端点意图不许被目录覆盖, 同 piModelFromProviderConfig 契约)
    expect(String(r!.piModel.baseUrl)).toContain('127.0.0.1:59999');
    expect(r!.apiKey).toBe('test-key-abc');
  });

  test('registry 与目录都不认识的 provider → undefined (拒因由调用方抛)', () => {
    const r = resolveLeafModel('no-such-provider-xyz', 'whatever');
    expect(r).toBeUndefined();
  });

  test('目录内置 provider 不受影响 (registry miss → 落目录, 存量语义)', () => {
    // openai 是 pi-ai 目录常驻 provider; 未注册进自有 registry 时应仍可解析。
    const r = resolveLeafModel('openai', 'gpt-4o-mini');
    expect(r).toBeTruthy();
    expect(r!.piModel.id).toBe('gpt-4o-mini');
    // 目录路径不带 registry 凭证 (凭证走 resolvePiApiKey 既有链)
    expect(r!.apiKey).toBeUndefined();
  });
});
