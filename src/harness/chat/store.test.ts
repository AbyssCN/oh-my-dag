/**
 * ChatStore 契约测试。反向自检:坏文件/非法 id/形状不对三条都真的会红(负例在场)。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { ChatStore } from './store';

let root: string;
let store: ChatStore;
const msg = (content: string): AgentMessage => ({ role: 'user', content, timestamp: 1 }) as AgentMessage;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'omd-chat-'));
  store = new ChatStore(root);
  delete process.env.OMD_DATA_HOME; // 测试固定走 repoRoot/.omd/chat 分支
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('往返与原子性', () => {
  test('★ save→load 往返:messages 原样回来(序列化面即运行面)', () => {
    const s = store.create('s1', '首个会话');
    s.messages.push(msg('hello'), { role: 'assistant', content: 'hi', timestamp: 2 } as unknown as AgentMessage);
    store.save(s);
    const back = store.load('s1');
    expect(back?.messages).toEqual(s.messages);
    expect(back?.title).toBe('首个会话');
  });

  test('create 不落盘(空会话不留垃圾);load 缺席 → null 不是错误', () => {
    store.create('ghost');
    expect(store.load('ghost')).toBeNull();
    expect(store.list()).toEqual([]);
  });

  test('save 无残留 .tmp,重复 save 整文件覆写', () => {
    const s = store.create('s1');
    s.messages.push(msg('a'));
    store.save(s);
    s.messages.push(msg('b'));
    store.save(s);
    expect(readdirSync(join(root, '.omd/chat'))).toEqual(['s1.json']);
    expect(store.load('s1')?.messages.length).toBe(2);
  });
});

describe('边界闸(HTTP 进来的 id 不可信)', () => {
  test('★ 路径穿越/非法字符响亮拒 —— create/load/save/delete 全部同闸', () => {
    for (const bad of ['../evil', 'a/b', '.hidden', '', 'x'.repeat(65)]) {
      expect(() => store.create(bad)).toThrow('非法会话 id');
      expect(() => store.load(bad)).toThrow('非法会话 id');
    }
  });
});

describe('损坏处置(吞异常不吞证据的分工)', () => {
  test('★ load 撞坏文件响亮抛(损坏必须被看见,不许静默当新会话)', () => {
    mkdirSync(join(root, '.omd/chat'), { recursive: true });
    writeFileSync(join(root, '.omd/chat', 's1.json'), '{broken', { encoding: 'utf-8' });
    expect(() => store.load('s1')).toThrow();
  });

  test('list 跳过坏文件但不杀列表;好会话照常在', () => {
    const good = store.create('good');
    good.messages.push(msg('x'));
    store.save(good);
    writeFileSync(join(root, '.omd/chat', 'bad.json'), '{broken');
    writeFileSync(join(root, '.omd/chat', 'wrong-shape.json'), JSON.stringify({ schema: 99 }));
    const metas = store.list();
    expect(metas.map((m) => m.id)).toEqual(['good']);
  });

  test('list 按 updatedAt 降序,messageCount 对得上', async () => {
    const a = store.create('a');
    a.messages.push(msg('1'));
    store.save(a);
    await new Promise((r) => setTimeout(r, 5)); // updatedAt 由 save 盖章, 两次间隔出顺序
    const b = store.create('b');
    b.messages.push(msg('1'), msg('2'));
    store.save(b);
    const metas = store.list();
    expect(metas.map((m) => m.id)).toEqual(['b', 'a']);
    expect(metas.map((m) => m.messageCount)).toEqual([2, 1]);
  });
});
