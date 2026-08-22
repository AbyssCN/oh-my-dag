/**
 * src/tui/ext/host —— **扩展宿主(父侧)**(S15a,2026-08-07)。
 *
 * 这个文件**永远不 import 扩展代码** —— 那是 `runner.ts` 在子进程里干的事。
 *
 * ## 三条 owner 裁决在这里兑现
 *
 * 1. **走沙箱不走白名单**:每个扩展一个 bwrap 子进程(bwrap 不在 → 响亮降级,
 *    照 `assemble.ts:395` 的惯例);
 * 2. **`systemPrompt` 只能追加**:返回值在**父进程**里校验(`enforceAppendOnly`)——
 *    检查放在子进程里等于让被检查的一方自己检查自己;
 * 3. **替换前缀的 block + 提醒**,不是静默吞掉。
 *
 * ## 加载期硬失败,不半残地跑
 *
 * 子进程握手时把**碰过的所有 API**报上来。碰了没实现的 → **拒绝加载并逐条列出缺什么**。
 * 静态体检读数说 16 个包里 15 个只差适配层 —— 但"差适配层"和"能装"是两回事,
 * 这条闸让区别在装的那一刻就说清楚,而不是用起来才发现一半不工作。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { zodIssues, type ConfigIssueSink } from '../../config/issues';
import { logger } from '../../logger';
import { bwrapArgs, defaultRoBinds } from '../../harness/hooks/bwrap';
import { type ChildMsg, type HostMsg, type ObserveEvent, SUPPORTED_API, SUPPORTED_EVENTS, type ToolDecl, decodeFrames, encodeFrame, enforceAppendOnly } from './protocol';

export interface LoadedExtension {
  name: string;
  tools: ToolDecl[];
  events: string[];
  /** 沙箱状态。`false` = bwrap 不在,**响亮降级**(扩展照跑但没有进程级隔离)。 */
  sandboxed: boolean;
  callTool(name: string, params: unknown): Promise<string>;
  /**
   * 跑 `before_agent_start`(gate),返回**校验过**的 systemPrompt。
   * D1: 超时/子进程死 → **走声明默认 = 放行原串** (warn 留痕), 不再把拒绝向上抛 ——
   * 一个挂了的扩展不许拖死对话轮。
   */
  beforeAgentStart(systemPrompt: string): Promise<string>;
  /**
   * observe 事件通知 (D1)。发帧即返回, **不消费回复**: 扩展没订阅 → 不发帧;
   * 崩溃/超时/返回值 → 只留 debug 痕, 结构上够不到调用方的任何状态。
   */
  notify(event: ObserveEvent, payload: unknown): void;
  stop(): void;
}

export interface LoadRejected {
  name: string;
  /** 逐条列出缺什么 —— 这就是「加载期硬失败」的全部价值。 */
  missing: string[];
  reason: string;
}

export type LoadResult = { ok: true; ext: LoadedExtension } | { ok: false; rejected: LoadRejected };

const IMPLEMENTED = new Set<string>([
  ...SUPPORTED_API,
  ...SUPPORTED_EVENTS.map((e) => `on:${e}`),
  // 扩展模块顶层常碰的语言/模块设施 —— 不是 pi API,不算缺口。
  'then',
  'default',
]);

/** 从 `touched` 里挑出**我们没实现**的。`on:<event>` 里不支持的事件也算。 */
export function missingApis(touched: readonly string[]): string[] {
  return touched.filter((t) => !IMPLEMENTED.has(t)).sort();
}

export interface HostDeps {
  cwd: string;
  /** 注入用:起子进程。默认真 `Bun.spawn`。 */
  spawn?: (argv: string[]) => ChildHandle;
  /** 注入用:找 bwrap。默认 `Bun.which`。 */
  which?: (bin: string) => string | null;
  /** 单次调用超时。 */
  timeoutMs?: number;
}

export interface ChildHandle {
  write(s: string): void;
  onLine(fn: (line: string) => void): void;
  kill(): void;
  readonly exited: Promise<number>;
}

