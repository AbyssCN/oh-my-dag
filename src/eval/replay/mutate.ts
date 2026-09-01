/**
 * src/eval/replay/mutate —— 变异算子 (P2 切片 2, 2026-09-01, INV-2 / C-2)。
 *
 * Lineage 条件反思变异: 给 (父代 VariantSpec, 非 heldout 败因摘要) → 调 LLM 产子代
 * VariantSpec。父代 + 子代都经 `runs/autoresearch/variants/<name>.json` 落地
 * (与 slice 1 同源磁盘格式)。
 *
 * ## 约束 (INV-2 / C-2)
 *
 *   - prompt 字符串**不含** heldout 条目 id 与 `fitness.ts` 函数名 —— 变异只见父代
 *     variant + 败因, 不见尺子实现与 heldout 语料。闸落点 = `buildMutationPrompt` 硬
 *     编码模板 + 调用方 caller 侧 filter (本文件不持 corpus 知识, 不去 corpus 拉任何东西)。
 *   - provider 注入点: 默认 `defaultMutationProvider` (P2b 切片 1 接真联机, 与
 *     `autoresearch-replay.defaultLiveProvider` 同层同形); 测试通过
 *     `opts.mutationProvider` 注入 fake, 整链零 LLM 调用。
 *
 * ## 反向自检 (锁死判据力)
 *
 *   - 把 `parentSection` 从 buildMutationPrompt 删掉 → 「prompt 真含父代」那条红
 *     (变异失父代 lineage, reflection 失据);
 *   - 把 `failureSection` 从 buildMutationPrompt 删掉 → 「prompt 真含败因」那条红
 *     (lineage 条件失据);
 *   - 在 sys 模板里加 `fakeSerialPairsOf` 之类的 fitness 函数名 → MUTATE_BLIND_TO_RULER
 *     红 (反查闸真在);
 *   - 把 `defaultMutationProvider` 改成 noop → 任何不装 fake provider 的测试红
 *     (provider 注入点是合同面, 不是装饰);
 *   - 把 `validateChildSpec` 的「unknown field」守卫去掉 → profileOverride 等被偷塞
 *     的字段也能通过 (anti-cheat 闸失守), 锁这条要靠对 unknown field 的负面断言;
 *   - 把 defaultMutationProvider 的 `await llmCaller(` 删了 → LIVE_MUTATION_WIRED 红
 *     (真联机路径存在, 不是 stub 短路);
 *   - 把 defaultMutationProvider 的 seats 强校验删了 → 任何不带 seats 的 ctx 仍跑通,
 *     LIVE_MUTATION_WIRED「无 seats → throw」红 (fail-closed 真在, 不是 silent noop)。
 */
import type { AggregatedFitness } from './fitness';
import { VARIANT_VERSION, type VariantFewShotCard, type VariantSpec } from './variant';
import { bootstrapModelRuntime } from '../../model/bootstrap';
import { send } from '../../model/gateway';
import type { GatewayRequest, ModelResponse } from '../../model/gateway';
import { tryResolveSeatModel } from '../../model/role-models';

/** Marker for the blind-to-ruler guarantee test (matches the verify command grep). */
export const MUTATE_BLIND_TO_RULER = 'MUTATE_BLIND_TO_RULER';

/**
 * 败因摘要 = 调用方喂给变异算子的输入。
 *
 * `perItem` 只含 screen + main (caller 闸, 本文件不持 corpus 知识 —— 见上注释)。
 * `aggregate` 是父代的聚合 fitness, 主要供变异算子看到**主目标**趋势。
 */
export interface MutationFailure {
  /** 逐题败因: 父代跑出来的非 heldout 题 (id + 自由文本 reason)。 */
  perItem: ReadonlyArray<{ id: string; reason: string }>;
  /** 父代聚合 fitness (caller 选传, 通常是 select 阶段的主段读数)。 */
  aggregate: AggregatedFitness;
}

/**
 * 变异上下文: 第几代 / 同代内第几个子代 / 父代名 / 座位签名。
 * 三者只用于 prompt 区分 (让不同代/不同 childIdx 的 prompt 形态不同, 鼓励
 * 差异化变异), 不进子代 spec; `seats` 是 live 联机通路专用 (defaultMutationProvider
 * 解析 conductor coord 用), 测试不必传 —— 缺 seats 走 throw (fail-closed)。
 */
