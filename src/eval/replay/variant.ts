/**
 * src/eval/replay/variant —— conductor 提示面 variant 物化 (P2 切片 1, 2026-09-01)。
 *
 * 磁盘格式: `runs/autoresearch/variants/<name>.json`
 *   shape = { version, name, fewShotCards?: [...], profileOverride?: ..., extraAppend?: [...] }
 *   加载: `readVariant(dir, name) → VariantSpec | null` (文件不存在 / 缺 version → null)
 *   写入: `writeVariant(dir, spec)` (mkdir -p + JSON.stringify + 末尾 \n)
 *   转换: `variantSpecToPromptOpts(spec) → VariantPromptOpts | undefined`
 *
 * C-1 / INV-1 守恒: 任何字段缺省 / spec 为 null → 转换结果 = undefined →
 *   `conductorSystemPrompt({ variant: undefined })` 与无 variant 字段调用**逐字节相同**
 *   (snapshot 测试守恒闸)。注入只走「明确在场」的字段, 不污染既有段落的生成逻辑。
 *
 * 反向自检 (锁死判据力):
 *   - 把 `extraAppend` 的 spread 删掉 → `VARIANT_BYTE_STABLE` 那条红 (variant 在场却
 *     不进 prompt, 但 opts 是 defined, 真值链失守);
 *   - 把 `fewShotCards` 的 if 守卫改成 always-add → bare 档的红 (因为 bare 早返, 不触
 *     注入, 这条验不到; 但 full 档会多一行 "Few-shot cards" header, snapshot 红);
 *   - 把 `writeVariant` 的 `mkdirSync({recursive:true})` 删掉 → 目录不存在时 ENOENT 红
 *     (写盘真在)。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ConductorPromptProfile } from '../../harness/conductor-plan';

/** Few-shot 卡 (autoresearch 内环的"图式样例"基本单元, 与 design v3 §3 同源)。 */
export interface VariantFewShotCard {
  /** 卡 id, 用于 cross-reference 与变异算子的 lineage 引用。 */
  id: string;
  /** 卡显示名 (≤ 80 code points, 归一化走 conductor-plan.ts 的 oneLineSummary 同款)。 */
  name: string;
  /** 卡正文 (单段文本, 拼进 prompt 的 few-shot 段; 行内换行视为多段)。 */
  body: string;
}

/** Variant 磁盘格式版本号 (改 shape 时 bump; load 校 version, 不匹配 → throw)。 */
export const VARIANT_VERSION = 1 as const;

/**
 * variant 磁盘 spec, 落在 `runs/autoresearch/variants/<name>.json`。
 *
 * 缺席语义: 任何字段缺省都视作"不覆盖" —— 不传 variant 给 conductorSystemPrompt
 * 就退化成现行 baseline 字节 (C-1 守恒闸)。这是与 `researchAvailable: undefined` 同款
 * 纪律: 缺席 = 不影响输出。
 */
export interface VariantSpec {
  /** 版本号, 加载时校验 (= VARIANT_VERSION)。 */
  version: typeof VARIANT_VERSION;
  /** variant 名 (= 文件名去后缀, 用于 trace 关联与 runner 选择)。 */
  name: string;
  /** few-shot 卡列表 (在场则替换 / 注入 baseline few-shot 段; 缺席 = 不动)。 */
  fewShotCards?: VariantFewShotCard[];
  /** profile 覆盖 (省略 → 不改 conductor profile, 与 caller 传的 profile 取交)。 */
  profileOverride?: ConductorPromptProfile;
  /** 额外追加段 (不替换任何既有内容, 只在 TRUST_FENCE_RULE 之前追加; 多次调用按数组序拼接)。 */
  extraAppend?: string[];
}

/** conductorSystemPrompt 的 variant opts 形状 (与 conductor-plan.ts 的耦合面)。 */
export interface VariantPromptOpts {
  /** few-shot 卡列表 (与 opts 一起注入)。 */
  fewShotCards?: VariantFewShotCard[];
  /** 额外追加段 (在 TRUST_FENCE_RULE 之前注入)。 */
  extraAppend?: string[];
}

/**
 * Read variant JSON. Returns null on missing file (C-1 缺席语义 = null = 不覆盖);
 * version 不匹配 → throw (不静默回落, 防版本漂移把旧 spec 当新用)。
 */
export function readVariant(dir: string, name: string): VariantSpec | null {
  const path = join(dir, `${name}.json`);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(`readVariant: "${path}" JSON parse failed — ${(e as Error).message}`);
  }
  const spec = parsed as VariantSpec;
  if (typeof spec !== 'object' || spec === null) {
    throw new Error(`readVariant: "${path}" must be a JSON object`);
  }
  if (spec.version !== VARIANT_VERSION) {
    throw new Error(
      `readVariant: unsupported version ${JSON.stringify(spec.version)} in "${name}" (expected ${VARIANT_VERSION})`,
    );
  }
  return spec;
}

/**
 * Write variant JSON to disk. mkdir -p parent dir; JSON.stringify(spec, null, 2) + 末尾 \n
 * (与 corpus.ts:writeManifest 同款)。返回写出的完整路径。
 */
export function writeVariant(dir: string, spec: VariantSpec): string {
  const path = join(dir, `${spec.name}.json`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(spec, null, 2)}\n`);
  return path;
}

/**
 * 把 VariantSpec 转成 conductorSystemPrompt opts 的 variant 段。
 *
 * 字段缺省 → undefined (C-1 守恒: opts.variant = undefined → 与无 variant 字段调用**逐字节相同**)。
 * 全字段缺省 → 返 undefined (call site 可直接 `?? undefined` 链上去)。
 */
export function variantSpecToPromptOpts(spec: VariantSpec | null): VariantPromptOpts | undefined {
  if (spec === null) return undefined;
  const opts: VariantPromptOpts = {};
  if (spec.fewShotCards !== undefined) opts.fewShotCards = spec.fewShotCards;
  if (spec.extraAppend !== undefined) opts.extraAppend = spec.extraAppend;
  return Object.keys(opts).length === 0 ? undefined : opts;
}

/** Marker for the byte-stable guarantee test (matches the verify command grep). */
export const VARIANT_BYTE_STABLE = 'VARIANT_BYTE_STABLE';

/**
 * Default variant directory per the autoresearch project convention
 * (`runs/autoresearch/variants/**`, 与 §决策 同款)。
 */
export const DEFAULT_VARIANT_DIR = 'runs/autoresearch/variants';