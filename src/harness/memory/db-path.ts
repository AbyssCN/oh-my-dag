/**
 * memory.db 路径的**唯一**解析点(S0 单一真源的路径半边)。
 *
 * 消费方: `assemble.ts` createDefaultMemory(MCP 装配 + TUI 对话位)·
 * `harness/dream/watermark.ts`(dream_watermark 同库表, 裁决 4)。
 * 再出现第三份 `OMD_MEMORY_PATH ?? '.omd/memory.db'` 字面量 = S0 病灶复发。
 */
export function resolveMemoryDbPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.OMD_MEMORY_PATH ?? '.omd/memory.db';
}

/**
 * 会话交接镜像(namespace='continuity')的**独立**库路径。
 *
 * ## 为什么跟 memory.db 分开(2026-08-28)
 *
 * 实测:`~/.omd/memory.db` 里 73,459 条 live fact, 其中 73,458 条是 continuity, 库 368MB,
 * 一次 `retrieve` 要 379–429ms; 同一份代码在 120 条的项目库上是 1–3ms。而 top-3 命中经常
 * 三条全是 continuity —— omd.pattern / omd.limit 这些真正要召回的东西被挤出去了。
 *
 * 根因不是 bug 是**形状**: continuity 的 identity key 是 sessionId 单键
 * (`CONTINUITY_NAMESPACE_IDENTITY_FIELDS`), 设计意图是"同一 session 反复写=演化一行" ——
 * 这在 session 内成立, 跨 session 不成立。每个新 session 是一个新 identity, 永不 supersede。
 * 于是它只增不减, 而 `facts` 表的其余 namespace 是靠 supersession 保持锋利的。
 * 两种生命周期共用一张表 = 增长快的那个把另一个淹掉。
 *
 * ⚠ **文件名刻意不叫 `continuity.db`**: `.omd/continuity/` 目录是 **DAG run 的 resume 存档**
 * (`continuity/checkpoint-manager.ts`), 跟会话交接是两件事。同名会让人以为是一件。
 * 库里的 namespace 字面量仍是 `'continuity'`(改它要动 schema 与既有行, 属另一张票)。
 *
 * 消费方: `session/omd-checkpoint.ts`(omd 自己的循环)· `scripts/session-writer.ts`(CC 那条)。
 * 读面 `listCheckpoints` 由调用方注入 store, 所以跟着写入侧走, 不需要自己解析路径。
 */
export function resolveHandoffDbPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.OMD_HANDOFF_DB_PATH ?? '.omd/handoff.db';
}
