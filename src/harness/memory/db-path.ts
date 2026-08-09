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
