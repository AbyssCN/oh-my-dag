/**
 * src/harness/config-dump —— `omd config dump` (C3, dsh/cordis 吸收计划线 C)。
 *
 * 学 dsh `--dump-config` 的可见性承诺: **一条命令打印本次生效配置的全叠加结果**,
 * 每个值标注来自哪一层, 未配置项显式印 `(default)` 而不是省略。它不新算任何东西 ——
 * 每一节都调**运行时真的在用的那个解析函数** (tryResolveSeatModel / discoverChannels /
 * loadMcpClientConfig / readExtensionList), 所以 dump 出的值与生效值不可能分叉
 * (config-dump.test.ts 取样钉这条)。
 *
 * 为什么值得单独一条命令: "它到底读了哪份 config" 是本仓 P-2 高发区 (owner 一天内
 * 连撞三处漂移的那次, 每处都得 grep 全仓才翻得出来); 也是 patch 生态 (C4 seats.patch)
 * 的前提 —— 用户敢替换, 是因为能先看见要替换的东西。
 */
import type { ConfigIssue } from '../config/issues';
import { discoverChannels, omdConfigPath } from '../config/config-discovery';
import { loadMcpClientConfig } from '../mcp/client/config';
import { ALL_SEAT_IDS } from '../model/seats';
import { tryResolveSeatModel } from '../model/role-models';
import { reportPools, renderPoolReport } from '../model/pool-report';
import { langfuseStatus } from '../model/langfuse';
import { readExtensionList } from '../tui/ext/host';

export interface ConfigDumpOpts {
  cwd: string;
  env?: Record<string, string | undefined>;
  /** 测试隔离缝: 座位解析的 config 文件路径 (生产省略 = tryResolveSeatModel 默认链)。 */
  seatConfigPath?: string;
}

export function renderConfigDump(o: ConfigDumpOpts): string {
  const env = o.env ?? process.env;
  const issues: ConfigIssue[] = [];
  const lines: string[] = [];

  lines.push('omd 生效配置 (全叠加结果; 每个值标注来源层, 未配置 = (default))');
  lines.push('');

  // ── 座位: 生效坐标 + 来源层 (解析链: explicit > override > config.models > env > auto-assign > 默认) ──
  lines.push(`[seats] 真源 src/model/seats.ts · 解析 tryResolveSeatModel (${ALL_SEAT_IDS.length} 座):`);
  for (const seat of ALL_SEAT_IDS) {
    const r = tryResolveSeatModel(seat, { env, ...(o.seatConfigPath ? { configPath: o.seatConfigPath } : {}) });
    lines.push(r ? `  ${seat.padEnd(12)} ${r.model.padEnd(36)} [${r.via}]` : `  ${seat.padEnd(12)} ${'—'.padEnd(36)} (default: 未配, 按 tier 类首选分配)`);
  }
  lines.push('');

  // ── 渠道发现: provider × 来源 (env → auth.json → models.json → go, 后写胜) ──
  const { discovered, declarations } = discoverChannels(env, { issues });
  lines.push(`[providers] 发现 ${discovered.length} 个 (探测序 env → auth.json → models.json → go, 同名后写胜):`);
  for (const p of discovered) lines.push(`  ${p.id.padEnd(16)} [${p.source}]${p.isOAuth ? ' (oauth)' : ''}`);
  if (discovered.length === 0) lines.push('  (default) 零 provider —— 任何模型调用都会失败');
  lines.push('');
  lines.push(`[plans] 渠道声明 ${declarations.length} 条 (auto 推断 + ${omdConfigPath(env)} declaredPlans 显式声明, 声明胜):`);
  for (const d of declarations) lines.push(`  ${d.provider.padEnd(16)} kind=${d.kind} plan=${d.plan}`);
  lines.push('');

  // ── 池 (不经过座位链) ──
  const pools = reportPools(env);
  lines.push('[pools] 不经过座位链 (座位表看不见它们):');
  lines.push(...renderPoolReport(pools, (c) => c).map((l) => `  ${l}`));
  lines.push('');

  // ── 观测 ──
  lines.push(`[observability] Langfuse: ${langfuseStatus(env)}`);
  lines.push('');

  // ── 外部 MCP ──
  const mcp = loadMcpClientConfig(o.cwd, issues);
  lines.push(`[mcp] ${o.cwd}/.omd/mcp.json:`);
  if (mcp.servers.length === 0 && !mcp.loadError) lines.push('  (default) 无注册');
  for (const s of mcp.servers) lines.push(`  ${s.name.padEnd(16)} [${s.kind}] connect=${s.connectTimeoutMs}ms call=${s.callTimeoutMs}ms`);
  if (mcp.loadError) lines.push(`  ⚠ ${mcp.loadError}`);
  lines.push('');

  // ── ext ──
  const exts = readExtensionList(o.cwd, issues);
  lines.push(`[ext] ${o.cwd}/.omd/extensions.json:`);
  if (exts.length === 0) lines.push('  (default) 无扩展');
  for (const e of exts) lines.push(`  ${e.name.padEnd(16)} ${e.entry}`);
  lines.push('');

  // ── C2 的回报: 全部结构化 issue 一次性亮出来 ──
  if (issues.length > 0) {
    lines.push(`[issues] 配置读取中 ${issues.length} 条问题 (fail-open 已跳过, 但别当它们不存在):`);
    for (const i of issues) lines.push(`  ⚠ ${i.source}${i.path ? ` · ${i.path}` : ''}: ${i.message}`);
  } else {
    lines.push('[issues] 无 —— 所有配置源读取干净。');
  }
  return lines.join('\n');
}
