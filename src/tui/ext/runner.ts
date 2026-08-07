/**
 * src/tui/ext/runner —— **扩展子进程的入口**(S15a,2026-08-07)。
 *
 * 这个文件跑在 **bwrap 沙箱里的子进程**中,是唯一会 `import` 第三方扩展代码的地方。
 * 宿主(`host.ts`)永远不 import 扩展。
 *
 * ## shim 记账:碰过什么都记下来
 *
 * 给扩展的 `api` 是一个 Proxy。它**记录扩展碰过的每一个属性名**,包括我们没实现的 ——
 * 没实现的返回一个无害的空操作,**不当场抛**。
 *
 * ⚠ 不抛是刻意的:抛了的话拿到的是**第一个**缺的 API,而我们要的是**完整清单**,
 * 好在加载期一次把话说全("缺 ctx.fork、ctx.navigateTree")。半残地跑起来才是最坏的,
 * 但那是宿主看完清单之后决定拒绝 —— 不是靠在子进程里炸。
 *
 * 用法(宿主 spawn):`bun run runner.ts <扩展入口的绝对路径>`
 */
import { type ChildMsg, type HostMsg, type ToolDecl, decodeFrames, encodeFrame } from './protocol';

const touched = new Set<string>();
const tools = new Map<string, ToolDecl & { execute: (params: unknown) => unknown }>();
const handlers = new Map<string, (payload: unknown) => unknown>();

function send(msg: ChildMsg): void {
  process.stdout.write(encodeFrame(msg));
}

/** 记一笔并返回无害空操作 —— 见文件头:清单要完整,不在这里炸。 */
function unimplemented(name: string): (...a: unknown[]) => undefined {
  return () => {
    touched.add(name);
    return undefined;
  };
}

const api = new Proxy(
  {},
  {
    get(_t, prop: string | symbol) {
      if (typeof prop !== 'string') return undefined;
      touched.add(prop);
      if (prop === 'on') {
        return (event: string, handler: (payload: unknown) => unknown) => {
          touched.add(`on:${event}`);
          handlers.set(event, handler);
        };
      }
      if (prop === 'registerTool') {
        return (tool: ToolDecl & { execute: (...a: unknown[]) => unknown }) => {
          tools.set(tool.name, {
            name: tool.name,
            description: tool.description ?? '',
            ...(tool.promptSnippet ? { promptSnippet: tool.promptSnippet } : {}),
            parameters: tool.parameters,
            // pi 的 execute 是 (toolCallId, params, signal, onUpdate, ctx);这里只喂 params ——
            // 其余四个这一版不代理, 碰了会记进 touched 让宿主看见。
            execute: (params: unknown) => tool.execute('ipc', params),
          });
        };
      }
      return unimplemented(prop);
    },
  },
);

/** `ctx` 同样是记账 Proxy。这一版一个成员都没实现 —— 碰了就进清单。 */
const ctx = new Proxy(
  {},
  {
    get(_t, prop: string | symbol) {
      if (typeof prop === 'string') touched.add(`ctx.${prop}`);
      return undefined;
    },
  },
);

async function main(): Promise<void> {
  const entry = process.argv[2];
  if (!entry) {
    send({ t: 'fatal', error: 'runner: 缺扩展入口路径' });
    return;
  }
  try {
    const mod = (await import(entry)) as { default?: unknown };
    const factory = typeof mod.default === 'function' ? (mod.default as (a: unknown, c: unknown) => unknown) : null;
    // pi 的扩展默认导出一个 (api, ctx) => void 的注册函数。不是函数 → 说清楚, 不静默当成功。
    if (!factory) {
      send({ t: 'fatal', error: `扩展的 default 导出不是函数 (实得 ${typeof mod.default}) —— 不是一个 pi extension?` });
      return;
    }
    await factory(api, ctx);
  } catch (err) {
    // ⚠ 原文带出去。只说"加载失败"的话, 是包坏了还是我们的 shim 缺东西就分不开。
    send({ t: 'fatal', error: err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err) });
    return;
  }

  send({
    t: 'ready',
    tools: [...tools.values()].map(({ execute: _e, ...decl }) => decl),
    events: [...handlers.keys()],
    touched: [...touched].sort(),
  });

  let buf = '';
  for await (const chunk of process.stdin) {
    buf += Buffer.from(chunk).toString();
    const { frames, rest } = decodeFrames(buf);
    buf = rest;
    for (const f of frames) {
      const msg = f as HostMsg;
      if (msg.t === 'shutdown') return;
      try {
        if (msg.t === 'event') {
          const h = handlers.get(msg.event);
          send({ t: 'result', id: msg.id, ok: true, value: h ? await h(msg.payload) : undefined });
        } else if (msg.t === 'tool') {
          const tool = tools.get(msg.name);
          if (!tool) throw new Error(`扩展没有注册工具 '${msg.name}'`);
          send({ t: 'result', id: msg.id, ok: true, value: await tool.execute(msg.params) });
        }
      } catch (err) {
        send({ t: 'result', id: msg.id, ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }
}

await main();
