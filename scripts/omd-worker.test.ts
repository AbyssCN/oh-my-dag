import { describe, expect, test } from 'bun:test';
import { swapWorker } from './omd-worker';

describe('swapWorker', () => {
  const models = {
    conductor: 'claude-code:claude-opus-5-5',
    verifier: 'openai-codex:gpt-5.6-sol',
    leaf: 'deepseek:deepseek-flash',
    judge: 'deepseek:deepseek-flash',
  };

  test('只换等于现役 worker 的座位, Opus/Sol 座不动', () => {
    const r = swapWorker(models, 'deepseek:deepseek-flash', 'minimax-cn:MiniMax-M3');
    expect(r.seats).toEqual(['leaf', 'judge']);
    expect(r.models).toEqual({
      conductor: 'claude-code:claude-opus-5-5',
      verifier: 'openai-codex:gpt-5.6-sol',
      leaf: 'minimax-cn:MiniMax-M3',
      judge: 'minimax-cn:MiniMax-M3',
    });
  });

  test('不改入参 (写入前失败时配置保持原样)', () => {
    swapWorker(models, 'deepseek:deepseek-flash', 'x:y');
    expect(models.leaf).toBe('deepseek:deepseek-flash');
  });
});
