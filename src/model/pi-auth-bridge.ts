/**
 * pi-auth-bridge — 把 pi 的 OAuth 凭证 (~/.pi/agent/auth.json) 桥进引擎 callModel 注册表。
 *
 * 场景: `kimi-coding` 走 device-flow OAuth (auth.json 存 access/refresh/expires), 不是静态
 * API key — runtime 模型层 (pi-ai) 原生认它, 但引擎层 (conductor/verifier/judge/dag 脚本)
 * 的 registry 只吃 baseUrl+apiKey。此桥在 boot 时读 access token 快照注册成 provider。
 *
 * 协议事实 (pi-ai models.generated 实测): kimi-coding = anthropic-messages @
 * https://api.kimi.com/coding — registry 原生支持该协议, 零适配。
 *
 * ponytail: token 是 boot 时快照, 长 session 中途过期会 401, 届时跑一次 pi/kimi 命令让
 * pi 刷新再重启 omd 即可, 401 时引擎会响亮报错不静默
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { registerProvider } from './providers';
import { logger } from '../logger';

/** kimi-coding 的固定端点 (pi-ai 目录同源)。 */
export const KIMI_CODING_BASE_URL = 'https://api.kimi.com/coding';

export interface PiOAuthEntry {
  access: string;
  refresh?: string;
  expires?: number;
}

/** 读 auth.json 里某 provider 的 OAuth 条目; 缺文件/缺条目/坏 JSON → null (不抛, boot 永不砖)。 */
export function readPiAuthEntry(
  name: string,
  authPath = join(homedir(), '.pi', 'agent', 'auth.json'),
): PiOAuthEntry | null {
  try {
    if (!existsSync(authPath)) return null;
    const all = JSON.parse(readFileSync(authPath, 'utf8')) as Record<string, unknown>;
    const entry = all[name] as { access?: unknown; refresh?: unknown; expires?: unknown } | undefined;
    if (!entry || typeof entry.access !== 'string' || !entry.access.trim()) return null;
    return {
      access: entry.access,
      refresh: typeof entry.refresh === 'string' ? entry.refresh : undefined,
      expires: typeof entry.expires === 'number' ? entry.expires : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * 把 pi 的 kimi-coding OAuth 桥注册进 callModel registry。
 * 返回是否注册成功。token 已过期仍注册 (pi 侧任意一次使用会刷新回写; 这里只提醒)。
 */
export function registerKimiCodingFromPiAuth(authPath?: string): boolean {
  const entry = readPiAuthEntry('kimi-coding', authPath);
  if (!entry) return false;
  if (entry.expires && entry.expires < Date.now()) {
    logger.warn(
      '[omd/pi-auth] kimi-coding token 已过期 — 跑一次 pi/kimi 命令触发刷新后重启 omd (仍注册, 请求会 401)',
    );
  }
  registerProvider('kimi-coding', {
    baseUrl: KIMI_CODING_BASE_URL,
    apiKey: entry.access,
    api: 'anthropic-messages',
    defaultModel: 'k3',
  });
  return true;
}