export interface MutationContext {
  /** 代号 (0 = 基线代; 此时 parent 必为 null)。 */
  genIdx: number;
  /** 同代内 child 序号 (0..K-1)。 */
  childIdx: number;
  /** 父代 variant 名 (供日志/trace; 若 parent=null, 通常填 'baseline')。 */
  parentName: string;
  /**
   * 冻结时刻座位签名 (P2b 切片 1 LIVE_MUTATION_WIRED) —— 与 `autoresearch-replay
   * .LiveProviderContext.seats` 同形, 保证回放与冻结时刻座位套对齐 (C-4 同源闸)。
   * 缺省 → defaultMutationProvider 抛 (没座位就走联机 = 没指定车型, fail-closed)。
   */
  seats?: Record<string, string>;
}

/**
 * 变异 provider 注入点 —— 给定 prompt → 返子代 VariantSpec 的 JSON 字符串。
 *
 * 默认 = `defaultMutationProvider` (P2b 切片 1 接真联机); 测试 = `opts.mutationProvider`
 * 注入 fake, 整链零 LLM 调用 —— 与 `scripts/autoresearch-replay.ts:LiveProvider` 同层同形。
 */
export type MutationProvider = (prompt: string, ctx: MutationContext) => Promise<string>;

export interface MutationOpts {
  /** 替代默认 provider。测试装 fake; 缺省 = defaultMutationProvider (切片 1 接联机)。 */
  mutationProvider?: MutationProvider;
}

/**
 * 模拟 transport 的注入点 (与 MutationProvider 同层, 但低一档) —— 接 send(req) → ModelResponse
 * 的函数签名 (= src/model/gateway.ts:send 的同形)。让 defaultMutationProvider **不调真 send**
 * 但**完整跑 bootstrap + 座位解析 + meta 拼装**这条 integration 路径, 把「live 路径真接入
 * conductor 装配」和「实际 HTTP 调用」两件事分开:
 *
 *   - deps.llmCaller 给 → 走 fake transport, 测试零发请求;
 *   - deps.llmCaller 不给 → 真 send() (烧 token, 仅人工冒烟用)。
 *
 * 同时也允许 deps.bootstrap 注入, 把 provider 注册这步也关上 (测试环境下不会触发
 * "[omd env] no providers" 这条 stderr 心跳 —— 测试不该污染 stderr)。
 *
 * 与 `autoresearch-replay.LiveProviderDeps` 同形: 形状镜像, 不共享类型, 因为跨模块
 * import 会把 replay ↔ mutate 强行耦合; 各自重写一份契约 (与 conductor-plan 镜像
 * VariantPromptOpts 同款「边界内零耦合」选择)。
 */
export interface MutationProviderDeps {
  /** 替代 send() 的 transport 函数。默认 = gateway.send。 */
  llmCaller?: (req: GatewayRequest) => Promise<ModelResponse>;
  /** 替代 bootstrapModelRuntime 的引导函数。默认 = bootstrapModelRuntime。 */
  bootstrap?: () => string[];
}

/**
 * 构造变异 prompt —— 系统 + 父代段 + 败因段 + ctx 段。
 *
 * INV-2 / C-2 闸: 本函数是「变异不可见尺与 heldout」的最后一道闸。
 *   · 模板硬编码字段中**绝不出现** `fitness.ts` 的任何函数名 (fakeSerialPairsOf /
 *     speedupTheoreticalOf / computeFitness / aggregateFitness / estimateTokens /
 *     costOf / haystackOf / median);
 *   · 模板不访问 corpus 任何 split, 不读 heldout ids —— caller 已在 `failure.perItem`
 *     过滤 (本文件不持有 corpus 知识, 不去拉)。
 *
 * 反向自检见文件头注释; MUTATE_BLIND_TO_RULER describe 块里逐条锁。
 */
