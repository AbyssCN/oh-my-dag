#!/usr/bin/env bun
/**
 * scripts/bench-bootstrap —— bench 容器的一次性配置引导 (E1b, 2026-08-26)。
 *
 * 场景: workbuddy-bench 等评测容器里只有**单一模型端点** (bench proxy 或直连), 没有本机的
 * 多渠道世界。本脚本把 omd 的全部座位钉到这一个坐标上, 让 `omd solve` 在容器内可跑。
 *
 * 读 env (全部必填, 缺任一响亮退出非零 —— fail-closed, 不写半套配置):
 *   OMD_BENCH_BASE_URL   OpenAI/Anthropic 兼容端点
 *   OMD_BENCH_MODEL      模型 id (coord 后缀)
 *   OMD_BENCH_API        'openai-completions' | 'anthropic-messages' (缺省 openai-completions)
 *   (key 本身放 OMD_BENCH_API_KEY, 由 provider 条目以 $引用, 本脚本不读它的值)
 *
 * 做两件事, 全走既有真源零新语义:
 *   1. upsertProvider → models.json 登记 provider 'bench' (src/model/models-json.ts:241);
 *   2. 写 <cwd>/.omd/config.json 的 models: 全 18 座 (src/model/seats.ts SEATS) → 'bench:<model>'。
 *
 * ⚠ verifier 的关闭**不在这里** —— 那是运行时旗标 OMD_VERIFY=0 (src/harness/verifier.ts:70),
 *   由 adapter 的 run() 环境带, 配置文件不该固化它 (bench 模式明示响亮降级, 见 E1 设计笔记裁1)。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { upsertProvider } from '../src/model/models-json';
import { SEATS } from '../src/model/seats';

/** 三角色座位分组 (镜像生产 config: claude-code 组=指挥, openai-codex 组=审核, 其余=worker)。 */
const CONDUCTOR_SEATS = new Set(['conductor', 'escalation', 'fusion', 'graft']);
const VERIFIER_SEATS = new Set(['verifier', 'review', 'review-spec']);
/**
 * judge 的独立第四坐标 (P2d 子修 3, 2026-09-02, 可选/加法, 不改三角色模式默认行为)。
 *
 * 为什么不把 'judge' 塞进 VERIFIER_SEATS: `src/model/seats.ts` 里 verifier 的
 * `crossFamily` 是 `'required'` 且注释明写「必须与 conductor/judge 异族」——
 * 塞进去会让 `models.judge === models.verifier`, 直接违反这条**更强**的约束,
 * 换来的只是缓解 judge 自己那条更弱的 `'preferred'`。真正两条都不违反的解法
 * 是给 judge 一个**独立**坐标, 缺省 (不给 `OMD_BENCH_JUDGE_MODEL`) 时行为
 * 与今天逐字节相同 —— judge 落回 worker (w) 分支, 不强制三角色调用方多传第四个 env。
 */
const JUDGE_SEATS = new Set(['judge']);

/**
 * 纯函数: 由 env 算出 config.json 的 models 段 (18 座全钉)。
 * 两种模式, fail-closed 不写半套:
 *  - 三角色 (owner E2 选型): OMD_BENCH_CONDUCTOR_MODEL + OMD_BENCH_WORKER_MODEL +
 *    OMD_BENCH_VERIFIER_MODEL 三者**齐**给 (缺任一 throw), 座位按组分派;
 *    可选加 OMD_BENCH_JUDGE_MODEL 给 judge 一个独立第四坐标 (P2d 子修 3, 2026-09-02) ——
 *    不给时 judge 落回 worker 坐标, 与本坐标出现之前逐字节相同 (不强制既有三件套调用方多传)。
 *  - 单模型回退: 只给 OMD_BENCH_MODEL → 18 座全钉一个坐标。
 */
export function benchSeatModels(env: Record<string, string | undefined>): Record<string, string> {
  const c = env.OMD_BENCH_CONDUCTOR_MODEL?.trim();
  const w = env.OMD_BENCH_WORKER_MODEL?.trim();
  const v = env.OMD_BENCH_VERIFIER_MODEL?.trim();
  // 可选第四坐标 (P2d 子修 3): 不给 → j 是 undefined, 下面三元表达式的 j 分支永不命中,
  // judge 落回 w 分支 —— 与本坐标出现之前逐字节相同, 不逼三角色调用方多传一个 env。
  const j = env.OMD_BENCH_JUDGE_MODEL?.trim();
  // ⚠ P2 审 (2026-09-02): j 必须一起进 anyRole —— 否则「只给 OMD_BENCH_MODEL + JUDGE」
  // 会静默落进下面的单模型分支, JUDGE 一个字都不生效 (配了不生效的空旋钮, 本仓要杀的形态);
  // 落进三角色分支后 c/w/v 不齐照样 fail-closed throw, 不会因为多了 j 而放宽三件套要求。
  const anyRole = Boolean(c || w || v || j);
  if (anyRole) {
    if (!(c && w && v))
      throw new Error('bench-bootstrap: 三角色模式要求 CONDUCTOR/WORKER/VERIFIER 三个 OMD_BENCH_*_MODEL 齐给 (fail-closed, 不写半套配置)');
    return Object.fromEntries(
      SEATS.map((s) => [
        s.id,
        `bench:${CONDUCTOR_SEATS.has(s.id) ? c : VERIFIER_SEATS.has(s.id) ? v : j && JUDGE_SEATS.has(s.id) ? j : w}`,
      ]),
    );
  }
  const model = env.OMD_BENCH_MODEL?.trim();
  if (!model) throw new Error('bench-bootstrap: OMD_BENCH_MODEL (或三角色三件套) 缺失 (fail-closed, 不写半套配置)');
  const coord = `bench:${model}`;
  return Object.fromEntries(SEATS.map((s) => [s.id, coord]));
}

/** 写 <cwd>/.omd/config.json (保留既有其它键, models 整段覆盖)。 */
export function writeBenchConfig(cwd: string, models: Record<string, string>): string {
  const dir = join(cwd, '.omd');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const path = join(dir, 'config.json');
  let existing: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      existing = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    } catch (e) {
      // 吞异常不许吞证据: 坏 JSON 视为空配置重建, 但原文错误要留痕。
      process.stderr.write(`[bench-bootstrap] 既有 config.json 解析失败, 整体重建: ${(e as Error).message}\n`);
    }
  }
  const next = { version: 1, ...existing, models };
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`);
  return path;
}

if (import.meta.main) {
  const baseUrl = process.env.OMD_BENCH_BASE_URL?.trim();
  const api = process.env.OMD_BENCH_API?.trim() || 'openai-completions';
  if (!baseUrl) {
    process.stderr.write('bench-bootstrap: OMD_BENCH_BASE_URL 缺失\n');
    process.exit(1);
  }
  let models: Record<string, string>;
  try {
    models = benchSeatModels(process.env);
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n`);
    process.exit(1);
  }
  // provider 的 model 条目 = 座位映射里出现过的全部裸 id (单模型 1 个, 三/四角色 ≤4 个)。
  const ids = [...new Set(Object.values(models).map((c) => c.slice('bench:'.length)))];
  upsertProvider({ id: 'bench', baseUrl, keyEnv: 'OMD_BENCH_API_KEY', api, models: ids.map((id) => ({ id })) });
  const path = writeBenchConfig(process.cwd(), models);
  process.stderr.write(`[bench-bootstrap] provider 'bench' → models.json · ${Object.keys(models).length} 座 → {${ids.join(', ')}} · ${path}\n`);
}
