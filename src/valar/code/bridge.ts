/**
 * src/valar/code/bridge —— code mode 的**工具桥** (子进程 ↔ 父进程编排工具)。
 *
 * code mode = 模型在隔离子进程里写代码串调多工具 + 循环/条件处理数据, 只回最终结果 (省 token)。
 * 子进程跑不了父进程的 in-process 工具闭包 (web_search/mcp_call …) → 经一个**临时 localhost HTTP 桥**:
 *   子进程 fetch http://127.0.0.1:<ephemeral>/call {name,args} → 父进程调真工具 → JSON 回。
 *
 * 安全 (单人信任模型够): ① 仅 127.0.0.1 ② bearer token 闸 (挡同机别的进程) ③ 用后即焚 (每次 run 起停)。
 * 桥经接口抽象 → 测试注入假桥, 不起真 server。
 */
import { randomUUID } from 'node:crypto';

/** 工具实现: 收 args (子进程 JSON.parse 后的对象), 返字符串结果 (非字符串由调用方先序列化)。 */
export type ToolFn = (args: unknown) => Promise<string> | string;
export type ToolMap = Record<string, ToolFn>;

export interface ToolBridge {
  /** 注入子进程的 JS 前导: 定义 globalThis.tools.<name>(args) → 经桥回调真工具。 */
  preamble: string;
  /** 关闭桥 (停 server)。每次 run 末必调 (用后即焚)。 */
  close(): Promise<void> | void;
}

/** 子进程前导: 把每个工具名绑成 globalThis.tools.<name>(args) → fetch 桥。 */
export function buildPreamble(port: number, token: string, names: readonly string[]): string {
  const bind = names
    .map((n) => `globalThis.tools[${JSON.stringify(n)}] = (args) => __bridge(${JSON.stringify(n)}, args);`)
    .join('\n');
  return `globalThis.tools = {};
const __bridge = async (name, args) => {
  const res = await fetch("http://127.0.0.1:${port}/call", {
    method: "POST",
    headers: { "content-type": "application/json", "authorization": "Bearer ${token}" },
    body: JSON.stringify({ name, args: args ?? {} }),
  });
  const j = await res.json();
  if (!j.ok) throw new Error("tool '" + name + "' failed: " + j.error);
  return j.result;
};
${bind}
`;
}

/**
 * 起一个临时 localhost HTTP 桥服务 tools。返回 { preamble, close }。
 * port 0 → 系统分配 ephemeral 端口 (无冲突); token 随机 → 同机别的进程调不动。
 */
export async function createHttpToolBridge(
  tools: ToolMap,
  opts: { token?: string } = {},
): Promise<ToolBridge> {
  const token = opts.token ?? randomUUID();
  const names = Object.keys(tools);
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      if (req.headers.get('authorization') !== `Bearer ${token}`) {
        return new Response('unauthorized', { status: 401 });
      }
      let body: { name?: string; args?: unknown };
      try {
        body = (await req.json()) as { name?: string; args?: unknown };
      } catch {
        return Response.json({ ok: false, error: 'bad json' }, { status: 400 });
      }
      const fn = body.name ? tools[body.name] : undefined;
      if (!fn) {
        return Response.json({ ok: false, error: `unknown tool: ${body.name}` }, { status: 404 });
      }
      try {
        const result = await fn(body.args);
        return Response.json({ ok: true, result: String(result) });
      } catch (e) {
        return Response.json({ ok: false, error: (e as Error).message });
      }
    },
  });
  const port = server.port;
  if (port == null) {
    server.stop(true);
    throw new Error('createHttpToolBridge: 端口绑定失败');
  }
  return {
    preamble: buildPreamble(port, token, names),
    close: () => {
      server.stop(true);
    },
  };
}