export function buildMutationPrompt(
  parent: VariantSpec | null,
  failure: MutationFailure,
  ctx: MutationContext,
): string {
  // ── 系统段: 定义角色 + 输出契约。零函数名, 零 item id, 零具体尺子字段。 ──
  const sys = [
    'You are the MUTATION OPERATOR for the conductor prompt face in an autoresearch loop.',
    '',
    'Your job: given a PARENT variant and a FAILURE SUMMARY, propose exactly one CHILD variant',
    'as a JSON object. Read the parent + per-item failures and reflect on what to change.',
    '',
    'Output STRICTLY one JSON object (no prose, no markdown fences), matching the schema:',
    '{',
    '  "version": 1,',
    '  "name": "<short-kebab-name>",',
    '  "fewShotCards"?: Array<{ "id": string, "name": string, "body": string }>,',
    '  "extraAppend"?: string[]',
    '}',
    '',
    'Rules:',
    '- version MUST be the literal integer 1.',
    '- name MUST be unique across this session, kebab-case (lowercase letters, digits, hyphens),',
    '-  ≤ 40 chars.',
    '- few-shot cards: each id unique; name ≤ 80 chars; body single text segment.',
    '- extraAppend: array of non-empty strings.',
    '- DO NOT include any field not listed above (no profile override, no raw prompts, no meta).',
    '- DO NOT touch anything outside this schema.',
  ].join('\n');

  // ── 父代段: lineage 条件之一。parent=null → 基线代, 显式标 <baseline>。 ──
  const parentSection =
    parent === null
      ? 'PARENT: <baseline — no previous variant exists in this session>'
      : `PARENT (VariantSpec v${parent.version}, name=${parent.name}):\n${JSON.stringify(parent, null, 2)}`;

  // ── 败因段: lineage 条件之二。aggregate 用通用术语, 不提尺子实现。 ──
  const failureHeader = [
    'FAILURE SUMMARY (screen + main only — heldout not visible to mutation):',
    '',
    'Aggregate fitness of parent (n=' + failure.aggregate.n + '):',
    `  planValidityRate: ${failure.aggregate.planValidityRate.toFixed(4)}`,
    `  fakeSerialPairsTotal: ${failure.aggregate.fakeSerialPairsTotal}`,
    `  speedupTheoreticalMedian: ${
      failure.aggregate.speedupTheoreticalMedian === null
        ? 'null'
        : failure.aggregate.speedupTheoreticalMedian.toFixed(4)
    }`,
    `  shapeDeclarationRate: ${failure.aggregate.shapeDeclarationRate.toFixed(4)}`,
    `  planningTokensTotal: ${failure.aggregate.planningTokensTotal}`,
    '',
    'Per-item failures (top ' + failure.perItem.length + '):',
  ].join('\n');
  const failurePerItem = failure.perItem
    .map((it, i) => `  [${i + 1}] id=${it.id} reason=${it.reason}`)
    .join('\n');
  const failureSection = failurePerItem.length > 0 ? `${failureHeader}\n${failurePerItem}` : failureHeader;

  // ── ctx 段: 给变异一些"位置感" (鼓励 childIdx 不同的子代走不同变异路径)。 ──
  const ctxSection = [
    'CTX:',
    `  genIdx: ${ctx.genIdx}`,
    `  childIdx: ${ctx.childIdx}`,
    `  parentName: ${ctx.parentName}`,
  ].join('\n');

  return [sys, parentSection, failureSection, ctxSection].join('\n\n');
}

/**
 * 解析 provider 输出 → 子代 VariantSpec。
 *
 * 三段失败模式 (fail-closed, 与 variant.ts 同哲学):
 *   · 非合法 JSON → throw;
 *   · JSON.parse 后字段校验失败 (version / name / fewShotCards / extraAppend) → throw;
 *   · 含未知字段 (e.g. profileOverride, prompt, rawText) → throw (anti-cheat: 闸真接住)。
 *
 * 拆 `parseChildSpec` / `validateChildSpec` 两层是为了让测试在不动 provider 的前提下
 * 锁住"provider 返回任意字符串"的边界。
 */
export function parseChildSpec(raw: string): VariantSpec {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(
      `mutateVariant: provider output is not valid JSON — ${(e as Error).message}`,
    );
  }
  return validateChildSpec(parsed);
}

/**
 * 字段级校验 + 未知字段守卫。VariantSpec 形状真源见 `variant.ts`; 本函数镜像字段
 * (不直接 import VariantSpec 走 zod, 因为那个 schema 还接受 profileOverride,
 * 而 mutate 输出要更严: 只许 version / name / fewShotCards / extraAppend 四键)。
 */
