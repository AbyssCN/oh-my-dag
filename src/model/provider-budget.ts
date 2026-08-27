/**
 * provider-budget.ts — MiMo 速率感知预算层 ("数桌子的" + "发号的" + "撞墙退避的")。
 *
 * MiMo 官方限流 (2026-06-08): **RPM 100 / TPM 10M** (每账号·每模型, 所有 key 之和)。
 * 三层闸 (叠加, 各管一件):
 *   ① 并发信号量 (cap = OMD_MIMO_MAX_CONCURRENCY, 默认 100) —— **突发上限** (一次最多多少在飞)。
 *      cap 高 (可设 200) = 允许突发冲高; 真正的稳态治理交给 ②。
 *   ② RPM token-bucket (OMD_MIMO_RPM, 默认 100) —— **稳态速率** (每分钟最多发 100 请求)。
 *      连续刷新发牌; priority 角色没牌就等下一张, overflow 角色没牌就溢出 fallback。
 *      ⚠️ RPM≠并发: 快调用 (mimo-v2.5 ~2s) RPM 限得紧, 慢调用 (pro ~24s) 能高并发 —— bucket 自动适配。
 *   ③ 429 指数退避 —— **撞墙安全网** (proactive 算漏了/多客户端共享账号时反应式兜底)。
 *      priority: 退避重试 (必用 MiMo); overflow: 撞 429 直接溢 fallback (ds 是泄压阀)。
 *
 * 两种角色 (调用侧给 overflowModel 区分):
 *   - **priority (无 overflowModel)**: reason/综合/终审 + 多模态 — 等并发槽 + 等 RPM 牌 + 429 退避重试 (必用 MiMo)。
 *   - **overflow (给 overflowModel)**: executor leaf — try 不等; 并发满/无 RPM 牌/撞 429 任一 → 改调 overflowModel (ds-flash)。
 *
 * 经典 counting-semaphore + 直接 hand-off: release 时若有 waiter, 槽直接转交 (不减计数)。
 * Date.now() 在 daemon src 合法 (仅 Workflow 脚本禁用)。
 */

const DEFAULT_CAP = 100; // 2026-06-08: 24→100 (官方 RPM 100; 并发是突发上限, 速率治理交给 RPM bucket)
let cap = Number(process.env.OMD_MIMO_MAX_CONCURRENCY) || DEFAULT_CAP;
let inFlight = 0;
const waiters: (() => void)[] = [];

// ---- ② RPM token-bucket ----
const DEFAULT_RPM = 100;
let rpmLimit = Number(process.env.OMD_MIMO_RPM) || DEFAULT_RPM;
let rpmTokens = rpmLimit; // 起步满桶
let rpmLastRefill = Date.now();

// ---- ③ 429 退避参数 (测试可调小) ----
let backoffBaseMs = Number(process.env.OMD_MIMO_BACKOFF_BASE_MS) || 500;
let backoffMaxAttempts = Number(process.env.OMD_MIMO_BACKOFF_ATTEMPTS) || 4;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.max(0, ms)));

function refillRpm(): void {
  const now = Date.now();
  const elapsedMin = (now - rpmLastRefill) / 60_000;
  if (elapsedMin <= 0) return;
  const add = elapsedMin * rpmLimit;
  if (add >= 0.0001) {
    rpmTokens = Math.min(rpmLimit, rpmTokens + add);
    rpmLastRefill = now;
  }
}
/** 试取一张 RPM 牌 (不等)。 */
function tryRpmToken(): boolean {
  refillRpm();
  if (rpmTokens >= 1) {
    rpmTokens -= 1;
    return true;
  }
  return false;
}
/** 等到有 RPM 牌 (priority 用)。按缺额估算下次发牌时间, 轮询直到拿到。 */
async function waitRpmToken(): Promise<void> {
  refillRpm();
  while (rpmTokens < 1) {
    const deficit = 1 - rpmTokens;
    const waitMs = Math.ceil((deficit / rpmLimit) * 60_000) + 5;
    await sleep(waitMs);
    refillRpm();
  }
  rpmTokens -= 1;
}

/**
 * 宽口径: 这是不是 429 家族。用于「**要不要溢出到备用模型**」——
 * 硬配额耗尽时溢出是对的 (换个模型确实能继续), 所以这里刻意不排除耗尽。
 */
export function is429(e: unknown): boolean {
  if (e == null) return false;
  const status = (e as { status?: number; statusCode?: number }).status ?? (e as { statusCode?: number }).statusCode;
  if (status === 429) return true;
  const msg = String((e as { message?: string }).message ?? e);
  // 中文限流文案 (`速率限制` / `请求过于频繁`) 是 2026-08-27 补的: MiniMax 的 2062 原文
  // 通篇中文, 既无 `429` 也无 `rate limit`。生产里靠 pi 把 HTTP 码写进 message
  // (形如 `pi: 429: …`) 才碰巧匹配上 —— 哪条路径丢了状态码, 这条限流就漏判成普通错误。
  return /\b429\b|too many requests|rate.?limit|rate.?limited|速率限制|请求过于频繁/i.test(msg);
}

/**
 * 硬配额耗尽 (≠ 瞬时速率限制): 退避对它毫无意义, 只是把失败拖慢。
 * 判据是**错误文案里的耗尽/余额标记**, 不是 HTTP 码 —— 两者共用 429。
 */
function isQuotaExhausted(e: unknown): boolean {
  if (e == null) return false;
  const msg = String((e as { message?: string }).message ?? e);
  return /quota exhausted|exhausted your|insufficient (balance|credit|quota)|余额不足|配额\s*(耗尽|用尽)|payment required|\b402\b/i.test(
    msg,
  );
}

