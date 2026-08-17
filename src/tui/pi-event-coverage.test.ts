/**
 * src/tui/pi-event-coverage —— **pi 事件词表的覆盖闸**(2026-08-14)。
 *
 * ## 为什么要有它:三个坑同一形状
 *
 * `pi-agent-core` 的模块台账钉着一条不变量:**没记过的东西不存在** —— 每个导出必须落进
 * 「欠账 / 有理由不用 / 已用 / 不适用」四档之一。那条闸守的是**符号面**。
 *
 * 而 2026-08 连着三个坑全在**事件面**,符号面一个都没拦住:
 *
 * | 坑 | pi 发了吗 | omd |
 * |---|---|---|
 * | 思维链看不到(owner 原话) | `thinking_delta` 一直在发 | `mapAgentEvent` 只映射 `text_delta` |
 * | 工具结果看不到 | `tool_execution_end.result.details` 一直在 | 丢掉 |
 * | bash 输出不流式,「在跑」与「卡死」屏上一样 | `tool_execution_update` + `onUpdate`/`onChunk` | **两条通道都没接** |
 *
 * 三次都不是"pi 没给",是**接缝上丢在地上**。而丢掉一个事件**不报错、不红、没有任何痕迹** ——
 * 那正是本仓最怕的一族。事件词表是**有限且可枚举**的,所以这件事不该靠人记得去查。
 *
 * ## 判据:每一种要么映射,要么在下面这张表里写明为什么不映射
 *
 * 豁免表**必须写理由**,而且理由要说清"不映射之后屏上少了什么、为什么不要紧"。
 * pi 升版新增一种事件 → 它既不在实装里也不在豁免表里 ⇒ **当场红**。
 * 这就是把「猜坑」换成「跑一条命令」。
 *
 * ⚠ 判据源是 **pi 的 `.d.ts`**,不是抄一份词表进来 —— 抄的那份会漂,而漂了不报错。
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// 两个锚**必须分家** (2026-08-17 修, W2 收编时全量回归 3 假红抓出; 前一半 2026-08-14 修过 cwd 锚):
// - 源码锚 SRC_ROOT = 模块位置上两级 —— worktree 里就测 worktree 的源, 锚到主仓会静默测错文件;
// - 依赖锚 DEPS_ROOT = 从源码锚**向上找** node_modules —— worktree 没有这个目录 (bun 跑测试
//   也是这样向上解析 import 的, 两者同路才不会"import 解析得到、readFileSync 读不到")。
// 找不到时回落源码锚, 让 ENOENT 自己响 —— 静默跳过会把"判据源丢了"藏成永绿。
const SRC_ROOT = join(import.meta.dir, '..', '..');
const DEPS_ROOT = (() => {
  let dir = SRC_ROOT;
  while (true) {
    if (existsSync(join(dir, 'node_modules', '@earendil-works'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return SRC_ROOT;
    dir = parent;
  }
})();
const CORE_TYPES = 'node_modules/@earendil-works/pi-agent-core/dist/types.d.ts';
const AI_TYPES = 'node_modules/@earendil-works/pi-ai/dist/types.d.ts';
const BACKEND = 'src/tui/backend-embedded.ts';

/** 从一段 `.d.ts` 联合类型里抽出所有 `type: "xxx"` 判别符。 */
function discriminants(source: string, unionDecl: string, span = 2600): string[] {
  const i = source.indexOf(unionDecl);
  if (i < 0) throw new Error(`在 .d.ts 里找不到 ${unionDecl} —— pi 改了声明形状, 这条闸要跟着改`);
  const seg = source.slice(i, i + span);
  return [...new Set([...seg.matchAll(/type:\s*"([a-z_]+)"/g)].map((m) => m[1] as string))].sort();
}

/**
 * **豁免表** —— 每条都要说清:不映射之后屏上少了什么,以及为什么那不要紧。
 *
 * ⚠ 写「暂时不需要」不算理由。判据是:**读完这条,下一个人能判断它该不该翻案**。
 */
const AGENT_EVENT_EXEMPT: Readonly<Record<string, string>> = {
  agent_start: '整轮开跑。UI 的等待指示器由 `submit` 那侧自己起停(轮飞着 = turnInFlight),不需要引擎再说一遍;两处各管一次反而会打架。',
  agent_end: '整轮收尾。UI 靠 `session` 事件收尾(那条同时带 pressure/usage,是收尾必须画的东西)。再接一条 agent_end 会变成两个收尾点。',
  turn_start: '模型单轮开始。omd 的「一轮」= 用户一句话(可能含多个模型轮),与 pi 的 turn 不同义 —— 画出来会让人以为发了多句。',
  turn_end: '同上,且轮内 token 账由 `agent.ts` 逐条 `emitModelUsage` 记,不靠这个事件。',
  message_start: '一条 assistant 消息开始。正文的开条目由 `text_delta` 的首片隐式完成(ChatLog 的流式追加),不需要显式开条。',
  message_end: '一条 assistant 消息结束。收条目由 `session` 事件与 `thinking_end` 管;这里再收一次会把多消息轮的第二条正文顶掉。',
};

