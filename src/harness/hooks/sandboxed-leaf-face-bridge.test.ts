/**
 * P3 S6b × D-9 (2026-09-04): 隔离档 (bwrap) 下 conductor 的七张派工卡必须过桥。
 *
 * 实账 run 4795bed7 (solve · branch 档): conductor 71 次工具调用, work / spawn / explore / best_of 全部
 * `prepared.tool.execute is not a function`, 派发 0 次; 同图 head 档 (不进 jail) 正常。根因: `input.face.customTools`
 * 随 payload 过 JSON 边界丢掉 execute, worker 只重水化 opts.customTools, 不重水化 face。
 *
 * 证伪方式 (当场验过): 把 leaf-worker.ts 里 `faceDecls.map(rehydrate)` 那一支删掉 → ① 红 (execute 不是函数);
 * 把 sandboxed-leaf.ts `bridgeToolsForCall` 的 face 循环删掉 → ③ 红。
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AnyOmdTool } from '../agent-tools';
import { bridgeToolsForCall, leafWorkerPayload } from './sandboxed-leaf';
import type { AgentLeafInput } from '../leaf-runners';
import { runLeafWorkerPayload } from '../leaf-worker';

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function card(name: string): AnyOmdTool {
  return {
    name,
    label: name,
    description: `${name} card`,
    parameters: { type: 'object', properties: {} } as never,
    executionMode: 'sequential',
    async execute() {
      return { content: [{ type: 'text', text: 'parent-side' }], details: { ok: true } };
    },
  } as unknown as AnyOmdTool;
}

describe('隔离叶 × conductor face 卡 (D-9 桥)', () => {
  test('① face.customTools 过 JSON 后在 worker 侧重水化成桥代理: 调用落 req 文件, 父侧回 res 即返回', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'omd-face-bridge-'));
    roots.push(dir);
    const prefix = join(dir, '.omd-leaf-tool-t');
    const input: AgentLeafInput = {
      prompt: 'p',
      model: 'x:y',
      face: { toolNames: ['read'], customTools: [card('work')], systemPrompt: 'S', readOnlyShell: true },
    };
    const decoded = JSON.parse(JSON.stringify(leafWorkerPayload({}, input, prefix))) as ReturnType<typeof leafWorkerPayload>;
    // JSON 边界确实剥掉了 execute —— 这是被修的那个事实, 先钉住。
    expect(typeof (decoded.input.face!.customTools![0] as { execute?: unknown }).execute).toBe('undefined');
    let seen: AgentLeafInput | undefined;
    await runLeafWorkerPayload(decoded, {
      createRunner: () => async (actual) => {
        seen = actual;
        return { text: 'ok', usage: { in: 1, out: 1 } };
      },
    });
    const work = seen!.face!.customTools![0]!;
    expect(typeof work.execute).toBe('function');
    expect(seen!.face!.readOnlyShell).toBe(true); // 布尔面过线不丢
    // 扮演父侧: 等 req 文件出现, 写 res。
    const pending = work.execute('id1', { goal: 'g' });
    const reqFile = `${prefix}-req-1.json`;
    for (let i = 0; i < 200 && !readdirSync(dir).includes('.omd-leaf-tool-t-req-1.json'); i++) await new Promise((r) => setTimeout(r, 10));
    const req = JSON.parse(readFileSync(reqFile, 'utf8')) as { name: string; params: unknown };
    expect(req.name).toBe('work');
    expect(req.params).toEqual({ goal: 'g' });
    writeFileSync(`${prefix}-res-1.json.tmp`, JSON.stringify({ ok: true, result: { content: [{ type: 'text', text: 'bridged' }] } }));
    renameSync(`${prefix}-res-1.json.tmp`, `${prefix}-res-1.json`);
    const out = (await pending) as { content: { text: string }[] };
    expect(out.content[0]!.text).toBe('bridged');
  });

  test('② 有 face 卡但 payload 无 toolBridge → 响亮拒, 不以假工具起叶', async () => {
    const input: AgentLeafInput = { prompt: 'p', model: 'x:y', face: { toolNames: [], customTools: [card('work')], systemPrompt: 'S' } };
    const decoded = JSON.parse(JSON.stringify(leafWorkerPayload({}, input))) as ReturnType<typeof leafWorkerPayload>;
    await expect(runLeafWorkerPayload(decoded, { createRunner: () => async () => ({ text: 'ok', usage: { in: 1, out: 1 } }) })).rejects.toThrow(/face 卡/);
  });

  test('③ 父侧桥工具 = 构造期 sandboxSafe 工具 ∪ 本次 face 卡, 同名 face 胜; 无 face 时逐字节等于构造期那份', () => {
    const base = new Map<string, AnyOmdTool>([['ext', card('ext')], ['work', card('work-from-opts')]]);
    const faceWork = card('work');
    const withFace = bridgeToolsForCall(base, { prompt: 'p', model: 'x:y', face: { toolNames: [], customTools: [faceWork], systemPrompt: 'S' } });
    expect([...withFace.keys()].sort()).toEqual(['ext', 'work']);
    expect(withFace.get('work')).toBe(faceWork);
    const noFace = bridgeToolsForCall(base, { prompt: 'p', model: 'x:y' });
    expect([...noFace.entries()]).toEqual([...base.entries()]);
  });
});
