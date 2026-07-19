/**
 * multimodal-route-extension —— 多模态输入路由 (泛化自 fusang .pi/extensions/xihe-video.ts)。
 *
 * 目标: 任何进入会话的多模态输入 (图片/视频) 都由 multimodalPool 配置的多模态模型消化,
 * 与当前激活的文本模型无关 (plan mode / deepseek-flash 照常跑)。两条路:
 *
 *   ① 激活模型本身多模态 (在池内 / input 含 image) → 媒体作原生 content block 注入
 *      tool result → pi 把媒体块提升进会话历史每轮重发 ("持续在上下文", kimi-cli 同机制)。
 *      视频伪装成 {type:"image", mimeType:"video/mp4"} 走 pi 原生管道 (pi 消息类型无 video),
 *      在 mimo 请求出口 (fetch 包裹) 把 image_url(data:video/*) 改写成 mimo 的 video_url。
 *      该改写是 mimo 特有协议 → 只在池首坐标是 mimo 系时才安装 fetch patch。
 *   ② 激活模型纯文本 → describe-and-handoff: 对池首模型做一次 callModel 单发侧调
 *      (媒体块 + 描述指令), 把返回的分析**文本**作为 tool result 注入会话 —— 文本/推理
 *      模型无需原生多模态即可消费媒体分析。
 *
 * 两层池 (代看模式): multimodalPool = 便宜层 (默认), multimodalPoolPremium = 贵层。
 *   depth:'deep' 显式走贵层; depth:'quick' (默认) 走便宜层, 分析命中不确定信号
 *   (看不清/模糊/cannot read...) 且贵层非空时自动升级贵层重看 (opts.autoEscalate 可关)。
 *   贵层池空 → deep 降级便宜层并在结果注明。mimo 出口改写按两层实际使用的坐标共同闸门。
 *
 * 模型切换安全: 非多模态模型时 pi transformMessages 自动把媒体块降级成占位文本, 不炸请求。
 * ffmpeg/ffprobe/yt-dlp 均为可选依赖: 缺失时清晰报错降级, 不炸扩展。
 * 池为空 (resolveMultimodalPool() = []) → 扩展 no-op (log 一次, 不注册任何工具)。
 */
import { Type } from 'typebox';
import { defineTool, type ExtensionFactory, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { extname, isAbsolute, join, resolve } from 'node:path';
import { callModel, getProvider, type ModelRequest, type ModelResponse, type ContentPart } from '../model';
import { resolveMultimodalPool, resolveMultimodalPoolPremium } from '../model/role-models';
import { logger } from '../logger';
import { m } from './i18n';

// 与 mimo-video-distill 校准一致: 170s@960px/1fps 是 mimo 单请求安全区, 留 30s 余量
const MAX_CLIP_SECONDS = 200;
const DEFAULT_SCALE = 960;
const DEFAULT_FPS = 1;
const MAX_B64_MEGABYTES = 25;
// 直通上限: token 不随帧数涨 (mimo 服务端自采样实测), 转码只为控体积。
// 但媒体块随历史每轮重发 → 直通只放小文件, 大了仍转码压缩。
const PASSTHROUGH_MAX_BYTES = 8 << 20;
const MAX_IMAGE_B64_MEGABYTES = 10;

const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
};

export interface MultimodalRouteOpts {
  /** 多模态池覆盖 (测试/CLI)。省略 = resolveMultimodalPool()。空数组 = 扩展 no-op。 */
  poolOverride?: string[];
  /**
   * 贵层多模态池覆盖 (测试/CLI)。省略且 poolOverride 也省略 = resolveMultimodalPoolPremium();
   * poolOverride 给了而它没给 = [] (override 场景不混读文件配置, 保测试/CLI 确定性)。
   */
  premiumPoolOverride?: string[];
  /** describe-and-handoff 的分析指令 (发给池首模型)。 */
  describePrompt?: string;
  /** 便宜层分析命中不确定信号时自动升级贵层重看。默认 true (贵层池空则无从升级)。 */
  autoEscalate?: boolean;
  /** 不确定信号正则 (匹配便宜层分析文本 → 触发升级)。 */
  uncertaintyRe?: RegExp;
}

/** 命令执行结果 (deps.run 注入面, 供测试替身; 与 verify-gate 的 RunResult 同构 + stdout 拆分)。 */
export interface MediaRunResult {
  /** 进程没跑成 (ENOENT/超时) — ffmpeg/yt-dlp 未安装即此态。 */
  errored: boolean;
  ok: boolean;
  stdout: string;
  stderr: string;
}