function realSpawn(argv: string[], cwd: string): ChildHandle {
  const proc = Bun.spawn(argv, { cwd, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
  const listeners: ((l: string) => void)[] = [];
  void (async () => {
    let buf = '';
    const reader = proc.stdout.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += Buffer.from(value).toString();
      const { frames, rest, garbage } = decodeFrames(buf);
      buf = rest;
      // ⚠ 扩展往 stdout 打的字**留证据**:不记的话"协议错乱"这件事永远查不出来。
      for (const g of garbage) logger.warn({ line: g.slice(0, 200) }, '[omd/ext] extension wrote non-protocol content to stdout');
      for (const f of frames) for (const fn of listeners) fn(JSON.stringify(f));
    }
  })();
  void (async () => {
    const err = await new Response(proc.stderr).text();
    if (err.trim()) logger.warn({ err: err.slice(0, 500) }, '[omd/ext] extension child stderr');
  })();
  return {
    write: (s) => proc.stdin.write(s),
    onLine: (fn) => listeners.push(fn),
    kill: () => proc.kill(9),
    exited: proc.exited,
  };
}

/**
 * 加载一个扩展。
 *
 * @param entry 扩展入口的**绝对路径**(npm 名字解析是后一片的事)。
 */
export async function loadExtension(name: string, entry: string, deps: HostDeps): Promise<LoadResult> {
  const which = deps.which ?? ((b: string) => Bun.which(b));
  const timeoutMs = deps.timeoutMs ?? 30_000;
  const runner = join(import.meta.dir, 'runner.ts');

  const hasBwrap = !!which('bwrap');
  if (!hasBwrap) {
    // 响亮降级, 同 `assemble.ts:395`: 不是静默不隔离, 是记一行说清楚少了什么。
    logger.warn({ name }, '[omd/ext] bwrap not found -> extension runs WITHOUT process-level isolation (still in child process; crash/timeout still isolated)');
  }
  const argv = hasBwrap
    ? ['bwrap', ...bwrapArgs(deps.cwd, defaultRoBinds(deps.cwd)), 'bun', 'run', runner, entry]
    : ['bun', 'run', runner, entry];

  const child = (deps.spawn ?? ((a: string[]) => realSpawn(a, deps.cwd)))(argv);

  let seq = 0;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  let ready: ((m: Extract<ChildMsg, { t: 'ready' }>) => void) | null = null;
  let fatal: ((e: string) => void) | null = null;

  child.onLine((line) => {
    let msg: ChildMsg;
    try {
      msg = JSON.parse(line) as ChildMsg;
    } catch {
      return;
    }
    if (msg.t === 'ready') ready?.(msg);
    else if (msg.t === 'fatal') fatal?.(msg.error);
    else if (msg.t === 'result') {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.value);
      else p.reject(new Error(msg.error));
    }
  });

  const handshake = await new Promise<Extract<ChildMsg, { t: 'ready' }> | { error: string }>((resolve) => {
    const timer = setTimeout(() => resolve({ error: `handshake timed out (${timeoutMs}ms) -- extension did not report ready` }), timeoutMs);
    ready = (m) => {
      clearTimeout(timer);
      resolve(m);
    };
    fatal = (e) => {
      clearTimeout(timer);
      resolve({ error: e });
    };
  });

  if ('error' in handshake) {
    child.kill();
    return { ok: false, rejected: { name, missing: [], reason: handshake.error } };
  }

  const missing = missingApis(handshake.touched);
  if (missing.length > 0) {
    child.kill();
    return {
      ok: false,
      rejected: { name, missing, reason: `this host does not implement these ${missing.length} APIs` },
    };
  }

  const call = (msg: HostMsg & { id: number }): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(msg.id);
        reject(new Error(`extension ${name} call timed out (${timeoutMs}ms)`));
      }, timeoutMs);
      pending.set(msg.id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      child.write(encodeFrame(msg));
    });

  return {
    ok: true,
    ext: {
      name,
      tools: handshake.tools,
      events: handshake.events,
      sandboxed: hasBwrap,
      async callTool(toolName, params) {
        const v = await call({ t: 'tool', id: ++seq, name: toolName, params });
        // 工具结果原样转成文本给模型。形状不认识时**说出来**, 不静默变空串。
        if (typeof v === 'string') return v;
        const content = (v as { content?: { text?: string }[] })?.content;
        if (Array.isArray(content)) return content.map((c) => c.text ?? '').filter(Boolean).join('\n');
        return `[tool from extension ${name} returned unknown shape]\n${JSON.stringify(v).slice(0, 500)}`;
      },
      async beforeAgentStart(systemPrompt) {
        let raw: unknown;
        try {
          raw = await call({ t: 'event', id: ++seq, event: 'before_agent_start', payload: { systemPrompt } });
        } catch (err) {
          // D1 gate 默认: 超时/子进程死 → 放行原串。留痕不吞证据, 但不再拖死调用方。
          logger.warn(
            { ext: name, err: err instanceof Error ? err.message : String(err) },
            '[omd/ext] before_agent_start call failed -> falling back to gate default (pass through original)',
          );
          return systemPrompt;
        }
        const returned = (raw as { systemPrompt?: unknown } | undefined)?.systemPrompt;
        const verdict = enforceAppendOnly(systemPrompt, returned);
        if (!verdict.ok) {
          // owner 裁决 ③:**block + 提醒**, 不是静默吞掉。
          logger.warn({ ext: name, reason: verdict.reason }, '[omd/ext] extension tried to replace system prompt -> blocked, using original');
        }
        return verdict.value;
      },
      notify(event, payload) {
        // observe: 没订阅不发帧; 回复/错误只留 debug 痕 —— 前缀零字节与"崩溃不扰动"是构造保证。
        if (!handshake.events.includes(event)) return;
        call({ t: 'event', id: ++seq, event, payload }).catch((err: unknown) => {
          logger.debug(
            { ext: name, event, err: err instanceof Error ? err.message : String(err) },
            '[omd/ext] observe event reply failed (semantically ignored)',
          );
        });
      },
      stop() {
        child.write(encodeFrame({ t: 'shutdown' }));
        child.kill();
      },
    },
  };
}

