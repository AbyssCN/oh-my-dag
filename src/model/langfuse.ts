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
import { homedir } from 'node:os';
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
 * 文件兜底一加进来, 「不配 env = 什么都不做」这条用例就会读到真机上的凭证文件
 * 而变成随环境绿红 (**写这段时测试当场抓住了**)。env 语义由纯函数验, 文件兜底由临时 HOME 验,
 * 两件事分开测才各自钉得住。
 */
export function resolveLangfuseConfig(env: Record<string, string | undefined> = process.env): LangfuseConfig | null {
  const fromEnv = langfuseConfigFromEnv(env);
  if (fromEnv) return fromEnv;
  // env 没给 → 退到凭证文件。**这不是"两个真源"**: env 恒压过文件, 文件只是让
  // "不改 MCP 启动方式也能开观测"成为可能 —— daemon 由客户端拉起, 给它加 env 要动客户端配置。
  return secretsFileLangfuseConfig(env);
}

/**
 * 凭证落点 = `$XDG_CONFIG_HOME/omd/secrets.json`(缺省 `~/.config/omd/secrets.json`)。
 *
 * **为什么不是 `.omd/config.json`**(2026-07-31 搬家, 首版落在那里):
 * ① 那份文件在**仓树里**, 而 command leaf 的白名单收了 `cat`/`grep`/`jq` —— 密钥躺在
 *    模型够得着的路径上, 等于把当初「不收 `printenv`」的判据自己拆了。搬出仓树后,
 *    模型列目录/递归 grep 都碰不到它(闸上另有 basename 拒, 见 `command-leaf.ts`)。
 * ② Langfuse 账号是**每台机器一份**, 不是每个仓一份。放 `~/.config` 是配一次全仓生效,
 *    比每开一个仓重填一遍更省事 —— 安全与便利这次同向, 不用取舍。
 * ③ gitignore 类机制(含 `.git/info/exclude`)只防"提交进去", 防不住"被读出来"。
 *    落点搬走才动到后者。
 *
 * 按 mtime 缓存 —— 这函数每次模型调用都会被问到。
 */
export function omdSecretsPath(env: Record<string, string | undefined> = process.env): string {
  const base = env.XDG_CONFIG_HOME?.trim() || join(env.HOME ?? homedir(), '.config');
  return join(base, 'omd', 'secrets.json');
}