export function validateChildSpec(value: unknown): VariantSpec {
  if (typeof value !== 'object' || value === null) {
    throw new Error('validateChildSpec: child spec must be a JSON object');
  }
  const obj = value as Record<string, unknown>;

  // 未知字段守卫 (anti-cheat): 先扫一遍, 再做字段校验, 错误信息更精准。
  const ALLOWED_KEYS = new Set(['version', 'name', 'fewShotCards', 'extraAppend']);
  for (const k of Object.keys(obj)) {
    if (!ALLOWED_KEYS.has(k)) {
      throw new Error(
        `validateChildSpec: unknown field "${k}" (allowed: ${[...ALLOWED_KEYS].join(', ')})`,
      );
    }
  }

  if (obj.version !== VARIANT_VERSION) {
    throw new Error(
      `validateChildSpec: child spec version ${JSON.stringify(obj.version)} !== ${VARIANT_VERSION}`,
    );
  }

  if (typeof obj.name !== 'string' || obj.name.length === 0) {
    throw new Error('validateChildSpec: child spec missing or empty "name"');
  }
  if (obj.name.length > 40) {
    throw new Error(`validateChildSpec: child name "${obj.name}" exceeds 40 chars`);
  }
  if (!/^[a-z0-9-]+$/.test(obj.name)) {
    throw new Error(
      `validateChildSpec: child name "${obj.name}" must be kebab-case (lowercase letters, digits, hyphens)`,
    );
  }

  if (obj.fewShotCards !== undefined) {
    validateFewShotCards(obj.fewShotCards);
  }
  if (obj.extraAppend !== undefined) {
    validateExtraAppend(obj.extraAppend);
  }

  // 已知字段全部通过, 形状对齐 VariantSpec。
  const spec: VariantSpec = {
    version: obj.version as typeof VARIANT_VERSION,
    name: obj.name,
  };
  if (obj.fewShotCards !== undefined) {
    spec.fewShotCards = obj.fewShotCards as VariantFewShotCard[];
  }
  if (obj.extraAppend !== undefined) {
    spec.extraAppend = obj.extraAppend as string[];
  }
  return spec;
}

function validateFewShotCards(value: unknown): asserts value is VariantFewShotCard[] {
  if (!Array.isArray(value)) {
    throw new Error('validateChildSpec: fewShotCards must be an array');
  }
  const seen = new Set<string>();
  for (const c of value) {
    if (typeof c !== 'object' || c === null) {
      throw new Error('validateChildSpec: few-shot card must be an object');
    }
    const card = c as Record<string, unknown>;
    if (typeof card.id !== 'string' || card.id.length === 0) {
      throw new Error('validateChildSpec: few-shot card missing or empty "id"');
    }
    if (seen.has(card.id)) {
      throw new Error(`validateChildSpec: duplicate few-shot card id "${card.id}"`);
    }
    seen.add(card.id);
    if (typeof card.name !== 'string' || card.name.length === 0) {
      throw new Error(`validateChildSpec: few-shot card "${card.id}" missing or empty "name"`);
    }
    if (card.name.length > 80) {
      throw new Error(`validateChildSpec: few-shot card "${card.id}" name exceeds 80 chars`);
    }
    if (typeof card.body !== 'string' || card.body.length === 0) {
      throw new Error(`validateChildSpec: few-shot card "${card.id}" missing or empty "body"`);
    }
  }
}

function validateExtraAppend(value: unknown): asserts value is string[] {
  if (!Array.isArray(value)) {
    throw new Error('validateChildSpec: extraAppend must be an array');
  }
  for (let i = 0; i < value.length; i++) {
    const s = value[i];
    if (typeof s !== 'string' || s.length === 0) {
      throw new Error(`validateChildSpec: extraAppend[${i}] must be a non-empty string`);
    }
  }
}

/**
 * 跑变异: build prompt → call provider → parse → 返子代 VariantSpec。
 *
 * 失败模式 (fail-closed):
 *   · provider throw → 透传;
 *   · provider 返非 JSON → parseChildSpec throw (覆盖);
 *   · provider 返 JSON 但不通过校验 → validateChildSpec throw。
 *
 * 不做 retry / fallback —— 那是 session runner (切片 4) 的事, 本切片只保证一次
 * 调用的纯度与可注入性。
 */
export async function mutateVariant(
  parent: VariantSpec | null,
  failure: MutationFailure,
  ctx: MutationContext,
  opts: MutationOpts = {},
): Promise<VariantSpec> {
  const provider = opts.mutationProvider ?? defaultMutationProvider;
  const prompt = buildMutationPrompt(parent, failure, ctx);
  const raw = await provider(prompt, ctx);
  return parseChildSpec(raw);
}