export interface MultimodalRouteDeps {
  /** 单发侧调注入面 (默认 callModel; 测试用假模型)。 */
  call?: (req: ModelRequest) => Promise<ModelResponse>;
  /** 子进程注入面 (ffprobe/ffmpeg/yt-dlp; 测试不跑真进程)。 */
  run?: (cmd: string[], timeoutMs: number) => MediaRunResult;
}

const DEFAULT_DESCRIBE_PROMPT =
  '请详尽描述并分析此媒体内容: 画面元素、可见文字、结构布局、时序变化 (视频)、整体含义。' +
  '输出将交给一个纯文本模型消费, 它看不到媒体本身 —— 请把所有关键信息写全, 用结构化中文输出。';

/** 便宜层分析的不确定信号: 命中 → (贵层池非空时) 自动升级贵层重看。 */
const DEFAULT_UNCERTAINTY_RE =
  /看不清|无法(识别|辨认|确认)|模糊|not sure|cannot (read|see|make out)|unclear|illegible/i;

/** mimo 出口改写安装闸门: 任一层实际使用的池首坐标是 mimo 系即安装。 */
export function shouldInstallMimoRewrite(cheap: string | undefined, premium: string | undefined): boolean {
  return [cheap, premium].some((c) => c != null && isMimoCoord(c));
}

function defaultRun(cmd: string[], timeoutMs: number): MediaRunResult {
  const proc = spawnSync(cmd[0]!, cmd.slice(1), {
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: timeoutMs,
  });
  return {
    errored: proc.error != null,
    ok: proc.error == null && proc.status === 0,
    stdout: new TextDecoder().decode(proc.stdout ?? new Uint8Array()),
    stderr: new TextDecoder().decode(proc.stderr ?? new Uint8Array()).slice(-500),
  };
}

// ── 池成员判定 ───────────────────────────────────────────────────────────

/**
 * 激活模型是否命中池坐标: 'provider:modelId' 按 modelId 匹配 pi 模型 id (跨 provider 命名容差,
 * omd callModel 的 provider 名与 pi 的 provider 名可能不同); 裸 'provider' 按 provider 匹配。
 */
export function modelInPool(
  model: { id?: string; provider?: string } | undefined,
  pool: readonly string[],
): boolean {
  if (!model) return false;
  const id = model.id?.toLowerCase();
  const provider = model.provider?.toLowerCase();
  for (const coord of pool) {
    const c = coord.trim().toLowerCase();
    if (!c) continue;
    const sep = c.indexOf(':');
    const coordProvider = sep === -1 ? c : c.slice(0, sep);
    const coordModel = sep === -1 ? '' : c.slice(sep + 1);
    if (coordModel && id && coordModel === id) return true;
    if (!coordModel && provider && coordProvider === provider) return true;
  }
  return false;
}

/** 激活模型能否直接吃原生媒体块: 在池内, 或 pi 声明 input 含 'image'。 */
function activeIsMultimodal(
  model: { id?: string; provider?: string; input?: string[] } | undefined,
  pool: readonly string[],
): boolean {
  if (modelInPool(model, pool)) return true;
  return Array.isArray(model?.input) && model.input.includes('image');
}

/** 池坐标是否 mimo 系 (fetch 出口改写是 mimo 私有协议, 按此闸门安装)。 */
export function isMimoCoord(coord: string): boolean {
  const provider = coord.trim().toLowerCase().split(':')[0] ?? '';
  return provider.includes('mimo') || provider.includes('xiaomi');
}

// ── mimo 出口改写: image_url(data:video/*) → video_url ──────────────────

const FETCH_PATCH_FLAG = Symbol.for('omd.multimodal.fetchPatched');
const FETCH_PATCH_HOSTS = Symbol.for('omd.multimodal.fetchHosts');

/** 把请求 body 里 data:video/* 的 image_url part 改写成 mimo 的 video_url part。改不动原样返回。 */
export function rewriteVideoEgressBody(body: string): string {
  const payload = JSON.parse(body) as { messages?: Array<{ content?: unknown }> };
  if (!Array.isArray(payload.messages)) return body;
  let changed = false;
  for (const msg of payload.messages) {
    if (!Array.isArray(msg.content)) continue;
    msg.content = msg.content.map((part: unknown) => {
      const p = part as { type?: string; image_url?: { url?: string } };
      const url = p?.type === 'image_url' ? p.image_url?.url : undefined;
      if (typeof url === 'string' && url.startsWith('data:video/')) {
        changed = true;
        return { type: 'video_url', video_url: { url } };
      }
      return part;
    });
  }
  return changed ? JSON.stringify(payload) : body;
}

