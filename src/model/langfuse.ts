/**
 * src/model/langfuse —— **Langfuse trace 导出器** (2026-07-31)。
 *
 * ## 为什么这个文件今天才有
 *
 * 仓里两处**写着**我们有 Langfuse:`executor-dag-defaults.ts` 的
 * 「默认 generate: 经 gateway send() → **自动出 Langfuse trace**」,以及 `ExecutorDagResult.sessionId`
 * 的「本次 run 的 **Langfuse session id**」。而全仓 `grep -i langfuse` 此前只命中注释 ——
 * **没有客户端、没有 env、没有导出器,一条 trace 都没发过。**
 *
 * 那两句不是凭空写的:`gateway.ts` 自己交代了出处 —— 上游 bluebell gateway 有一条 middleware
 * pipeline(trace 在那儿发),开源内核按 YAGNI 没搬,而**注释跟着搬过来了**。
 * 声明面与执行面对不上,这次是文档说的比代码做的多。
 *
 * 好消息是关联键早就端到端存在(每次调用带 `sessionId`,留痕库每条带 `runId`),
 * 所以补的只是 `send()` 这一个 chokepoint 上的出口。
 *
 * ## 四条设计决定
 *
 * ① **不引 SDK,一个 `fetch` + Basic auth 就够。** 我们只发一种事件(generation),
 *    而 SDK 带 OTel 依赖树且版本会漂。Ingestion 是稳定的公开 HTTP 契约。
 * ② **env 激活,不配就是真的什么都不做**,并且 {@link langfuseStatus} 说得出它为什么没开 ——
 *    这个文件本身就是在治「机制在、生产零生效」,不能自己再长出一个。
 * ③ **fail-open 且只吼一次**:观测层不许把主路径拖挂;网络抖动/429 会反复发生,
 *    每次都 warn 等于把日志刷成噪音(而噪音里没人看得见第一条真错误)。
 * ④ **入队即返回,后台批量 flush**:主路径上只有一次数组 push。
 *
 * ## ⚠ 这条线会把 prompt 正文送出去
 *
 * 接它的**目的**就是让每个节点的 prompt 可审查(要能持续优化就得先看得见),所以 input/output
 * 是原样发的 —— 其中包含仓库内容、owner 指令、research 抓回来的网页正文。
 * 前提因此是 **self-hosted**(NAS)。指向任何第三方托管实例之前,先想清楚这一句。
 */
import { randomUUID } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '../harness/logger';
import type { ModelUsage } from './types';

/** 单个字段的上送上限;超了截断并留标记(ingestion 对超大 body 会整批拒,截断比丢整批好)。 */
const MAX_FIELD_CHARS = 100_000;
/** 批大小与最长滞留 —— 攒批是为了少发请求,滞留上限是为了短命进程也能把最后几条送出去。 */
const BATCH_SIZE = 20;
const FLUSH_INTERVAL_MS = 3_000;
/**
 * 单次上送超时。**这一格是测试当场抓出来的**:第一版没给超时, 于是指向一个不可达地址时
 * flush 会一直挂着 —— 观测请求挂住 = 句柄与内存慢慢堆, 而这条线的全部前提是"它不能影响引擎"。
 * fail-open 不只是"出错不抛", 还得是"**出错要及时**"。
 */
const REQUEST_TIMEOUT_MS = 5_000;

export interface LangfuseConfig {
  host: string;
  publicKey: string;
  secretKey: string;
}

/**
 * 读 env(**每次读,不在模块加载时冻结**)—— 同 INV-MODEL-3 的那条纪律:
 * daemon 长活,配置在运行中被改是常态,boot 冻结会让人改完发现"没生效"。
 */
export function langfuseConfigFromEnv(env: Record<string, string | undefined> = process.env): LangfuseConfig | null {
  const host = (env.LANGFUSE_HOST ?? env.LANGFUSE_BASEURL ?? '').trim().replace(/\/+$/, '');
  const publicKey = (env.LANGFUSE_PUBLIC_KEY ?? '').trim();
  const secretKey = (env.LANGFUSE_SECRET_KEY ?? '').trim();
  return host && publicKey && secretKey ? { host, publicKey, secretKey } : null;
}

/**
 * env 优先, 文件兜底。
 *
 * ⚠ **纯 env 那一半单独导出** ({@link langfuseConfigFromEnv}) 不是为了好看:
 * 文件兜底一加进来, 「不配 env = 什么都不做」这条用例就会读到仓里真实的 `.omd/config.json`
 * 而变成随环境绿红 (**写这段时测试当场抓住了**)。env 语义由纯函数验, 文件兜底由临时 cwd 验,
 * 两件事分开测才各自钉得住。
 */
