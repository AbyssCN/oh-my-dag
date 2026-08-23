/**
 * src/harness/gates/gate-registry.ts —— 「判生死的图级闸」登记 + 对账闸
 *
 * ## 为什么要有它(2026-08-23 实测, 片 5 第一步)
 *
 * 一道闸**有没有被删掉 / 改名**——今天两种都是静默的:
 *  - 闸被删: 那行判词字面量从源码消失, 没有任何东西钉着它该在那儿
 *  - 闸被改名: 它的语义还在, 但日志/读数板上不再出现原措辞, 检索全靠人记
 *
 * 这张表是**字面量级**的锚: 判词原文(去掉前缀) + 声明文件 + 出现次数。三位一体:
 *  - 改名 ⇒ 整串找不到 ⇒ 红
 *  - 删掉 ⇒ 次数变 0 ⇒ 红
 *  - 复制到第二处 / 实装重排 ⇒ 次数变了 ⇒ 红, 要人来抬这个数
 *
 * ⚠ 本片不治「悄悄不再被调用」—— 判词字面量还在文件里, 但代码已经走不到。
 *    对账闸看不出来 (见未决)。
 *
 * ## 字段语义
 *
 * `verdict`: 判词**去掉前缀的原文**。匹配时由对账函数补回 `VERDICT_PREFIX`,
 *   整串 = `VERDICT_PREFIX + verdict`。
 *   为什么不直接把 prefix 写进表: prefix 是 [omd/executor-dag] 的产物标记, 表只关心**可
 *   读的判词内容**。要不要换 marker 留那片 id 化再说。
 *
 * `count`: 实装中**整串应在 `file` 里出现**的次数。
 *   `split(verdict).length - 1` 式的字符串包含计数, 不用正则 (中文标点)。
 *
 * ## ⚠ 与契约表的偏差(实测后定型)
 *
 * 契约表 (`command 节点未命中 expect_exit → failed (D-K)` 的 count = 2) 是 2026-08-23
 * 「六个核心文件」的累计口径 (含 sdd-compile.ts 的注释),
 * 而本表的 INV-2 要求「在声明的文件里出现的次数 = count」—— 在 `src/harness/dag/engine.ts`
 * 当前实测只有 **1** 次。本片不动 `engine.ts` (INV-6), 按本地数落。
 */

/** 引擎侧判词前缀。对账函数拼整串时补上, 表里只放纯判词。 */
export const VERDICT_PREFIX = '[omd/executor-dag] ';

export interface GateEntry {
  id: string;
  family: string;
  file: string;
  /** 判词原文(去掉 `[omd/executor-dag] ` 前缀)。匹配 = prefix + verdict。 */
  verdict: string;
  /** 实装中该整串应在 `file` 里出现几次。 */
  count: number;
}

/**
 * 判生死的图级闸。**12 项** —— 一道闸可能有多条判词 (通过/拒绝/fail-open),
 * 但本表只收**判定生死的那一条**, 别的归旁路。
 *
 * ⚠ 偏离契约: `oracle-exit-miss.count` = 1 (不是契约表的 2); 见文件头注释。
 *    别的 11 项与契约表逐字一致。
 */
