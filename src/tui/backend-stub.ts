/**
 * src/tui/backend-stub —— **引擎还没接上时的后端**(切片 S2 → S10 之间的临时真身)。
 *
 * ## 为什么是"说得出自己没接通"而不是"假装能用"
 *
 * 真后端(`backend-embedded.ts` 接 `runChatTurn`)是 S10 的活。在那之前 `omd tui`
 * 需要**某个**满足 `OmdBackend` 的东西,而这里有三种画法,只有一种是合法的
 * (conductor 冻结核 `<absent-upstream>` 的三画法):
 *
 *   ① 无源恒缺席 —— 不适用:`omd tui` 这条命令已经存在,总得有东西接。
 *   ② **断链说明卡** —— ✅ 本文件:能力面照常在,每个请求**明确拒绝并说明原因**,
 *      `connection.url` 自己就写着 `stub://engine-not-wired`。**零假数据。**
 *   ③ 灰常量即真值 —— 不适用:这里没有"当前值"可言。
 *
 * ⚠ **绝对不许**让 `sendChat` 返回一个编出来的回复。那会让 S2..S10 之间任何一次手测
 * 都读成"能用了",而这正是本仓 S-1 那一族的成因:**看起来在动,其实一次都没生效**。
 * 所以它 `ok: false` 且带原因 —— 调用方拿到的是一个**响亮的否**。
 *
 * 删除时机:S10 接上 `backend-embedded.ts` 那一刻,这个文件应当被删掉,不是被留着当 fallback。
 */
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { OmdBackend, TuiSessionMeta } from './backend';

/** 每个被拒请求都带同一句原因 —— 读的人一眼知道这不是失败,是还没做到那一片。 */
export const NOT_WIRED_REASON = '引擎后端尚未接通 (切片 S10 backend-embedded);当前 omd tui 只是 UI 壳';

export function createStubBackend(): OmdBackend {
  return {
    connection: { url: 'stub://engine-not-wired' },
    start() {},
    stop() {},
    async sendChat() {
      return { ok: false as const };
    },
    async abortChat() {
      return { ok: false as const, aborted: false };
    },
    async loadHistory(): Promise<AgentMessage[]> {
      return [];
    },
    async listSessions(): Promise<TuiSessionMeta[]> {
      return [];
    },
  };
}
