/**
 * D1 ext 事件词表 v2 判据:
 *  ① observe 崩溃不扰动: 崩的 handler 之后, 子进程仍活、后续事件照常送达、宿主零抛错。
 *  ② gate 超时走声明默认: before_agent_start 挂死 → 放行原串 (不 reject 不拖死调用方)。
 *  ③ 前缀零字节 (构造保证的行为面): observe notify 不消费回复 —— 订阅了也改不了任何宿主状态;
 *    未订阅的事件连帧都不发 (IPC 有序性证明)。
 *  ④ 体检: 词表外事件加载期被拒并点名; 新词表六员照常通过 (反向)。
 *  ⑤ 引擎桥: DagNodeEvent → ext observe 映射真通; 无扩展 cwd 上零开销零抛错。
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extNodeEventSink, loadExtTools, stopExtTools } from '../../harness/ext-tools';
import { loadExtension, type LoadedExtension } from './host';
import { EVENT_MODES, SUPPORTED_EVENTS } from './protocol';

const FIXTURES = join(import.meta.dir, '__fixtures__');
const NO_BWRAP = { which: () => null } as const;

let dirs: string[] = [];
let exts: LoadedExtension[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'omd-extv2-'));
  dirs.push(d);
  return d;
}
async function until(cond: () => boolean, ms = 3000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return cond();
}
afterEach(() => {
  for (const e of exts) e.stop();
  exts = [];
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe('D1 · 词表与语义声明', () => {
  test('词表绊线: 6 员, 每员有声明语义 (Record 全覆盖是编译期事实)', () => {
    expect([...SUPPORTED_EVENTS].map(String).sort()).toEqual(
      ['after_node', 'after_plan', 'before_agent_start', 'before_node', 'on_escalation', 'on_verdict'].sort(),
    );
    expect(EVENT_MODES.before_agent_start).toBe('gate');
    for (const e of SUPPORTED_EVENTS) {
      if (e !== 'before_agent_start') expect(EVENT_MODES[e]).toBe('observe');
    }
  });

  test('④ 体检: 词表外事件加载期被拒并点名; 新词表事件照常通过', async () => {
    const cwd = tmp();
    const bad = await loadExtension('bad', join(FIXTURES, 'bad-event.mjs'), { cwd, ...NO_BWRAP });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.rejected.missing).toContain('on:zzz_unknown_event');
    const good = await loadExtension('observer', join(FIXTURES, 'observer.mjs'), { cwd, ...NO_BWRAP });
    expect(good.ok).toBe(true);
    if (good.ok) exts.push(good.ext);
  });
});

describe('D1 · observe 语义', () => {
  test('①③ 崩溃不扰动 + 未订阅不发帧 (IPC 有序性证明)', async () => {
    const cwd = tmp();
    const r = await loadExtension('observer', join(FIXTURES, 'observer.mjs'), { cwd, ...NO_BWRAP, timeoutMs: 3000 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    exts.push(r.ext);
    // 崩的 handler (on_verdict throws) —— notify 不抛
    expect(() => r.ext.notify('on_verdict', { round: 1 })).not.toThrow();
    // 未订阅的事件 (on_escalation) —— 宿主按订阅清单不发帧
    r.ext.notify('on_escalation', { parent: 'x' });
    // 之后的已订阅事件照常送达 (IPC 有序 ⇒ 到这一帧被处理时, 前两帧若存在也已处理完)
    r.ext.notify('after_node', { type: 'settle', id: 'n1', status: 'done' });
    expect(await until(() => existsSync(join(cwd, 'observed-after_node.json')))).toBe(true);
    const seen = JSON.parse(readFileSync(join(cwd, 'observed-after_node.json'), 'utf8'));
    expect(seen.id).toBe('n1');
    // 未订阅事件确实没到过子进程 (没有它的落盘物; 且崩溃后子进程仍活着刚送达了 after_node)
    expect(existsSync(join(cwd, 'observed-on_escalation.json'))).toBe(false);
  });

  test('② gate 超时走声明默认: 挂死的 before_agent_start → 放行原串', async () => {
    const cwd = tmp();
    const r = await loadExtension('slow', join(FIXTURES, 'slow-gate.mjs'), { cwd, ...NO_BWRAP, timeoutMs: 300 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    exts.push(r.ext);
    const original = '原始 system prompt';
    const out = await r.ext.beforeAgentStart(original);
    expect(out).toBe(original);
  });
});

describe('D1 · 引擎桥 (extNodeEventSink)', () => {
  test('⑤ DagNodeEvent → observe 映射真通; 无扩展 cwd 零抛错', async () => {
    const empty = tmp();
    const sink0 = extNodeEventSink(empty);
    expect(() => sink0({ type: 'start', id: 'x', kind: 'inproc' })).not.toThrow();

    const cwd = tmp();
    mkdirSync(join(cwd, '.omd'), { recursive: true });
    writeFileSync(
      join(cwd, '.omd', 'extensions.json'),
      JSON.stringify({ extensions: [{ name: 'observer', entry: join(FIXTURES, 'observer.mjs') }] }),
    );
    try {
      const tools = await loadExtTools(cwd, { ...NO_BWRAP, timeoutMs: 3000 });
      expect(tools).toEqual([]); // observer 不注册工具 —— 工具面零变化
      const sink = extNodeEventSink(cwd);
      // settle → after_node (映射表), 载荷 = DagNodeEvent 原样
      sink({ type: 'settle', id: 'node-9', status: 'done', kind: 'agent' });
      expect(await until(() => existsSync(join(cwd, 'observed-after_node.json')))).toBe(true);
      const seen = JSON.parse(readFileSync(join(cwd, 'observed-after_node.json'), 'utf8'));
      expect(seen).toMatchObject({ type: 'settle', id: 'node-9', status: 'done' });
      // 不在映射表的事件 (progress) 不通知 —— 桥的词表是显式的
      sink({ type: 'progress', id: 'node-9', calls: 1, elapsedMs: 5 });
    } finally {
      stopExtTools(cwd);
    }
  });
});
