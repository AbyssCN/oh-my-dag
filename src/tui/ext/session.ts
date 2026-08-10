/**
 * src/tui/ext/session —— 对话位扩展宿主的**可重载持有者**(D3 `/reload`,2026-08-11)。
 *
 * ## 为什么要有这个文件(而不是把 reload 写在 cli.ts 里)
 *
 * 重载要动的那份状态(当前活着的 `LoadedExtension` 数组)此前长在 `cli.ts` 的一个内联
 * 异步块里 —— 谁都够不着,也没有任何闸看得见它。`chat-seat.ts` 的文件头记过同族的账:
 * 长在 cli.ts 内联块里的装配等于没有测试。这里把它抽成一个持有者,cli.ts 只调两个方法。
 *
 * ## 重载 = kill 旧子进程 + 按清单重来一遍
 *
 * 宿主本来就是**按路径字符串 spawn `runner.ts` 子进程**(`host.ts:111-125`),
 * 所以不需要新机制:`stop()` 掉旧的,重读 `.omd/extensions.json`,重新 `loadExtension`。
 *
 * ## ⚠ 工具面是**启动时冻结**的 —— 这条限制要说出来,不许静默
 *
 * `createChatSeatTools` 在装配时把扩展工具**展开进一个新数组**(`chat-seat.ts:81`),
 * 之后再改源数组不会传导。于是这里做两件事:
 *
 * 1. **工具包装按名转发,不闭包捕获 `LoadedExtension`。** 捕获的话,重载 kill 掉旧子进程之后,
 *    面上那些工具全指向死进程 —— 调用要么超时要么静默失败,而这**恰恰是最难查的形态**。
 *    按名转发的话,重载后还在清单里的同名工具立刻接到**新**子进程。
 * 2. **重载后新增/消失的工具名逐条报出来**(`toolsAdded` / `toolsRemoved`)。
 *    新增的这一轮进不了模型的工具面(要重启),消失的还挂在面上但调用会**明说它没了**。
 *    这是响亮降级,不是"重载了但一半没生效"。
 */
import { loadExtension, readExtensionList, type HostDeps, type LoadedExtension } from './host';
import type { AnyOmdTool } from '../../harness/agent-tools';
import { logger } from '../../logger';

/** 加载结果的 UI 视图 —— 被拒的也要带上(设置面板要说出缺了什么)。 */
export interface ExtStatus {
  name: string;
  ok: boolean;
  sandboxed?: boolean;
  missing?: string[];
}

/** 一次 `/reload` 的回执。**成败两侧都要有数** —— 只报成功的回执没有信息量。 */
export interface ExtReloadResult {
  /** 重载后**活着**的扩展名。 */
  loaded: string[];
  /** 被拒的:名字 + 一句原因(缺 API / 握手超时 / 加载抛了)。 */
  rejected: { name: string; reason: string }[];
  /** 设置面板要的那份状态(与 `RunOmdTuiOpts.extensions` 同形)。 */
  status: ExtStatus[];
  /** 重载后**新出现**的工具名 —— 工具面已冻结, 它们要重启才进得去。 */
  toolsAdded: string[];
  /** 重载后**没了**的工具名 —— 还挂在面上, 但调用会明说它没了。 */
  toolsRemoved: string[];
}

export interface ExtSession {
  /** 首次加载。返回的工具数组就是交给 `createChatSeatTools` 的那一份(启动时冻结)。 */
  load(): Promise<{ tools: AnyOmdTool[]; status: ExtStatus[] }>;
  /** kill 旧子进程 + 按清单重来。并发调用返回**同一个** Promise(不许两次 kill 交叉)。 */
  reload(): Promise<ExtReloadResult>;
  /** `before_agent_start` 串接。**每轮现取当前扩展** —— 重载后下一句就生效。 */
  systemPromptHook(prompt: string): Promise<string>;
  /** 停掉全部子进程(测试清理 / 退出路径)。 */
  stop(): void;
}

export type ExtSessionDeps = Pick<HostDeps, 'spawn' | 'which' | 'timeoutMs'>;

