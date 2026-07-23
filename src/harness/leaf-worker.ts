/**
 * leaf-worker —— bwrap 隔离下的 **agent-leaf 子进程 worker** (2026-07-23, subprocess-per-leaf 真隔离)。
 *
 * 由 sandboxed-leaf.ts 在 `bwrap [binds] bun run <此文件>` 里跑: 进程 cwd = worktree (bwrap --chdir),
 * 主 repo 物理不可见 → 该进程内**所有**工具 (pi write/read/bash + 模型幻觉的 shell + hashline + 未来工具)
 * 与 `git show` oracle 泄漏一次性全封, 无需逐工具沙箱 (治"模型用 shell 绕过单工具沙箱"的打地鼠)。
 *
 * 协议 (全走 worktree 内文件, 避开 stdin 穿 bwrap): argv = [payloadFile, resultFile] (相对 cwd=worktree)。
 *   payload = { opts: AgentLeafRunnerOpts(JSON 安全子集, 不含 sandboxRoot/onEvent/customTools), input: {prompt, model} }
 *   result  = { ok:true, result: AgentLeafResult } | { ok:false, error }
 *
 * ⚠ 本 worker 必须在 **worktree 内**跑 (worktree = HEAD 全量 checkout, 含完整 harness 代码; 只 targetPaths
 *   被清空) —— 依赖链 (agent-leaf/hashline/model) 在 worktree 内解析, node_modules ro-bind 自主 repo。
 *   故改动须**提交**后 eval worktree (从 HEAD checkout) 才含本 worker。
 */
import './script-bootstrap';
import { readFileSync, writeFileSync } from 'node:fs';
import { bootstrapModelRuntime } from '../model/bootstrap';
import { createAgentLeafRunner } from './agent-leaf';

const payloadFile = process.argv[2];
const resultFile = process.argv[3];
if (!payloadFile || !resultFile) {
  process.stderr.write('[leaf-worker] 用法: leaf-worker <payloadFile> <resultFile>\n');
  process.exit(2);
}

try {
  const payload = JSON.parse(readFileSync(payloadFile, 'utf8')) as {
    opts: Record<string, unknown>;
    input: { prompt: string; model: string };
  };
  bootstrapModelRuntime();
  // cwd = process.cwd() (= worktree, bwrap --chdir 设); sandboxRoot 清掉 → in-process 路径 (bwrap 已是隔离)。
  const runner = createAgentLeafRunner({ ...payload.opts, cwd: process.cwd(), sandboxRoot: undefined });
  const result = await runner(payload.input);
  writeFileSync(resultFile, JSON.stringify({ ok: true, result }));
} catch (e) {
  writeFileSync(resultFile, JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }));
}
process.exit(0);
