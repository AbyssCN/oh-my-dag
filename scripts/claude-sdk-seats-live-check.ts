/**
 * scripts/claude-sdk-seats-live-check.ts —— S2 现场验收:worker(leaf)与终审(completion)座位。
 *
 * 【判据 —— 动手前钉死】
 * worker(claude-code:claude-sonnet-5, effort=medium, 真 leaf + 真 write 工具):
 *   ✅ ① 盘上真有 hello.txt 且内容含 nonce(真写盘,不是嘴上说)
 *      ② filesTouched 含 hello.txt 且 writeEffects 非空(emit 事件流采集在 SDK 路上工作)
 *      ③ usage.in/out > 0(累账口径通)
 * 终审(claude-code:claude-opus-5, thinkingLevel=high, callModel + responseSchema):
 *   ✅ ④ parsed.verdict === 'pass'(结构化判决走通 schema 校验回路)
 *      ⑤ usage in>0 且 model 归因 claude-code:claude-opus-5
 * ❌ 任一塌 → 记原文定方向(桥 / 采集 / schema / 归因)。
 * 对照基线:两条机械在 pi 通道全绿(agent-leaf / callModel 既有测试)—— 单一变量 = 通道。
 *
 * 跑法:bun run scripts/claude-sdk-seats-live-check.ts
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { createAgentLeafRunner } from '../src/harness/agent-leaf';
import { callModel } from '../src/model';

const nonce = randomUUID().slice(0, 8);
const cwd = mkdtempSync(join(tmpdir(), 'omd-sdk-worker-'));

try {
  // ── worker 座位 ──────────────────────────────────────────────────────────────
  const run = createAgentLeafRunner({ cwd, thinkingLevel: 'medium' });
  const leaf = await run({
    prompt: `Create a file named hello.txt (in the working root) whose entire content is exactly: ${nonce}`,
    model: 'claude-code:claude-sonnet-5',
  });
  let fileContent = '';
  try {
    fileContent = readFileSync(join(cwd, 'hello.txt'), 'utf8');
  } catch {
    /* 缺文件 = 信号①塌, 读数如实留空 */
  }

  // ── 终审座位 ─────────────────────────────────────────────────────────────────
  const judge = await callModel({
    model: 'claude-code:claude-opus-5',
    messages: [
      { role: 'system', content: 'You are a strict verifier. Reply with ONLY a JSON object {"verdict":"pass"|"fail","reason":string}.' },
      { role: 'user', content: `Claim: the string "${nonce}" has exactly 8 characters. Verify and give your verdict.` },
    ],
    responseSchema: z.object({ verdict: z.enum(['pass', 'fail']), reason: z.string() }),
    thinkingLevel: 'high',
  });

  const signals = {
    workerWroteFile: fileContent.includes(nonce),
    workerCollection: (leaf.filesTouched ?? []).includes('hello.txt') && (leaf.writeEffects?.length ?? 0) > 0,
    workerUsage: leaf.usage.in > 0 && leaf.usage.out > 0,
    judgeVerdictPass: (judge.parsed as { verdict?: string })?.verdict === 'pass',
    judgeAttribution: judge.model === 'claude-code:claude-opus-5' && judge.usage.in > 0,
  };
  console.log(
    JSON.stringify(
      {
        check: 'claude-sdk-seats-live',
        signals,
        readings: {
          worker: { text: leaf.text.slice(0, 200), usage: leaf.usage, filesTouched: leaf.filesTouched, toolCalls: leaf.toolCalls, writeEffects: leaf.writeEffects },
          judge: { parsed: judge.parsed, usage: judge.usage, attempts: judge.attempts },
        },
      },
      null,
      2,
    ),
  );
  process.exit(Object.values(signals).every(Boolean) ? 0 : 1);
} finally {
  rmSync(cwd, { recursive: true, force: true });
}