export function resolveLangfuseConfig(env: Record<string, string | undefined> = process.env): LangfuseConfig | null {
  const fromEnv = langfuseConfigFromEnv(env);
  if (fromEnv) return fromEnv;
  // env 没给 → 退到 omd 自己的配置面。**这不是"两个真源"**: env 恒压过文件, 文件只是让
  // "不改 MCP 启动方式也能开观测"成为可能 —— daemon 由客户端拉起, 给它加 env 要动客户端配置,
  // 而 `.omd/config.json` 是 omd 本来就在读的那一份 (且已 gitignore, 与 .env 同级别的本地文件)。
  return fileLangfuseConfig();
}

/** `.omd/config.json` 的 `observability.langfuse`。按 mtime 缓存 —— 这函数每次模型调用都会被问到。 */
let fileCache: { mtimeMs: number; cfg: LangfuseConfig | null } | null = null;
function fileLangfuseConfig(): LangfuseConfig | null {
  const path = join(process.cwd(), '.omd', 'config.json');
  try {
    const { mtimeMs } = statSync(path);
    if (fileCache?.mtimeMs === mtimeMs) return fileCache.cfg;
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as { observability?: { langfuse?: Partial<LangfuseConfig> } };
    const lf = raw.observability?.langfuse;
    const cfg =
      lf?.host && lf.publicKey && lf.secretKey
        ? { host: lf.host.trim().replace(/\/+$/, ''), publicKey: lf.publicKey.trim(), secretKey: lf.secretKey.trim() }
        : null;
    fileCache = { mtimeMs, cfg };
    return cfg;
  } catch {
    // 文件不在/读不动/不是 JSON → 当没配 (观测层不许因为配置面缺失而抛)
    return null;
  }
}

/** 人可读的开没开 + 没开的**原因**(给 `omd_config_status` 与排障用)。 */
export function langfuseStatus(env: Record<string, string | undefined> = process.env): string {
  const missing = (['LANGFUSE_HOST', 'LANGFUSE_PUBLIC_KEY', 'LANGFUSE_SECRET_KEY'] as const).filter(
    (k) => !(k === 'LANGFUSE_HOST' ? (env.LANGFUSE_HOST ?? env.LANGFUSE_BASEURL) : env[k])?.trim(),
  );
  const resolved = resolveLangfuseConfig(env);
  if (!resolved) return `未启用 (env 缺 ${missing.join(' / ')}; .omd/config.json 的 observability.langfuse 也没配)`;
  return `启用 → ${resolved.host} (来源: ${missing.length ? '.omd/config.json' : 'env'})`;
}

export interface GenerationRecord {
  /** 归到哪条 trace。给 sessionId 就用它 —— 一次 run 的所有调用因此落进同一条 trace。 */
  traceId: string;
  /** 观测名(角色/节点名,如 `omd-leaf` / `conductor`)。Langfuse 上按它分组看。 */
  name: string;
  model: string;
  /** 原样的请求消息 —— **这就是我们要审查的 prompt**。 */
  input: unknown;
  output: string;
  usage?: ModelUsage;
  startTime: Date;
  endTime: Date;
  /** 出错时给,进 Langfuse 的 level/statusMessage(错的那些调用比对的更值得看)。 */
  error?: string;
  metadata?: Record<string, unknown>;
}

interface QueuedEvent {
  id: string;
  timestamp: string;
  type: string;
  body: Record<string, unknown>;
}

