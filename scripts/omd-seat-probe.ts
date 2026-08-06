/**
 * scripts/omd-seat-probe —— **动座位之前,对每个坐标发一次真调用**(2026-08-07)。
 *
 * ## 它是一条纪律的可执行版,而那条纪律是花钱买来的
 *
 * 2026-08-06 那一程:我用 `sed 's/"deepseek:.../"opencode-go:.../g'` 把 **11 个好用的直连座位**
 * 批量刷成 `opencode-go:`,理由是"同一个模型换一条通道,单变量"。
 * 而 `opencode-go:deepseek-v4-flash` 是**区域限制**的 —— 之后两跑全挂在 403 上,
 * 我却把它写成了「四跑四种失效」「provider 不可用是账户层面的硬限制」,进了交接和 commit 判词。
 *
 * **九个坐标真调一遍花了不到 30 秒**,结果是:`kimi-coding:k3` ✓(我一次都没试过)·
 * `deepseek:*` ✓(直连一直是好的)· `opencode-go:glm-5.2` ✓ ·
 * **只有 `opencode-go:deepseek-v4-flash` 坏,而它是我自己 sed 出来的。**
 *
 * ## 为什么是脚本不是散文
 *
 * 仓规:「想加新纪律前先问:能不能做成会红的闸?能就别写成散文。」
 * 第一版我把这条写进了交接文档 —— 交接会过期,而这件事每次换座位都要做一遍。
 *
 * ## ⚠ 它与 `omd_config_status` 的"全座位自检"**不是一回事**
 *
 * 那个自检的判据是 `usable()` = **有凭证 ∧ 不在熔断冷却窗内** —— **它不发真调用**。
 * 于是「额度用尽 / 余额不足 / 区域限制」在它眼里全部是 ✓(实测:16 座 0 不可用,而真调用当场 402)。
 * 两者都要有:那个便宜、随时可看;这个花几十秒和几十 token,**换座位前跑**。
 *
 * ## 用法
 *
 *   bun run scripts/omd-seat-probe.ts                    # 探 .omd/config.json 里现役的全部坐标
 *   bun run scripts/omd-seat-probe.ts a:b c:d            # 只探点名的坐标(换座位前先探候选)
 *
 * 退出码:全通 0 · 有坏坐标 1(可直接当 CI/pre-change 闸用)。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { callModel } from '../src/model/index';
import { bootstrapModelRuntime } from '../src/model/bootstrap';

export interface SeatProbeResult {
  coord: string;
  ok: boolean;
  ms: number;
  /** 失败时的错误分类与状态码 —— 402/403/429 各自的下一步不同,别压成一个 "挂了"。 */
  kind?: string;
  status?: number;
  detail?: string;
}

/** 从 `.omd/config.json` 收集现役坐标(`models` 全部角色 + 各 pool),去重后保持首次出现序。 */
export function seatsFromConfig(cwd: string): string[] {
  const raw = JSON.parse(readFileSync(join(cwd, '.omd', 'config.json'), 'utf-8')) as {
    models?: Record<string, string>;
    pools?: Record<string, string[]>;
    multimodalPool?: string[];
  };
  const out: string[] = [];
  const push = (c?: string): void => {
    // ⚠ `pools` 与 `multimodalPool` 是**两个键、不联动** —— 只读一个会漏掉另一半现役坐标。
    if (c && c.includes(':') && !out.includes(c)) out.push(c);
  };
  for (const c of Object.values(raw.models ?? {})) push(c);
  for (const pool of Object.values(raw.pools ?? {})) for (const c of pool) push(c);
  for (const c of raw.multimodalPool ?? []) push(c);
  return out;
}

/**
 * 对一个坐标发一次**真调用**。成败判据是"有没有回话",不是"配置里有没有它"。
 *
 * 提示词刻意最短:这条探针会对每个坐标各烧一发,贵了就没人愿意跑,没人跑的闸等于不存在。
 */
export async function probeSeat(coord: string): Promise<SeatProbeResult> {
  const t0 = Date.now();
  try {
    await callModel({
      messages: [{ role: 'user', content: 'reply with the single word: ok' }],
      model: coord,
      maxRetries: 0,
      retryDelayMs: 0,
    });
    return { coord, ok: true, ms: Date.now() - t0 };
  } catch (e) {
    const err = e as { kind?: string; status?: number; message?: string };
    return {
      coord,
      ok: false,
      ms: Date.now() - t0,
      ...(err.kind ? { kind: err.kind } : {}),
      ...(err.status ? { status: err.status } : {}),
      detail: String(err.message ?? e).slice(0, 120),
    };
  }
}

if (import.meta.main) {
  // ⚠ **短命进程必须先 bootstrap**(2026-08-07,第一版就栽在这):不注册 provider 的话
  // `mimo-platform:*` 会报 `provider not registered` —— 而它在 MCP server 里是好的
  // (`~/.pi/agent/models.json` 的自定 provider 由 `registerProvidersFromModelsJson` 叠加)。
  // **一个会给假阴性的探针比没有探针更坏**:它会让人去删掉本来能用的座位,
  // 而这正是这个脚本存在的理由(别从间接信号推可用性)。
  bootstrapModelRuntime();
  const coords = Bun.argv.length > 2 ? Bun.argv.slice(2) : seatsFromConfig(process.cwd());
  if (coords.length === 0) {
    console.error('omd-seat-probe: 一个坐标都没收集到 —— 检查 .omd/config.json');
    process.exit(1);
  }
  console.log(`omd-seat-probe — ${coords.length} 个坐标, 每个发一次真调用\n`);
  const results: SeatProbeResult[] = [];
  for (const c of coords) {
    const r = await probeSeat(c);
    results.push(r);
    console.log(
      r.ok
        ? `  ✓ ${c.padEnd(32)} ${String(r.ms).padStart(6)}ms`
        : `  ✗ ${c.padEnd(32)} ${String(r.ms).padStart(6)}ms  [${r.kind ?? '?'}${r.status ? '/' + r.status : ''}] ${r.detail}`,
    );
  }
  const bad = results.filter((r) => !r.ok);
  console.log(
    bad.length === 0
      ? `\n全部可用 (${results.length}/${results.length})。`
      : `\n⚠ ${bad.length}/${results.length} 个坐标不可用: ${bad.map((b) => b.coord).join(' · ')}\n` +
          '  改座位前先把它们从 .omd/config.json 里换掉 —— 别等跑到一半再从日志倒推。',
  );
  process.exit(bad.length === 0 ? 0 : 1);
}
