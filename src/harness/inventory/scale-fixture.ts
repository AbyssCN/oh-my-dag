/**
 * inventory/scale-fixture —— S2 规模实验的**确定性条目发生器** (2026-08-27)。
 *
 * ## 为什么需要它
 *
 * SDD §8 切片表 S2 要求「inventory 规模实验(20/50/100/200 条,单变量)」,
 * 执行契约 D-8 补:「同一构建的一组运行中**只改变条目数**,其他输入与环境冻结」。
 * 「冻结」这件事只有发生器确定性才做得到 —— 每档的第 k 条必须逐字节可复现,
 * 否则档与档之间差的就不止是条目数。
 *
 * SDD §10 另有一条硬要求:**外部读数不作判据** ——「39 工具≈15k token」
 * 「Top-K=20 饱和 88.1%」一律要在生产同款座位重测。本发生器就是那次重测的输入面。
 *
 * ## 确定性怎么来的
 *
 * 不用随机数, 不读时钟, 不读环境。第 k 条的每个字段都是 k 的纯函数
 * (`content_sha256` 用 k 填充十六进制, 时间戳用固定字面)。
 * 于是 `makeScaleInventory(50)` 的前 20 条与 `makeScaleInventory(20)` **逐字节相同** ——
 * 档与档之间是真正的嵌套关系, 不是四组无关样本。这条由 `scale-fixture.test.ts` 钉住。
 *
 * ## 刻意可调的第二个维度: 裸名歧义
 *
 * `ambiguousPairs` 制造「同一裸名跨两个 source」的条目对, 用来喂 F17
 * (`PP-T02` 同名歧义拒并列候选)。规模实验里它保持 **0** (单变量!);
 * 单独调它是另一个实验的事, 参数留在这里只是为了那时不用改发生器。
 *
 * @module
 */
import { InventoryEntrySchema, type InventoryEntry } from './inventory';

/** 冻结的时间字面 —— 发生器不许读时钟, 否则跨档不可比。 */
const FROZEN_TS = '2026-01-01T00:00:00Z';

/** 四档 = SDD §8 S2 逐字。放这里让脚本与测试共用同一份, 不各写各的。 */
export const SCALE_STEPS = [20, 50, 100, 200] as const;

export interface ScaleOptions {
  /**
   * 制造多少对「同裸名、不同 source」的条目 (喂 F17/PP-T02)。
   * **规模实验必须留 0** —— 一次只动一个变量。
   */
  ambiguousPairs?: number;
}

/** 第 k 条的 source 段: 四个源轮转, 让 id 前缀有真实分布而非全同。 */
const SOURCES = ['omd', 'ext', 'local', 'vendor'] as const;

/**
 * 造 n 条**schema 合法**的 inventory 条目, 逐字节确定性。
 *
 * 嵌套性质 (被测试钉住): `makeScaleInventory(m)` 是 `makeScaleInventory(n)` 的前缀 (m < n)。
 */
export function makeScaleInventory(n: number, opts: ScaleOptions = {}): InventoryEntry[] {
  if (!Number.isInteger(n) || n < 0) throw new Error(`makeScaleInventory: n 必须是非负整数, 收到 ${n}`);
  const ambiguousPairs = opts.ambiguousPairs ?? 0;
  if (ambiguousPairs * 2 > n) {
    throw new Error(`makeScaleInventory: ambiguousPairs*2 (${ambiguousPairs * 2}) 超过 n (${n})`);
  }

  const out: InventoryEntry[] = [];
  for (let k = 0; k < n; k++) {
    // 前 ambiguousPairs*2 条排成「两条共用一个裸名, source 不同」。
    // 其余条目裸名全局唯一 (resolve 应当命中唯一候选)。
    const inPair = k < ambiguousPairs * 2;
    const bare = inPair ? `amb-${Math.floor(k / 2)}` : `tool-${k}`;
    const source = SOURCES[k % SOURCES.length]!;

    out.push({
      id: `${source}:${bare}@1.0.${k}`,
      name: bare,
      // when_to_use 是 prompt 里真正占体积的那一段 (SDD §6 限 ≤100 token)。
      // 长度对 k 取模变化, 免得所有条目等长把体积读数做成一条直线。
      when_to_use: `use ${bare} when the task needs ${'capability '.repeat((k % 5) + 1)}`.trim(),
      effect: (['read', 'write', 'destructive', 'sidechain'] as const)[k % 4]!,
      safety_class: k % 3 === 0 ? 'pure' : k % 3 === 1 ? 'guarded' : 'privileged',
      cost_tier: (['t0', 't1', 't2', 't3'] as const)[k % 4]!,
      defer_mode: k % 2 === 0 ? 'eager' : 'lazy',
      signature: { inputs: [`in${k}`], outputs: [`out${k}`] },
      oracle: {
        kind: (['command', 'llm-judge', 'human', 'none'] as const)[k % 4]!,
        gateScriptRef: `test/fixtures/gate-${k}.sh`,
      },
      probe_state: 'UNPROBED',
      applicability: 'APPLICABLE',
      idle_days: k % 30,
      provenance: {
        registered_at: FROZEN_TS,
        registered_by: 'scale-fixture',
        source_repo: `${source}/repo`,
        source_path: `src/tools/${bare}.ts`,
        commit_sha: `sha${k}`,
        import_method: 'git',
        imported_at: FROZEN_TS,
        imported_by: 'scale-fixture',
        upstream_version: `1.0.${k}`,
        // 64 位十六进制且随 k 变 —— 用 k 的十六进制左填充, 不用随机。
        content_sha256: k.toString(16).padStart(64, '0'),
        schema_version: '1.0',
      },
      search_hint: `${bare} ${source} scale fixture`,
      owner_pinned: false,
      oracle_bearing: k % 7 === 0,
    });
  }
  return out;
}

/**
 * 体积读数 —— 用来重测「39 工具≈15k token」那条外部主张 (SDD §10)。
 *
 * ⚠ `approxTokens` 是**估算**, 不是分词器读数: 按 4 字符 ≈ 1 token 的粗口径。
 * 真要下判据必须换成生产同款分词器 —— 这个字段的存在只是为了让量级可比,
 * 报告里必须标明它是估算 (仓规: 别把推断当事实)。
 */
export interface InventoryBulk {
  entries: number;
  jsonBytes: number;
  /** 只算真正会进 prompt 的那几个字段 (id/name/when_to_use/effect/cost_tier)。 */
  promptFacingBytes: number;
  approxTokens: number;
}

export function measureBulk(entries: InventoryEntry[]): InventoryBulk {
  const jsonBytes = Buffer.byteLength(JSON.stringify(entries), 'utf8');
  const promptFacing = entries
    .map((e) => `${e.id} ${e.name} ${e.when_to_use} ${e.effect} ${e.cost_tier}`)
    .join('\n');
  const promptFacingBytes = Buffer.byteLength(promptFacing, 'utf8');
  return {
    entries: entries.length,
    jsonBytes,
    promptFacingBytes,
    approxTokens: Math.round(promptFacingBytes / 4),
  };
}

/** 发生器自证: 每条都过 schema。造出非法条目就等于整个实验的输入面是坏的。 */
export function assertAllValid(entries: InventoryEntry[]): void {
  for (const e of entries) InventoryEntrySchema.parse(e);
}
