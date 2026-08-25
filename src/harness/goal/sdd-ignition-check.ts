/**
 * src/harness/goal/sdd-ignition-check —— sddPath 点火空跑闸 (D3 · SDD docs/plan/2026-08-25-d3-sdd-ignition-dryrun.md)。
 *
 * 把平铺图编译块里那块「判定 fatal 还是 fallback」的逻辑搬出来, 收成**纯函数**, 让
 * run-goal 的平铺图编译块与 goal.ts 的点火闸**共用同一份** (INV-D3-1)。抄一份必漂, 漂的
 * 后果就是「点火闸放行、worker 里照样回落」 —— 恰是本契约要消灭的病。
 *
 * 不跑判据自证 / O-6 探针 (它们要跑真命令, 要 mkdtemp 世界, 属 run-goal 的领地; 它们的红
 * 由 INV-D3-4 收成 fail-fast) —— INV-D3-5 「空跑就是空跑」。零 IO, 不读 git 不碰账本。
 *
 * 三终局:
 *   · ok       一切就绪, 平铺图可编译
 *   · fatal    致命错 (parseBreakdown 抛) —— 同步拒, 不可 force 越闸
 *   · fallback 降级条件 (verify 列推不出验收命令 / compileBreakdown 抛, 含写集并集绊线
 *               assertSeamWriteSet) —— 同步拒, 可 force (owner 越闸, 沿 INV-5 force 旧惯例)
 */
import { parseBreakdown } from './sdd-direct';
import { acceptCommandFromBreakdown, compileBreakdown } from './sdd-compile';
import { logger } from '../logger';

export type SddIgnitionCheck =
  | { readonly kind: 'ok' }
  | { readonly kind: 'fatal'; readonly err: string }
  | { readonly kind: 'fallback'; readonly reason: string };

/**
 * 纯函数: 一份 SDD 文本 → 三终局之一。毫秒级, 零 IO, 不读 git 不碰账本 (INV-D3-5)。
 *
 * Fatal 与 fallback 的边界对齐 run-goal 平铺图编译块那 try/catch 里 try 体的语义 (sdd-direct
 * 那块是同一份消费方, 单真源):
 *   · parseBreakdown 抛        → fatal (与「编译抛」是不同类别, 不可 force 越闸 —— 整份契约
 *                                 缺段或表坏, 强制跑 = 让 worker 死也不知道为什么)
 *   · verify 列推不出验收命令  → fallback (推不出 = 跑前就少一条主路径; reason 是固定的,
 *                                 没有原 exception.message 可抄)
 *   · compileBreakdown 抛      → fallback (含写集并集绊线 assertSeamWriteSet, 含乱序 / 写集
 *                                 相交 / 依赖悬空 / 反向自检越界)
 *
 * fallback 的 reason 原文带出: 调用方 (goal.ts / run-goal) 要拿它直接改 SDD, 不许改写。
 */
export function dryRunSddIgnition(sddText: string): SddIgnitionCheck {
  // 1) parseBreakdown —— 抛 = fatal。fail-loud 同 sdd-direct 的性格 (G-6): 整份契约缺段或表坏
  //    时宁可不挂票也不静默塞空, 这里的 fatal 正是为了让 caller 把这条原文进回执。
  let breakdown;
  try {
    breakdown = parseBreakdown(sddText);
  } catch (err) {
    logger.warn({ err: messageOf(err) }, '[sdd-ignition-check] parseBreakdown 抛错 → fatal (点火同步拒)');
    return { kind: 'fatal', err: messageOf(err) };
  }

  // 2) acceptCommandFromBreakdown —— undefined = fallback (verify 列推不出验收命令)。
  //    不抛错但确实没结论: 这条只能用 fallback (没原 exception.message 可抄) —— reason
  //    用 run-goal 那条 warn 同样的语义, 让调用方一眼看见「少的是验收命令, 不是别的」。
  const acceptCommand = acceptCommandFromBreakdown(breakdown);
  if (!acceptCommand) {
    return {
      kind: 'fallback',
      reason: '分解表 verify 列全空, 推不出终局验收命令 (见 sdd-compile.acceptCommandFromBreakdown)',
    };
  }

  // 3) compileBreakdown —— 抛 = fallback (含写集并集绊线 assertSeamWriteSet, 含乱序 / 写集
  //    相交 / 依赖悬空 / 反向自检越界)。reason 用原 exception.message 原样带出 —— 调用方
  //    要拿它直接改 SDD (比方说把 `docs/architecture/seams.md` 加进写集并集), 改写 =
  //    又抄一份判据, 而新一份必漂。
  try {
    compileBreakdown(breakdown, { acceptCommand });
  } catch (err) {
    logger.warn({ err: messageOf(err) }, '[sdd-ignition-check] compileBreakdown 抛错 → fallback 条件 (点火同步拒)');
    return { kind: 'fallback', reason: messageOf(err) };
  }

  return { kind: 'ok' };
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));
