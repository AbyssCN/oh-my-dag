/**
 * src/harness/agent-media-injection.test.ts —— D2 切片 2: attach_media 在 agent 节点
 * 不再被静默扔图 (D-3) 的契约钉死 (2026-08-25, D2 视觉通道)。
 *
 * **反向自检 / 证伪方式**:
 *  - GWT-4: 把 `engine.ts:3655` 改回 `mediaParts = []` (恢复静默清空) ⇒ GWT-4 红;
 *           把 `engine.ts:3782` 旁的 `promptImages: mediaParts` 那一行删掉 ⇒ 同红。
 *  - GWT-5: 把 `agent-leaf.ts` 的 `splitContentPartsForPi` 改成只返 parts 不转 mimeType
 *           → image 块的 mimeType 跑成 undefined ⇒ 红 (pi 拒绝空 mimeType)。
 *  - GWT-6: 把 `agent-leaf.ts` 的 SDK 旁路整段注释掉 (包括 `sdkPrompt =` 那行) ⇒ GWT-6
 *           红 (prompt 不含 view_image 字样 + 路径)。
 *  - GWT-8: 把 `agent-leaf.ts` 的 `imageRefs.length > 0` gate 删掉 → 无图时也走旁路逻辑
 *           ⇒ prompt 文本附一段无意义尾巴 ⇒ 红 (INV-6 零回归)。
 *
 * 与 `view-image-tool.test.ts` 的关系: 那文件专测 D-1 工具面 + D-2 read 拒图;
 * 本文件专测 D-3 attach_media 的 agent 注入两条腿 (pi parts / SDK 旁路)。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, existsSync, openSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import {
  AGENT_MEDIA_SDK_BYPASS_LOG,
  createAgentLeafRunner,
  splitContentPartsForPi,
} from './agent-leaf';
import { runExecutorDag } from '../../test/helpers/legacy-plan-entry';
import { CheckpointManager } from './continuity/checkpoint-manager';
import { setLoggerDestination } from '../logger';
import type { ExecutorDagConfig, GenerateFn } from './dag/types';
import type { AgentLeafInput, AgentLeafResult } from './leaf-runners';
import type { ContentPart } from '../model/types';

// ── 1×1 PNG 字节 (与 view-image-tool.test.ts 同源) ───────────────────────────────
const PNG_1X1_BYTES = Buffer.from([
  0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4,
  0x89, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9C, 0x63, 0xF8, 0x0F, 0x00, 0x00,
  0x01, 0x01, 0x00, 0x01, 0x5C, 0xCD, 0xFF, 0x69, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44,
  0xAE, 0x42, 0x60, 0x82,
]);
const PNG_DATA_URI = `data:image/png;base64,${PNG_1X1_BYTES.toString('base64')}`;

const PI_MODEL = 'deepseek:deepseek-v4-flash';
const SDK_MODEL = 'claude-code:claude-sonnet-5';

const piAssistant = (text: string): AgentMessage =>
  ({
    role: 'assistant',
    content: [{ type: 'text', text }],
    timestamp: 1,
    stopReason: 'stop',
  }) as unknown as AgentMessage;

const sdkAsst = (text: string): SDKMessage =>
  ({
    type: 'assistant',
    session_id: 's',
    message: {
      content: [{ type: 'text', text }],
      usage: { input_tokens: 1, output_tokens: 1 },
      stop_reason: 'end_turn',
    },
  }) as unknown as SDKMessage;
const sdkSuccess = (): SDKMessage =>
  ({ type: 'result', subtype: 'success', result: 'done', session_id: 's', usage: {} }) as unknown as SDKMessage;

let cwd: string;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'omd-agent-media-'));
  // 在临时盘上落一张真 PNG, 让 collectDepMedia 能读到。
  writeFileSync(join(cwd, 'shot.png'), PNG_1X1_BYTES);
});
afterEach(() => {
  if (cwd) rmSync(cwd, { recursive: true, force: true });
  cwd = '';
});

// ── 纯函数 · splitContentPartsForPi (INV-3/INV-6 的实现细节) ────────────────────
describe('splitContentPartsForPi · 纯函数 (GWT-5 的下层) ', () => {
  test('data URI → 转 pi ImageContent { mimeType, data }, refs 含原 URI', () => {
    const parts: ContentPart[] = [{ type: 'image_url', image_url: { url: PNG_DATA_URI } }];
    const { parts: piParts, refs } = splitContentPartsForPi(parts);
    expect(piParts).toHaveLength(1);
    expect(piParts[0]!.type).toBe('image');
    expect(piParts[0]!.mimeType).toBe('image/png');
    expect(piParts[0]!.data).toBe(PNG_1X1_BYTES.toString('base64'));
    expect(refs).toEqual([PNG_DATA_URI]);
  });

  test('HTTP URL → 不进 parts (这层无 fetcher), refs 仍记 (给 SDK 旁路日志)', () => {
    const httpUrl = 'https://x.test/p.png';
    const { parts, refs } = splitContentPartsForPi([{ type: 'image_url', image_url: { url: httpUrl } }]);
    expect(parts).toEqual([]);
    expect(refs).toEqual([httpUrl]);
  });

  test('undefined → 零 parts, 零 refs (零回归护栏: 缺省不走任何附加路径)', () => {
    expect(splitContentPartsForPi(undefined)).toEqual({ parts: [], refs: [] });
  });

  test('空数组 → 同上', () => {
    expect(splitContentPartsForPi([])).toEqual({ parts: [], refs: [] });
  });
});

// ── GWT-4 · engine.ts 把 attach_media 解析出的图片透传到 agentRunner.promptImages ─
describe('GWT-4 · engine → agentRunner.promptImages 透传 (INV-3)', () => {
  test('★ attach_media:true + agent 节点 + 前驱输出含 png 路径 → runner 收到 promptImages 长度 === 1 (image_url 形 data URI)', async () => {
    let captured: AgentLeafInput | undefined;
    const runner = async (input: AgentLeafInput): Promise<AgentLeafResult> => {
      captured = input;
      return { text: 'done', usage: { in: 1, out: 1 } };
    };
    // 命令节点把 PNG 路径印到 stdout, agent 节点 attach_media + depends_on 该节点。
    const plan = JSON.stringify({
      name: 'media-inject',
      nodes: {
        src: {
          executor: 'command',
          command: `echo "see ${join(cwd, 'shot.png')}"`,
          expect_exit: 0,
          depends_on: [],
          goal: '印出截图路径',
          detector: true,
        },
        viewer: {
          executor: 'agent',
          attach_media: true,
          depends_on: ['src'],
          goal: '看图并打分',
        },
      },
    });
    const generate: GenerateFn = async () => ({ text: plan, usage: { in: 1, out: 1 } });
    const config: ExecutorDagConfig = {
      conductorModel: 'test:conductor',
      leafModel: PI_MODEL,
      agentLeafModel: PI_MODEL,
      generate,
      continuity: { manager: new CheckpointManager(cwd), runId: 'R', repoRoot: cwd },
      agentRunner: runner,
      // 前驱 src 是 command 节点 → 必须注入 commandRunner (engine.ts:3267: 缺则 failed)。
      // 命令桩要返回 **含 PNG 路径的 stdout 文本** — engine.ts:3632 的 collectDepMedia 从
      // depOutputs[id] (即本命令节点的 text) 扫图引用,空串 = 无图 = fail-closed。
      commandRunner: async () => ({
        text: `see ${join(cwd, 'shot.png')}`,
        usage: { in: 0, out: 0 },
        timedOut: false,
        signal: null,
        exitCode: 0,
      }),
    };
    const r = await runExecutorDag('注入', config);
    expect(r.results.viewer!.status).toBe('done');
    expect(captured).toBeDefined();
    expect(captured!.promptImages).toBeDefined();
    expect(captured!.promptImages).toHaveLength(1);
    // 元素 = ContentPart(image_url 形, data URI) —— 引擎不二次解析, 透传给 runner。
    const only = captured!.promptImages![0]!;
    expect(only.type).toBe('image_url');
    if (only.type === 'image_url') {
      expect(only.image_url.url).toBe(PNG_DATA_URI);
    }
  });

  test('★ 无 attach_media 的 agent 节点 → runner.promptImages = undefined (INV-6 零回归)', async () => {
    let captured: AgentLeafInput | undefined;
    const runner = async (input: AgentLeafInput): Promise<AgentLeafResult> => {
      captured = input;
      return { text: 'done', usage: { in: 1, out: 1 } };
    };
    const plan = JSON.stringify({
      name: 'no-media',
      nodes: {
        x: { executor: 'agent', goal: '干点别的' },
      },
    });
    const generate: GenerateFn = async () => ({ text: plan, usage: { in: 1, out: 1 } });
    const config: ExecutorDagConfig = {
      conductorModel: 'test:conductor',
      leafModel: PI_MODEL,
      agentLeafModel: PI_MODEL,
      generate,
      continuity: { manager: new CheckpointManager(cwd), runId: 'R', repoRoot: cwd },
      agentRunner: runner,
    };
    await runExecutorDag('裸跑', config);
    expect(captured).toBeDefined();
    // ★ 钉死: promptImages 缺省 = undefined, prompt 文本逐字就是节点 goal 那一句。
    expect(captured!.promptImages).toBeUndefined();
    expect(captured!.prompt).toContain('干点别的');
  });
});

// ── GWT-5 · pi 腿首条 user 消息 content 是 parts 数组 (text + image) ───────────
describe('GWT-5 · agent-leaf pi 腿: 有图 → 首条 user content 是 parts 数组 (INV-3)', () => {
  test('★ input.promptImages = 1 → loop 收到的首条 user content = [text, image part] 数组', async () => {
    let captured: AgentMessage[] | undefined;
    const fakeLoop = async (msgs: AgentMessage[]) => {
      captured = msgs;
      return [...msgs, piAssistant('看到了')];
    };
    const run = createAgentLeafRunner({ cwd, loopFn: fakeLoop as never });
    await run({
      prompt: '看这张图',
      model: PI_MODEL,
      promptImages: [{ type: 'image_url', image_url: { url: PNG_DATA_URI } }],
    });
    expect(captured).toBeDefined();
    expect(captured).toHaveLength(1);
    // AgentMessage 是 union (含 BashExecutionMessage 等无 .content 字段的形态);
    // loopFn 收到的实际是 pi 序列里的 user 消息, 这里 cast 成 user-message 形状便于断言。
    const first = captured![0] as unknown as { role: string; content: unknown };
    expect(first.role).toBe('user');
    // 关键: content 是数组, 不是字符串。
    expect(Array.isArray(first.content)).toBe(true);
    const parts = first.content as Array<{ type: string; text?: string; mimeType?: string; data?: string }>;
    // 文本块 + 图块 = 2; 顺序 = text 在前 (openai-compat 惯例, 与 chat/agent.ts:379 同构)。
    expect(parts).toHaveLength(2);
    expect(parts[0]!.type).toBe('text');
    // 注: text 块 = routedPrompt, 已被 DISCIPLINE_CORE scaffold 包裹 (agent-leaf.ts:1551);
    //     这里只断言它**包含**原 prompt 文本 (语义不丢), 不锁字节 —— 与现有 pi 路径口径一致。
    expect(parts[0]!.text).toContain('看这张图');
    expect(parts[1]!.type).toBe('image');
    expect(parts[1]!.mimeType).toBe('image/png');
    expect(parts[1]!.data).toBe(PNG_1X1_BYTES.toString('base64'));
  });

  test('★ input.promptImages 缺省 → content 仍是字符串 (INV-6, 零图时不升格 parts)', async () => {
    let captured: AgentMessage[] | undefined;
    const fakeLoop = async (msgs: AgentMessage[]) => {
      captured = msgs;
      return [...msgs, piAssistant('好')];
    };
    const run = createAgentLeafRunner({ cwd, loopFn: fakeLoop as never });
    await run({ prompt: '普通的纯文本任务', model: PI_MODEL });
    const first = captured![0] as unknown as { role: string; content: unknown };
    expect(first.role).toBe('user');
    // ★ 钉死: content 是 string, 不是数组 (零回归护栏)。
    expect(typeof first.content).toBe('string');
    expect(first.content as string).toContain('普通的纯文本任务');
  });
});

// ── GWT-6 · SDK 腿旁路响亮: 日志常量行 + prompt 文本含 view_image + 图片路径 ───
describe('GWT-6 · agent-leaf SDK 腿: promptImages 非空 → 旁路响亮 (INV-4)', () => {
  test('★ SDK 通道 + promptImages 1 张 → 日志含 AGENT_MEDIA_SDK_BYPASS_LOG, prompt 含 view_image 与图片路径', async () => {
    // 把 pino 日志汇改到临时文件, 跑完读回断言常量行 (与 chat-agent / spin-route 同做法)。
    const logPath = join(cwd, 'capture.log');
    const fd = openSync(logPath, 'w');
    setLoggerDestination(fd);
    try {
      let seenPrompt: string | undefined;
      const fakeQuery = (props: { prompt: string; options: Options }) => {
        seenPrompt = props.prompt;
        return (async function* () {
          yield sdkAsst('看到图了');
          yield sdkSuccess();
        })();
      };
      const run = createAgentLeafRunner({ cwd, sdkQueryFn: fakeQuery });
      await run({
        prompt: '看截图',
        model: SDK_MODEL,
        promptImages: [{ type: 'image_url', image_url: { url: PNG_DATA_URI } }],
      });
      expect(seenPrompt).toBeDefined();
      // ★ INV-4: prompt 文本含「view_image」与图片路径 (用 data URI 前 40 字符作为路径指纹即可,
      //   engine 端给的就是 data URI, agent 经 view_image 可读)。
      expect(seenPrompt!).toContain('view_image');
      expect(seenPrompt!).toContain(PNG_DATA_URI.slice(0, 40));
      // 读日志: 旁路常量行出现 (响亮, 不静默丢图)。
      const log = readFileSync(logPath, 'utf8');
      expect(log).toContain(AGENT_MEDIA_SDK_BYPASS_LOG);
      // 顺手钉: 日志里附了节点 model + imageCount (结构化那一位不被吞)。
      expect(log).toContain('"imageCount":1');
    } finally {
      setLoggerDestination(1);
    }
  });

  test('★ SDK 通道 + 无 promptImages → prompt 含原 prompt 文本, 不附旁路尾巴 (INV-6)', async () => {
    const logPath = join(cwd, 'capture2.log');
    const fd = openSync(logPath, 'w');
    setLoggerDestination(fd);
    try {
      let seenPrompt: string | undefined;
      const fakeQuery = (props: { prompt: string; options: Options }) => {
        seenPrompt = props.prompt;
        return (async function* () {
          yield sdkAsst('done');
          yield sdkSuccess();
        })();
      };
      const run = createAgentLeafRunner({ cwd, sdkQueryFn: fakeQuery });
      await run({ prompt: '纯文本', model: SDK_MODEL });
      // routedPrompt = scaffold + 原 prompt (DISCIPLINE_CORE 包裹), 与 D2 前逐字一致。
      // 关键不变量: **没有**「Attached images」尾巴, **没有**「view_image」字样。
      expect(seenPrompt!).toContain('纯文本');
      expect(seenPrompt!).not.toContain('Attached images');
      expect(seenPrompt!).not.toContain('view_image');
      const log = readFileSync(logPath, 'utf8');
      expect(log).not.toContain(AGENT_MEDIA_SDK_BYPASS_LOG);
    } finally {
      setLoggerDestination(1);
    }
  });
});

// ── GWT-8 · agent-media-injection.test.ts 自身的零回归 (INV-6 总闸) ─────────────
describe('GWT-8 · 缺省零回归 (INV-6): 无 promptImages → 首条消息与现状逐字', () => {
  test('★ pi 通道无 promptImages → loop 收到的 user 消息 content 是字符串 (与 D2 之前字节一致)', async () => {
    let captured: AgentMessage[] | undefined;
    const fakeLoop = async (msgs: AgentMessage[]) => {
      captured = msgs;
      return [...msgs, piAssistant('ok')];
    };
    const run = createAgentLeafRunner({ cwd, loopFn: fakeLoop as never });
    await run({ prompt: 'hi', model: PI_MODEL });
    const first = captured![0] as unknown as { role: string; content: unknown };
    expect(typeof first.content).toBe('string');
    expect(first.content as string).toContain('hi');
  });

  test('★ SDK 通道无 promptImages → 传给 sdkQueryFn 的 prompt 含原 prompt, 无任何追加', async () => {
    let seenPrompt: string | undefined;
    const fakeQuery = (props: { prompt: string; options: Options }) => {
      seenPrompt = props.prompt;
      return (async function* () {
        yield sdkAsst('ok');
        yield sdkSuccess();
      })();
    };
    const run = createAgentLeafRunner({ cwd, sdkQueryFn: fakeQuery });
    await run({ prompt: '裸 prompt', model: SDK_MODEL });
    expect(seenPrompt!).toContain('裸 prompt');
    // 不附 view_image / Attached images / paths 这类尾巴 —— 零回归。
    expect(seenPrompt!).not.toContain('Attached images');
    expect(seenPrompt!).not.toContain('view_image');
  });
});
