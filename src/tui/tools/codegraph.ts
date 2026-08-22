/**
 * src/tui/tools/codegraph —— **符号能力,探测式 provider**(goal §4 S17)。
 *
 * ## goal 点名的判据:探测不到就**从工具列表里彻底消失**
 *
 * 不是"注册了、调了才失败"。理由不是洁癖:模型看到一个工具就会去用它,
 * 一个恒失败的工具会让 conductor 反复重试、把一轮的预算耗在一个不存在的能力上,
 * 而屏幕上只看到"它好像在忙"。**能力探测面 = 工具在不在**,与 `backend.listRuns ?` 同一条纪律。
 *
 * ## 探测是两段的,少一段就会给出垃圾答案
 *
 * ① `codegraph` 二进制在不在(`Bun.which`,与 `assemble.ts:393` 探 `bwrap` 同款);
 * ② **这个仓有没有建过索引**。二进制在、索引没建 —— 查询会返回空或报错,
 *    而模型拿到空结果的默认反应是"这个符号不存在",那是一个**看起来有答案的错答案**。
 *
 * ## 为什么走 CLI 而不是 `codegraph serve --mcp`
 *
 * MCP 那条要在 TUI 里再养一个 MCP 客户端 + 一个常驻子进程的生命周期。
 * CLI 的 `query` / `context` 给的是同一份索引的同一批事实,一次性子进程,零生命周期。
 * 真需要长连接(比如高频调用)时再换,那时这个文件的**接口不用动**。
 */
import { Type } from 'typebox';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { AnyOmdTool } from '../../harness/agent-tools';
import { logger } from '../../logger';

export type CodegraphProbe =
  | { available: true; bin: string }
  /** `reason` 一定有内容 —— 「为什么没有这个能力」是用户唯一能据以行动的东西。 */
  | { available: false; reason: string };

export interface CodegraphDeps {
  cwd: string;
  /** 注入用:找二进制。默认 `Bun.which`。 */
  which?: (bin: string) => string | null;
  /** 注入用:跑一条命令。默认真 `Bun.spawn`。 */
  run?: (bin: string, args: string[], cwd: string) => Promise<{ ok: boolean; text: string }>;
}

/** 两段探测。任一段不过 → `available: false` 且**说得出是哪一段**。 */
export function probeCodegraph(deps: CodegraphDeps): CodegraphProbe {
  const which = deps.which ?? ((b: string) => Bun.which(b));
  const bin = which('codegraph');
  if (!bin) return { available: false, reason: 'codegraph binary not found on PATH' };
  if (!existsSync(join(deps.cwd, '.codegraph'))) {
    return { available: false, reason: `${deps.cwd} not indexed yet (run codegraph index first)` };
  }
  return { available: true, bin };
}

async function defaultRun(bin: string, args: string[], cwd: string): Promise<{ ok: boolean; text: string }> {
  // ⚠ 参数走数组不拼字符串 —— 拼字符串就得处理引号转义, 而查询串来自模型。
  const p = Bun.spawn([bin, ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  const timer = setTimeout(() => p.kill(), 30_000);
  try {
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return { ok: code === 0, text: (code === 0 ? out : `${out}\n${err}`).trim() };
  } finally {
    clearTimeout(timer);
  }
}

function textTool(
  name: string,
  description: string,
  promptSnippet: string,
  parameters: ReturnType<typeof Type.Object>,
  run: (params: Record<string, unknown>) => Promise<string>,
): AnyOmdTool {
  return {
    name,
    label: name,
    description,
    promptSnippet,
    parameters,
    executionMode: 'sequential',
    async execute(_id: string, params: unknown) {
      return { content: [{ type: 'text', text: await run(params as Record<string, unknown>) }], details: undefined };
    },
  } as AnyOmdTool;
}

/**
 * @returns 探测不到 → **空数组**(工具列表里根本没有这两个名字)。
 */
export function createCodegraphTools(deps: CodegraphDeps): AnyOmdTool[] {
  const probe = probeCodegraph(deps);
  if (!probe.available) {
    // 响亮降级,同 `assemble.ts:395` 的惯例: 不是静默少两个工具, 是记一行说清缺什么。
    logger.info({ reason: probe.reason }, '[omd/tui] symbol capability (codegraph) unavailable -> tools not registered');
    return [];
  }
  const run = deps.run ?? defaultRun;
  const exec = async (args: string[]): Promise<string> => {
    const r = await run(probe.bin, args, deps.cwd);
    // 失败原文原样给模型 —— 「索引过期了」和「这个符号不存在」是两种完全不同的下一步。
    return r.ok ? r.text || '(no results)' : `[codegraph failed]\n${r.text}`;
  };

  return [
    textTool(
      'codegraph_query',
      'Search symbols in this repo by name (indexed knowledge graph, not grep).',
      'codegraph_query(q, limit?) — search symbols by name (uses the indexed knowledge graph, not grep)',
      Type.Object({ q: Type.String(), limit: Type.Optional(Type.Integer()) }),
      (p) => exec(['query', String(p.q), '-l', String(p.limit ?? 10)]),
    ),
    textTool(
      'codegraph_context',
      'Build a task-scoped context bundle (symbols + call edges + code) from the index.',
      'codegraph_context(task) — pull relevant symbols, call edges, and code for a task (one call replaces many grep+read)',
      Type.Object({ task: Type.String(), maxNodes: Type.Optional(Type.Integer()) }),
      (p) => exec(['context', String(p.task), '-n', String(p.maxNodes ?? 30)]),
    ),
  ];
}
