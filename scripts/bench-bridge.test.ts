import { describe, expect, test } from 'bun:test';
import { checkAuth, handleChatCompletions, parseBridgeMap, toSingleChunkSse } from './bench-bridge';
import type { ModelRequest, ModelResponse } from '../src/model/types';

const fakeCall = (capture: ModelRequest[]) => async (req: ModelRequest): Promise<ModelResponse> => {
  capture.push(req);
  return { text: 'hi', usage: { in: 7, out: 3 } } as ModelResponse;
};

describe('bench-bridge (E1c 宿主桥)', () => {
  test('★ 白名单映射: 裸 id → coord 传给 callModel, usage 透传', async () => {
    const cap: ModelRequest[] = [];
    const r = await handleChatCompletions(
      { model: 'claude-opus-5', messages: [{ role: 'user', content: 'x' }], temperature: 0.2 },
      { call: fakeCall(cap), mapModel: (id) => (id === 'claude-opus-5' ? 'claude-code:claude-opus-5' : undefined) },
    );
    expect(r.status).toBe(200);
    expect(cap[0]!.model).toBe('claude-code:claude-opus-5');
    expect(cap[0]!.temperature).toBe(0.2);
    const j = r.json as { choices: Array<{ message: { content: string } }>; usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } };
    expect(j.choices[0]!.message.content).toBe('hi');
    expect(j.usage).toEqual({ prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 });
  });

  test('★ developer role 归一为 system (2026-08-26 根因回归钉: 丢它 = 系统面蒸发)', async () => {
    const cap: ModelRequest[] = [];
    const r = await handleChatCompletions(
      { model: 'm', messages: [{ role: 'developer', content: 'SYS-RULES' }, { role: 'user', content: 'x' }] },
      { call: fakeCall(cap), mapModel: () => 'a:b' },
    );
    expect(r.status).toBe(200);
    expect(cap[0]!.messages.length).toBe(2);
    expect(cap[0]!.messages[0]!.role).toBe('system');
    expect(String(cap[0]!.messages[0]!.content)).toBe('SYS-RULES');
  });

  test('★ 不在白名单 → 404 (不透传任意 coord)', async () => {
    const r = await handleChatCompletions(
      { model: 'evil:coord', messages: [{ role: 'user', content: 'x' }] },
      { call: fakeCall([]), mapModel: () => undefined },
    );
    expect(r.status).toBe(404);
  });

  test('缺 model / 缺 messages → 400', async () => {
    const deps = { call: fakeCall([]), mapModel: () => 'a:b' };
    expect((await handleChatCompletions({ messages: [{ role: 'user', content: 'x' }] }, deps)).status).toBe(400);
    expect((await handleChatCompletions({ model: 'm' }, deps)).status).toBe(400);
  });

  test('上游抛错 → 502 且错误原文在 (吞异常不许吞证据)', async () => {
    const r = await handleChatCompletions(
      { model: 'm', messages: [{ role: 'user', content: 'x' }] },
      { call: async () => { throw new Error('channel down'); }, mapModel: () => 'a:b' },
    );
    expect(r.status).toBe(502);
    expect(JSON.stringify(r.json)).toContain('channel down');
  });

  test('parseBridgeMap: 逗号表解析, coord 内冒号保留', () => {
    const m = parseBridgeMap('a=x:y,b=p:q:r, c = s:t ');
    expect(m.get('a')).toBe('x:y');
    expect(m.get('b')).toBe('p:q:r');
    expect(m.get('c')).toBe('s:t');
  });

  test('checkAuth: 恰等 Bearer 才过', () => {
    expect(checkAuth('Bearer tok', 'tok')).toBe(true);
    expect(checkAuth('Bearer wrong', 'tok')).toBe(false);
    expect(checkAuth(null, 'tok')).toBe(false);
  });

  test('SSE 单块包装含内容与 [DONE]', () => {
    const s = toSingleChunkSse({ id: 'i', model: 'm', choices: [{ message: { content: 'body' } }] });
    expect(s).toContain('"content":"body"');
    expect(s.trim().endsWith('data: [DONE]')).toBe(true);
  });
});
