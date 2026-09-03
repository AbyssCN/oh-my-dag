/**
 * leaf-worker —— bwrap 隔离下的 **agent-leaf 子进程 worker** (2026-07-23, subprocess-per-leaf 真隔离)。
 *
 * 由 sandboxed-leaf.ts 在 `bwrap [binds] bun run <此文件>` 里跑: 进程 cwd = worktree (bwrap --chdir),
 * 主 repo 物理不可见 → 该进程内**所有**工具 (pi write/read/bash + 模型幻觉的 shell + hashline + 未来工具)
 * 与 `git show` oracle 泄漏一次性全封, 无需逐工具沙箱 (治"模型用 shell 绕过单工具沙箱"的打地鼠)。
 *
 * 协议 (全走 worktree 内文件, 避开 stdin 穿 bwrap): argv = [payloadFile, resultFile] (相对 cwd=worktree)。
 *   payload = { opts: AgentLeafRunnerOpts(JSON 安全子集, 不含 sandboxRoot/onEvent; customTools 只含 sandboxSafe
 *     声明者的元数据 —— execute 在 JSON 边界剥落, 见下方 D-9 重水化), input: {prompt, model},
 *     toolBridge?: {prefix} (有保留工具时才落; 调用经 worktree 内 req/res 文件回调父进程真执行) }
 *   result  = { ok:true, result: AgentLeafResult } | { ok:false, error }
 *
 * ⚠ 本 worker 必须在 **worktree 内**跑 (worktree = HEAD 全量 checkout, 含完整 harness 代码; 只 targetPaths
 *   被清空) —— 依赖链 (agent-leaf/hashline/model) 在 worktree 内解析, node_modules ro-bind 自主 repo。
 *   故改动须**提交**后 eval worktree (从 HEAD checkout) 才含本 worker。
 */
import './script-bootstrap';
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import type { AgentToolResult } from '@earendil-works/pi-agent-core';
import { bootstrapModelRuntime } from '../model/bootstrap';
import { createAgentLeafRunner, type AgentLeafRunnerOpts } from './agent-leaf';
import type { AgentLeafInput, AgentLeafResult, AgentLeafRunner } from './leaf-runners';
import type { AnyOmdTool } from './agent-tools';

export interface LeafWorkerPayload {
  opts: Record<string, unknown>;
  input: AgentLeafInput;
  toolBridge?: { prefix: string };
}

export interface LeafWorkerDeps {
  createRunner?: (opts: AgentLeafRunnerOpts) => AgentLeafRunner;
}

/**
 * D-9 文件桥: 把一次扩展工具调用交给**父进程的原有 customTools 实例**执行, 等结果回来。
 * 请求/响应走 worktree 内文件 (与 payload/result 同一通道, 避开 stdin 穿 bwrap), 写 tmp+rename
 * 保原子 —— 对端只会在文件完整后看见它。不另设等待上限: 父进程死了 → 外层超时杀手收尸,
 * 响应永远不来等价于 worker 挂起, 由同一把超时刀响亮收场。
 */
async function callParentTool(
  prefix: string,
  n: number,
  name: string,
  id: string,
  params: unknown,
): Promise<AgentToolResult<any>> {
  const resFile = `${prefix}-res-${n}.json`;
  writeFileSync(`${prefix}-req-${n}.json.tmp`, JSON.stringify({ name, id, params }));
  renameSync(`${prefix}-req-${n}.json.tmp`, `${prefix}-req-${n}.json`);
  for (;;) {
    await new Promise((r) => setTimeout(r, 25));
    if (!existsSync(resFile)) continue;
    const res = JSON.parse(readFileSync(resFile, 'utf8')) as { ok: boolean; result?: unknown; error?: string };
    rmSync(resFile, { force: true });
    if (res.ok) return res.result as AgentToolResult<any>;
    throw new Error(`[leaf-worker] 扩展工具 "${name}" 父进程执行失败: ${res.error ?? '未知'}`);
  }
}

/**
 * 消费父进程落下的单次调用载荷。抽成可导出函数是为了让 JSON 边界可直接验:
 * profile/touchSession 等调用期字段必须留在 input 上, 不能在 worker 里重建或丢掉。
 */
export async function runLeafWorkerPayload(
  payload: LeafWorkerPayload,
  deps: LeafWorkerDeps = {},
): Promise<AgentLeafResult> {
  // cwd = process.cwd() (= worktree, bwrap --chdir 设); sandboxRoot 清掉 → in-process 路径 (bwrap 已是隔离)。
  // SDD S3: 引擎侧 session 经 input 传 (runner 每 leaf 新建一次, 静态 session 即可, 无需 ALS)。
  // D-9: sandboxSafe 工具的 decl (元数据) 过线, execute 在 JSON 边界剥落 → 这里重水化成**文件桥代理**
  // (不是 stub): 调用回调父进程, 由父进程原有实例真执行 (ext host 仍按 cwd 共享, 本进程不 loadExtension)。
  // 有保留工具而桥不在 = 父侧装配坏了 → 当场响亮失败, 不留裸 `execute is not a function`, 更不冒充可执行。
  const decls = Array.isArray(payload.opts.customTools) ? (payload.opts.customTools as AnyOmdTool[]) : [];
  // P3 S6b × D-9 (2026-09-04): 按调用的 face.customTools (conductor 七张卡) 同样是 decl 过线、execute 在父进程 ——
  // 与 opts 那份走同一座桥、同一条「有工具无桥 → 响亮拒」的闸。此前这里不重水化 face → jail 里的 conductor 派不出任何卡。
  const faceDecls = Array.isArray(payload.input.face?.customTools) ? (payload.input.face!.customTools as AnyOmdTool[]) : [];
  const bridgePrefix = payload.toolBridge?.prefix;
  if ((decls.length > 0 || faceDecls.length > 0) && typeof bridgePrefix !== 'string') {
    throw new Error('[leaf-worker] 有 sandboxSafe 扩展工具或 face 卡但 payload 无 toolBridge —— 拒绝以不可执行的假工具起叶');
  }
  let callSeq = 0;
  const rehydrate = (t: AnyOmdTool): AnyOmdTool => ({
    ...t,
    execute: (id: string, params: unknown) => callParentTool(bridgePrefix!, ++callSeq, t.name, id, params),
  });
  const customTools = decls.length > 0 ? decls.map(rehydrate) : undefined;
  const input: AgentLeafInput =
    faceDecls.length > 0 ? { ...payload.input, face: { ...payload.input.face!, customTools: faceDecls.map(rehydrate) } } : payload.input;
  const runner = (deps.createRunner ?? createAgentLeafRunner)({
    ...payload.opts,
    cwd: process.cwd(),
    sandboxRoot: undefined,
    ...(payload.input.touchSession ? { touch: { session: payload.input.touchSession } } : {}),
    ...(customTools ? { customTools } : {}),
  } as AgentLeafRunnerOpts);
  return runner(input);
}

async function main(): Promise<number> {
  const payloadFile = process.argv[2];
  const resultFile = process.argv[3];
  if (!payloadFile || !resultFile) {
    process.stderr.write('[leaf-worker] 用法: leaf-worker <payloadFile> <resultFile>\n');
    return 2;
  }
  try {
    const payload = JSON.parse(readFileSync(payloadFile, 'utf8')) as LeafWorkerPayload;
    bootstrapModelRuntime();
    const result = await runLeafWorkerPayload(payload);
    writeFileSync(resultFile, JSON.stringify({ ok: true, result }));
  } catch (e) {
    writeFileSync(resultFile, JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }));
  }
  return 0;
}

if (import.meta.main) process.exit(await main());
