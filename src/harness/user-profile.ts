/**
 * src/harness/user-profile —— 用户静态档案 (user.md) 读取 + 注入封装。
 *
 * user.md = 用户**人写**的 durable 档案 (像 CLAUDE.md 之于项目), 整段注入 systemPrompt。跟:
 *   - OMD_IDENTITY (omd 自身, 嵌入不可改, 只方法论 — the owner 锁) 分开;
 *   - `user.*` SQLite 动态记忆 (omd 边用边学, 选择性召回) 互补 (慢种子 vs 快观察)。
 *
 * 纯函数 + 一次文件读 (无 watch)。缺/空 → null (no-op, omd 从零靠 user.* 学起)。
 */
import { existsSync, readFileSync } from 'node:fs';

/** 部署默认路径 (cwd 下 user.md); 经 OMD_USER_PROFILE 覆盖。 */
export const DEFAULT_USER_PROFILE_PATH = 'user.md';

/** 读 user.md 内容; 缺/空/读失败 → null。 */
export function readUserProfile(path: string = DEFAULT_USER_PROFILE_PATH): string | null {
  try {
    if (!existsSync(path)) return null;
    const content = readFileSync(path, 'utf8').trim();
    return content.length > 0 ? content : null;
  } catch {
    return null;
  }
}

/** 包成 systemPrompt 注入块 (XML 标签消歧 + 防注入, 跟身份/grounding 同形)。 */
export function wrapUserProfile(content: string): string {
  return `<user-profile>\n${content}\n</user-profile>`;
}
