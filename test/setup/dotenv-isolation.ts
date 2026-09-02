/**
 * test/setup/dotenv-isolation —— **仓根 `.env` 不许灌进测试进程**(2026-09-03, next-session N1 / Q4)。
 *
 * ## 它修的是什么
 *
 * bun 启动时自动把 `<cwd>/.env` 读进 `process.env`, `bun test` 也不例外。仓根 `.env` 里有真凭证
 * (`MIMO_API_KEY` 等 21 个键), 于是**任何先跑过 `bootstrapModelRuntime()` 的用例**都会把 `mimo`
 * 注册进进程全局 provider 表, 后面的用例拿到的座位就被顺延 —— 全量读数变成**机器相关的**:
 * 这台机有 `.env` 就红这两条, 干净机器不红 (2026-09-02 T6 追 review 两条红时定位到的)。
 * 跨机器比红集之前, 这件事必须先消掉。
 *
 * ## 做法: 单点, 零测试文件改动
 *
 * `[test].preload` 在每个测试进程启动时、任何用例之前跑一次 (与 tmpdir-isolation 同一时点)。
 * 这里读 `.env` 的**键名** (不读值), 把这些键从 `process.env` 删掉。规则是「`.env` 里声明了什么就删什么」,
 * 不维护一张会过期的键名清单 —— `.env` 加一个键, 隔离自动覆盖它。
 *
 * ## ⚠ 已知不覆盖面 (与 tmpdir-isolation 同源, 实测过)
 *
 * `Bun.spawn` 的默认 env 是**进程启动时的快照**, 这里删 `process.env` 到不了子进程; 而且子进程若是
 * `bun run src/harness/cli.ts` 之类, 它自己会再读一次仓根 `.env`。所以本件只管**进程内**那条路
 * (N1 定位到的正是进程内的 provider 注册表), 真子进程用例仍看得见 `.env`。要盖那一面得逐个 spawn 点
 * 传 `env`, 不为一个还没量到的问题加机制。
 *
 * ## 逃生口
 *
 * `OMD_TEST_KEEP_DOTENV=1` 保留 `.env` (只给本地手动跑 live 探针用; 全量读数一律不带它)。
 *
 * 会红的闸: `test/setup/dotenv-isolation.test.ts` (★① 删掉 bunfig 的 preload 行即红 —— 前提是这台机的
 * `.env` 里真有键; 没有 `.env` 的机器上 ★① 是空判, 由 ★② 的纯函数用例兜底)。
 * 纯函数在 `dotenv-keys.ts`: 闸只 import 那边 —— import 本文件的副作用会替 preload 干活, 闸就永远绿。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { STRIPPED_MARKER, dotenvKeyNames, stripKeys } from './dotenv-keys';

const DOTENV_PATH = join(process.cwd(), '.env');

/** 本进程里从 `.env` 来、并且被删掉的键名。**导出**给闸用 —— 闸要能断言"我们确实删了"。 */
export const STRIPPED_DOTENV_KEYS: readonly string[] = (() => {
  if (process.env.OMD_TEST_KEEP_DOTENV === '1') {
    console.error('[dotenv-isolation] OMD_TEST_KEEP_DOTENV=1 → 保留仓根 .env (本轮读数带凭证, 不可跨机器比)');
    return [];
  }
  if (!existsSync(DOTENV_PATH)) return [];
  let text: string;
  try {
    text = readFileSync(DOTENV_PATH, 'utf8');
  } catch (e) {
    // fail-open 可以吞异常, 不许吞证据。
    console.error(`[dotenv-isolation] 读 .env 失败, 本轮未隔离: ${(e as Error).message}`);
    return [];
  }
  return stripKeys(process.env, dotenvKeyNames(text));
})();

// 标记给闸读 (闸不 import 本文件)。空串也写: 「preload 跑了但一个没删」与「preload 没跑」要分得开。
process.env[STRIPPED_MARKER] = STRIPPED_DOTENV_KEYS.join(',');
if (STRIPPED_DOTENV_KEYS.length > 0) {
  console.error(`[dotenv-isolation] 已从测试进程删掉仓根 .env 的 ${STRIPPED_DOTENV_KEYS.length} 个键`);
}
