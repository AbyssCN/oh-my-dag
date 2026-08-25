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

/** 纯函数: 由 env 算出 config.json 的 models 段 (18 座全钉)。缺必填 → throw (响亮)。 */
export function benchSeatModels(env: Record<string, string | undefined>): Record<string, string> {
  const model = env.OMD_BENCH_MODEL?.trim();
  if (!model) throw new Error('bench-bootstrap: OMD_BENCH_MODEL 缺失 (fail-closed, 不写半套配置)');
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
  const modelId = process.env.OMD_BENCH_MODEL!.trim();
  upsertProvider({ id: 'bench', baseUrl, keyEnv: 'OMD_BENCH_API_KEY', api, models: [{ id: modelId }] });
  const path = writeBenchConfig(process.cwd(), models);
  process.stderr.write(`[bench-bootstrap] provider 'bench' → models.json · ${Object.keys(models).length} 座 → bench:${modelId} · ${path}\n`);
}