/** 全局 fetch 包裹一次 (幂等); hosts 存全局 Set, 后续 session 可追加匹配面。 */
function patchFetchOnce(extraHost: string | null): void {
  const g = globalThis as unknown as Record<symbol, unknown>;
  const hosts = (g[FETCH_PATCH_HOSTS] as Set<string> | undefined) ?? new Set<string>(['xiaomimimo.com']);
  g[FETCH_PATCH_HOSTS] = hosts;
  if (extraHost) hosts.add(extraHost);
  if (g[FETCH_PATCH_FLAG]) return;
  g[FETCH_PATCH_FLAG] = true;
  const origFetch = globalThis.fetch.bind(globalThis);
  const wrapped = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    try {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (
        typeof init?.body === 'string' &&
        init.body.includes('"data:video/') &&
        [...hosts].some((h) => url.includes(h))
      ) {
        init = { ...init, body: rewriteVideoEgressBody(init.body) };
      }
    } catch {
      // fail-open: 改写失败原样放行 (最坏 = mimo 收到 image_url 报错, 不吞真请求)
    }
    return origFetch(input, init);
  };
  globalThis.fetch = wrapped as typeof fetch;
}

/** 从注册 provider 的 baseUrl 提 host (mimo 出口匹配面; provider 未注册 → null)。 */
function mimoProviderHost(coord: string): string | null {
  try {
    const provider = coord.trim().split(':')[0] ?? '';
    const cfg = getProvider(provider);
    if (!cfg?.baseUrl) return null;
    return new URL(cfg.baseUrl).hostname;
  } catch {
    return null;
  }
}

// ── 视频取材 + 转码 (ffmpeg 可选, 缺失清晰降级) ─────────────────────────

function videoCacheDir(): string {
  const base = process.env.OMD_DATA_HOME || join(homedir(), '.omd');
  const dir = join(base, 'video-cache');
  mkdirSync(dir, { recursive: true });
  return dir;
}

function sha1(s: string): string {
  return createHash('sha1').update(s).digest('hex').slice(0, 16);
}

type RunCmd = (cmd: string[], timeoutMs: number) => MediaRunResult;

/** URL → yt-dlp 下载进缓存 (按 URL hash 幂等); 本地路径 → 原样返回。 */
function materialize(source: string, cwd: string, run: RunCmd): { path: string } | { error: string } {
  if (/^https?:\/\//.test(source)) {
    const out = join(videoCacheDir(), `${sha1(source)}.mp4`);
    if (existsSync(out)) return { path: out };
    const r = run(
      ['yt-dlp', '-f', 'bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/b', '--merge-output-format', 'mp4', '--remux-video', 'mp4', '-o', out, source],
      300_000,
    );
    if (r.errored) {
      return { error: m({ en: 'yt-dlp not installed — install it to read video URLs, or pass a local file path.', zh: 'yt-dlp 未安装 — 装上才能读视频 URL, 或改传本地文件路径。' }) };
    }
    if (!r.ok || !existsSync(out)) return { error: `yt-dlp 下载失败: ${r.stderr || '无输出'}` };
    return { path: out };
  }
  const abs = isAbsolute(source) ? source : resolve(cwd, source);
  if (!existsSync(abs)) return { error: `文件不存在: ${abs}` };
  return { path: abs };
}

/** ffprobe 读时长。missing = ffprobe 不存在 (可选依赖缺失, 由调用方决定降级还是报错)。 */
function ffprobeDuration(path: string, run: RunCmd): { missing: boolean; dur: number } {
  const r = run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path], 30_000);
  if (r.errored) return { missing: true, dur: 0 };
  const dur = Number.parseFloat(r.stdout.trim());
  return { missing: false, dur: Number.isFinite(dur) ? dur : 0 };
}

/** ffmpeg 转码 (mimo-video-distill 配方: 精确切段 + 段首关键帧, 每段独立可解)。
 *  slowmo>1 = 时间放大器 (setpts 拉长, mimo 服务端 ~1fps 采样才够到亚秒动效; 丢音频)。 */
