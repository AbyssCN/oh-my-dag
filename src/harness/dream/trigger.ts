/**
 * src/harness/dream/trigger —— dream 的**点火判定**(2026-08-28)。
 *
 * ## 补的是哪一格
 *
 * dream 的实装是完整的、跑得通的,但它**没有触发器**:`runDreamAssembly` 的调用点只有
 * `assembly.ts` 内部和 `scripts/omd-dream.ts` 那个手动 CLI。`gather.ts` 里的三个阈值常量
 * `M` / `W_HOURS` / `W_SESSIONS` 定义了、导出了、**零读取方** —— 它们描述的是一个打算有的
 * 触发策略,而那个策略不存在。实测代价:上一次固化是 2026-08-10,18 天后积压 303 个脏 run。
 *
 * 本模块就是那三个常量的读取方。**纯函数,零副作用** —— 与 `session/continuity-hook.ts`
 * 同一分工:判定在这里,spawn 在薄壳里。
 *
 * ## 三条护栏, 每条都有来历
 *
 * **① 默认关(`OMD_DREAM_AUTO=1` 才开)。** dream 每批要打真模型。一个会花钱的东西默认开着,
 * 意味着任何继承本 harness 的仓一装上就开始烧。方向取安全的那边:显式打开。
 *
 * **② 冷却记在「上次尝试」而不是「上次成功」。** 唯一现成的成功水位是 `dream_watermark.updated_at`,
 * 但拿它当冷却基准有个闭环 bug:dream 失败 → 水位不推进 → 冷却永远没开始 → 下一次 Stop 又点火 →
 * 每次 Stop 烧一批钱且每次都失败。所以另记一个 attempt 标记。
 * 「上次成功」与「上次尝试」是两件事(仓规坑①),不许折叠。
 *
 * **③ 自喂闸复用 `isSdkChildSession`。** 2026-08-20 在生产盘上烧了一天六小时的 fork bomb 就是
 * 「hook 派子会话 → 子会话结束再点 hook」这条闭环(见 `session/continuity-hook.ts` 那段注)。
 * dream 的 `callModel` 走网关直连、不派 CC 子会话, 所以链**不闭**; 但判别位一分钱不要,
 * 而少了它一旦哪天 dream 改成派子会话就是同一场火。
 *
 * @module
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { logger } from '../logger';
import { M, W_HOURS, W_SESSIONS } from './gather';

/** 上次点火尝试的记录。**attempt 不是 success** —— 见模块头注护栏②。 */
export interface DreamAttemptState {
  /** 上次**尝试**时刻(epoch ms)。 */
  lastAttemptAt: number;
  /** 上次尝试的结局。`null` = 记录写于结局产出之前(进程被杀),第三种值,不许折成 failed。 */
  lastOutcome: 'ok' | 'failed' | null;
}

export type DreamTrigger =
  | Readonly<{ fire: false; why: string }>
  | Readonly<{ fire: true; batch: number; why: string }>;

/** 一次自动点火最多吃几个脏源。与 `L_MAX=12`(模型叶上限)同量级 —— 别让积压一次性烧穿预算。 */
export const AUTO_BATCH = 12;

export interface DecideDreamOpts {
  /** `gather` 报的脏源总数(零 LLM 就能拿到)。 */
  dirtyTotal: number;
  /** 脏**源**个数(session ∪ run 合计)。 */
  dirtySources: number;
  /** 上次尝试记录;从没跑过 = `null`。 */
  attempt: DreamAttemptState | null;
  /** 现在(epoch ms)。 */
  nowMs: number;
  env?: NodeJS.ProcessEnv;
  /** 自喂闸:本进程是不是 agent-SDK 子会话。 */
  isSdkChild?: boolean;
}

/**
 * 该不该自动跑一批 dream。
 *
 * 判据 = `dirtyTotal ≥ M` **且** `dirtySources ≥ W_SESSIONS` **且** 距上次尝试 ≥ `W_HOURS`。
 *
 * ⚠ `W_SESSIONS` 原文写的是「最少新**会话**数」,这里读作「最少新**源**数」。理由是实测:
 * 本仓 gather 报 303 个脏源,**全部是 run,零 session**。按字面取"会话数"的话这条闸在一个
 * 只跑 DAG 不开对话的仓里永远不成立 —— dream 一次都不会点火。而它要表达的意思("别为了
 * 一个源就烧一批")对两种源同样成立。**这是一次口径改判,不是漏读**,所以写在这里而不是
 * 悄悄不用它。
 */
export function decideDreamTrigger(opts: DecideDreamOpts): DreamTrigger {
  const env = opts.env ?? process.env;
  if (env.OMD_DREAM_AUTO !== '1') return { fire: false, why: 'OMD_DREAM_AUTO≠1 — 自动固化默认关(它要花钱)' };
  if (opts.isSdkChild === true) return { fire: false, why: '自喂闸: SDK 子会话不点火' };

  if (opts.dirtyTotal < M) return { fire: false, why: `脏条目 ${opts.dirtyTotal} < M=${M}` };
  if (opts.dirtySources < W_SESSIONS)
    return { fire: false, why: `脏源 ${opts.dirtySources} < W_SESSIONS=${W_SESSIONS}` };

  if (opts.attempt !== null) {
    const hours = (opts.nowMs - opts.attempt.lastAttemptAt) / 3_600_000;
    if (hours < W_HOURS) {
      return { fire: false, why: `距上次尝试 ${hours.toFixed(1)}h < W_HOURS=${W_HOURS}` };
    }
  }
  return {
    fire: true,
    batch: AUTO_BATCH,
    why: `脏源 ${opts.dirtySources} / 脏条目 ${opts.dirtyTotal} 过水位, 距上次尝试 ≥ ${W_HOURS}h`,
  };
}