export const GATE_REGISTRY: readonly GateEntry[] = [
  {
    id: 'artifact-empty',
    family: '产物闸',
    file: 'src/harness/dag/engine.ts',
    verdict: '产物校验失败 → 节点 failed (拒绝 empty-done)',
    count: 1,
  },
  {
    id: 'artifact-verdict',
    family: '产物闸',
    file: 'src/harness/dag/engine.ts',
    verdict: '产物闸判定 (declaredArtifact 节点; entry = 进闸条数)',
    count: 3,
  },
  {
    id: 'artifact-broken',
    family: '产物闸',
    file: 'src/harness/dag/engine.ts',
    verdict: '写后即验: 节点写完之后文件语法解析不过 → 节点 failed (部分写入损坏)',
    count: 1,
  },
  {
    id: 'heartbeat',
    family: '心跳闸',
    file: 'src/harness/dag/engine.ts',
    verdict: 'agent leaf 停摆 (心跳闸) → 节点 failed',
    count: 1,
  },
  {
    id: 'fuse-action',
    family: '空转熔断',
    file: 'src/harness/dag/engine.ts',
    verdict: '动作级熔断 → 环提前退出 (§8.4)',
    count: 1,
  },
  {
    id: 'fuse-judge',
    family: '空转熔断',
    file: 'src/harness/dag/engine.ts',
    verdict: '闸级熔断 → 环提前退出 (infra-error, 不烧剩余轮数)',
    count: 1,
  },
  {
    id: 'fuse-spin',
    family: '空转熔断',
    file: 'src/harness/dag/engine.ts',
    verdict: 'agent leaf 空转熔断 → 节点 failed',
    count: 1,
  },
  {
    id: 'fuse-samecause',
    family: '空转熔断',
    file: 'src/harness/dag/engine.ts',
    verdict: 'D-6 同因熔断 → 停止重试 (连撞同一根因), STALLED 交人',
    count: 1,
  },
  {
    id: 'oracle-exit-miss',
    family: 'expect_exit',
    file: 'src/harness/dag/engine.ts',
    verdict: 'command 节点未命中 expect_exit → failed (D-K)',
    // ⚠ 见文件头: 契约表写 2, 当前 engine.ts 实测 1; 本片取实测值 (不动 engine.ts)。
    count: 1,
  },
  {
    id: 'oracle-exit-scope',
    family: 'expect_exit',
    file: 'src/harness/dag/engine.ts',
    verdict: 'expect_exit 只对 executor:command 生效 → 本节点忽略 (D-K)',
    count: 1,
  },
  {
    id: 'writescope-drop',
    family: '写域越界',
    file: 'src/harness/dag/engine.ts',
    verdict: '产物闸写域外路径剔除 (不参与判死, 仅记账; s1 Step C)',
    count: 1,
  },
  {
    id: 'false-completion',
    family: '谎报完成',
    file: 'src/harness/dag/engine.ts',
    verdict: 'D-4 谎报完成闸: 声称完成而验收命令实败 → 判未收敛',
    count: 1,
  },
];

export type GateDriftReason = 'missing' | 'count-mismatch';

export interface GateDrift {
  id: string;
  expected: number;
  actual: number;
  reason: GateDriftReason;
}

/**
 * 对账。**纯函数** —— 接受 (registry, readFile), 不直接读盘。
 * 返回漂移表; 空数组 = 当前闸与代码一致。
 *
 * 漂移语义:
 *  - `actual === 0` ⇒ missing(闸被删, 整串找不到)
 *  - `actual !== expected` ⇒ count-mismatch(闸被复制 / 实装重排)
 *
 * 文件级缓存: 同一文件被多条 entry 引用时不重复读。
 */
export function reconcileGates(
  registry: readonly GateEntry[],
  readFile: (path: string) => string,
): GateDrift[] {
  const drifts: GateDrift[] = [];
  const cache = new Map<string, string>();
  for (const entry of registry) {
    let content = cache.get(entry.file);
    if (content === undefined) {
      content = readFile(entry.file);
      cache.set(entry.file, content);
    }
    const full = VERDICT_PREFIX + entry.verdict;
    const actual = (content.split(full).length - 1);
    if (actual === 0) {
      drifts.push({ id: entry.id, expected: entry.count, actual, reason: 'missing' });
    } else if (actual !== entry.count) {
      drifts.push({ id: entry.id, expected: entry.count, actual, reason: 'count-mismatch' });
    }
  }
  return drifts;
}

/** 人读判词(CI 日志 / 本地跑都用这一份, 别两处各拼一次)。 */
export function formatGateDrift(d: GateDrift): string {
  if (d.reason === 'missing') {
    return `[${d.id}] 整串找不到 (actual 0, expected ${d.expected}) ⇒ 判词被改名或闸被删; 修: 在 \`${'src/harness/dag/engine.ts'}\` 找回原句, 或在表里同步更新。`;
  }
  return `[${d.id}] 计数不匹配 (actual ${d.actual}, expected ${d.expected}) ⇒ 判词被复制到第二处 / 实装重排; 修: 抬表里的 \`count\` 与实装同步。`;
}