function transcode(
  src: string,
  opts: { start: number; duration: number; scale: number; fps: number; slowmo: number },
  run: RunCmd,
): { path: string } | { error: string } {
  const key = sha1(`${src}|${opts.start}|${opts.duration}|${opts.scale}|${opts.fps}|${opts.slowmo}`);
  const out = join(videoCacheDir(), `clip-${key}.mp4`);
  if (existsSync(out)) return { path: out };
  const slow = opts.slowmo > 1;
  // 慢放: 裁剪须在输入侧 (-ss/-t 在 -i 前) —— 输出侧 -t 会把 setpts 拉长后的成片截回原时长。
  const seek = slow
    ? { pre: ['-ss', String(opts.start), '-t', String(opts.duration)], post: [] as string[] }
    : { pre: [] as string[], post: ['-ss', String(opts.start), '-t', String(opts.duration)] };
  const vf = slow
    ? `setpts=${opts.slowmo}*(PTS-STARTPTS),scale=${opts.scale}:-2`
    : `scale=${opts.scale}:-2`;
  const audio = slow ? ['-an'] : ['-c:a', 'aac', '-b:a', '48k'];
  const r = run(
    [
      'ffmpeg', '-y', '-loglevel', 'error',
      ...seek.pre, '-i', src, ...seek.post,
      '-vf', vf, '-r', String(opts.fps), '-g', String(opts.fps * 5),
      '-force_key_frames', 'expr:gte(t,0)',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '30',
      ...audio, '-movflags', '+faststart',
      out,
    ],
    600_000,
  );
  if (r.errored) {
    return { error: m({ en: 'ffmpeg not installed — install it to transcode video, or pass a small (≤8MB) mp4 with default params for passthrough.', zh: 'ffmpeg 未安装 — 装上才能转码视频; 或用默认参数直接传 ≤8MB 的 mp4 走原片直通。' }) };
  }
  if (!r.ok || !existsSync(out)) return { error: `ffmpeg 转码失败: ${r.stderr || '无输出'}` };
  return { path: out };
}

/** mp4 魔数嗅探 (ftyp box @ offset 4) — 直通只放确定可解的 mp4。 */
function isMp4(path: string): boolean {
  try {
    const buf = Buffer.alloc(8);
    const fd = openSync(path, 'r');
    try {
      readSync(fd, buf, 0, 8, 0);
    } finally {
      closeSync(fd);
    }
    return buf.toString('latin1', 4, 8) === 'ftyp';
  } catch {
    return false;
  }
}

// ── 工具参数 schema ──────────────────────────────────────────────────────

const DEPTH_PARAM = Type.Optional(
  Type.Union([Type.Literal('quick'), Type.Literal('deep')], {
    description:
      "分析深度 (代看模式): quick=便宜层多模态池 (默认); deep=贵层池精看 (细小文字/复杂图表/高价值判断)。贵层池未配置时 deep 自动降级便宜层并注明",
  }),
);

const ReadImageParams = Type.Object({
  path: Type.String({ description: '本地图片文件路径, 或 http(s) 图片 URL' }),
  question: Type.Optional(
    Type.String({ description: '要针对图片回答的具体问题 (纯文本模型代看模式下并入分析指令)' }),
  ),
  depth: DEPTH_PARAM,
});

const ReadVideoParams = Type.Object({
  path: Type.String({
    description: '本地视频文件路径, 或 http(s) 视频页 URL (抖音/B站/YouTube 等, 经 yt-dlp 下载)',
  }),
  start: Type.Optional(Type.Number({ description: '起始秒 (长视频分段看; 默认 0)' })),
  duration: Type.Optional(
    Type.Number({ description: `本次观看时长秒 (默认整段, 上限 ${MAX_CLIP_SECONDS}s)` }),
  ),
  scale: Type.Optional(Type.Number({ description: `视频宽 px (默认 ${DEFAULT_SCALE}; 读代码/PPT 别降)` })),
  fps: Type.Optional(Type.Number({ description: `采样帧率 (默认 ${DEFAULT_FPS}, 讲解视频够用)` })),
  slowmo: Type.Optional(
    Type.Number({
      description:
        '时间放大倍数 (如 8): 慢放后送入, 用于看清亚秒级动效/转场。会丢音频; 放大后时长计入单次上限',
    }),
  ),
  question: Type.Optional(
    Type.String({ description: '要针对视频回答的具体问题 (纯文本模型代看模式下并入分析指令)' }),
  ),
  depth: DEPTH_PARAM,
});

