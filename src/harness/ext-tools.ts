/**
 * src/harness/ext-tools —— ext 工具进 agent leaf 生产装配 (S4, SDD 2026-08-10 omd-open-ecosystem-s4-ext-leaf)。
 *
 * ## 生命周期: per-cwd 单例, host 子进程共享, 不每叶一个 (D-2)
 *
 * 生产路径**从不调 `LoadedExtension.stop()`**(全仓 `.stop()` 命中仅 host.test.ts 逐测与
 * tui.ts 的渲染器/等待器对象, 均非 ext host)——`LoadedExtension` 生命周期 = 宿主进程生命周期
 * (cli.ts 启动加载一次, 活到进程退出)。于是这里按 cwd 缓存 **Promise 本身** (C-4: 同 cwd 连续
 * 两次 `loadExtTools(cwd)` 返回**同一 Promise 引用**), 同一 cwd 只 `loadExtension` 一次,
 * 每 leaf run 复用同一批 LoadedExtension 闭包。每叶一 host 是反设计 (loadExtension 每扩展必起
 * 新子进程, host.ts:111-125; 每 run 每叶调一次 = 每 run 每 ext 一进程)。
 *
 * ## 复用既有 IPC, 不造第二套
 *
 * 复用 `src/tui/ext/host.ts` 的 loadExtension / readExtensionList(同一套子进程 IPC 协议),
 * 把 `ToolDecl` 包成 `AnyOmdTool` 经 agent-leaf 既有 `customTools` 通道进 leaf —— 不新开通道
 * (防重议段 ③)。wrap 形状与 cli.ts:156-167 的 TUI chat-seat 加载块同款。
 */
import { loadExtension, readExtensionList, type HostDeps, type LoadedExtension } from '../tui/ext/host';
import type { AnyOmdTool } from './agent-tools';
import { logger } from '../logger';

/**
 * host 注入缝 (测试用, 同 host.test.ts 的 `which: () => null` 惯例)。
 * ⚠ 已知潜伏缺口 (2026-08-10 leaf-ext.test 揭出, 记 NOTES): bwrap 在场时 host 起在 jail 里,
 * 而 bwrapArgs 只 bind cwd + 系统目录 —— **cwd 之外的 entry / runner 在 jail 内不可达**,
 * 加载会挂到 30s 超时。今天 TUI/leaf 生产 cwd 都是含 runner 的仓, 未观测真失败;
 * 装了全局 omd 包在别的仓挂 ext 的那天, 此处要给 jail 补 entry/runner 目录的 ro-bind。
 */
export type ExtHostDeps = Pick<HostDeps, 'spawn' | 'which' | 'timeoutMs'>;

/** 每个 cwd 一条: 已(在)加载的工具 Promise。缓存 Promise 而非结果 —— C-4 要同一引用。 */
const toolsCache = new Map<string, Promise<AnyOmdTool[]>>();
/** 每个 cwd 的 LoadedExtension 集合 —— 只给 stopExtTools 清理用, 生产不读。 */
const extsCache = new Map<string, LoadedExtension[]>();

/**
 * 按 cwd 加载扩展清单 (`.omd/extensions.json`, 只认绝对路径入口) 并 wrap 成 leaf 工具。
 *
 * 零清单 / 坏 JSON / 文件缺失 → 空数组 (readExtensionList 已兜底, host.ts:235-253) ——
 * **工具面零变化** (D-4/I-1): extTools 空数组不挂任何空段, 由调用方条件 spread 决定
 * 传不传 `customTools` 键。
 *
 * 永不 reject (D-8): 单扩展加载失败 (!r.ok 缺 API / 抛异常) → warn + 跳过, 不杀 MCP server
 * (与 cli.ts:138-170 的 chat-seat 加载块「拒的进 UI 不崩」同精神)。
 *
 * ⚠ 不是 async 函数: 必须**原样返回缓存的 Promise 引用** (C-4 `toBe` 断言), async 包一层
 * 每次调用都会造新 Promise。
 */
export function loadExtTools(cwd: string, hostDeps?: ExtHostDeps): Promise<AnyOmdTool[]> {
  const hit = toolsCache.get(cwd);
  if (hit) return hit;
  const p = loadExtToolsInner(cwd, hostDeps);
  toolsCache.set(cwd, p);
  return p;
}

async function loadExtToolsInner(cwd: string, hostDeps?: ExtHostDeps): Promise<AnyOmdTool[]> {
  const exts: LoadedExtension[] = [];
  const tools: AnyOmdTool[] = [];
  try {
    for (const spec of readExtensionList(cwd)) {
      const r = await loadExtension(spec.name, spec.entry, { cwd, ...(hostDeps ?? {}) });
      if (!r.ok) {
        logger.warn(
          { ext: spec.name, missing: r.rejected.missing, reason: r.rejected.reason },
          '[omd/ext] 扩展**拒绝加载**(缺的 API 已逐条列出, 不半残地跑)',
        );
        continue;
      }
      exts.push(r.ext);
      for (const t of r.ext.tools) {
        tools.push({
          name: t.name,
          label: t.name,
          description: t.description,
          promptSnippet: t.promptSnippet ?? t.description,
          parameters: t.parameters,
          // D-5: 声明面 (ToolDecl) → 装配面 (OmdTool) 逐字段拷贝。缺省/非 true → false ——
          // sandboxed-leaf 闸按 `sandboxSafe === true` 放行, 其余剥除 + warn。
          sandboxSafe: t.sandboxSafe === true,
          executionMode: 'sequential',
          // execute 留在子进程里, 宿主经 host 的 IPC 代理调用 (protocol.ts:28 同注)。
          async execute(_id: string, params: unknown) {
            return { content: [{ type: 'text', text: await r.ext.callTool(t.name, params) }], details: undefined };
          },
        } as AnyOmdTool);
      }
      logger.info({ ext: spec.name, tools: r.ext.tools.length, sandboxed: r.ext.sandboxed }, '[omd/ext] 扩展已加载 (leaf)');
    }
  } catch (err) {
    logger.warn({ cwd, err: (err as Error).message }, '[omd/ext] 扩展加载失败 → 该 cwd 无 ext 工具 (不杀 server)');
  }
  extsCache.set(cwd, exts);
  return tools;
}

/**
 * 停掉该 cwd 全部 LoadedExtension 并清缓存。**仅供测试 afterAll 清理** (防孤儿子进程;
 * host.test.ts 逐测显式 `r.ext.stop()` 同精神)——生产不调: host 生命周期 = 进程生命周期 (D-9)。
 */
export function stopExtTools(cwd: string): void {
  for (const e of extsCache.get(cwd) ?? []) e.stop();
  extsCache.delete(cwd);
  toolsCache.delete(cwd);
}
