#!/usr/bin/env bun
/**
 * scripts/bench-call —— bench-bridge 的一次性调用子进程 (2026-08-26)。
 *
 * 为什么存在: 实测 (n=14) claude-code 通道对**同一份大 prompt**, 一次性进程直调 5/5 干净 JSON,
 * bridge 长驻进程内调用 9/9 退化为 CC 角色扮演 (env/cwd/并发互斥三个假设逐一排除后仍复现;
 * 小 prompt 在长驻进程内 2/2 干净)。机理待查 (票: 长驻事件循环下 SDK spawn 行为差异),
 * 先按被证明干净的形状隔离: 每请求一个子进程, 状态污染被进程边界物理切断。
 *
 * 协议: 入参 JSON {coord, messages, maxTokens?, temperature?, topP?} 走 **argv[2] 指向的文件**;
 * 没给 argv[2] 时回落读 stdin (本文件初版的形状, 留着兼容手工调用)。
 * stdout 出 JSON {ok:true, text, usage} 或 {ok:false, error}。退出码恒 0 (错误在 payload 里)。
 *
 * ⚠ 2026-08-27 修: 桥在 `16624fa8` 改成写临时文件 + argv 传路径, 本文件却还在读 stdin。
 * 于是 translate 通道 (gpt / opus 座) 每一发都在 `JSON.parse('')` 抛 SyntaxError —— 抛在
 * try 之外, stdout 一个字节没有, 桥只看见 `empty subprocess output` 记 502。实测账:
 * 观测盘 332 次 gpt-5.6-sol 调用 **零成功**, 即跨模型 verifier 从那天起就没通过电。
 * minimax 座没露出来是因为它走字节级透传道 (be3555d1), 根本不经过本文件。
 */
import { callModel } from '../src/model/index';
import { bootstrapModelRuntime } from '../src/model/bootstrap';

bootstrapModelRuntime();

const payloadPath = Bun.argv[2];
const raw = payloadPath ? await Bun.file(payloadPath).text() : await Bun.stdin.text();
const input = JSON.parse(raw) as {
  coord: string;
  messages: import('../src/model/types').ModelMessage[];
  maxTokens?: number;
  temperature?: number;
  topP?: number;
};

try {
  const res = await callModel({
    messages: input.messages,
    model: input.coord,
    ...(input.maxTokens !== undefined ? { maxTokens: input.maxTokens } : {}),
    ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
    ...(input.topP !== undefined ? { topP: input.topP } : {}),
  });
  process.stdout.write(JSON.stringify({ ok: true, text: res.text, usage: res.usage }));
} catch (e) {
  process.stdout.write(JSON.stringify({ ok: false, error: (e as Error).message }));
}