type ToolFail = { content: [{ type: 'text'; text: string }]; details: Record<string, never>; isError: true };
const fail = (text: string): ToolFail => ({ content: [{ type: 'text', text }], details: {}, isError: true });

// ── 扩展工厂 ─────────────────────────────────────────────────────────────

/**
 * 造 multimodal-route 扩展工厂。池首坐标 = 指定的多模态模型 (describe-and-handoff 的侧调目标)。
 * 池空 → no-op (log 一次)。
 */
export function createMultimodalRouteExtension(
  opts: MultimodalRouteOpts = {},
  deps: MultimodalRouteDeps = {},
): ExtensionFactory {
  const run = deps.run ?? defaultRun;
  const call = deps.call ?? callModel;
  const describePrompt = opts.describePrompt ?? DEFAULT_DESCRIBE_PROMPT;
  const autoEscalate = opts.autoEscalate ?? true;
  const uncertaintyRe = opts.uncertaintyRe ?? DEFAULT_UNCERTAINTY_RE;

  return (pi) => {
    const pool = opts.poolOverride ?? resolveMultimodalPool();
    if (pool.length === 0) {
      logger.info('[omd/multimodal-route] multimodalPool empty — extension is a no-op (configure .omd/config.json multimodalPool)');
      return;
    }
    const poolModel = pool[0]!;
    // 贵层池: override 优先; poolOverride 场景不混读文件配置 (测试/CLI 确定性)。
    const premiumPool =
      opts.premiumPoolOverride ?? (opts.poolOverride ? [] : resolveMultimodalPoolPremium());
    const premiumModel: string | undefined = premiumPool[0];

    // fetch 出口改写是 mimo 私有 video_url 协议 → 任一层实际使用的坐标是 mimo 系即安装。
    if (shouldInstallMimoRewrite(poolModel, premiumModel)) {
      for (const coord of [poolModel, premiumModel]) {
        if (coord != null && isMimoCoord(coord)) patchFetchOnce(mimoProviderHost(coord));
      }
    }

    /** describe-and-handoff 单发侧调: 媒体 part + 指令 → 指定层的池首模型 → 分析文本。 */
    async function describeWith(
      model: string,
      mediaUrl: string,
      kind: 'image' | 'video',
      question: string | undefined,
      signal: AbortSignal | undefined,
    ): Promise<{ text: string } | { error: string }> {
      const parts: ContentPart[] = [
        {
          type: 'text',
          text: question ? `${describePrompt}\n\n重点回答: ${question}` : describePrompt,
        },
        // 视频也走 image_url part (data:video/*): mimo 出口改写会转成 video_url。
        { type: 'image_url', image_url: { url: mediaUrl } },
      ];
      try {
        const res = await call({
          model,
          messages: [{ role: 'user', content: parts }],
          maxTokens: 4096,
          signal,
        });
        const text = res.text.trim();
        if (!text) return { error: `多模态侧调 (${model}) 返回空文本` };
        return { text };
      } catch (e) {
        logger.warn({ err: e, model, kind }, '[omd/multimodal-route] describe-and-handoff side-call failed');
        return { error: `多模态侧调 (${model}) 失败: ${(e as Error)?.message ?? String(e)}` };
      }
    }

    /** 分层代看: quick=便宜层 (+不确定信号自动升级); deep=贵层 (池空降级便宜层并注明)。 */
    async function analyzeMedia(
      mediaUrl: string,
      kind: 'image' | 'video',
      question: string | undefined,
      depth: 'quick' | 'deep',
      signal: AbortSignal | undefined,
    ): Promise<
      | { text: string; by: string; tier: 'cheap' | 'premium'; escalated: boolean; note?: string }
      | { error: string }
    > {
      // ── deep: 直接贵层; 贵层未配置 → 便宜层 + 注明降级。 ──
      if (depth === 'deep') {
        if (premiumModel) {
          const r = await describeWith(premiumModel, mediaUrl, kind, question, signal);
          if ('error' in r) return r;
          return { text: r.text, by: premiumModel, tier: 'premium', escalated: false };
        }
        const r = await describeWith(poolModel, mediaUrl, kind, question, signal);
        if ('error' in r) return r;
        return {
          text: r.text,
          by: poolModel,
          tier: 'cheap',
          escalated: false,
          note: m({
            en: "(note: depth:'deep' requested but premium multimodal pool is empty — analyzed by the cheap tier; configure .omd/config.json multimodalPoolPremium to enable deep reads.)",
            zh: "(注: 请求了 depth:'deep' 但贵层多模态池未配置 — 已由便宜层代看; 配置 .omd/config.json multimodalPoolPremium 可启用贵层精看。)",
          }),
        };
      }

      // ── quick: 便宜层; 分析命中不确定信号且贵层可用 → 自动升级重看。 ──
      const cheap = await describeWith(poolModel, mediaUrl, kind, question, signal);
      if ('error' in cheap) return cheap;
      if (autoEscalate && premiumModel && uncertaintyRe.test(cheap.text)) {
        logger.info(
          { from: poolModel, to: premiumModel, kind },
          '[omd/multimodal-route] cheap-tier analysis hit uncertainty signal — auto-escalating to premium tier',
        );
        const prem = await describeWith(premiumModel, mediaUrl, kind, question, signal);
        if (!('error' in prem)) {
          return { text: prem.text, by: premiumModel, tier: 'premium', escalated: true };
        }
        // 贵层重看失败 → 保留便宜层分析 + 注明升级未遂 (不因升级失败吞掉已有结果)。
        return {
          text: cheap.text,
          by: poolModel,
          tier: 'cheap',
          escalated: false,
          note: m({
            en: `(note: uncertainty detected, premium-tier retry failed (${prem.error}) — cheap-tier analysis kept.)`,
            zh: `(注: 检测到不确定信号, 贵层升级重看失败 (${prem.error}) — 保留便宜层分析。)`,
          }),
        };
      }
      return { text: cheap.text, by: poolModel, tier: 'cheap', escalated: false };
    }

    /** handoff 结果包装: 说明来源 + 分析正文 (纯文本, 任何激活模型可消费)。 */
    const handoffText = (
      kind: 'image' | 'video',
      source: string,
      a: { text: string; by: string; tier: 'cheap' | 'premium'; escalated: boolean; note?: string },
    ): string =>
      `<media-analysis kind="${kind}" source="${source}" analyzed-by="${a.by}" tier="${a.tier}"${a.escalated ? ' escalated-from=cheap' : ''}>\n` +
      `${a.text}\n</media-analysis>\n` +
      (a.note ? `${a.note}\n` : '') +
      m({
        en: '(Active model is text-only; the multimodal model above viewed the media and produced this analysis.)',
        zh: '(当前激活模型为纯文本; 以上分析由多模态模型代看媒体后产出。)',
      });

    // ── read_image ──────────────────────────────────────────────────────
    pi.registerTool(
      defineTool({
        name: 'read_image',
        label: 'Read Image',
        description: m({
          en:
            'Read an image (local path or http(s) URL) into the conversation. If the active model is multimodal the raw image stays in context for follow-ups; otherwise the configured multimodal model analyzes it and returns a detailed text description.',
          zh:
            '把图片 (本地路径或 http(s) URL) 读进对话。激活模型多模态时原图持续留在上下文可多轮追问; 纯文本模型时由配置的多模态模型代看, 返回详尽文字分析。',
        }),
        promptSnippet: m({
          en: 'read_image(path, question?) — view an image; works even when the active model is text-only.',
          zh: 'read_image(path, question?) — 看图; 激活模型纯文本也能用 (多模态模型代看)。',
        }),
        parameters: ReadImageParams,
        async execute(_id, params, signal, _onUpdate, ctx: ExtensionContext) {
          ctx?.ui?.setStatus?.('multimodal', 'reading image...');
          try {
            const isUrl = /^https?:\/\//.test(params.path);
            const rawActive = activeIsMultimodal(ctx?.model as never, pool);

            // handoff + URL: 直接把 URL 交给池模型, 不下载。
            if (!rawActive && isUrl) {
              const r = await analyzeMedia(params.path, 'image', params.question, params.depth ?? 'quick', signal);
              if ('error' in r) return fail(r.error);
              return { content: [{ type: 'text' as const, text: handoffText('image', params.path, r) }], details: { source: params.path, handoff: true, tier: r.tier, escalated: r.escalated } };
            }

            // 取字节: 本地读盘 / URL 下载 (仅 raw 模式需要 base64)。
            let bytes: Buffer;
            let mime: string;
            if (isUrl) {
              const res = await fetch(params.path, { signal });
              if (!res.ok) return fail(`图片下载失败: HTTP ${res.status}`);
              bytes = Buffer.from(await res.arrayBuffer());
              mime = res.headers.get('content-type')?.split(';')[0] || IMAGE_MIME[extname(new URL(params.path).pathname).toLowerCase()] || 'image/png';
            } else {
              const abs = isAbsolute(params.path) ? params.path : resolve(ctx?.cwd ?? process.cwd(), params.path);
              if (!existsSync(abs)) return fail(`文件不存在: ${abs}`);
              const ext = extname(abs).toLowerCase();
              const known = IMAGE_MIME[ext];
              if (!known) return fail(`不认识的图片扩展名 '${ext}' (支持: ${Object.keys(IMAGE_MIME).join(' ')})`);
              mime = known;
              bytes = readFileSync(abs);
            }
            const b64 = bytes.toString('base64');
            if (b64.length > MAX_IMAGE_B64_MEGABYTES << 20) {
              return fail(`图片 ${(b64.length / (1 << 20)).toFixed(1)}MB 超过 ${MAX_IMAGE_B64_MEGABYTES}MB 上限, 先压缩再读。`);
            }

            if (rawActive) {
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: `<image path="${params.path}" size="${bytes.length} bytes">下方媒体块即该图片, 已进入会话上下文并在后续轮次持续可见。</image>`,
                  },
                  { type: 'image' as const, data: b64, mimeType: mime },
                ],
                details: { source: params.path, mime, handoff: false },
              };
            }

            const r = await analyzeMedia(`data:${mime};base64,${b64}`, 'image', params.question, params.depth ?? 'quick', signal);
            if ('error' in r) return fail(r.error);
            return { content: [{ type: 'text' as const, text: handoffText('image', params.path, r) }], details: { source: params.path, mime, handoff: true, tier: r.tier, escalated: r.escalated } };
          } finally {
            ctx?.ui?.setStatus?.('multimodal', '');
          }
        },
      }),
    );

    // ── read_video ──────────────────────────────────────────────────────
    pi.registerTool(
      defineTool({
        name: 'read_video',
        label: 'Read Video',
        description: m({
          en:
            'Read a video (frames + audio) into the conversation. If the active model is multimodal the clip stays in context for follow-ups; otherwise the configured multimodal model watches it and returns a detailed text analysis. ' +
            `Max ${MAX_CLIP_SECONDS}s per call — use start/duration for longer videos. Local files and http(s) URLs (yt-dlp). Needs ffmpeg unless the file is a small (≤8MB) mp4 read with default params.`,
          zh:
            '把视频 (画面+音频) 读进对话。激活模型多模态时视频段持续留在上下文可多轮追问; 纯文本模型时由配置的多模态模型代看, 返回详尽文字分析。' +
            `单次最长 ${MAX_CLIP_SECONDS}s, 更长用 start/duration 分段。支持本地文件和 http(s) URL (yt-dlp)。除"默认参数 + ≤8MB mp4 直通"外需要 ffmpeg。` +
            '动效/转场细节原速不可见 (采样 ~1fps), 用 read_video(start=事件秒, duration=2~5, slowmo=8) 慢放精看。',
        }),
        promptSnippet: m({
          en: 'read_video(path, start?, duration?, slowmo?, question?) — watch a video; works even when the active model is text-only.',
          zh: 'read_video(path, start?, duration?, slowmo?, question?) — 看视频; 激活模型纯文本也能用 (多模态模型代看)。',
        }),
        parameters: ReadVideoParams,
        async execute(_id, params, signal, _onUpdate, ctx: ExtensionContext) {
          ctx?.ui?.setStatus?.('multimodal', 'materializing video...');
          try {
            const mat = materialize(params.path, ctx?.cwd ?? process.cwd(), run);
            if ('error' in mat) return fail(mat.error);

            const probe = ffprobeDuration(mat.path, run);
            const slowmo = Math.max(1, params.slowmo ?? 1);
            const wantsDefault =
              params.start === undefined && params.duration === undefined &&
              params.scale === undefined && params.fps === undefined && slowmo === 1;
            const rawSize = statSync(mat.path).size;

            let clipPath: string;
            let start = params.start ?? 0;
            let duration = 0;
            let totalDur = probe.dur;

            if (probe.missing) {
              // ffmpeg/ffprobe 缺失: 只允许"默认参数 + 小 mp4"直通, 其余清晰报错降级。
              if (!(wantsDefault && rawSize <= PASSTHROUGH_MAX_BYTES && isMp4(mat.path))) {
                return fail(
                  m({
                    en: `ffmpeg/ffprobe not installed — cannot probe or transcode video. Install ffmpeg, or pass a ≤${PASSTHROUGH_MAX_BYTES >> 20}MB mp4 with default params (passthrough needs no ffmpeg).`,
                    zh: `ffmpeg/ffprobe 未安装 — 无法探测/转码视频。安装 ffmpeg, 或用默认参数传 ≤${PASSTHROUGH_MAX_BYTES >> 20}MB 的 mp4 (直通不需要 ffmpeg)。`,
                  }),
                );
              }
              clipPath = mat.path;
            } else {
              if (totalDur <= 0) return fail(`ffprobe 读不出时长, 可能不是可解码视频: ${mat.path}`);
              if (start >= totalDur) return fail(`start=${start}s 超出视频总长 ${totalDur.toFixed(1)}s`);
              const remaining = totalDur - start;
              duration = Math.min(params.duration ?? remaining, remaining);
              const effectiveDur = duration * slowmo; // 慢放拉长的是实际送入时长 → 闸按放大后算
              if (effectiveDur > MAX_CLIP_SECONDS) {
                const maxSrc = Math.floor(MAX_CLIP_SECONDS / slowmo);
                return fail(
                  `本段送入时长 ${effectiveDur.toFixed(0)}s (${duration.toFixed(0)}s × slowmo ${slowmo}) ` +
                    `超过单次上限 ${MAX_CLIP_SECONDS}s。分段观看: 每次最多 duration=${maxSrc}, ` +
                    `如 read_video(start=${start}, duration=${maxSrc}${slowmo > 1 ? `, slowmo=${slowmo}` : ''}), 逐段推进到 ${totalDur.toFixed(0)}s。`,
                );
              }
              if (wantsDefault && rawSize <= PASSTHROUGH_MAX_BYTES && isMp4(mat.path)) {
                clipPath = mat.path; // 直通: 小 mp4 + 无任何裁剪/慢放/重采样诉求
              } else {
                ctx?.ui?.setStatus?.('multimodal', 'transcoding...');
                const clip = transcode(
                  mat.path,
                  { start, duration, scale: params.scale ?? DEFAULT_SCALE, fps: params.fps ?? DEFAULT_FPS, slowmo },
                  run,
                );
                if ('error' in clip) return fail(clip.error);
                clipPath = clip.path;
              }
            }

            const bytes = readFileSync(clipPath);
            const b64 = bytes.toString('base64');
            if (b64.length > MAX_B64_MEGABYTES << 20) {
              return fail(
                `转码后 ${(b64.length / (1 << 20)).toFixed(1)}MB 超过 ${MAX_B64_MEGABYTES}MB 上限。缩短 duration 或降 scale (如 640) 再试。`,
              );
            }

            const header =
              `<video path="${params.path}" start="${start}s" duration="${duration > 0 ? duration.toFixed(0) : '?'}s" ` +
              `total="${totalDur > 0 ? totalDur.toFixed(0) : '?'}s" size="${bytes.length} bytes"` +
              `${slowmo > 1 ? ` slowmo="${slowmo}x (无音频)"` : ''}${clipPath === mat.path ? ' passthrough="原片直通"' : ''}>`;

            if (activeIsMultimodal(ctx?.model as never, pool)) {
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: `${header}下方媒体块即该视频段 (画面${slowmo > 1 ? '' : '+音频'}), 已进入会话上下文并在后续轮次持续可见。</video>`,
                  },
                  // pi 消息类型无 video → 伪装成 image block; mimo 出口改写转成 video_url。
                  { type: 'image' as const, data: b64, mimeType: 'video/mp4' },
                ],
                details: { path: mat.path, clip: clipPath, start, duration, slowmo, totalDur, handoff: false },
              };
            }

            const depth = params.depth ?? 'quick';
            ctx?.ui?.setStatus?.('multimodal', `handoff → ${depth === 'deep' && premiumModel ? premiumModel : poolModel}...`);
            const r = await analyzeMedia(`data:video/mp4;base64,${b64}`, 'video', params.question, depth, signal);
            if ('error' in r) return fail(r.error);
            return {
              content: [{ type: 'text' as const, text: `${header}</video>\n${handoffText('video', params.path, r)}` }],
              details: { path: mat.path, clip: clipPath, start, duration, slowmo, totalDur, handoff: true, tier: r.tier, escalated: r.escalated },
            };
          } finally {
            ctx?.ui?.setStatus?.('multimodal', '');
          }
        },
      }),
    );
  };
}
