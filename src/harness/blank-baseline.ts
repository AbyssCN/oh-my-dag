/**
 * src/harness/blank-baseline —— 空白基线的具名 keyed 缓存(grill 契约 C-6 / 普查 §2.2)。
 *
 * ## 为什么是它、不是 command 结果缓存
 *
 * 每次 worktree 派单起跑都全量 `bun install + bunx tsc + bun test`(实测 ~62s + 237 包,
 * 且同 HEAD 两次的 fail 名字集逐条相同)。command-leaf 结果缓存那条路**已试过、量过、
 * 删掉并立了反向闸**(`command-leaf-cache-scope.test.ts` §3.1:长驻进程跨 run 吐旧值 /
 * 图内写后读旧)。正确形状 = **具名的、显式 keyed 的基线记录,由派单/判读那一层读**,
 * 而不是让命令串"看起来跑了其实没跑" —— 本模块即该记录;消费方 = 派单任务书里的
 * 基线节点(调 `scripts/omd-blank-baseline.ts`),引擎零改动。
 *
 * ## key 与失效方向(普查 §2.2,不对称!)
 *
 * key = (HEAD sha, 树干净, lockfile hash) **全等才命中**,任一不等即重跑:
 * - 乐观陈旧(少记红)→ 真基线红被当新增 → 白烧修复轮(可恢复,吵);
 * - **悲观陈旧(多记红)→ 真回归被赦免成"基线本来就红"(静默,致命)** ——
 *   所以脏树**永不写缓存**(脏树的红没有稳定身份),命中时必须把采集时刻 + 来源 runId
 *   一起报出来,不许无声使用(消费方把它写进报告,事后可审)。
 */
import { existsSync, readFileSync, renameSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';

export interface BaselineKey {
  /** `git rev-parse HEAD`(全长)。 */
  head: string;
  /** `git status --porcelain` 为空。脏树永不入缓存。 */
  cleanTree: boolean;
  /** bun.lock 内容 sha256(依赖变了基线作废)。 */
  lockHash: string;
}

export interface BaselineRecord {
  key: BaselineKey;
  /** 采集时刻(ISO)—— 命中时必须随记录报出。 */
  at: string;
  /** 采集方 runId(来源可审)。 */
  runId?: string;
  tscExit: number;
  /** `(fail)` 测试名字全集 —— 判据是集合比较不是计数。 */
  failSet: string[];
  pass: number;
  fail: number;
  skip: number;
}

interface BaselineFile {
  records: BaselineRecord[];
}

/** 保留最近 N 条(不同 HEAD 各一条;同 key 覆盖)。 */
const MAX_RECORDS = 5;

export function keyEquals(a: BaselineKey, b: BaselineKey): boolean {
  return a.head === b.head && a.cleanTree === b.cleanTree && a.lockHash === b.lockHash;
}

export function lockHashOf(lockContent: string): string {
  return createHash('sha256').update(lockContent).digest('hex').slice(0, 16);
}

/** 读缓存记录。坏文件 fail-open 按空(留证据归 caller 的 logger,本模块纯函数不带 logger)。 */
export function readBaselineStore(path: string): BaselineFile {
  if (!existsSync(path)) return { records: [] };
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as BaselineFile;
    return { records: Array.isArray(raw.records) ? raw.records : [] };
  } catch {
    return { records: [] };
  }
}

/**
 * 查命中:key 全等才命中(C-6)。命中返回记录本体 —— 消费方**必须**把
 * `at` + `runId` 写进自己的报告(不许无声使用)。
 */
export function lookupBaseline(path: string, key: BaselineKey): BaselineRecord | null {
  if (!key.cleanTree) return null; // 脏树连查都不查:脏树的红没有稳定身份
  const { records } = readBaselineStore(path);
  return records.find((r) => keyEquals(r.key, key)) ?? null;
}

/** 写记录(同 key 覆盖;超额裁老)。脏树拒写 —— 悲观陈旧是静默致命面。 */
export function writeBaseline(path: string, record: BaselineRecord): void {
  if (!record.key.cleanTree) {
    throw new Error('blank-baseline: 脏树基线拒入缓存 (脏树的红没有稳定身份, 悲观陈旧会赦免真回归)');
  }
  const { records } = readBaselineStore(path);
  const rest = records.filter((r) => !keyEquals(r.key, record.key));
  rest.push(record);
  while (rest.length > MAX_RECORDS) rest.shift();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify({ records: rest }, null, 1)}\n`);
  renameSync(tmp, path);
}

/** 从 bun test 输出提取 `(fail)` 名字集(与 S4-S6 图的 N5 集合比较同刀法)。 */
export function extractFailSet(testOutput: string): string[] {
  const out = new Set<string>();
  for (const m of testOutput.matchAll(/^\(fail\)\s+(.+?)(?:\s+\[[\d.]+m?s\])?$/gm)) {
    out.add(m[1]!.trim());
  }
  return [...out].sort();
}

/** 默认存储路径(相对仓根显式拼,不吃进程 cwd —— 2026-08-10 一天三踩的锚陷阱)。 */
export function baselineStorePath(repoRoot: string): string {
  return join(repoRoot, '.omd', 'blank-baseline.json');
}