let fileCache: { path: string; mtimeMs: number; cfg: LangfuseConfig | null } | null = null;
function secretsFileLangfuseConfig(env: Record<string, string | undefined>): LangfuseConfig | null {
  const path = omdSecretsPath(env);
  try {
    const { mtimeMs } = statSync(path);
    if (fileCache?.path === path && fileCache.mtimeMs === mtimeMs) return fileCache.cfg;
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as { langfuse?: Partial<LangfuseConfig> };
    const lf = raw.langfuse;
    const cfg =
      lf?.host && lf.publicKey && lf.secretKey
        ? { host: lf.host.trim().replace(/\/+$/, ''), publicKey: lf.publicKey.trim(), secretKey: lf.secretKey.trim() }
        : null;
    fileCache = { path, mtimeMs, cfg };
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
  if (!resolved) return `未启用 (env 缺 ${missing.join(' / ')}; ${omdSecretsPath(env)} 的 langfuse 也没配)`;
  return `启用 → ${resolved.host} (来源: ${missing.length ? omdSecretsPath(env) : 'env'})`;
}

export interface GenerationRecord {
  /** 归到哪条 trace。给 sessionId 就用它 —— 一次 run 的所有调用因此落进同一条 trace。 */
  traceId: string;
  /** 观测名(角色/节点名,如 `omd-leaf` / `conductor`)。Langfuse 上按它分组看。 */
  name: string;
  /**
   * 这一发属于哪个 DAG 节点 —— 给了就挂到那个节点的 span 下,没给就挂 trace 根。
   *
   * **为什么是显式字段而不是从 {@link name} 里切**(2026-07-31 修):此前的做法是把
   * `<相位>:<后缀>` 的后缀当节点 id,注释还写着"认不出 → 挂根上,不硬凑一个父"。
   * 可它根本认不出来 —— `conductor:<nodeId>`(子图展开,后缀**是**节点)与
   * `conductor:plan` / `conductor:repair` / `classify:acceptance`(run 级调用,后缀**不是**节点)
   * 字符串形状完全一样。于是 `conductor:plan` 被凑了个叫 `plan` 的父,而那个 span 从未发出过
   * —— live trace 上就是一条父指向虚空的孤儿。
   *
   * 区分它们的信息只存在于调用点,所以就由调用点给。省略 = 挂根,这次是真的挂根。
   */
  nodeId?: string;
  model: string;
  /** 原样的请求消息 —— **这就是我们要审查的 prompt**。 */
  input: unknown;
  output: string;
  usage?: ModelUsage;
  startTime: Date;
  endTime: Date;
  /**
   * 这条 trace 的人可读名(= 这一跑在干什么)。只有该 trace 的**第一条** generation 说了算,
   * 之后的忽略 —— trace 头只发一次。省略 = `omd-run`。
   */
  traceLabel?: string;
  /** system 段的版本哈希(见 {@link promptVersionOf})。省略 = 不登记版本。 */
  promptVersion?: string;
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

/** 版本身份进 metadata: prompt 版本 + 引擎 commit。两者一起才定得住"这一发是哪一版跑的"。 */
const versionMeta = (rec: GenerationRecord): Record<string, string> => ({
  ...(rec.promptVersion ? { promptVersion: rec.promptVersion } : {}),
  engineCommit: engineCommitId(),
});

const clip = (s: string): string => (s.length > MAX_FIELD_CHARS ? `${s.slice(0, MAX_FIELD_CHARS)}\n…[truncated ${s.length - MAX_FIELD_CHARS} chars]` : s);
const clipDeep = (v: unknown): unknown => (typeof v === 'string' ? clip(v) : JSON.parse(clip(JSON.stringify(v ?? null))) as unknown);

/**
 * **节点 id → 确定性 observation id**(2026-07-31,父子结构用)。
 *
 * 为什么要确定性而不是随机 uuid:父子关系要建立,子调用就得知道父 span 的 id。
 * 随机 id 意味着要把它从"节点开始执行"一路穿到"每一个模型调用",穿过五六层函数签名 ——
 * 而**同一条 trace 里同一个节点只有一个 span**,那么 `hash(traceId + nodeId)` 就已经是它的名字了。
 * 于是父子两边各自算一遍,算出来必然相等,**一个参数都不用传**。
 */
function observationId(traceId: string, nodeId: string): string {
  return new Bun.CryptoHasher('sha1').update(`${traceId}\u0000${nodeId}`).digest('hex').slice(0, 32);
}

/**
 * **父节点**:子节点 id 是 `<父>::<内容寻址后缀>`(D-B),所以父子关系**写在 id 里**,
 * 不需要另外记账。没有 `::` = 顶层节点,父是 trace 根。
 */
function parentNodeIdOf(nodeId: string): string | null {
  const i = nodeId.indexOf('::');
  return i > 0 ? nodeId.slice(0, i) : null;
}

/**
 * 记一个**节点级 span** —— 让一条 trace 打开就是**整张图的形状**,而不是一串平铺的调用。
 *
 * 与 generation 的分工:generation 是"打了一发模型",span 是"这个节点跑了多久、成没成"。
 * `command` 节点一次模型都不打, 此前在观测面上**完全不存在** —— 而它们常常是验收闸,
 * 一张图少了它们就不是那张图。
 */
export function recordSpan(
  rec: { traceId: string; nodeId: string; kind: string; status: string; startTime: Date; endTime: Date; failureKind?: string },
  env: Record<string, string | undefined> = process.env,
): void {
  if (!resolveLangfuseConfig(env)) return;
  const parent = parentNodeIdOf(rec.nodeId);
  queue.push({
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    type: 'span-create',
    body: {
      id: observationId(rec.traceId, rec.nodeId),
      traceId: rec.traceId,
      name: `${rec.kind}:${rec.nodeId}`,
      startTime: rec.startTime.toISOString(),
      endTime: rec.endTime.toISOString(),
      ...(parent ? { parentObservationId: observationId(rec.traceId, parent) } : {}),
      ...(rec.status !== 'done' ? { level: 'WARNING', statusMessage: rec.failureKind ?? rec.status } : {}),
      metadata: { nodeId: rec.nodeId, kind: rec.kind, status: rec.status },
    },
  });
  scheduleFlush(env);
}

/**
 * **prompt 版本身份**(2026-07-31)。
 *
 * owner 问要不要把 prompt 登记进 Langfuse 的 Prompt Management —— **不**:那会把真源挪进 UI
 * (绕过 code review)、并且 UI 里改一个字就打掉全仓的 prompt-cache 而**没有任何 diff 看得见**
 * (`LEAF_SYSTEM_PREFIX` 那段"字节稳定"的注释正是为它写的)。
 *
 * 但"可持续优化迭代"这个需求是对的, 换个给法: 登记的是**版本身份**而不是 prompt 本身 ——
 * system 段的哈希 + 引擎 commit。于是 Langfuse 上做得了这件事:
 * 「用 A 版前缀的那 200 次」vs「用 B 版的那 200 次」并排比收敛率/成本/轮数。
 * 而 prompt 的真源仍在 git、仍要过 review、字节仍然稳定。
 */
export function promptVersionOf(messages: unknown): string {
  const sys = Array.isArray(messages)
    ? (messages as { role?: string; content?: unknown }[]).find((m) => m.role === 'system')?.content
    : undefined;
  const text = typeof sys === 'string' ? sys : sys === undefined ? '' : JSON.stringify(sys);
  return promptVersionOfText(text);
}

/**
 * 同一个哈希, 给**没有 system 段**的调用面用 —— agent leaf 就是这一类:
 * 它不经 gateway、整份指令都在 user prompt 里, 所以 {@link promptVersionOf} 对它恒返回空串的哈希。
 *
 * ⚠ 传进来的必须是**节点无关**的那一段(脚手架), 不是整条 prompt。整条里含本节点的 goal 与上游材料,
 * 逐节点都不同 —— 那样算出来的"版本"每个节点一个值, 分不了组, 等于没有版本。
 */
export function promptVersionOfText(text: string): string {
  return new Bun.CryptoHasher('sha1').update(text).digest('hex').slice(0, 12);
}

/** 引擎 commit(懒算一次;算不出 → `unknown`,不猜)。 */
let engineCommit: string | null = null;
export function engineCommitId(): string {
  if (engineCommit === null) {
    try {
      const p = Bun.spawnSync(['git', 'rev-parse', '--short', 'HEAD']);
      engineCommit = p.success ? new TextDecoder().decode(p.stdout).trim() || 'unknown' : 'unknown';
    } catch {
      engineCommit = 'unknown';
    }
  }
  return engineCommit;
}

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
      // name 用这一跑的目标而不是常量 'omd-run': Langfuse 的列表页是按 name 认 trace 的,
      // 全叫一个名字等于**一屏一模一样的行**, 要点进去才知道哪条是哪条。
      body: { id: rec.traceId, name: rec.traceLabel?.slice(0, 120) || 'omd-run', sessionId: rec.traceId, timestamp: now, tags: ['omd'], metadata: { source: 'oh-my-dag' } },
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
      // 挂到本节点的 span 上 —— span id 两边各算一遍确定性 id, 不用传 (见 observationId 的注);
      // 但"属不属于某个节点"必须由调用点说 (见 GenerationRecord.nodeId 的注)。
      ...(rec.nodeId ? { parentObservationId: observationId(rec.traceId, rec.nodeId) } : {}),
      ...(rec.usage
        ? {
            usage: { input: rec.usage.in, output: rec.usage.out, total: rec.usage.in + rec.usage.out, unit: 'TOKENS' },
            // cacheHit 不进 usage 而进 metadata: Langfuse 的 usage 三格是它自己算钱用的,
            // 塞第四个数进去它不认; 而我们的成本账本来就在 cost-ledger 里算 (那才是真源)。
            ...(rec.usage.cacheHit !== undefined ? { metadata: { ...rec.metadata, cacheHit: rec.usage.cacheHit, ...versionMeta(rec) } } : {}),
          }
        : {}),
      ...(rec.usage?.cacheHit === undefined ? { metadata: { ...rec.metadata, ...versionMeta(rec) } } : {}),
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
