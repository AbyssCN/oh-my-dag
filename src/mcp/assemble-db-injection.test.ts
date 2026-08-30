/**
 * src/mcp/assemble-db-injection.test —— 「调 `assembleOmdMcpTools` 的测试必须把开库的接缝全注掉」。
 *
 * ## 这条闸拆的是什么
 *
 * `assembleOmdMcpTools` 内部会开**两个真库**,两个的默认路径都是**进程 cwd 相对**的串:
 *   · `createDagRecorder()`      → `.omd/dag-runs.db`     (dag-record.ts)
 *   · `createModelRouterFromEnv()` → `.omd/model-router.db` (model-router.ts:90)
 *
 * 测试跑在真仓根上, 于是这两句开的都是**真仓那两个库**。宿主上只要还有一个活的 omd 进程
 * 握着它们(实测: bench 模型桥 `scripts/bench-bridge.ts`), 就并发出
 * `SQLiteError: disk I/O error` —— **红的是测试基建, 不是被测代码**。
 *
 * 症状很难抓: **全量偶尔 1 fail、单跑必绿**(单跑时外部进程恰好没在写)。
 * 2026-08-30 实测一次: 全量 8524 tests 1 fail(`chat-seat.test.ts` 的 ★ 指挥面没被挤掉),
 * 同一份测试单跑连续三遍 18 pass / 0 fail;栈顶 `model-router.ts:92 new Database(path)`。
 *
 * ## 为什么是闸不是注释
 *
 * `chat-seat.test.ts:19` 早就用注释写清了 recorder 那一半的坑, 而 router 那一半照样漏了
 * **四个文件**。本仓判据:「能做成会红的闸就别写在散文里」。这一条把"记得注入"变成机械的。
 *
 * ## 反向自检(当场证伪过)
 *
 * 把任意一个被扫文件里的 `router:` 那行删掉 → 本闸当场红, 并把文件名和缺哪一个印出来。
 * 2026-08-30 实测: 补这一条之前, 五个文件里有 **4 个**缺 `router:`。
 *
 * ⚠ 判据是**文本**的(文件里有没有那个键), 不是运行时的 —— 与本仓既有的源码面闸同款
 * (`chat-seat.test.ts` 的 `tuiBranch()`)。代价: 把 deps 拆到另一个文件里构造的写法会被误判。
 * 今天没有那种写法; 真出现了, 改判据别改闸(把那个文件加进豁免表并写清为什么)。
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(import.meta.dir, '..');

/** 开库接缝: 键名 → 一句话为什么不注它会假红。 */
const REQUIRED_INJECTIONS: Record<string, string> = {
  'recorder:': '默认 createDagRecorder() 开真仓 .omd/dag-runs.db',
  'router:': '默认 createModelRouterFromEnv() 开真仓 .omd/model-router.db',
};

/** 豁免表 —— 空的。有条目时必须在这里写清为什么(见文件头最后一段)。 */
const EXEMPT: ReadonlySet<string> = new Set<string>([
  'assemble-db-injection.test.ts', // 本闸自己: 它只读文件不装配
]);

function allTestFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) allTestFiles(p, out);
    else if (name.endsWith('.test.ts')) out.push(p);
  }
  return out;
}

describe('assembleOmdMcpTools 的开库接缝必须被注掉 (并发假红闸)', () => {
  test('★ 每个调 assembleOmdMcpTools 的测试文件都注了 recorder + router', () => {
    const offenders: string[] = [];
    let scanned = 0;
    for (const f of allTestFiles(SRC)) {
      const base = f.split('/').pop() as string;
      if (EXEMPT.has(base)) continue;
      const src = readFileSync(f, 'utf8');
      if (!src.includes('assembleOmdMcpTools(')) continue;
      scanned += 1;
      const missing = Object.entries(REQUIRED_INJECTIONS)
        .filter(([key]) => !src.includes(key))
        .map(([key, why]) => `${key} (${why})`);
      if (missing.length) offenders.push(`${f.slice(SRC.length + 1)} 缺: ${missing.join(' · ')}`);
    }
    // 扫到 0 个文件 = 判据锚点漂了(函数改名了), 那时这条闸是"永远绿"的 —— 当场红比静默绿好。
    expect(scanned, 'assembleOmdMcpTools 一个调用点都没扫到 —— 判据锚点漂了').toBeGreaterThan(0);
    expect(offenders, `以下测试会开真仓的库, 外部 omd 进程活跃时并发假红:\n${offenders.join('\n')}`).toEqual([]);
  });
});
