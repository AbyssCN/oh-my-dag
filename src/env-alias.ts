/**
 * env-alias — XIHE_* → OMD_* 兼容层 (改名 oh-my-dag 后的过渡桥)。
 *
 * 内部读取点统一是 OMD_RUNTIME_PROVIDER 等; 老配置里的 XIHE_* 仍被接受。
 * 规则: 每个 XIHE_<k> 若对应 OMD_<k> 未设置, 则复制过去。OMD_* 显式设置时优先, 保证新配置为真理源。
 * 必须在任何读 env 的模块之前 import (tui.ts / pi-runtime.ts / script-bootstrap.ts 首行)。
 */
export function applyEnvAliases(env: Record<string, string | undefined> = process.env): void {
  for (const key of Object.keys(env)) {
    if (!key.startsWith('XIHE_')) continue;
    const modern = `OMD_${key.slice('XIHE_'.length)}`;
    if (env[modern] === undefined) env[modern] = env[key];
  }
}

applyEnvAliases();