/**
 * 从 `<cwd>/.omd/extensions.json` 读扩展清单。
 *
 * 格式:`{ "extensions": [{ "name": "...", "entry": "<绝对路径>" }] }`。
 * ⚠ 这一版**只认绝对路径** —— npm 包名解析要先决定"装在哪、谁装",那是另一片。
 * 文件不在 → 空数组(没配过扩展不是错误)。
 */
/** C2: 清单条目闸字段 (looseObject: 多余键照旧忽略)。 */
const extensionEntrySchema = z.looseObject({ name: z.string().min(1), entry: z.string().min(1) });

export function readExtensionList(cwd: string, issues?: ConfigIssueSink): { name: string; entry: string }[] {
  const f = join(cwd, '.omd', 'extensions.json');
  if (!existsSync(f)) return [];
  try {
    const parsed = JSON.parse(readFileSync(f, 'utf8')) as { extensions?: unknown[] };
    const out: { name: string; entry: string }[] = [];
    for (const [i, rawEntry] of (parsed.extensions ?? []).entries()) {
      const p = extensionEntrySchema.safeParse(rawEntry);
      if (!p.success) {
        // C2: 此前无效条目 (缺 name/entry) 是静默 filter 掉的 —— 跳过行为不变, 证据补上。
        issues?.push(...zodIssues(f, `extensions[${i}]`, p.error.issues));
        continue;
      }
      if (!existsSync(p.data.entry)) {
        logger.warn({ name: p.data.name, entry: p.data.entry }, '[omd/ext] entry file missing in manifest -> skipped');
        issues?.push({ source: f, path: `extensions[${i}].entry`, message: `entry file does not exist: ${p.data.entry}` });
        continue;
      }
      out.push({ name: p.data.name, entry: p.data.entry });
    }
    return out;
  } catch (err) {
    logger.warn({ f, err: (err as Error).message }, '[omd/ext] extensions.json could not be parsed -> treating as no extensions configured');
    issues?.push({ source: f, path: '', message: (err as Error).message });
    return [];
  }
}
