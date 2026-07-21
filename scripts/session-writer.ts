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
 * 注:MVP 阶段不注入 OmdMemory → SQLite 镜像层为 no-op(markdown 已是真理源)。
 * W5(config 接线)交付后在此构造 createDefaultMemory 并传入 runWriter({ memory }) 打开镜像。
 */
import '../src/harness/script-bootstrap';
import { existsSync } from 'node:fs';
import { runWriter, type WriterMode } from '../src/harness/session/writer';

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

const res = await runWriter({
  transcript,
  sessionId,
  mode,
  mechanical: process.argv.includes('--mechanical'),
});

console.error(
  `[session-writer] ok=${res.ok} mode=${mode} chars=${res.chars} degraded=${res.degraded} ` +
    `skipped=${res.skipped} checkpoint=${res.checkpointPath}` +
    (res.sink ? ` sink.ok=${res.sink.ok}${res.sink.error ? ` (${res.sink.error})` : ''}` : ''),
);
process.exit(0);