let queue: QueuedEvent[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let shoutedOnce = false;
/** 已经建过 trace 头的 traceId(一条 trace 只发一次 trace-create)。 */
const seenTraces = new Set<string>();

const clip = (s: string): string => (s.length > MAX_FIELD_CHARS ? `${s.slice(0, MAX_FIELD_CHARS)}\n…[truncated ${s.length - MAX_FIELD_CHARS} chars]` : s);
const clipDeep = (v: unknown): unknown => (typeof v === 'string' ? clip(v) : JSON.parse(clip(JSON.stringify(v ?? null))) as unknown);

/**
 * 记一次模型调用。**同步入队即返回** —— 主路径上只有一次 push,网络在后台。
 * 未配置 → 直接返回(零成本)。
 */
export function recordGeneration(rec: GenerationRecord, env: Record<string, string | undefined> = process.env): void {
  if (!resolveLangfuseConfig(env)) return;
  const now = new Date().toISOString();
  if (!seenTraces.has(rec.traceId)) {
    seenTraces.add(rec.traceId);
    queue.push({
      id: randomUUID(),
      timestamp: now,
      type: 'trace-create',
      // sessionId 与 id 同值: 一次 run = 一条 trace, 同时也是一个 session ——
      // 这样按 run 看和按 session 看是同一份东西, 不用在两个概念之间来回翻译。
      // tags: 这台 Langfuse 目前只有一个项目 (bluebell/Fusang), omd 的 trace 会与别的产品混在一起 ——
      // 打上 tag 才筛得出来。等要建**数据集与 score** 时再谈拆项目 (那两样是 project 作用域的)。
      body: { id: rec.traceId, name: 'omd-run', sessionId: rec.traceId, timestamp: now, tags: ['omd'], metadata: { source: 'oh-my-dag' } },
    });
  }
  queue.push({
    id: randomUUID(),
    timestamp: now,
    type: 'generation-create',
    body: {
      id: randomUUID(),
      traceId: rec.traceId,
      name: rec.name,
      model: rec.model,
      startTime: rec.startTime.toISOString(),
      endTime: rec.endTime.toISOString(),
      input: clipDeep(rec.input),
      output: clip(rec.output),
      ...(rec.usage
        ? {
            usage: { input: rec.usage.in, output: rec.usage.out, total: rec.usage.in + rec.usage.out, unit: 'TOKENS' },
            // cacheHit 不进 usage 而进 metadata: Langfuse 的 usage 三格是它自己算钱用的,
            // 塞第四个数进去它不认; 而我们的成本账本来就在 cost-ledger 里算 (那才是真源)。
            ...(rec.usage.cacheHit !== undefined ? { metadata: { ...rec.metadata, cacheHit: rec.usage.cacheHit } } : {}),
          }
        : {}),
      ...(rec.usage?.cacheHit === undefined && rec.metadata ? { metadata: rec.metadata } : {}),
      ...(rec.error ? { level: 'ERROR', statusMessage: clip(rec.error) } : {}),
    },
  });
  if (queue.length >= BATCH_SIZE) void flushLangfuse(env);
  else scheduleFlush(env);
}

function scheduleFlush(env: Record<string, string | undefined>): void {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    void flushLangfuse(env);
  }, FLUSH_INTERVAL_MS);
  // daemon 里这颗定时器不该拖住进程退出 (它只是观测)。unref 在 node/bun 都有。
  timer.unref?.();
}

/**
 * 送一批。**任何失败都只 fail-open**:事件丢掉、吼一次、继续跑。
 *
 * 为什么丢而不重试:重试要么占内存(排队积压)要么占主路径(阻塞),而这是**观测层** ——
 * 丢几条 trace 的代价远小于把引擎拖慢。真要一条不丢,那是另一个设计(落盘再补送),
 * 到时候再谈;今天先让它有。
 */
export async function flushLangfuse(
  env: Record<string, string | undefined> = process.env,
  // 注入口只为**测试确定性**: 拿真 socket 验 fail-open 会把用例的绿红压在 OS 的网络行为上
  // (第一版就是这么写的, 结果连不上的那个地址挂满 5s 把用例拖超时 —— 而那恰好也暴露了
  // 上面 REQUEST_TIMEOUT_MS 的缺失)。生产走全局 fetch, 这个参数不填。
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const cfg = resolveLangfuseConfig(env);
  if (!cfg || queue.length === 0) return;
  const batch = queue;
  queue = [];
  try {
    const res = await fetchImpl(`${cfg.host}/api/public/ingestion`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Basic ${Buffer.from(`${cfg.publicKey}:${cfg.secretKey}`).toString('base64')}`,
      },
      body: JSON.stringify({ batch }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    // 207 = 逐条多状态 (Langfuse 的正常成功码之一), 2xx 一律当过。
    if (!res.ok && res.status !== 207) shoutOnce(`Langfuse ingestion HTTP ${res.status}`);
  } catch (err) {
    shoutOnce(`Langfuse ingestion 发不出去: ${String(err)}`);
  }
}

/** 只吼第一条 —— 网络抖动会反复发生, 每次都 warn 会把真正的第一条错误埋掉。 */
function shoutOnce(msg: string): void {
  if (shoutedOnce) {
    logger.debug({ msg }, '[omd/langfuse] 又一次导出失败 (已静默)');
    return;
  }
  shoutedOnce = true;
  logger.warn({ msg }, '[omd/langfuse] trace 导出失败 —— **观测掉了, 引擎照跑**。后续同类失败只进 debug');
}

/** 测试用:清空队列与"吼过了"标记。 */
export function _resetLangfuseForTest(): void {
  queue = [];
  seenTraces.clear();
  shoutedOnce = false;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}
/** 测试用:看队列里攒了什么(不发网络)。 */
export function _peekLangfuseQueue(): ReadonlyArray<{ type: string; body: Record<string, unknown> }> {
  return queue.map((e) => ({ type: e.type, body: e.body }));
}