export function createExtSession(cwd: string, deps?: ExtSessionDeps): ExtSession {
  /** 当前活着的扩展。reload 整体换掉。 */
  let exts: LoadedExtension[] = [];
  let status: ExtStatus[] = [];
  let rejected: { name: string; reason: string }[] = [];
  /** 启动时冻结进工具面的那批工具名 —— `toolsAdded/Removed` 拿它当基线。 */
  let frozenToolNames: string[] = [];
  let reloading: Promise<ExtReloadResult> | null = null;

  async function loadAll(): Promise<void> {
    const next: LoadedExtension[] = [];
    const nextStatus: ExtStatus[] = [];
    const nextRejected: { name: string; reason: string }[] = [];
    for (const spec of readExtensionList(cwd)) {
      const r = await loadExtension(spec.name, spec.entry, { cwd, ...(deps ?? {}) });
      if (!r.ok) {
        logger.warn(
          { ext: spec.name, missing: r.rejected.missing, reason: r.rejected.reason },
          '[omd/ext] 扩展**拒绝加载**(缺的 API 已逐条列出, 不半残地跑)',
        );
        nextStatus.push({ name: spec.name, ok: false, missing: r.rejected.missing });
        nextRejected.push({ name: spec.name, reason: r.rejected.reason });
        continue;
      }
      next.push(r.ext);
      nextStatus.push({ name: spec.name, ok: true, sandboxed: r.ext.sandboxed });
      logger.info({ ext: spec.name, tools: r.ext.tools.length, sandboxed: r.ext.sandboxed }, '[omd/ext] 扩展已加载');
    }
    exts = next;
    status = nextStatus;
    rejected = nextRejected;
  }

  /** 当前全部扩展工具名(顺序 = 清单顺序)。 */
  const currentToolNames = (): string[] => exts.flatMap((e) => e.tools.map((t) => t.name));

  /**
   * 按**名字**转发给当前持有该工具的扩展。
   *
   * 查不到不是"返回空串" —— 空串会被模型读成"工具跑了、结果是空的"。说出它没了。
   */
  async function callByName(toolName: string, params: unknown): Promise<string> {
    const owner = exts.find((e) => e.tools.some((t) => t.name === toolName));
    if (!owner) {
      return `[omd/ext] tool ${toolName} is gone after /reload - it is no longer in .omd/extensions.json. Restart omd tui to bring the tool surface back in sync.`;
    }
    return owner.callTool(toolName, params);
  }

  function wrap(decl: LoadedExtension['tools'][number]): AnyOmdTool {
    return {
      name: decl.name,
      label: decl.name,
      description: decl.description,
      promptSnippet: decl.promptSnippet ?? decl.description,
      parameters: decl.parameters,
      executionMode: 'sequential',
      // ⚠ 这里**不捕获 LoadedExtension** —— 见文件头第 1 条。每次调用现查当前持有者。
      async execute(_id: string, params: unknown) {
        return { content: [{ type: 'text', text: await callByName(decl.name, params) }], details: undefined };
      },
    } as AnyOmdTool;
  }

  return {
    async load() {
      await loadAll();
      const tools = exts.flatMap((e) => e.tools.map(wrap));
      frozenToolNames = tools.map((t) => t.name);
      return { tools, status };
    },

    reload() {
      if (reloading) return reloading;
      const p = (async (): Promise<ExtReloadResult> => {
        try {
          // ① kill 旧子进程。stop() 先发 shutdown 帧再 kill(9)(host.ts:220-223)。
          for (const e of exts) {
            try {
              e.stop();
            } catch (err) {
              // fail-open 可以吞异常, 不许吞证据: 停不掉的那个扩展名要留下来。
              logger.warn({ ext: e.name, err: (err as Error).message }, '[omd/ext] 停旧子进程时抛了 → 继续重载');
            }
          }
          exts = [];
          // ② 重读清单 + 重 spawn。
          await loadAll();
          const now = currentToolNames();
          return {
            loaded: exts.map((e) => e.name),
            rejected,
            status,
            toolsAdded: now.filter((n) => !frozenToolNames.includes(n)),
            toolsRemoved: frozenToolNames.filter((n) => !now.includes(n)),
          };
        } finally {
          reloading = null;
        }
      })();
      reloading = p;
      return p;
    },

    async systemPromptHook(prompt: string) {
      // 多个扩展**串起来**追加:每个都只能在前一个的结果上追加, 顺序 = 清单顺序。
      let out = prompt;
      for (const e of exts) out = await e.beforeAgentStart(out);
      return out;
    },

    stop() {
      for (const e of exts) e.stop();
      exts = [];
    },
  };
}
