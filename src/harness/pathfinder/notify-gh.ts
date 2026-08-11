/**
 * src/harness/pathfinder/notify-gh —— `waiting_human` 超时提醒的 **gh 通道** (O-1 终裁, 2026-08-11)。
 *
 * owner 定向: 「waiting_human 提醒走 TUI+GH, GH 要尽量实时, 因为我可能经常不在 TUI 面前」。
 * 落点选**在对应 issue 上落一条评论**: GitHub 的 issue 通知天然推手机/邮件, 是这套里唯一
 * 不要求人开着某个程序就能触达的通道 (TUI 那条是另一线, 接口 `WaitingHumanNotifier` 同一个插口)。
 *
 * 这条评论**一件事两用**:
 *   ① 给人看的提醒 (等了多久 · 自何时 · 下一步在**手机上**就能按的把手);
 *   ② 给机器读的 `**stale-at**` 锚 —— gh 后端没有本地盘, 票上的 `staleAt` 只能存在 gh 上,
 *      而它正是"同一轮超时不重复提醒"的幂等键 (靠状态不靠记忆)。
 *
 * ⚠ 幂等键**必须**是我们自己写进正文的 ISO 串, 不许读评论的服务端 `createdAt`:
 *    响应里少一个字段 = 幂等键消失 = 每次 sweep 都重发一条提醒 (刷屏)。
 *    `ruledAt` 那一戳可以读 `createdAt` (缺了只是读数缺失, fail-safe), 幂等键不可以。
 *
 * 写与读同一处定型 (`ghWaitingReminderBody` ↔ `parseStaleAt`), 防两边漂移 —— 同 backend-gh
 * 的 `suggestionLogBody`/`parseSuggestionLog` 惯例。
 */
import type { GhRunner } from './backend';
import type { WaitingHumanNotifier } from './frontier';
import type { WaitingLogEntry } from './types';

/** 机器锚行的键 (写与读共用一个常量, 不许两边各写一遍字面串)。 */
const STALE_ANCHOR = 'stale-at';

/** `#31` / `31` → gh CLI 收的纯 number 串; 不是 issue 号形状 → null (md 的 `g1` 走这条)。 */
function issueNumberOf(ticketId: string): string | null {
  const m = ticketId.match(/^#?(\d+)$/);
  return m ? m[1]! : null;
}

/**
 * 一条超时提醒的评论正文 (人读的三行 + 机器读的一行锚)。
 *
 * 下一步把手给的是**评论指令** (`/rule` · `/confirm`) 而不是只给 `path_rule`: owner 收到这条
 * 通知时人在手机上, 评论是他当场能按的唯一把手 (评论指令折入见 afk-hook.reflowOwnerCommands)。
 * 两个指令都列: WaitingLogEntry 里没有票的状态/类型, 编不出"你这张该用哪个"——
 * 与其猜一个写死, 不如两个都摆出来 (猜错的代价是把人引到一条会被拒的路上)。
 */
export function ghWaitingReminderBody(entry: WaitingLogEntry): string {
  const hours = Math.floor(entry.waitedMs / 3_600_000);
  return [
    `**waiting-human**: 这张票在等人裁, 已超时 — 标 stale + 台账留痕 (D-5/G-5)。`,
    ``,
    `- 已等 ${hours}h (自 ${entry.waitingSince})`,
    `- 下一步: 直接在本 issue 评论 \`/rule <判词>\` 裁掉它 (机器建议票用 \`/confirm accept|reject\`); 在电脑前也可走 \`path_rule\`。`,
    `- 盘上 map 是唯一真源 (D-4): 手改 issue 状态**不算**裁决, 下次同步会被以盘为准盖掉。`,
    ``,
    `**${STALE_ANCHOR}**: ${entry.at}`,
  ].join('\n');
}

/** 从一条评论正文读回 `stale-at` 锚 (无该行 → undefined; 与上面的写法同一处定型)。 */
export function parseStaleAt(body: string): string | undefined {
  const m = body.match(new RegExp(`^\\*\\*${STALE_ANCHOR}\\*\\*:\\s*(\\S+)\\s*$`, 'm'));
  return m ? m[1]! : undefined;
}

/**
 * gh 提醒通道: 超时票 → 在对应 issue 落一条提醒评论 (= 同时把 `staleAt` 持久化到 gh)。
 *
 * **fail-loud**: gh 调用失败 / 票 id 不是 issue 号 → throw。调用方 (`sweepWaitingHuman`) 是
 * fail-open 的, 会吞掉异常但把 ticketId + 错因打到 stderr —— 于是 gh 侧没写成时:
 * `stale-at` 锚没落地 → 下一轮 sweep 重新判定为超时 → 自动重发 (自愈), 而不是静默漏掉一次提醒。
 */
export function createGhWaitingNotifier(gh: GhRunner): WaitingHumanNotifier {
  return (entry: WaitingLogEntry): void => {
    const n = issueNumberOf(entry.ticketId);
    if (n === null) {
      // md 的 `g1` 这类 id 进了 gh 通道 = 接线接错了; 对着不存在的 issue 乱发比不发更糟。
      throw new Error(`gh 提醒通道: 票 id "${entry.ticketId}" 不是 issue 号 (#N) — 该图不是 gh 后端?`);
    }
    const r = gh(['issue', 'comment', n, '--body', ghWaitingReminderBody(entry)]);
    if (r.exitCode !== 0) {
      throw new Error(`gh issue comment ${n} 失败 (waiting-human 提醒, exit=${r.exitCode}): ${(r.stderr || r.stdout || '').trim()}`);
    }
  };
}
