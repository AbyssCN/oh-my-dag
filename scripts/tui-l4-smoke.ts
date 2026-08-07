/**
 * scripts/tui-l4-smoke —— **L4:真引擎冒烟**(TUI SDD §9 第四层,切片 S10)。
 *
 * ## 它与 L3 的分工(这条边界必须写死)
 *
 * L3(`tui-pty-check.mjs`)跑 fixture 后端,证明 UI 循环 / 渲染 / 按键 / 流式装配是通的,
 * **不证明**引擎行为。这个脚本相反:不起 TUI、不碰终端,只把 `backend-embedded` 那条线
 * 从头到尾走一遍 —— 真座位、真 `runChatTurn`、真工具面、真会话落库。
 *
 * ## ⚠ 默认不跑,因为它**要花钱**
 *
 * 它会真的发一次模型请求。所以:
 *   - `bun test` 里没有它(它是 `scripts/`,不是 `*.test.ts`);
 *   - 不设 `OMD_L4=1` 直接退 0 并说明为什么 —— **不是静默跳过**,
 *     静默跳过的冒烟测试与不存在的冒烟测试读数一样。
 *
 * 用法:`OMD_L4=1 bun run scripts/tui-l4-smoke.ts`
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatStore } from '../src/harness/chat/store';
import { assembleOmdMcpTools, resolveEngineModels } from '../src/mcp/assemble';
import { bootstrapModelRuntime } from '../src/model/bootstrap';
import { createConductorChatTools } from '../src/serve/chat-tools';
import type { OmdTuiEvent } from '../src/tui/backend';
import { createEmbeddedBackend } from '../src/tui/backend-embedded';

if (process.env.OMD_L4 !== '1') {
  console.log('L4 冒烟未运行: 它会真发一次模型请求(要钱、要网)。要跑就 `OMD_L4=1 bun run scripts/tui-l4-smoke.ts`。');
  process.exit(0);
}

const cwd = mkdtempSync(join(tmpdir(), 'omd-tui-l4-'));
bootstrapModelRuntime();
const model = resolveEngineModels(process.env).conductorModel;
const store = new ChatStore(cwd);
const backend = createEmbeddedBackend({
  cwd,
  store,
  tools: createConductorChatTools(assembleOmdMcpTools()),
  resolveModel: () => model,
});

const events: OmdTuiEvent[] = [];
backend.onEvent = (e) => events.push(e);

const failures: string[] = [];
const check = (ok: boolean, label: string, extra = ''): void => {
  if (ok) console.log(`✓ ${label}`);
  else {
    console.error(`✗ ${label}${extra ? `\n    ${extra}` : ''}`);
    failures.push(label);
  }
};

console.log(`座位: ${backend.connection.url}`);
console.log(`工作目录: ${cwd}`);

backend.start();
// 问一句**答案可判定**的话 —— "你好"那种回什么都算对, 等于没有判据。
const res = await backend.sendChat({ sessionId: 'l4', prompt: '只回一个词: 把 17 乘以 3 的结果写出来。' });
await backend.stop();

check(res.ok, 'L4-1 一轮真对话跑通 (ok)');
const deltas = events.filter((e) => e.event === 'chat').map((e) => (e.payload as { text: string }).text);
check(deltas.length > 0, 'L4-2 收到了流式 delta (不是一次性返回)', `实得 ${deltas.length} 片`);
const reply = deltas.join('');
check(reply.includes('51'), 'L4-3 ★ 回答内容对 (17×3=51) —— 判据不是"有回复", 是回对了', reply.slice(0, 200));
const persisted = store.load('l4');
check((persisted?.messages.length ?? 0) >= 2, 'L4-4 会话真写进了 ChatStore', `实得 ${persisted?.messages.length ?? 0} 条`);
check(events.at(-1)?.event === 'session', 'L4-5 收尾发了 session 事件 (UI 靠它收尾流式)');

if (failures.length) {
  console.error(`\n✗ L4 冒烟: ${failures.length} 条不过`);
  process.exit(1);
}
console.log('\n✓ L4 冒烟全过');