/**
 * 默认变异 provider (生产) —— P2b 切片 1 接真联机: bootstrap + 解析 conductor
 * 座位 + gateway.send (与 `autoresearch-replay.defaultLiveProvider` 同层同形)。
 *
 * 不冒烟: 本契约内无任何调用点会走这条 (测试全装 fake); 首夜点火前人工冒烟 1 次
 * (上游 §未决), 配额/网络影响不进机械 verify。
 *
 * 装配点对齐 scripts/probes/repeat-plan-validity.ts:80-98 (generatePlan) 的同形:
 *   - 系统提示: buildMutationPrompt 的 sys 段 (MUTATION OPERATOR, 与 conductor 装配
 *     平面**分离** —— 变异不调用 conductor 推理, 而是产出 conductor prompt 的子代 spec);
 *   - user 段: buildMutationPrompt 的 parentSection + failureSection + ctxSection
 *     (lineage 条件全段打包发车);
 *   - 推理档: thinkingLevel='high' (与 conductor 档位一致);
 *   - maxTokens: 32_768 (与 role-models.ts:65 MAX_TOKENS_DEFAULT 一致);
 *   - meta.role='conductor' + sessionId/runLabel: 让变异调用进 seat-usage 同一通道,
 *     trace 与正常 conductor 发一致 (langfuse / 账本都能看到)。
 *
 * 第 3 个形参 `deps` 是 mock 注入点 (transport + bootstrap), 不进生产路径 (默认空对象)。
 * 测试时传 `{ llmCaller: fakeTransport, bootstrap: noopBootstrap }` → 完整跑装配链,
 * 但零实际 HTTP / 零 provider 注册副作用。
 *
 * fail-closed:
 *   · ctx.seats 缺席 → throw (没座位 = 联机通路无车型, 不可降级);
 *   · ctx.seats.conductor 缺席 → throw (解析不出目标, 不可降级);
 *   · llmCaller 返 text 为空 → 抛 (变异算子必须拿到 rawText)。
 */
export async function defaultMutationProvider(
  prompt: string,
  ctx: MutationContext,
  deps: MutationProviderDeps = {},
): Promise<string> {
  // 每次进程起一次就够 —— send() 内部状态自洽; 重复调安全 (实测 repeat-plan-validity 复用同一进程)。
  const bootstrap = deps.bootstrap ?? bootstrapModelRuntime;
  const llmCaller = deps.llmCaller ?? send;
  bootstrap();
  const seats = ctx.seats;
  if (!seats) {
    throw new Error(
      `defaultMutationProvider: ctx.seats missing (genIdx=${ctx.genIdx}, childIdx=${ctx.childIdx}, ` +
        `parentName=${ctx.parentName}) — call site must pass frozen seats (P2b LIVE_MUTATION_WIRED).`,
    );
  }
  const conductorCoord = seats['conductor'];
  if (!conductorCoord) {
    throw new Error(
      `defaultMutationProvider: ctx.seats.conductor missing (genIdx=${ctx.genIdx}, childIdx=${ctx.childIdx}, ` +
        `parentName=${ctx.parentName}) — manifest.seats.conductor 缺席, 冻结时刻没记 conductor 座.`,
    );
  }
  const seat = tryResolveSeatModel('conductor', { explicit: conductorCoord });
  const model = seat?.model ?? conductorCoord;
  const res = await llmCaller({
    model,
    // prompt 在这里是 buildMutationPrompt 的整段输出 (sys + parent + failure + ctx),
    // 自包含 MUTATION OPERATOR 角色定义 + lineage 条件; 与 defaultLiveProvider 的
    // sys=conductorSystemPrompt / user=PLAN_BOUNDARY+prompt 拆分不同 —— 那里 prompt
    // 只是任务描述, 系统提示在 conductorSystemPrompt 单独拼; 这里 prompt 自带角色段,
    // 再拆属于复制。整段进 user 即可, 段计数 / 边界留给 provider 端处理, INV-2 闸由
    // buildMutationPrompt 硬编码模板保证 (不变薄, 不泄漏 heldout/尺名)。
    messages: [{ role: 'user', content: prompt }],
    thinkingLevel: 'high',
    maxTokens: 32_768,
    meta: {
      // 标签命名空间化 (seat-usage 覆盖闸): 裸 'conductor' 与 engine 的 conductor:* 混账;
      // mutate:live 单列 → TRACE_SEAT_RULES 归 conductor 座 (烧钱在 conductor 座, 用途是变异)。
      role: 'mutate:live',
      sessionId: `autoresearch-mutate:${ctx.genIdx}-${ctx.childIdx}`,
      runLabel: `mutate/${ctx.parentName}`,
    },
  });
  const text = res.text ?? '';
  if (text.length === 0) {
    throw new Error(
      `defaultMutationProvider: llmCaller returned empty text (genIdx=${ctx.genIdx}, childIdx=${ctx.childIdx}, ` +
        `parentName=${ctx.parentName})`,
    );
  }
  return text;
}