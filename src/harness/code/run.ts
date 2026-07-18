/**
 * src/harness/code/run —— runCodeMode: 组装前导+用户代码 → 子进程跑 → 只回 stdout。
 *
 * 复用 mcp/sandbox 的子进程 runner (隔离边界一致, 只 stdout 进 context)。
 * 桥默认 createHttpToolBridge(tools); 注入 bridge/runner → 测试不起真 server / 不 spawn。
 */
import { ctxExecute, defaultExecRunner, type ExecRunner } from '../mcp/sandbox';
import { createHttpToolBridge, type ToolBridge, type ToolMap } from './bridge';

export interface RunCodeModeOpts {
  /** 暴露给模型代码的编排工具 (globalThis.tools.<name>)。省略 = 仅原生 fetch/std 库。 */
  tools?: ToolMap;
  /** 子进程 runner (测试注入桩, 省略 = bun -e)。 */
  runner?: ExecRunner;
  /** 工具桥 (测试注入假桥, 省略 = createHttpToolBridge(tools))。 */
  bridge?: ToolBridge;
  signal?: AbortSignal;
}

/**
 * 跑 code mode: 前导 (工具桥绑定) + 用户代码 → 子进程 → stdout。
 * 桥**用后即焚** (finally close), 无残留 server。失败返含 stderr 的错误文本 (ctxExecute 语义)。
 */
export async function runCodeMode(code: string, opts: RunCodeModeOpts = {}): Promise<string> {
  const tools = opts.tools ?? {};
  const bridge = opts.bridge ?? (await createHttpToolBridge(tools));
  try {
    const program = `${bridge.preamble}\n${code}`;
    return await ctxExecute(program, 'ts', {
      runner: opts.runner ?? defaultExecRunner(),
      signal: opts.signal,
    });
  } finally {
    await bridge.close();
  }
}