/**
 * 窄口径: 值得**重试同一个模型**的限流 = 429 家族且不是硬配额耗尽。
 *
 * ⚠ 2026-08-27 实证起票, 两侧都有语料:
 * · 该退避的 —— MiniMax `2062 已达到 Token Plan 速率限制`: **随并发变化**
 *   (8 并发零命中 / 40 并发 1156 次), 退一下就过去了。
 * · 不该退避的 —— `429 weekly quota exhausted` (见 `research/fanout.test.ts` 那条):
 *   周配额耗尽, 退 4 次只是把失败拖慢十几秒, 一次都不会成功。
 */
export function isRetryableRateLimit(e: unknown): boolean {
  return is429(e) && !isQuotaExhausted(e);
}

/** 测试/运维 钩子。 */
export function setMimoCap(n: number): void {
  cap = Math.max(1, Math.floor(n));
}
export function setMimoRpm(n: number): void {
  rpmLimit = Math.max(1, n);
  rpmTokens = Math.min(rpmTokens, rpmLimit);
}
/** 测试: 重置预算闸到初始态 (满桶 + 零在飞)。 */
export function resetBudget(): void {
  inFlight = 0;
  waiters.length = 0;
  rpmTokens = rpmLimit;
  rpmLastRefill = Date.now();
}
export function setBackoffParams(baseMs: number, attempts: number): void {
  backoffBaseMs = Math.max(0, baseMs);
  backoffMaxAttempts = Math.max(0, Math.floor(attempts));
}
/** 当前在飞的 MiMo 调用数 (可观测)。 */
export function mimoInFlight(): number {
  return inFlight;
}
/** 预算状态快照 (可观测): 在飞数 / 等待数 / RPM 余牌 / 配置。 */
export function budgetStats(): { inFlight: number; waiting: number; cap: number; rpmTokens: number; rpmLimit: number } {
  refillRpm();
  return { inFlight, waiting: waiters.length, cap, rpmTokens: Math.floor(rpmTokens), rpmLimit };
}
export function isMimoModel(model: string | undefined): boolean {
  return typeof model === 'string' && model.startsWith('mimo:');
}

function acquire(): Promise<void> {
  if (inFlight < cap) {
    inFlight++;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => waiters.push(resolve)); // 被唤醒 = 槽已转交, inFlight 不变
}
function tryAcquire(): boolean {
  if (inFlight < cap) {
    inFlight++;
    return true;
  }
  return false;
}
function release(): void {
  const next = waiters.shift();
  if (next) next(); // 槽直接转交 waiter, 不减计数
  else inFlight--;
}

/** 429 指数退避重试 (priority 用; jitter 防同步重试)。 */
async function callWith429Backoff<R>(fn: () => Promise<R>): Promise<R> {
  let delay = backoffBaseMs;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      // 窄口径: 硬配额耗尽不退避 (退了也不会成功, 只把失败拖慢)。
      if (!isRetryableRateLimit(e) || attempt >= backoffMaxAttempts) throw e;
      await sleep(delay + Math.random() * delay * 0.3);
      delay *= 2;
    }
  }
}

/**
 * 用 MiMo 速率感知预算闸包一个 call 函数。Req 泛型继承真实调用签名 (保留 messages 等字段)。
 * @param rawCall 真正的模型调用 (如 callModel)。
 * @returns budgetedCall(req, overflowModel?):
 *   - 非 mimo → 直接 rawCall (DeepSeek 不闸, 受其服务端限流)。
 *   - mimo + 无 overflowModel (priority) → 等并发槽 + 等 RPM 牌 → 429 退避重试 → release。
 *   - mimo + 有 overflowModel (spillable) → try 并发槽 + try RPM 牌; 任一无 / 撞 429 → 改调 overflowModel。
 */
export function makeBudgetedCall<Req extends { model?: string }, R>(rawCall: (req: Req) => Promise<R>) {
  return async function budgetedCall(req: Req, overflowModel?: string): Promise<R> {
    // 非 mimo: 不进并发槽 / 不占 RPM 牌 (那两样是 mimo 配额模型专属), 但**仍要吃退避**。
    // ⚠ 2026-08-27 缺口: 原先这里裸 return rawCall(req) —— mimo 之外的 provider 撞限流即抛、
    // 零重试。座位切成 18/18 MiniMax 后这成了主干道: bench 一批 40 并发撞了 1156 次限流,
    // 每次都把 conductor 打成「未产出有效 plan」→ 整个 run crash, 该批 72% trial 报废。
    // 退避是纯增益: 不撞限流时零开销 (第一次就返回); 硬配额耗尽也不退 (见 isRetryableRateLimit)。
    if (!isMimoModel(req.model)) return callWith429Backoff(() => rawCall(req));

    if (overflowModel) {
      // overflow 角色 (executor leaf): 不排队 —— 并发满 / 无 RPM 牌 → 溢出。
      if (!tryAcquire()) return rawCall({ ...req, model: overflowModel } as Req);
      try {
        if (!tryRpmToken()) return rawCall({ ...req, model: overflowModel } as Req);
        try {
          return await rawCall(req);
        } catch (e) {
          if (is429(e)) return rawCall({ ...req, model: overflowModel } as Req); // 撞墙 → 溢出泄压
          throw e;
        }
      } finally {
        release();
      }
    }

    // priority 角色 (reason/多模态): 等并发槽 + 等 RPM 牌 + 429 退避重试 (必用 MiMo)。
    // 有牌时同步取 (不引入额外 await, 保热路径 + timing 敏感测试); 没牌才 await 下一张。
    await acquire();
    try {
      if (!tryRpmToken()) await waitRpmToken();
      return await callWith429Backoff(() => rawCall(req));
    } finally {
      release();
    }
  };
}
