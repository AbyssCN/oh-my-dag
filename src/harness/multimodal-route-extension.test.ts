import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createMultimodalRouteExtension,
  modelInPool,
  isMimoCoord,
  rewriteVideoEgressBody,
  shouldInstallMimoRewrite,
  type MediaRunResult,
  type MultimodalRouteOpts,
  type MultimodalRouteDeps,
} from './multimodal-route-extension';
import type { ModelRequest, ModelResponse, ContentPart } from '../model';

// ── 测试基座: 假 pi (收集 registerTool) + 假模型 + 假子进程, 不碰真 ffmpeg/网络 ──

const tmp = mkdtempSync(join(tmpdir(), 'omd-mmr-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

// 素材: png (内容任意, 按扩展名认 mime) + 迷你 mp4 (ftyp 魔数 @ offset 4) + 未知扩展名
const pngPath = join(tmp, 'shot.png');
writeFileSync(pngPath, Buffer.from('fake-png-bytes'));
const mp4Path = join(tmp, 'clip.mp4');
writeFileSync(mp4Path, Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom-rest-of-video')]));

function harness(opts: MultimodalRouteOpts, deps: MultimodalRouteDeps = {}) {
  const tools = new Map<string, { execute: Function }>();
  const pi = {
    registerTool(def: { name: string; execute: Function }) {
      tools.set(def.name, def);
    },
    on() {},
  };
  createMultimodalRouteExtension(opts, deps)(pi as never);
  const exec = (name: string, params: unknown, model?: unknown) =>
    tools.get(name)!.execute('id', params, undefined, undefined, { cwd: tmp, model, ui: {} });
  return { tools, exec };
}

/** 假模型: 记录请求, 固定返回分析文本。 */
function fakeCall(text = 'FAKE-ANALYSIS: 画面里有一只猫。') {
  const requests: ModelRequest[] = [];
  const call = async (req: ModelRequest): Promise<ModelResponse> => {
    requests.push(req);
    return { text, usage: { in: 1, out: 1 }, raw: {}, model: req.model ?? '?', attempts: 1 };
  };
  return { requests, call };
}

/** 假子进程: ffprobe 报 5s, 其余成功 (missing=true 时全 ENOENT)。 */
function fakeRun(opts: { missing?: boolean } = {}) {
  const calls: string[][] = [];
  const run = (cmd: string[]): MediaRunResult => {
    calls.push(cmd);
    if (opts.missing) return { errored: true, ok: false, stdout: '', stderr: 'ENOENT' };
    if (cmd[0] === 'ffprobe') return { errored: false, ok: true, stdout: '5.0\n', stderr: '' };
    return { errored: false, ok: true, stdout: '', stderr: '' };
  };
  return { calls, run };
}

// 非 mimo 池 (fetch patch 不安装, 测试不污染 globalThis.fetch)
const POOL = ['fake:vision-x'];
const textModel = { id: 'deepseek-v4-flash', provider: 'deepseek', input: ['text'] };
const poolMemberModel = { id: 'vision-x', provider: 'fake-pi-provider', input: ['text', 'image'] };

const parts = (req: ModelRequest): ContentPart[] => req.messages[0]!.content as ContentPart[];
const imageUrlOf = (req: ModelRequest): string => {
  const p = parts(req).find((x) => x.type === 'image_url');
  return p?.type === 'image_url' ? p.image_url.url : '';
};

describe('multimodal-route', () => {
  test('pool empty → no tools registered (no-op)', () => {
    const h = harness({ poolOverride: [] });
    expect(h.tools.size).toBe(0);
  });

  test('pool set → read_image + read_video registered', () => {
    const h = harness({ poolOverride: POOL });
    expect([...h.tools.keys()].sort()).toEqual(['read_image', 'read_video']);
  });

  test('read_image + active model NOT in pool → handoff: pool model called with media block, result is analysis text', async () => {
    const fm = fakeCall();
    const h = harness({ poolOverride: POOL }, { call: fm.call });
    const res = await h.exec('read_image', { path: pngPath, question: '图里是什么动物?' }, textModel);

    expect(fm.requests.length).toBe(1);
    const req = fm.requests[0]!;
    expect(req.model).toBe('fake:vision-x'); // 池首坐标 = 侧调目标
    expect(imageUrlOf(req)).toStartWith('data:image/png;base64,');
    const instruction = parts(req).find((x) => x.type === 'text');
    expect(instruction?.type === 'text' && instruction.text).toContain('图里是什么动物?');

    expect(res.content).toHaveLength(1); // 纯文本, 无原始媒体块
    expect(res.content[0].text).toContain('FAKE-ANALYSIS');
    expect(res.content[0].text).toContain('analyzed-by="fake:vision-x"');
    expect(res.details.handoff).toBe(true);
  });

  test('read_image + active model IN pool → raw image block kept, no side-call', async () => {
    const fm = fakeCall();
    const h = harness({ poolOverride: POOL }, { call: fm.call });
    const res = await h.exec('read_image', { path: pngPath }, poolMemberModel);

    expect(fm.requests.length).toBe(0);
    const img = res.content.find((c: { type: string }) => c.type === 'image');
    expect(img?.mimeType).toBe('image/png');
    expect(img?.data).toBe(Buffer.from('fake-png-bytes').toString('base64'));
    expect(res.details.handoff).toBe(false);
  });

  test('describePrompt override flows into the side-call instruction', async () => {
    const fm = fakeCall();
    const h = harness({ poolOverride: POOL, describePrompt: '只列出图中文字。' }, { call: fm.call });
    await h.exec('read_image', { path: pngPath }, textModel);
    const instruction = parts(fm.requests[0]!).find((x) => x.type === 'text');
    expect(instruction?.type === 'text' && instruction.text).toStartWith('只列出图中文字。');
  });

  test('read_image unknown extension → clear error, no side-call', async () => {
    const bad = join(tmp, 'note.txt');
    writeFileSync(bad, 'hi');
    const fm = fakeCall();
    const h = harness({ poolOverride: POOL }, { call: fm.call });
    const res = await h.exec('read_image', { path: bad }, textModel);
    expect(res.isError).toBe(true);
    expect(fm.requests.length).toBe(0);
  });

  test('read_video + active model IN pool → disguised video block ({type:image, mimeType:video/mp4})', async () => {
    const fm = fakeCall();
    const fr = fakeRun();
    const h = harness({ poolOverride: POOL }, { call: fm.call, run: fr.run });
    const res = await h.exec('read_video', { path: mp4Path }, poolMemberModel);

    expect(fm.requests.length).toBe(0);
    const block = res.content.find((c: { type: string }) => c.type === 'image');
    expect(block?.mimeType).toBe('video/mp4'); // pi 无 video 类型 → 伪装 image 走原生管道
    expect(res.content[0].text).toContain('passthrough'); // 小 mp4 + 默认参数 = 原片直通, 未跑 ffmpeg
    expect(fr.calls.some((c) => c[0] === 'ffmpeg')).toBe(false);
  });

  test('read_video + active model NOT in pool → handoff with data:video/mp4 media part', async () => {
    const fm = fakeCall('FAKE-VIDEO-ANALYSIS: 0-5s 演示登录流程。');
    const fr = fakeRun();
    const h = harness({ poolOverride: POOL }, { call: fm.call, run: fr.run });
    const res = await h.exec('read_video', { path: mp4Path, question: '演示了什么?' }, textModel);

    expect(fm.requests.length).toBe(1);
    expect(imageUrlOf(fm.requests[0]!)).toStartWith('data:video/mp4;base64,');
    expect(res.content).toHaveLength(1);
    expect(res.content[0].text).toContain('FAKE-VIDEO-ANALYSIS');
    expect(res.details.handoff).toBe(true);
  });

  test('ffmpeg missing → passthrough-eligible mp4 still works; transcode-needing call degrades with clear error', async () => {
    const fm = fakeCall();
    const missing = fakeRun({ missing: true });
    const h = harness({ poolOverride: POOL }, { call: fm.call, run: missing.run });

    // 默认参数 + 小 mp4 → 直通, 不需要 ffmpeg
    const ok = await h.exec('read_video', { path: mp4Path }, textModel);
    expect(ok.isError).toBeUndefined();

    // 要裁剪 (start/duration) → 必须转码 → 清晰报错点名 ffmpeg
    const res = await h.exec('read_video', { path: mp4Path, start: 3, duration: 2 }, textModel);
    expect(res.isError).toBe(true);
    expect(res.content[0].text.toLowerCase()).toContain('ffmpeg');
  });

  test('read_video rejects a clip exceeding the per-call cap (slowmo amplifies)', async () => {
    const fr = fakeRun(); // 总长 5s
    const h = harness({ poolOverride: POOL }, { call: fakeCall().call, run: fr.run });
    const res = await h.exec('read_video', { path: mp4Path, slowmo: 100 }, textModel); // 5s × 100 = 500s > 200s
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('200');
  });

  test('side-call failure surfaces as tool error (not a silent empty analysis)', async () => {
    const call = async (): Promise<ModelResponse> => {
      throw new Error('HTTP 500: upstream down');
    };
    const h = harness({ poolOverride: POOL }, { call });
    const res = await h.exec('read_image', { path: pngPath }, textModel);
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('HTTP 500');
  });

  test('modelInPool: matches by modelId across provider naming, bare coord by provider', () => {
    expect(modelInPool({ id: 'mimo-v2.5', provider: 'xiaomi-token-plan-ams' }, ['mimo:mimo-v2.5'])).toBe(true);
    expect(modelInPool({ id: 'x', provider: 'mimo' }, ['mimo'])).toBe(true);
    expect(modelInPool({ id: 'deepseek-v4-flash', provider: 'deepseek' }, ['mimo:mimo-v2.5'])).toBe(false);
    expect(modelInPool(undefined, ['mimo'])).toBe(false);
  });

  // ── 两层池: depth:'deep' / 自动升级 / 贵层空降级 ────────────────────────

  const PREMIUM = ['fake:vision-pro'];

  /** 按目标模型分文案的假模型: 便宜层回 cheapText, 贵层回 premiumText。 */
  function tieredCall(cheapText: string, premiumText = 'PREMIUM-ANALYSIS: 文字是「羲和」。') {
    const requests: ModelRequest[] = [];
    const call = async (req: ModelRequest): Promise<ModelResponse> => {
      requests.push(req);
      const text = req.model === PREMIUM[0] ? premiumText : cheapText;
      return { text, usage: { in: 1, out: 1 }, raw: {}, model: req.model ?? '?', attempts: 1 };
    };
    return { requests, call };
  }

  test("depth:'deep' routes the side-call to the premium pool head", async () => {
    const fm = tieredCall('CHEAP-ANALYSIS');
    const h = harness({ poolOverride: POOL, premiumPoolOverride: PREMIUM }, { call: fm.call });
    const res = await h.exec('read_image', { path: pngPath, depth: 'deep' }, textModel);

    expect(fm.requests.length).toBe(1); // 直上贵层, 不先走便宜层
    expect(fm.requests[0]!.model).toBe('fake:vision-pro');
    expect(res.content[0].text).toContain('PREMIUM-ANALYSIS');
    expect(res.content[0].text).toContain('analyzed-by="fake:vision-pro"');
    expect(res.content[0].text).toContain('tier="premium"');
    expect(res.content[0].text).not.toContain('escalated-from'); // 显式 deep ≠ 升级
    expect(res.details.tier).toBe('premium');
  });

  test('quick analysis hitting the uncertainty signal auto-escalates to premium', async () => {
    const fm = tieredCall('图片模糊无法识别');
    const h = harness({ poolOverride: POOL, premiumPoolOverride: PREMIUM }, { call: fm.call });
    const res = await h.exec('read_image', { path: pngPath }, textModel); // depth 默认 quick

    expect(fm.requests.map((r) => r.model)).toEqual(['fake:vision-x', 'fake:vision-pro']);
    expect(res.content[0].text).toContain('PREMIUM-ANALYSIS'); // 返回的是贵层分析
    expect(res.content[0].text).toContain('escalated-from=cheap');
    expect(res.content[0].text).toContain('analyzed-by="fake:vision-pro"');
    expect(res.details.escalated).toBe(true);
  });

  test('confident quick analysis stays on the cheap tier (no premium call)', async () => {
    const fm = tieredCall('清晰可见: 一只猫。');
    const h = harness({ poolOverride: POOL, premiumPoolOverride: PREMIUM }, { call: fm.call });
    const res = await h.exec('read_image', { path: pngPath }, textModel);

    expect(fm.requests.map((r) => r.model)).toEqual(['fake:vision-x']);
    expect(res.content[0].text).toContain('tier="cheap"');
    expect(res.details.escalated).toBe(false);
  });

  test('autoEscalate:false keeps the uncertain cheap analysis (no premium call)', async () => {
    const fm = tieredCall('图片模糊无法识别');
    const h = harness({ poolOverride: POOL, premiumPoolOverride: PREMIUM, autoEscalate: false }, { call: fm.call });
    const res = await h.exec('read_image', { path: pngPath }, textModel);
    expect(fm.requests.length).toBe(1);
    expect(res.content[0].text).toContain('tier="cheap"');
  });

  test("depth:'deep' with empty premium pool falls back to cheap with an explicit note", async () => {
    const fm = fakeCall();
    const h = harness({ poolOverride: POOL, premiumPoolOverride: [] }, { call: fm.call });
    const res = await h.exec('read_image', { path: pngPath, depth: 'deep' }, textModel);

    expect(fm.requests.map((r) => r.model)).toEqual(['fake:vision-x']); // 只走便宜层
    expect(res.content[0].text).toContain('tier="cheap"');
    expect(res.content[0].text).toContain('multimodalPoolPremium'); // 注明降级 + 指路配置
    expect(res.details.tier).toBe('cheap');
  });

  test('read_video handoff also honors depth + escalation', async () => {
    const fm = tieredCall('画面模糊, 无法确认按钮文案');
    const fr = fakeRun();
    const h = harness({ poolOverride: POOL, premiumPoolOverride: PREMIUM }, { call: fm.call, run: fr.run });
    const res = await h.exec('read_video', { path: mp4Path }, textModel);
    expect(fm.requests.map((r) => r.model)).toEqual(['fake:vision-x', 'fake:vision-pro']);
    expect(res.content[0].text).toContain('escalated-from=cheap');
  });

  test('mimo egress rewrite gate considers BOTH tiers', () => {
    expect(shouldInstallMimoRewrite('fake:vision-x', undefined)).toBe(false);
    expect(shouldInstallMimoRewrite('mimo:mimo-v2.5', undefined)).toBe(true);
    expect(shouldInstallMimoRewrite('fake:vision-x', 'mimo:mimo-v2.5')).toBe(true); // 贵层 mimo 也装
    expect(shouldInstallMimoRewrite('fake:vision-x', 'fake:vision-pro')).toBe(false);
  });

  test('egress rewrite: image_url(data:video/*) → video_url, others untouched; gated on mimo coords', () => {
    const body = JSON.stringify({
      messages: [
        {
          content: [
            { type: 'text', text: 'hi' },
            { type: 'image_url', image_url: { url: 'data:video/mp4;base64,AAAA' } },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,BBBB' } },
          ],
        },
      ],
    });
    const out = JSON.parse(rewriteVideoEgressBody(body)) as { messages: Array<{ content: Array<Record<string, unknown>> }> };
    expect(out.messages[0]!.content[1]).toEqual({ type: 'video_url', video_url: { url: 'data:video/mp4;base64,AAAA' } });
    expect(out.messages[0]!.content[2]!.type).toBe('image_url'); // 图片 part 不动

    // patch 安装闸门: 只有 mimo 系池首坐标才装 fetch 改写
    expect(isMimoCoord('mimo:mimo-v2.5')).toBe(true);
    expect(isMimoCoord('xiaomi-token-plan-ams:mimo-v2.5')).toBe(true);
    expect(isMimoCoord('fake:vision-x')).toBe(false);
    expect(isMimoCoord('deepseek:deepseek-v4-pro')).toBe(false);
  });
});
