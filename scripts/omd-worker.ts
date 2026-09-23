/**
 * scripts/omd-worker —— 一条命令换 worker 模型(owner 2026-09-23)。
 *
 * 生产配置是三家组合:Opus 5.5 坐稀疏高价值座(conductor/escalation/fusion/graft),
 * Sol 坐终审(verifier/review/review-spec),**其余高频座全坐同一个 worker 坐标**。
 * 换 worker 时只动这一个变量:以 `models.leaf` 为现役 worker,把 `models` 里所有等于它的座位
 * 一起换成新坐标。Opus / Sol 那几座不受影响。
 *
 * 写入前先对新坐标发一次真调用(同 `omd-seat-probe`)—— 不通就不写,配置保持原样。
 *
 * 用法:
 *   bun run --env-file=.env scripts/omd-worker.ts            # 打印现役 worker 与它坐的座位
 *   bun run --env-file=.env scripts/omd-worker.ts ds         # 别名: ds | minimax | mimo
 *   bun run --env-file=.env scripts/omd-worker.ts a:b        # 或直接给坐标
 *
 * 换完要重启 MCP client,MCP 子进程才会读到新座位。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { bootstrapModelRuntime } from '../src/model/bootstrap';
import { probeSeat } from './omd-seat-probe';

export const WORKER_ALIASES: Record<string, string> = {
  ds: 'deepseek:deepseek-flash',
  minimax: 'minimax-cn:MiniMax-M3',
  mimo: 'mimo-platform:mimo-v2.6-pro',
};

/** 把 `models` 里所有等于 `from` 的座位换成 `to`;返回新 map 与被换的座位名。 */
export function swapWorker(
  models: Record<string, string>,
  from: string,
  to: string,
): { models: Record<string, string>; seats: string[] } {
  const seats: string[] = [];
  const out: Record<string, string> = {};
  for (const [seat, coord] of Object.entries(models)) {
    if (coord === from) {
      out[seat] = to;
      seats.push(seat);
    } else out[seat] = coord;
  }
  return { models: out, seats };
}

if (import.meta.main) {
  const path = join(process.cwd(), '.omd', 'config.json');
  const cfg = JSON.parse(readFileSync(path, 'utf-8')) as { models?: Record<string, string> };
  const models = cfg.models ?? {};
  const current = models.leaf;
  if (!current) {
    console.error('omd-worker: .omd/config.json 没有 models.leaf,认不出现役 worker');
    process.exit(1);
  }
  const arg = Bun.argv[2];
  if (!arg) {
    const seats = Object.keys(models).filter((s) => models[s] === current);
    console.log(`现役 worker: ${current}\n座位 (${seats.length}): ${seats.join(' ')}`);
    console.log(`别名: ${Object.entries(WORKER_ALIASES).map(([k, v]) => `${k}=${v}`).join(' · ')}`);
    process.exit(0);
  }
  const next = WORKER_ALIASES[arg] ?? arg;
  if (!next.includes(':')) {
    console.error(`omd-worker: '${arg}' 既不是别名也不是 provider:model 坐标`);
    process.exit(1);
  }
  if (next === current) {
    console.log(`worker 已经是 ${current},不改`);
    process.exit(0);
  }
  bootstrapModelRuntime();
  const probe = await probeSeat(next);
  if (!probe.ok) {
    console.error(
      `✗ ${next} 真调用失败 [${probe.kind ?? '?'}${probe.status ? '/' + probe.status : ''}] ${probe.detail}\n` +
        '  配置未改动。',
    );
    process.exit(1);
  }
  const r = swapWorker(models, current, next);
  cfg.models = r.models;
  writeFileSync(path, JSON.stringify(cfg, null, 2) + '\n');
  console.log(`✓ worker ${current} → ${next} (${probe.ms}ms 真调用通过)`);
  console.log(`  换了 ${r.seats.length} 座: ${r.seats.join(' ')}`);
  console.log('  重启 MCP client 后生效。');
}