const ASSISTANT_EVENT_EXEMPT: Readonly<Record<string, string>> = {
  text_start: '正文块开始。首片 `text_delta` 已隐式开条(`appendAssistantChunk` 没有开条目就新建),显式开条会多出一条空气泡。',
  text_end: '正文块结束,带整块 content。omd 走增量(delta)不走整块 —— 两者都接会把同一段文字画两遍。',
  thinking_start: '思考块开始。同 `text_start`:首片 `thinking_delta` 已隐式开条。',
  toolcall_start: '工具调用参数开始流式到达。omd 画的是 `tool_execution_start`(参数已完整),那才是「它要做什么」有答案的时刻;逐字符画参数会让工具行在成形前一直抖。',
  toolcall_delta: '工具调用参数的增量片段(JSON 字符串逐段到达)。半截 JSON 解不出路径也解不出命令,画出来是一行会变形的乱码;等 `tool_execution_start` 拿到完整 args 才有信息。',
  toolcall_end: '参数成形。`tool_execution_start` 紧随其后且带完整 args,两者信息等价 —— 都接会让同一个工具在屏上开两行。',
  done: '整条 assistant 消息成功收尾。收尾走 `session` 事件(见 agent_end)。',
  error: 'provider 错误。**不在这里接是刻意的**:`agent.ts` 按 C-5b 纪律在轮级把 `stopReason==="error"` 连同 errorMessage 上抛,由 `sendChat` 的 catch 画成 notice + 进日志。在事件流里再画一次会让同一个错误出现两遍,而其中一遍没有原文。',
};

/** 后端源码里出现 `'xxx'` 即视为已映射 —— 判据是**实装文本**,不是另抄一份清单。 */
const mapped = (backend: string, name: string): boolean => backend.includes(`'${name}'`);

describe('pi 事件词表覆盖闸 —— 每一种要么映射, 要么写明为什么不', () => {
  const backend = readFileSync(join(SRC_ROOT, BACKEND), 'utf8');

  /**
   * 反向自检(实跑,两刀):
   *   ① 把 `mapAgentEvent` 里 `tool_execution_update` 那一支删掉 → 第一条当场红
   *      (它既不在实装里, 豁免表里也没有它)。
   *   ② 往豁免表里加一个 pi 根本没有的名字 → 第三条当场红(豁免了一个不存在的事件 =
   *      表在漂, 而漂掉的那条会让人以为某个事件"已经想过了")。
   */
  test('★ AgentEvent 的每一种都有着落(映射 / 豁免)', () => {
    const all = discriminants(readFileSync(join(DEPS_ROOT, CORE_TYPES), 'utf8'), 'export type AgentEvent', 4000);
    expect(all.length).toBeGreaterThan(5); // 解析真的解出东西了 —— 空集合会让这条恒绿
    const orphans = all.filter((e) => !mapped(backend, e) && !(e in AGENT_EVENT_EXEMPT));
    expect(orphans).toEqual([]);
  });

  test('★ AssistantMessageEvent 的每一种都有着落', () => {
    const all = discriminants(readFileSync(join(DEPS_ROOT, AI_TYPES), 'utf8'), 'export type AssistantMessageEvent');
    expect(all.length).toBeGreaterThan(8);
    const orphans = all.filter((e) => !mapped(backend, e) && !(e in ASSISTANT_EVENT_EXEMPT));
    expect(orphans).toEqual([]);
  });

  /**
   * ★ **反向**:豁免表里不许有 pi 根本没有的名字。
   *
   * 少了这条,豁免表会变成一个只进不出的坟场 —— pi 删掉一个事件之后,那条豁免
   * 还在,读的人会以为"这件事想过了",而它想的是一个已经不存在的东西。
   */
  test('★ 豁免表里没有幽灵条目(pi 删掉一种事件时, 对应豁免也要跟着删)', () => {
    const core = discriminants(readFileSync(join(DEPS_ROOT, CORE_TYPES), 'utf8'), 'export type AgentEvent', 4000);
    const ai = discriminants(readFileSync(join(DEPS_ROOT, AI_TYPES), 'utf8'), 'export type AssistantMessageEvent');
    expect(Object.keys(AGENT_EVENT_EXEMPT).filter((k) => !core.includes(k))).toEqual([]);
    expect(Object.keys(ASSISTANT_EVENT_EXEMPT).filter((k) => !ai.includes(k))).toEqual([]);
  });

  test('★ 豁免理由不许敷衍 —— 每条至少说清「少了什么」', () => {
    for (const [k, why] of Object.entries({ ...AGENT_EVENT_EXEMPT, ...ASSISTANT_EVENT_EXEMPT })) {
      expect(why.length, `${k} 的豁免理由太短`).toBeGreaterThan(30);
      // 「暂时」「以后」「不需要」这类词单独出现 = 没有判据, 下一个人无法判断该不该翻案。
      expect(why, `${k} 的豁免理由是敷衍词`).not.toMatch(/^(暂时|以后|不需要|用不上)[^,，]*$/);
    }
  });

  /**
   * ★ 已映射的那几种**真的在实装里**,不是碰巧出现在注释里。
   * 判据锚 `e.type === '<name>'` 这个形状 —— 注释里写的是散文,不长这样。
   */
  test('★ 声称映射的那几种, 判别式真的在代码里', () => {
    for (const name of ['message_update', 'tool_execution_start', 'tool_execution_update', 'tool_execution_end']) {
      expect(backend, name).toContain(`e.type === '${name}'`);
    }
    for (const name of ['text_delta', 'thinking_delta', 'thinking_end']) {
      expect(backend, name).toContain(`assistantMessageEvent.type === '${name}'`);
    }
  });
});
