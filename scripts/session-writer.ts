#!/usr/bin/env bun
/**
 * scripts/session-writer —— session 交接 checkpoint 蒸馏 CLI(W1 · D6 共享 writer 的薄壳)。
 *
 * 三方复用同一个 runWriter(单一真源):本 CLI(手动/验证)· phase-2 的 SessionEnd/Stop hook ·
 * 手动 /handoff skill。全程 fail-open —— 任何失败都 exit 0,绝不阻断调用方(hook 链)。
 *
 *   bun run scripts/session-writer.ts --transcript <jsonl> --session <id> [--final|--precompact] [--mechanical]
 *
 * script-bootstrap 首行引导:OMD_DATA_HOME=~/.omd + setActiveProject → checkpoint 落
 * ~/.omd/projects/<slug>/session/<sessionId>/,不污染当前 repo git status,也不碰 DAG-run 的 .omd/continuity/。
 *
 * 镜像层(#206, 2026-08-19 接线):这里构造 OmdMemory 传进 `runWriter({ memory })`,
 * checkpoint 才会镜像进 `namespace='continuity'`。此前这一行不存在 = 镜像层从来没被打开过,
 * 而 sink 全程 fail-open ⇒ 症状是「代码在、调用在、facts 表里 continuity 零行」。
 * safeguard 用 `CONTINUITY_SAFEGUARD` 而不是 `UNIVERSAL_SAFEGUARD`:后者的 allowedNamespaces
 * 里没有 continuity,记忆层 REJECT-by-default 会把每一次写闸掉(同样只在 `{ok:false}` 里留痕)。
 */
import '../src/harness/script-bootstrap';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { runWriter, type WriterMode } from '../src/harness/session/writer';
import { createOmdMemory } from '../src/harness/memory';
import { resolveMemoryDbPath } from '../src/harness/memory/db-path';
import { CONTINUITY_SAFEGUARD } from '../src/memory/safeguards/continuity-namespace';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const transcript = arg('transcript');
const sessionId = arg('session');
const mode: WriterMode = process.argv.includes('--final')
  ? 'final'
  : process.argv.includes('--precompact')
    ? 'precompact'
    : 'rolling';

if (!transcript || !sessionId || !existsSync(transcript)) {
  console.error(
    'usage: bun run scripts/session-writer.ts --transcript <jsonl> --session <id> [--final|--precompact] [--mechanical]',
  );
  process.exit(0); // fail-open:派遣方不感知失败
}

// 镜像层的库位置与 MCP 装配同一真源(resolveMemoryDbPath = `OMD_MEMORY_PATH ?? '.omd/memory.db'`)。
// ⚠ 它**不认 OMD_DATA_HOME**(与上面 checkpoint.md 那条路不同)⇒ 落的是 `<cwd>/.omd/memory.db`,
//   即**本进程 cwd 那个 repo** 的库。这正是要的:MCP 读面以 `cd "${CLAUDE_PROJECT_DIR:-$PWD}"`
//   起、走同一条解析,两面同库才读得回;`.omd/` 已在 .gitignore,不脏 git status。
//   派发方(scripts/session-continuity-hook.ts)因此必须带 `cwd = input.cwd` spawn 本脚本。
//   (2026-08-19 #206 修:此处原注写「⇒ 落 ~/.omd/memory.db」—— 推的,不是看的,而且是反的。)
const memoryPath = resolveMemoryDbPath(process.env);
mkdirSync(dirname(memoryPath), { recursive: true });
const memory = createOmdMemory({ path: memoryPath, safeguard: CONTINUITY_SAFEGUARD });

const res = await runWriter({
  transcript,
  sessionId,
  mode,
  mechanical: process.argv.includes('--mechanical'),
  memory,
});

console.error(
  `[session-writer] ok=${res.ok} mode=${mode} chars=${res.chars} degraded=${res.degraded} ` +
    `skipped=${res.skipped} checkpoint=${res.checkpointPath}` +
    (res.sink ? ` sink.ok=${res.sink.ok}${res.sink.error ? ` (${res.sink.error})` : ''}` : ''),
);
process.exit(0);
