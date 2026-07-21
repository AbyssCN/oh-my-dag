#!/usr/bin/env bun
/**
 * scripts/omd-hud — omd-hud Claude Code statusLine 入口。
 *
 * Claude Code 每 refreshInterval 秒 (+事件) fork 本脚本: stdin 喂 session JSON, 打印多行 HUD 到 stdout。
 * 读 <cwd>/.omd/hud/{dag,fog}.json (MCP server 经 onNodeEvent/renderStatus 原子写的活体快照),
 * 用纯渲染器拼 DAG 层级图 + pathfinder 迷雾条; 无活跃 run → 退化极简 session 行。
 *
 * 契约 (claude-code-guide 核实): cwd 在 workspace.current_dir/cwd; 宽度不在 JSON → 读 $COLUMNS;
 * 多行 stdout 逐行渲染; refreshInterval 必设 (否则空闲不刷新, 见 docs 安装说明)。
 *
 * 铁律: 永不抛 (statusline 崩 = 底栏空/报错)。stdin 坏 / 无快照 → 优雅降级。
 */
import { readDagView, readFog } from '../src/hud/load';
import { renderHud, type HudSession } from '../src/hud/render';

interface StatusStdin {
  cwd?: string;
  workspace?: { current_dir?: string };
  model?: { display_name?: string; id?: string };
  context_window?: { used_percentage?: number };
  cost?: { total_cost_usd?: number };
  rate_limits?: { five_hour?: { used_percentage?: number } };
}

async function main(): Promise<void> {
  let input: StatusStdin = {};
  try {
    const raw = await Bun.stdin.text();
    if (raw.trim()) input = JSON.parse(raw) as StatusStdin;
  } catch {
    /* stdin 缺失/坏 JSON → 空 input, 走空闲降级 */
  }

  const cwd = input.workspace?.current_dir ?? input.cwd ?? process.cwd();
  const cols = Number.parseInt(process.env.COLUMNS ?? '', 10) || 80;
  const nowMs = Date.now();

  const session: HudSession = {
    model: input.model?.display_name ?? input.model?.id ?? 'Claude',
    repo: cwd.split('/').filter(Boolean).pop() ?? '',
    ctxPct: Math.round(input.context_window?.used_percentage ?? 0),
    costUsd: input.cost?.total_cost_usd,
    fiveHourPct: input.rate_limits?.five_hour?.used_percentage,
  };

  const out = renderHud({
    dag: readDagView(cwd, nowMs),
    fog: readFog(cwd),
    session,
    cols,
    nowMs,
    color: !process.env.NO_COLOR,
  });
  if (out) process.stdout.write(out);
}

// 任何未预期错误也不许冒泡成非零退出 (Claude Code 会把 stderr 忽略, 但崩溃会留空底栏)。
main().catch(() => {
  /* swallow — 空底栏胜过报错 */
});