/**
 * **互斥锁** —— 同一个仓同一时刻只许一个 dream 在跑(2026-08-28 实测补的)。
 *
 * ## 为什么非有不可(现场,不是设想)
 *
 * 开关打开后的第一次 Stop,hook 派了一批 `omd-dream.ts all`,而人手起的
 * `omd-dream.ts drain` 正跑到第 5 批 —— **两个进程同时对着同一个 memory.db 跑**。
 * 证据:hook 那侧 gather 报「126 个脏源」,而同一时刻 drain 已经推到 114。
 *
 * 后果不是数据损坏(WAL + `busy_timeout=20000` 挡得住),是**两件更贵的事**:
 * ① 两边 gather 看见重叠的脏源 → **同一批语料被抽两遍**,模型调用白花一份;
 * ② 水位写入互相覆盖,谁后写谁赢 —— 一个源被 A 抽过、水位却被 B 按自己的结果推进,
 *    于是"这个源到底被谁消费了、消费出什么"事后查不出来。
 *
 * 用 `O_EXCL` 建锁文件(与 `session/ledger.ts` 的 append 锁同一手法):原子、无依赖、
 * 进程死掉留下的陈锁按 `STALE_LOCK_MS` 判过期,不会永久堵死。
 */
export const STALE_LOCK_MS = 30 * 60 * 1000;

/** 拿锁。拿到 = `true`;已有活锁 = `false`(调用方据此不点火)。 */
export function acquireDreamLock(lockPath: string, nowMs: number = Date.now()): boolean {
  try {
    mkdirSync(dirname(lockPath), { recursive: true });
    try {
      // 'wx' = O_CREAT|O_EXCL —— 已存在就抛,这一步的原子性就是互斥本身。
      writeFileSync(lockPath, `${JSON.stringify({ pid: process.pid, at: nowMs })}\n`, { flag: 'wx' });
      return true;
    } catch (err) {
      logger.debug({ lockPath, err: (err as Error).message }, '[dream] 锁已存在 → 转判陈锁');
      // 已有锁 → 判它是不是陈的。**陈锁必须能过期**:dream 被 kill 掉不留清理机会,
      // 没有过期判据的话一次崩溃就永久关掉了自动固化(而且是静默的)。
      const raw = JSON.parse(readFileSync(lockPath, 'utf-8')) as { at?: unknown };
      const at = typeof raw.at === 'number' ? raw.at : 0;
      if (nowMs - at < STALE_LOCK_MS) return false;
      writeFileSync(lockPath, `${JSON.stringify({ pid: process.pid, at: nowMs })}\n`);
      return true;
    }
  } catch (err) {
    // 锁机制自己坏了 → **不点火**。方向取安全那边:宁可少固化一批,不可两个进程对着烧。
    // ⚠ 但**必须留一行**: 不留的话"dream 再也不自动固化了"在盘上没有任何痕迹,
    // 而这正是 fail-open 吞证据那条禁令的原形 (2026-08-29 绊线补)。
    logger.warn({ err: (err as Error).message }, '[dream] 锁机制自身失败 → 本轮不点火');
    return false;
  }
}

/** 放锁(幂等;删不掉只留给 `STALE_LOCK_MS` 兜底)。 */
export function releaseDreamLock(lockPath: string): void {
  try {
    rmSync(lockPath, { force: true });
  } catch {
    /* 删不掉 → 陈锁判据兜底, 不抛(点火链全程 fail-open) */
  }
}

/** 读上次尝试记录。没有 / 读不动 / 形状不对 → `null`(= 从没跑过, 冷却不成立)。 */
export function readDreamAttempt(statePath: string): DreamAttemptState | null {
  try {
    if (!existsSync(statePath)) return null;
    const raw = JSON.parse(readFileSync(statePath, 'utf-8')) as Partial<DreamAttemptState>;
    if (typeof raw.lastAttemptAt !== 'number') return null;
    const outcome = raw.lastOutcome;
    return {
      lastAttemptAt: raw.lastAttemptAt,
      lastOutcome: outcome === 'ok' || outcome === 'failed' ? outcome : null,
    };
  } catch (err) {
    // 读不出上次尝试记录 = 冷却窗口失忆 → 下一次 Stop 会立刻再点一批。留一行, 别让它无声发生。
    logger.debug({ statePath, err: (err as Error).message }, '[dream] 上次尝试记录读不出 → 当作没记过');
    return null;
  }
}

/**
 * 写上次尝试记录。**点火前先写 `lastOutcome: null`**,跑完再回写结局 ——
 * 顺序反过来的话(跑完才记)进程中途被杀就等于没记过,下一次 Stop 立刻又点一批。
 * 冷却必须在**掏钱之前**开始计时。
 */
export function writeDreamAttempt(statePath: string, state: DreamAttemptState): boolean {
  try {
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(statePath, `${JSON.stringify(state)}\n`);
    return true;
  } catch (err) {
    // 写不进去 = 冷却计时没开始 (见上面那段注释: 计时必须在掏钱之前开始)。
    logger.warn({ statePath, err: (err as Error).message }, '[dream] 尝试记录写入失败 → 冷却计时未开始');
    return false;
  }
}
