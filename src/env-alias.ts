/**
 * env-alias — 全局配置加载 + XIHE_* → OMD_* 兼容层。
 * 必须在任何读 env 的模块之前 import (tui.ts / pi-runtime.ts / script-bootstrap.ts 首行)。
 *
 * 加载序 (2026-07-19 修"全局命令无全局配置"): Bun 已自动加载 cwd/.env → 本模块补
 * ~/.omd/env 全局兜底 (**只填未设置的 key**, cwd/.env 与显式 env 永远赢) → XIHE_* 别名。
 * omd init 默认写全局文件 → 任何目录起 omd 都有配置; 项目内已有 .env 则项目覆盖。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

/** 全局配置文件路径 (omd init 的默认写入点)。 */
export function globalEnvPath(): string {
  return join(homedir(), '.omd', 'env');
}

/**
 * 读全局 env 文件, 只填 process.env 里**未设置**的 key (fail-open: 缺文件/坏行静默跳过)。
 * 格式 = .env 同款 KEY=value 行; # 注释与空行忽略; 不做引号/插值解析 (值原样)。
 */
export function loadGlobalEnv(
  path = globalEnvPath(),
  env: Record<string, string | undefined> = process.env,
): void {
  try {
    if (!existsSync(path)) return;
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (m && m[1] && env[m[1]] === undefined) env[m[1]] = m[2] ?? '';
    }
  } catch {
    /* 全局配置永不砖启动 */
  }
}

/**
 * XIHE_* → OMD_* : 每个 XIHE_<k> 若对应 OMD_<k> 未设置, 则复制过去。
 * OMD_* 显式设置时优先, 保证新配置为真理源。
 */
export function applyEnvAliases(env: Record<string, string | undefined> = process.env): void {
  for (const key of Object.keys(env)) {
    if (!key.startsWith('XIHE_')) continue;
    const modern = `OMD_${key.slice('XIHE_'.length)}`;
    if (env[modern] === undefined) env[modern] = env[key];
  }
}

loadGlobalEnv();
applyEnvAliases();
